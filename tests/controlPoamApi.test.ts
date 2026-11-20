import './testEnv';
import { server } from '../server/index';
import { firstProgram } from './programFixture';
import { readControlPoam, listControlPoamEvents } from '../server/controlPoam';

/**
 * Control POA&M fields over HTTP (#304): GET/PATCH /api/v1/control-poam and GET /api/v1/control-poam/:controlId/events. One row per control and
 * program (x-program-id), written by TENANT_OWNER / ADMIN / MSP_ADMIN, read by every role. Covers the stale-write rule (expectedUpdatedAt required,
 * null = no row yet, 409 stale_write with only the stamp), the field validation (a 400 names the field, never the value), program isolation and the
 * archive rule, the cascade of a program delete, the first-writer race, the milestone list (server ids, unknown id refused, replace as a whole),
 * the digest-only history event (flags, counts and the control's status), and that no console line carries any text.
 * Runs against the in-memory store. Boots the server on port 8080: run it alone.
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

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, program?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (program) headers['x-program-id'] = program;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

const OWNER_MARK = 'OWNER-MARK-304';
const PLAN_MARK = 'PLAN-MARK-304';
const RES_MARK = 'RES-MARK-304';
const MS_MARK = 'MILESTONE-MARK-304';
const CTRL = 'AC.L1-3.1.1';

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_cp_owner');
  const rival = person('u_cp_rival');
  const viewer = person('u_cp_viewer');
  const assessor = person('u_cp_assessor');

  // every console line written while the suite runs is kept, to prove none carries the text
  const captured: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const capture = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
  console.log = capture(origLog);
  console.error = capture(origError);

  console.log('--- Setup: a tenant with a viewer and an assessor, more programs; a rival tenant ---');
  const mk = async (token: string, name: string, frameworks: string[]) =>
    (await call('POST', '/tenants', token, undefined, { name, primaryFramework: frameworks[0], enabledFrameworks: frameworks })).body?.tenant?.id as string;
  const T = await mk(owner, 'Control Poam T', ['CMMC_L1', 'CMMC_L2']);
  const R = await mk(rival, 'Control Poam R', ['CMMC_L1']);
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_cp_viewer', email: 'u_cp_viewer@test.mil', role: 'VIEWER' });
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_cp_assessor', email: 'u_cp_assessor@test.mil', role: 'ASSESSOR' });
  const DEF = (await firstProgram(T)).id;
  const newProgram = async (name: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId: 'CMMC_L1' })).body?.program?.id as string;
  const P2 = await newProgram('Poam second');
  const P3 = await newProgram('Poam third');
  const P4 = await newProgram('Poam fourth');
  await firstProgram(R);
  assert(Boolean(T && R && DEF && P2 && P3 && P4), 'setup: tenants and programs exist', { T, R, DEF, P2, P3, P4 });

  const patch = (body: Json, control = CTRL, program?: string, who = owner) => call('PATCH', `/control-poam/${encodeURIComponent(control)}`, who, T, body, program);

  const cp1 = await call('GET', '/control-poam', owner, T);
  assert(cp1.status === 200 && Array.isArray(cp1.body?.entries) && cp1.body.entries.length === 0, 'CP1 a fresh program -> 200, entries []', cp1.body);

  // the control's status is recorded on the event: NOT_MET here
  await call('PUT', `/controls/${CTRL}`, owner, T, { status: 'NOT_MET', implementationNotes: 'notes' });

  const cp2 = await patch({ expectedUpdatedAt: null, owner: OWNER_MARK, scheduledCompletion: '2027-01-15' });
  const e2 = cp2.body?.entry as Json | undefined;
  assert(
    cp2.status === 200 && cp2.body?.changed === true && e2?.controlId === CTRL && e2.owner === OWNER_MARK && e2.scheduledCompletion === '2027-01-15' &&
      e2.requiredResources === '' && e2.plan === '' && Array.isArray(e2.milestones) && e2.milestones.length === 0 && typeof e2.updatedAt === 'string' && e2.updatedBy === 'u_cp_owner',
    'CP2 first PATCH with expectedUpdatedAt null -> 200, changed true, the entry with its stamp and writer',
    cp2.body
  );
  const stamp1 = e2?.updatedAt as string;

  const cp3 = await call('GET', '/control-poam', owner, T);
  assert(cp3.status === 200 && cp3.body?.entries.length === 1 && cp3.body.entries[0].updatedAt === stamp1, 'CP3 GET lists the stored entry', cp3.body);

  const cp4 = await patch({ expectedUpdatedAt: stamp1, owner: OWNER_MARK, scheduledCompletion: '2027-01-15' });
  const ev4 = await call('GET', `/control-poam/${CTRL}/events`, owner, T);
  assert(cp4.status === 200 && cp4.body?.changed === false && cp4.body.entry?.updatedAt === stamp1 && ev4.body?.events.length === 1, 'CP4 the same body with the current stamp -> changed false, the stamp stays, still one event', [cp4.body, ev4.body]);

  const cp5 = await patch({ expectedUpdatedAt: null, owner: 'other' });
  assert(cp5.status === 409 && cp5.body?.code === 'stale_write' && cp5.body.current?.updatedAt === stamp1 && !JSON.stringify(cp5.body).includes(OWNER_MARK), 'CP5 a second first-write (null) -> 409 stale_write with the current stamp and no text', cp5.body);

  const cp6 = await patch({ expectedUpdatedAt: stamp1, requiredResources: RES_MARK, plan: PLAN_MARK });
  const stamp2 = cp6.body?.entry?.updatedAt as string;
  assert(cp6.status === 200 && cp6.body?.changed === true && Date.parse(stamp2) > Date.parse(stamp1) && cp6.body.entry.owner === OWNER_MARK && cp6.body.entry.plan === PLAN_MARK, 'CP6 a patch keeps the fields it leaves out and bumps the stamp', cp6.body);

  const cp7 = await patch({ expectedUpdatedAt: stamp1, plan: 'older' });
  assert(cp7.status === 409 && cp7.body?.code === 'stale_write' && cp7.body.current?.updatedAt === stamp2, 'CP7 an old stamp -> 409 stale_write', cp7.body);

  const roles = [
    (await call('GET', '/control-poam', viewer, T)).status,
    (await patch({ expectedUpdatedAt: stamp2, plan: 'v' }, CTRL, undefined, viewer)).status,
    (await patch({ expectedUpdatedAt: stamp2, plan: 'a' }, CTRL, undefined, assessor)).status,
    (await call('GET', '/control-poam', assessor, T)).status,
    (await call('GET', `/control-poam/${CTRL}/events`, viewer, T)).status,
  ];
  assert(JSON.stringify(roles) === JSON.stringify([200, 403, 403, 200, 200]), 'CP8 every role reads (200); a viewer and an assessor cannot write (403)', roles);

  const other = await call('GET', '/control-poam', owner, T, undefined, P2);
  const otherPut = await patch({ expectedUpdatedAt: null, owner: 'P2-OWNER' }, CTRL, P2);
  const defAfter = await call('GET', '/control-poam', owner, T);
  assert(other.status === 200 && other.body?.entries.length === 0 && otherPut.status === 200 && defAfter.body?.entries[0].updatedAt === stamp2, 'CP9 a write in program A is invisible to program B, and writing to B leaves A alone', [other.body, otherPut.status, defAfter.body]);

  const foreign = await call('GET', '/control-poam', rival, R, undefined, DEF);
  assert(foreign.status === 404 && foreign.body?.code === 'program_not_found', "CP10 another tenant's program id -> 404 program_not_found", [foreign.status, foreign.body]);

  console.log('--- Validation: a 400 names the field, never the value ---');
  const field = (r: { status: number; body: Json | null }) => (r.status === 400 && r.body?.code === 'invalid_control_poam_patch' ? (r.body.field as string) : `${r.status}`);
  const bads: Array<[Json, string]> = [
    [{ expectedUpdatedAt: stamp2, scheduledCompletion: '2027-02-30' }, 'scheduledCompletion'],
    [{ expectedUpdatedAt: stamp2, plan: 'P'.repeat(4001) }, 'plan'],
    [{ expectedUpdatedAt: stamp2, requiredResources: 'R'.repeat(2001) }, 'requiredResources'],
    [{ expectedUpdatedAt: stamp2, owner: 'O'.repeat(256) }, 'owner'],
    [{ expectedUpdatedAt: stamp2, status: 'MET' }, 'status'],
    [{ plan: 'x' }, 'expectedUpdatedAt'],
    [{ expectedUpdatedAt: stamp2 }, 'body'],
    [{ expectedUpdatedAt: stamp2, milestones: 'nope' }, 'milestones'],
  ];
  for (const [body, want] of bads) {
    const r = await patch(body);
    assert(field(r) === want && !JSON.stringify(r.body).includes('PPPP'), `CP11 ${JSON.stringify(Object.keys(body))} -> 400 naming ${want}`, r.body);
  }
  const okMax = await patch({ expectedUpdatedAt: stamp2, plan: 'P'.repeat(4000) });
  const stamp3 = okMax.body?.entry?.updatedAt as string;
  assert(okMax.status === 200 && okMax.body?.changed === true, 'CP12 exactly 4000 plan characters -> 200', okMax.body);
  const bad404 = await patch({ expectedUpdatedAt: null, owner: 'x' }, 'a b');
  const bad404Events = await call('GET', `/control-poam/${encodeURIComponent('a b')}/events`, owner, T);
  assert(bad404.status === 404 && bad404Events.status === 404, 'CP13 a malformed control id -> 404 on both routes', [bad404.status, bad404Events.status]);
  const nist = await patch({ expectedUpdatedAt: null, owner: 'x' }, 'AC-2(1)', undefined, owner);
  assert(nist.status === 200 || nist.status === 403, 'CP13b a NIST id with parentheses passes the id pattern (200, or 403 when its framework is not enabled)', nist.status);

  console.log('--- Clearing, the not-stored case ---');
  const clearRes = await patch({ expectedUpdatedAt: stamp3, plan: '', requiredResources: '' });
  const stamp4 = clearRes.body?.entry?.updatedAt as string;
  assert(clearRes.status === 200 && clearRes.body?.changed === true && clearRes.body.entry.plan === '' && clearRes.body.entry.requiredResources === '' && clearRes.body.entry.owner === OWNER_MARK, 'CP14 an empty text clears it; the other fields stay', clearRes.body);
  const clearDate = await patch({ expectedUpdatedAt: stamp4, scheduledCompletion: null });
  assert(clearDate.status === 200 && clearDate.body?.entry.scheduledCompletion === null, 'CP15 a null date clears the date', clearDate.body);
  const stamp5 = clearDate.body?.entry?.updatedAt as string;
  const noRow = await patch({ expectedUpdatedAt: null, owner: '' }, 'SC.L1-3.13.1');
  assert(noRow.status === 200 && noRow.body?.changed === false && noRow.body.entry === null, 'CP16 a first write that stores nothing -> 200, changed false, entry null (no row created)', noRow.body);

  console.log('--- Milestones ---');
  const m1 = await patch({ expectedUpdatedAt: stamp5, milestones: [{ description: MS_MARK + ' one', targetDate: '2027-01-01' }, { description: MS_MARK + ' two', targetDate: '2027-02-01', completed: true }] });
  const ms1 = (m1.body?.entry?.milestones ?? []) as Json[];
  assert(
    m1.status === 200 && ms1.length === 2 && ms1.every((m) => /^ms-[0-9a-f]{12}$/.test(m.id)) && ms1[0].completed === false && ms1[1].completed === true && ms1[0].id !== ms1[1].id,
    'CP17 new milestones get server ids and keep their order and completed flag',
    m1.body
  );
  const stamp6 = m1.body?.entry?.updatedAt as string;
  const m2 = await patch({ expectedUpdatedAt: stamp6, milestones: [{ id: ms1[0].id, description: MS_MARK + ' one', targetDate: '2027-01-01', completed: true }] });
  const ms2 = (m2.body?.entry?.milestones ?? []) as Json[];
  assert(m2.status === 200 && ms2.length === 1 && ms2[0].id === ms1[0].id && ms2[0].completed === true, 'CP18 an edit replaces the whole list: a kept id stays, the omitted milestone is gone', m2.body);
  const stamp7 = m2.body?.entry?.updatedAt as string;
  const m3 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ id: 'ms-000000000000', description: 'x', targetDate: '2027-01-01' }] });
  assert(field(m3) === 'milestones' && !JSON.stringify(m3.body).includes(MS_MARK), 'CP19 an id the entry does not hold -> 400 naming milestones', m3.body);
  const m4 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ id: ms1[1].id, description: 'x', targetDate: '2027-01-01' }] });
  assert(field(m4) === 'milestones', 'CP19b an id that was removed earlier is unknown now -> 400', m4.body);
  const many = Array.from({ length: 21 }, (_, i) => ({ description: `m${i}`, targetDate: '2027-01-01' }));
  const m5 = await patch({ expectedUpdatedAt: stamp7, milestones: many });
  const m6 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ description: 'two\nlines', targetDate: '2027-01-01' }] });
  const m7 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ description: 'x', targetDate: '2027-13-01' }] });
  const m8 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ description: 'x'.repeat(501), targetDate: '2027-01-01' }] });
  assert([m5, m6, m7, m8].every((r) => field(r) === 'milestones'), 'CP20 21 milestones, a multi-line description, a bad date and 501 characters are each refused (400 milestones)', [m5, m6, m7, m8].map(field));
  const m9 = await patch({ expectedUpdatedAt: stamp7, milestones: [{ id: ms1[0].id, description: MS_MARK + ' one', targetDate: '2027-01-01', completed: true }] });
  assert(m9.status === 200 && m9.body?.changed === false, 'CP21 the same list again -> changed false', m9.body);
  const m10 = await patch({ expectedUpdatedAt: stamp7, milestones: [] });
  assert(m10.status === 200 && m10.body?.changed === true && m10.body.entry.milestones.length === 0, 'CP22 an empty list clears the milestones', m10.body);

  console.log('--- History: flags, counts, the control status; never text ---');
  const events = ((await call('GET', `/control-poam/${CTRL}/events`, owner, T)).body?.events ?? []) as Json[];
  const first = events[events.length - 1];
  assert(
    events.length >= 8 && events.every((e) => e.controlId === CTRL && e.actor === 'u_cp_owner') && first.ownerChanged === true && first.newScheduledCompletion === '2027-01-15' &&
      first.oldScheduledCompletion === null && first.controlStatus === 'NOT_MET' && first.planChanged === false && first.milestonesChanged === false,
    'CP23 the first event: owner changed, the date, the control status NOT_MET, nothing else',
    first
  );
  const msEvent = events.find((e) => e.milestonesChanged === true && e.milestoneCount === 2);
  assert(Boolean(msEvent) && msEvent?.milestonesCompleted === 1 && msEvent.ownerChanged === false, 'CP24 a milestone event carries the count and the completed count', msEvent);
  const text = JSON.stringify(events);
  assert(!text.includes(OWNER_MARK) && !text.includes(PLAN_MARK) && !text.includes(RES_MARK) && !text.includes(MS_MARK) && !/sha256|userId|actorUserId/i.test(text), 'CP25 no event carries any text, digest or user id', text.slice(0, 200));
  const stored = await listControlPoamEvents({ tenantId: T, programId: DEF }, CTRL, 5);
  assert(stored.length === 5, 'CP25b the history is limited to the requested count (newest first)', stored.length);

  console.log('--- Program rules ---');
  const archive = await call('POST', `/tenants/${T}/programs/${P2}/archive`, owner, T);
  const archW = await patch({ expectedUpdatedAt: otherPut.body?.entry?.updatedAt, plan: 'ARCH' }, CTRL, P2);
  const archR = await call('GET', '/control-poam', owner, T, undefined, P2);
  assert(archive.status === 200 && archW.status === 409 && archW.body?.code === 'program_archived' && archR.status === 200 && archR.body?.entries.length === 1, 'CP26 an archived program: PATCH 409 program_archived, GET 200', [archW.status, archW.body, archR.status]);

  const delPut = await patch({ expectedUpdatedAt: null, owner: 'P3-OWNER' }, CTRL, P3);
  const delBefore = await readControlPoam({ tenantId: T, programId: P3 });
  const del = await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T);
  const delAfter = await readControlPoam({ tenantId: T, programId: P3 });
  assert(delPut.status === 200 && delBefore.length === 1 && del.status === 204 && delAfter.length === 0, 'CP27 deleting a program removes its entries', [delPut.status, del.status, delAfter.length]);

  const race = await Promise.all([patch({ expectedUpdatedAt: null, owner: 'RACE-1' }, CTRL, P4), patch({ expectedUpdatedAt: null, owner: 'RACE-2' }, CTRL, P4)]);
  const statuses = race.map((r) => r.status).sort();
  assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'CP28 two concurrent first writes: exactly one 200 and one 409', statuses);

  console.log('--- Framework policy ---');
  const notEnabled = await call('PATCH', `/control-poam/${encodeURIComponent('AC-2')}`, rival, R, { expectedUpdatedAt: null, owner: 'x' });
  assert(notEnabled.status === 403 && notEnabled.body?.code === 'framework_not_enabled', 'CP29 a control of a framework the tenant has not enabled -> 403 framework_not_enabled', [notEnabled.status, notEnabled.body]);

  console.log = origLog;
  console.error = origError;
  const marks = [OWNER_MARK, PLAN_MARK, RES_MARK, MS_MARK, 'P2-OWNER', 'P3-OWNER', 'RACE-1', 'RACE-2'];
  assert(captured.length > 0 && !captured.some((l) => marks.some((m) => l.includes(m))), 'CP30 no console line written during the suite contains any text', captured.filter((l) => marks.some((m) => l.includes(m))));

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
