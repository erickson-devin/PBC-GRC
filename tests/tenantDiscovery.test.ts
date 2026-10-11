import './testEnv';
import { server } from '../server/index';

/**
 * GET /api/v1/tenants ("list my tenants"): each user sees exactly the tenants they belong to, with their own role
 * in each, and never another user's tenants. Runs against the in-memory store (which mirrors the PostgreSQL
 * discovery policies by filtering on the user id); the policies themselves are checked by dbSchema.test.ts and,
 * against a live database, by `npm run db:verify-rls`.
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
/** Claims mention only an unrelated tenant, so everything a user sees must come from tenant_users. */
const user = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, path: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
/** `tenants` holds membership entries only; the fixture's unrelated claim is checked separately. */
const mine = async (token: string) => {
  const r = await call('GET', '/tenants', token);
  const all = (r.body?.tenants ?? []) as Json[];
  return { status: r.status, all, tenants: all.filter((t) => t.id !== 'tenant_unrelated'), body: r.body };
};
const ids = (list: Json[]) => list.map((t) => t.id).sort();
const roleIn = (list: Json[], id: string) => list.find((t) => t.id === id)?.role;

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const alice = user('u_alice');
  const bob = user('u_bob');
  const carol = user('u_carol');

  console.log('--- Authentication ---');
  assert((await call('GET', '/tenants', null)).status === 401, 'listing tenants requires authentication (401)');
  assert((await call('GET', '/tenants', 'garbage')).status === 401, 'an invalid token is rejected (401)');

  console.log('\n--- Setup: alice owns two tenants, bob one; bob is also invited to alice\'s first ---');
  const t1 = (await call('POST', '/tenants', alice, undefined, { name: 'Zulu Defense' })).body?.tenant?.id as string;
  const t2 = (await call('POST', '/tenants', alice, undefined, { name: 'Alpha Systems', primaryFramework: 'CMMC_L2' })).body?.tenant?.id as string;
  const t3 = (await call('POST', '/tenants', bob, undefined, { name: 'Bob Industries' })).body?.tenant?.id as string;
  assert(Boolean(t1 && t2 && t3), 'three tenants created');
  assert((await call('POST', `/tenants/${t1}/members`, alice, t1, { userId: 'u_bob', email: 'bob@test.mil', role: 'ASSESSOR' })).status === 201, 'alice invites bob to her first tenant as ASSESSOR');

  console.log('\n--- Each user sees only their own tenants ---');
  const a = await mine(alice);
  assert(a.status === 200 && a.tenants.length === 2, 'alice sees exactly 2 tenants of her own', a.tenants.length);
  assert(a.all.find((t) => t.id === 'tenant_unrelated')?.source === 'claim', 'plus the tenant her token claims, labelled as a claim');
  assert(JSON.stringify(ids(a.tenants)) === JSON.stringify([t1, t2].sort()), 'alice sees her two tenants and not bob\'s');
  assert(!a.tenants.some((t) => t.id === t3), "bob's tenant is invisible to alice");
  const b = await mine(bob);
  assert(JSON.stringify(ids(b.tenants)) === JSON.stringify([t1, t3].sort()), 'bob sees his own tenant plus the one he was invited to', ids(b.tenants));
  assert(!b.tenants.some((t) => t.id === t2), "alice's other tenant is invisible to bob (not a member)");
  const c = await mine(carol);
  assert(c.status === 200 && c.tenants.length === 0, 'a user with no memberships sees an empty list, not an error', c.body);

  console.log('\n--- Roles are per user and per tenant ---');
  assert(roleIn(a.tenants, t1) === 'TENANT_OWNER' && roleIn(a.tenants, t2) === 'TENANT_OWNER', 'alice is TENANT_OWNER in both');
  assert(roleIn(b.tenants, t1) === 'ASSESSOR' && roleIn(b.tenants, t3) === 'TENANT_OWNER', 'bob is ASSESSOR in alice\'s tenant and TENANT_OWNER in his own');
  await call('POST', `/tenants/${t1}/members`, alice, t1, { userId: 'u_bob', email: 'bob@test.mil', role: 'VIEWER' });
  assert(roleIn((await mine(bob)).tenants, t1) === 'VIEWER', 'a role change on the server shows up on the next listing');

  console.log('\n--- The list matches what the server actually enforces ---');
  for (const t of (await mine(bob)).tenants) {
    const read = await call('GET', '/controls', bob, t.id);
    assert(read.status === 200, `bob can read every tenant he is listed in (${t.name})`, read.status);
    const write = await call('PUT', '/controls/AC.L1-3.1.1', bob, t.id, { status: 'MET', implementationNotes: 'x' });
    assert((write.status === 200) === (t.role === 'TENANT_OWNER'), `listed role ${t.role} == enforced write access (${t.name}: ${write.status})`);
  }
  assert((await call('GET', '/controls', bob, t2)).status === 403, 'and a tenant that is not listed is not accessible (403)');

  console.log('\n--- Content ---');
  const first = a.tenants[0];
  assert(first.name === 'Alpha Systems' && a.tenants[1].name === 'Zulu Defense', 'sorted by name');
  assert(a.tenants.find((t) => t.id === t2)?.primaryFramework === 'CMMC_L2', 'tenant settings are included');
  assert(typeof first.joinedAt === 'string' && typeof first.createdAt === 'string', 'timestamps included');
  assert(!JSON.stringify(a.body).includes('u_bob') && !JSON.stringify(a.body).includes('bob@test.mil'), 'the response never contains other members');
  assert(a.tenants.every((t) => t.source === 'membership'), 'membership-derived entries are labelled');
  const tenantIdClaim = await mine(jwt({ sub: 'u_erin', email: 'erin@test.mil', tenantId: t3 }));
  assert(tenantIdClaim.tenants.length === 1 && tenantIdClaim.tenants[0].id === t3 && tenantIdClaim.tenants[0].role === 'VIEWER' && tenantIdClaim.tenants[0].source === 'claim', 'a tenant_id claim (no roles claim, no membership) is listed as read-only VIEWER, as enforced', tenantIdClaim.tenants);

  console.log('\n--- Token claims are merged the way authMiddleware treats them ---');
  const withClaims = jwt({ sub: 'u_dave', email: 'dave@test.mil', roles: { tenant_from_claims: 'ASSESSOR', [t3]: 'VIEWER' } });
  await call('POST', `/tenants/${t3}/members`, bob, t3, { userId: 'u_dave', email: 'dave@test.mil', role: 'TENANT_OWNER' });
  const d = await mine(withClaims);
  assert(roleIn(d.tenants, 'tenant_from_claims') === 'ASSESSOR' && d.tenants.find((t) => t.id === 'tenant_from_claims')?.source === 'claim', 'a claim-only tenant is listed and labelled "claim"');
  assert(roleIn(d.tenants, t3) === 'VIEWER' && d.tenants.filter((t) => t.id === t3).length === 1, 'a claim and a membership for the same tenant appear once, claim role wins (as in authMiddleware)', d.tenants);

  console.log('\n--- Authenticate-only: no tenant header needed, and a hostile one is ignored ---');
  assert((await call('GET', '/tenants', alice, t3)).status === 200 && !ids((await call('GET', '/tenants', alice, t3)).body?.tenants ?? []).includes(t3), "an x-tenant-id for someone else's tenant does not widen the list");
  assert((await call('GET', '/tenants', alice, '../etc')).status === 200, 'a malformed x-tenant-id is irrelevant here');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
