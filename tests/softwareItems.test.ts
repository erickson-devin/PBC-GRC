import './testEnv';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { TABLES_SQL, RLS_TENANT_TABLES, RLS_PROGRAM_TABLES, buildRlsSql } from '../server/schema';
import { MAX_SOFTWARE_PER_TENANT, validateSoftwareInput } from '../server/softwareItems';

/**
 * Software inventory (issue #229, phase 1b): the software_items schema and its row-level security, the validation
 * rules, the CRUD API, role enforcement (VIEWER / ASSESSOR are read-only), tenant isolation and the asset link. Runs
 * against the in-memory store, which mirrors the PostgreSQL behaviour; the SQL itself is checked structurally here
 * and, against a live database, by `npm run db:verify-rls`.
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
  const start = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS software_items');
  const block = start < 0 ? '' : TABLES_SQL.slice(start, TABLES_SQL.indexOf('\n  );', start));
  assert(start > TABLES_SQL.indexOf('unq_enclave_assets_tenant_id'), 'S1 software_items is created after the enclave_assets composite key it references');
  assert(block.includes('FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE SET NULL (asset_id)') && block.includes('approved BOOLEAN,'), 'S2 the asset link is a composite, nullable foreign key and approved is tri-state');
  assert(RLS_TENANT_TABLES.some((t) => t.table === 'software_items' && t.tenantColumn === 'tenant_id') && !(RLS_PROGRAM_TABLES as readonly string[]).includes('software_items'), 'S3 software_items is a tenant table, not a program table');
  const rls = buildRlsSql();
  assert(rls.includes('ALTER TABLE software_items FORCE ROW LEVEL SECURITY;') && rls.includes('rls_software_items_tenant_isolation'), 'S3 FORCE ROW LEVEL SECURITY and the tenant isolation policy');

  // Every statement the store runs on this table is tenant-scoped, on top of the RLS policy.
  const src = fs.readFileSync(path.join(process.cwd(), 'server', 'softwareItems.ts'), 'utf8');
  const stmts = [...src.matchAll(/(SELECT|UPDATE|DELETE)[^`'"]*?software_items[^`'"]*/g)].map((m) => m[0]);
  assert(stmts.length >= 4 && stmts.every((s) => /tenant_id\s*=\s*\$/.test(s) || /\$\{sets/.test(s)), 'S4 every SELECT / UPDATE / DELETE filters by tenant_id', stmts);

  // Names, vendors and notes may describe a CUI boundary: the API's logs carry ids only.
  const routeSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'routes', 'software.ts'), 'utf8').replace(/\r\n/g, '\n');
  const logLines = routeSrc.split('\n').filter((l) => /console\.\w+\(/.test(l));
  assert(logLines.length > 0 && !logLines.some((l) => /name|version|vendor|notes/.test(l)), 'S5 no console line of the software routes contains name, version, vendor or notes', logLines);
}

function validationTests() {
  console.log('\n--- Validation ---');
  const ok = (b: unknown, partial = false) => validateSoftwareInput(b, partial);
  const created = ok({ name: '  Office  ', version: '2024', vendor: 'Acme', notes: 'line 1\nline 2', approved: true, assetId: 'abc-123' });
  assert(created.ok && created.value.name === 'Office' && created.value.approved === true && created.value.assetId === 'abc-123' && created.value.notes === 'line 1\nline 2', 'V1 a full body is accepted and trimmed');
  const noName = ok({ version: '1' });
  assert(!noName.ok && noName.error === 'Software name is required' && !ok({ name: '  ' }).ok, 'V2 a name is required on create');
  const longName = ok({ name: 'x'.repeat(256) });
  assert(!longName.ok && longName.error === 'Software name must be at most 255 characters', 'V3 the name is bounded', longName);
  const badApproved = ok({ name: 'a', approved: 'yes' });
  assert(!badApproved.ok && badApproved.error === 'Approved must be true, false or null' && ok({ name: 'a', approved: null }).ok && ok({ name: 'a', approved: false }).ok, 'V4 approved is true, false or null', badApproved);
  const badAsset = ok({ name: 'a', assetId: '../x' });
  assert(!badAsset.ok && badAsset.error === 'Asset id is invalid' && !ok({ name: 'a', assetId: 5 }).ok && ok({ name: 'a', assetId: null }).ok, 'V5 the asset id is null or a plain id', badAsset);
  const partial = ok({ approved: false }, true);
  assert(partial.ok && Object.keys(partial.value).join() === 'approved' && !ok({ name: '' }, true).ok, 'V6 a partial update returns only the fields sent and cannot blank the name', partial);
  assert(!ok({ name: 'a', version: 'x'.repeat(129) }).ok && !ok({ name: 'a', vendor: 'x'.repeat(256) }).ok && !ok({ name: 'a', notes: 'x'.repeat(4001) }).ok && !ok({ name: 'a\u0007' }).ok && !ok({ name: 'a', vendor: 7 }).ok && !ok('nope').ok && !ok(null).ok && !ok([]).ok, 'V7 length limits, control characters, types and the body shape');
  assert(MAX_SOFTWARE_PER_TENANT === 5000, 'the per-tenant limit is 5000');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_sw_owner');
  const tenant = (await call('POST', '/tenants', owner, undefined, { name: 'Software Org' })).body?.tenant?.id as string;
  const rival = person('u_sw_rival');
  const rivalTenant = (await call('POST', '/tenants', rival, undefined, { name: 'Software Rival Org' })).body?.tenant?.id as string;
  const sw = (t = tenant) => `/tenants/${t}/software`;

  console.log('\n--- CRUD ---');
  assert((await call('GET', sw(), owner, tenant)).body?.items?.length === 0, 'a new tenant starts with no software entries');
  assert((await call('GET', sw(), null, tenant)).status === 401, 'unauthenticated -> 401');

  const p1 = await call('POST', sw(), owner, tenant, { name: 'Office', version: '2024', vendor: 'Acme', approved: true });
  const office = p1.body?.item as Json;
  assert(p1.status === 201 && office.name === 'Office' && office.version === '2024' && office.vendor === 'Acme' && office.approved === true && office.assetId === null && office.tenantId === tenant, 'P1 create returns the entry, unlinked', p1.body);
  assert((await call('POST', sw(), owner, tenant, { version: '1' })).status === 400, 'a missing name -> 400');
  const unreviewed = await call('POST', sw(), owner, tenant, { name: 'Zip tool' });
  assert(unreviewed.body?.item?.approved === null && unreviewed.body?.item?.notes === '', 'an entry with no review decision stays null (not reviewed)', unreviewed.body);

  const asset = (await call('POST', `/tenants/${tenant}/assets`, owner, tenant, { hostName: 'SW-HOST', cmmcAssetCategory: 'CUI_ASSET' })).body?.asset as Json;
  const p2 = await call('POST', sw(), owner, tenant, { name: 'Antivirus', assetId: asset.id });
  assert(p2.status === 201 && p2.body?.item?.assetId === asset.id, 'P2 an entry can be linked to an asset of the same tenant', p2.body);
  const linkedId = p2.body?.item?.id as string;

  const rivalAsset = (await call('POST', `/tenants/${rivalTenant}/assets`, rival, rivalTenant, { hostName: 'RIVAL-HOST', cmmcAssetCategory: 'CUI_ASSET' })).body?.asset as Json;
  const p3 = await call('POST', sw(), owner, tenant, { name: 'Cross', assetId: rivalAsset.id });
  assert(p3.status === 400 && p3.body?.code === 'asset_not_found', "P3 another tenant's asset id is refused (asset_not_found)", p3);
  const p3b = await call('PUT', `${sw()}/${office.id}`, owner, tenant, { assetId: rivalAsset.id });
  assert(p3b.status === 400 && p3b.body?.code === 'asset_not_found', "P3 and on update", p3b);

  const p6 = await call('PUT', `${sw()}/${office.id}`, owner, tenant, { approved: false });
  assert(p6.status === 200 && p6.body?.item?.approved === false && p6.body?.item?.name === 'Office' && p6.body?.item?.vendor === 'Acme', 'P6 PUT changes only the fields sent', p6.body);
  assert((await call('PUT', `${sw()}/does-not-exist`, owner, tenant, { approved: true })).body?.code === 'not_found', 'P7 PUT unknown id -> not_found');
  assert((await call('PUT', `${sw()}/does-not-exist`, owner, tenant, { approved: true })).status === 404 && (await call('DELETE', `${sw()}/does-not-exist`, owner, tenant)).status === 404, 'P7 PUT / DELETE unknown id -> 404');
  assert((await call('PUT', `${sw()}/..%2Fevil`, owner, tenant, { approved: true })).status === 404, 'a malformed id -> 404');

  console.log('\n--- Roles: VIEWER and ASSESSOR are read-only ---');
  const listed = await call('GET', sw(), owner, tenant);
  const before = JSON.stringify(listed.body?.items);
  for (const role of ['VIEWER', 'ASSESSOR']) {
    const t = withRole(`u_sw_${role.toLowerCase()}`, tenant, role);
    const read = await call('GET', sw(), t, tenant);
    assert(read.status === 200 && read.body?.items?.length === 3, `P4 ${role} can read the inventory`, read.status);
    assert((await call('POST', sw(), t, tenant, { name: `${role}-NEW` })).status === 403, `P4 ${role} POST -> 403`);
    assert((await call('PUT', `${sw()}/${office.id}`, t, tenant, { approved: true })).status === 403, `P4 ${role} PUT -> 403`);
    assert((await call('DELETE', `${sw()}/${office.id}`, t, tenant)).status === 403, `P4 ${role} DELETE -> 403`);
  }
  assert(JSON.stringify((await call('GET', sw(), owner, tenant)).body?.items) === before, 'nothing changed after those attempts');

  console.log('\n--- Tenant isolation ---');
  assert((await call('GET', sw(rivalTenant), rival, rivalTenant)).body?.items?.length === 0, "P5 the rival tenant sees none of our entries");
  assert((await call('GET', sw(), rival, rivalTenant)).status === 403, "the URL tenant must match the active tenant");
  assert((await call('PUT', `${sw(rivalTenant)}/${office.id}`, rival, rivalTenant, { approved: true })).status === 404, "an entry id from another tenant is not found (PUT)");
  assert((await call('DELETE', `${sw(rivalTenant)}/${office.id}`, rival, rivalTenant)).status === 404, 'nor deletable (DELETE)');

  console.log('\n--- Asset link and delete ---');
  assert((await call('DELETE', `/tenants/${tenant}/assets/${asset.id}`, owner, tenant)).status === 200, 'the linked asset is deleted');
  const afterAsset = ((await call('GET', sw(), owner, tenant)).body?.items as Json[]).find((i) => i.id === linkedId);
  assert(!!afterAsset && afterAsset.assetId === null && afterAsset.name === 'Antivirus', 'P8 the entry stays and its asset link becomes null', afterAsset);

  const del = await call('DELETE', `${sw()}/${linkedId}`, owner, tenant);
  assert(del.status === 200 && del.body?.removed === linkedId, 'P9 DELETE removes an entry', del.body);
  assert((await call('GET', sw(), owner, tenant)).body?.items?.length === 2, 'P9 the list shrinks by one');
}

async function run() {
  schemaTests();
  validationTests();
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
