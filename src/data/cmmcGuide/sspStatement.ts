import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import { cmmcGuideLetter } from './displayId';
import { cmmcNumberOf, guideObjectives } from './guide';
import { getControlObjectives } from './objectives';

/**
 * The implementation statement an SSP prints for a control (#293): the control-level notes, then one paragraph per objective
 * narrative, so the screen, the export and the Markdown cannot drift. Pure: read-only, logs nothing, stores nothing. Objective
 * narratives may contain CUI and appear only where the control notes already do.
 *
 * Product decisions that live here and nowhere else:
 *  - GUARDED_FRAMEWORKS (the scope): CMMC Level 1 / 2 only; any other framework prints its notes byte for byte.
 *  - STATUS_PREFIX (D5): a narrative on an objective that is not Met prints with a status prefix; set a prefix to '' to drop it.
 *  - STARTER_TEXT_NEEDS_MET (D6): unedited starter-template text prints only once the objective is Met.
 */
export interface ObjectiveAnswer {
  status: ObjectiveStatus;
  implementationNarrative?: string | null;
}

export interface ComposedStatement {
  text: string;
  /** The printed (guide) letters, in guide order. */
  objectiveLetters: string[];
}

export const GUARDED_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2'];
export const STARTER_TEXT_NEEDS_MET = true;
export const STATUS_PREFIX: Record<ObjectiveStatus, string> = {
  MET: '',
  NOT_APPLICABLE: '(Not applicable) ',
  IN_PROGRESS: '(In progress) ',
  NOT_MET: '(Not met) ',
  NOT_STARTED: '(Not started) ',
};

/** Whether an objective's narrative is printed in the SSP: non-blank, not an unedited starter text that is not yet Met, not already in the notes. */
export function objectiveNarrativePrints(
  o: Pick<AssessmentObjective, 'status' | 'implementationNarrative' | 'prefilledTemplate'>,
  notes: string
): boolean {
  const n = (o.implementationNarrative ?? '').trim();
  if (n === '') return false;
  if (STARTER_TEXT_NEEDS_MET && o.status !== 'MET' && n === (o.prefilledTemplate ?? '').trim()) return false;
  return !(notes ?? '').includes(n);
}

export function composeImplementationStatement(
  controlId: string,
  notes: string | null | undefined,
  objectives: Readonly<Record<string, ObjectiveAnswer>> | undefined,
  framework: string
): ComposedStatement {
  const base = notes ?? '';
  if (objectives === undefined || !GUARDED_FRAMEWORKS.includes(framework) || cmmcNumberOf(controlId) === null) {
    return { text: base, objectiveLetters: [] };
  }
  const rows = getControlObjectives(controlId, undefined, undefined, objectives as unknown as Record<string, AssessmentObjective>, framework);
  // An answer does not have to carry its letter, so the letter comes from the guide (rows are in guide order).
  const guide = guideObjectives(cmmcNumberOf(controlId)!, framework);
  const letters: string[] = [];
  const paragraphs: string[] = [];
  for (const [i, o] of rows.entries()) {
    if (!objectiveNarrativePrints(o, base)) continue;
    const letter = cmmcGuideLetter(controlId, guide[i].letter, framework);
    letters.push(letter);
    paragraphs.push(`[${letter}] ${STATUS_PREFIX[o.status] ?? ''}${(o.implementationNarrative ?? '').trim()}`);
  }
  if (paragraphs.length === 0) return { text: base, objectiveLetters: [] };
  const joined = paragraphs.join('\n\n');
  const text = base.trim() === '' ? joined : `${base.replace(/\s+$/, '')}\n\n${joined}`;
  return { text, objectiveLetters: letters };
}
