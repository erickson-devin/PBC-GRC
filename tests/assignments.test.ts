import './testEnv';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { __setMembershipClockForTests } from '../server/db';
import { __programAssignmentRowsForTests, __setAssignmentLimitForTests } from '../server/assignments/assignmentsStore';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { SSP_SECTIONS, SSP_SIGNABLE_SECTION_IDS } from '../src/data/ssp/sspSections';
import { utcToday } from '../src/utils/memberProfile';

/**
 * Assignments, responsibilities and teams (issue #253) over HTTP: who is responsible for a control, an objective or an SSP section (a person or a team),
 * with the stale-write rule, all-or-nothing batches, the assignee states (member who left, access expired, team removed), "my responsibilities" across
 * the programs, the advisory reviewer duty (the sign-off route is unchanged), teams (names, members, usage, delete with and without force), the history
 * (ids only; team names as digests), the limit, tenant isolation and the cascades of a program delete. An assignment is a label: it grants no access.
 * Runs against the in-memory store; the SQL is checked structurally in tests/dbSchema.test.ts and, against a live database, by `npm run db:verify-rls`.
 * Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const DAY = 86_400_000;

let passed = 0;
let total = 0;
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    origLog(`  ✓ PASS: ${name}`);
  } else {
    origError(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

// every line the server writes while the tests run (the test's own output goes through origLog)
const captured: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  console[level] = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
const withRole = (sub: string, tenant: string, role: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_as_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const O_ID = 'u_as_owner';
  const A_ID = 'u_as_admin';
  const S_ID = 'u_as_assessor';
  const V_ID = 'u_as_viewer';
  const owner = person(O_ID);
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Assignments Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] })).body?.tenant?.id as string;
  const admin = withRole(A_ID, T, 'TENANT_ADMIN');
  const assessor = withRole(S_ID, T, 'ASSESSOR');
  const viewer = withRole(V_ID, T, 'VIEWER');
  const rival = person('u_as_rival');
  const U = (await call('POST', '/tenants', rival, undefined, { name: 'Assignments Rival Org' })).body?.tenant?.id as string;
  const addMember = (id: string, role: string) => call('POST', `/tenants/${T}/members`, owner, T, { userId: id, email: `${id}@test.mil`, name: id, role });
  assert((await addMember(A_ID, 'TENANT_ADMIN')).status === 201 && (await addMember(S_ID, 'ASSESSOR')).status === 201 && (await addMember(V_ID, 'VIEWER')).status === 201, 'setup: an admin, an assessor and a viewer are members of T');
  const mkProgram = async (name: string, frameworkId: string, baseline?: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId, ...(baseline ? { baseline } : {}) })).body?.program?.id as string;
  const P1 = await mkProgram('AS Program 1', 'CMMC_L2');
  const P2 = await mkProgram('AS Program 2', 'NIST_800_53_REV5', 'LOW');
  const P3 = await mkProgram('AS Program 3', 'CMMC_L1');
  assert(Boolean(T) && Boolean(U) && Boolean(P1) && Boolean(P2) && Boolean(P3), 'setup: tenant T with P1 (CMMC_L2), P2 (NIST 800-53 LOW) and P3 (CMMC_L1), and tenant U', [T, U, P1, P2, P3]);

  const c = getFrameworkControls('CMMC_L2')[0].id;
  const c2 = getFrameworkControls('CMMC_L2')[1].id;
  const user = (id: string) => ({ kind: 'user', id });
  const item = (targetKind: string, targetId: string, duty: string, assignee: Json | null, expectedAssignee: Json | null = null) => ({ targetKind, targetId, duty, assignee, expectedAssignee });
  const put = (items: Json[], token: string | null = owner, program: string = P1) => call('PUT', '/assignments', token, T, { items }, program);
  const list = async (token: string | null = owner, program: string = P1) => (await call('GET', '/assignments', token, T, undefined, program)).body?.assignments as Json[];
  const mine = async (token: string, program: string = P1) => (await call('GET', '/assignments/mine', token, T, undefined, program)).body?.items as Json[];

  origLog('\n--- Person assignments ---');
  const a1 = await put([item('control', c, 'owner', user(S_ID))]);
  assert(a1.status === 200 && a1.body?.changed === 1 && a1.body?.assignments?.length === 1 && a1.body?.assignments?.[0]?.assigneeState === 'active', 'AS1 an owner assigns a control to a member -> 200, changed 1', a1.body);
  const g1 = ((await list()) ?? []).find((a) => a.targetId === c);
  assert(g1?.assignee?.kind === 'user' && g1?.assignee?.id === S_ID && g1?.duty === 'owner' && g1?.assigneeState === 'active' && g1?.assignedBy === O_ID && typeof g1?.assignedAt === 'string', 'AS1 GET shows it with the state active and who assigned it', g1);
  const a2 = await put([item('control', c, 'owner', user(S_ID))]);
  assert(a2.status === 409 && a2.body?.code === 'stale_write' && a2.body?.index === 0 && a2.body?.current?.id === S_ID, 'AS2 the same body again (expectedAssignee null, stored S) -> 409 stale_write with the index and the current assignee', a2.body);
  const a3 = await put([item('control', c, 'owner', user(S_ID), user(S_ID))]);
  assert(a3.status === 200 && a3.body?.changed === 0, 'setting what is already stored (with the right expectation) changes nothing', a3.body);
  const a4 = await put([item('control', c, 'owner', null, user(S_ID))]);
  assert(a4.status === 200 && a4.body?.changed === 1 && a4.body?.assignments?.length === 0 && (await list()).length === 0, 'AS2 an unassign with expectedAssignee S -> 200 (removed)', a4.body);
  const objectiveId = `${c}[a]`;
  const a5 = await put([item('objective', objectiveId, 'owner', user(S_ID)), item('ssp_section', 'identification', 'owner', user(A_ID))]);
  assert(a5.status === 200 && a5.body?.changed === 2 && (await list()).length === 2, 'an objective and an SSP section can be assigned too (one batch, 2 changes)', a5.body);

  origLog('\n--- Roles ---');
  assert((await put([item('control', c2, 'owner', user(S_ID))], viewer)).status === 403 && (await put([item('control', c2, 'owner', user(S_ID))], assessor)).status === 403 && (await call('GET', '/assignments', viewer, T, undefined, P1)).status === 200, 'AS3 a viewer and an assessor cannot write (403); a viewer can read (200)');
  assert((await put([item('control', c2, 'owner', user(V_ID))], admin)).status === 200, 'an admin can assign');
  assert((await call('PUT', '/controls/' + encodeURIComponent(c2), viewer, T, { status: 'IN_PROGRESS' }, P1)).status === 403, 'AS3b being named as an owner gives no access: the viewer assigned to a control still cannot change it (403)');
  assert((await call('PUT', '/controls/' + encodeURIComponent(c), assessor, T, { status: 'IN_PROGRESS' }, P1)).status === 403, 'AS3b nor does it for an assessor (403)');

  origLog('\n--- Refusals ---');
  const nistId = getFrameworkControls('NIST_800_53_REV5')[0].id;
  const r1 = await put([item('control', nistId, 'owner', user(S_ID))]);
  assert(r1.status === 400 && r1.body?.code === 'target_not_in_program' && r1.body?.index === 0, 'AS4 a control of another framework -> 400 target_not_in_program with the index', r1.body);
  const r2 = await put([item('control', c, 'reviewer', user(S_ID))]);
  const r3 = await put([item('ssp_section', 'system_details', 'reviewer', user(O_ID))]);
  assert(r2.status === 400 && r2.body?.code === 'reviewer_only_for_sections' && r3.status === 400 && r3.body?.code === 'reviewer_only_for_sections', 'AS4 a reviewer duty on a control, or on a section that cannot be signed -> 400 reviewer_only_for_sections', [r2.body, r3.body]);
  const r4 = await put([item('objective', 'ZZ-9[a]', 'owner', user(S_ID))]);
  assert(r4.status === 400 && r4.body?.code === 'target_not_in_program', 'an objective of a control that is not in the program -> 400 target_not_in_program', r4.body);
  const r5 = await put([item('control', c, 'owner', user('u_as_stranger'))]);
  assert(r5.status === 400 && r5.body?.code === 'assignee_not_member' && r5.body?.index === 0 && !r5.text.includes('u_as_stranger'), 'AS5 an assignee who is not a member -> 400 assignee_not_member with the index, the id not echoed', r5.body);
  const r6 = await put([item('control', c, 'owner', { kind: 'team', id: 'no-such-team' })]);
  assert(r6.status === 404 && r6.body?.code === 'team_not_found' && r6.body?.index === 0, 'a team that does not exist -> 404 team_not_found', r6.body);
  const bad = [await put([]), await put([item('Control', c, 'owner', user(S_ID))]), await put([{ ...item('control', c, 'owner', user(S_ID)), extra: 1 }]), await put([item('control', c, 'owner', user(S_ID)), item('control', c, 'owner', user(A_ID))])];
  assert(bad.every((r) => r.status === 400 && r.body?.code === 'invalid') && bad[1].body?.index === 0 && bad[1].body?.field === 'targetKind' && bad[0].body?.field === 'items', 'AS-V a malformed batch -> 400 invalid with the field (and the index of the item), a duplicate target in one batch too', bad.map((r) => r.body));
  const before = (await list()).length;
  const batch = await put([item('control', c, 'owner', user(S_ID)), item('control', nistId, 'owner', user(S_ID))]);
  assert(batch.status === 400 && (await list()).length === before && !((await list()) ?? []).some((a) => a.targetId === c && a.duty === 'owner'), 'AS6 a batch of 2 whose second item is invalid -> 400 and the first was not written (all or nothing)', batch.body);
  const stale2 = await put([item('control', c, 'owner', user(S_ID)), item('objective', objectiveId, 'owner', user(A_ID), user(O_ID))]);
  assert(stale2.status === 409 && stale2.body?.index === 1 && !((await list()) ?? []).some((a) => a.targetId === c && a.duty === 'owner'), 'a stale item in a batch -> 409 with its index, nothing written', stale2.body);

  origLog('\n--- A member who left, access that ended ---');
  assert((await put([item('control', c, 'owner', user(S_ID))])).status === 200, 'S is assigned to the control');
  assert((await call('DELETE', `/tenants/${T}/members/${S_ID}`, owner, T)).status === 200, 'S is removed from the organization');
  const left = ((await list()) ?? []).find((a) => a.targetId === c && a.duty === 'owner');
  assert(left?.assigneeState === 'not_member' && left?.assignee?.id === S_ID, 'AS7 the row stays and shows not_member', left);
  assert((await addMember(S_ID, 'ASSESSOR')).status === 201 && ((await list()) ?? []).find((a) => a.targetId === c && a.duty === 'owner')?.assigneeState === 'active', 'AS7 re-adding S makes it active again');
  const today = utcToday(Date.now());
  assert((await call('PATCH', `/tenants/${T}/members/${S_ID}`, owner, T, { accessExpiresOn: today })).status === 200, 'S gets an access expiry of today');
  try {
    __setMembershipClockForTests(() => Date.now() + 2 * DAY);
    const expired = ((await list()) ?? []).find((a) => a.targetId === c && a.duty === 'owner');
    assert(expired?.assigneeState === 'membership_expired', 'AS8 two days later the assignment shows membership_expired', expired);
    const refused = await put([item('control', c2, 'owner', user(S_ID), user(V_ID))]);
    assert(refused.status === 400 && refused.body?.code === 'assignee_not_member', 'a member whose access has ended cannot be assigned (400 assignee_not_member)', refused.body);
  } finally {
    __setMembershipClockForTests(null);
  }
  assert((await call('PATCH', `/tenants/${T}/members/${S_ID}`, owner, T, { accessExpiresOn: null })).status === 200, 'the expiry is cleared');

  origLog('\n--- My responsibilities ---');
  const m1 = await mine(assessor);
  assert(m1?.length === 2 && m1.some((i) => i.targetKind === 'control' && i.targetId === c && i.status === 'NOT_STARTED' && i.via === 'user' && i.teamId === null) && m1.some((i) => i.targetKind === 'objective' && i.targetId === objectiveId && i.status === 'NOT_STARTED'), 'AS9 /assignments/mine lists the caller\'s items with their live status', m1);
  assert((await call('PUT', `/controls/${encodeURIComponent(c)}`, owner, T, { status: 'IN_PROGRESS' }, P1)).status === 200 && (await mine(assessor)).find((i) => i.targetId === c)?.status === 'IN_PROGRESS', 'the status follows the control (IN_PROGRESS)');
  const resp = await call('GET', `/tenants/${T}/responsibilities?view=me`, assessor, T);
  assert(resp.status === 200 && resp.body?.programs?.length === 1 && resp.body.programs[0].programId === P1 && resp.body.programs[0].archived === false && resp.body.truncated === false && resp.body.programs[0].items.length === 2, 'AS9 /tenants/T/responsibilities?view=me as S -> one program (P1) with the 2 items', resp.body);
  const idle = withRole('u_as_idle', T, 'VIEWER');
  assert((await addMember('u_as_idle', 'VIEWER')).status === 201 && (await mine(idle))?.length === 0 && (await call('GET', `/tenants/${T}/responsibilities`, idle, T)).body?.programs?.length === 0, 'a member with nothing assigned gets nothing');
  assert((await call('GET', `/tenants/${T}/responsibilities?view=other`, owner, T)).status === 400 && (await call('GET', `/tenants/${T}/responsibilities?view=me`, owner, `${T}x`)).status === 403, 'an unknown view -> 400; the tenant in the header must be the caller\'s');

  origLog('\n--- The reviewer duty is advisory ---');
  const reviews = await call('GET', '/ssp-metadata/reviews', owner, T, undefined, P1);
  const digestOf = (id: string) => (reviews.body?.sections as Json[]).find((s) => s.sectionId === id)?.currentDigest as string;
  assert((await put([item('ssp_section', 'roles', 'reviewer', user(O_ID))])).status === 200, 'AS10 the owner is named the reviewer of "roles"');
  const reviewerBefore = (await mine(owner)).find((i) => i.targetId === 'roles' && i.duty === 'reviewer');
  assert(reviewerBefore?.reviewed === false && reviewerBefore?.status === null, 'AS10 before any sign-off: reviewed false, no status', reviewerBefore);
  const signA = await call('POST', '/ssp-metadata/reviews', admin, T, { sectionId: 'roles', expectedDigest: digestOf('roles') }, P1);
  assert(signA.status === 201, 'AS10 an admin who is not the reviewer can still sign off (the rule is advisory: 201)', signA.status);
  assert((await mine(owner)).find((i) => i.targetId === 'roles' && i.duty === 'reviewer')?.reviewed === true, 'the section counts as reviewed for the assigned reviewer once anyone signed the current content');
  assert((await put([item('ssp_section', 'roles', 'reviewer', user(S_ID), user(O_ID))])).status === 200, 'a read-only member can be named the reviewer (the label is allowed; it cannot sign)');
  assert((await call('POST', '/ssp-metadata/reviews', assessor, T, { sectionId: 'roles', expectedDigest: digestOf('roles') }, P1)).status === 403, 'AS10 ... and the sign-off route still refuses them (403): nothing changed there');

  origLog('\n--- History and the limit ---');
  const events = ((await call('GET', '/program-inventory/events?limit=200', owner, T, undefined, P1)).body?.events ?? []) as Json[];
  const changes = events.filter((e) => e.action === 'assignment_changed');
  assert(changes.some((e) => e.detail?.to?.id === S_ID && e.detail?.targetId === c && e.detail?.from === null) && changes.some((e) => e.detail?.from?.id === S_ID && e.detail?.to === null), 'AS13 assignment_changed events carry the target, the duty and the from / to ids', changes.slice(0, 3).map((e) => e.detail));
  assert(changes.every((e) => Object.keys(e.detail).sort().join() === 'duty,from,targetId,targetKind,to'), 'and nothing else');
  try {
    __setAssignmentLimitForTests(2);
    const l1 = getFrameworkControls('CMMC_L1').map((x) => x.id);
    const full = await put([item('control', l1[0], 'owner', user(A_ID)), item('control', l1[1], 'owner', user(A_ID))], owner, P3);
    assert(full.status === 200 && full.body?.changed === 2, 'AS11 two assignments fit the lowered limit');
    const over = await put([item('control', l1[2], 'owner', user(A_ID))], owner, P3);
    assert(over.status === 429 && over.body?.code === 'limit', 'AS11 a third -> 429 limit', over.body);
    const replace = await put([item('control', l1[0], 'owner', user(O_ID), user(A_ID))], owner, P3);
    assert(replace.status === 200, 'replacing an assignment is not an addition: allowed at the limit');
  } finally {
    __setAssignmentLimitForTests(null);
  }

  origLog('\n--- Isolation, an archived program, a program delete ---');
  assert((await call('GET', '/assignments', rival, U, undefined, P1)).status === 404, 'AS12 another tenant naming P1 -> 404 (never P1\'s data)');
  assert((await list(owner, P2)).length === 0, 'the assignments of P1 are invisible in P2');
  const P4 = await mkProgram('AS Program 4 (archived)', 'CMMC_L1');
  assert((await put([item('control', getFrameworkControls('CMMC_L1')[0].id, 'owner', user(S_ID))], owner, P4)).status === 200, 'setup: an assignment in P4');
  assert((await call('POST', `/tenants/${T}/programs/${P4}/archive`, owner, T)).status === 200, 'P4 is archived');
  const arch = await put([item('control', getFrameworkControls('CMMC_L1')[1].id, 'owner', user(S_ID))], owner, P4);
  assert(arch.status === 409 && arch.body?.code === 'program_archived' && (await list(owner, P4)).length === 1, 'AS12 an archived program: writes -> 409 program_archived, reads stay possible', arch.body);
  assert((await call('GET', `/tenants/${T}/responsibilities?view=me`, assessor, T)).body?.programs?.every((p: Json) => p.programId !== P4) && (await call('GET', `/tenants/${T}/responsibilities?view=me&includeArchived=true`, assessor, T)).body?.programs?.some((p: Json) => p.programId === P4 && p.archived === true), 'responsibilities leave archived programs out unless includeArchived=true');
  assert(__programAssignmentRowsForTests({ tenantId: T, programId: P3 }) === 2, 'P3 holds 2 rows in the memory store');
  assert((await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T)).status === 204 && __programAssignmentRowsForTests({ tenantId: T, programId: P3 }) === 0, 'AS14 deleting a program leaves nothing of its assignments in the memory store');

  origLog('\n--- Teams ---');
  const TEAM = 'Blue Team MARK';
  const teams = (method: string, sub: string, body?: unknown, token: string | null = owner) => call(method, `/tenants/${T}/teams${sub}`, token, T, body);
  const t1 = await teams('POST', '', { name: TEAM, description: 'Handles MARK things' });
  const team = t1.body?.team as Json;
  assert(t1.status === 201 && team?.name === TEAM && team?.description === 'Handles MARK things' && Array.isArray(team?.memberIds) && team.memberIds.length === 0 && typeof team?.updatedAt === 'string', 'AS15 POST /teams -> 201 with the team and no members', t1.body);
  const t2 = await teams('POST', '', { name: 'blue team mark' });
  assert(t2.status === 409 && t2.body?.code === 'duplicate_name' && !t2.text.includes('MARK') && !t2.text.includes('mark'), 'AS15 the same name ignoring case -> 409 duplicate_name, not echoed', t2.body);
  assert((await teams('POST', '', { name: 'Viewer Team' }, viewer)).status === 403 && (await teams('POST', '', { name: 'Assessor Team' }, assessor)).status === 403 && (await teams('GET', '', undefined, viewer)).status === 200, 'AS15 a viewer and an assessor cannot create a team (403); a viewer can read the list');
  const tBad = [await teams('POST', '', {}), await teams('POST', '', { name: '   ' }), await teams('POST', '', { name: 'x'.repeat(121) }), await teams('POST', '', { name: 'ok', extra: 1 })];
  assert(tBad.every((r) => r.status === 400 && r.body?.code === 'invalid' && typeof r.body?.field === 'string') && tBad[0].body?.field === 'name', 'AS15 an invalid name or a stray field -> 400 invalid with the field', tBad.map((r) => r.body));
  const up = await teams('PUT', `/${team.id}`, { description: 'Updated MARK', expectedUpdatedAt: team.updatedAt });
  assert(up.status === 200 && up.body?.changed === true && up.body?.team?.description === 'Updated MARK' && up.body?.team?.name === TEAM, 'AS15 PUT with the stamp -> 200 changed', up.body);
  const staleUp = await teams('PUT', `/${team.id}`, { description: 'Again', expectedUpdatedAt: team.updatedAt });
  assert(staleUp.status === 409 && staleUp.body?.code === 'stale_write' && typeof staleUp.body?.current?.updatedAt === 'string', 'AS15 the old stamp -> 409 stale_write with the current stamp', staleUp.body);
  assert((await teams('PUT', `/${team.id}`, { description: 'x' })).body?.code === 'invalid_expected_updated_at' && (await teams('PUT', '/nope', { expectedUpdatedAt: team.updatedAt })).status === 404, 'a missing stamp -> 400 invalid_expected_updated_at; an unknown team -> 404');
  const noChange = await teams('PUT', `/${team.id}`, { description: 'Updated MARK', expectedUpdatedAt: up.body?.team?.updatedAt });
  assert(noChange.status === 200 && noChange.body?.changed === false, 'a PUT that changes nothing -> changed false');
  const other = await teams('POST', '', { name: 'Red Team' });
  assert((await teams('PUT', `/${other.body?.team?.id}`, { name: 'BLUE TEAM MARK', expectedUpdatedAt: other.body?.team?.updatedAt })).body?.code === 'duplicate_name', 'renaming onto another team\'s name -> 409 duplicate_name');

  const nm = await teams('PATCH', `/${team.id}/members`, { add: ['u_as_stranger'] });
  assert(nm.status === 400 && nm.body?.code === 'not_a_member' && nm.body?.count === 1 && !nm.text.includes('u_as_stranger'), 'AS16 adding a non-member -> 400 not_a_member { count: 1 }', nm.body);
  const mAdd = await teams('PATCH', `/${team.id}/members`, { add: [S_ID, V_ID] });
  assert(mAdd.status === 200 && mAdd.body?.added === 2 && mAdd.body?.team?.memberIds?.join() === [S_ID, V_ID].sort().join(), 'AS16 adding two members -> 200 added 2', mAdd.body);
  assert((await teams('PATCH', `/${team.id}/members`, { add: [S_ID] })).body?.added === 0 && (await teams('PATCH', `/${team.id}/members`, { remove: ['u_unknown'] })).body?.removed === 0, 'adding a member again and removing a non-member are not changes');
  assert((await teams('PATCH', `/${team.id}/members`, { add: 'x' })).body?.code === 'invalid_member_ids' && (await teams('PATCH', '/nope/members', { add: [S_ID] })).status === 404 && (await teams('PATCH', `/${team.id}/members`, { add: [S_ID] }, viewer)).status === 403, 'a malformed list -> 400 invalid_member_ids; an unknown team -> 404; a viewer -> 403');
  assert((await teams('PATCH', `/${team.id}/members`, { remove: [V_ID] })).body?.team?.memberIds?.join() === S_ID, 'removing a member works');

  const tAssign = await put([item('control', c2, 'owner', { kind: 'team', id: team.id }, user(V_ID))]);
  assert(tAssign.status === 200 && tAssign.body?.assignments?.[0]?.assignee?.kind === 'team' && tAssign.body?.assignments?.[0]?.assigneeState === 'active', 'AS17 a team can be assigned (state active)', tAssign.body);
  const viaTeam = (await mine(assessor)).find((i) => i.targetId === c2);
  assert(viaTeam?.via === 'team' && viaTeam?.teamId === team.id, 'AS17 /mine for a member of the team shows the item via the team', viaTeam);
  assert(!(await mine(viewer)).some((i) => i.targetId === c2), 'a person who is not in the team does not see it');
  const teamView = await call('GET', `/tenants/${T}/responsibilities?view=team&teamId=${team.id}`, viewer, T);
  assert(teamView.status === 200 && teamView.body?.programs?.[0]?.items?.[0]?.targetId === c2 && teamView.body?.programs?.[0]?.items?.[0]?.via === 'team' && (await call('GET', `/tenants/${T}/responsibilities?view=team&teamId=nope`, viewer, T)).status === 404, 'AS17 view=team lists the team\'s assignments for every role; an unknown team -> 404', teamView.body);
  const usage = await teams('GET', `/${team.id}/usage`, undefined, viewer);
  assert(usage.status === 200 && usage.body?.programs?.length === 1 && usage.body.programs[0].programId === P1 && usage.body.programs[0].assignments === 1 && (await teams('GET', '/nope/usage')).status === 404, 'AS18 GET /usage names the program and the count', usage.body);

  const del = await teams('DELETE', `/${team.id}`);
  assert(del.status === 409 && del.body?.code === 'team_in_use' && del.body?.assignments === 1 && (await teams('GET', '')).body?.teams?.some((t: Json) => t.id === team.id), 'AS18 DELETE while an assignment names the team -> 409 team_in_use { assignments: 1 }, the team stays', del.body);
  assert((await teams('DELETE', `/${team.id}?force=true`, undefined, viewer)).status === 403, 'a viewer cannot delete a team (403)');
  const gone = await teams('DELETE', `/${team.id}?force=true`);
  assert(gone.status === 200 && gone.body?.removed === team.id && gone.body?.assignmentsRemoved === 1, 'AS18 DELETE ?force=true -> 200, the assignment is removed with it', gone.body);
  assert(!((await list()) ?? []).some((a) => a.assignee?.kind === 'team') && !(await teams('GET', '')).body?.teams?.some((t: Json) => t.id === team.id) && (await teams('DELETE', `/${team.id}`)).status === 404, 'AS18 P1 has no team rows and the team is gone (a second delete -> 404)');
  const orphan = await put([item('control', c2, 'owner', { kind: 'team', id: team.id })]);
  assert(orphan.status === 404 && orphan.body?.code === 'team_not_found', 'a removed team cannot be assigned (404 team_not_found)');
  const hist = await call('GET', `/tenants/${T}/inventory/events?entityId=${team.id}`, owner, T);
  const teamEvents = (hist.body?.events ?? []) as Json[];
  assert(teamEvents.length >= 5 && teamEvents.every((e) => e.entityKind === 'team') && ['created', 'updated', 'members_changed', 'deleted'].every((a) => teamEvents.some((e) => e.action === a)), 'AS19 the register history has the created, updated, members_changed and deleted events of the team', teamEvents.map((e) => e.action));
  const created = teamEvents.find((e) => e.action === 'created');
  assert(typeof created?.fields?.name?.sha256 === 'string' && typeof created?.fields?.name?.length === 'number' && !JSON.stringify(teamEvents).includes('Blue') && !JSON.stringify(teamEvents).includes('MARK'), 'AS19 name and description are digests ({ sha256, length }); no team text in the history', created?.fields);
  assert(teamEvents.some((e) => e.action === 'members_changed' && String(e.fields?.added).includes(S_ID)), 'member ids are recorded as values');

  origLog('\n--- Source and logs ---');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  const api = read('server', 'routes', 'api.ts');
  const tenants = read('server', 'routes', 'tenants.ts');
  assert(/router\.use\('\/assignments', authMiddleware, programContext, assignmentsRouter\)/.test(api) && tenants.includes("router.use('/:tenantId/teams', tenantTeamsRouter)") && tenants.includes("router.use('/:tenantId/responsibilities', tenantResponsibilitiesRouter)"), 'AS-S1 the routers are mounted (assignments behind authMiddleware and programContext; teams and responsibilities after the write guard of the tenants router)');
  const grantors = ['server/middleware/roleGuard.ts', 'server/middleware/authMiddleware.ts', 'server/routes/sspMetadata.ts', 'server/sspReviews.ts', 'src/utils/roles.ts'].map((f) => read(...f.split('/')));
  assert(grantors.every((src) => !/program_assignments|assignmentsStore|assignmentsService|teamsStore|readAssignments/.test(src)), 'AS-S2 no permission code (the role guards, the sign-off route, the role helpers) reads an assignment or a team: they are labels');
  assert(SSP_SECTIONS.length > SSP_SIGNABLE_SECTION_IDS.length, 'the sections that cannot be signed exist (the reviewer duty refuses them)');
  const lines = ['assignments.ts', 'teams.ts', 'responsibilities.ts'].flatMap((f) => read('server', 'routes', f).split('\n').filter((l) => /console\.\w+\(/.test(l)));
  assert(lines.length > 0 && !lines.some((l) => /\.name|description|team\.name|body/.test(l)), 'AS-S3 no console line of the three routers mentions a name, a description or the body', lines);
  assert(captured.length > 0 && !captured.some((l) => l.includes('MARK') || l.includes('Blue Team')), 'AS21 no line the server logged contains a team name, a description or MARK', captured.filter((l) => l.includes('MARK') || l.includes('Blue Team')));
}

async function run() {
  await apiTests();

  origLog('\n================================================================');
  origLog(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  origLog('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  origError('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
