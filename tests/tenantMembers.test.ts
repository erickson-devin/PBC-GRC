import './testEnv';
import { server } from '../server/index';
import { firstProgram } from './programFixture';

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
  await firstProgram(T_A); // a tenant starts with no program
  await firstProgram(T_B);

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
  const put = { status: 'IN_PROGRESS', implementationNotes: 'members test' };
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

  console.log('\n--- Admin role: manages Assessors and Viewers only ---');
  const admin = caller('u_admin', 'TENANT_ADMIN', T_A);
  const grantAdmin = await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_dave', email: 'dave@example.mil', role: 'TENANT_ADMIN' }));
  assert(grantAdmin.status === 201 && grantAdmin.body?.member?.role === 'TENANT_ADMIN', 'TENANT_OWNER can grant TENANT_ADMIN -> 201', grantAdmin);
  const adminAdds = await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_erin', email: 'erin@example.mil', role: 'ASSESSOR' }));
  assert(adminAdds.status === 201, 'an Admin can add an Assessor -> 201', adminAdds);
  assert((await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_erin', email: 'erin@example.mil', role: 'VIEWER' }))).status === 200, 'an Admin can set an Assessor to Viewer -> 200');
  for (const role of ['TENANT_ADMIN', 'TENANT_OWNER', 'MSP_ADMIN']) {
    const r = await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_erin', email: 'erin@example.mil', role }));
    assert(r.status === 403 && r.body?.code === 'role_not_grantable', `an Admin cannot raise a member to ${role} -> 403 role_not_grantable`, r);
  }
  const adminRaisesNew = await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_frank', email: 'frank@example.mil', role: 'TENANT_OWNER' }));
  assert(adminRaisesNew.status === 403, 'an Admin cannot add a new member as Owner -> 403', adminRaisesNew);
  assert((await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_alice', role: 'VIEWER' }))).status === 403, 'an Admin cannot demote an Owner -> 403');
  assert((await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_dave', email: 'dave@example.mil', role: 'VIEWER' }))).status === 403, 'an Admin cannot demote another Admin -> 403');
  assert((await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_carol', role: 'VIEWER' }))).status === 403, 'an Admin cannot demote an MSP_ADMIN -> 403');
  assert((await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_admin', email: 'admin@example.mil', role: 'VIEWER' }))).status === 403, 'an Admin cannot change their own role -> 403');
  const memberOf = async (id: string) => (await call('GET', `/tenants/${T_A}/members`, owner, T_A)).body?.members?.find((m: any) => m.userId === id);
  assert((await memberOf('u_alice'))?.role === 'TENANT_OWNER' && (await memberOf('u_dave'))?.role === 'TENANT_ADMIN', 'the refused changes left the Owner and the Admin as they were');
  const refusal = await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_erin', email: 'erin@example.mil', role: 'TENANT_ADMIN' }));
  assert(refusal.body?.error === 'Forbidden: an Admin cannot grant, change or remove an Admin role', 'the refusal reads naturally (an Admin ... an Admin)', refusal.body);
  const refusalOwner = await call('POST', `/tenants/${T_A}/members`, admin, T_A, newMember({ userId: 'u_alice', role: 'VIEWER' }));
  assert(refusalOwner.body?.error === 'Forbidden: an Admin cannot grant, change or remove a Tenant Owner role', 'the refusal reads naturally (an Admin ... a Tenant Owner)', refusalOwner.body);
  assert(escalate.body?.error === 'Forbidden: a Tenant Owner cannot grant, change or remove an MSP Admin role', 'the refusal reads naturally (a Tenant Owner ... an MSP Admin)', escalate.body);
  assert((await call('DELETE', `/tenants/${T_A}/members/u_dave`, admin, T_A)).status === 403, 'an Admin cannot remove another Admin -> 403');
  assert((await call('DELETE', `/tenants/${T_A}/members/u_alice`, admin, T_A)).status === 403, 'an Admin cannot remove an Owner -> 403');
  assert((await call('DELETE', `/tenants/${T_A}/members/u_carol`, admin, T_A)).status === 403, 'an Admin cannot remove an MSP_ADMIN -> 403');
  assert((await call('DELETE', `/tenants/${T_A}/members/u_admin`, admin, T_A)).status === 403, 'an Admin cannot remove themselves -> 403');
  const adminRemoves = await call('DELETE', `/tenants/${T_A}/members/u_erin`, admin, T_A);
  assert(adminRemoves.status === 200 && adminRemoves.body?.previousRole === 'VIEWER', 'an Admin can remove a Viewer -> 200', adminRemoves);
  assert((await call('DELETE', `/tenants/${T_A}/members/u_alice`, owner, T_A)).status === 409, 'removing the last Owner is still 409 (an Owner may remove an Owner otherwise)');
  const lastOwnerDemote = await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_alice', role: 'TENANT_ADMIN' }));
  assert(lastOwnerDemote.status === 409 && lastOwnerDemote.body?.code === 'last_owner', 'demoting the last Owner is 409 last_owner', lastOwnerDemote);
  const lastOwnerRemove = await call('DELETE', `/tenants/${T_A}/members/u_alice`, owner, T_A);
  assert(lastOwnerRemove.status === 409 && lastOwnerRemove.body?.code === 'last_owner', 'removing the last Owner carries last_owner too', lastOwnerRemove);
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_dave', email: 'dave@example.mil', role: 'TENANT_OWNER' }))).status === 200, 'an Owner can make an Admin a second Owner -> 200');
  assert((await call('POST', `/tenants/${T_A}/members`, owner, T_A, newMember({ userId: 'u_alice', role: 'TENANT_ADMIN' }))).status === 200, 'with a second Owner, the first can be demoted -> 200');
  await call('POST', `/tenants/${T_A}/members`, msp, T_A, newMember({ userId: 'u_alice', role: 'TENANT_OWNER' })); // restore for the isolation checks below

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

  console.log('\n--- An MSP_ADMIN cannot demote the only Owner either ---');
  const mspB = caller('u_msp_b', 'MSP_ADMIN', T_B);
  assert((await call('POST', `/tenants/${T_B}/members`, mspB, T_B, newMember({ userId: 'u_solo', email: 'solo@example.mil', role: 'TENANT_OWNER' }))).status === 201, 'MSP_ADMIN adds the only Owner of tenant B -> 201');
  const soloDemote = await call('POST', `/tenants/${T_B}/members`, mspB, T_B, newMember({ userId: 'u_solo', email: 'solo@example.mil', role: 'VIEWER' }));
  assert(soloDemote.status === 409 && soloDemote.body?.code === 'last_owner', 'MSP_ADMIN demoting the only Owner -> 409 last_owner', soloDemote);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
