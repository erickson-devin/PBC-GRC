import fs from 'fs';
import path from 'path';
import { validateAssignmentBatch, targetProblem, validateTeamInput } from '../src/data/assignments/assignmentSchema';
import { assigneeState, assigneeStateText, groupResponsibilities, reviewerCheck, responsibilityIsOpen } from '../src/data/assignments/assignmentsView';
import { SSP_SECTIONS, SSP_SIGNABLE_SECTION_IDS } from '../src/data/ssp/sspSections';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { MAX_ASSIGNMENT_BATCH, type Assignment, type ResponsibilityItem } from '../src/types/assignments';
import type { SspSectionReview } from '../src/types/sspProfile';
import type { TenantRole } from '../src/types/tenant';

/**
 * #253: the pure parts of teams and responsibilities. The validators shared by the server and the client, the state of an assignee, the advisory
 * reviewer check (an assignment is a label and never grants a permission) and the grouping of "my responsibilities".
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

const ids = getFrameworkControls('CMMC_L2').map((c) => c.id);
const first = ids[0];
const item = (over: Record<string, unknown> = {}) => ({ targetKind: 'control', targetId: first, duty: 'owner', assignee: { kind: 'user', id: 'u1' }, expectedAssignee: null, ...over });

console.log('\n--- AV1: validateAssignmentBatch ---');
{
  const e = validateAssignmentBatch({ items: [] });
  assert(e.ok === false && e.index === null && e.field === 'items', 'AV1 an empty list names the items field', e);
  const big = validateAssignmentBatch({ items: Array.from({ length: MAX_ASSIGNMENT_BATCH + 1 }, (_, i) => item({ targetId: `X-${i}` })) });
  assert(big.ok === false, 'AV1 more than the batch limit is refused');
  const exact = validateAssignmentBatch({ items: Array.from({ length: MAX_ASSIGNMENT_BATCH }, (_, i) => item({ targetId: `X-${i}` })) });
  assert(exact.ok === true, 'AV1 the batch limit itself is accepted');
  const k = validateAssignmentBatch({ items: [item({ targetKind: 'Control' })] });
  assert(k.ok === false && k.index === 0 && k.field === 'targetKind', 'AV1 a wrong kind names item 0 and targetKind', k);
  assert(validateAssignmentBatch(null).ok === false && validateAssignmentBatch({}).ok === false && validateAssignmentBatch({ items: 'x' }).ok === false, 'AV1 a body that is not a list is refused');
  const ok = validateAssignmentBatch({ items: [item(), item({ targetKind: 'objective', targetId: `${first}[a]`, assignee: null, expectedAssignee: { kind: 'team', id: 't-1' } })] });
  assert(ok.ok === true && ok.items.length === 2 && ok.items[1].assignee === null && ok.items[1].expectedAssignee?.kind === 'team', 'AV1 a valid batch, an unassign with an expected team', ok);
  const f = (over: Record<string, unknown>) => {
    const r = validateAssignmentBatch({ items: [item(), item(over)] });
    return r.ok ? null : `${r.index}:${r.field}`;
  };
  assert(f({ targetId: 'bad id!' }) === '1:targetId', 'AV1 a target id with a space is refused');
  assert(f({ targetKind: 'objective' }) === '1:targetId', 'AV1 an objective needs an objective id');
  assert(f({ targetId: `${first}[a]` }) === '1:targetId', 'AV1 a control must not carry a letter');
  assert(f({ duty: 'boss' }) === '1:duty', 'AV1 an unknown duty');
  assert(f({ assignee: { kind: 'robot', id: 'u1' } }) === '1:assignee', 'AV1 an unknown assignee kind');
  assert(f({ assignee: { kind: 'user', id: 'bad id' } }) === '1:assignee', 'AV1 an assignee id outside the pattern');
  assert(f({ assignee: { kind: 'user', id: 'u1', x: 1 } }) === '1:assignee', 'AV1 an extra key on the assignee');
  assert(f({ expectedAssignee: undefined }) === '1:expectedAssignee', 'AV1 expectedAssignee is required');
  assert(f({ expectedAssignee: 'u1' }) === '1:expectedAssignee', 'AV1 expectedAssignee must be a ref or null');
  assert(f({ extra: 1 }) === '1:items', 'AV1 an unknown key');
  assert(f({}) === '1:targetId', 'AV1 the same target and duty twice in one batch');
  const echo = JSON.stringify(validateAssignmentBatch({ items: [item({ targetId: 'SECRET value!' })] }));
  assert(!echo.includes('SECRET'), 'AV1 an error never echoes a value', echo);
}

console.log('\n--- AV2: targetProblem ---');
{
  const ctx = { catalogIds: new Set(ids), sectionIds: SSP_SECTIONS.map((s) => s.id) as string[], signableIds: SSP_SIGNABLE_SECTION_IDS as readonly string[] };
  assert(targetProblem({ targetKind: 'control', targetId: first, duty: 'owner' }, ctx) === null, 'AV2 a control of the program');
  assert(targetProblem({ targetKind: 'objective', targetId: `${first}[a]`, duty: 'owner' }, ctx) === null, 'AV2 an objective of a control of the program');
  assert(targetProblem({ targetKind: 'objective', targetId: 'ZZ-9[a]', duty: 'owner' }, ctx) === 'target_not_in_program', 'AV2 an objective of an unknown control');
  assert(targetProblem({ targetKind: 'control', targetId: 'ZZ-9', duty: 'owner' }, ctx) === 'target_not_in_program', 'AV2 an unknown control');
  assert(targetProblem({ targetKind: 'ssp_section', targetId: 'roles', duty: 'reviewer' }, ctx) === null, 'AV2 a reviewer on a signable section');
  assert(targetProblem({ targetKind: 'ssp_section', targetId: 'nope', duty: 'owner' }, ctx) === 'target_not_in_program', 'AV2 an unknown section');
  assert(targetProblem({ targetKind: 'control', targetId: first, duty: 'reviewer' }, ctx) === 'reviewer_only_for_sections', 'AV2 a reviewer on a control');
  const nonSignable = SSP_SECTIONS.find((s) => !s.signable)!.id;
  assert(targetProblem({ targetKind: 'ssp_section', targetId: nonSignable, duty: 'reviewer' }, ctx) === 'reviewer_only_for_sections', 'AV2 a reviewer on a section that cannot be signed');
  assert(targetProblem({ targetKind: 'ssp_section', targetId: nonSignable, duty: 'owner' }, ctx) === null, 'AV2 an owner on a section that cannot be signed');
}

console.log('\n--- AV3: assigneeState ---');
{
  const ctx = { members: new Map([['u1', { accessExpiresOn: '2026-12-31' }], ['u2', { accessExpiresOn: null }], ['u3', {}]]), teamIds: new Set(['t1']) };
  const at = (s: string) => Date.parse(`${s}T00:00:00Z`);
  assert(assigneeState({ kind: 'user', id: 'u1' }, ctx, at('2027-01-01')) === 'membership_expired', 'AV3 access ended the day before');
  assert(assigneeState({ kind: 'user', id: 'u1' }, ctx, at('2026-12-31')) === 'active', 'AV3 the last day is still active');
  assert(assigneeState({ kind: 'user', id: 'u2' }, ctx, at('2040-01-01')) === 'active' && assigneeState({ kind: 'user', id: 'u3' }, ctx, at('2040-01-01')) === 'active', 'AV3 no end date is active');
  assert(assigneeState({ kind: 'user', id: 'gone' }, ctx, at('2027-01-01')) === 'not_member', 'AV3 a user who left');
  assert(assigneeState({ kind: 'team', id: 'tx' }, ctx, at('2027-01-01')) === 'team_removed' && assigneeState({ kind: 'team', id: 't1' }, ctx, at('2027-01-01')) === 'active', 'AV3 a team that is gone, and one that is there');
  assert(assigneeStateText('not_member') === 'No longer a member' && assigneeStateText('membership_expired') === 'Access expired' && assigneeStateText('team_removed') === 'Team removed' && assigneeStateText('active') === '', 'AV3 the chip texts');
}

console.log('\n--- AV4: reviewerCheck is advisory ---');
{
  const asg = (kind: 'user' | 'team', id: string): Assignment => ({ targetKind: 'ssp_section', targetId: 'roles', duty: 'reviewer', assignee: { kind, id }, assigneeState: 'active', assignedAt: '2027-01-01T00:00:00Z', assignedBy: null });
  const review = (by: string): SspSectionReview => ({ id: 'r', sectionId: 'roles', contentSha256: 'x', reviewerUserId: by, reviewerName: 'N', reviewerRole: 'TENANT_OWNER', createdAt: '2027-01-02T00:00:00Z' });
  const roles = new Map<string, TenantRole>([['u1', 'TENANT_OWNER'], ['u2', 'TENANT_ADMIN'], ['u3', 'ASSESSOR'], ['u4', 'VIEWER']]);
  const teams = new Map<string, string[]>([['t1', ['u2', 'u3']], ['t2', ['u3', 'u4']], ['t0', []]]);
  const ctx = { teams, roles };
  assert(reviewerCheck(null, review('u1'), ctx).kind === 'none', 'AV4 no assignment');
  assert(reviewerCheck(asg('user', 'u1'), review('u1'), ctx).kind === 'match', 'AV4 signed by the assigned reviewer');
  assert(reviewerCheck(asg('user', 'u1'), review('u2'), ctx).kind === 'signed_by_other', 'AV4 signed by someone else');
  assert(reviewerCheck(asg('user', 'u1'), null, ctx).kind === 'not_signed', 'AV4 not signed');
  assert(reviewerCheck(asg('user', 'u3'), null, ctx).kind === 'reviewer_cannot_sign', 'AV4 an assessor cannot sign off');
  assert(reviewerCheck(asg('user', 'u4'), review('u1'), ctx).kind === 'reviewer_cannot_sign', 'AV4 a viewer cannot sign off, whoever signed');
  assert(reviewerCheck(asg('team', 't1'), review('u2'), ctx).kind === 'match', 'AV4 a team: a member signed');
  assert(reviewerCheck(asg('team', 't1'), review('u1'), ctx).kind === 'signed_by_other', 'AV4 a team: a non-member signed');
  assert(reviewerCheck(asg('team', 't2'), null, ctx).kind === 'reviewer_cannot_sign', 'AV4 a team of read-only members cannot sign');
  assert(reviewerCheck(asg('team', 't0'), null, ctx).kind === 'not_signed', 'AV4 an empty team is not signed');
  assert(reviewerCheck(asg('user', 'gone'), null, ctx).kind === 'not_signed', 'AV4 a member who left is not called read-only');
}

console.log('\n--- AV5: grouping my responsibilities ---');
{
  const it = (over: Partial<ResponsibilityItem>): ResponsibilityItem => ({ targetKind: 'control', targetId: 'AC-1', duty: 'owner', via: 'user', teamId: null, status: 'NOT_STARTED', reviewed: null, ...over });
  const g = groupResponsibilities({
    truncated: false,
    programs: [
      { programId: 'p1', name: 'One', frameworkId: 'CMMC_L2', archived: false, items: [it({ targetId: 'AC-1' }), it({ targetId: 'AC-2', status: 'MET' }), it({ targetKind: 'objective', targetId: 'AC-1[a]', status: 'IN_PROGRESS' }), it({ targetKind: 'ssp_section', targetId: 'roles', duty: 'reviewer', status: null, reviewed: true })] },
      { programId: 'p2', name: 'Two', frameworkId: 'NIST_800_53_REV5', archived: true, items: [] },
    ],
  });
  assert(g.length === 1 && g[0].programId === 'p1', 'AV5 a program with nothing assigned is left out', g.map((x) => x.programId));
  assert(g[0].byKind.control.length === 2 && g[0].byKind.objective.length === 1 && g[0].byKind.ssp_section.length === 1, 'AV5 grouped by kind');
  assert(g[0].openCount === 2, 'AV5 open: one control not started, one objective in progress; a Met control and a reviewed section are not open', g[0].openCount);
  assert(responsibilityIsOpen(it({ targetKind: 'ssp_section', status: null, reviewed: null })) === true && responsibilityIsOpen(it({ status: 'NOT_MET' })) === false, 'AV5 an owned section stays open; a Not met control is decided');
}

console.log('\n--- AV6: validateTeamInput ---');
{
  const r = validateTeamInput({ name: '  Blue team ', description: ' d ' }, false);
  assert(r.ok === true && r.value.name === 'Blue team' && r.value.description === 'd', 'AV6 trimmed name and description', r);
  assert(validateTeamInput({}, false).ok === false && validateTeamInput({ name: '   ' }, false).ok === false, 'AV6 a create needs a name');
  const p = validateTeamInput({ description: 'x' }, true);
  assert(p.ok === true && p.value.name === undefined, 'AV6 a partial update may leave the name out');
  const long = validateTeamInput({ name: 'x'.repeat(121) }, false);
  assert(long.ok === false && long.field === 'name', 'AV6 a name over 120 characters', long);
  const d = validateTeamInput({ name: 'ok', description: 'x'.repeat(1001) }, false);
  assert(d.ok === false && d.field === 'description', 'AV6 a description over 1000 characters', d);
  assert(validateTeamInput({ name: 'a\u0007b' }, false).ok === false, 'AV6 a control character in the name');
  assert(validateTeamInput({ name: 'ok', description: 'two\nlines' }, false).ok === true, 'AV6 a line break in the description is fine');
  assert(validateTeamInput({ name: 'ok', extra: 1 }, false).ok === false && validateTeamInput({ name: 5 }, false).ok === false && validateTeamInput(null, false).ok === false, 'AV6 unknown keys, wrong types and a missing body');
  assert(validateTeamInput({ name: 'ok', expectedUpdatedAt: '2027-01-01T00:00:00Z' }, true).ok === true, 'AV6 expectedUpdatedAt is the route own');
  const bad = JSON.stringify(validateTeamInput({ name: 'SECRET\u0007' }, false));
  assert(!bad.includes('SECRET'), 'AV6 an error never echoes the name', bad);
}

console.log('\n--- AV7: the modules are pure ---');
{
  for (const f of ['assignmentSchema', 'assignmentsView']) {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'assignments', `${f}.ts`), 'utf8');
    assert(!/\b(localStorage|sessionStorage|console\.|fetch\(|Date\.now|new Date|from 'react')/.test(src), `AV7 ${f} has no storage, console, network, clock or React`);
  }
  for (const f of ['useAssignments', 'useTeams', 'useResponsibilities']) {
    const p = path.join(process.cwd(), 'src', 'hooks', `${f}.ts`);
    if (!fs.existsSync(p)) continue; // written by the client coder
    const src = fs.readFileSync(p, 'utf8');
    assert(!/\b(localStorage|sessionStorage|console\.)/.test(src), `AV7 ${f} keeps nothing in browser storage and never logs`);
  }
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
