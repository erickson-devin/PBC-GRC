import { cmmcNumberOf, guideObjectives } from './guide';
import { normalizeObjectiveText } from './validate';

/**
 * The CMMC Assessment Guide letter (the objective checklist's) of one objective listed by an SSP import's gap analysis, matched
 * by wording. undefined: not a CMMC control. null: a CMMC control, but no checklist objective has this wording.
 */
export function checklistLetterOf(controlId: string, framework: string, text: string): string | null | undefined {
  const number = cmmcNumberOf(controlId);
  if (!number) return undefined;
  const want = normalizeObjectiveText(text);
  for (const fw of [framework, 'CMMC_L2']) {
    const hits = guideObjectives(number, fw).filter((g) => normalizeObjectiveText(g.text) === want);
    if (hits.length === 1) return hits[0].letter;
  }
  return null;
}

/**
 * The checklist letters (the guide's, in guide order) of a CMMC control that none of an import's objective texts is worded like (#284),
 * so a person sees which ones the import did not compare. undefined: the control has no guide objectives for this framework.
 */
export function uncoveredChecklistLetters(controlId: string, framework: string, texts: string[]): string[] | undefined {
  const number = cmmcNumberOf(controlId);
  if (!number) return undefined;
  const letters = guideObjectives(number, framework).map((g) => g.letter);
  if (letters.length === 0) return undefined;
  const covered = new Set<string>();
  for (const t of texts) {
    const l = checklistLetterOf(controlId, framework, t);
    if (typeof l === 'string') covered.add(l);
  }
  return letters.filter((l) => !covered.has(l));
}

/** The line shown for those letters ('' when there are none). */
export function uncoveredChecklistText(letters: readonly string[]): string {
  if (letters.length === 0) return '';
  const list = letters.map((l) => `[${l}]`).join(', ');
  return letters.length === 1
    ? `Checklist objective the import did not compare: ${list}. Mark it yourself.`
    : `Checklist objectives the import did not compare: ${list}. Mark them yourself.`;
}
