import type { VmPoamItemEvent, VmPoamItemPatch, VmPoamRow, VmPoamStatus } from '../../types/vm';
import type { UnsavedTextEntry } from '../../services/unsavedText';
import {
  VM_POAM_DATE_MAX, VM_POAM_DATE_MIN, VM_POAM_MITIGATION_MAX, VM_POAM_OWNER_MAX,
  parseVmPoamPatch, planVmPoamStatus, vmPoamFindingOpenInEpisode,
} from '../vmPoamEdit';
import { isOpenVmPoamStatus, isoDate } from './vmPoamView';

/**
 * #297: the edit form of a vulnerability POA&M item as pure functions: the form values and the patch they make, the field errors, the
 * status options and the rules said before the server refuses them, the merge after a stale write, fixed texts for every failed save, the
 * row markers and the change history. The owner and the plan are user text and may be sensitive: nothing here stores, logs or sends
 * them anywhere; every error and label names a field, never a value.
 */

/** The actor the server records for the scanner worker (server/vm/transitions.ts VM_WORKER_ACTOR). */
export const VM_WORKER_ACTOR_NAME = 'system:vm-worker';

export const VM_POAM_STATUS_LABEL: Record<VmPoamStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', RISK_ACCEPTED: 'Risk accepted' };

export interface VmPoamForm {
  owner: string;
  mitigation: string;
  /** '' = no date. */
  scheduledCompletion: string;
  status: VmPoamStatus;
}
export type VmPoamFormField = 'owner' | 'mitigation' | 'scheduledCompletion' | 'status';

const MITIGATION_REQUIRED = 'Risk accepted needs a plan: describe the mitigation and why the risk is accepted.';
const COMPLETED_BLOCKED_AUTO = 'Completed is not available while the scanner still reports this vulnerability. The item is completed automatically when a later scan no longer reports it. To close it now, choose Risk accepted and describe the mitigation.';
const COMPLETED_BLOCKED = 'Completed is not available while the scanner still reports this vulnerability. Complete it after a scan no longer reports it, or choose Risk accepted and describe the mitigation.';

export const VM_POAM_ITEM_COPY = {
  ownerError: `Owner: at most ${VM_POAM_OWNER_MAX} characters, with no control characters.`,
  mitigationError: `Plan: at most ${VM_POAM_MITIGATION_MAX} characters. Line breaks and tabs are allowed; other control characters are not.`,
  dateError: `Target date: a real date from ${VM_POAM_DATE_MIN} to ${VM_POAM_DATE_MAX}.`,
  mitigationRequired: MITIGATION_REQUIRED,
  completedBlockedAuto: COMPLETED_BLOCKED_AUTO,
  completedBlocked: COMPLETED_BLOCKED,
  reopenWarning: 'Reopening turns off automatic completion for this item. A later scan that no longer reports the vulnerability will not complete it; a person has to.',
  saveStale: 'Someone else or a scan changed this item while you were editing. Nothing was saved, and your entries are still in the form.',
  saveArchived: 'This program was archived while you were editing, so its items are read-only. Nothing was saved. Copy any text you need.',
  saveInvalid: 'One of the values was not accepted. Check the fields and try again.',
  saveForbidden: 'Your role cannot edit POA&M items. Nothing was saved.',
  saveNotFound: 'This item no longer exists in this program. Nothing was saved. Copy any text you need.',
  saveNetwork: 'The server could not be reached. Nothing was saved; your entries are still in the form. Try again.',
  saveFailed: 'The item could not be saved. Your entries are still in the form. Try again.',
  loadCurrent: 'Load the current values',
  loadingCurrent: 'Loading the current values…',
  loadCurrentFailed: 'The current values could not be loaded. Try again.',
  loadedNoConflict: 'The current values are loaded. Your changes are kept; save again to apply them.',
  useCurrent: 'Use the current values instead',
  removedNote: 'This item is no longer in the list: a scan or someone else completed it or accepted the risk, or it was removed. Nothing was saved. Copy any text you need, then close this dialog.',
  removedHint: ' To open it again, turn on Show completed and risk-accepted items.',
  discardQuestion: 'Discard your changes to this item? They have not been saved.',
  historyLoading: 'Loading the history…',
  historyError: 'The history could not be loaded.',
  historyEmpty: 'No changes recorded since the item was created.',
  historyCap: 'Showing the latest 100 changes.',
  notRecorded: 'Not recorded',
};

const FIELD_NAME: Record<VmPoamFormField, string> = { owner: 'owner', mitigation: 'plan', scheduledCompletion: 'target date', status: 'status' };

/** Field names for a note, in the order the form shows them. */
export function vmPoamFieldNames(fields: readonly VmPoamFormField[]): string {
  return fields.map((f) => FIELD_NAME[f]).join(', ');
}

export function vmPoamFormFrom(row: VmPoamRow): VmPoamForm {
  return { owner: row.owner, mitigation: row.mitigation, scheduledCompletion: row.scheduledCompletion ?? '', status: row.status };
}

const findingOpen = (row: VmPoamRow): boolean => vmPoamFindingOpenInEpisode(row, row.finding);
const isWorkerItem = (row: VmPoamRow): boolean => row.createdBy === VM_WORKER_ACTOR_NAME;

/** Changed keys only: owner compared trimmed and sent trimmed; '' date -> null; mitigation compared trimmed and sent as typed. */
export function vmPoamFormPatch(base: VmPoamRow, form: VmPoamForm): VmPoamItemPatch {
  const patch: VmPoamItemPatch = {};
  if (form.owner.trim() !== base.owner.trim()) patch.owner = form.owner.trim();
  if (form.mitigation.trim() !== base.mitigation.trim()) patch.mitigation = form.mitigation;
  if ((form.scheduledCompletion || null) !== base.scheduledCompletion) patch.scheduledCompletion = form.scheduledCompletion || null;
  if (form.status !== base.status) patch.status = form.status;
  return patch;
}

export function vmPoamFormDirty(base: VmPoamRow, form: VmPoamForm): boolean {
  return Object.keys(vmPoamFormPatch(base, form)).length > 0;
}

/** Why the form cannot be saved, per field. Each changed field runs alone through the server's parser; the status rules run on the whole edit. */
export function vmPoamFormErrors(base: VmPoamRow, form: VmPoamForm): Partial<Record<VmPoamFormField, string>> {
  const errors: Partial<Record<VmPoamFormField, string>> = {};
  const patch = vmPoamFormPatch(base, form);
  const check = (key: 'owner' | 'mitigation' | 'scheduledCompletion', text: string) => {
    if (!(key in patch)) return;
    const res = parseVmPoamPatch({ expectedUpdatedAt: base.updatedAt, [key]: patch[key] });
    if (!res.ok) errors[key] = text;
  };
  check('owner', VM_POAM_ITEM_COPY.ownerError);
  check('mitigation', VM_POAM_ITEM_COPY.mitigationError);
  check('scheduledCompletion', VM_POAM_ITEM_COPY.dateError);
  if (Object.keys(patch).length > 0) {
    // The server runs the status rules on every real change, with the plan the item will hold afterwards
    const plan = planVmPoamStatus({ status: base.status, findingOpenInEpisode: findingOpen(base) }, form.status, (patch.mitigation ?? base.mitigation).trim());
    if (!plan.ok) {
      if (plan.code === 'finding_still_open') errors.status = vmPoamCompletedBlockedText(base) ?? COMPLETED_BLOCKED;
      else if (!errors.mitigation) errors.mitigation = MITIGATION_REQUIRED;
    }
  }
  return errors;
}

/** Null unless the scanner still reports the vulnerability in this item's episode and the item is not already completed. */
export function vmPoamCompletedBlockedText(base: VmPoamRow): string | null {
  if (!findingOpen(base) || base.status === 'COMPLETED') return null;
  return isWorkerItem(base) && base.autoComplete ? COMPLETED_BLOCKED_AUTO : COMPLETED_BLOCKED;
}

export function vmPoamStatusOptions(base: VmPoamRow): Array<{ status: VmPoamStatus; label: string; available: boolean; note: string }> {
  const blocked = vmPoamCompletedBlockedText(base) !== null;
  const auto = isWorkerItem(base) && base.autoComplete;
  const label = VM_POAM_STATUS_LABEL;
  return [
    { status: 'OPEN', label: label.OPEN, available: true, note: 'Remediation has not started.' },
    { status: 'IN_PROGRESS', label: label.IN_PROGRESS, available: true, note: `Remediation is under way.${auto ? ' Automatic completion still applies.' : ''}` },
    { status: 'COMPLETED', label: label.COMPLETED, available: !blocked, note: blocked ? 'Not available: the scanner still reports it.' : 'The vulnerability is fixed.' },
    { status: 'RISK_ACCEPTED', label: label.RISK_ACCEPTED, available: true, note: 'The vulnerability stays, with a documented mitigation. Needs a plan.' },
  ];
}

/** Said at the point of choice: reopening a scanner item switches off its automatic completion. */
export function vmPoamReopenWarning(base: VmPoamRow, form: VmPoamForm): string | null {
  const closed = base.status === 'COMPLETED' || base.status === 'RISK_ACCEPTED';
  const reopening = form.status === 'OPEN' || form.status === 'IN_PROGRESS';
  return closed && reopening && isWorkerItem(base) && base.autoComplete ? VM_POAM_ITEM_COPY.reopenWarning : null;
}

/** Normalised value of one field, for comparing what a person typed with what the server holds. */
function fieldValue(f: VmPoamForm, k: VmPoamFormField): string {
  return k === 'owner' || k === 'mitigation' ? f[k].trim() : f[k];
}

const FIELDS: VmPoamFormField[] = ['owner', 'scheduledCompletion', 'mitigation', 'status'];

/** Three-way merge after a stale write: fields the person did not touch take the new server value; conflicts = touched by both, to different values. */
export function rebaseVmPoamForm(oldBase: VmPoamRow, newBase: VmPoamRow, form: VmPoamForm): { form: VmPoamForm; conflicts: VmPoamFormField[] } {
  const was = vmPoamFormFrom(oldBase);
  const now = vmPoamFormFrom(newBase);
  const next: VmPoamForm = { ...now };
  const conflicts: VmPoamFormField[] = [];
  for (const k of FIELDS) {
    const touched = fieldValue(form, k) !== fieldValue(was, k);
    if (!touched) continue;
    (next as unknown as Record<string, string>)[k] = form[k];
    const serverChanged = fieldValue(now, k) !== fieldValue(was, k);
    if (serverChanged && fieldValue(now, k) !== fieldValue(form, k)) conflicts.push(k);
  }
  return { form: next, conflicts };
}

export type VmPoamSaveErrorKind = 'stale' | 'archived' | 'finding_open' | 'mitigation_required' | 'invalid' | 'forbidden' | 'not_found' | 'network' | 'session' | 'failed';

/** Fixed copy for a failed save: never the server's message, never a value. Same ApiError check as controlSave.ts. */
export function vmPoamSaveError(err: unknown): { kind: VmPoamSaveErrorKind; text: string | null; field?: VmPoamFormField } {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  if (!e || e.name !== 'ApiError') return { kind: 'failed', text: VM_POAM_ITEM_COPY.saveFailed };
  const status = e.status;
  const reason = e.reason;
  if (status === 401) return { kind: 'session', text: null };
  if (status === 409 && reason === 'stale_write') return { kind: 'stale', text: VM_POAM_ITEM_COPY.saveStale };
  if (reason === 'program_archived') return { kind: 'archived', text: VM_POAM_ITEM_COPY.saveArchived };
  if (reason === 'finding_still_open') return { kind: 'finding_open', text: COMPLETED_BLOCKED_AUTO, field: 'status' };
  if (reason === 'mitigation_required') return { kind: 'mitigation_required', text: MITIGATION_REQUIRED, field: 'mitigation' };
  if (status === 400) return { kind: 'invalid', text: VM_POAM_ITEM_COPY.saveInvalid };
  if (status === 403) return { kind: 'forbidden', text: VM_POAM_ITEM_COPY.saveForbidden };
  if (status === 404) return { kind: 'not_found', text: VM_POAM_ITEM_COPY.saveNotFound };
  if (status === 0) return { kind: 'network', text: VM_POAM_ITEM_COPY.saveNetwork };
  return { kind: 'failed', text: VM_POAM_ITEM_COPY.saveFailed };
}

/** A line under the status in the list: who closed or reopened the item, and when. Null for an ordinary item. */
export function vmPoamStatusMarker(row: VmPoamRow): string | null {
  const d = row.statusChangedAt ? row.statusChangedAt.slice(0, 10) : '';
  const on = d ? ` on ${d}` : '';
  if (row.status === 'COMPLETED') {
    if (row.statusChangedBy === VM_WORKER_ACTOR_NAME) return `Completed automatically by a scan${on}`;
    return row.statusChangedBy ? `Completed by ${row.statusChangedBy}${on}` : null;
  }
  if (row.status === 'RISK_ACCEPTED') return row.statusChangedBy ? `Risk accepted by ${row.statusChangedBy}${on}` : null;
  if (isOpenVmPoamStatus(row.status) && isWorkerItem(row) && row.autoComplete === false) {
    return `Automatic completion is off (reopened by ${row.statusChangedBy ?? 'a person'}${on})`;
  }
  return null;
}

/** What the scanner says about the item's finding. */
export function vmPoamFindingStateText(row: VmPoamRow): string {
  const f = row.finding;
  if (!f) return 'Finding removed with its asset';
  if (findingOpen(row)) return 'Still reported by the scanner';
  if (f.status === 'RESOLVED') return `Fixed: not reported since ${isoDate(f.resolvedAt)}`;
  if (f.status === 'OPEN') return 'Reported again later; a newer item covers it';
  return 'Decided on the finding';
}

export function vmPoamEventView(e: VmPoamItemEvent): { what: string; who: string; when: string } {
  const system = e.source === 'system';
  const parts: string[] = [];
  if (system && e.newStatus === 'COMPLETED') parts.push('Completed automatically: a scan confirmed the fix');
  else if (e.oldStatus !== e.newStatus) parts.push(`Status: ${VM_POAM_STATUS_LABEL[e.oldStatus ?? e.newStatus]} to ${VM_POAM_STATUS_LABEL[e.newStatus]}`);
  if (e.oldScheduledCompletion !== e.newScheduledCompletion) parts.push(`Target date: ${e.oldScheduledCompletion ?? 'None'} to ${e.newScheduledCompletion ?? 'None'}`);
  if (e.ownerChanged) parts.push('Owner changed');
  if (e.mitigationChanged) parts.push('Plan changed');
  return {
    what: parts.length > 0 ? `${parts.join('. ')}.` : 'Recorded without a visible change.',
    who: system ? 'Scanner integration' : e.actor,
    when: `${e.createdAt.slice(0, 10)} ${e.createdAt.slice(11, 16)} UTC`,
  };
}

export function vmPoamCreatedText(row: VmPoamRow): string {
  return `Created ${isoDate(row.createdAt)} by ${isWorkerItem(row) ? 'the scanner integration' : row.createdBy}.`;
}

/** The accessible name of an item's button. The CVE names it, not the weakness id: ids are positional and shift when an item closes. */
export function vmPoamItemLabel(row: VmPoamRow, weaknessId: string | null): string {
  return `POA&M item ${weaknessId ? `${weaknessId}, ` : ''}${row.finding?.vulnId ?? 'with a removed finding'}`;
}

/** The polite announcement after a save. */
export function vmPoamSavedText(before: VmPoamRow, after: VmPoamRow, changed: boolean, includeClosed: boolean): string {
  if (!changed) return 'Nothing to save: the item already had these values.';
  const name = after.finding?.vulnId;
  const label = VM_POAM_STATUS_LABEL[after.status];
  if (!includeClosed && !isOpenVmPoamStatus(after.status)) return `Saved. ${name ?? 'The item'} is now ${label}, so it has left the open list.`;
  if (before.status !== after.status) return `Saved. ${name ?? 'The item'} is now ${label}.`;
  return `Saved the changes to ${name ?? 'the item'}.`;
}

/** The owner and plan typed and not saved, for the session rescue. Labels carry the CVE or the id, never the text. */
export function vmPoamUnsavedText(base: VmPoamRow, form: VmPoamForm): UnsavedTextEntry[] {
  const name = base.finding?.vulnId ?? base.id;
  const out: UnsavedTextEntry[] = [];
  if (form.owner !== base.owner) out.push({ key: `vmpoam:${base.id}:owner`, label: `Vulnerability POA&M owner, ${name}`, text: form.owner });
  if (form.mitigation !== base.mitigation) out.push({ key: `vmpoam:${base.id}:mitigation`, label: `Vulnerability POA&M plan, ${name}`, text: form.mitigation });
  return out;
}
