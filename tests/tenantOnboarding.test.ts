import './testEnv';
// Framework (program) settings are decided by platform administrators: this test's actor is listed as one.
process.env.PLATFORM_ADMIN_EMAILS = 'u_onb_owner@test.mil';
// The browser ApiClient resolves its base URL from VITE_API_URL at import time; point it at the test server first.
process.env.VITE_API_URL = 'http://127.0.0.1:8080';

import { installSessionCookieBridge } from './sessionCookieBridge';
installSessionCookieBridge();
import { server } from '../server/index';

/**
 * Server-side onboarding: PATCH /api/v1/tenants/:id (so settings entered in the wizard / edit screens persist and
 * survive the server-wins sync), samStatus on create, and the browser ApiClient's createTenant / updateTenant with
 * the error mapping the UI shows (401 / 403 / 400 / network).
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

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** A user whose claims name only an unrelated tenant, so all access to real tenants comes from tenant_users. */
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, path: string, token: string, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
const myTenant = async (token: string, id: string) => ((await call('GET', '/tenants', token)).body?.tenants as Json[]).find((t) => t.id === id);
const rejection = async (p: Promise<unknown>): Promise<{ status: number; message: string; name: string } | null> =>
  p.then(() => null, (e: { status: number; message: string; name: string }) => ({ status: e.status, message: e.message, name: e.name }));

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const { ApiClient, ApiError } = await import('../src/services/apiClient');

  const owner = person('u_onb_owner');
  const analyst = person('u_onb_analyst');
  const viewer = person('u_onb_viewer');
  const stranger = person('u_onb_stranger');

  console.log('--- Create carries samStatus; settings come back on listing ---');
  const created = await call('POST', '/tenants', owner, undefined, { name: 'Onboarding Org', samStatus: 'PENDING', cageCode: 'ab12c' });
  const id: string = created.body?.tenant?.id;
  assert(created.status === 201 && created.body?.tenant?.samStatus === 'PENDING', 'samStatus is accepted on create', created.body?.tenant);
  assert((await call('POST', '/tenants', owner, undefined, { name: 'Bad Sam', samStatus: 'MAYBE' })).status === 400, 'an invalid samStatus is rejected (400)');
  await call('POST', `/tenants/${id}/members`, owner, id, { userId: 'u_onb_analyst', email: 'a@test.mil', role: 'ASSESSOR' });
  await call('POST', `/tenants/${id}/members`, owner, id, { userId: 'u_onb_viewer', email: 'v@test.mil', role: 'VIEWER' });

  console.log('\n--- PATCH /tenants/:id ---');
  const patch = (token: string, body: unknown, tenant = id, urlId = id) => call('PATCH', `/tenants/${urlId}`, token, tenant, body);
  const ok = await patch(owner, { name: 'Onboarding Org Inc', systemName: 'Prod Enclave', systemOwner: 'Jane Doe', samStatus: 'ACTIVE', cageCode: 'zz9yx', industry: 'Aerospace' });
  assert(ok.status === 200 && ok.body?.tenant?.name === 'Onboarding Org Inc', 'the owner can update settings (200)', ok);
  const listed = await myTenant(owner, id);
  assert(listed?.systemName === 'Prod Enclave' && listed?.systemOwner === 'Jane Doe' && listed?.samStatus === 'ACTIVE' && listed?.industry === 'Aerospace', 'the update is what GET /tenants returns, so a sync will not revert it', listed);
  assert(listed?.cageCode === 'ZZ9YX', 'CAGE codes are normalised to upper case');
  assert(listed?.createdAt === created.body?.tenant?.createdAt, 'createdAt is untouched');

  assert((await patch(analyst, { name: 'Hacked' })).status === 403, 'an ASSESSOR cannot update settings (403)');
  assert((await patch(viewer, { name: 'Hacked' })).status === 403, 'a VIEWER cannot update settings (403)');
  assert((await myTenant(owner, id))?.name === 'Onboarding Org Inc', 'and nothing changed');
  assert((await patch(stranger, { name: 'Hacked' })).status === 403, 'a non-member cannot update (403)');
  const otherTenant = (await call('POST', '/tenants', stranger, undefined, { name: 'Stranger Org' })).body?.tenant?.id as string;
  assert((await patch(owner, { name: 'Hacked' }, id, otherTenant)).status === 403, "the URL must match the caller's active tenant: no editing someone else's tenant");
  assert((await patch(owner, { name: 'Hacked' }, otherTenant, otherTenant)).status === 403, "even naming that tenant in x-tenant-id does not help (not a member)");
  assert((await myTenant(stranger, otherTenant))?.name === 'Stranger Org', "the other tenant was not modified");

  console.log('\n--- Validation and protected fields ---');
  assert((await patch(owner, {})).status === 400, 'an empty patch -> 400');
  assert((await patch(owner, { name: 'x' })).status === 400, 'name too short -> 400');
  assert((await patch(owner, { cageCode: 'PENDING' })).status === 400, 'the UI placeholder "PENDING" is not a valid CAGE code -> 400');
  assert((await patch(owner, { samStatus: 'NOPE' })).status === 400, 'bad samStatus -> 400');
  assert((await patch(owner, { primaryFramework: 'ISO_27001' })).status === 400, 'unknown framework -> 400');
  assert((await patch(owner, { systemName: '   ' })).status === 400, 'blank systemName -> 400');
  assert((await patch(owner, { systemName: 'x'.repeat(300) })).status === 400, 'over-long systemName -> 400');
  const protectedPatch = await patch(owner, { name: 'Still Fine', licenseTier: 'ENTERPRISE', id: 'tenant-hijack', createdAt: '1999-01-01T00:00:00Z' });
  const after = await myTenant(owner, id);
  assert(protectedPatch.status === 200 && !('licenseTier' in (after ?? {})), 'there is no license tier any more: the field is neither accepted nor returned', after);
  assert(after?.id === id && after?.createdAt === created.body?.tenant?.createdAt, 'id and createdAt cannot be changed either');

  console.log('\n--- Framework consistency ---');
  await patch(owner, { primaryFramework: 'CMMC_L2' });
  let t = await myTenant(owner, id);
  assert(t?.primaryFramework === 'CMMC_L2' && t?.enabledFrameworks.includes('CMMC_L2'), 'choosing a primary framework also enables it', t);
  await patch(owner, { enabledFrameworks: ['SOC_2_TYPE_II', 'HIPAA_SECURITY'] });
  t = await myTenant(owner, id);
  assert(t?.enabledFrameworks.includes(t?.primaryFramework), 'the primary framework is always one of the enabled ones', t);
  await patch(owner, { primaryFramework: 'NIST_800_53_REV5', enabledFrameworks: ['CMMC_L1'] });
  t = await myTenant(owner, id);
  assert(t?.primaryFramework === 'NIST_800_53_REV5' && t?.enabledFrameworks.includes('NIST_800_53_REV5') && t?.enabledFrameworks.includes('CMMC_L1'), 'an explicit primary wins and is enabled alongside the rest', t);

  console.log('\n--- 404 for a tenant with no row ---');
  const claimOnly = jwt({ sub: 'u_onb_claim', email: 'c@test.mil', roles: { tenant_norow: 'TENANT_OWNER' } });
  assert((await call('PATCH', '/tenants/tenant_norow', claimOnly, 'tenant_norow', { name: 'Ghost Tenant' })).status === 404, 'patching a tenant the server has no record of -> 404');

  console.log('\n--- Browser ApiClient: createTenant ---');
  const viaClient = await ApiClient.createTenant({ name: 'Client Created Org', primaryFramework: 'CMMC_L2' }, owner);
  assert(viaClient.role === 'TENANT_OWNER' && /^tenant-client-created-org-[0-9a-f]{8}$/.test(viaClient.tenant.id), 'createTenant returns the server-generated tenant and the owner role', viaClient.tenant.id);
  assert((await myTenant(owner, viaClient.tenant.id))?.primaryFramework === 'CMMC_L2', 'and it really exists on the server');

  const noSession = await rejection(ApiClient.createTenant({ name: 'No Token Org' }));
  assert(noSession?.name === 'ApiError' && noSession.status === 401 && /signed in/i.test(noSession.message), 'no session => ApiError 401 before any request', noSession);
  const badRef = await rejection(ApiClient.createTenant({ name: 'Bad Token Org' }, 'not-a-token'));
  assert(badRef?.status === 401 && /sign in again/i.test(badRef.message), 'an invalid or expired token => 401 with a "sign in again" message', badRef);
  const invalid = await rejection(ApiClient.createTenant({ name: 'x' }, owner));
  assert(invalid?.status === 400 && /name/i.test(invalid.message), 'invalid input => 400 carrying the server\'s explanation', invalid);
  process.env.ALLOW_TENANT_CREATION = 'false';
  const disabled = await rejection(ApiClient.createTenant({ name: 'Blocked Org' }, owner));
  delete process.env.ALLOW_TENANT_CREATION;
  assert(disabled?.status === 403 && /disabled/i.test(disabled.message), 'creation disabled => 403 with the server\'s message', disabled);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
  const offline = await rejection(ApiClient.createTenant({ name: 'Offline Org' }, owner));
  globalThis.fetch = (() => Promise.resolve(new Response('upstream broke', { status: 502 }))) as typeof fetch;
  const serverDown = await rejection(ApiClient.createTenant({ name: 'Broken Org' }, owner));
  globalThis.fetch = realFetch;
  assert(offline?.status === 0 && /cannot reach/i.test(offline.message), 'a network failure => status 0 "cannot reach the server"', offline);
  assert(serverDown?.status === 502 && !/upstream/.test(serverDown.message), 'a 5xx => a generic message (no server internals leak to the UI)', serverDown);
  assert(new ApiError(403, 'x') instanceof Error && new ApiError(403, 'x').status === 403, 'ApiError is a real Error with a status');

  console.log('\n--- Browser ApiClient: updateTenant ---');
  assert((await rejection(ApiClient.updateTenant(id, { name: 'Renamed By Client' }, owner))) === null, 'the owner can update through the client');
  assert((await myTenant(owner, id))?.name === 'Renamed By Client', 'and the change is on the server');
  const denied = await rejection(ApiClient.updateTenant(id, { name: 'Nope Nope' }, analyst));
  assert(denied?.status === 403 && denied.message.length > 0, 'an ASSESSOR gets ApiError 403', denied);
  assert((await rejection(ApiClient.updateTenant(id, { name: 'No Token' })))?.status === 401, 'no session => 401');
  assert((await rejection(ApiClient.updateTenant(id, { cageCode: 'PENDING' }, owner)))?.status === 400, 'invalid settings => 400');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
