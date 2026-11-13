import { CMMC_L1_GUIDE, CMMC_L2_GUIDE, cmmcNumberOf } from './guide';
import type { L1Requirement } from './validate';
import { getFrameworkControls } from '../frameworks/frameworkRegistry';
import type { AssessmentState } from '../../types/cmmc';

/**
 * The control id the CMMC Assessment Guide prints, as a display alias only: the id the platform stores (and every compiler,
 * crosswalk and import reads) is never renamed. A Level 2 program, or no program, shows the Level 2 guide id ('AC.L2-3.1.1' for
 * the stored 'AC.L1-3.1.1'); a Level 1 program shows the FAR id ('AC.L1-b.1.i'), with the 800-171 number added where one FAR
 * requirement covers several controls ('PE.L1-b.1.ix (3.10.4)'). Pure: nothing here mutates its input or logs an id.
 */

const L2_BY_NUMBER = new Map(CMMC_L2_GUIDE.requirements.map((r) => [r.number, r]));
const L1_BY_NUMBER = new Map<string, L1Requirement>();
for (const r of CMMC_L1_GUIDE.requirements) for (const n of r.numbers) L1_BY_NUMBER.set(n, r);

/** The id each 800-171 number is stored under. Built on first use: the Level 2 catalog's ids include all 17 Level 1 ids. */
let storedByNumber: Map<string, string> | null = null;
const stored = () => {
  if (!storedByNumber) {
    storedByNumber = new Map();
    for (const c of getFrameworkControls('CMMC_L2')) {
      const n = cmmcNumberOf(c.id);
      if (n) storedByNumber.set(n, c.id);
    }
  }
  return storedByNumber;
};

/** Upper-cased guide id or stored id -> the stored ids it names (a FAR id that covers several controls names several). */
let storedByText: Map<string, string[]> | null = null;
const byText = () => {
  if (!storedByText) {
    storedByText = new Map();
    for (const [n, id] of stored()) {
      storedByText.set(id.toUpperCase(), [id]);
      const l2 = L2_BY_NUMBER.get(n);
      if (l2) storedByText.set(l2.id.toUpperCase(), [id]);
    }
    for (const r of CMMC_L1_GUIDE.requirements) {
      const ids = r.numbers.map((n) => stored().get(n)).filter((id): id is string => !!id);
      if (ids.length) storedByText.set(r.id.toUpperCase(), ids);
    }
  }
  return storedByText;
};

const OBJECTIVE_RE = /^(.+)\[([a-z0-9]+)\]$/i;

/** The guide's id for a control: the Level 1 FAR id for CMMC_L1, the Level 2 id otherwise. Any other id comes back unchanged. */
export function cmmcGuideId(controlId: string, framework?: string): string {
  const number = cmmcNumberOf(controlId);
  if (!number) return controlId;
  if (framework === 'CMMC_L1') {
    const l1 = L1_BY_NUMBER.get(number);
    if (l1) return l1.id;
  }
  return L2_BY_NUMBER.get(number)?.id ?? controlId;
}

/** cmmcGuideId, plus the 800-171 number in brackets where the Level 1 requirement covers more than one control. */
export function cmmcDisplayId(controlId: string, framework?: string): string {
  const id = cmmcGuideId(controlId, framework);
  const number = cmmcNumberOf(controlId);
  if (!number || framework !== 'CMMC_L1') return id;
  const l1 = L1_BY_NUMBER.get(number);
  return l1 && l1.numbers.length > 1 ? `${id} (${number})` : id;
}

/** The guide's letter for a stored objective letter: only a Level 1 program re-letters (the three PE controls share one list). */
export function cmmcGuideLetter(controlId: string, letter: string, framework?: string): string {
  const number = cmmcNumberOf(controlId);
  if (!number || framework !== 'CMMC_L1') return letter;
  const o = L1_BY_NUMBER.get(number)?.objectives.find((x) => x.number === number && x.numberLetter === letter);
  return o ? o.letter : letter;
}

/** The guide's id for a stored objective id ('PE.L1-3.10.4[a]' is 'PE.L1-b.1.ix[c]' in a Level 1 program). Others come back unchanged. */
export function cmmcGuideObjectiveId(objectiveId: string, framework?: string): string {
  const m = OBJECTIVE_RE.exec(objectiveId ?? '');
  if (!m) return objectiveId;
  const number = cmmcNumberOf(m[1]);
  if (!number) return objectiveId;
  if (framework === 'CMMC_L1') {
    const l1 = L1_BY_NUMBER.get(number);
    const o = l1?.objectives.find((x) => x.number === number && x.numberLetter === m[2]);
    return l1 && o ? `${l1.id}[${o.letter}]` : objectiveId;
  }
  return `${cmmcGuideId(m[1], framework)}[${m[2]}]`;
}

/** The stored ids a guide id or stored id names (exact, any case). 'PE.L1-b.1.ix' names three; anything else names none. */
export function cmmcStoredIds(text: string): string[] {
  return [...(byText().get((text ?? '').trim().toUpperCase()) ?? [])];
}

/** The stored objective id a guide objective id or stored objective id names, or null when it names none. */
export function cmmcStoredObjectiveId(text: string): string | null {
  const m = OBJECTIVE_RE.exec((text ?? '').trim());
  if (!m) return null;
  const ids = cmmcStoredIds(m[1]);
  if (ids.length === 0) return null;
  const letter = m[2].toLowerCase();
  const far = CMMC_L1_GUIDE.requirements.find((r) => r.id.toUpperCase() === m[1].toUpperCase());
  if (far) {
    const o = far.objectives.find((x) => x.letter === letter);
    const id = o ? stored().get(o.number) : undefined;
    return o && id ? `${id}[${o.numberLetter}]` : null;
  }
  const number = cmmcNumberOf(ids[0]);
  return number && L2_BY_NUMBER.get(number)?.objectives.some((o) => o.letter === letter) ? `${ids[0]}[${letter}]` : null;
}

/**
 * Re-keys an imported state's controls, objectives and evidence from guide ids to stored ids. Returns a new state (the input is
 * never mutated) and counts only. A key already present under the stored id wins and the alias copy is dropped (skipped); a FAR
 * id that covers several controls is ambiguous at control level and is left alone (skipped). Not a CMMC framework: no change.
 */
export function normalizeImportedCmmcIds(state: AssessmentState, framework: string): { state: AssessmentState; renamed: number; skipped: number } {
  if (framework !== 'CMMC_L1' && framework !== 'CMMC_L2') return { state, renamed: 0, skipped: 0 };
  let renamed = 0;
  let skipped = 0;

  const controls: AssessmentState['controls'] = {};
  const inControls = state.controls ?? {};
  for (const [key, value] of Object.entries(inControls)) {
    const ids = cmmcStoredIds(key);
    if (ids.length === 0 || (ids.length === 1 && ids[0] === key)) {
      if (!(key in controls)) controls[key] = value;
      continue;
    }
    if (ids.length > 1) {
      skipped++;
      controls[key] = value;
      continue;
    }
    if (ids[0] in inControls || ids[0] in controls) {
      skipped++;
      continue;
    }
    controls[ids[0]] = { ...value, id: ids[0] };
    renamed++;
  }

  let objectives = state.objectives;
  if (state.objectives) {
    const out: NonNullable<AssessmentState['objectives']> = {};
    const inObjectives = state.objectives;
    for (const [key, value] of Object.entries(inObjectives)) {
      const id = cmmcStoredObjectiveId(key);
      if (id === null || id === key) {
        if (!(key in out)) out[key] = value;
        continue;
      }
      if (id in inObjectives || id in out) {
        skipped++;
        continue;
      }
      const old = OBJECTIVE_RE.exec(key)!;
      const letter = id.slice(id.lastIndexOf('[') + 1, -1);
      out[id] = { ...value, id, controlId: id.slice(0, id.lastIndexOf('[')), letter: value.letter === old[2] ? letter : value.letter };
      renamed++;
    }
    objectives = out;
  }

  const evidenceIndex = (state.evidenceIndex ?? []).map((e) => {
    const ids = cmmcStoredIds(e.controlId);
    if (ids.length === 0 || (ids.length === 1 && ids[0] === e.controlId)) return e;
    if (ids.length > 1) {
      skipped++;
      return e;
    }
    renamed++;
    return { ...e, controlId: ids[0] };
  });

  return { state: { ...state, controls, objectives, evidenceIndex }, renamed, skipped };
}
