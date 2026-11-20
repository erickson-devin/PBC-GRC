import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';
import {
  ASSIGNMENT_TEXT,
  assigneeChip,
  assigneeOptions,
  assignmentErrorMessage,
  bulkAssignPlan,
  bulkConfirmText,
  decodeAssignee,
  encodeAssignee,
  reviewerCheckText,
  teamErrorMessage,
} from '../src/data/assignments/assignmentsUiView';
import { AssignControl, type AssignControlProps } from '../src/components/assignments/AssignControl';
import { SspReviewerChipView } from '../src/components/ssp/SspReviewerChip';
import type { Assignment, Team } from '../src/types/assignments';
import type { TeamMember } from '../src/types/tenant';

/**
 * #253: what the assignment screens show. The picker's options, the chip, the error texts, the bulk plan and its confirmation sentence, the markup of
 * the assign control and of the reviewer chip rendered without a browser, and the source rules (where the controls are mounted, nothing stored or logged).
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

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-11-20T12:00:00Z');

const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm', tenantId: 't', email: 'x@example.com', name: '', role: 'TENANT_ADMIN', status: 'ACTIVE', userId: 'u', ...over });
const team = (id: string, name: string, memberIds: string[] = []): Team => ({ id, name, description: '', memberIds, createdAt: '', updatedAt: '', updatedBy: null });
const owned = (controlId: string, kind: 'user' | 'team', id: string): Assignment => ({
  targetKind: 'control', targetId: controlId, duty: 'owner', assignee: { kind, id }, assigneeState: 'active', assignedAt: '', assignedBy: null,
});

console.log('\n--- AU1: assigneeOptions ---');
{
  const members: TeamMember[] = [
    member({ id: 'm1', userId: 'u-zed', name: 'Zed Last' }),
    member({ id: 'm2', userId: 'u-amy', name: 'amy First' }),
    member({ id: 'm3', userId: 'u-old', name: 'Old Timer', accessExpiresOn: '2026-01-01' }),
    member({ id: 'm4', userId: 'u-dis', name: 'Dee Sabled', accountDisabled: true }),
    member({ id: 'm5', userId: undefined, name: 'No User Id' }),
    member({ id: 'm6', userId: 'u-pending', name: 'Pending Person', status: 'PENDING_INVITE' }),
    member({ id: 'm7', userId: 'u-mail', name: '', email: 'mail@example.com' }),
  ];
  const o = assigneeOptions(members, [team('t2', 'Beta'), team('t1', 'alpha')], NOW, null);
  const labels = o.people.map((p) => p.label);
  assert(!labels.some((l) => l.includes('No User Id')) && !labels.some((l) => l.includes('Pending Person')), 'AU1 a pending invitation and a member without a user id are left out', labels);
  const old = o.people.find((p) => p.value === 'user:u-old');
  assert(old?.disabled === true && old.label === 'Old Timer (access expired)', 'AU1 an expired member is shown disabled with the reason', old);
  const dis = o.people.find((p) => p.value === 'user:u-dis');
  assert(dis?.disabled === true && dis.label === 'Dee Sabled (account disabled)', 'AU1 a disabled account is shown disabled with the reason', dis);
  assert(labels[0] === 'amy First' && labels[labels.length - 1] === 'Zed Last', 'AU1 people are sorted by label, case-insensitively', labels);
  assert(labels.includes('mail@example.com'), 'AU1 a member without a name is labelled by email', labels);
  assert(o.teams.map((t) => t.label).join(',') === 'alpha,Beta', 'AU1 teams are sorted by name', o.teams);
  assert(o.currentExtra === null, 'AU1 no extra option when nobody is assigned');
  const gone = assigneeOptions(members, [], NOW, { kind: 'user', id: 'gone' });
  assert(gone.currentExtra?.label === 'Former member (no longer a member)' && gone.currentExtra.disabled, 'AU1 a former member stays shown, disabled', gone.currentExtra);
  const goneTeam = assigneeOptions(members, [], NOW, { kind: 'team', id: 'gone' });
  assert(goneTeam.currentExtra?.label === 'Removed team', 'AU1 a removed team stays shown', goneTeam.currentExtra);
  const present = assigneeOptions(members, [], NOW, { kind: 'user', id: 'u-amy' });
  assert(present.currentExtra === null, 'AU1 a current assignee who is in the list needs no extra option');
}

console.log('\n--- AU2: encodeAssignee / decodeAssignee ---');
{
  assert(encodeAssignee(null) === '' && encodeAssignee({ kind: 'team', id: 'tm_1' }) === 'team:tm_1', 'AU2 encode');
  const rt = decodeAssignee(encodeAssignee({ kind: 'user', id: 'u1' }));
  assert(rt !== null && rt.kind === 'user' && rt.id === 'u1', 'AU2 a value round-trips', rt);
  assert(decodeAssignee('') === null && decodeAssignee('x:y') === null && decodeAssignee('user:bad id!') === null && decodeAssignee('user:') === null && decodeAssignee('user') === null, 'AU2 anything else is null');
}

console.log('\n--- AU3: assignmentErrorMessage / teamErrorMessage ---');
{
  const by = (reason: string, status = 400) => assignmentErrorMessage(Object.assign(new Error('MARK'), { reason, status }));
  const table: [string, string][] = [
    ['stale_write', 'Someone else changed this assignment. The current assignee is shown; choose again if needed.'],
    ['assignee_not_member', 'That person is not a current member of this organization.'],
    ['target_not_in_program', 'That item is not part of this program.'],
    ['reviewer_only_for_sections', 'A reviewer can only be assigned to an SSP section that is signed off.'],
    ['team_not_found', 'That team was removed.'],
    ['teams_not_available', 'Teams are not available yet.'],
    ['limit', 'This program has reached its assignment limit.'],
    ['program_archived', ASSIGNMENT_TEXT.archived],
    ['duplicate_name', 'A team with that name already exists.'],
    ['team_in_use', 'This team still has assignments.'],
  ];
  for (const [reason, text] of table) assert(by(reason, 409) === text, `AU3 ${reason}`, by(reason, 409));
  assert(assignmentErrorMessage({ status: 403 }) === 'Only a Tenant Owner or Admin can change assignments.', 'AU3 403');
  assert(assignmentErrorMessage(new Error('MARK')) === 'The assignment was not saved. Try again.', 'AU3 default');
  assert(assignmentErrorMessage(null) === 'The assignment was not saved. Try again.' && assignmentErrorMessage('MARK') === 'The assignment was not saved. Try again.', 'AU3 a non-error value gives the default');
  assert(!by('whatever').includes('MARK') && !by('stale_write').includes('MARK'), 'AU3 no message echoes the error text');
  assert(teamErrorMessage({ reason: 'duplicate_name', status: 409 }) === 'A team with that name already exists.', 'AU3 team duplicate_name');
  assert(teamErrorMessage({ reason: 'not_a_member', status: 400 }).includes('whose access has not ended'), 'AU3 team not_a_member');
  assert(teamErrorMessage({ status: 403 }) === 'Only a Tenant Owner or Admin can change teams.', 'AU3 team 403');
  assert(!teamErrorMessage(new Error('MARK')).includes('MARK') && teamErrorMessage(new Error('MARK')) === 'The team was not saved. Try again.', 'AU3 team default');
}

console.log('\n--- AU4: bulkAssignPlan ---');
{
  const current = new Map<string, Assignment>([['control|b|owner', owned('b', 'user', 'u2')]]);
  const u1 = { kind: 'user' as const, id: 'u1' };
  const keep = bulkAssignPlan(['a', 'b', 'c'], current, u1, false);
  assert(keep.changing === 2 && keep.skipped === 1 && keep.replacing === 0 && keep.unchanged === 0, 'AU4 a different owner is skipped without replace', keep);
  const rep = bulkAssignPlan(['a', 'b', 'c'], current, u1, true);
  const b = rep.chunks[0].find((i) => i.targetId === 'b');
  assert(rep.changing === 3 && rep.replacing === 1 && rep.skipped === 0, 'AU4 replace changes all three', rep);
  assert(b?.expectedAssignee?.id === 'u2' && rep.chunks[0].find((i) => i.targetId === 'a')?.expectedAssignee === null, 'AU4 each change carries the owner this screen saw', b);
  const same = bulkAssignPlan(['a', 'b'], new Map([['control|a|owner', owned('a', 'user', 'u1')]]), u1, false);
  assert(same.unchanged === 1 && same.changing === 1, 'AU4 the same owner is unchanged', same);
  const clear = bulkAssignPlan(['a', 'b', 'c'], current, null, false);
  assert(clear.changing === 1 && clear.unchanged === 2 && clear.chunks[0][0].targetId === 'b' && clear.chunks[0][0].assignee === null, 'AU4 removing touches only the assigned', clear);
  const ids = Array.from({ length: 1001 }, (_, i) => `c${i}`);
  const big = bulkAssignPlan(ids, new Map(), u1, false);
  assert(big.chunks.map((c) => c.length).join(',') === '500,500,1' && big.changing === 1001, 'AU4 1001 ids go in chunks of 500, 500 and 1', big.chunks.map((c) => c.length));
  assert(bulkAssignPlan([], new Map(), u1, false).chunks.length === 0, 'AU4 nothing to change gives no chunk');
}

console.log('\n--- AU5: bulkConfirmText ---');
{
  const p = { chunks: [], changing: 2, replacing: 0, skipped: 1, unchanged: 0 };
  assert(bulkConfirmText(p, 'Amy') === 'Assign Amy as owner of 2 controls? 1 control that already has a different owner will be skipped.', 'AU5 assign with one skipped', bulkConfirmText(p, 'Amy'));
  assert(bulkConfirmText({ ...p, skipped: 3, replacing: 1 }, 'Amy') === 'Assign Amy as owner of 2 controls? 3 controls that already have a different owner will be skipped. 1 control will change owner.', 'AU5 plural skipped and a replaced one');
  assert(bulkConfirmText({ ...p, changing: 1, skipped: 0 }, 'Amy') === 'Assign Amy as owner of 1 control?', 'AU5 one control');
  assert(bulkConfirmText({ ...p, changing: 3 }, null) === 'Remove the owner from 3 controls?', 'AU5 removal');
  assert(bulkConfirmText({ ...p, changing: 1 }, null) === 'Remove the owner from 1 control?', 'AU5 removal of one');
}

console.log('\n--- AU6: AssignControl markup ---');
{
  const base: AssignControlProps = {
    duty: 'owner', targetLabel: 'AC.L2-3.1.1', assignment: null, options: { people: [{ value: 'user:u1', label: 'Amy', disabled: false }], teams: [], currentExtra: null },
    chip: { text: 'Unassigned', tag: null, tone: 'none' }, canAssign: false, lockedReason: ASSIGNMENT_TEXT.readOnly, busy: false, error: null, onSave: async () => true,
  };
  const ro = renderToStaticMarkup(React.createElement(AssignControl, base));
  assert(!ro.includes('<select') && !ro.includes('Change') && !ro.includes('<button'), 'AU6 a read role gets no picker and no button', ro);
  assert(ro.includes('Unassigned') && ro.includes(ASSIGNMENT_TEXT.readOnly), 'AU6 a read role sees the chip and the reason');
  const rw = renderToStaticMarkup(React.createElement(AssignControl, { ...base, canAssign: true, lockedReason: null }));
  assert(rw.includes('aria-label="Assign owner of AC.L2-3.1.1"'), 'AU6 the button names what it assigns', rw);
  assert(!rw.includes('<select'), 'AU6 the picker opens only on request');
  const changed = renderToStaticMarkup(React.createElement(AssignControl, { ...base, canAssign: true, lockedReason: null, assignment: owned('x', 'user', 'u1'), chip: { text: 'Amy', tag: null, tone: 'ok' } }));
  assert(changed.includes('aria-label="Change owner of AC.L2-3.1.1"') && changed.includes('>Change<'), 'AU6 an assigned item offers Change', changed);
  const hint = renderToStaticMarkup(React.createElement(AssignControl, { ...base, showHint: true }));
  assert(hint.includes('does not give anyone access'), 'AU6 the hint says an assignment grants no access');
  const warn = renderToStaticMarkup(React.createElement(AssignControl, { ...base, chip: { text: 'Former member', tag: 'No longer a member', tone: 'warn' } }));
  assert(warn.includes('Former member') && warn.includes('No longer a member'), 'AU6 a former member keeps its state shown');
  const errored = renderToStaticMarkup(React.createElement(AssignControl, { ...base, error: 'Someone else changed this assignment.' }));
  assert(errored.includes('role="alert"') && errored.includes('role="status"'), 'AU6 an error is an alert and a polite status exists');
  const chip = assigneeChip(null, [], []);
  assert(chip.text === 'Unassigned' && chip.tone === 'none', 'AU6 chip of nobody');
  const gone = assigneeChip({ ...owned('x', 'user', 'u9'), assigneeState: 'not_member' }, [], []);
  assert(gone.text === 'Former member' && gone.tag === 'No longer a member' && gone.tone === 'warn', 'AU6 chip of a former member', gone);
  const exp = assigneeChip({ ...owned('x', 'user', 'u1'), assigneeState: 'membership_expired' }, [member({ userId: 'u1', name: 'Amy' })], []);
  assert(exp.text === 'Amy' && exp.tag === 'Access expired' && exp.tone === 'warn', 'AU6 chip of an expired member', exp);
  const tm = assigneeChip(owned('x', 'team', 't1'), [], [team('t1', 'Ops')]);
  assert(tm.text === 'Ops (team)' && tm.tone === 'ok', 'AU6 chip of a team', tm);
  const rm = assigneeChip({ ...owned('x', 'team', 't9'), assigneeState: 'team_removed' }, [], []);
  assert(rm.text === 'Removed team' && rm.tag === 'Team removed' && rm.tone === 'warn', 'AU6 chip of a removed team', rm);
}

console.log('\n--- AU7: the reviewer chip ---');
{
  const control: AssignControlProps = {
    duty: 'reviewer', targetLabel: 'Roles', assignment: null, options: { people: [], teams: [], currentExtra: null }, chip: { text: 'Unassigned', tag: null, tone: 'none' },
    canAssign: false, lockedReason: null, busy: false, error: null, onSave: async () => true,
  };
  const texts: [ReturnType<typeof reviewerCheckText>, string][] = [
    [reviewerCheckText({ kind: 'none' }, null, null), 'No reviewer assigned.'],
    [reviewerCheckText({ kind: 'match' }, 'Amy', 'Admin'), 'Last signed off by the assigned reviewer.'],
    [reviewerCheckText({ kind: 'signed_by_other' }, 'Amy', 'Admin'), 'Last signed off by someone other than the assigned reviewer.'],
    [reviewerCheckText({ kind: 'not_signed' }, 'Amy', 'Admin'), 'The assigned reviewer has not signed off yet.'],
    [reviewerCheckText({ kind: 'reviewer_cannot_sign' }, 'Amy', 'Assessor'), "Amy's role (Assessor) cannot sign off. A Tenant Owner or Admin signs off instead."],
  ];
  for (const [got, want] of texts) {
    assert(got.text === want, `AU7 ${want}`, got.text);
    const html = renderToStaticMarkup(React.createElement(SspReviewerChipView, { control, check: got }));
    assert(html.includes(want.replace(/'/g, '&#x27;')) || html.includes(want), `AU7 the chip view renders: ${want}`);
    assert(html.includes('Advisory only'), 'AU7 the chip view says it is advisory');
  }
  const cannot = texts[4][0];
  assert(cannot.tone === 'warn' && texts[2][0].tone === 'warn' && texts[1][0].tone === 'ok' && texts[0][0].tone === 'none' && texts[3][0].tone === 'none', 'AU7 tones');
  assert(!/disabled/.test(renderToStaticMarkup(React.createElement(SspReviewerChipView, { control, check: cannot }))), 'AU7 nothing in the chip view is disabled');
}

console.log('\n--- AU8: where the controls are mounted ---');
{
  const inspect = read('src', 'components', 'matrix', 'InspectDocumentModal.tsx');
  const objectives = read('src', 'components', 'matrix', 'ObjectiveChecklist.tsx');
  const builder = read('src', 'components', 'ssp', 'SSPBuilder.tsx');
  const review = read('src', 'components', 'ssp', 'SspSectionReview.tsx');
  const sidebar = read('src', 'components', 'layout', 'Sidebar.tsx');
  const app = read('src', 'App.tsx');
  const ctx = read('src', 'context', 'AssessmentContext.tsx');
  const scoped = read('src', 'data', 'programDefaultChoice.ts');
  const matrix = read('src', 'components', 'dashboard', 'AssessmentMatrix.tsx');
  const settings = read('src', 'components', 'settings', 'TeamSettingsModal.tsx');
  assert(inspect.includes("useAssignControlProps('control'") && inspect.includes('<AssignControl {...ownerProps} showHint />'), 'AU8 the control dialog shows the owner');
  assert(inspect.includes('ASSIGNMENT_TEXT.browserOnly'), 'AU8 the control dialog says assignments need a server-backed organization');
  assert(objectives.includes('<ObjectiveOwner') && objectives.includes('currentTenant.serverBacked &&'), 'AU8 every objective row shows its owner on server-backed organizations');
  assert(builder.includes('<SectionOwner') && builder.includes('reviewer={') && builder.includes('<SspReviewerChip'), 'AU8 the SSP builder shows the section owner and the reviewer');
  assert(review.includes('{supported && reviewer}') && review.includes('reviewer?: React.ReactNode;'), 'AU8 the section review renders the reviewer');
  assert(sidebar.includes("id: 'responsibilities'") && sidebar.includes("'My Responsibilities'") && sidebar.includes('currentTenant.serverBacked ?'), 'AU8 the sidebar item exists for server-backed organizations only');
  assert(app.includes("{activeTab === 'responsibilities' && <ResponsibilitiesView />}"), 'AU8 the app mounts the responsibilities view');
  assert(ctx.includes("| 'responsibilities'"), 'AU8 the tab id exists');
  assert(!scoped.includes("'responsibilities'"), 'AU8 the responsibilities tab is not program-scoped (it spans programs)');
  assert(matrix.includes('<BulkAssignDialog') && matrix.includes('Assign owner ({filteredControls.length})') && matrix.includes('canEdit && !activeProgram?.archived'), 'AU8 the matrix offers bulk assignment to write roles on a live program');
  assert(settings.includes('<TeamsSection />') && settings.includes("'teams'") && settings.includes('teamsSupported'), 'AU8 team settings has a Teams tab, for server-backed organizations only');
}

console.log('\n--- AU9: source rules of the new files ---');
{
  const files = [
    ['src', 'data', 'assignments', 'assignmentsUiView.ts'],
    ['src', 'components', 'assignments', 'AssignControl.tsx'],
    ['src', 'components', 'assignments', 'useAssignControlProps.ts'],
    ['src', 'components', 'assignments', 'BulkAssignDialog.tsx'],
    ['src', 'components', 'assignments', 'ResponsibilitiesView.tsx'],
    ['src', 'components', 'ssp', 'SspReviewerChip.tsx'],
    ['src', 'components', 'settings', 'TeamsSection.tsx'],
  ];
  const sources = files.map((f) => ({ name: f[f.length - 1], src: read(...f) }));
  for (const { name, src } of sources) {
    assert(!/console\./.test(src) && !/localStorage|sessionStorage|indexedDB/.test(src), `AU9 ${name}: no console and no browser storage`);
    assert(!src.includes('dangerouslySetInnerHTML') && !src.includes('javascript:') && !/\balert\(/.test(src), `AU9 ${name}: no HTML injection, no javascript: URL, no alert()`);
    assert(!/Tenant Owner or MSP Admin/.test(src), `AU9 ${name}: wording guard`);
    for (const m of src.matchAll(/<DialogOverlay/g)) assert(src.slice(m.index!, m.index! + 900).includes('max-h-['), `AU9 ${name}: a dialog scrolls inside the viewport`);
  }
  const view = sources[0].src;
  assert(!/from 'react'|from '\.\.\/\.\.\/(services|context|hooks)/.test(view), 'AU9 assignmentsUiView imports no react, services, context or hooks');
  const dialog = sources.find((s) => s.name === 'BulkAssignDialog.tsx')!.src;
  assert(dialog.includes('<DialogOverlay') && dialog.includes('onClose={saving ? undefined : onClose}'), 'AU9 the bulk dialog cannot be dismissed while it saves');
  const resp = sources.find((s) => s.name === 'ResponsibilitiesView.tsx')!.src;
  assert(resp.includes('aria-disabled={program.archived || undefined}') && resp.includes('Archived: restore the program to open it.'), 'AU9 an archived program row cannot be opened and says why');
  assert(resp.includes('aria-label="Whose responsibilities"') && resp.includes('teams.length > 0'), 'AU9 the team toggle appears once a team exists');
  const teams = sources.find((s) => s.name === 'TeamsSection.tsx')!.src;
  assert(teams.includes('role="alertdialog"') && teams.includes('Delete team and assignments') && teams.includes('remove(t.id, assignments > 0)'), 'AU9 deleting a team that has assignments asks first and forces only then');
  assert(!/<option[^>]*>[^<]*u\.id|userId\}\s*<\/option>/.test(read('src', 'components', 'assignments', 'AssignControl.tsx')), 'AU9 the picker never prints a user id as text');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
