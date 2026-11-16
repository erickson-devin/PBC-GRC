import type { AssessmentObjective } from '../../types/assessment';
import { statusDisplayLabel } from '../statusLabels';
import { cmmcNumberOf } from './guide';
import { GUARDED_FRAMEWORKS, composeImplementationStatement, objectiveNarrativePrints } from './sspStatement';
import type { ObjectiveAnswer } from './sspStatement';

/**
 * What the control dialog and the matrix say about the SSP statement (#293 / #294). Pure: no React, no storage, no logging. A narrative
 * may contain CUI: it is compared and counted here, never copied into a label.
 */

/** Whether the SSP adds objective narratives to this control's statement (CMMC Level 1 / 2 controls only). */
export function objectiveNarrativesInSsp(controlId: string, framework: string): boolean {
  return GUARDED_FRAMEWORKS.includes(framework) && cmmcNumberOf(controlId) !== null;
}

export type ObjectiveSspBadge = { kind: 'prints' | 'starter' | 'duplicate'; text: string } | null;

/** The badge beside an objective's narrative box. It asks `objectiveNarrativePrints` and only classifies the reason when that says no. */
export function objectiveSspBadge(
  controlId: string,
  framework: string,
  o: Pick<AssessmentObjective, 'status' | 'implementationNarrative' | 'prefilledTemplate'>,
  notes: string
): ObjectiveSspBadge {
  if (!objectiveNarrativesInSsp(controlId, framework)) return null;
  const narrative = (o.implementationNarrative ?? '').trim();
  if (narrative === '') return null;
  if (objectiveNarrativePrints(o, notes)) {
    return { kind: 'prints', text: o.status === 'MET' ? 'Prints in the SSP' : `Prints in the SSP as ${statusDisplayLabel(o.status)}` };
  }
  if (o.status !== 'MET' && narrative === (o.prefilledTemplate ?? '').trim()) {
    return { kind: 'starter', text: 'Starter text: prints once Met' };
  }
  return { kind: 'duplicate', text: 'Already in the control statement' };
}

export function sspStatementLabel(controlId: string, framework: string): { label: string; help: string } {
  if (objectiveNarrativesInSsp(controlId, framework)) {
    return {
      label: 'Control statement (optional)',
      help: 'Printed first in the SSP for this control. Each objective narrative that prints follows it, labelled with its letter.',
    };
  }
  return { label: 'Implementation statement', help: "Printed in the SSP as this control's implementation statement." };
}

export function sspPreviewCaption(controlId: string, framework: string, letters: readonly string[]): string {
  if (!objectiveNarrativesInSsp(controlId, framework)) {
    return 'This framework prints the implementation statement only. Objective narratives are not added.';
  }
  if (letters.length === 0) {
    return 'No objective narrative prints yet. A narrative prints once written; starter text prints once its objective is Met.';
  }
  const list = letters.map((l) => `[${l}]`).join(', ');
  return letters.length === 1 ? `Includes the narrative of objective ${list}.` : `Includes the narratives of objectives ${list}.`;
}

/** Whether the SSP prints anything for the control: the notes or at least one objective narrative. */
export function hasSspStatement(
  controlId: string,
  notes: string | null | undefined,
  objectives: Readonly<Record<string, ObjectiveAnswer>> | undefined,
  framework: string
): boolean {
  return composeImplementationStatement(controlId, notes, objectives, framework).text.trim() !== '';
}
