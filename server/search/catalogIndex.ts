import { programCatalogControls } from '../programCatalog';
import { PROGRAM_SCOPING_KEYS } from '../../src/data/programScope';
import { cmmcDisplayId } from '../../src/data/cmmcGuide/displayId';
import { cmmcNumberOf, guideObjectives } from '../../src/data/cmmcGuide/guide';
import type { Program } from '../programs';

/**
 * The searchable text of a program's control catalog (#254): each control's id, the id the guide shows for it and its title, and, for CMMC, the text of each
 * assessment objective. It is shipped with the app (not CUI), so it is built once per framework, baseline, privacy baseline and overlay combination and kept
 * in this module's memory. Nothing a person typed is here: notes and narratives are read per request, under the program's row policies.
 */

export interface CatalogControl {
  id: string;
  /** The id the screens show (the Level 2 id in a Level 2 program, the FAR id in a Level 1 program); the stored id for any other framework. */
  displayId: string;
  title: string;
}

export interface CatalogObjective {
  /** The stored objective id, `AC.L2-3.1.1[a]`. */
  id: string;
  controlId: string;
  text: string;
}

export interface CatalogIndex {
  controls: CatalogControl[];
  /** CMMC programs only: the guide's objective text. Other frameworks' objectives have no stable id, so only a stored narrative can be searched. */
  objectives: CatalogObjective[];
  byId: Map<string, CatalogControl>;
}

const cache = new Map<string, CatalogIndex>();

const keyOf = (p: Pick<Program, 'frameworkId' | 'baseline' | 'privacyBaseline' | 'scoping'>): string =>
  [p.frameworkId, p.baseline ?? '', p.privacyBaseline ? 'privacy' : '', PROGRAM_SCOPING_KEYS.filter((k) => p.scoping[k]).join('+')].join('|');

/** The index of the program's catalog (built on first use). */
export function catalogIndexFor(program: Pick<Program, 'frameworkId' | 'baseline' | 'privacyBaseline' | 'scoping'>): CatalogIndex {
  const key = keyOf(program);
  const hit = cache.get(key);
  if (hit) return hit;
  const controls: CatalogControl[] = [];
  const objectives: CatalogObjective[] = [];
  for (const c of programCatalogControls(program)) {
    controls.push({ id: c.id, displayId: cmmcDisplayId(c.id, program.frameworkId), title: c.title });
    const number = program.frameworkId === 'CMMC_L1' || program.frameworkId === 'CMMC_L2' ? cmmcNumberOf(c.id) : null;
    if (number) for (const g of guideObjectives(number, program.frameworkId)) objectives.push({ id: `${c.id}[${g.letter}]`, controlId: c.id, text: g.text });
  }
  const index: CatalogIndex = { controls, objectives, byId: new Map(controls.map((c) => [c.id, c] as const)) };
  cache.set(key, index);
  return index;
}

/** Test hook. */
export function __clearCatalogIndexForTests(): void {
  cache.clear();
}
