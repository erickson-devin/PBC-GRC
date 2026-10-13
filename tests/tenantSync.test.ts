import './testEnv';
// Framework (program) settings are decided by platform administrators: this test's actor is listed as one.
process.env.PLATFORM_ADMIN_EMAILS = 'u_sync_owner@test.mil';
import { server } from '../server/index';
import {
  applyRoleSync,
  isValidCageCode,
  mergeServerTenants,
  parseServerTenants,
  pickActiveTenantId,
  serverTenantToTenant,
  ServerTenant,
  toServerPatch,
} from '../src/data/tenantSync';
import { canRoleWrite } from '../src/utils/roles';
import type { Tenant, TenantRole } from '../src/types/tenant';

/**
 * Server-to-client tenant synchronisation. Part 1 tests the pure merge logic the React TenantContext uses.
 * Part 2 is a contract test: the REAL GET /api/v1/tenants response goes through the same parser and merger, and the
 * role the UI would derive is compared with what the server actually enforces.
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

const NOW = new Date('2026-01-01T00:00:00Z');
const srv = (over: Partial<ServerTenant> & { id: string }): ServerTenant => ({
  name: over.id,
  cageCode: null,
  samStatus: 'ACTIVE',
  systemName: 'Sys',
  systemOwner: 'Owner',
  industry: 'DIB',
  enabledFrameworks: ['CMMC_L1'],
  primaryFramework: 'CMMC_L1',
  createdAt: '2025-12-01T00:00:00Z',
  role: 'VIEWER',
  source: 'membership',
  ...over,
});
const local = (over: Partial<Tenant> & { id: string }): Tenant => ({
  name: over.id,
  cageCode: 'OLD11',
  samStatus: 'PENDING',
  systemName: 'Old sys',
  systemOwner: 'Old owner',
  industry: 'Old',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  isConfigured: true,
  ...over,
});

function pureTests() {
  console.log('--- parseServerTenants ---');
  const parsed = parseServerTenants({
    tenants: [
      { id: 't1', name: 'One', role: 'TENANT_OWNER', enabledFrameworks: ['CMMC_L2', 5], source: 'membership' },
      { id: 't2', role: 'ADMIN' }, // unknown role: dropped, never trusted
      { name: 'no id', role: 'VIEWER' },
      { id: '', role: 'VIEWER' },
      'garbage',
      null,
      { id: 't3', role: 'ASSESSOR', source: 'claim' },
    ],
  });
  assert(parsed.length === 2 && parsed[0].id === 't1' && parsed[1].id === 't3', 'malformed entries and unknown roles are dropped', parsed.map((p) => p.id));
  assert(parsed[0].enabledFrameworks.length === 1 && parsed[0].primaryFramework === 'CMMC_L1', 'fields are validated and defaulted');
  assert(parsed[1].source === 'claim', 'claim entries keep their source');
  assert(parseServerTenants(null).length === 0 && parseServerTenants({}).length === 0 && parseServerTenants({ tenants: 'x' }).length === 0, 'non-list payloads parse to an empty list');

  console.log('\n--- mergeServerTenants: server wins ---');
  const fresh = mergeServerTenants([], [srv({ id: 'a', name: 'Alpha', role: 'TENANT_OWNER', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2'], cageCode: '1ABC2' })], NOW);
  const a = fresh.tenants[0];
  assert(fresh.tenants.length === 1 && a.name === 'Alpha' && a.serverBacked === true && a.isDemo === false, 'a new server tenant is added and marked serverBacked');
  assert(a.isConfigured === true, 'a tenant that exists on the server does not trigger first-run onboarding');
  assert(a.primaryFramework === 'CMMC_L2' && a.cageCode === '1ABC2', 'server settings are applied');
  assert(fresh.roleUpdates.a === 'TENANT_OWNER' && fresh.removedTenantIds.length === 0, 'the server role is reported');

  const cached = local({ id: 'a', name: 'Stale Name', samStatus: 'EXPIRED', domain: 'alpha.mil', stackProfile: { identityProvider: 'OKTA' } as Tenant['stackProfile'] });
  const merged = mergeServerTenants([cached], [srv({ id: 'a', name: 'Alpha', role: 'VIEWER' })], NOW).tenants[0];
  assert(merged.name === 'Alpha' && merged.samStatus === 'ACTIVE', 'server-owned fields overwrite the cache (name, SAM status)');
  assert(merged.domain === 'alpha.mil' && merged.stackProfile?.identityProvider === 'OKTA', 'browser-owned fields survive (domain, stack profile)');
  assert(merged.serverBacked === true, 'the cached tenant becomes serverBacked');

  console.log('\n--- Roles are server-dictated, never trusted from cache ---');
  const cachedRoles: Record<string, TenantRole> = { a: 'TENANT_OWNER', b: 'TENANT_OWNER', legacy: 'TENANT_OWNER' };
  const r1 = mergeServerTenants([local({ id: 'a', serverBacked: true }), local({ id: 'b', serverBacked: true })], [srv({ id: 'a', role: 'VIEWER' }), srv({ id: 'b', role: 'ASSESSOR' })], NOW);
  const roles1 = applyRoleSync(cachedRoles, r1);
  assert(roles1.a === 'VIEWER' && roles1.b === 'ASSESSOR', 'a cached TENANT_OWNER is downgraded to the role the server says');
  assert(!canRoleWrite(roles1.a) && !canRoleWrite(roles1.b), 'so the UI turns read-only (canEdit false) for VIEWER and ASSESSOR');
  const r2 = mergeServerTenants([local({ id: 'a', serverBacked: true })], [srv({ id: 'a', role: 'TENANT_OWNER' })], NOW);
  assert(applyRoleSync({ a: 'VIEWER' }, r2).a === 'TENANT_OWNER' && canRoleWrite('TENANT_OWNER'), 'an upgrade is picked up too');
  assert(roles1.legacy === 'TENANT_OWNER', 'roles for tenants the server did not mention are left alone');

  console.log('\n--- Revocation and account switching ---');
  const mine = [local({ id: 'a', serverBacked: true }), local({ id: 'b', serverBacked: true }), local({ id: 'legacy' })];
  const afterRevoke = mergeServerTenants(mine, [srv({ id: 'a', role: 'VIEWER' })], NOW);
  assert(afterRevoke.removedTenantIds.length === 1 && afterRevoke.removedTenantIds[0] === 'b', 'a server-backed tenant the server no longer lists is removed (membership revoked)');
  assert(afterRevoke.tenants.map((t) => t.id).join() === 'a,legacy', 'and a browser-only legacy tenant is kept', afterRevoke.tenants.map((t) => t.id));
  assert(applyRoleSync({ a: 'TENANT_OWNER', b: 'TENANT_OWNER' }, afterRevoke).b === undefined, "the revoked tenant's cached role is deleted too");
  const switched = mergeServerTenants([local({ id: 'a', serverBacked: true, name: "Previous user's org" })], [srv({ id: 'z', name: 'New user org', role: 'TENANT_OWNER' })], NOW);
  assert(switched.tenants.map((t) => t.id).join() === 'z', "another user signing in does not inherit the previous user's server-backed tenants", switched.tenants.map((t) => t.id));
  const empty = mergeServerTenants([local({ id: 'a', serverBacked: true })], [], NOW);
  assert(empty.tenants.length === 0 && empty.removedTenantIds[0] === 'a', 'a user with no server tenants keeps none that were server-backed');

  console.log('\n--- Details and ordering ---');
  const claimOnly = mergeServerTenants([local({ id: 'c', name: 'Cached Name' })], [srv({ id: 'c', name: 'c', source: 'claim', role: 'ASSESSOR', systemName: '' })], NOW).tenants[0];
  assert(claimOnly.name === 'Cached Name' && claimOnly.cageCode === 'OLD11', 'a claim-only entry has no details, so it does not blank out cached ones');
  const twins = mergeServerTenants([], [srv({ id: 'x1', name: 'Acme Systems' }), srv({ id: 'x2', name: 'Acme Group' })], NOW);
  assert(twins.tenants.length === 2, 'two organisations with similar names stay distinct (identity is the id)');
  const idem = mergeServerTenants(twins.tenants, [srv({ id: 'x1', name: 'Acme Systems' }), srv({ id: 'x2', name: 'Acme Group' })], NOW);
  assert(idem.tenants.length === 2 && idem.removedTenantIds.length === 0, 'syncing twice is idempotent');
  assert(idem.tenants.map((t) => t.id).join() === 'x1,x2', 'existing order is stable');

  console.log('\n--- Onboarding: drafts and legacy blanks ---');
  const placeholder = local({ id: 'tenant-live-default-01', isConfigured: false });
  const legacyBlank = local({ id: 'tenant-old-blank-x1y2', isConfigured: false });
  const legacyDone = local({ id: 'tenant-old-done', isConfigured: true });
  const withServer = mergeServerTenants([placeholder, legacyBlank, legacyDone], [srv({ id: 'real', role: 'TENANT_OWNER' })], NOW, { placeholderIds: ['tenant-live-default-01'] });
  assert(!withServer.tenants.some((t) => t.id === placeholder.id), 'once the server lists real tenants, the first-run placeholder is dropped');
  assert(!withServer.tenants.some((t) => t.id === legacyBlank.id) && withServer.removedTenantIds.includes(legacyBlank.id), 'so is an unconfigured blank tenant left by an older version');
  assert(withServer.tenants.some((t) => t.id === legacyDone.id), 'but a configured browser-only tenant (real user data) is kept');
  assert(withServer.removedTenantIds.includes(placeholder.id) && applyRoleSync({ [placeholder.id]: 'TENANT_OWNER' }, withServer)[placeholder.id] === undefined, "and the draft's local role is removed with it");
  const noServer = mergeServerTenants([placeholder], [], NOW, { placeholderIds: ['tenant-live-default-01'] });
  assert(noServer.tenants.length === 1 && noServer.tenants[0].id === placeholder.id, 'with no server tenants the draft stays: the wizard needs it to create the first tenant');

  console.log('\n--- Licence tier stays browser-owned (the server does not manage it yet) ---');
  const programmed = mergeServerTenants([local({ id: 't', primaryFramework: 'CMMC_L1', enabledFrameworks: ['CMMC_L1'], serverBacked: true })], [srv({ id: 't', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2', 'NIST_800_53_REV5'] })], NOW).tenants[0];
  assert(programmed.primaryFramework === 'CMMC_L2' && programmed.enabledFrameworks?.join() === 'CMMC_L2,NIST_800_53_REV5', 'the assessment program always comes from the server: an administrator\'s change reaches every browser', programmed);

  console.log('\n--- serverTenantToTenant (used when the follow-up listing fails) ---');
  const built = serverTenantToTenant(srv({ id: 'b', name: 'Built Org', role: 'TENANT_OWNER', cageCode: 'AB12C' }), undefined, NOW.toISOString());
  assert(built.id === 'b' && built.name === 'Built Org' && built.cageCode === 'AB12C' && built.serverBacked === true && built.isConfigured === true, 'a POST response becomes a usable server-backed tenant');

  console.log('\n--- toServerPatch: only server-owned, valid fields are sent ---');
  assert(isValidCageCode('AB12C') && isValidCageCode(' ab12c ') && !isValidCageCode('PENDING') && !isValidCageCode('') && !isValidCageCode(undefined), 'CAGE validation matches the server (5 letters/digits; "PENDING" is not one)');
  const p = toServerPatch({ name: ' New Name ', cageCode: 'ab12c', samStatus: 'PENDING', systemName: 'S', systemOwner: 'O', industry: 'I', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2', 'CMMC_L1'] });
  assert(p.name === 'New Name' && p.cageCode === 'AB12C' && p.samStatus === 'PENDING' && p.primaryFramework === 'CMMC_L2' && p.enabledFrameworks?.length === 2, 'valid edits are normalised and sent');
  const dropped = toServerPatch({ name: '', cageCode: 'PENDING', systemName: '   ', domain: 'x.mil', stackProfile: {} as Tenant['stackProfile'], isConfigured: true, isSuspended: true });
  assert(Object.keys(dropped).length === 0, 'blank values, the PENDING placeholder and browser-only fields (domain, stack profile, flags) are never sent', dropped);
  assert(Object.keys(toServerPatch({ name: 'A' })).length === 0, 'a name the server would reject (too short) is not sent');

  console.log('\n--- pickActiveTenantId ---');
  const list = [local({ id: 'placeholder' }), local({ id: 'a' }), local({ id: 'b' })];
  assert(pickActiveTenantId('b', list, ['a'], ['placeholder']) === 'b', 'keeps the active tenant while it still exists');
  assert(pickActiveTenantId('placeholder', list, ['a', 'b'], ['placeholder']) === 'a', 'leaves the empty placeholder for the first server tenant');
  assert(pickActiveTenantId('gone', list, ['b'], ['placeholder']) === 'b', 'falls back to a server tenant when the active one was removed');
  assert(pickActiveTenantId('gone', list, [], []) === 'placeholder', 'with no server tenants, falls back to the first remaining tenant');
}

// ------------------------------------------------------------------------------------------------ contract

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
async function call(method: string, path: string, token: string, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

async function contractTests() {
  console.log('\n--- Contract: real server response -> parser -> merger ---');
  const owner = person('u_sync_owner');
  const analyst = person('u_sync_analyst');
  const t1 = ((await call('POST', '/tenants', owner, undefined, { name: 'Sync Org One' })).json as any).tenant.id as string;
  const t2 = ((await call('POST', '/tenants', owner, undefined, { name: 'Sync Org Two', primaryFramework: 'CMMC_L2' })).json as any).tenant.id as string;
  await call('POST', `/tenants/${t1}/members`, owner, t1, { userId: 'u_sync_analyst', email: 'analyst@test.mil', role: 'ASSESSOR' });

  const fetchMerged = async (token: string, cache: Tenant[] = []) => {
    const res = await call('GET', '/tenants', token);
    const list = parseServerTenants(res.json).filter((t) => t.id !== 'tenant_unrelated');
    return { list, result: mergeServerTenants(cache, list, NOW) };
  };

  const o = await fetchMerged(owner);
  assert(o.result.tenants.length === 2 && o.result.tenants.every((t) => t.serverBacked), 'the owner\'s response yields two server-backed tenants');
  assert(o.result.tenants.find((t) => t.id === t2)?.primaryFramework === 'CMMC_L2', 'tenant settings survive the round trip');
  assert(o.result.tenants.find((t) => t.id === t1)?.name === 'Sync Org One', 'tenant name survives the round trip');

  const a = await fetchMerged(analyst);
  assert(a.result.tenants.map((t) => t.id).join() === t1 && a.result.roleUpdates[t1] === 'ASSESSOR', 'the analyst gets only the tenant they were invited to, as ASSESSOR');

  // The UI derives canEdit from the synced role; the server enforces the same rule.
  for (const [who, token, res] of [['owner', owner, o], ['analyst', analyst, a]] as const) {
    for (const t of res.result.tenants) {
      const uiCanEdit = canRoleWrite(applyRoleSync({}, res.result)[t.id]);
      const put = await call('PUT', '/controls/AC.L1-3.1.1', token, t.id, { status: 'MET', implementationNotes: 'sync' });
      assert((put.status === 200) === uiCanEdit, `${who} in ${t.name}: UI canEdit=${uiCanEdit} matches server (${put.status})`);
    }
  }

  // Cache poisoned with a self-granted owner role, then synced.
  const poisoned = applyRoleSync({ [t1]: 'TENANT_OWNER' }, a.result);
  assert(poisoned[t1] === 'ASSESSOR' && !canRoleWrite(poisoned[t1]), 'a locally edited cache that claims TENANT_OWNER is corrected back to the server role');

  // Revocation round trip: analyst removed by being demoted to nothing is not possible via the API, so simulate the
  // switch of accounts instead: the owner's cache synced with the analyst's response.
  const switched = mergeServerTenants(o.result.tenants, a.list, NOW);
  assert(switched.tenants.map((t) => t.id).join() === t1 && switched.removedTenantIds.includes(t2), "signing in as another user drops the previous user's tenants (not theirs)");
  assert(applyRoleSync({ [t1]: 'TENANT_OWNER', [t2]: 'TENANT_OWNER' }, switched)[t2] === undefined, 'and their cached roles');
}

async function run() {
  pureTests();
  await new Promise((r) => setTimeout(r, 500));
  await contractTests();

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
