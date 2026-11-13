/**
 * The CMMC Assessment Guide data (DoD CIO, version 2.13, public release) as typed lookups. The shipped control catalogs in
 * src/data/frameworks/ are untouched: this module only supplies the guide's objectives and display titles, keyed by the
 * 800-171 requirement number inside a CMMC control id ('AC.L2-3.1.1' and 'AC.L1-3.1.1' are both 3.1.1).
 */
import l2Json from './cmmcL2Guide.generated.json';
import l1Json from './cmmcL1Guide.generated.json';
import type { GuideObjective, L1GuideFile, L2GuideFile, L2Requirement } from './validate';

export const CMMC_L2_GUIDE = l2Json as L2GuideFile;
export const CMMC_L1_GUIDE = l1Json as L1GuideFile;

/** Which version of the guide's objectives a cached or stored answer was last reconciled with. */
export const CMMC_OBJECTIVE_CATALOG_REV = 'cmmc-ag-2.13';

const L2_BY_NUMBER = new Map<string, L2Requirement>(CMMC_L2_GUIDE.requirements.map((r) => [r.number, r]));

/** Level 1 objectives per 800-171 number, in the 800-171 letter order of the Level 2 guide. */
const L1_BY_NUMBER = new Map<string, GuideObjective[]>();
for (const r of CMMC_L1_GUIDE.requirements) {
  for (const o of r.objectives) {
    const list = L1_BY_NUMBER.get(o.number) ?? [];
    list.push({ letter: o.numberLetter, text: o.text });
    L1_BY_NUMBER.set(o.number, list);
  }
}
for (const list of L1_BY_NUMBER.values()) list.sort((a, b) => a.letter.localeCompare(b.letter));

/**
 * The 800-171 number of a CMMC control id ('AC.L2-3.1.1', 'AC.L1-3.1.1'), when the guide has that requirement. A bare '3.1.1',
 * a FAR id ('AC.L1-b.1.i') or any other framework's id returns null and keeps the behaviour it had before the guide.
 */
export function cmmcNumberOf(controlId: string): string | null {
  const m = /^[A-Z]{2}\.L[12]-(3\.\d{1,2}\.\d{1,2})$/i.exec((controlId ?? '').trim());
  return m && L2_BY_NUMBER.has(m[1]) ? m[1] : null;
}

/** The guide's objectives for a requirement: Level 1 wording for a Level 1 program (it says [FCI]), Level 2 wording otherwise. */
export function guideObjectives(number: string, framework?: string): GuideObjective[] {
  if (framework === 'CMMC_L1') {
    const l1 = L1_BY_NUMBER.get(number);
    if (l1) return l1;
  }
  return L2_BY_NUMBER.get(number)?.objectives ?? [];
}

/** The guide's title for a CMMC control, for both levels, without its [CUI Data] / [FCI Data] tag. Undefined for any other id. */
export function cmmcGuideTitle(controlId: string): string | undefined {
  const n = cmmcNumberOf(controlId);
  return n ? L2_BY_NUMBER.get(n)?.displayTitle : undefined;
}

/** A copy of the control with the guide's title; a control that is not a CMMC requirement comes back unchanged. */
export function withGuideTitle<T extends { id: string; title: string }>(ctrl: T): T {
  const title = cmmcGuideTitle(ctrl.id);
  return title ? { ...ctrl, title } : ctrl;
}
