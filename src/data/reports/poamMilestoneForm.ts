import type { PoamMilestone, PoamMilestoneInput } from '../../types/poamMilestone';
import type { UnsavedTextEntry } from '../../services/unsavedText';
import { VM_POAM_DATE_MAX, VM_POAM_DATE_MIN } from '../poamDates';
import { POAM_MILESTONES_MAX, POAM_MILESTONE_DESCRIPTION_MAX, parseMilestonesInput } from '../poamMilestones';

/**
 * #304: the milestone list of a POA&M entry as an editable form, in pure functions shared by the control entry dialog and the vulnerability item
 * dialog (the stored shape and the server's parser are in ../poamMilestones). A milestone's description is user text and may be CUI: nothing here
 * stores, logs or sends it; every error and label names a milestone by its number (M1, M2, ...), never by its text.
 */

export { POAM_MILESTONES_MAX, POAM_MILESTONE_DESCRIPTION_MAX };

/** One row of the editor. `key` is the row's identity in React (the stored id, or new-n for a row added here); `id` is set only for a stored milestone. */
export interface MilestoneDraft {
  key: string;
  id?: string;
  description: string;
  /** '' = no date yet (an error on save). */
  targetDate: string;
  completed: boolean;
}

export interface MilestoneRowError {
  description?: string;
  targetDate?: string;
}

export const MILESTONE_COPY = {
  hint: `Printed as M1, M2 and so on, in this order. At most ${POAM_MILESTONES_MAX}.`,
  empty: 'No milestones recorded. Exports print that none are recorded.',
  limit: `${POAM_MILESTONES_MAX} of ${POAM_MILESTONES_MAX} milestones. Remove one to add another.`,
  listError: 'Check the milestones marked below.',
  completedBadge: 'Completed',
  pendingBadge: 'Pending',
};

/** The number a milestone prints under: M1 for the first row. */
export const milestoneLabel = (index: number): string => `M${index + 1}`;

export const milestoneDescriptionError = (index: number): string => `${milestoneLabel(index)}: describe it in 1 to ${POAM_MILESTONE_DESCRIPTION_MAX} characters on one line.`;
export const milestoneDateError = (index: number): string => `${milestoneLabel(index)}: a real date from ${VM_POAM_DATE_MIN} to ${VM_POAM_DATE_MAX}.`;
export const milestoneRemovedText = (index: number): string => `${milestoneLabel(index)} removed. Not saved yet.`;

/** The editor rows of a stored list (a row's key is its id). */
export function milestoneDrafts(list: readonly PoamMilestone[] | undefined): MilestoneDraft[] {
  return (list ?? []).map((m) => ({ key: m.id, id: m.id, description: m.description, targetDate: m.targetDate, completed: m.completed }));
}

/** A new empty row. `n` makes its key unique within the editor (new-1, new-2, ...). */
export const newMilestoneDraft = (n: number): MilestoneDraft => ({ key: `new-${n}`, description: '', targetDate: '', completed: false });

/** The next free new-n number for a list. */
export function nextNewMilestoneNumber(drafts: readonly MilestoneDraft[]): number {
  let max = 0;
  for (const d of drafts) {
    const m = /^new-(\d+)$/.exec(d.key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** The list as an edit request sends it: the whole list in order, `key` stripped, an id only on a stored milestone, the description trimmed. */
export function milestonesPatch(drafts: readonly MilestoneDraft[]): PoamMilestoneInput[] {
  return drafts.map((d) => ({ ...(d.id ? { id: d.id } : {}), description: d.description.trim(), targetDate: d.targetDate, completed: d.completed }));
}

/** One comparable string per list: a new row (no id) never equals a stored one, so adding then removing a row is not a change. */
const draftsKey = (drafts: readonly MilestoneDraft[]): string =>
  JSON.stringify(drafts.map((d) => [d.id ?? '', d.description.trim(), d.targetDate, d.completed]));
const storedKey = (list: readonly PoamMilestone[]): string => draftsKey(milestoneDrafts(list));

/** True when the rows differ from the stored list (order, text, date, completion, additions, removals). */
export const milestonesChanged = (base: readonly PoamMilestone[] | undefined, drafts: readonly MilestoneDraft[]): boolean => storedKey(base ?? []) !== draftsKey(drafts);

/** Per row, why it cannot be saved (the server's own parser decides, one field at a time). Rows without a problem have no entry. */
export function milestoneErrors(drafts: readonly MilestoneDraft[]): Record<number, MilestoneRowError> {
  const out: Record<number, MilestoneRowError> = {};
  drafts.forEach((d, i) => {
    const row: MilestoneRowError = {};
    if (!parseMilestonesInput([{ description: d.description, targetDate: VM_POAM_DATE_MIN }]).ok) row.description = milestoneDescriptionError(i);
    if (!parseMilestonesInput([{ description: 'x', targetDate: d.targetDate }]).ok) row.targetDate = milestoneDateError(i);
    if (row.description || row.targetDate) out[i] = row;
  });
  return out;
}

/** True when the list as a whole is refused: too many rows or a row with a problem. */
export const milestoneListInvalid = (drafts: readonly MilestoneDraft[]): boolean =>
  drafts.length > POAM_MILESTONES_MAX || Object.keys(milestoneErrors(drafts)).length > 0;

/** The rows with one moved a place up (dir -1) or down (dir 1). The same rows when it cannot move. */
export function moveMilestone(drafts: readonly MilestoneDraft[], index: number, dir: -1 | 1): MilestoneDraft[] {
  const to = index + dir;
  if (index < 0 || index >= drafts.length || to < 0 || to >= drafts.length) return [...drafts];
  const next = [...drafts];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** How many rows are not completed. */
export const pendingMilestoneCount = (drafts: readonly MilestoneDraft[]): number => drafts.filter((d) => !d.completed).length;

/** Said when an item is set to Completed while milestones are still pending. A warning only: the item can still be completed. Null otherwise. */
export function pendingMilestoneWarning(drafts: readonly MilestoneDraft[], nextStatus: string): string | null {
  if (nextStatus !== 'COMPLETED') return null;
  const n = pendingMilestoneCount(drafts);
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'milestone is' : 'milestones are'} not marked completed. You can still complete the item; the export prints ${n === 1 ? 'it' : 'them'} as Pending.`;
}

/** "{done} of {n} milestones completed", or null for none (the list row under the status). */
export function milestoneProgressText(list: readonly { completed?: boolean }[] | undefined): string | null {
  const n = list?.length ?? 0;
  if (n === 0) return null;
  const done = (list ?? []).filter((m) => m.completed).length;
  return `${done} of ${n} ${n === 1 ? 'milestone' : 'milestones'} completed`;
}

/** How a read-only view or the export prints one milestone: "M1. {description}, {date}, Completed". */
export function printedMilestoneLine(m: { description: string; targetDate: string; completed: boolean }, index: number): string {
  return `${milestoneLabel(index)}. ${m.description}, ${m.targetDate}, ${m.completed ? MILESTONE_COPY.completedBadge : MILESTONE_COPY.pendingBadge}`;
}

/**
 * Three-way merge of the whole list after a stale write. Untouched: the server's list. Touched: the person's rows stay; a row that points at a
 * stored milestone the server no longer holds becomes a new row (the server refuses an unknown id). `conflict` = both sides changed the list
 * to different results.
 */
export function rebaseMilestones(
  oldBase: readonly PoamMilestone[] | undefined,
  newBase: readonly PoamMilestone[] | undefined,
  drafts: readonly MilestoneDraft[]
): { drafts: MilestoneDraft[]; conflict: boolean } {
  const was = oldBase ?? [];
  const now = newBase ?? [];
  if (!milestonesChanged(was, drafts)) return { drafts: milestoneDrafts(now), conflict: false };
  const known = new Set(now.map((m) => m.id));
  let n = nextNewMilestoneNumber(drafts);
  const kept = drafts.map((d) => {
    if (!d.id || known.has(d.id)) return { ...d };
    return { key: `new-${n++}`, description: d.description, targetDate: d.targetDate, completed: d.completed };
  });
  const serverChanged = storedKey(was) !== storedKey(now);
  return { drafts: kept, conflict: serverChanged && storedKey(now) !== draftsKey(kept.map((d) => ({ ...d }))) };
}

/** The typed milestones as one text for the session rescue (label and key are supplied by the caller; never logged or stored). */
export function milestonesUnsavedText(key: string, label: string, drafts: readonly MilestoneDraft[]): UnsavedTextEntry {
  return { key, label, text: drafts.map((d, i) => `${milestoneLabel(i)}. ${d.description}${d.targetDate ? ` (${d.targetDate})` : ''}${d.completed ? ' [completed]' : ''}`).join('\n') };
}
