import './testEnv';
import { server } from '../server/index';

/**
 * Per-user default programs over HTTP: GET / PUT /api/v1/me/default-program (every role, including a VIEWER), the isMyDefault flag of the
 * program list, 404 for an unknown or another tenant's program, 409 for an archived one, clearing with null, and the program's delete
 * removing the preference. Runs against the in-memory store. Boots the server on port 8080: run it alone.
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

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_udp_owner@test.mil';
  const owner = person('u_udp_owner');
  const viewer = person('u_udp_viewer');

  console.log('--- Setup: a tenant with two programs, a VIEWER, and a second tenant ---');
  const mk = async (name: string) =>
    (await call('POST', '/tenants', owner, undefined, { name, primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2'] })).body?.tenant?.id as string;
  const T = await mk('Defaults T');
  const T2 = await mk('Defaults T2');
  await call('POST', `/tenants/${T}/members`, owner, T, { userId: 'u_udp_viewer', email: 'u_udp_viewer@test.mil', role: 'VIEWER' });
  const mkProgram = async (tenant: string, name: string) => (await call('POST', `/tenants/${tenant}/programs`, owner, tenant, { name, frameworkId: 'CMMC_L2' })).body?.program?.id as string;
  const P1 = await mkProgram(T, 'Org Default');
  const P2 = await mkProgram(T, 'Second');
  const P3 = await mkProgram(T, 'Third (deleted later)');
  const OTHER = await mkProgram(T2, 'Other Tenant Program');
  assert([P1, P2, P3, OTHER].every(Boolean), 'setup: three programs in T, one in T2', [P1, P2, P3, OTHER]);
  const mine = (who: string, tenant: string) => call('GET', '/me/default-program', who, tenant);
  const listIn = async (who: string) => ((await call('GET', `/tenants/${T}/programs`, who, T)).body?.programs ?? []) as Json[];

  console.log('\n--- no personal default: the organization default ---');
  const before = await mine(viewer, T);
  assert(before.status === 200 && before.body?.programId === null && before.body?.landingProgramId === P1, '1 GET /me/default-program: no pick, the landing program is the organization default', before.body);

  console.log('\n--- a VIEWER sets a personal default ---');
  const set = await call('PUT', '/me/default-program', viewer, T, { programId: P2 });
  assert(set.status === 200 && set.body?.programId === P2 && set.body?.landingProgramId === P2, '2 a VIEWER PUT { programId } -> 200 (it is a preference, not a data change)', set);
  const viewerList = await listIn(viewer);
  const ownerList = await listIn(owner);
  assert(viewerList.find((p) => p.id === P2)?.isMyDefault === true && viewerList.filter((p) => p.isMyDefault).length === 1, '3 the VIEWER sees isMyDefault true on exactly that program', viewerList.map((p) => p.isMyDefault));
  assert(ownerList.every((p) => p.isMyDefault === false), "3 the owner's list has no isMyDefault (it is per user)", ownerList.map((p) => p.isMyDefault));
  assert((await mine(owner, T)).body?.programId === null && (await mine(owner, T)).body?.landingProgramId === P1, "3 and the owner's landing program is unchanged");
  assert(viewerList.find((p) => p.isDefault)?.id === P1, '3 the organization default did not move');

  console.log('\n--- errors ---');
  const unknown = await call('PUT', '/me/default-program', viewer, T, { programId: 'no-such-program' });
  assert(unknown.status === 404 && unknown.body?.code === 'program_not_found', '4 an unknown program -> 404 program_not_found', unknown.body);
  const foreign = await call('PUT', '/me/default-program', viewer, T, { programId: OTHER });
  assert(foreign.status === 404 && foreign.body?.code === 'program_not_found', "5 another tenant's program -> 404 program_not_found", foreign.body);
  assert((await mine(viewer, T)).body?.programId === P2, '5 and the earlier pick is unchanged');
  const badBody = await call('PUT', '/me/default-program', viewer, T, { programId: 5 });
  assert(badBody.status === 400, '6 a programId that is neither a string nor null -> 400', badBody.body);
  const noAuth = await call('PUT', '/me/default-program', null, T, { programId: P1 });
  assert(noAuth.status === 401, '6 no sign-in -> 401', noAuth.status);

  console.log('\n--- archived, null, delete ---');
  await call('POST', `/tenants/${T}/programs/${P2}/archive`, owner, T);
  const fallback = await mine(viewer, T);
  assert(fallback.body?.landingProgramId === P1, '7 an archived personal default falls back to the organization default for landing', fallback.body);
  const pickArchived = await call('PUT', '/me/default-program', viewer, T, { programId: P2 });
  assert(pickArchived.status === 409 && pickArchived.body?.code === 'program_archived', '8 picking an archived program -> 409 program_archived', pickArchived.body);
  const cleared = await call('PUT', '/me/default-program', viewer, T, { programId: null });
  assert(cleared.status === 200 && cleared.body?.programId === null && (await mine(viewer, T)).body?.programId === null, '9 null clears the personal default');
  await call('PUT', '/me/default-program', viewer, T, { programId: P3 });
  const delP3 = await call('DELETE', `/tenants/${T}/programs/${P3}`, owner, T);
  const afterDelete = await mine(viewer, T);
  assert(delP3.status === 204 && afterDelete.body?.programId === null && afterDelete.body?.landingProgramId === P1, '10 deleting the program clears the personal default pointing at it', [delP3.status, afterDelete.body]);

  console.log('\n--- a non-member ---');
  const stranger = person('u_udp_stranger');
  const strangerCall = await call('PUT', '/me/default-program', stranger, T, { programId: P1 });
  assert(strangerCall.status === 403, '11 a user who is not a member of the tenant is refused (403)', strangerCall.status);

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
