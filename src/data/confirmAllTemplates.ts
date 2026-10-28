import type { AssessmentObjective } from '../types/assessment';

/** The part of an objective the "Confirm All Best-Practice Narratives" plan reads. */
export type ConfirmAllObjective = Pick<AssessmentObjective, 'id' | 'letter' | 'text' | 'status' | 'prefilledTemplate' | 'implementationNarrative'>;

export interface ConfirmAllPlan {
  /** The implementation notes the apply would write: one section per objective, joined by a blank line. */
  notes: string;
  /** The control already has notes that the apply would replace. */
  notesReplaced: boolean;
  /** Objectives whose non-empty narrative differs from their template (an empty template would clear it). */
  narrativesReplaced: { id: string; letter: string }[];
  /** Objectives that are neither MET nor NOT_STARTED and would be marked MET. */
  statusChanged: { id: string; letter: string }[];
  /** Something non-empty would be overwritten: ask first. A status change alone does not need a confirmation. */
  needsConfirmation: boolean;
}

/** One section of the notes the bulk apply writes; the same format as applyAllObjectiveTemplatesForControl in AssessmentContext. */
export const objectiveTemplateSection = (o: Pick<ConfirmAllObjective, 'letter' | 'text' | 'prefilledTemplate'>): string =>
  `[Objective ${o.letter.toUpperCase()} - ${o.text}]:\n${o.prefilledTemplate}`;

/** What "Confirm All Best-Practice Narratives" would overwrite, so the screen can ask before it does. Counts and letters only: no existing text. */
export const planConfirmAll = (objectives: ConfirmAllObjective[], currentNotes: string): ConfirmAllPlan => {
  const notes = objectives.map(objectiveTemplateSection).join('\n\n');
  const notesReplaced = currentNotes.trim() !== '' && currentNotes !== notes;
  const narrativesReplaced = objectives
    .filter((o) => (o.implementationNarrative || '').trim() !== '' && (o.implementationNarrative || '').trim() !== (o.prefilledTemplate || '').trim())
    .map((o) => ({ id: o.id, letter: o.letter }));
  const statusChanged = objectives
    .filter((o) => o.status !== 'MET' && o.status !== 'NOT_STARTED')
    .map((o) => ({ id: o.id, letter: o.letter }));
  return { notes, notesReplaced, narrativesReplaced, statusChanged, needsConfirmation: notesReplaced || narrativesReplaced.length > 0 };
};
