import { getFrameworkControls } from '../../src/data/frameworks';
import { Index, buildIndexFrom, scoreIndex } from './bm25';
import { candidates53, rank53, support53 } from './retrieval53';
import type { SspImportFramework } from './types';

export { tokenize } from './bm25';

/**
 * Which controls should the model be asked about for a section of the document?
 *
 * Asking about all 110 practices for every section would waste the model's limited context and invite wrong matches, so each
 * section is first matched against the control catalog with BM25 (a standard keyword ranking: no model, no embeddings, no
 * extra download), and only the best few controls are offered. A control the section names outright (by identifier) is always
 * offered. A section that matches nothing well (a cover page, a glossary) is not sent to the model at all.
 *
 * The NIST SP 800-53 catalog (about a thousand controls and enhancements) is searched in two tiers instead, see retrieval53.ts.
 */
export interface Candidate {
  id: string;
  title: string;
  /** What the control requires, in plain words (shown to the model). */
  requirement: string;
  score: number;
  /** The section names this control by identifier. */
  explicit: boolean;
}

const indexes = new Map<SspImportFramework, Index>();

function buildIndex(framework: SspImportFramework): Index {
  return buildIndexFrom(
    getFrameworkControls(framework).map((c) => ({
      id: c.id,
      title: c.title,
      requirement: (c.plainEnglishSummary || c.title).replace(/\s+/g, ' ').trim(),
      text: [c.title, c.title, c.title, c.plainEnglishSummary, ...(c.assessmentObjectives ?? []), (c.discussion ?? '').slice(0, 400)].join(' '),
    }))
  );
}

const indexFor = (framework: SspImportFramework): Index => {
  let i = indexes.get(framework);
  if (!i) indexes.set(framework, (i = buildIndex(framework)));
  return i;
};

export interface RetrievalOptions {
  /** At most this many controls besides the explicitly named ones. */
  max?: number;
  /** Below this BM25 score a control is not offered on keywords alone. */
  minScore?: number;
}

// Deliberately strict. A small model (3B) offered many loosely related controls will attach real sentences to the wrong ones,
// so few controls are offered and only clear matches: on realistic text the right control scores 10-25 and unrelated
// controls 0-6. The relative cut-off drops anything not at least half as strong as the best match.
export const DEFAULT_MAX_CANDIDATES = 4;
export const DEFAULT_MIN_SCORE = 9;
export const RELATIVE_CUTOFF = 0.5;

/** Operators can tune retrieval without a code change: SSP_AI_MAX_CANDIDATES and SSP_AI_RETRIEVAL_MIN_SCORE. */
export function retrievalOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Required<RetrievalOptions> {
  const num = (v: string | undefined, fallback: number, min: number, max: number): number => {
    const n = Number.parseFloat(v ?? '');
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    max: Math.round(num(env.SSP_AI_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES, 1, 12)),
    minScore: num(env.SSP_AI_RETRIEVAL_MIN_SCORE, DEFAULT_MIN_SCORE, 0, 100),
  };
}

export interface ControlSupport {
  /** 0 = the best-matching control for this text. */
  rank: number;
  score: number;
  topScore: number;
}

/**
 * How well does `text` (a quotation and the model's summary of it) fit `controlId`? Used to check a model's claim that a
 * passage shows a control being implemented, without asking the model: on realistic text the right control ranks first with a
 * score above 10, and a wrong pairing ranks 6th or lower with a score under 3.
 */
export function controlSupport(text: string, controlId: string, framework: SspImportFramework): ControlSupport {
  if (framework === 'NIST_800_53_REV5') return support53(text, controlId);
  const ranked = rankControls(text, framework);
  const rank = ranked.findIndex((r) => r.id === controlId);
  return { rank: rank === -1 ? ranked.length : rank, score: rank === -1 ? 0 : ranked[rank].score, topScore: ranked[0]?.score ?? 0 };
}

/** Score of every control against `text`, highest first. */
export function rankControls(text: string, framework: SspImportFramework): Array<{ id: string; score: number }> {
  if (framework === 'NIST_800_53_REV5') return rank53(text);
  return scoreIndex(indexFor(framework), text);
}

export function candidatesForSection(
  text: string,
  framework: SspImportFramework,
  explicitIds: readonly string[] = [],
  options: RetrievalOptions = {}
): Candidate[] {
  const max = options.max ?? DEFAULT_MAX_CANDIDATES;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  if (framework === 'NIST_800_53_REV5') return candidates53(text, explicitIds, { max, minScore, relativeCutoff: RELATIVE_CUTOFF });

  const idx = indexFor(framework);
  const byId = new Map(idx.controls.map((c) => [c.id, c]));
  const ranked = rankControls(text, framework);
  const scoreOf = new Map(ranked.map((r) => [r.id, r.score]));

  const picked = new Map<string, Candidate>();
  const add = (id: string, explicit: boolean): void => {
    const c = byId.get(id);
    if (!c || picked.has(id)) return;
    picked.set(id, { id, title: c.title, requirement: c.requirement, score: scoreOf.get(id) ?? 0, explicit });
  };
  for (const id of explicitIds) add(id, true);
  let byKeywords = 0;
  // Besides the absolute floor, a control must score at least half of the best match, so one clear topic is not diluted by noise
  const cutoff = Math.max(minScore, (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF);
  for (const r of ranked) {
    if (byKeywords >= max || r.score < cutoff) break;
    if (!picked.has(r.id)) {
      add(r.id, false);
      byKeywords++;
    }
  }
  return [...picked.values()];
}
