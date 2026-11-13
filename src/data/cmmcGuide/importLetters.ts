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
