import fs from 'fs';
import path from 'path';
import {
  VM_POAM_ITEM_COPY, VM_POAM_STATUS_LABEL, VM_WORKER_ACTOR_NAME, rebaseVmPoamForm, vmPoamCompletedBlockedText, vmPoamCreatedText,
  vmPoamEventView, vmPoamFieldNames, vmPoamFindingStateText, vmPoamFormDirty, vmPoamFormErrors, vmPoamFormFrom, vmPoamFormPatch,
  vmPoamItemLabel, vmPoamReopenWarning, vmPoamSaveError, vmPoamSavedText, vmPoamStatusMarker, vmPoamStatusOptions, vmPoamUnsavedText,
  type VmPoamForm,
} from '../src/data/reports/vmPoamItemForm';
import { vmPoamFindingOpenInEpisode } from '../src/data/vmPoamEdit';
import type { VmFindingStatus, VmPoamItemEvent, VmPoamRow, VmPoamStatus } from '../src/types/vm';

/**
 * #297: the edit form of a vulnerability POA&M item as pure functions (patch, errors, status rules, stale-write merge, fixed save-error
 * texts, markers, history), and source pins on the dialog. Pure test: no server boots, no browser.
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

interface RowOptions {
  status?: VmPoamStatus; owner?: string; mitigation?: string; sched?: string | null; createdBy?: string; autoComplete?: boolean;
  statusChangedBy?: string | null; statusChangedAt?: string | null; finding?: 'open' | 'resolved' | 'later' | 'null' | 'false_positive';
  createdAt?: string; episode?: string | null;
}
function row(o: RowOptions = {}): VmPoamRow {
  const kind = o.finding ?? 'open';
  const status: VmFindingStatus = kind === 'resolved' ? 'RESOLVED' : kind === 'false_positive' ? 'FALSE_POSITIVE' : 'OPEN';
  return {
    id: 'item-1', status: o.status ?? 'OPEN', controlId: 'RA.L2-3.11.3', weakness: 'Weakness', scheduledCompletion: o.sched === undefined ? null : o.sched,
    createdAt: o.createdAt ?? '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    findingFirstSeenAt: o.episode === undefined ? '2026-01-01T00:00:00Z' : o.episode,
    createdBy: o.createdBy ?? VM_WORKER_ACTOR_NAME, owner: o.owner ?? '', mitigation: o.mitigation ?? '', updatedBy: null,
    statusChangedBy: o.statusChangedBy ?? null, statusChangedAt: o.statusChangedAt ?? null, autoComplete: o.autoComplete ?? true,
    finding: kind === 'null' ? null : {
      id: 'f-1', vulnId: 'CVE-2024-0001', severity: 'HIGH', status, kev: false,
      firstSeenAt: kind === 'later' ? '2026-03-01T00:00:00Z' : '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-05T00:00:00Z', slaDueAt: '2026-02-01T00:00:00Z',
      resolvedAt: kind === 'resolved' ? '2026-01-20T10:00:00Z' : null, affectedPackages: [], affectedPackageCount: 0, asset: { id: 'a', name: 'host-a' },
    },
  };
}
const apiError = (status: number, reason?: string) => Object.assign(new Error('SECRET-SERVER-TEXT'), { name: 'ApiError', status, reason });
const formOf = (r: VmPoamRow, o: Partial<VmPoamForm> = {}): VmPoamForm => ({ ...vmPoamFormFrom(r), ...o });
const outputs: string[] = [];

console.log('--- F1-F3 form, patch, dirty ---');
{
  const r = row({ sched: '2026-12-15', owner: 'x' });
  assert(vmPoamFormFrom(row()).scheduledCompletion === '' && vmPoamFormFrom(r).scheduledCompletion === '2026-12-15', 'F1 a null date becomes an empty field');
  assert(same(vmPoamFormPatch(r, formOf(r)), {}), 'F2 unchanged: empty patch');
  assert(same(vmPoamFormPatch(row(), formOf(row(), { owner: '  IT Lead ' })), { owner: 'IT Lead' }), 'F2 owner is sent trimmed');
  assert(same(vmPoamFormPatch(r, formOf(r, { owner: ' x ' })), {}), 'F2 owner equal after trimming: not sent');
  assert(same(vmPoamFormPatch(r, formOf(r, { scheduledCompletion: '' })), { scheduledCompletion: null }), 'F2 an emptied date clears it');
  assert(same(vmPoamFormPatch(r, formOf(r, { mitigation: 'Patch', status: 'IN_PROGRESS' })), { mitigation: 'Patch', status: 'IN_PROGRESS' }), 'F2 plan and status appear when they change');
  assert(same(vmPoamFormPatch(r, formOf(r, { mitigation: ' Patch ' })).mitigation, ' Patch '), 'F2 the plan is sent as typed (the server trims it)');
  assert(!vmPoamFormDirty(r, formOf(r)) && !vmPoamFormDirty(r, formOf(r, { owner: ' x ' })) && vmPoamFormDirty(r, formOf(r, { owner: 'y' })), 'F3 dirty follows the patch');
}

console.log('--- F4 errors ---');
{
  const r = row();
  assert('owner' in vmPoamFormErrors(r, formOf(r, { owner: 'o'.repeat(256) })), 'F4 a 256 character owner');
  assert(!('owner' in vmPoamFormErrors(r, formOf(r, { owner: 'o'.repeat(255) }))), 'F4 a 255 character owner is fine');
  assert('mitigation' in vmPoamFormErrors(r, formOf(r, { mitigation: 'm'.repeat(4001) })), 'F4 a 4001 character plan');
  assert('scheduledCompletion' in vmPoamFormErrors(r, formOf(r, { scheduledCompletion: '2100-01-01' })), 'F4 a date after 2099');
  assert(!('scheduledCompletion' in vmPoamFormErrors(r, formOf(r, { scheduledCompletion: '2026-12-15' }))), 'F4 a real date is fine');
  assert('mitigation' in vmPoamFormErrors(r, formOf(r, { status: 'RISK_ACCEPTED', mitigation: '  ' })), 'F4 risk accepted with a blank plan');
  assert(same(vmPoamFormErrors(r, formOf(r, { status: 'RISK_ACCEPTED', mitigation: 'Segmented.' })), {}), 'F4 risk accepted with a plan');
  const ra = row({ status: 'RISK_ACCEPTED', mitigation: 'Segmented.' });
  assert('mitigation' in vmPoamFormErrors(ra, formOf(ra, { mitigation: '' })), 'F4 risk accepted item with its plan emptied');
  assert('status' in vmPoamFormErrors(r, formOf(r, { status: 'COMPLETED' })), 'F4 completed while the finding is open in its episode');
  assert(same(vmPoamFormErrors(row({ finding: 'resolved' }), formOf(row(), { status: 'COMPLETED' })), {}), 'F4 completed with the finding resolved');
  assert(same(vmPoamFormErrors(row({ finding: 'null' }), formOf(row(), { status: 'COMPLETED' })), {}), 'F4 completed with the finding removed');
  assert(same(vmPoamFormErrors(r, formOf(r)), {}), 'F4 an untouched form has no errors');
  const joined = JSON.stringify(vmPoamFormErrors(r, formOf(r, { owner: 'SECRET-OWNER'.repeat(40) })));
  assert(!joined.includes('SECRET-OWNER'), 'F4 an error names the field, never the value');
}

console.log('--- F5 finding open in the item episode ---');
{
  const f = (o: RowOptions) => { const r = row(o); return vmPoamFindingOpenInEpisode(r, r.finding); };
  assert(f({}), 'F5 same episode and OPEN');
  assert(!f({ finding: 'later' }), 'F5 the finding came back later (a newer episode)');
  assert(f({ episode: null, createdAt: '2026-01-01T00:00:00Z' }), 'F5 legacy item without an episode, created at the first seen time');
  assert(!f({ finding: 'resolved' }) && !f({ finding: 'null' }), 'F5 resolved or removed finding');
  assert(vmPoamFindingStateText(row()) === 'Still reported by the scanner' && vmPoamFindingStateText(row({ finding: 'null' })) === 'Finding removed with its asset', 'F5 finding state texts');
  assert(vmPoamFindingStateText(row({ finding: 'resolved' })) === 'Fixed: not reported since 2026-01-20', 'F5 resolved text');
  assert(vmPoamFindingStateText(row({ finding: 'later' })) === 'Reported again later; a newer item covers it' && vmPoamFindingStateText(row({ finding: 'false_positive' })) === 'Decided on the finding', 'F5 later episode and decided texts');
}

console.log('--- F6 status options ---');
{
  const o = vmPoamStatusOptions(row());
  const completed = o.find((x) => x.status === 'COMPLETED')!;
  const text = vmPoamCompletedBlockedText(row()) ?? '';
  assert(!completed.available && text.includes('still reports') && text.includes('Risk accepted') && text.includes('completed automatically'), 'F6 finding open: Completed unavailable, with the reason and the alternative', text);
  assert(o.filter((x) => x.status !== 'COMPLETED').every((x) => x.available), 'F6 the other statuses are available');
  const manual = vmPoamCompletedBlockedText(row({ autoComplete: false })) ?? '';
  assert(manual.length > 0 && !manual.includes('completed automatically'), 'F6 a reopened item does not promise automatic completion', manual);
  assert(vmPoamCompletedBlockedText(row({ finding: 'resolved' })) === null && vmPoamCompletedBlockedText(row({ status: 'COMPLETED' })) === null, 'F6 no block when the finding is not open or the item is completed');
  assert(vmPoamStatusOptions(row()).find((x) => x.status === 'IN_PROGRESS')!.note.includes('Automatic completion still applies'), 'F6 in progress notes the automatic completion');
  assert(!vmPoamStatusOptions(row({ autoComplete: false })).find((x) => x.status === 'IN_PROGRESS')!.note.includes('Automatic'), 'F6 ... only while it applies');
  assert(completed.note === 'Not available: the scanner still reports it.' && vmPoamStatusOptions(row({ finding: 'resolved' })).find((x) => x.status === 'COMPLETED')!.note === 'The vulnerability is fixed.', 'F6 completed notes');
}

console.log('--- F7 reopen warning ---');
{
  const done = row({ status: 'COMPLETED' });
  assert((vmPoamReopenWarning(done, formOf(done, { status: 'OPEN' })) ?? '').includes('turns off automatic completion'), 'F7 worker item completed to open');
  assert(vmPoamReopenWarning(row({ status: 'RISK_ACCEPTED' }), formOf(row({ status: 'RISK_ACCEPTED' }), { status: 'IN_PROGRESS' })) !== null, 'F7 risk accepted to in progress');
  const mine = row({ status: 'COMPLETED', createdBy: 'Dana' });
  assert(vmPoamReopenWarning(mine, formOf(mine, { status: 'OPEN' })) === null, 'F7 a person-created item: no warning');
  assert(vmPoamReopenWarning(row(), formOf(row(), { status: 'IN_PROGRESS' })) === null, 'F7 open to in progress: no warning');
  const off = row({ status: 'COMPLETED', autoComplete: false });
  assert(vmPoamReopenWarning(off, formOf(off, { status: 'OPEN' })) === null, 'F7 automatic completion already off: no warning');
}

console.log('--- F8 rebase after a stale write ---');
{
  const oldBase = row({ owner: 'Ann' });
  const newBase = { ...row({ owner: 'Ann', status: 'IN_PROGRESS' }), updatedAt: '2026-01-03T00:00:00Z' };
  const a = rebaseVmPoamForm(oldBase, newBase, formOf(oldBase, { owner: 'Bob' }));
  assert(a.form.status === 'IN_PROGRESS' && a.form.owner === 'Bob' && a.conflicts.length === 0, 'F8 untouched status adopts the server value, the owner is kept', a);
  const serverOwner = { ...row({ owner: 'Cy' }), updatedAt: '2026-01-03T00:00:00Z' };
  const b = rebaseVmPoamForm(oldBase, serverOwner, formOf(oldBase, { owner: 'Bob' }));
  assert(same(b.conflicts, ['owner']) && b.form.owner === 'Bob', 'F8 both changed the owner to different values: a conflict, the typed value kept', b);
  const c = rebaseVmPoamForm(oldBase, serverOwner, formOf(oldBase, { owner: 'Cy' }));
  assert(c.conflicts.length === 0, 'F8 both changed it to the same value: no conflict');
  const d = rebaseVmPoamForm(oldBase, newBase, formOf(oldBase, { status: 'OPEN', owner: 'Ann' }));
  assert(d.conflicts.length === 0 && d.form.status === 'IN_PROGRESS', 'F8 a form equal to the old base takes everything from the server');
  assert(vmPoamFieldNames(['owner', 'scheduledCompletion', 'mitigation', 'status']) === 'owner, target date, plan, status', 'F8 field names');
}

console.log('--- F9 save errors ---');
{
  const k = (e: unknown) => vmPoamSaveError(e);
  assert(k(apiError(401)).kind === 'session' && k(apiError(401)).text === null, 'F9 401: nothing shown');
  assert(k(apiError(409, 'stale_write')).kind === 'stale' && k(apiError(409, 'stale_write')).text === VM_POAM_ITEM_COPY.saveStale, 'F9 stale write');
  assert(k(apiError(409, 'program_archived')).kind === 'archived', 'F9 archived');
  const open = k(apiError(409, 'finding_still_open'));
  assert(open.kind === 'finding_open' && open.field === 'status' && open.text === VM_POAM_ITEM_COPY.completedBlockedAuto, 'F9 finding still open');
  const mit = k(apiError(400, 'mitigation_required'));
  assert(mit.kind === 'mitigation_required' && mit.field === 'mitigation' && mit.text === VM_POAM_ITEM_COPY.mitigationRequired, 'F9 mitigation required');
  assert(k(apiError(400, 'invalid_poam_patch')).kind === 'invalid' && k(apiError(400)).kind === 'invalid', 'F9 invalid');
  assert(k(apiError(403)).kind === 'forbidden' && k(apiError(404)).kind === 'not_found' && k(apiError(0)).kind === 'network', 'F9 forbidden, not found, network');
  assert(k(apiError(500)).kind === 'failed' && k(apiError(409)).kind === 'failed', 'F9 anything else');
  const plain = k(new Error('OWNER-MARK'));
  assert(plain.kind === 'failed' && !(plain.text ?? '').includes('OWNER-MARK'), 'F9 a plain error is a failure with fixed text', plain);
  for (const status of [400, 403, 404, 409, 500, 0]) assert(!(k(apiError(status, 'x')).text ?? '').includes('SECRET-SERVER-TEXT'), `F9 the server message never appears (${status})`);
  for (const t of [k(apiError(409, 'stale_write')), k(apiError(0)), k(apiError(404))]) outputs.push(t.text ?? '');
}

console.log('--- F10 markers ---');
{
  const at = '2026-11-10T09:00:00Z';
  assert(vmPoamStatusMarker(row({ status: 'COMPLETED', statusChangedBy: VM_WORKER_ACTOR_NAME, statusChangedAt: at })) === 'Completed automatically by a scan on 2026-11-10', 'F10 completed by a scan');
  assert(vmPoamStatusMarker(row({ status: 'COMPLETED', statusChangedBy: 'Dana', statusChangedAt: at })) === 'Completed by Dana on 2026-11-10', 'F10 completed by a person');
  assert(vmPoamStatusMarker(row({ status: 'RISK_ACCEPTED', statusChangedBy: 'Dana', statusChangedAt: at })) === 'Risk accepted by Dana on 2026-11-10', 'F10 risk accepted');
  assert(vmPoamStatusMarker(row({ autoComplete: false, statusChangedBy: 'Dana', statusChangedAt: at })) === 'Automatic completion is off (reopened by Dana on 2026-11-10)', 'F10 reopened');
  assert(vmPoamStatusMarker(row()) === null && vmPoamStatusMarker(row({ status: 'IN_PROGRESS' })) === null, 'F10 an ordinary open item has none');
  assert(vmPoamStatusMarker(row({ status: 'COMPLETED', statusChangedBy: 'Dana' })) === 'Completed by Dana' && !(vmPoamStatusMarker(row({ autoComplete: false })) ?? '').includes(' on '), 'F10 no date, no " on "');
  assert(vmPoamStatusMarker(row({ autoComplete: false })) === 'Automatic completion is off (reopened by a person)', 'F10 reopened by an unknown person');
  outputs.push(vmPoamStatusMarker(row({ autoComplete: false })) ?? '');
}

console.log('--- F11 history ---');
{
  const ev = (o: Partial<VmPoamItemEvent>): VmPoamItemEvent => ({
    id: 'e1', itemId: 'item-1', source: 'human', actor: 'Dana', oldStatus: 'OPEN', newStatus: 'OPEN', oldScheduledCompletion: null, newScheduledCompletion: null,
    ownerChanged: false, mitigationChanged: false, runId: null, createdAt: '2026-11-10T14:05:33Z', ...o,
  });
  const sys = vmPoamEventView(ev({ source: 'system', actor: VM_WORKER_ACTOR_NAME, newStatus: 'COMPLETED' }));
  assert(sys.what === 'Completed automatically: a scan confirmed the fix.' && sys.who === 'Scanner integration', 'F11 a system completion', sys);
  const human = vmPoamEventView(ev({ newStatus: 'IN_PROGRESS', newScheduledCompletion: '2026-12-15', ownerChanged: true, mitigationChanged: true }));
  assert(human.what === 'Status: Open to In progress. Target date: None to 2026-12-15. Owner changed. Plan changed.' && human.who === 'Dana', 'F11 a person edit', human);
  assert(human.when === '2026-11-10 14:05 UTC', 'F11 when');
  assert(vmPoamEventView(ev({ ownerChanged: true })).what === 'Owner changed.', 'F11 a single change');
  assert(vmPoamCreatedText(row()) === 'Created 2026-01-02 by the scanner integration.' && vmPoamCreatedText(row({ createdBy: 'Dana' })) === 'Created 2026-01-02 by Dana.', 'F11 created text');
  outputs.push(sys.what, human.what);
}

console.log('--- F12-F13 unsaved text, labels, saved text ---');
{
  const r = row({ owner: 'Ann' });
  const u = vmPoamUnsavedText(r, formOf(r, { mitigation: 'SECRET-PLAN-TEXT' }));
  assert(u.length === 1 && u[0].key === 'vmpoam:item-1:mitigation' && u[0].text === 'SECRET-PLAN-TEXT' && !u[0].label.includes('SECRET-PLAN-TEXT'), 'F12 a changed plan: one entry, the label has no text', u);
  assert(vmPoamUnsavedText(r, formOf(r)).length === 0, 'F12 equal values: nothing');
  const both = vmPoamUnsavedText(r, formOf(r, { owner: 'Bob', mitigation: 'p' }));
  assert(both.length === 2 && both[0].label === 'Vulnerability POA&M owner, CVE-2024-0001' && both[1].label === 'Vulnerability POA&M plan, CVE-2024-0001', 'F12 labels carry the CVE');
  assert(vmPoamItemLabel(r, 'POAM-VM-001') === 'POA&M item POAM-VM-001, CVE-2024-0001' && vmPoamItemLabel(row({ finding: 'null' }), null) === 'POA&M item with a removed finding', 'F12 item labels');
  const closed = row({ status: 'COMPLETED' });
  assert(vmPoamSavedText(row(), closed, true, false).includes('left the open list'), 'F13 completed while closed items are hidden');
  assert(!vmPoamSavedText(row(), closed, true, true).includes('left the open list') && vmPoamSavedText(row(), closed, true, true) === 'Saved. CVE-2024-0001 is now Completed.', 'F13 completed while closed items are shown');
  assert(vmPoamSavedText(row(), row({ owner: 'x' }), true, false) === 'Saved the changes to CVE-2024-0001.', 'F13 other changes');
  assert(vmPoamSavedText(row(), row(), false, false) === 'Nothing to save: the item already had these values.', 'F13 nothing changed');
  outputs.push(vmPoamSavedText(row(), closed, true, false), vmPoamSavedText(row(), row(), false, false));
}

console.log('--- F14 no em dashes ---');
{
  const copy = Object.values(VM_POAM_ITEM_COPY).join('\n');
  const everything = [...outputs, copy, ...Object.values(VM_POAM_STATUS_LABEL), vmPoamCompletedBlockedText(row()) ?? '', vmPoamReopenWarning(row({ status: 'COMPLETED' }), formOf(row(), { status: 'OPEN' })) ?? '',
    ...vmPoamStatusOptions(row()).map((o) => o.note), ...Object.values(vmPoamFormErrors(row(), formOf(row(), { owner: 'o'.repeat(300), mitigation: 'm'.repeat(5000), scheduledCompletion: '2100-01-01', status: 'RISK_ACCEPTED' })))].join('\n');
  assert(!everything.includes('—') && !everything.includes('–'), 'F14 no em or en dash in any output or copy');
}

console.log('--- F15 source pins ---');
{
  const dialog = read('src/components/reports/VmPoamItemDialog.tsx');
  for (const piece of ['z-[60]', 'max-h-[90vh]', '<DialogTitle', 'useUnsavedTextProvider(', 'type="date"', 'maxLength={VM_POAM_MITIGATION_MAX}', 'maxLength={VM_POAM_OWNER_MAX}',
    'role="group"', 'Keep editing', 'onClose={saving ? undefined : requestClose}', 'readOnly={locked}', 'VM_POAM_ITEM_COPY.loadCurrent', 'aria-expanded={historyOpen}']) {
    assert(dialog.includes(piece), `F15 the dialog includes ${piece}`);
  }
  assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML/.test(dialog), 'F15 the dialog has no console, browser storage or raw HTML');
  assert(dialog.includes('e.stopPropagation()') && dialog.includes("e.key === 'Escape'"), 'F15 Escape inside the discard group only cancels the confirmation');
  const form = read('src/data/reports/vmPoamItemForm.ts');
  assert(!/console\.|localStorage|sessionStorage|ApiClient/.test(form), 'F15 the form helpers have no console, storage or ApiClient');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
