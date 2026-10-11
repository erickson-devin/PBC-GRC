import './testEnv';
import { server } from '../server/index';

/**
 * tenant_users writer: POST /api/v1/tenants/:tenantId/members inserts / updates membership rows, and those rows
 * then drive tenant access and the role used by the write guard. Runs against the in-memory RLS-emulating store
 * (testEnv forces it), which mirrors the INSERT ... ON CONFLICT and tenant-scoped SELECT used on PostgreSQL.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const T_A = 'tenant_members_a';
const T_B = 'tenant_members_b';

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

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify({ email: 'caller@test.mil', ...claims })).toString('base64')}.mock_pbc_signature`;
const caller = (sub: string, role: string, tenant: string) => jwt({ sub, roles: { [tenant]: role } });

async function call(method: string, path: string, token: string, tenant: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'x-tenant-id': tenant, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

const owner = caller('u_owner', 'TENANT_OWNER', T_A);
const newMember = (over: Record<string, unknown> = {}) => ({ userId: 'u_alice', email: 'Alice@Example.mil', name: 'Alice', role: 'ASSESSOR', ...over });

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Insert / update ---');
  const empty = await call('GET', `/tenants/${T_A}/members`, owner, T_A);
  assert(empty.status === 200 && empty.body?.totalCount === 0, 'a new tenant has no members', empty);

  const created = await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember());
  assert(created.status === 201 && created.body?.created === true, 'POST inserts a tenant_users row (201)', created);
  assert(created.body?.member?.role === 'ASSESSOR' && created.body?.member?.tenantId === T_A, 'row carries role and tenant');
  assert(created.body?.member?.email === 'alice@example.mil', 'email is normalized to lowercase', created.body?.member);

  const listed = await call('GET', `/tenants/${T_A}/members`, owner, T_A);
  assert(listed.body?.totalCount === 1 && listed.body?.members?.[0]?.userId === 'u_alice', 'GET lists the inserted member', listed.body);

  const updated = await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ role: 'VIEWER' }));
  assert(updated.status === 200 && updated.body?.created === false && updated.body?.previousRole === 'ASSESSOR', 'second POST updates the role (200, upsert)', updated);
  const afterUpdate = await call('GET', `/tenants/${T_A}/members`, owner, T_A);
  assert(afterUpdate.body?.totalCount === 1 && afterUpdate.body?.members?.[0]?.role === 'VIEWER', 'still one row, role changed');

  console.log('\n--- Membership drives access and role ---');
  // alice authenticates with a token that only claims tenant "elsewhere": her access to T_A can only come from tenant_users.
  const alice = (role?: string) => jwt({ sub: 'u_alice', roles: { tenant_elsewhere: role ?? 'VIEWER' } });
  const bob = jwt({ sub: 'u_bob', roles: { tenant_elsewhere: 'VIEWER' } });
  assert((await call('GET', '/controls', bob, T_A)).status === 403, 'non-member with claims for another tenant -> 403');
  assert((await call('GET', '/controls', alice(), T_A)).status === 200, 'member (added via POST) can read the tenant -> 200');
  const put = { status: 'MET', implementationNotes: 'members test' };
  assert((await call('PUT', '/controls/AC.L1-3.1.1', alice(), T_A, put)).status === 403, 'role VIEWER from tenant_users => write 403');
  await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ role: 'TENANT_OWNER' }));
  assert((await call('PUT', '/controls/AC.L1-3.1.1', alice(), T_A, put)).status === 200, 'after promotion to TENANT_OWNER => write 200 (role read from tenant_users)');

  console.log('\n--- Authorization of the endpoint itself ---');
  for (const role of ['ASSESSOR', 'VIEWER'] as const) {
    const r = await call('POST', `/tenants/${T_A}/members`, caller(`u_${role}`, role, T_A), T_A, newMember({ userId: 'u_x' }));
    assert(r.status === 403, `${role} cannot add members (403)`, r);
  }
  assert((await call('GET', `/tenants/${T_A}/members`, caller('u_v', 'VIEWER', T_A), T_A)).status === 200, 'VIEWER can list members');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_B, newMember())).status === 403, 'URL tenant must match active tenant -> 403');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_owner', role: 'VIEWER' }))).status === 403, 'cannot change your own role -> 403');
  const escalate = await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_carol', role: 'MSP_ADMIN' }));
  assert(escalate.status === 403, 'TENANT_OWNER cannot grant MSP_ADMIN -> 403', escalate);
  const msp = caller('u_msp', 'MSP_ADMIN', T_A);
  assert((await call('POST', `/tenants/${T_A}/members`, msp, T_A, newMember({ userId: 'u_carol', role: 'MSP_ADMIN' }))).status === 201, 'MSP_ADMIN can grant MSP_ADMIN -> 201');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_carol', role: 'VIEWER' }))).status === 403, 'TENANT_OWNER cannot demote an MSP_ADMIN -> 403');

  console.log('\n--- Validation ---');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ role: 'ADMIN' }))).status === 400, 'unknown role -> 400');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ email: 'not-an-email' }))).status === 400, 'bad email -> 400');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: "x'; DROP TABLE tenant_users;--" }))).status === 400, 'unsafe userId -> 400');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, {})).status === 400, 'empty body -> 400');

  console.log('\n--- Tenant isolation (RLS emulation) ---');
  const ownerB = caller('u_owner_b', 'TENANT_OWNER', T_B);
  const listB = await call('GET', `/tenants/${T_B}/members`, ownerB, T_B);
  assert(listB.status === 200 && listB.body?.totalCount === 0, "tenant B cannot see tenant A's members", listB.body);
  await call('POST', `/tenants/${T_B}/members`, ownerB, T_B, newMember({ userId: 'u_alice', role: 'VIEWER' }));
  const aliceInA = (await call('GET', `/tenants/${T_A}/members`, owner, T_A)).body?.members?.find((m: any) => m.userId === 'u_alice');
  assert(aliceInA?.role === 'TENANT_OWNER', 'the same user can hold different roles in different tenants', aliceInA);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
