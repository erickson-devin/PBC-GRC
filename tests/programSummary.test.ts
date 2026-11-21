import './testEnv';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { SSP_SIGNABLE_SECTION_IDS } from '../src/data/ssp/sspSections';
import { insertPoamItems, loadSnapshotFindings, updateVmPoamItem } from '../server/vm/findingsStore';

/**
 * The program summary (issues #251, #252) over HTTP: GET /api/v1/program-summary (people, inventory and document inputs, sign-off counts and the POA&M target
 * summary, counts and dates only) and the SPRS goal of a CMMC Level 2 program (PUT /tenants/:tenantId/programs/:id { sprsGoal }, its range, its history in the
 * program inventory events, the roles and an archived program). Runs against the in-memory store; the SQL is checked structurally in tests/dbSchema.test.ts
 * and, against a live database, by `npm run db:verify-rls`. Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';

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
  return { status: res.status, body: json, text, headers: res.headers };
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_ps_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const owner = person('u_ps_owner');
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Program Summary Org', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II'] })).body?.tenant?.id as string;
  const viewer = withRole('u_ps_viewer', T, 'VIEWER');
  const mkProgram = async (name: string, frameworkId: string, baseline?: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId, ...(baseline ? { baseline } : {}) })).body?.program?.id as string;
  const P1 = await mkProgram('PS Program 1', 'CMMC_L2');
  const P2 = await mkProgram('PS Program 2', 'NIST_800_53_REV5', 'LOW');
  const P3 = await mkProgram('PS Program 3', 'SOC_2_TYPE_II');
  assert(Boolean(T) && Boolean(P1) && Boolean(P2) && Boolean(P3), 'setup: tenant T with P1 (CMMC_L2), P2 (NIST 800-53 LOW) and P3 (SOC 2)', [T, P1, P2, P3]);

  const summary = (program: string, token: string | null = owner) => call('GET', '/program-summary', token, T, undefined, program);
  const N = getFrameworkControls('CMMC_L2').length;
  const controls = getFrameworkControls('CMMC_L2');
  const c0 = controls[0].id;
  const c1 = controls[1].id;

  origLog('\n--- The summary of a fresh program ---');
  const s1 = await summary(P1);
  assert(
    s1.status === 200 && s1.body?.programId === P1 && typeof s1.body?.generatedAt === 'string' && s1.body?.people?.ownerLevelMembers === 1 && s1.body?.people?.primaryContactSet === false,
    'PS1 GET -> 200 with the program id, one owner-level member and no primary contact',
    s1.body?.people
  );
  assert(
    s1.body?.reviews?.total === SSP_SIGNABLE_SECTION_IDS.length && s1.body?.reviews?.reviewed === 0 &&
      JSON.stringify(s1.body?.poam) === JSON.stringify({ openCount: N, datedCount: 0, undatedCount: N, latestDate: null, latestSource: null, overdueCount: 0 }),
    'PS1 sign-offs 0 of the signable sections; every control is an open, undated POA&M entry',
    [s1.body?.reviews, s1.body?.poam]
  );
  assert(s1.body?.inventory?.supported === true && s1.body?.inventory?.tools.length === 0 && s1.body?.inventory?.handlesFci === null && s1.body?.inventory?.categories.length === 0, 'PS1b the register input: supported, no tools, FCI not answered, no categories', s1.body?.inventory);
  const docs1 = s1.body?.documents;
  assert(docs1?.supported === true && docs1?.approvedCount === 0 && docs1?.expected?.present === 0 && docs1?.expected?.total > 0 && typeof docs1?.recommendedTotal === 'number', 'PS1c the document input of a CMMC L2 program: nothing approved, expected documents listed and none present', docs1);
  assert((await summary(P3)).body?.documents === null && (await summary(P2)).body?.documents?.expected?.total > 0, 'PS1d a framework with no expected-document catalog (SOC 2) has documents null; NIST SP 800-53 has one');
  assert((s1.headers.get('cache-control') ?? '').includes('no-store'), 'PS1e Cache-Control: no-store');

  origLog('\n--- The POA&M target date ---');
  const patch = (control: string, body: Json) => call('PATCH', `/control-poam/${encodeURIComponent(control)}`, owner, T, body, P1);
  assert((await patch(c0, { expectedUpdatedAt: null, scheduledCompletion: '2027-03-31' })).status === 200 && (await patch(c1, { expectedUpdatedAt: null, scheduledCompletion: '2027-06-30' })).status === 200, 'two control entries get dates');
  const s2 = await summary(P1);
  assert(s2.body?.poam?.latestDate === '2027-06-30' && s2.body?.poam?.datedCount === 2 && s2.body?.poam?.latestSource === 'control' && s2.body?.poam?.openCount === N && s2.body?.poam?.undatedCount === N - 2, 'PS2 the latest date of the open entries (2027-06-30, from a control entry), 2 dated', s2.body?.poam);
  const draft = {
    findingId: 'fnd_ps_open',
    findingFirstSeenAt: '2026-01-01T00:00:00.000Z',
    controlId: 'RA.L2-3.11.3' as const,
    weakness: 'MARK weakness',
    mitigation: '' as const,
    owner: '' as const,
    scheduledCompletion: null,
    status: 'OPEN' as const,
    createdBy: 'system:vm-worker' as const,
  };
  await insertPoamItems(T, [draft, { ...draft, findingId: 'fnd_ps_done' }], null, P1);
  const items = (await loadSnapshotFindings(T, P1)).poam;
  const open = items.find((i) => i.findingId === 'fnd_ps_open')!;
  const done = items.find((i) => i.findingId === 'fnd_ps_done')!;
  const who = { actor: 'test', userId: null };
  await updateVmPoamItem({ tenantId: T, programId: P1 }, open.id, { scheduledCompletion: '2027-09-30' }, open.updatedAt, who);
  const doneEdit = await updateVmPoamItem({ tenantId: T, programId: P1 }, done.id, { scheduledCompletion: '2029-01-01', status: 'COMPLETED', mitigation: 'done' }, done.updatedAt, who);
  assert(Boolean(doneEdit?.changed), 'setup: a vulnerability item dated 2027-09-30 and a completed one dated 2029-01-01', doneEdit);
  const s3 = await summary(P1);
  assert(s3.body?.poam?.latestDate === '2027-09-30' && s3.body?.poam?.latestSource === 'vulnerability' && s3.body?.poam?.openCount === N + 1 && s3.body?.poam?.datedCount === 3, 'PS3 an open vulnerability item counts (its date wins, source vulnerability); a completed one does not', s3.body?.poam);
  assert((await summary(P2)).body?.poam?.openCount === getFrameworkControls('NIST_800_53_REV5', 'LOW').length, 'PS3b another program sees none of it (the NIST LOW catalog, all open)');
  // a CMMC control is Met only when its objectives are (the status guard), so the Met case runs in the NIST SP 800-53 program
  const nist = getFrameworkControls('NIST_800_53_REV5', 'LOW');
  const patch2 = (control: string, body: Json) => call('PATCH', `/control-poam/${encodeURIComponent(control)}`, owner, T, body, P2);
  assert((await patch2(nist[0].id, { expectedUpdatedAt: null, scheduledCompletion: '2027-03-31' })).status === 200 && (await patch2(nist[1].id, { expectedUpdatedAt: null, scheduledCompletion: '2027-06-30' })).status === 200, 'two NIST control entries get dates');
  assert((await summary(P2)).body?.poam?.latestDate === '2027-06-30', 'PS2 the latest date of the open entries in P2 is 2027-06-30');
  assert((await call('PUT', `/controls/${nist[1].id}`, owner, T, { status: 'MET', implementationNotes: 'MARK secret note' }, P2)).status === 200, 'the second NIST control is recorded as Met');
  const s2b = await summary(P2);
  assert(s2b.body?.poam?.latestDate === '2027-03-31' && s2b.body?.poam?.datedCount === 1 && s2b.body?.poam?.openCount === nist.length - 1, 'PS2 a Met control leaves the open entries: the latest date falls back to 2027-03-31', s2b.body?.poam);

  origLog('\n--- Roles, people and text ---');
  const sv = await summary(P1, viewer);
  assert(sv.status === 200 && !sv.text.includes('MARK'), 'PS4 a viewer can read the summary (200) and the body holds no note or weakness text', sv.status);
  assert((await call('POST', '/program-summary', owner, T, {}, P1)).status === 404, 'PS4b the route serves GET only');
  assert((await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ps_owner2', email: 'u_ps_owner2@test.mil', name: 'u_ps_owner2', role: 'TENANT_OWNER' })).status === 201 &&
    (await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_ps_assessor', email: 'u_ps_assessor@test.mil', name: 'u_ps_assessor', role: 'ASSESSOR' })).status === 201, 'setup: a second owner and an assessor are added');
  assert((await summary(P1)).body?.people?.ownerLevelMembers === 2, 'PS4c the owner-level count follows the members (2 owners, the assessor is not counted)');
  const pc = await call('PATCH', `/tenants/${T}/members/u_ps_assessor`, owner, T, { primaryContact: true });
  assert(pc.status === 200 && (await summary(P1)).body?.people?.primaryContactSet === true, 'PS4d a primary contact makes primaryContactSet true', pc.body);

  origLog('\n--- The SPRS goal ---');
  const put = (program: string, body: Json, token: string | null = owner) => call('PUT', `/tenants/${T}/programs/${program}`, token, T, body);
  const g1 = await put(P1, { sprsGoal: 88 });
  assert(g1.status === 200 && g1.body?.program?.sprsGoal === 88, 'PS5 an owner sets the goal -> 200 with program.sprsGoal 88', g1.body?.program?.sprsGoal);
  assert((await call('GET', `/tenants/${T}/programs`, owner, T)).body?.programs?.find((p: Json) => p.id === P1)?.sprsGoal === 88, 'the program list carries it');
  const bad = [await put(P1, { sprsGoal: 111 }), await put(P1, { sprsGoal: -204 }), await put(P1, { sprsGoal: 1.5 }), await put(P1, { sprsGoal: '88' })];
  assert(bad.every((r) => r.status === 400 && r.body?.code === 'invalid_sprs_goal'), 'PS5 111, -204, 1.5 and "88" -> 400 invalid_sprs_goal', bad.map((r) => [r.status, r.body?.code]));
  const other = await put(P2, { sprsGoal: 88 });
  assert(other.status === 400 && other.body?.code === 'invalid_sprs_goal' && (await put(P2, { sprsGoal: null })).status === 200, 'PS5 a goal on a program that is not CMMC Level 2 -> 400 invalid_sprs_goal (null is accepted: no goal)', other.body);
  assert((await put(P1, { sprsGoal: -203 })).body?.program?.sprsGoal === -203 && (await put(P1, { sprsGoal: 110 })).body?.program?.sprsGoal === 110, 'PS5b both ends of the range are accepted');
  assert((await put(P1, { name: 'PS Program 1 renamed' })).body?.program?.sprsGoal === 110, 'PS5c a request without sprsGoal leaves it unchanged');
  assert((await put(P1, { sprsGoal: 70 }, viewer)).status === 403, 'PS5 a viewer cannot set it (403)');
  assert((await put(P1, { sprsGoal: 88 })).status === 200 && (await put(P1, { sprsGoal: 88 })).status === 200, 'setting the same value again is accepted');
  const cleared = await put(P1, { sprsGoal: null });
  assert(cleared.status === 200 && cleared.body?.program?.sprsGoal === null, 'PS5 null clears it (the default shows)', cleared.body?.program?.sprsGoal);
  const events = ((await call('GET', '/program-inventory/events?limit=200', owner, T, undefined, P1)).body?.events ?? []) as Json[];
  const goalEvents = events.filter((e) => e.action === 'sprs_goal_changed');
  assert(
    goalEvents.some((e) => e.detail?.old === null && e.detail?.new === 88) && goalEvents.some((e) => e.detail?.old === 88 && e.detail?.new === null),
    'PS5 the history (program inventory events) records sprs_goal_changed with the old and the new value',
    goalEvents.map((e) => e.detail)
  );
  assert(goalEvents.length === 5 && goalEvents.every((e) => Object.keys(e.detail).sort().join() === 'new,old'), 'only real changes are recorded (5 changes), each holding only the two numbers', goalEvents.length);

  origLog('\n--- An archived program ---');
  assert((await call('POST', `/tenants/${T}/programs/${P1}/archive`, owner, T)).status === 200, 'P1 is archived');
  const arch = await summary(P1);
  const archPut = await put(P1, { sprsGoal: 70 });
  assert(arch.status === 200 && archPut.status === 409 && archPut.body?.code === 'program_archived', 'PS6 an archived program: the summary is 200, setting the goal -> 409 program_archived', [arch.status, archPut.status, archPut.body?.code]);

  origLog('\n--- Source and logs ---');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  const api = read('server', 'routes', 'api.ts');
  assert(/router\.use\('\/program-summary', authMiddleware, programContext, programSummaryRouter\)/.test(api), 'PS-S1 the route is mounted behind authMiddleware and programContext, with no write guard (every role reads)');
  assert(!read('server', 'routes', 'programSummary.ts').includes('requireWriteRole') && !/console\.\w+\([^)]*(notes|weakness|name)/.test(read('server', 'routes', 'programSummary.ts')), 'PS-S2 the route logs no text');
  assert(captured.length > 0 && !captured.some((l) => l.includes('MARK')), 'PS7 no line the server logged contains a note or a weakness (MARK)', captured.filter((l) => l.includes('MARK')));
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
