import fs from 'fs';
import path from 'path';
import {
  CONTROL_POAM_COPY, POAM_FAR_DATE_DAYS, controlPoamEventView, controlPoamExpectedStamp, controlPoamExportNotice, controlPoamFormDirty,
  controlPoamFormErrors, controlPoamFormFrom, controlPoamFormPatch, controlPoamItemLabel, controlPoamLoadNotice, controlPoamSaveError,
  controlPoamSavedText, controlPoamUnsavedText, poamDateWarnings, rebaseControlPoamForm, todayIso, type ControlPoamForm,
} from '../src/data/reports/controlPoamForm';
import { newMilestoneDraft } from '../src/data/reports/poamMilestoneForm';
import type { ControlPoamEvent, ControlPoamRecord } from '../src/types/controlPoam';

/**
 * #304: the edit form of a control's POA&M entry as pure functions (patch, errors, date warnings, stale-write merge, fixed save-error texts,
 * history, notices, unsaved-text labels) and source pins on the dialog. Pure test: no server boots, no browser.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const read = (p: string): string => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

const record = (o: Partial<ControlPoamRecord> = {}): ControlPoamRecord => ({
  controlId: 'AC.L2-3.1.1', owner: '', scheduledCompletion: null, requiredResources: '', plan: '', milestones: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', updatedBy: 'u1', ...o,
});
const apiError = (status: number, reason?: string) => Object.assign(new Error('SECRET-SERVER-TEXT'), { name: 'ApiError', status, reason });
const formOf = (r: ControlPoamRecord | null, o: Partial<ControlPoamForm> = {}): ControlPoamForm => ({ ...controlPoamFormFrom(r), ...o });

console.log('--- C1 form and patch ---');
{
  assert(same(controlPoamFormFrom(null), { owner: '', scheduledCompletion: '', requiredResources: '', plan: '', milestones: [] }), 'C1 no entry gives an empty form');
  assert(same(controlPoamFormPatch(null, formOf(null)), {}) && !controlPoamFormDirty(null, formOf(null)), 'C1 an untouched form gives an empty patch');
  const r = record({ owner: 'IT Lead', scheduledCompletion: '2027-01-15', plan: 'Do it' });
  assert(same(controlPoamFormPatch(r, formOf(r)), {}), 'C1 an untouched stored entry gives an empty patch');
  assert(same(controlPoamFormPatch(null, formOf(null, { owner: '  IT Lead ' })), { owner: 'IT Lead' }), 'C1 the owner is sent trimmed');
  assert(same(controlPoamFormPatch(r, formOf(r, { scheduledCompletion: '' })), { scheduledCompletion: null }), 'C1 an emptied date sends null');
  assert(same(controlPoamFormPatch(null, formOf(null, { scheduledCompletion: '2027-02-01' })), { scheduledCompletion: '2027-02-01' }), 'C1 a date is sent as typed');
  assert(same(controlPoamFormPatch(null, formOf(null, { requiredResources: ' Two people ', plan: ' Step 1 ' })), { requiredResources: 'Two people', plan: 'Step 1' }), 'C1 resources and plan are sent trimmed');
  assert(controlPoamExpectedStamp(null) === null && controlPoamExpectedStamp(r) === r.updatedAt, 'C1 the stamp is null without an entry, else updatedAt');
  const withMs = formOf(null, { milestones: [{ ...newMilestoneDraft(1), description: 'Patch hosts', targetDate: '2027-03-01' }] });
  const patch = controlPoamFormPatch(null, withMs);
  assert(same(patch, { milestones: [{ description: 'Patch hosts', targetDate: '2027-03-01', completed: false }] }), 'C1 a new milestone is sent without id or key', patch);
}

console.log('--- C2 errors ---');
{
  assert(controlPoamFormErrors(null, formOf(null, { owner: 'x'.repeat(256) })).owner === CONTROL_POAM_COPY.ownerError, 'C2 an owner of 256 characters is an error');
  assert(controlPoamFormErrors(null, formOf(null, { owner: 'x'.repeat(255) })).owner === undefined, 'C2 an owner of 255 characters is fine');
  assert(controlPoamFormErrors(null, formOf(null, { scheduledCompletion: '2100-01-01' })).scheduledCompletion === CONTROL_POAM_COPY.dateError, 'C2 2100-01-01 is an error');
  assert(controlPoamFormErrors(null, formOf(null, { scheduledCompletion: '2027-02-30' })).scheduledCompletion === CONTROL_POAM_COPY.dateError, 'C2 2027-02-30 is an error');
  assert(controlPoamFormErrors(null, formOf(null, { requiredResources: 'x'.repeat(2001) })).requiredResources === CONTROL_POAM_COPY.resourcesError, 'C2 resources over 2000 are an error');
  assert(controlPoamFormErrors(null, formOf(null, { plan: 'a\u0007b' })).plan === CONTROL_POAM_COPY.planError, 'C2 a control character in the plan is an error');
  assert(controlPoamFormErrors(null, formOf(null, { plan: 'a\nb\tc' })).plan === undefined, 'C2 line breaks and tabs are allowed in the plan');
  const bad = formOf(null, { milestones: [{ ...newMilestoneDraft(1), description: 'ok', targetDate: '' }] });
  assert(controlPoamFormErrors(null, bad).milestones !== undefined, 'C2 a milestone without a date is an error on the list');
  assert(Object.values(controlPoamFormErrors(null, formOf(null, { owner: 'IT' }))).length === 0, 'C2 a valid edit has no errors');
  const all = JSON.stringify([CONTROL_POAM_COPY.ownerError, CONTROL_POAM_COPY.planError, controlPoamFormErrors(null, formOf(null, { owner: `SECRET-${'x'.repeat(300)}` }))]);
  assert(!all.includes('SECRET-'), 'C2 an error never echoes the typed value');
}

console.log('--- C3 date warnings (never refusals) ---');
{
  const today = '2026-11-19';
  const plus = (days: number): string => new Date(Date.UTC(2026, 10, 19 + days)).toISOString().slice(0, 10);
  assert(same(poamDateWarnings({ date: plus(POAM_FAR_DATE_DAYS + 1), open: true, today }), ['far']), 'C3 +181 days gives far');
  assert(same(poamDateWarnings({ date: plus(POAM_FAR_DATE_DAYS), open: true, today }), []), 'C3 +180 days gives none');
  assert(same(poamDateWarnings({ date: plus(-1), open: true, today }), ['past']), 'C3 yesterday on an open entry gives past');
  assert(same(poamDateWarnings({ date: plus(-1), open: false, today }), []), 'C3 yesterday on a closed entry gives none');
  assert(same(poamDateWarnings({ date: today, open: true, today }), []), 'C3 today gives none');
  assert(same(poamDateWarnings({ date: null, open: true, today }), []) && same(poamDateWarnings({ date: 'Not recorded', open: true, today }), []), 'C3 no date or a non-date gives none');
  assert(todayIso(new Date(2026, 0, 5)) === '2026-01-05', 'C3 today is formatted YYYY-MM-DD');
  // a warning never makes the form invalid
  assert(controlPoamFormErrors(null, formOf(null, { scheduledCompletion: '2099-12-31' })).scheduledCompletion === undefined, 'C3 a far date is still saveable');
}

console.log('--- C4 rebase after a stale write ---');
{
  const oldBase = record({ owner: 'Ann', plan: 'P1' });
  const newBase = record({ owner: 'Ann', plan: 'P2', scheduledCompletion: '2027-01-01', updatedAt: '2026-01-03T00:00:00Z' });
  const a = rebaseControlPoamForm(oldBase, newBase, formOf(oldBase, { owner: 'Bob' }));
  assert(a.form.owner === 'Bob' && a.form.plan === 'P2' && a.form.scheduledCompletion === '2027-01-01' && a.conflicts.length === 0, 'C4 untouched fields take the server values, touched ones stay');
  const b = rebaseControlPoamForm(oldBase, newBase, formOf(oldBase, { plan: 'Mine' }));
  assert(same(b.conflicts, ['plan']) && b.form.plan === 'Mine', 'C4 a conflict only where both sides changed to different values');
  const c = rebaseControlPoamForm(oldBase, newBase, formOf(oldBase, { plan: 'P2' }));
  assert(c.conflicts.length === 0, 'C4 both sides making the same change is no conflict');
  const withMs = record({ milestones: [{ id: 'ms-1', description: 'One', targetDate: '2027-01-01', completed: false }] });
  const gone = record({ updatedAt: '2026-01-04T00:00:00Z' });
  const d = rebaseControlPoamForm(withMs, gone, formOf(withMs, { milestones: [{ key: 'ms-1', id: 'ms-1', description: 'One edited', targetDate: '2027-01-01', completed: false }] }));
  assert(d.form.milestones.length === 1 && d.form.milestones[0].id === undefined && d.conflicts.includes('milestones'), 'C4 a milestone the server removed becomes a new row, and the list conflicts');
  const e = rebaseControlPoamForm(null, withMs, formOf(null));
  assert(e.form.milestones.length === 1 && e.form.milestones[0].id === 'ms-1', 'C4 an untouched list takes the server list (first entry created meanwhile)');
}

console.log('--- C5 fixed save-error texts ---');
{
  assert(controlPoamSaveError(apiError(409, 'stale_write')).kind === 'stale', 'C5 409 stale_write is stale');
  assert(controlPoamSaveError(apiError(403)).kind === 'forbidden', 'C5 403 is forbidden');
  assert(controlPoamSaveError(apiError(403, 'framework_not_enabled')).kind === 'not_enabled', 'C5 403 framework_not_enabled is its own kind');
  assert(controlPoamSaveError(apiError(409, 'program_archived')).kind === 'archived', 'C5 program_archived is archived');
  assert(controlPoamSaveError(apiError(409, 'program_required')).kind === 'no_program', 'C5 program_required is no_program');
  assert(controlPoamSaveError(apiError(400, 'invalid_control_poam_patch')).kind === 'invalid', 'C5 400 is invalid');
  assert(controlPoamSaveError(apiError(404)).kind === 'not_found', 'C5 404 is not_found');
  assert(controlPoamSaveError(apiError(0)).kind === 'network', 'C5 status 0 is network');
  assert(controlPoamSaveError(apiError(401)).kind === 'session' && controlPoamSaveError(apiError(401)).text === null, 'C5 401 is left to the session rescue');
  assert(controlPoamSaveError(new Error('boom')).kind === 'failed', 'C5 a plain error is failed');
  const texts = [409, 403, 400, 404, 0, 500].map((s) => controlPoamSaveError(apiError(s, s === 409 ? 'stale_write' : undefined)).text ?? '').join('|');
  assert(!texts.includes('SECRET-SERVER-TEXT'), 'C5 the server message is never shown');
}

console.log('--- C6 history, labels, notices ---');
{
  const ev: ControlPoamEvent = {
    id: 'e1', controlId: 'AC.L2-3.1.1', actor: 'Ann', controlStatus: 'NOT_MET', oldScheduledCompletion: null, newScheduledCompletion: '2027-01-31',
    ownerChanged: true, resourcesChanged: true, planChanged: true, milestonesChanged: true, milestoneCount: 3, milestonesCompleted: 1, createdAt: '2026-11-19T10:30:00Z',
  };
  const v = controlPoamEventView(ev);
  assert(v.what === 'Target date: None to 2027-01-31. Owner changed. Required resources changed. Plan changed. Milestones: 3 recorded, 1 completed.', 'C6 the event reads as flags and counts', v.what);
  assert(v.who === 'Ann' && v.when === '2026-11-19 10:30 UTC', 'C6 who and when');
  assert(controlPoamEventView({ ...ev, oldScheduledCompletion: null, newScheduledCompletion: null, ownerChanged: false, resourcesChanged: false, planChanged: false, milestonesChanged: false }).what === 'Recorded without a visible change.', 'C6 an event with no visible change says so');
  assert(controlPoamEventView({ ...ev, milestoneCount: 0, milestonesCompleted: 0 }).what.includes('Milestones cleared'), 'C6 a cleared list says so');
  assert(controlPoamItemLabel('3.1.1') === 'POA&M fields for control 3.1.1', 'C6 the button label names the control, not the weakness id');
  assert(controlPoamSavedText('3.1.1', true) === 'Saved the POA&M fields for 3.1.1.' && controlPoamSavedText('3.1.1', false) === CONTROL_POAM_COPY.nothingToSave, 'C6 the saved announcement');
  const ready = { status: 'ready' as const, entries: [] };
  assert(controlPoamExportNotice(ready) === null && controlPoamLoadNotice(ready) === null, 'C6 no notice when the fields are loaded');
  assert(controlPoamExportNotice({ status: 'loading' })?.text === CONTROL_POAM_COPY.exportLoading, 'C6 loading: the export notice says exports print Not recorded');
  const err = controlPoamExportNotice({ status: 'error' });
  assert(err?.text === CONTROL_POAM_COPY.exportError && err.retry === true, 'C6 error: the export notice offers Retry');
  assert(controlPoamExportNotice({ status: 'unsupported' }) === null && controlPoamExportNotice({ status: 'idle' }) === null && controlPoamExportNotice({ status: 'no_program' }) === null, 'C6 browser-only, idle and no program: no export notice');
  assert(controlPoamLoadNotice({ status: 'unsupported' })?.text === CONTROL_POAM_COPY.browserOnly, 'C6 the section says browser-only organizations print Not recorded');
  assert(controlPoamLoadNotice({ status: 'loading' })?.kind === 'loading' && controlPoamLoadNotice({ status: 'error' })?.kind === 'error', 'C6 the section has loading and error notices');
  const r = record({ owner: 'old', plan: 'old' });
  const un = controlPoamUnsavedText(r, formOf(r, { owner: 'SECRET-owner', plan: 'SECRET-plan', requiredResources: 'SECRET-res', milestones: [{ ...newMilestoneDraft(1), description: 'SECRET-ms', targetDate: '2027-01-01' }] }), 'AC.L2-3.1.1');
  assert(un.length === 4 && un.every((u) => u.label.includes('AC.L2-3.1.1') && !u.label.includes('SECRET') && !u.key.includes('SECRET')), 'C6 unsaved labels carry the control id, never the typed text');
  assert(un.every((u) => u.text.includes('SECRET')), 'C6 the typed text is kept for the rescue');
  assert(controlPoamUnsavedText(r, formOf(r), 'AC.L2-3.1.1').length === 0, 'C6 nothing typed gives no unsaved text');
}

console.log('--- C7 source pins ---');
{
  const dialog = read('src/components/reports/ControlPoamDialog.tsx');
  assert(dialog.includes('z-[60]') && dialog.includes('max-h-[90vh]') && dialog.includes('onClose={saving ? undefined : requestClose}'), 'C7 the dialog sits above the export modal, scrolls, and cannot be dismissed while saving');
  assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|alert\(/.test(dialog), 'C7 the dialog has no console, browser storage, raw HTML or alert');
  assert(dialog.includes('ownerRef.current?.focus({ preventScroll: true })') && dialog.includes('aria-expanded={historyOpen}') && dialog.includes('useUnsavedTextProvider'), 'C7 focus, history and the session rescue');
  assert(dialog.includes("e.key === 'Escape'") && dialog.includes('Keep editing') && dialog.includes('role="group"'), 'C7 the inline discard confirmation handles its own Escape');
  assert(dialog.includes('api.refreshRecord(controlId)') && dialog.includes('rebaseControlPoamForm'), 'C7 a stale write loads the current values and merges');
  for (const f of ['src/data/reports/controlPoamForm.ts', 'src/data/reports/poamMilestoneForm.ts', 'src/components/reports/PoamMilestonesEditor.tsx']) {
    const src = read(f);
    assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|alert\(|ApiClient/.test(src), `C7 ${f} has no console, browser storage, raw HTML, alert or ApiClient`);
  }
  const hook = read('src/hooks/useControlPoam.ts');
  assert(hook.includes('refreshRecord') && !/console\.|localStorage|sessionStorage/.test(hook), 'C7 the hook offers the stale-write re-read and stores nothing');
  const modal = read('src/components/reports/ArtifactExportModal.tsx');
  assert(modal.includes('controlPoamExportNotice(controlPoam.load)') && modal.includes('controlPoam={controlPoam}') && modal.includes('data-testid="control-poam-notice"'), 'C7 the export modal wires the hook to the workspace and shows the loading / error notice');
  const ws = read('src/components/reports/PoamWorkspace.tsx');
  assert(ws.includes('controlPoamExportNotice(controlPoam.load)') && ws.includes('controlPoam={controlPoam}') && ws.includes('canEdit={canEdit}'), 'C7 the workspace shows the notice beside the CSV button and passes the hook and role on');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
