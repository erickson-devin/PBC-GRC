import './testEnv';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { TABLES_SQL, RLS_TENANT_TABLES, buildRlsSql } from '../server/schema';
import { MAX_BULK_ASSETS, validateAssetInput, validateDiscoveryItems } from '../server/assets';
import {
  CATEGORY_INFO,
  CMMC_ASSET_CATEGORIES,
  boundaryNarrative,
  emptyScopeSummary,
  parseAssetCategory,
  summarizeScope,
} from '../src/data/telemetry/assetScope';

/**
 * CMMC asset scoping: the enclave_assets schema and its row-level security, the validation rules, the CRUD API,
 * role enforcement (VIEWER / ASSESSOR are read-only), tenant isolation, bulk import, network discovery and the scope
 * counts that feed the SSP boundary summary. Runs against the in-memory store, which mirrors the PostgreSQL behaviour;
 * the SQL itself is checked structurally here and, against a live database, by `npm run db:verify-rls`.
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
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
/** A token that holds `role` in `tenant` through its roles claim. */
const withRole = (sub: string, tenant: string, role: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

function schemaTests() {
  console.log('--- Schema and row-level security ---');
  const start = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS enclave_assets');
  const block = TABLES_SQL.slice(start, TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_users'));
  assert(start > 0, 'enclave_assets is created by initDb');
  for (const col of ['tenant_id VARCHAR(64) NOT NULL', 'asset_name VARCHAR(255) NOT NULL', 'description TEXT', 'cmmc_category VARCHAR(32) NOT NULL', 'owner VARCHAR(255)']) {
    assert(block.includes(col), `column: ${col}`);
  }
  const check = /enclave_assets_category_check CHECK \(cmmc_category IN \(([^)]*)\)\)/.exec(block);
  const allowed = (check?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
  assert(
    allowed.length === 5 && ['CUI_ASSET', 'SECURITY_PROTECTION', 'CONTRACTOR_RISK', 'SPECIALIZED_ASSET', 'OUT_OF_SCOPE'].every((c) => allowed.includes(c)),
    'the database only accepts the five CMMC categories (including SPECIALIZED_ASSET)',
    allowed
  );
  assert(/CREATE UNIQUE INDEX IF NOT EXISTS unq_enclave_assets_name ON enclave_assets\(tenant_id, lower\(asset_name\)\)/.test(block), 'asset names are unique per tenant, case-insensitively');
  assert(RLS_TENANT_TABLES.some((t) => t.table === 'enclave_assets' && t.tenantColumn === 'tenant_id'), 'enclave_assets is in the set of tenant-isolated tables');
  const rls = buildRlsSql();
  assert(rls.includes('ALTER TABLE enclave_assets ENABLE ROW LEVEL SECURITY;') && rls.includes('ALTER TABLE enclave_assets FORCE ROW LEVEL SECURITY;'), 'ENABLE and FORCE ROW LEVEL SECURITY (the table owner is bound too)');
  const p = rls.indexOf('rls_enclave_assets_tenant_isolation');
  assert(p > 0 && /tenant_id = NULLIF\(current_setting\('app\.current_tenant_id', true\), ''\)/.test(rls.slice(p, p + 600)), "rows are visible only for the session's tenant (unset = nothing)");
  assert(!/enclave_assets[^;]*app\.current_user_id/.test(rls), 'no policy lets a user context widen access to asset rows');

  // Every statement the store runs on this table is tenant-scoped, on top of the RLS policy.
  const src = fs.readFileSync(path.join(process.cwd(), 'server', 'assets.ts'), 'utf8');
  const stmts = [...src.matchAll(/(SELECT|UPDATE|DELETE)[^`'"]*?enclave_assets[^`'"]*/g)].map((m) => m[0]);
  assert(stmts.length >= 4 && stmts.every((s) => /tenant_id\s*=\s*\$/.test(s) || /\$\{sets/.test(s)), 'every SELECT / UPDATE / DELETE filters by tenant_id', stmts);
  assert(/set_config\(\$1, \$2, true\)', \['app\.current_tenant_id', tenantId\]/.test(src), 'every PostgreSQL transaction sets app.current_tenant_id first');
}

function validationTests() {
  console.log('\n--- Validation ---');
  const ok = (b: unknown, partial = false) => validateAssetInput(b, partial);
  assert(ok({ hostName: 'srv-1', cmmcAssetCategory: 'CUI_ASSET' }).ok, 'a name and a category are enough');
  assert(!ok({ cmmcAssetCategory: 'CUI_ASSET' }).ok && !ok({ hostName: '  ', cmmcAssetCategory: 'CUI_ASSET' }).ok, 'a name is required');
  assert(!ok({ hostName: 'srv-1' }).ok, 'a CMMC category is required');
  assert(!ok({ hostName: 'srv-1', cmmcAssetCategory: 'SPA' }).ok && !ok({ hostName: 'srv-1', cmmcAssetCategory: 'cui_asset' }).ok, 'unknown categories are refused (the API does not guess)');
  assert(ok({ hostName: 'srv-1', cmmcAssetCategory: 'SPECIALIZED_ASSET' }).ok, 'SPECIALIZED_ASSET is accepted');
  assert(!ok({ hostName: 'x'.repeat(256), cmmcAssetCategory: 'CUI_ASSET' }).ok, 'name length is bounded');
  assert(!ok({ hostName: 'bad\u0000name', cmmcAssetCategory: 'CUI_ASSET' }).ok, 'control characters are refused');
  assert(!ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', ipAddress: '10.0.0.1; DROP TABLE' }).ok, 'an address with unexpected characters is refused');
  assert(!ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', complianceScore: 101 }).ok && !ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', complianceScore: 5.5 }).ok, 'the compliance score is a whole number from 0 to 100');
  assert(!ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', status: 'BROKEN' }).ok, 'status must be a known value');
  assert(!ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', owner: 7 }).ok, 'owner must be text');
  assert(!ok('nope').ok && !ok(null).ok && !ok([]).ok, 'the body must be an object');
  const aliased = ok({ hostName: 'a', cmmcAssetCategory: 'CUI_ASSET', description: 'via alias' });
  assert(aliased.ok && aliased.value.notes === 'via alias', 'description is accepted as an alias of notes');
  const partial = ok({ owner: 'Ops' }, true);
  assert(partial.ok && Object.keys(partial.value).join() === 'owner', 'a partial update returns only the fields sent');
  assert(!ok({ hostName: '' }, true).ok, 'a partial update cannot blank the name');
  assert(!validateDiscoveryItems({ items: [] }).ok && !validateDiscoveryItems({}).ok, 'discovery needs a non-empty list');
  assert(!validateDiscoveryItems({ items: [{ macAddress: '', ipAddress: '', agentId: 'a' }] }).ok, 'a discovered device needs a MAC or an IP');
  assert(!validateDiscoveryItems({ items: [{ macAddress: '00:11:22:33:44:55' }] }).ok, 'a discovered device needs an agent id');
}

function scopeTests() {
  console.log('\n--- Scope summary (feeds the SSP boundary) ---');
  assert(CMMC_ASSET_CATEGORIES.length === 5 && CMMC_ASSET_CATEGORIES.every((c) => c in CATEGORY_INFO), 'all five categories have labels');
  assert(CATEGORY_INFO.CONTRACTOR_RISK.label === 'Contractor Risk Managed Asset (CRMA)', 'CRMA is spelled out in full');
  assert(CATEGORY_INFO.SPECIALIZED_ASSET.label === 'Specialized Asset (SA)' && CATEGORY_INFO.SECURITY_PROTECTION.label === 'Security Protection Asset (SPA)', 'SA and SPA are spelled out');
  assert(parseAssetCategory('Contractor Risk') === 'CONTRACTOR_RISK' && parseAssetCategory('spa') === 'SECURITY_PROTECTION' && parseAssetCategory('specialized') === 'SPECIALIZED_ASSET' && parseAssetCategory('out of scope') === 'OUT_OF_SCOPE' && parseAssetCategory('CUI') === 'CUI_ASSET', 'CSV category cells are understood, including Specialized');
  assert(parseAssetCategory('') === null && parseAssetCategory('banana') === null, 'an unrecognised category is null, never silently CUI');

  const s = summarizeScope([
    { cmmcAssetCategory: 'CUI_ASSET', discoveryStatus: 'ACTIVE' },
    { cmmcAssetCategory: 'CUI_ASSET', discoveryStatus: 'ACTIVE' },
    { cmmcAssetCategory: 'SECURITY_PROTECTION', discoveryStatus: 'ACTIVE' },
    { cmmcAssetCategory: 'SPECIALIZED_ASSET', discoveryStatus: 'ACTIVE' },
    { cmmcAssetCategory: 'OUT_OF_SCOPE', discoveryStatus: 'ACTIVE' },
    { cmmcAssetCategory: 'CONTRACTOR_RISK', discoveryStatus: 'UNCONFIRMED_DISCOVERY' },
    { cmmcAssetCategory: 'CUI_ASSET', discoveryStatus: 'DECOMMISSIONED' },
  ]);
  assert(s.byCategory.CUI_ASSET === 2 && s.byCategory.SECURITY_PROTECTION === 1 && s.byCategory.SPECIALIZED_ASSET === 1 && s.byCategory.OUT_OF_SCOPE === 1 && s.byCategory.CONTRACTOR_RISK === 0, 'counts per category', s.byCategory);
  assert(s.inScope === 4, 'in scope = CUI + SPA + CRMA + SA (out-of-scope excluded)', s.inScope);
  assert(s.unconfirmed === 1 && s.byCategory.CONTRACTOR_RISK === 0, 'a discovered, unclassified asset is NOT counted in its placeholder category');
  assert(s.decommissioned === 1 && s.total === 6, 'decommissioned assets are excluded from every count', s);
  const text = boundaryNarrative(s);
  assert(/4 in-scope assets: 2 CUI Assets, 1 Security Protection Asset \(SPA\), 0 Contractor Risk Managed Assets \(CRMA\) and 1 Specialized Asset \(SA\)\./.test(text), 'the narrative states the counts', text);
  assert(/1 asset is documented as out of scope\./.test(text) && /1 discovered asset has not yet been classified and is excluded/.test(text), 'the narrative covers out-of-scope and unclassified assets', text);
  assert(/boundary has not been defined/.test(boundaryNarrative(emptyScopeSummary())), 'with no assets the narrative says the boundary is undefined');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_as_owner');
  const tenant = (await call('POST', '/tenants', owner, undefined, { name: 'Assets Org' })).body?.tenant?.id as string;
  const rival = person('u_as_rival');
  const rivalTenant = (await call('POST', '/tenants', rival, undefined, { name: 'Rival Org' })).body?.tenant?.id as string;
  const path = (t = tenant) => `/tenants/${t}/assets`;

  console.log('\n--- CRUD ---');
  assert((await call('GET', path(), owner, tenant)).body?.assets?.length === 0, 'a new tenant starts with NO assets (no seeded fake inventory)');
  assert((await call('GET', path(), null, tenant)).status === 401, 'unauthenticated -> 401');

  const created = await call('POST', path(), owner, tenant, { hostName: 'DB-PRIMARY', description: 'Primary CUI database', cmmcAssetCategory: 'CUI_ASSET', owner: 'Data Platform', ipAddress: '10.0.1.5', osProfile: 'rhel9' });
  const db = created.body?.asset as Json;
  assert(created.status === 201 && db.hostName === 'DB-PRIMARY' && db.notes === 'Primary CUI database' && db.owner === 'Data Platform' && db.cmmcAssetCategory === 'CUI_ASSET', 'create returns the asset (description maps to notes)', created.body);
  assert(db.tenantId === tenant && /^[0-9a-f-]{36}$/.test(db.id) && db.discoveryStatus === 'ACTIVE' && db.status === 'NEVER_SCANNED' && db.sourceOrigin === 'MANUAL_ENTRY', 'server-generated id, tenant and defaults');
  for (const [name, cat] of [['FW-EDGE', 'SECURITY_PROTECTION'], ['QA-LAPTOP', 'CONTRACTOR_RISK'], ['CNC-MILL-01', 'SPECIALIZED_ASSET'], ['GUEST-WIFI', 'OUT_OF_SCOPE']] as const) {
    assert((await call('POST', path(), owner, tenant, { hostName: name, cmmcAssetCategory: cat })).status === 201, `create ${cat}`);
  }
  const dup = await call('POST', path(), owner, tenant, { hostName: 'db-primary', cmmcAssetCategory: 'CUI_ASSET' });
  assert(dup.status === 409 && dup.body?.code === 'duplicate', 'a duplicate name (any case) -> 409');
  assert((await call('POST', path(), owner, tenant, { hostName: 'X', cmmcAssetCategory: 'NOPE' })).status === 400, 'an invalid category -> 400');
  assert((await call('POST', path(), owner, tenant, { cmmcAssetCategory: 'CUI_ASSET' })).status === 400, 'a missing name -> 400');

  const listed = await call('GET', path(), owner, tenant);
  assert(listed.body?.assets?.length === 5, 'list returns the five assets', listed.body?.assets?.length);
  const sum = listed.body?.summary as Json;
  assert(sum.total === 5 && sum.inScope === 4 && sum.byCategory.CUI_ASSET === 1 && sum.byCategory.SPECIALIZED_ASSET === 1 && sum.byCategory.CONTRACTOR_RISK === 1 && sum.byCategory.OUT_OF_SCOPE === 1, 'the list carries the scope summary', sum);
  assert(JSON.stringify((await call('GET', path() + '/summary', owner, tenant)).body?.summary) === JSON.stringify(sum), '/summary matches');

  const upd = await call('PUT', `${path()}/${db.id}`, owner, tenant, { cmmcAssetCategory: 'SPECIALIZED_ASSET', owner: 'OT team' });
  assert(upd.status === 200 && upd.body?.asset.cmmcAssetCategory === 'SPECIALIZED_ASSET' && upd.body?.asset.owner === 'OT team' && upd.body?.asset.hostName === 'DB-PRIMARY' && upd.body?.asset.notes === 'Primary CUI database', 'PUT changes only the fields sent');
  assert((await call('PUT', `${path()}/${db.id}`, owner, tenant, { hostName: 'fw-edge' })).status === 409, 'renaming onto an existing name -> 409');
  assert((await call('PUT', `${path()}/${db.id}`, owner, tenant, { cmmcAssetCategory: 'NOPE' })).status === 400, 'PUT validates too');
  assert((await call('PUT', `${path()}/${db.id}`, owner, tenant, { complianceScore: 87, status: 'NON_COMPLIANT', lastScannedAt: '2026-01-01T00:00:00Z' })).body?.asset.complianceScore === 87, 'scan results can be recorded');
  assert((await call('PUT', `${path()}/does-not-exist`, owner, tenant, { owner: 'x' })).status === 404, 'PUT unknown id -> 404');
  assert((await call('PUT', `${path()}/..%2Fevil`, owner, tenant, { owner: 'x' })).status === 404, 'a malformed id -> 404');

  const gone = (listed.body?.assets as Json[]).find((a) => a.hostName === 'GUEST-WIFI')!;
  assert((await call('DELETE', `${path()}/${gone.id}`, owner, tenant)).status === 200, 'DELETE removes an asset');
  assert((await call('DELETE', `${path()}/${gone.id}`, owner, tenant)).status === 404, 'deleting it again -> 404');
  assert((await call('GET', path(), owner, tenant)).body?.assets?.length === 4, 'four assets remain');

  console.log('\n--- Roles: VIEWER and ASSESSOR are read-only ---');
  const before = JSON.stringify((await call('GET', path(), owner, tenant)).body?.assets);
  const target = db.id as string;
  for (const role of ['VIEWER', 'ASSESSOR']) {
    const t = withRole(`u_as_${role.toLowerCase()}`, tenant, role);
    const read = await call('GET', path(), t, tenant);
    assert(read.status === 200 && read.body?.assets?.length === 4 && read.body?.summary.total === 4, `${role} can read the inventory and summary`);
    assert((await call('GET', path() + '/summary', t, tenant)).status === 200, `${role} can read /summary`);
    const attempts: Array<[string, string, unknown]> = [
      ['POST', path(), { hostName: `${role}-NEW`, cmmcAssetCategory: 'CUI_ASSET' }],
      ['POST', path() + '/bulk', { assets: [{ hostName: `${role}-BULK`, cmmcAssetCategory: 'CUI_ASSET' }] }],
      ['POST', path() + '/discovery', { items: [{ macAddress: '00:11:22:33:44:55', ipAddress: '10.9.9.9', agentId: 'a' }] }],
      ['PUT', `${path()}/${target}`, { cmmcAssetCategory: 'OUT_OF_SCOPE' }],
      ['DELETE', `${path()}/${target}`, undefined],
    ];
    for (const [method, p, body] of attempts) {
      const r = await call(method, p, t, tenant, body);
      assert(r.status === 403, `${role} ${method} ${p.replace(tenant, ':id').replace(target, ':asset')} -> 403`, r.status);
    }
  }
  assert(JSON.stringify((await call('GET', path(), owner, tenant)).body?.assets) === before, 'nothing changed after all of those attempts');
  const msp = withRole('u_as_msp', tenant, 'MSP_ADMIN');
  assert((await call('POST', path(), msp, tenant, { hostName: 'MSP-ADDED', cmmcAssetCategory: 'CONTRACTOR_RISK' })).status === 201, 'an MSP_ADMIN can write');

  console.log('\n--- Tenant isolation ---');
  assert((await call('GET', path(), rival, tenant)).status === 403, "another tenant's owner cannot list this tenant's assets (x-tenant-id they do not belong to)");
  assert((await call('GET', path(), rival, rivalTenant)).status === 403, 'and the URL tenant must match the active tenant');
  assert((await call('GET', path(rivalTenant), rival, rivalTenant)).body?.assets?.length === 0, 'the rival tenant sees none of our assets');
  assert((await call('PUT', `${path(rivalTenant)}/${target}`, rival, rivalTenant, { owner: 'pwned' })).status === 404, "an asset id from another tenant is not found under the rival's own tenant (PUT)");
  assert((await call('DELETE', `${path(rivalTenant)}/${target}`, rival, rivalTenant)).status === 404, 'nor deletable (DELETE)');
  assert((await call('POST', path(rivalTenant), rival, rivalTenant, { hostName: 'DB-PRIMARY', cmmcAssetCategory: 'CUI_ASSET' })).status === 201, 'the same asset name may exist in another tenant');
  assert((await call('POST', path(), rival, rivalTenant, { hostName: 'CROSS', cmmcAssetCategory: 'CUI_ASSET' })).status === 403, 'writing to our URL while acting as the rival tenant -> 403');
  assert((await call('GET', path(), owner, tenant)).body?.assets.find((a: Json) => a.id === target)?.owner === 'OT team', 'our asset is untouched');
  assert(((await call('GET', path(rivalTenant), rival, rivalTenant)).body?.assets as Json[]).every((a) => a.tenantId === rivalTenant), "every row the rival sees carries the rival's tenant id");

  console.log('\n--- Bulk import ---');
  const bulkTenant = (await call('POST', '/tenants', person('u_as_bulk'), undefined, { name: 'Bulk Org' })).body?.tenant?.id as string;
  const bulkOwner = person('u_as_bulk');
  const bp = path(bulkTenant) + '/bulk';
  const bulk = await call('POST', bp, bulkOwner, bulkTenant, { assets: [
    { hostName: 'B-1', cmmcAssetCategory: 'CUI_ASSET', sourceOrigin: 'CSV_IMPORT' },
    { hostName: 'B-2', cmmcAssetCategory: 'SPECIALIZED_ASSET', sourceOrigin: 'CSV_IMPORT' },
    { hostName: 'b-1', cmmcAssetCategory: 'CUI_ASSET' },
  ] });
  assert(bulk.status === 201 && bulk.body?.created.length === 2 && bulk.body?.skipped.length === 1 && bulk.body?.skipped[0].index === 2, 'a duplicate row is skipped and reported by index, the others land', bulk.body);
  const bad = await call('POST', bp, bulkOwner, bulkTenant, { assets: [{ hostName: 'OK-1', cmmcAssetCategory: 'CUI_ASSET' }, { hostName: 'BAD', cmmcAssetCategory: 'NOPE' }] });
  assert(bad.status === 400 && bad.body?.index === 1, 'a malformed row rejects the whole request (reported by index)');
  assert((await call('GET', path(bulkTenant), bulkOwner, bulkTenant)).body?.assets.length === 2, '...and nothing from it was stored');
  assert((await call('POST', bp, bulkOwner, bulkTenant, { assets: Array.from({ length: MAX_BULK_ASSETS + 1 }, (_, i) => ({ hostName: `N-${i}`, cmmcAssetCategory: 'CUI_ASSET' })) })).status === 400, `more than ${MAX_BULK_ASSETS} rows -> 400`);
  assert((await call('POST', bp, bulkOwner, bulkTenant, { assets: [] })).status === 400, 'an empty list -> 400');

  console.log('\n--- Network discovery ---');
  const disc = path(bulkTenant) + '/discovery';
  const batch = { items: [
    { agentId: 'sensor-1', hostName: 'ROGUE-1', ipAddress: '10.0.50.155', macAddress: '00:1A:2B:3C:4D:5E', osFingerprint: 'Linux', discoveredPorts: [22, 8080], connectionType: 'WIRELESS' },
    { agentId: 'sensor-1', ipAddress: '10.0.50.210', macAddress: 'B8:27:EB:4F:99:A1', discoveredPorts: [502], connectionType: 'ETHERNET' },
  ] };
  const first = await call('POST', disc, bulkOwner, bulkTenant, batch);
  assert(first.status === 200 && first.body?.newDiscoveredCount === 2 && first.body?.updatedExistingCount === 0, 'two new devices are discovered', first.body);
  const found = (await call('GET', path(bulkTenant), bulkOwner, bulkTenant)).body as Json;
  const rogue = (found.assets as Json[]).find((a) => a.hostName === 'ROGUE-1')!;
  assert(rogue.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && rogue.sourceOrigin === 'ACCRETION_DISCOVERY' && rogue.cmmcAssetCategory === 'CONTRACTOR_RISK' && rogue.accretionMetadata.discoveredPorts.length === 2, 'a new device is UNCONFIRMED, from the sensor, and defaults to CRMA');
  assert(found.summary.unconfirmed === 2 && found.summary.byCategory.CONTRACTOR_RISK === 0 && found.summary.total === 4, 'unconfirmed devices are not counted as CRMA in the boundary', found.summary);
  const again = await call('POST', disc, bulkOwner, bulkTenant, batch);
  assert(again.body?.newDiscoveredCount === 0 && again.body?.updatedExistingCount === 2, 'the same devices again are deduplicated by MAC / IP');
  assert((await call('GET', path(bulkTenant), bulkOwner, bulkTenant)).body?.assets.length === 4, 'no duplicates were created');
  const macOnly = await call('POST', disc, bulkOwner, bulkTenant, { items: [{ agentId: 'sensor-1', ipAddress: '10.99.99.99', macAddress: '00:1a:2b:3c:4d:5e' }] });
  assert(macOnly.body?.updatedExistingCount === 1, 'matching is by MAC regardless of case or a changed IP');
  const classified = await call('PUT', `${path(bulkTenant)}/${rogue.id}`, bulkOwner, bulkTenant, { cmmcAssetCategory: 'SPECIALIZED_ASSET', discoveryStatus: 'ACTIVE' });
  assert(classified.status === 200, 'an administrator classifies the discovered device');
  const after = (await call('GET', path(bulkTenant), bulkOwner, bulkTenant)).body as Json;
  assert(after.summary.unconfirmed === 1 && after.summary.byCategory.SPECIALIZED_ASSET === 2 && after.summary.inScope === 3, 'it now counts in its category', after.summary);
  const reingest = await call('POST', disc, bulkOwner, bulkTenant, batch);
  assert((await call('GET', `${path(bulkTenant)}`, bulkOwner, bulkTenant)).body?.assets.find((a: Json) => a.id === rogue.id)?.cmmcAssetCategory === 'SPECIALIZED_ASSET' && reingest.status === 200, 'a later sensor sweep never resets an administrator\'s classification');
  assert((await call('POST', disc, withRole('u_as_v2', bulkTenant, 'VIEWER'), bulkTenant, batch)).status === 403, 'a viewer cannot ingest discovery results');
  assert((await call('POST', disc, bulkOwner, bulkTenant, { items: [{ macAddress: 'zz;zz', ipAddress: '1', agentId: 'a' }] })).status === 400, 'a malformed device -> 400');
}

async function run() {
  schemaTests();
  validationTests();
  scopeTests();
  await apiTests();

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
