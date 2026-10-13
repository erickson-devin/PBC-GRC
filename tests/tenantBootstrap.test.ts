import './testEnv';
import { server } from '../server/index';

/**
 * Tenant bootstrap: POST /api/v1/tenants creates a tenant and makes the caller its first TENANT_OWNER in
 * tenant_users, so a brand-new user can reach a working, secured tenant with no manual database work.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';

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
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;

/** A user with NO tenant of their own: claims only mention an unrelated tenant, so any access to a new tenant must
 *  come from the tenant_users row that the bootstrap created. */
const newUser = (sub: string, email: string) => jwt({ sub, email, name: sub, roles: { tenant_elsewhere: 'VIEWER' } });

async function call(method: string, path: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  const founder = newUser('u_founder', 'Founder@Acme-Defense.com');
  const stranger = newUser('u_stranger', 'stranger@other.com');

  console.log('--- Authentication ---');
  assert((await call('POST', '/tenants', null, undefined, { name: 'Acme Defense' })).status === 401, 'creating a tenant requires authentication (401)');

  console.log('\n--- Bootstrap ---');
  const created = await call('POST', '/tenants', founder, undefined, {
    name: 'Acme Defense Systems',
    cageCode: '1abc2',
    licenseTier: 'ENTERPRISE', // there is no license tier: ignored like any unknown field
    primaryFramework: 'CMMC_L2',
  });
  assert(created.status === 201, 'POST /tenants -> 201 (no x-tenant-id needed: the caller has no tenant yet)', created);
  const tenantId: string = created.body?.tenant?.id;
  assert(/^tenant-acme-defense-systems-[0-9a-f]{8}$/.test(tenantId), 'server generates a slugged, unguessable tenant id', tenantId);
  assert(created.body?.role === 'TENANT_OWNER' && created.body?.member?.role === 'TENANT_OWNER', 'caller is assigned TENANT_OWNER');
  assert(created.body?.member?.userId === 'u_founder' && created.body?.member?.tenantId === tenantId, 'tenant_users row links the caller to the new tenant');
  assert(created.body?.member?.email === 'founder@acme-defense.com', 'owner email is normalized', created.body?.member?.email);
  assert(!('licenseTier' in (created.body?.tenant ?? {})), 'there is no license tier: the field is not stored or returned', created.body?.tenant);
  assert(created.body?.tenant?.cageCode === '1ABC2', 'cage code is normalized to upper case');
  assert(created.body?.tenant?.primaryFramework === 'CMMC_L1' && created.body?.tenant?.enabledFrameworks?.join() === 'CMMC_L1', 'a self-service tenant gets the default program (CMMC Level 1) whatever it asks for: only a platform administrator sets it', created.body?.tenant);
  assert(created.body?.tenant?.systemName === 'Acme Defense Systems Enclave', 'defaults the system name');

  console.log('\n--- The founder can really use the tenant (access + role come from tenant_users) ---');
  const members = await call('GET', `/tenants/${tenantId}/members`, founder, tenantId);
  assert(members.status === 200 && members.body?.totalCount === 1 && members.body?.members?.[0]?.role === 'TENANT_OWNER', 'GET members: exactly one member, the owner', members);
  assert((await call('GET', '/controls', founder, tenantId)).status === 200, 'founder can read the new tenant');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', founder, tenantId, { status: 'MET', implementationNotes: 'bootstrap' })).status === 200, 'founder (TENANT_OWNER) can write');
  const invite = await call('POST', `/tenants/${tenantId}/members`, founder, tenantId, { userId: 'u_analyst', email: 'analyst@acme-defense.com', role: 'ASSESSOR' });
  assert(invite.status === 201, 'the owner can add the next member immediately', invite);

  console.log('\n--- Isolation ---');
  assert((await call('GET', '/controls', stranger, tenantId)).status === 403, 'an unrelated user cannot access the new tenant (403)');
  assert((await call('GET', `/tenants/${tenantId}/members`, stranger, tenantId)).status === 403, 'nor list its members');
  const second = await call('POST', '/tenants', founder, undefined, { name: 'Acme Defense Systems' });
  assert(second.status === 201 && second.body?.tenant?.id !== tenantId, 'the same user can create another tenant with a distinct id');
  const otherMembers = await call('GET', `/tenants/${second.body?.tenant?.id}/members`, founder, second.body?.tenant?.id);
  assert(otherMembers.body?.totalCount === 1, "tenants do not share members");
  const original = await call('GET', `/tenants/${tenantId}/members`, founder, tenantId);
  assert(original.body?.totalCount === 2, 'the first tenant still has its own two members', original.body?.totalCount);

  console.log('\n--- Validation ---');
  assert((await call('POST', '/tenants', founder, undefined, {})).status === 400, 'missing name -> 400');
  assert((await call('POST', '/tenants', founder, undefined, { name: 'x' })).status === 400, 'name too short -> 400');
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Valid Name', primaryFramework: 'ISO_27001' })).status === 400, 'unknown framework -> 400');
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Valid Name', enabledFrameworks: [] })).status === 400, 'empty enabledFrameworks -> 400');
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Valid Name', cageCode: 'TOO-LONG-CAGE' })).status === 400, 'bad CAGE code -> 400');
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Valid Name', systemName: 42 })).status === 400, 'non-string systemName -> 400');
  const evil = await call('POST', '/tenants', founder, undefined, { name: "../../x'; DROP TABLE tenants;--" });
  assert(evil.status === 201 && /^tenant-[a-z0-9-]+-[0-9a-f]{8}$/.test(evil.body?.tenant?.id), 'a hostile name is slugged safely and never reaches the id verbatim', evil.body?.tenant?.id);

  console.log('\n--- Operator switch ---');
  process.env.ALLOW_TENANT_CREATION = 'false';
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Blocked Org' })).status === 403, 'ALLOW_TENANT_CREATION=false disables self-service creation (403)');
  delete process.env.ALLOW_TENANT_CREATION;
  assert((await call('POST', '/tenants', founder, undefined, { name: 'Allowed Org' })).status === 201, 'and re-enabling it works');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
