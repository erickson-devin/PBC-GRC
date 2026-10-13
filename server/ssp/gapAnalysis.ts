import { getFrameworkControls } from '../../src/data/frameworks';
import { NIST_800_171A_REGISTRY } from '../../src/data/frameworks/assessmentObjectives';
import { groundQuote } from './grounding';
import { numberOf } from './controlMapper';
import { OllamaError, type OllamaClient } from './ollama';
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
    mode: 'narrative',
    summary: modelSummary ? `${tally} ${modelSummary}` : tally,
    gaps: gaps.slice(0, MAX_GAPS),
    objectives: assessed,
  };
}

// ------------------------------------------------------------------------------------------------ extractive variant

/** A model's near-miss copy is snapped to the document sentence it most resembles when their word overlap (Dice) is at least this... */
export const SNAP_MIN_SIMILARITY = 0.5;
/** ...and that sentence is clearly ahead: the runner-up must score no more than this share of the best. */
export const SNAP_MAX_RUNNER_UP = 0.75;
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

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

/** The sentences of a text, with their positions (a sentence may contain the line breaks of a PDF). */
export function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(/[^.!?\n]+(?:\n(?!\n)[^.!?\n]+)*[.!?]*/g)) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (trimmed.split(/\s+/).length < EXTRACTIVE_MIN_WORDS) continue;
    const start = (m.index ?? 0) + (raw.length - raw.trimStart().length);
    out.push({ start, end: start + trimmed.length, text: trimmed });
  }
  return out;
}

/**
 * Small models often copy a sentence with a word or two changed. If the words agree with ONE sentence of the document much
 * better than with any other, the model clearly meant that sentence, and the document's own sentence is used: the evidence
 * stays verbatim and real. A claim that resembles no sentence, or two about equally, stays unsupported.
 */
export function snapToSentence(claimed: string, sentences: Sentence[]): Sentence | null {
  const words = new Set(tokenize(claimed));
  if (words.size < 3 || sentences.length === 0) return null;
  const scored = sentences
    .map((s) => {
      const have = new Set(tokenize(s.text));
      let shared = 0;
      for (const w of words) if (have.has(w)) shared++;
      return { s, sim: (2 * shared) / (words.size + have.size) }; // Dice coefficient
    })
    .sort((x, y) => y.sim - x.sim);
  const [best, runnerUp] = scored;
  if (best.sim < SNAP_MIN_SIMILARITY) return null;
  if (runnerUp && runnerUp.sim > best.sim * SNAP_MAX_RUNNER_UP) return null; // ambiguous: it could be either
  return best.s;
}

export interface ObjectiveAnswer {
  letter: string;
  /** The sentence the model copied; 'NONE' or empty when nothing speaks to the objective. */
  sentence: string;
}

/**
 * The simple, small-model-friendly gap analysis. The model copies one supporting sentence per objective (or says NONE); this
 * function does everything else:
 *
 *  - a copied sentence counts if it is verbatim in the document, or is a near-miss of exactly one sentence of it;
 *  - the sentence is the model's choice of what speaks to the objective; the reviewer judges whether it does. The result is
 *    therefore "a supporting sentence was found", not "the objective is met";
 *  - one sentence can support at most two objectives, so a model that repeats itself cannot claim everything;
 *  - an objective with no answer at all was not assessed, which is not the same as having no supporting text;
 *  - gaps, severities, recommendations and the summary are generated from those results, so they cannot be invented or repeated.
 */
export function buildExtractiveGapAnalysis(reply: { answers: ObjectiveAnswer[] }, objectives: ObjectiveDef[], excerpts: string): GapAnalysis {
  const answers = new Map<string, string>();
  for (const a of reply.answers) if (!answers.has(normLetter(a.letter))) answers.set(normLetter(a.letter), a.sentence);
  const sentences = sentencesOf(excerpts);

  type Pending = { def: ObjectiveDef; status: ObjectiveAssessment['status']; evidence?: string; start?: number; overlap: number };
  const pending: Pending[] = objectives.map((def) => {
    const raw = answers.get(def.letter);
    if (raw === undefined) return { def, status: 'NOT_ASSESSED', overlap: 0 };
    if (!raw.trim() || /^none\b\.?$/i.test(raw.trim())) return { def, status: 'NOT_ADDRESSED', overlap: 0 };
    const grounded = groundQuote(excerpts, 0, raw, [], { minWords: EXTRACTIVE_MIN_WORDS });
    if (grounded.ok) return { def, status: 'ADDRESSED', evidence: grounded.quote.quote, start: grounded.quote.start, overlap: termOverlap(def.text, grounded.quote.quote) };
    const snapped = snapToSentence(raw, sentences);
    if (snapped) return { def, status: 'ADDRESSED', evidence: excerpts.slice(snapped.start, snapped.end), start: snapped.start, overlap: termOverlap(def.text, snapped.text) };
    return { def, status: 'UNSUPPORTED', overlap: 0 }; // not a sentence of the document
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
  const count = (s: ObjectiveAssessment['status']) => assessed.filter((o) => o.status === s).length;
  const found = count('ADDRESSED');
  const notAssessed = assessed.filter((o) => o.status === 'NOT_ASSESSED');
  const unsupported = count('UNSUPPORTED');
  const total = assessed.length;

  const gaps: GapItem[] = [];
  // Only when EVERY objective got a real answer and none has a supporting sentence is the control itself undocumented
  if (total > 0 && found === 0 && notAssessed.length === 0 && unsupported === 0) {
    gaps.push({ severity: 'HIGH', missingElement: 'No supporting sentence found', recommendation: 'None of this control’s assessment objectives has a supporting sentence in the text found for it. Describe how the control is implemented.' });
  }
  for (const o of assessed) {
    if (o.status === 'NOT_ADDRESSED') {
      gaps.push({ severity: 'MEDIUM', objective: o.letter, missingElement: `Objective [${o.letter}] has no supporting sentence`, recommendation: `State how the organisation meets: ${o.text}.` });
    } else if (o.status === 'UNSUPPORTED') {
      gaps.push({ severity: 'LOW', objective: o.letter, missingElement: `Objective [${o.letter}] could not be checked`, recommendation: `The model’s answer did not match any sentence of the document, so it was ignored. Check the document for: ${o.text}.` });
    }
  }
  if (notAssessed.length > 0) {
    const letters = notAssessed.map((o) => `[${o.letter}]`).join(', ');
    gaps.push({ severity: 'LOW', missingElement: `${notAssessed.length === 1 ? 'An objective was' : `${notAssessed.length} objectives were`} not assessed by the AI`, recommendation: `The AI gave no answer for ${letters}. Review the document against ${notAssessed.length === 1 ? 'it' : 'them'} yourself.` });
  }
  gaps.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.objective ?? '').localeCompare(b.objective ?? ''));

  const notes: string[] = [];
  if (notAssessed.length) notes.push(`${notAssessed.length} not assessed by the AI.`);
  if (unsupported) notes.push(`${unsupported} answer${unsupported === 1 ? '' : 's'} could not be matched to the document and ${unsupported === 1 ? 'was' : 'were'} ignored.`);
  return {
    source: 'ai',
    mode: 'extractive',
    summary: [total === 0 ? 'No assessment objectives are defined for this control.' : `${found} of ${total} assessment objectives have a supporting sentence in the document.`, ...notes].join(' '),
    gaps: gaps.slice(0, MAX_GAPS),
    objectives: assessed,
  };
}

/**
 * Asks the model one small question per objective. A single failed answer leaves that objective unassessed; the analysis only
 * fails (so the caller falls back to the simple checks) if the model could not answer any of them.
 */
export async function analyzeGapsExtractive(client: OllamaClient, input: GapInput, signal?: AbortSignal): Promise<GapAnalysis> {
  const objectives = objectivesFor(input.controlId, input.framework);
  if (objectives.length === 0) throw new Error(`No objectives for ${input.controlId}`);
  const answers: ObjectiveAnswer[] = [];
  let lastError: unknown = null;
  for (const objective of objectives) {
    try {
      const reply = await client.chatJson({
        system: GAP_EXTRACT_SYSTEM,
        user: gapExtractUserMessage({ objective, excerpts: input.excerpts }),
        schema: GAP_EXTRACT_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 250,
        signal,
      });
      const parsed = gapExtractReply.safeParse(reply.data);
      if (!parsed.success) throw new Error('The model’s answer did not have the expected shape.');
      answers.push({ letter: objective.letter, sentence: parsed.data.sentence });
    } catch (err: unknown) {
      if (err instanceof OllamaError && ['cancelled', 'unreachable', 'model_missing', 'disabled', 'blocked_host'].includes(err.code)) throw err;
      lastError = err; // this objective stays unassessed
    }
  }
  if (answers.length === 0) throw lastError instanceof Error ? lastError : new Error('The model gave no answers.');
  return buildExtractiveGapAnalysis({ answers }, objectives, input.excerpts);
}
