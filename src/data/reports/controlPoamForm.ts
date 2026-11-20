import { CONTROL_POAM_OWNER_MAX, CONTROL_POAM_PLAN_MAX, CONTROL_POAM_RESOURCES_MAX } from '../../types/controlPoam';
import type { ControlPoamEvent, ControlPoamPatch, ControlPoamRecord } from '../../types/controlPoam';
import type { UnsavedTextEntry } from '../../services/unsavedText';
import { parseControlPoamPatch } from '../controlPoamEdit';
import { VM_POAM_DATE_MAX, VM_POAM_DATE_MIN } from '../poamDates';
import type { ControlPoamLoad } from './controlPoamView';
import {
  milestoneErrors, milestoneListInvalid, milestonesChanged, milestonesPatch, milestonesUnsavedText, milestoneDrafts, rebaseMilestones,
  type MilestoneDraft,
} from './poamMilestoneForm';

/**
 * #304: the edit form of a control's POA&M entry (owner, scheduled completion, required resources, plan, milestones) as pure functions: the form
 * values and the patch they make, the field errors, the rules said before anything is refused (warnings only), the merge after a stale write,
 * fixed texts for every failed save, the history and the notices about the recorded fields. The owner, resources, plan and milestones are user
 * text and may be CUI: nothing here stores, logs or sends them anywhere; every error and label names a field or a control id, never a value.
 */

export interface ControlPoamForm {
  owner: string;
  /** '' = no date. */
  scheduledCompletion: string;
  requiredResources: string;
  plan: string;
  milestones: MilestoneDraft[];
}
export type ControlPoamFormField = 'owner' | 'scheduledCompletion' | 'requiredResources' | 'plan' | 'milestones';

/** The warning window: a target date further out than this many days from today is flagged. */
export const POAM_FAR_DATE_DAYS = 180;

export const CONTROL_POAM_COPY = {
  ownerError: `Owner: at most ${CONTROL_POAM_OWNER_MAX} characters, with no control characters.`,
  dateError: `Scheduled completion date: a real date from ${VM_POAM_DATE_MIN} to ${VM_POAM_DATE_MAX}.`,
  resourcesError: `Required resources: at most ${CONTROL_POAM_RESOURCES_MAX} characters. Line breaks and tabs are allowed; other control characters are not.`,
  planError: `Plan: at most ${CONTROL_POAM_PLAN_MAX} characters. Line breaks and tabs are allowed; other control characters are not.`,
  ownerHint: 'Printed in the Responsible column instead of the control\'s responsible role. Leave it empty to print that role.',
  dateHint: 'Printed as the Scheduled Completion Date. Leave it empty if no date is planned.',
  resourcesHint: 'Printed as the Required Resources, for example people, budget or tools.',
  planHint: 'Printed as the Remediation Plan. Leave it empty to print the standard plan for this control.',
  weaknessIdHint: 'Weakness IDs follow list order and can change.',
  farWarning: `The target date is more than ${POAM_FAR_DATE_DAYS} days from today. Check it against your POA&M closeout deadline.`,
  pastWarning: 'The target date has passed and this entry is still open. Record a new date or update the plan.',
  farRowText: `Target date over ${POAM_FAR_DATE_DAYS} days away`,
  pastRowText: 'Past target date',
  metNote: 'This control is recorded as Met, so it has no POA&M entry in the exports. The fields you save here are kept and print again if the control stops being Met.',
  readOnlyNote: 'Only a Tenant Owner or Admin can edit POA&M entries.',
  saveStale: 'Someone else changed these fields while you were editing. Nothing was saved, and your entries are still in the form.',
  saveArchived: 'This program was archived while you were editing, so its POA&M entries are read-only. Nothing was saved. Copy any text you need.',
  saveForbidden: 'Your role cannot edit POA&M entries. Only a Tenant Owner or Admin can. Nothing was saved.',
  saveNotEnabled: 'This framework is not enabled for the organization, so its POA&M entries cannot be edited. Nothing was saved. Copy any text you need.',
  saveNoProgram: 'No program is selected, so the entry cannot be saved. Nothing was saved. Copy any text you need.',
  saveNotFound: 'This control is not part of the program. Nothing was saved. Copy any text you need.',
  saveInvalid: 'One of the values was not accepted. Check the fields and try again.',
  saveNetwork: 'The server could not be reached. Nothing was saved; your entries are still in the form. Try again.',
  saveFailed: 'The entry could not be saved. Your entries are still in the form. Try again.',
  loadCurrent: 'Load the current values',
  loadingCurrent: 'Loading the current values…',
  loadCurrentFailed: 'The current values could not be loaded. Try again.',
  loadedNoConflict: 'The current values are loaded. Your changes are kept; save again to apply them.',
  useCurrent: 'Use the current values instead',
  discardQuestion: 'Discard your changes to this entry? They have not been saved.',
  historyLoading: 'Loading the history…',
  historyError: 'The history could not be loaded.',
  historyEmpty: 'No changes recorded yet.',
  historyCap: 'Showing the latest 100 changes.',
  notRecorded: 'Not recorded',
  loading: 'Loading the recorded POA&M fields…',
  loadError: 'The recorded POA&M fields could not be loaded. The entries show the control\'s responsible role and print Not recorded for dates, resources and milestones.',
  browserOnly: 'Owners, dates, resources, plans and milestones for control entries need an organization stored on the server. This organization is stored only in this browser, so they print as Not recorded.',
  noProgram: 'No program is selected, so the recorded POA&M fields cannot be shown. They print as Not recorded.',
  exportLoading: 'The recorded POA&M fields for control entries are still loading. Exporting now prints Not recorded for every control entry\'s owner, date, resources and milestones.',
  exportError: 'The recorded POA&M fields for control entries could not be loaded. Exporting now prints Not recorded instead of them.',
  retry: 'Retry',
  nothingToSave: 'Nothing to save: the entry already had these values.',
};

const FIELD_NAME: Record<ControlPoamFormField, string> = {
  owner: 'owner', scheduledCompletion: 'scheduled completion date', requiredResources: 'required resources', plan: 'plan', milestones: 'milestones',
};
const FIELDS: ControlPoamFormField[] = ['owner', 'scheduledCompletion', 'requiredResources', 'plan', 'milestones'];

/** Field names for a note, in the order the form shows them. */
export function controlPoamFieldNames(fields: readonly ControlPoamFormField[]): string {
  return fields.map((f) => FIELD_NAME[f]).join(', ');
}

/** The form for a stored entry; null (the control has no entry yet) gives an empty form. */
export function controlPoamFormFrom(record: ControlPoamRecord | null): ControlPoamForm {
  return {
    owner: record?.owner ?? '',
    scheduledCompletion: record?.scheduledCompletion ?? '',
    requiredResources: record?.requiredResources ?? '',
    plan: record?.plan ?? '',
    milestones: milestoneDrafts(record?.milestones),
  };
}

/** Changed keys only; texts compared and sent trimmed; '' date -> null; the milestones as the whole list in order. */
export function controlPoamFormPatch(base: ControlPoamRecord | null, form: ControlPoamForm): ControlPoamPatch {
  const patch: ControlPoamPatch = {};
  if (form.owner.trim() !== (base?.owner ?? '').trim()) patch.owner = form.owner.trim();
  if ((form.scheduledCompletion || null) !== (base?.scheduledCompletion ?? null)) patch.scheduledCompletion = form.scheduledCompletion || null;
  if (form.requiredResources.trim() !== (base?.requiredResources ?? '').trim()) patch.requiredResources = form.requiredResources.trim();
  if (form.plan.trim() !== (base?.plan ?? '').trim()) patch.plan = form.plan.trim();
  if (milestonesChanged(base?.milestones, form.milestones)) patch.milestones = milestonesPatch(form.milestones);
  return patch;
}

export function controlPoamFormDirty(base: ControlPoamRecord | null, form: ControlPoamForm): boolean {
  return Object.keys(controlPoamFormPatch(base, form)).length > 0;
}

/** The stamp an edit sends back: the entry's updatedAt as loaded, null when the control had no entry yet. */
export const controlPoamExpectedStamp = (base: ControlPoamRecord | null): string | null => base?.updatedAt ?? null;

/** Why the form cannot be saved, per field. Each changed field runs alone through the server's parser. `milestones` is a short pointer; the rows carry the detail. */
export function controlPoamFormErrors(base: ControlPoamRecord | null, form: ControlPoamForm): Partial<Record<ControlPoamFormField, string>> {
  const errors: Partial<Record<ControlPoamFormField, string>> = {};
  const patch = controlPoamFormPatch(base, form);
  const check = (key: 'owner' | 'scheduledCompletion' | 'requiredResources' | 'plan', text: string) => {
    if (!(key in patch)) return;
    if (!parseControlPoamPatch({ expectedUpdatedAt: null, [key]: patch[key] }).ok) errors[key] = text;
  };
  check('owner', CONTROL_POAM_COPY.ownerError);
  check('scheduledCompletion', CONTROL_POAM_COPY.dateError);
  check('requiredResources', CONTROL_POAM_COPY.resourcesError);
  check('plan', CONTROL_POAM_COPY.planError);
  if ('milestones' in patch && milestoneListInvalid(form.milestones)) errors.milestones = 'Check the milestones marked below.';
  return errors;
}

/** The per-row milestone errors of a form (for the editor). */
export const controlPoamMilestoneErrors = (form: ControlPoamForm) => milestoneErrors(form.milestones);

/** Normalised value of one scalar field, for comparing what a person typed with what the server holds. */
function scalar(f: ControlPoamForm, k: Exclude<ControlPoamFormField, 'milestones'>): string {
  return k === 'scheduledCompletion' ? f[k] : f[k].trim();
}

/** Three-way merge after a stale write: fields the person did not touch take the new server value; conflicts = touched by both, to different values. */
export function rebaseControlPoamForm(
  oldBase: ControlPoamRecord | null,
  newBase: ControlPoamRecord | null,
  form: ControlPoamForm
): { form: ControlPoamForm; conflicts: ControlPoamFormField[] } {
  const was = controlPoamFormFrom(oldBase);
  const now = controlPoamFormFrom(newBase);
  const next: ControlPoamForm = { ...now };
  const conflicts: ControlPoamFormField[] = [];
  for (const k of FIELDS) {
    if (k === 'milestones') {
      const r = rebaseMilestones(oldBase?.milestones, newBase?.milestones, form.milestones);
      next.milestones = r.drafts;
      if (r.conflict) conflicts.push(k);
      continue;
    }
    if (scalar(form, k) === scalar(was, k)) continue;
    next[k] = form[k];
    if (scalar(now, k) !== scalar(was, k) && scalar(now, k) !== scalar(form, k)) conflicts.push(k);
  }
  return { form: next, conflicts };
}

export type ControlPoamSaveErrorKind = 'stale' | 'archived' | 'forbidden' | 'not_enabled' | 'no_program' | 'invalid' | 'not_found' | 'network' | 'session' | 'failed';

/** Fixed copy for a failed save: never the server's message, never a value. Same ApiError check as vmPoamSaveError. */
export function controlPoamSaveError(err: unknown): { kind: ControlPoamSaveErrorKind; text: string | null } {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  if (!e || e.name !== 'ApiError') return { kind: 'failed', text: CONTROL_POAM_COPY.saveFailed };
  const status = e.status;
  const reason = e.reason;
  if (status === 401) return { kind: 'session', text: null };
  if (status === 409 && reason === 'stale_write') return { kind: 'stale', text: CONTROL_POAM_COPY.saveStale };
  if (reason === 'program_archived') return { kind: 'archived', text: CONTROL_POAM_COPY.saveArchived };
  if (reason === 'program_required') return { kind: 'no_program', text: CONTROL_POAM_COPY.saveNoProgram };
  if (reason === 'framework_not_enabled') return { kind: 'not_enabled', text: CONTROL_POAM_COPY.saveNotEnabled };
  if (status === 400) return { kind: 'invalid', text: CONTROL_POAM_COPY.saveInvalid };
  if (status === 403) return { kind: 'forbidden', text: CONTROL_POAM_COPY.saveForbidden };
  if (status === 404) return { kind: 'not_found', text: CONTROL_POAM_COPY.saveNotFound };
  if (status === 0) return { kind: 'network', text: CONTROL_POAM_COPY.saveNetwork };
  return { kind: 'failed', text: CONTROL_POAM_COPY.saveFailed };
}

/** One history row. Flags, dates and counts only: the server never sends the text. */
export function controlPoamEventView(e: ControlPoamEvent): { what: string; who: string; when: string } {
  const parts: string[] = [];
  if (e.oldScheduledCompletion !== e.newScheduledCompletion) parts.push(`Target date: ${e.oldScheduledCompletion ?? 'None'} to ${e.newScheduledCompletion ?? 'None'}`);
  if (e.ownerChanged) parts.push('Owner changed');
  if (e.resourcesChanged) parts.push('Required resources changed');
  if (e.planChanged) parts.push('Plan changed');
  if (e.milestonesChanged) {
    parts.push(e.milestoneCount === 0 ? 'Milestones cleared' : `Milestones: ${e.milestoneCount ?? 0} recorded, ${e.milestonesCompleted ?? 0} completed`);
  }
  return {
    what: parts.length > 0 ? `${parts.join('. ')}.` : 'Recorded without a visible change.',
    who: e.actor,
    when: `${e.createdAt.slice(0, 10)} ${e.createdAt.slice(11, 16)} UTC`,
  };
}

/** The accessible name of an entry's button. The control id names it, not the weakness id: ids are positional and shift when a control changes status. */
export const controlPoamItemLabel = (displayId: string): string => `POA&M fields for control ${displayId}`;

/** The polite announcement after a save. */
export const controlPoamSavedText = (displayId: string, changed: boolean): string =>
  changed ? `Saved the POA&M fields for ${displayId}.` : CONTROL_POAM_COPY.nothingToSave;

/** The typed owner, resources, plan and milestones that are not saved, for the session rescue. Labels carry the control id only, never the text. */
export function controlPoamUnsavedText(base: ControlPoamRecord | null, form: ControlPoamForm, controlId: string): UnsavedTextEntry[] {
  const out: UnsavedTextEntry[] = [];
  if (form.owner !== (base?.owner ?? '')) out.push({ key: `controlpoam:${controlId}:owner`, label: `Control POA&M owner, ${controlId}`, text: form.owner });
  if (form.requiredResources !== (base?.requiredResources ?? '')) out.push({ key: `controlpoam:${controlId}:resources`, label: `Control POA&M required resources, ${controlId}`, text: form.requiredResources });
  if (form.plan !== (base?.plan ?? '')) out.push({ key: `controlpoam:${controlId}:plan`, label: `Control POA&M plan, ${controlId}`, text: form.plan });
  if (milestonesChanged(base?.milestones, form.milestones) && form.milestones.length > 0) {
    out.push(milestonesUnsavedText(`controlpoam:${controlId}:milestones`, `Control POA&M milestones, ${controlId}`, form.milestones));
  }
  return out;
}

/** Today as YYYY-MM-DD in the browser's local time (the day a person means by "today"). */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const dayNumber = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : NaN;
};

/**
 * Warnings about a target date, never refusals: `far` = more than POAM_FAR_DATE_DAYS days after `today`; `past` = the entry is open and the date
 * is before `today`. No date, an invalid date or an invalid `today` gives none.
 */
export function poamDateWarnings(input: { date: string | null | undefined; open: boolean; today: string }): Array<'far' | 'past'> {
  const d = input.date ? dayNumber(input.date) : NaN;
  const t = dayNumber(input.today);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return [];
  const out: Array<'far' | 'past'> = [];
  if (d - t > POAM_FAR_DATE_DAYS) out.push('far');
  if (input.open && d < t) out.push('past');
  return out;
}

/** The dialog's text for a warning. */
export const poamDateWarningText = (w: 'far' | 'past'): string => (w === 'far' ? CONTROL_POAM_COPY.farWarning : CONTROL_POAM_COPY.pastWarning);

/** What the section says above the table about the recorded fields; null once they are loaded. */
export type ControlPoamNotice = { kind: 'loading' | 'error' | 'unsupported' | 'no_program'; text: string };
export function controlPoamLoadNotice(load: ControlPoamLoad): ControlPoamNotice | null {
  switch (load.status) {
    case 'unsupported': return { kind: 'unsupported', text: CONTROL_POAM_COPY.browserOnly };
    case 'loading':
    case 'idle': return { kind: 'loading', text: CONTROL_POAM_COPY.loading };
    case 'error': return { kind: 'error', text: CONTROL_POAM_COPY.loadError };
    case 'no_program': return { kind: 'no_program', text: CONTROL_POAM_COPY.noProgram };
    default: return null;
  }
}

/**
 * The warning beside the export button: while the recorded fields load, or after they failed to load, an export prints Not recorded for them
 * without saying why. Null when they are loaded, when the organization is stored only in the browser (the section says so), with no program, and
 * while the hook is idle (not enabled).
 */
export function controlPoamExportNotice(load: ControlPoamLoad): { tone: 'amber'; text: string; retry: boolean } | null {
  if (load.status === 'loading') return { tone: 'amber', text: CONTROL_POAM_COPY.exportLoading, retry: false };
  if (load.status === 'error') return { tone: 'amber', text: CONTROL_POAM_COPY.exportError, retry: true };
  return null;
}
