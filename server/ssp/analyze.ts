import { getFrameworkControls } from '../../src/data/frameworks';
import { CMMC_ID_RE, NIST_NUMBER_RE, chunkDocument, foldForMatching } from './chunk';
import { numberToIdMap } from './controlMapper';
import { analyzeGaps } from './gapAnalysis';
import { groundQuote, resolveControlId } from './grounding';
import { OllamaClient, OllamaError } from './ollama';
import {
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM,
  MAX_FINDINGS_PER_SECTION,
  MAX_SUMMARY_CHARS,
  PROMPT_VERSION,
  extractionReply,
  extractionUserMessage,
} from './prompts';
import { candidatesForSection, type Candidate } from './retrieval';
import type {
  DocChunk,
  MappingResult,
  PageSpan,
  SourceQuote,
  SspAiStats,
  SspImportFramework,
  SspStageProgress,
  StagedControlDraft,
} from './types';

/**
 * The AI analysis of a document, on top of the rule-based mapping:
 *
 *   1. split the text into sections (at most SECTION_MAX_CHARS each);
 *   2. for each section pick the few controls it could be about (retrieval.ts) and skip sections that match nothing;
 *   3. ask the local model which of those controls the section describes the implementation of, with a quotation;
 *   4. keep a finding only if its control is one that was offered and its quotation is verbatim in that section (grounding.ts);
 *   5. combine the findings per control into one suggestion with sources;
 *   6. compare each suggestion with the control's 800-171A objectives (gapAnalysis.ts).
 *
 * Controls the rules found that the model did not confirm are kept as rule-based suggestions, so the AI can add and sharpen
 * but never remove what is plainly in the document. Everything ends in the staging tables: nothing here writes a control.
 */

export const SECTION_MAX_CHARS = 5000;
const MIN_SECTION_CHARS = 80;
const MAX_NOTES_CHARS = 8000;
const MAX_QUOTES_PER_CONTROL = 3;
const MAX_EXCERPT_CHARS = 3500;
const EARLY_ABORT_AFTER = 5; // this many sections in a row, all failing: the model is not usable

export interface AnalyzeOptions {
  /** Upper bound on sections sent to the model (a long document is limited to its most relevant sections). */
  maxSections?: number;
  /** Compare each suggestion with the 800-171A objectives (one more model call per control). */
  gapAnalysis?: boolean;
}

export interface AnalyzeInput {
  text: string;
  pages: readonly PageSpan[];
  framework: SspImportFramework;
  client: OllamaClient;
  /** The rule-based result: AI suggestions are merged with it. */
  rules: MappingResult;
  signal?: AbortSignal;
  onProgress?: (progress: SspStageProgress) => void | Promise<void>;
  options?: AnalyzeOptions;
}

export interface AnalyzeResult {
  mapping: MappingResult;
  stats: SspAiStats;
  warnings: string[];
}

/** Errors that mean the model cannot be used at all, as opposed to one bad answer. */
const FATAL: ReadonlySet<string> = new Set(['cancelled', 'unreachable', 'model_missing', 'disabled', 'blocked_host']);

/** Control ids a section names outright, by CMMC identifier or NIST number. */
export function explicitControlIds(text: string, framework: SspImportFramework): string[] {
  const folded = foldForMatching(text);
  const numbers = numberToIdMap(framework);
  const ids = new Set<string>();
  for (const m of folded.matchAll(new RegExp(CMMC_ID_RE.source, 'g'))) {
    const hit = numbers.get(m[3]);
    if (hit) ids.add(hit.id);
  }
  for (const m of folded.matchAll(new RegExp(NIST_NUMBER_RE.source, 'g'))) {
    const hit = numbers.get(m[1]);
    if (hit) ids.add(hit.id);
  }
  return [...ids];
}

interface GroundedFinding {
  controlId: string;
  implementation: string;
  coverage: 'FULL' | 'PARTIAL';
  confidence: number;
  quote: SourceQuote;
  chunk: DocChunk;
  explicit: boolean;
}

interface Planned {
  chunk: DocChunk;
  candidates: Candidate[];
  explicitIds: string[];
  priority: number;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

function plan(chunks: DocChunk[], framework: SspImportFramework): Planned[] {
  const out: Planned[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length < MIN_SECTION_CHARS) continue;
    const explicitIds = explicitControlIds(chunk.text, framework);
    const candidates = candidatesForSection(chunk.text, framework, explicitIds);
    if (candidates.length === 0) continue;
    out.push({ chunk, candidates, explicitIds, priority: explicitIds.length * 100 + Math.max(...candidates.map((c) => c.score)) });
  }
  return out;
}

export async function analyzeDocumentWithAi(input: AnalyzeInput): Promise<AnalyzeResult> {
  const started = Date.now();
  const { framework, client, signal } = input;
  const maxSections = input.options?.maxSections ?? 150;
  const warnings: string[] = [];
  const check = (): void => {
    if (signal?.aborted) throw new OllamaError('cancelled', 'The analysis was cancelled.');
  };

  const stats: SspAiStats = {
    model: client.config.model,
    promptVersion: PROMPT_VERSION,
    sectionsAnalyzed: 0,
    sectionsSkipped: 0,
    sectionsFailed: 0,
    findingsProposed: 0,
    findingsGrounded: 0,
    rejected: {},
    gapAnalyses: 0,
    gapAnalysesFailed: 0,
    durationMs: 0,
  };
  const reject = (reason: string): void => {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
  };

  // ---- 1-2. sections and what each could be about
  const chunks = chunkDocument(input.text, input.pages, { maxChars: SECTION_MAX_CHARS });
  let planned = plan(chunks, framework);
  stats.sectionsSkipped = chunks.length - planned.length;
  if (planned.length > maxSections) {
    planned = [...planned].sort((a, b) => b.priority - a.priority).slice(0, maxSections).sort((a, b) => a.chunk.index - b.chunk.index);
    stats.sectionsSkipped = chunks.length - planned.length;
    warnings.push(`The document is long: only the ${maxSections} sections most likely to describe controls were analysed by the AI.`);
  }

  // ---- 3-4. ask the model, then keep only what can be checked
  const findings: GroundedFinding[] = [];
  let consecutiveFailures = 0;
  for (let i = 0; i < planned.length; i++) {
    check();
    const { chunk, candidates, explicitIds } = planned[i];
    await input.onProgress?.({ stage: `AI reading section ${i + 1} of ${planned.length}`, chunksTotal: planned.length, chunksDone: i });
    try {
      const reply = await client.chatJson({
        system: EXTRACTION_SYSTEM,
        user: extractionUserMessage(candidates, { heading: chunk.heading, page: chunk.page, text: chunk.text }),
        schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 1400,
        signal,
      });
      const parsed = extractionReply.safeParse(reply.data);
      if (!parsed.success) throw new OllamaError('bad_response', 'The model’s answer did not have the expected shape.');
      stats.sectionsAnalyzed++;
      consecutiveFailures = 0;

      const offered = new Set(candidates.map((c) => c.id));
      for (const f of parsed.data.findings.slice(0, MAX_FINDINGS_PER_SECTION)) {
        stats.findingsProposed++;
        const id = resolveControlId(f.controlId, framework, offered);
        if (!id.ok) {
          reject(id.reason);
          continue;
        }
        const grounded = groundQuote(chunk.text, chunk.start, f.quote, input.pages);
        if (!grounded.ok) {
          reject(grounded.reason);
          continue;
        }
        stats.findingsGrounded++;
        findings.push({
          controlId: id.controlId,
          implementation: clip(f.implementation.replace(/\s+/g, ' ').trim(), MAX_SUMMARY_CHARS),
          coverage: f.coverage,
          confidence: f.confidence,
          quote: grounded.quote,
          chunk,
          explicit: explicitIds.includes(id.controlId),
        });
      }
    } catch (err: unknown) {
      if (err instanceof OllamaError && FATAL.has(err.code)) throw err;
      stats.sectionsFailed++;
      consecutiveFailures++;
      console.warn(`[SSP AI] section ${chunk.index} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (consecutiveFailures >= EARLY_ABORT_AFTER && stats.sectionsAnalyzed === 0) {
        throw new OllamaError('bad_response', 'The model could not produce a usable answer for the first sections of the document.');
      }
    }
  }
  if (stats.sectionsFailed > 0) warnings.push(`${stats.sectionsFailed} of ${planned.length} sections could not be analysed by the AI (the rule-based result is used for them).`);
  const dropped = stats.findingsProposed - stats.findingsGrounded;
  if (dropped > 0) warnings.push(`${dropped} AI finding${dropped === 1 ? ' was' : 's were'} discarded because the control or the quotation could not be verified against the document.`);

  // ---- 5. one suggestion per control
  const byControl = new Map<string, GroundedFinding[]>();
  for (const f of findings) byControl.set(f.controlId, [...(byControl.get(f.controlId) ?? []), f]);

  const catalog = new Map(getFrameworkControls(framework).map((c) => [c.id, c]));
  const drafts: Array<StagedControlDraft & { excerpts: string }> = [];
  for (const [controlId, list] of byControl) {
    const ranked = [...list].sort((a, b) => (a.coverage === b.coverage ? 0 : a.coverage === 'FULL' ? -1 : 1) || b.confidence - a.confidence);
    const best = ranked[0];

    const seen = new Set<string>();
    const sentences: string[] = [];
    for (const f of ranked) {
      const key = f.implementation.toLowerCase();
      if (!seen.has(key) && f.implementation) {
        seen.add(key);
        sentences.push(f.implementation);
      }
    }
    const quotes: SourceQuote[] = [];
    for (const f of ranked) {
      if (quotes.length >= MAX_QUOTES_PER_CONTROL) break;
      if (!quotes.some((q) => f.quote.start < q.end && q.start < f.quote.end)) quotes.push(f.quote);
    }
    // The sections these findings came from, in document order: the evidence the gap analysis is allowed to cite
    const sections = [...new Map(ranked.map((f) => [f.chunk.index, f.chunk])).values()].sort((a, b) => a.index - b.index);
    let excerpts = '';
    for (const s of sections) {
      if (excerpts.length + s.text.length + 2 > MAX_EXCERPT_CHARS) break;
      excerpts += (excerpts ? '\n\n' : '') + s.text;
    }
    if (!excerpts) excerpts = best.chunk.text.slice(0, MAX_EXCERPT_CHARS);

    const confidence = Math.min(0.95, Math.max(0.05, +(0.5 * best.confidence + (best.explicit ? 0.3 : 0) + (best.coverage === 'FULL' ? 0.2 : 0.1)).toFixed(2)));
    drafts.push({
      controlId,
      framework,
      matchKind: 'AI_EXTRACTED',
      origin: 'AI',
      sectionHeading: best.chunk.heading,
      suggestedNotes: clip(sentences.join('\n\n'), MAX_NOTES_CHARS),
      confidence,
      sourceQuotes: quotes,
      gapAnalysis: { source: 'ai', summary: '', gaps: [] },
      excerpts,
    });
  }
  drafts.sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));

  // ---- 6. gap analysis against the 800-171A objectives
  const wantGaps = input.options?.gapAnalysis !== false;
  const heuristic = new Map(input.rules.staged.map((s) => [s.controlId, s.gapAnalysis]));
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!wantGaps) {
      d.gapAnalysis = heuristic.get(d.controlId) ?? { source: 'heuristic', summary: 'No gap analysis was run.', gaps: [] };
      continue;
    }
    check();
    await input.onProgress?.({ stage: `Comparing with the objectives: ${d.controlId} (${i + 1} of ${drafts.length})`, chunksTotal: planned.length, chunksDone: planned.length });
    try {
      d.gapAnalysis = await analyzeGaps(client, { controlId: d.controlId, framework, excerpts: d.excerpts }, signal);
      stats.gapAnalyses++;
    } catch (err: unknown) {
      if (err instanceof OllamaError && FATAL.has(err.code)) throw err;
      stats.gapAnalysesFailed++;
      console.warn(`[SSP AI] gap analysis for ${d.controlId} failed: ${err instanceof Error ? err.message : String(err)}`);
      d.gapAnalysis = heuristic.get(d.controlId) ?? { source: 'heuristic', summary: 'The AI gap analysis could not be completed for this control.', gaps: [] };
    }
  }
  if (stats.gapAnalysesFailed > 0) warnings.push(`The AI gap analysis could not be completed for ${stats.gapAnalysesFailed} control${stats.gapAnalysesFailed === 1 ? '' : 's'}.`);

  // ---- merge with the rule-based result
  const aiIds = new Set(drafts.map((d) => d.controlId));
  const staged: StagedControlDraft[] = [
    ...drafts.map(({ excerpts: _excerpts, ...d }) => d),
    ...input.rules.staged.filter((s) => !aiIds.has(s.controlId)), // found by identifier, not confirmed by the model: kept as rule-based
  ].sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));

  const foundIds = new Set(staged.map((s) => s.controlId));
  stats.durationMs = Date.now() - started;
  return {
    mapping: {
      staged,
      unmapped: input.rules.unmapped,
      coverage: {
        framework,
        totalControls: catalog.size,
        foundControls: foundIds.size,
        missing: [...catalog.keys()].filter((id) => !foundIds.has(id)),
      },
    },
    stats,
    warnings,
  };
}
