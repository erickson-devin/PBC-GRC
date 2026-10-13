import { getFrameworkControls } from '../../src/data/frameworks';
import type { SspImportFramework } from './types';

/**
 * Which controls should the model be asked about for a section of the document?
 *
 * Asking about all 110 practices for every section would waste the model's limited context and invite wrong matches, so each
 * section is first matched against the control catalog with BM25 (a standard keyword ranking: no model, no embeddings, no
 * extra download), and only the best few controls are offered. A control the section names outright (by identifier) is always
 * offered. A section that matches nothing well (a cover page, a glossary) is not sent to the model at all.
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

const STOPWORDS = new Set(
  'the and for are was were that this with from have has had not but all any can will shall may must should would could into onto upon such than then them they their there these those its our out who whom whose which what when where while how also been being both each other more most some only own same very just over under between through during before after above below again further once here about against because does did doing done get got per via use used using'.split(' ')
);

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)); // crude plural folding

interface IndexedControl {
  id: string;
  title: string;
  requirement: string;
  tf: Map<string, number>;
  length: number;
}
interface Index {
  controls: IndexedControl[];
  idf: Map<string, number>;
  avgLength: number;
}

const indexes = new Map<SspImportFramework, Index>();
const K1 = 1.5;
const B = 0.75;

function buildIndex(framework: SspImportFramework): Index {
  const controls: IndexedControl[] = getFrameworkControls(framework).map((c) => {
    const text = [c.title, c.title, c.title, c.plainEnglishSummary, ...(c.assessmentObjectives ?? []), (c.discussion ?? '').slice(0, 400)].join(' ');
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: c.id, title: c.title, requirement: (c.plainEnglishSummary || c.title).replace(/\s+/g, ' ').trim(), tf, length: tokens.length };
  });
  const df = new Map<string, number>();
  for (const c of controls) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = controls.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  return { controls, idf, avgLength: controls.reduce((s, c) => s + c.length, 0) / Math.max(1, n) };
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
  const ranked = rankControls(text, framework);
  const rank = ranked.findIndex((r) => r.id === controlId);
  return { rank: rank === -1 ? ranked.length : rank, score: rank === -1 ? 0 : ranked[rank].score, topScore: ranked[0]?.score ?? 0 };
}
const QUERY_CHARS = 4000;

/** Score of every control against `text`, highest first. */
export function rankControls(text: string, framework: SspImportFramework): Array<{ id: string; score: number }> {
  const idx = indexFor(framework);
  const query = new Set(tokenize(text.slice(0, QUERY_CHARS)));
  return idx.controls
    .map((c) => {
      let score = 0;
      for (const term of query) {
        const f = c.tf.get(term);
        if (!f) continue;
        score += (idx.idf.get(term) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.length) / idx.avgLength)));
      }
      return { id: c.id, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function candidatesForSection(
  text: string,
  framework: SspImportFramework,
  explicitIds: readonly string[] = [],
  options: RetrievalOptions = {}
): Candidate[] {
  const max = options.max ?? DEFAULT_MAX_CANDIDATES;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
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
