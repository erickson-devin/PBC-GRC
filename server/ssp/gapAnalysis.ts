import { getFrameworkControls } from '../../src/data/frameworks';
import { NIST_800_171A_REGISTRY } from '../../src/data/frameworks/assessmentObjectives';
import { groundQuote } from './grounding';
import { numberOf } from './controlMapper';
import type { OllamaClient } from './ollama';
import { GAP_EXTRACT_SCHEMA, GAP_EXTRACT_SYSTEM, GAP_SCHEMA, GAP_SYSTEM, gapExtractReply, gapExtractUserMessage, gapReply, gapUserMessage } from './prompts';
import { tokenize } from './retrieval';
import type { GapAnalysis, GapItem, ObjectiveAssessment, SspImportFramework } from './types';

/**
 * Gap analysis: how does what the document says compare with what the control requires, objective by objective?
 *
 * The objectives are the official NIST SP 800-171A determination statements ([a], [b], [c]...) for the control. The model
 * is shown the requirement, the objectives and the document's own text for that control, and decides for each objective
 * whether the document addresses it. It is not trusted on that: a claim of ADDRESSED or PARTIAL stands only if the model
 * can point to a passage that really is in the document (see grounding.ts); otherwise the objective is marked UNSUPPORTED.
 * Objectives nothing speaks to always produce a gap, whatever the model listed.
 */

const SEVERITY_ORDER: Record<GapItem['severity'], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const MAX_GAPS = 12;

export interface ObjectiveDef {
  letter: string;
  text: string;
}

/** The 800-171A objectives of a control (falling back to the catalog's own list, lettered a, b, c...). */
export function objectivesFor(controlId: string, framework: SspImportFramework): ObjectiveDef[] {
  const number = numberOf(controlId);
  const official = number ? NIST_800_171A_REGISTRY[number]?.objectives : undefined;
  if (official && official.length > 0) return official.map((o) => ({ letter: o.letter.toLowerCase(), text: o.text }));
  const def = getFrameworkControls(framework).find((c) => c.id === controlId);
  return (def?.assessmentObjectives ?? []).map((text, i) => ({ letter: String.fromCharCode(97 + i), text }));
}

const normLetter = (raw: string): string => raw.trim().toLowerCase().replace(/^[\[(]|[\])]$/g, '').replace(/[.:]$/, '');

export interface GapInput {
  controlId: string;
  framework: SspImportFramework;
  /** The document's own text where this control is described (never the model's summary). */
  excerpts: string;
}

/**
 * Compares the document's text for one control with its requirement and objectives. Throws OllamaError when the model cannot
 * be used; the caller decides what to show instead.
 */
export async function analyzeGaps(client: OllamaClient, input: GapInput, signal?: AbortSignal): Promise<GapAnalysis> {
  const def = getFrameworkControls(input.framework).find((c) => c.id === input.controlId);
  if (!def) throw new Error(`Unknown control ${input.controlId}`);
  const objectives = objectivesFor(input.controlId, input.framework);
  const requirement = [def.plainEnglishSummary, def.discussion].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  const reply = await client.chatJson({
    system: GAP_SYSTEM,
    user: gapUserMessage({ controlId: def.id, title: def.title, requirement, objectives, excerpts: input.excerpts }),
    schema: GAP_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    signal,
  });
  const parsed = gapReply.safeParse(reply.data);
  if (!parsed.success) throw new Error('The model’s gap analysis did not have the expected shape.');
  return buildGapAnalysis(parsed.data, objectives, input.excerpts);
}

/** Turns the model's (validated) answer into a GapAnalysis, applying the grounding rules. Pure. */
export function buildGapAnalysis(
  reply: { summary: string; objectives: Array<{ letter: string; status: 'ADDRESSED' | 'PARTIAL' | 'NOT_ADDRESSED'; evidence: string }>; gaps: Array<{ severity: GapItem['severity']; objective: string; missingElement: string; recommendation: string }> },
  objectives: ObjectiveDef[],
  excerpts: string
): GapAnalysis {
  const known = new Set(objectives.map((o) => o.letter));
  const byLetter = new Map(reply.objectives.map((o) => [normLetter(o.letter), o]));

  const assessed: ObjectiveAssessment[] = objectives.map((def) => {
    const claim = byLetter.get(def.letter);
    if (!claim) return { letter: def.letter, text: def.text, status: 'NOT_ASSESSED' };
    if (claim.status === 'NOT_ADDRESSED') return { letter: def.letter, text: def.text, status: 'NOT_ADDRESSED' };
    const grounded = groundQuote(excerpts, 0, claim.evidence);
    return grounded.ok
      ? { letter: def.letter, text: def.text, status: claim.status, evidence: grounded.quote.quote }
      : { letter: def.letter, text: def.text, status: 'UNSUPPORTED' };
  });

  const gaps: GapItem[] = [];
  for (const g of reply.gaps) {
    const letter = normLetter(g.objective);
    gaps.push({
      severity: g.severity,
      ...(known.has(letter) ? { objective: letter } : {}),
      missingElement: g.missingElement.trim(),
      recommendation: g.recommendation.trim(),
    });
  }
  // Whatever the model listed, an objective the document does not address is a gap
  for (const o of assessed) {
    if (o.status === 'ADDRESSED' || o.status === 'PARTIAL') continue;
    if (gaps.some((g) => g.objective === o.letter)) continue;
    gaps.push(
      o.status === 'NOT_ADDRESSED'
        ? { severity: 'MEDIUM', objective: o.letter, missingElement: `Objective [${o.letter}] is not addressed`, recommendation: `Describe how the organisation meets: ${o.text}.` }
        : o.status === 'UNSUPPORTED'
          ? { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] is not supported by the text`, recommendation: `The model said this is addressed but could not point to a passage that says so. Check the document, and state plainly: ${o.text}.` }
          : { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] was not assessed`, recommendation: `Review the document against: ${o.text}.` }
    );
  }
  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.objective ?? '').localeCompare(b.objective ?? ''));

  const total = assessed.length;
  const addressed = assessed.filter((o) => o.status === 'ADDRESSED').length;
  const partial = assessed.filter((o) => o.status === 'PARTIAL').length;
  const tally = total === 0 ? 'No assessment objectives are defined for this control.' : `${addressed} of ${total} assessment objectives addressed${partial ? `, ${partial} partly` : ''}.`;
  const modelSummary = reply.summary.trim().slice(0, 400);
  return {
    source: 'ai',
    summary: modelSummary ? `${tally} ${modelSummary}` : tally,
    gaps: gaps.slice(0, MAX_GAPS),
    objectives: assessed,
  };
}

// ------------------------------------------------------------------------------------------------ extractive variant

/** An objective counts as spoken to when the sentence uses at least this share of the objective's distinctive words. */
export const MIN_OBJECTIVE_OVERLAP = 0.5;
/** One sentence can be the evidence for at most this many objectives (a small model tends to repeat itself). */
const MAX_OBJECTIVES_PER_SENTENCE = 2;
const EXTRACTIVE_MIN_WORDS = 3;

/** Share of the objective's distinctive words that appear in `sentence` (0 to 1). */
export function termOverlap(objectiveText: string, sentence: string): number {
  const wanted = new Set(tokenize(objectiveText));
  if (wanted.size === 0) return 0;
  const have = new Set(tokenize(sentence));
  let shared = 0;
  for (const t of wanted) if (have.has(t)) shared++;
  return shared / wanted.size;
}

/**
 * The simple, small-model-friendly gap analysis: the model copies one supporting sentence per objective (or says NONE) and
 * this function does everything else. An answer counts only if the sentence is verbatim in the document AND shares enough of
 * the objective's words; the same sentence supports at most two objectives. Gaps, severities, recommendations and the summary
 * are generated here from the results, so they cannot be wrong in the model's way (invented, vague, or repeated).
 */
export function buildExtractiveGapAnalysis(
  reply: { answers: Array<{ letter: string; sentence: string }> },
  objectives: ObjectiveDef[],
  excerpts: string
): GapAnalysis {
  const answers = new Map<string, string>();
  for (const a of reply.answers) if (!answers.has(normLetter(a.letter))) answers.set(normLetter(a.letter), a.sentence);

  type Pending = { def: ObjectiveDef; status: ObjectiveAssessment['status']; evidence?: string; start?: number; overlap: number };
  const pending: Pending[] = objectives.map((def) => {
    const raw = answers.get(def.letter);
    if (raw === undefined) return { def, status: 'NOT_ASSESSED', overlap: 0 };
    if (!raw.trim() || /^none\b\.?$/i.test(raw.trim())) return { def, status: 'NOT_ADDRESSED', overlap: 0 };
    const grounded = groundQuote(excerpts, 0, raw, [], { minWords: EXTRACTIVE_MIN_WORDS });
    if (!grounded.ok) return { def, status: 'UNSUPPORTED', overlap: 0 }; // not a sentence of the document
    const overlap = termOverlap(def.text, grounded.quote.quote);
    // A real sentence that does not speak to this objective is simply not evidence for it
    if (overlap < MIN_OBJECTIVE_OVERLAP) return { def, status: 'NOT_ADDRESSED', overlap };
    return { def, status: 'ADDRESSED', evidence: grounded.quote.quote, start: grounded.quote.start, overlap };
  });

  // The same sentence cannot be the evidence for everything: keep it for the objectives it fits best
  const bySentence = new Map<number, Pending[]>();
  for (const p of pending) if (p.status === 'ADDRESSED' && p.start !== undefined) bySentence.set(p.start, [...(bySentence.get(p.start) ?? []), p]);
  for (const group of bySentence.values()) {
    group.sort((a, b) => b.overlap - a.overlap);
    for (const extra of group.slice(MAX_OBJECTIVES_PER_SENTENCE)) {
      extra.status = 'NOT_ADDRESSED';
      extra.evidence = undefined;
    }
  }

  const assessed: ObjectiveAssessment[] = pending.map((p) => ({ letter: p.def.letter, text: p.def.text, status: p.status, ...(p.evidence ? { evidence: p.evidence } : {}) }));
  const addressed = assessed.filter((o) => o.status === 'ADDRESSED').length;
  const gaps: GapItem[] = [];
  if (assessed.length > 0 && addressed === 0) {
    gaps.push({ severity: 'HIGH', missingElement: 'No supporting text found', recommendation: 'None of this control\u2019s assessment objectives has a supporting statement in the document. Describe how the control is implemented.' });
  }
  for (const o of assessed) {
    if (o.status === 'ADDRESSED') continue;
    gaps.push(
      o.status === 'NOT_ADDRESSED'
        ? { severity: 'MEDIUM', objective: o.letter, missingElement: `Objective [${o.letter}] has no supporting text`, recommendation: `State how the organisation meets: ${o.text}.` }
        : o.status === 'UNSUPPORTED'
          ? { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] could not be checked`, recommendation: `The model\u2019s answer is not a sentence of the document, so it was ignored. Check the document for: ${o.text}.` }
          : { severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] was not assessed`, recommendation: `Review the document against: ${o.text}.` }
    );
  }
  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.objective ?? '').localeCompare(b.objective ?? ''));

  const ignored = assessed.filter((o) => o.status === 'UNSUPPORTED').length;
  const total = assessed.length;
  return {
    source: 'ai',
    summary:
      (total === 0 ? 'No assessment objectives are defined for this control.' : `${addressed} of ${total} assessment objectives have supporting text in the document.`) +
      (ignored ? ` ${ignored} answer${ignored === 1 ? '' : 's'} from the model could not be matched to the document and ${ignored === 1 ? 'was' : 'were'} ignored.` : ''),
    gaps: gaps.slice(0, MAX_GAPS),
    objectives: assessed,
  };
}

export async function analyzeGapsExtractive(client: OllamaClient, input: GapInput, signal?: AbortSignal): Promise<GapAnalysis> {
  const objectives = objectivesFor(input.controlId, input.framework);
  if (objectives.length === 0) throw new Error(`No objectives for ${input.controlId}`);
  const reply = await client.chatJson({
    system: GAP_EXTRACT_SYSTEM,
    user: gapExtractUserMessage({ objectives, excerpts: input.excerpts }),
    schema: GAP_EXTRACT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 700,
    signal,
  });
  const parsed = gapExtractReply.safeParse(reply.data);
  if (!parsed.success) throw new Error('The model\u2019s answer did not have the expected shape.');
  return buildExtractiveGapAnalysis(parsed.data, objectives, input.excerpts);
}
