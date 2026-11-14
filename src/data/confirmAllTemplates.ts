import type { AssessmentObjective } from '../types/assessment';

/** The part of an objective the "Use starter templates" plan reads. */
export type ConfirmAllObjective = Pick<AssessmentObjective, 'id' | 'letter' | 'text' | 'status' | 'prefilledTemplate' | 'implementationNarrative'>;

export interface ConfirmAllPlan {
  /** The implementation notes the apply would write: one section per objective with a template, joined by a blank line. */
  notes: string;
  /** The control already has notes that the apply would replace. */
  notesReplaced: boolean;
  /** Objectives whose non-empty narrative differs from their template (an empty template would clear it). */
  narrativesReplaced: { id: string; letter: string }[];
  /** Objectives whose status would move to In progress: those not MET, NOT_APPLICABLE or IN_PROGRESS already. A template never marks MET. */
  statusChanged: { id: string; letter: string }[];
  /** Objectives with a written template: the apply fills them and sets them to In progress (an objective already MET or N/A keeps its status). */
  filled: { id: string; letter: string }[];
  /** Objectives with only the generic wording: the apply leaves them as they are. */
  skipped: { id: string; letter: string }[];
  /** Something non-empty would be overwritten: ask first. A status change alone does not need a confirmation. */
  needsConfirmation: boolean;
}

/** One section of the notes the bulk apply writes; the same format as applyAllObjectiveTemplatesForControl in AssessmentContext. */
export const objectiveTemplateSection = (o: Pick<ConfirmAllObjective, 'letter' | 'text' | 'prefilledTemplate'>): string =>
  `[Objective ${o.letter.toUpperCase()} - ${o.text}]:\n${o.prefilledTemplate}`;

/** What "Use starter templates" would write and overwrite, so the screen can ask before it does. Counts and letters only: no existing text. */
export const planConfirmAll = (
  objectives: ConfirmAllObjective[],
  currentNotes: string,
  hasTemplate: (o: ConfirmAllObjective) => boolean = () => true
): ConfirmAllPlan => {
  const withTemplate = objectives.filter((o) => hasTemplate(o));
  const ref = (o: ConfirmAllObjective) => ({ id: o.id, letter: o.letter });
  const notes = withTemplate.map(objectiveTemplateSection).join('\n\n');
  const notesReplaced = withTemplate.length > 0 && currentNotes.trim() !== '' && currentNotes !== notes;
  const narrativesReplaced = withTemplate
    .filter((o) => (o.implementationNarrative || '').trim() !== '' && (o.implementationNarrative || '').trim() !== (o.prefilledTemplate || '').trim())
    .map(ref);
  const statusChanged = withTemplate
    .filter((o) => o.status !== 'MET' && o.status !== 'NOT_APPLICABLE' && o.status !== 'IN_PROGRESS')
    .map(ref);
  return {
    notes, notesReplaced, narrativesReplaced, statusChanged,
    filled: withTemplate.map(ref),
    skipped: objectives.filter((o) => !hasTemplate(o)).map(ref),
    needsConfirmation: notesReplaced || narrativesReplaced.length > 0,
  };
};

/** What the screen says after the apply: how many objectives were filled and how many were left without a template. */
export const confirmAllResultMessage = (filled: number, skipped: number): string => {
  const total = filled + skipped;
  const objectivesWord = `objective${total === 1 ? '' : 's'}`;
  if (filled === 0) return `No starter template was written: none of the ${total} ${objectivesWord} has one.`;
  const head = `Starter templates written to ${filled} of ${total} ${objectivesWord}. Review ${total === 1 ? 'it' : 'each one'}, then mark it Met.`;
  if (skipped === 0) return head;
  return `${head} ${skipped} ${skipped === 1 ? 'objective has' : 'objectives have'} no template and ${skipped === 1 ? 'was' : 'were'} left unchanged.`;
};
