import { getFrameworkControls } from '../../src/data/frameworks';
import { collapseTags } from '../../src/data/frameworks/parameters';
import { Index, buildIndexFrom, scoreIndex } from './bm25';
import type { Candidate, ControlSupport } from './retrieval';

/**
 * Candidate search over NIST SP 800-53 Rev. 5: about 300 base controls and 700 control enhancements.
 *
 * Ranking all thousand together does not work well. Many enhancements say nearly the same thing ("Employ automated mechanisms
 * to ...") and would crowd the base control a section is really about, and the keyword statistics of 700 short enhancements
 * differ from those of 300 base controls. So the search has two tiers:
 *
 *   1. FAMILIES AND BASE CONTROLS. The section is ranked against the base controls only. The families whose best base controls
 *      score together are the topic of the section: a base control from any other family is dropped, so one stray keyword hit
 *      cannot bring in an unrelated control. The survivors are cut with the same absolute floor and relative cut-off as the
 *      CMMC search.
 *   2. ENHANCEMENTS. Only the enhancements of the few base controls that made it through tier 1 (and of controls the section
 *      names outright) are ranked against the section, with the same floor and a relative cut-off among themselves.
 *
 * The two lists are merged by score and capped at the same candidate limit as the CMMC search, so the model is never offered
 * more controls than before. A control the section names by identifier is always offered, and is not counted in the limit.
 */

/**
 * Statements in SP 800-53 are long and full of generic words, so even unrelated text scores around 10-14 against its best match
 * (a cover page scored 13.8) while a section that really describes a control scores 25-45. The floor is therefore higher than
 * for the CMMC catalogs (DEFAULT_MIN_SCORE); the operator setting can raise it further but never lowers it below this.
 */
export const MIN_SCORE_53 = 18;

/** How many families the section may be about. */
export const FAMILIES_KEPT = 3;
/** A family counts if its score is at least this share of the best family's. */
export const FAMILY_RELATIVE_CUTOFF = 0.4;
/** Enhancements are looked for under this many of the best base controls. */
export const PARENTS_EXPANDED = 3;
/** The parent of an enhancement must itself rank within this many base controls for a quotation to support the enhancement. */
export const PARENT_SUPPORT_MAX_RANK = 5;

interface Meta {
  id: string;
  title: string;
  requirement: string;
  family: string;
  parent?: string;
}
interface Index53 {
  bases: Index;
  enhancements: Index;
  meta: Map<string, Meta>;
  enhancementsOf: Map<string, string[]>;
}

let cached: Index53 | null = null;

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

function build(): Index53 {
  const controls = getFrameworkControls('NIST_800_53_REV5'); // the whole catalog, whatever baseline an import is measured against
  const meta = new Map<string, Meta>();
  const baseDocs: Parameters<typeof buildIndexFrom>[0] = [];
  const enhDocs: Parameters<typeof buildIndexFrom>[0] = [];
  const enhancementsOf = new Map<string, string[]>();
  const titleOf = new Map(controls.map((c) => [c.id, c.title]));
  for (const c of controls) {
    const statement = collapseTags(c.statement ?? '');
    const isEnhancement = c.controlKind === 'ENHANCEMENT' && c.parentControlId;
    if (!isEnhancement) {
      const requirement = flat(c.plainEnglishSummary || c.title);
      meta.set(c.id, { id: c.id, title: c.title, requirement, family: c.domain });
      baseDocs.push({ id: c.id, title: c.title, requirement, text: [c.title, c.title, c.title, statement, (c.discussion ?? '').slice(0, 400)].join(' ') });
    } else {
      const parent = c.parentControlId!;
      // The model is told which control this refines: an enhancement on its own is easy to mistake for its neighbours
      const requirement = flat(`Enhancement of ${parent} ${titleOf.get(parent) ?? ''}: ${c.plainEnglishSummary || c.title}`);
      meta.set(c.id, { id: c.id, title: c.title, requirement, family: c.domain, parent });
      enhDocs.push({ id: c.id, title: c.title, requirement, text: [c.title, c.title, c.title, statement].join(' ') });
      enhancementsOf.set(parent, [...(enhancementsOf.get(parent) ?? []), c.id]);
    }
  }
  return { bases: buildIndexFrom(baseDocs), enhancements: buildIndexFrom(enhDocs), meta, enhancementsOf };
}

const index53 = (): Index53 => (cached ??= build());

/** Where an id sits in the catalog; undefined for an id that is not an SP 800-53 control. */
export const control53 = (id: string): Meta | undefined => index53().meta.get(id);

/** Score of every control and enhancement against `text`, highest first (the tiers merged: for tests and inspection). */
export function rank53(text: string): Array<{ id: string; score: number }> {
  const idx = index53();
  return [...scoreIndex(idx.bases, text), ...scoreIndex(idx.enhancements, text)].sort((a, b) => b.score - a.score);
}

export interface Options53 {
  max: number;
  minScore: number;
  relativeCutoff: number;
}

export function candidates53(text: string, explicitIds: readonly string[], options: Options53): Candidate[] {
  const idx = index53();
  const picked = new Map<string, Candidate>();
  const add = (id: string, score: number, explicit: boolean): void => {
    const m = idx.meta.get(id);
    if (!m || picked.has(id)) return;
    picked.set(id, { id, title: m.title, requirement: m.requirement, score, explicit });
  };

  // ---- tier 1: families and base controls
  const baseRank = scoreIndex(idx.bases, text);
  const baseScore = new Map(baseRank.map((r) => [r.id, r.score]));
  const familyScore = new Map<string, number[]>();
  for (const r of baseRank) {
    if (r.score <= 0) break;
    const family = idx.meta.get(r.id)!.family;
    const list = familyScore.get(family) ?? [];
    if (list.length < 2) familyScore.set(family, [...list, r.score]); // the two best base controls of a family
  }
  const families = [...familyScore.entries()].map(([family, s]) => ({ family, score: s.reduce((a, b) => a + b, 0) })).sort((a, b) => b.score - a.score);
  const familyCut = (families[0]?.score ?? 0) * FAMILY_RELATIVE_CUTOFF;
  const topFamilies = new Set(families.filter((f) => f.score >= familyCut).slice(0, FAMILIES_KEPT).map((f) => f.family));
  const floor = Math.max(options.minScore, MIN_SCORE_53);
  const baseCut = Math.max(floor, (baseRank[0]?.score ?? 0) * options.relativeCutoff);
  const bases = baseRank.filter((r) => r.score >= baseCut && topFamilies.has(idx.meta.get(r.id)!.family)).slice(0, options.max);

  // ---- tier 2: enhancements of the base controls that made it (and of those the section names)
  const parents = new Set(bases.slice(0, PARENTS_EXPANDED).map((b) => b.id));
  for (const id of explicitIds) {
    const m = idx.meta.get(id);
    if (m) parents.add(m.parent ?? m.id);
  }
  const enhRank = scoreIndex(idx.enhancements, text).filter((r) => parents.has(idx.meta.get(r.id)!.parent!));
  const enhCut = Math.max(floor, (enhRank[0]?.score ?? 0) * options.relativeCutoff);
  const enhancements = enhRank.filter((r) => r.score >= enhCut);

  // ---- merge: explicitly named first, then the best of both tiers up to the limit
  for (const id of explicitIds) add(id, idx.meta.get(id)?.parent ? enhRank.find((r) => r.id === id)?.score ?? 0 : baseScore.get(id) ?? 0, true);
  const merged = [...bases, ...enhancements].sort((a, b) => b.score - a.score);
  let byKeywords = 0;
  for (const r of merged) {
    if (byKeywords >= options.max) break;
    if (!picked.has(r.id)) {
      add(r.id, r.score, false);
      byKeywords++;
    }
  }
  return [...picked.values()];
}

/**
 * How well does `text` fit the control it is claimed to show? A base control is ranked among the base controls; an enhancement
 * among the enhancements, and its base control must also fit (a quotation cannot show AC-2(1) without being about AC-2).
 */
export function support53(text: string, controlId: string): ControlSupport {
  const idx = index53();
  const m = idx.meta.get(controlId);
  const none = (n: number): ControlSupport => ({ rank: n, score: 0, topScore: 0 });
  if (!m) return none(Number.MAX_SAFE_INTEGER);
  const tier = m.parent ? scoreIndex(idx.enhancements, text) : scoreIndex(idx.bases, text);
  const at = tier.findIndex((r) => r.id === controlId);
  const result: ControlSupport = { rank: at === -1 ? tier.length : at, score: at === -1 ? 0 : tier[at].score, topScore: tier[0]?.score ?? 0 };
  if (m.parent) {
    const baseRank = scoreIndex(idx.bases, text).findIndex((r) => r.id === m.parent);
    if (baseRank === -1 || baseRank > PARENT_SUPPORT_MAX_RANK) return { ...result, rank: tier.length };
  }
  return result;
}
