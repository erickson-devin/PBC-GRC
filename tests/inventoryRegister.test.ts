import './testEnv';
import fs from 'fs';
import path from 'path';
import { server } from '../server/index';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { CUI_CATEGORY_IDS } from '../server/inventory/cuiCategories';
import { MAX_BATCH, MAX_TOOLS_PER_TENANT } from '../src/types/inventory';

/**
 * The Tools and Services register (issues #239, #248, #249) over HTTP: tools and vendors CRUD with stale-write protection, the validation
 * rules, role enforcement (VIEWER / ASSESSOR read-only, the annual cost stripped for them, in the history too), tenant isolation, the insert-only
 * batch (survey seed, catalog quick add), the recovery order, the vendor link, the history (digests only) and the tool usage across programs.
 * Source checks: every statement is tenant-scoped and no log line names a tool, vendor, mission, note or cost. Runs against the in-memory store;
 * the SQL itself is checked structurally in tests/dbSchema.test.ts and, against a live database, by `npm run db:verify-rls`.
 * Boots the server on port 8080: run it alone.
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
/** A token that holds `role` in `tenant` through its roles claim. */
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
  return { status: res.status, body: json, text };
}

function sourceTests() {
  origLog('--- Source: tenant scoping and logging ---');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  // template expressions are blanked first so a quote inside one cannot cut a statement short
  const statements = (src: string) => [...src.replace(/\$\{[^}]*\}/g, '${}').replace(/interval '1 millisecond'/g, 'interval 1ms').matchAll(/(SELECT|UPDATE|DELETE)[^`'"]*?inventory_\w+[^`'"]*/g)].map((m) => m[0]);
  const store = statements(read('server', 'inventory', 'registerStore.ts'));
  const events = statements(read('server', 'inventory', 'events.ts'));
  assert(store.length >= 12 && store.every((s) => /tenant_id\s*=\s*\$/.test(s)), 'IR-S1 every SELECT / UPDATE / DELETE of registerStore.ts filters by tenant_id', store.filter((s) => !/tenant_id\s*=\s*\$/.test(s)));
  assert(events.length >= 2 && events.every((s) => /tenant_id\s*=\s*\$/.test(s)), 'IR-S1 and so does events.ts', events);
  for (const file of ['inventory.ts', 'programInventory.ts']) {
    const lines = read('server', 'routes', file).split('\n').filter((l) => /console\.\w+\(/.test(l));
    assert(lines.length > 0 && !lines.some((l) => /name|vendor|mission|notes|services|cost/.test(l)), `IR-S2 no console line of routes/${file} contains name, vendor, mission, notes, services or cost`, lines);
  }
  assert(/router\.use\('\/:tenantId\/inventory', tenantInventoryRouter\)/.test(read('server', 'routes', 'tenants.ts')) && /router\.use\('\/program-inventory', authMiddleware, programContext, programInventoryRouter\)/.test(read('server', 'routes', 'api.ts')), 'IR-S3 the two routers are mounted behind the tenant and program middleware');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  process.env.PLATFORM_ADMIN_EMAILS = 'u_ir_owner@test.mil'; // a platform administrator may enable the frameworks of the tenant it creates
  const owner = person('u_ir_owner');
  const frameworks = { primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'] };
  const T = (await call('POST', '/tenants', owner, undefined, { name: 'Register Org', ...frameworks })).body?.tenant?.id as string;
  const rival = person('u_ir_rival');
  const U = (await call('POST', '/tenants', rival, undefined, { name: 'Register Rival Org', ...frameworks })).body?.tenant?.id as string;
  const inv = (t = T) => `/tenants/${t}/inventory`;
  const viewer = withRole('u_ir_viewer', T, 'VIEWER');
  const assessor = withRole('u_ir_assessor', T, 'ASSESSOR');
  const list = async (token = owner, t = T) => (await call('GET', `${inv(t)}/tools`, token, t)).body?.tools as Json[];

  origLog('\n--- Tools: create, validate, roles ---');
  assert((await call('GET', `${inv()}/tools`, owner, T)).body?.tools?.length === 0 && (await call('GET', `${inv()}/tools`, null, T)).status === 401, 'a new tenant starts with an empty register; unauthenticated -> 401');
  assert((await call('GET', `${inv(U)}/tools`, rival, U)).status === 200 && (await call('GET', `${inv()}/tools`, rival, T)).status === 403, 'the URL tenant must be a tenant the caller belongs to');
  const ir1 = await call('POST', `${inv()}/tools`, owner, T, { name: 'Falcon MARK', deployment: 'CLOUD', assetCategory: 'SECURITY_PROTECTION', endUsers: 40, privilegedUsers: 3 });
  const A = ir1.body?.tool as Json;
  assert(ir1.status === 201 && A.origin === 'MANUAL' && A.deployment === 'CLOUD' && A.endUsers === 40 && A.privilegedUsers === 3 && A.fedrampStatus === 'UNKNOWN' && A.recoveryRank === null && A.vendorId === null && A.tenantId === T && A.annualCostCents === null, 'IR1 a tool is created (origin MANUAL, FedRAMP unknown, unranked, no vendor, no cost)', ir1.body);
  const ir2 = await call('POST', `${inv()}/tools`, owner, T, { name: 'falcon mark' });
  assert(ir2.status === 409 && ir2.body?.code === 'duplicate_name' && !ir2.text.includes('mark'), 'IR2 the same name ignoring case -> 409 duplicate_name (the name is not echoed)', ir2);
  const ir3 = await call('POST', `${inv()}/tools`, owner, T, { name: 'Bad deployment', deployment: 'MOON-MARK' });
  assert(ir3.status === 400 && ir3.body?.code === 'invalid' && String(ir3.body?.error).includes('deployment') && !ir3.text.includes('MARK'), 'IR3 an unknown deployment -> 400 invalid naming the field, never echoing the value', ir3);
  for (const bad of [-1, 1.5, '40']) {
    assert((await call('POST', `${inv()}/tools`, owner, T, { name: 'Bad count', endUsers: bad })).status === 400, `IR4 endUsers ${JSON.stringify(bad)} -> 400`);
  }
  assert((await call('POST', `${inv()}/tools`, owner, T, { name: 'x'.repeat(256) })).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', notes: 'a\u0007b' })).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, {})).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', crmOnFile: 'yes' })).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', assetCategory: 'NOPE' })).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', fedrampStatus: 'GOLD' })).status === 400, 'IR4b a long name, a control character, a missing name, a non-boolean flag, an unknown category and an unknown FedRAMP status -> 400');
  assert((await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', fedrampVerifiedOn: '2026-13-01' })).status === 400 && (await call('POST', `${inv()}/tools`, owner, T, { name: 'ok', recoveryRank: 1, origin: 'CATALOG' })).body?.tool?.recoveryRank === null, 'IR4c a calendar date is checked, and recoveryRank / origin in a body are ignored');
  for (const [label, token] of [['VIEWER', viewer], ['ASSESSOR', assessor]] as const) {
    assert((await call('POST', `${inv()}/tools`, token, T, { name: `${label}-NEW` })).status === 403, `IR5 ${label} POST -> 403`);
    assert((await call('PUT', `${inv()}/tools/${A.id}`, token, T, { mission: 'x', expectedUpdatedAt: A.updatedAt })).status === 403, `IR5 ${label} PUT -> 403`);
    assert((await call('DELETE', `${inv()}/tools/${A.id}`, token, T)).status === 403, `IR5 ${label} DELETE -> 403`);
    const read = await call('GET', `${inv()}/tools`, token, T);
    assert(read.status === 200 && (read.body?.tools as Json[]).some((t) => t.id === A.id), `IR5 ${label} can read the register`);
  }

  origLog('\n--- Tools: stale-write protection ---');
  const ir6a = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'Endpoint protection agent', expectedUpdatedAt: A.updatedAt });
  const A2 = ir6a.body?.tool as Json;
  assert(ir6a.status === 200 && ir6a.body?.changed === true && A2.mission === 'Endpoint protection agent' && A2.name === 'Falcon MARK' && Date.parse(A2.updatedAt) > Date.parse(A.updatedAt), 'IR6 PUT with the current stamp -> 200 changed true, only the fields sent change', ir6a.body);
  const ir6b = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'Other text', expectedUpdatedAt: A.updatedAt });
  assert(ir6b.status === 409 && ir6b.body?.code === 'stale_write' && ir6b.body?.current?.updatedAt === A2.updatedAt && !ir6b.text.includes('MARK') && !ir6b.text.includes('Endpoint'), 'IR6 PUT with the previous stamp -> 409 stale_write with the current stamp, and no text', ir6b);
  const same = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'Endpoint protection agent', expectedUpdatedAt: A2.updatedAt });
  assert(same.status === 200 && same.body?.changed === false && same.body?.tool?.updatedAt === A2.updatedAt, 'a PUT that changes nothing -> changed false and the stamp stays');
  assert((await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'x' })).body?.code === 'invalid_expected_updated_at' && (await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'x', expectedUpdatedAt: null })).status === 400 && (await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { mission: 'x', expectedUpdatedAt: 'soon' })).status === 400, 'IR7 a PUT without a usable expectedUpdatedAt -> 400 invalid_expected_updated_at (null is refused too)');
  assert((await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { name: '', expectedUpdatedAt: A2.updatedAt })).status === 400 && (await call('PUT', `${inv()}/tools/no-such-tool`, owner, T, { mission: 'x', expectedUpdatedAt: A2.updatedAt })).status === 404 && (await call('PUT', `${inv()}/tools/..%2Fevil`, owner, T, { mission: 'x', expectedUpdatedAt: A2.updatedAt })).status === 404, 'a blank name -> 400, an unknown or malformed id -> 404');

  origLog('\n--- Tenant isolation ---');
  assert((await call('GET', `${inv(U)}/tools`, rival, U)).body?.tools?.length === 0, 'IR8 the rival tenant sees none of our tools');
  assert((await call('PUT', `${inv(U)}/tools/${A.id}`, rival, U, { mission: 'x', expectedUpdatedAt: A2.updatedAt })).status === 404 && (await call('DELETE', `${inv(U)}/tools/${A.id}`, rival, U)).status === 404 && (await call('GET', `${inv(U)}/tools/${A.id}/usage`, rival, U)).status === 404, "IR8 a tool id of another tenant is not found (PUT, DELETE, usage)");

  origLog('\n--- Batch: insert-only seeding ---');
  const items = [{ name: 'Okta', seedKey: 'survey:identityProvider' }, { name: 'okta' }, { name: 'Splunk', seedKey: 'catalog:splunk-enterprise' }];
  const b1 = await call('POST', `${inv()}/tools/batch`, owner, T, { items });
  const created = b1.body?.created as Json[];
  assert(b1.status === 200 && created.length === 2 && JSON.stringify(b1.body?.skipped) === JSON.stringify([{ index: 1, reason: 'duplicate_name' }]) && created[0].origin === 'SURVEY' && created[1].origin === 'CATALOG' && created[0].seedKey === 'survey:identityProvider', 'IR9 a batch creates what does not clash and skips the same name (also within the batch); origin comes from the seed key', b1.body);
  const b2 = await call('POST', `${inv()}/tools/batch`, owner, T, { items });
  assert(b2.status === 200 && b2.body?.created.length === 0 && JSON.stringify((b2.body?.skipped as Json[]).map((s) => s.reason)) === JSON.stringify(['duplicate_seed', 'duplicate_name', 'duplicate_seed']), 'IR9 repeating it creates nothing: duplicate_seed, duplicate_name, duplicate_seed', b2.body);
  const okta = created[0];
  const tooMany = await call('POST', `${inv()}/tools/batch`, owner, T, { items: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ name: `Bulk ${i}` })) });
  assert(tooMany.status === 400 && tooMany.body?.code === 'invalid' && (await list()).length === 4, 'IR10 more than MAX_BATCH items -> 400 and nothing is written');
  const badItem = await call('POST', `${inv()}/tools/batch`, owner, T, { items: [{ name: 'Fine' }, { name: 'Bad', deployment: 'NOPE-MARK' }] });
  assert(badItem.status === 400 && badItem.body?.index === 1 && !badItem.text.includes('MARK') && (await list()).length === 4, 'a bad item -> 400 with its index, never its value, and nothing is written');
  assert((await call('POST', `${inv()}/tools/batch`, owner, T, { items: [] })).status === 400 && (await call('POST', `${inv()}/tools/batch`, owner, T, {})).status === 400 && (await call('POST', `${inv()}/tools/batch`, owner, T, { items: [{ name: 'Seeded', seedKey: 'weird:key' }] })).status === 400 && (await call('POST', `${inv()}/tools/batch`, viewer, T, { items })).status === 403, 'an empty batch, no list, a bad seed key -> 400; a VIEWER -> 403');

  origLog('\n--- Recovery order ---');
  const ranked = async () => (await list()).filter((t) => t.recoveryRank !== null).sort((x, y) => x.recoveryRank - y.recoveryRank).map((t) => t.id);
  const o1 = await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [A.id, okta.id], expectedOrder: [] });
  assert(o1.status === 200 && JSON.stringify(o1.body?.order) === JSON.stringify([A.id, okta.id]) && JSON.stringify(await ranked()) === JSON.stringify([A.id, okta.id]) && (await list()).find((t) => t.id === A.id)?.recoveryRank === 1 && (await list()).find((t) => t.id === okta.id)?.recoveryRank === 2, 'IR11 {order:[A,B], expectedOrder:[]} -> 200, ranks 1 and 2');
  const o2 = await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [okta.id, A.id], expectedOrder: [] });
  assert(o2.status === 409 && o2.body?.code === 'stale_order' && JSON.stringify(o2.body?.current) === JSON.stringify([A.id, okta.id]) && JSON.stringify(await ranked()) === JSON.stringify([A.id, okta.id]), 'IR11 a stale expectedOrder -> 409 stale_order with the current order, nothing changes', o2.body);
  const o3 = await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [okta.id, A.id], expectedOrder: [A.id, okta.id] });
  assert(o3.status === 200 && JSON.stringify(await ranked()) === JSON.stringify([okta.id, A.id]), 'IR11 the right expectedOrder -> 200');
  assert((await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [A.id, A.id], expectedOrder: [okta.id, A.id] })).status === 400 && (await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [A.id, 'no-such-tool'], expectedOrder: [okta.id, A.id] })).status === 400 && (await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [A.id] })).status === 400 && (await call('PUT', `${inv()}/tools/recovery-order`, viewer, T, { order: [], expectedOrder: [okta.id, A.id] })).status === 403, 'IR11 a duplicate id, an unknown id, a missing expectedOrder -> 400; a VIEWER -> 403');
  assert(JSON.stringify(await ranked()) === JSON.stringify([okta.id, A.id]), 'a refused order changes nothing');
  const o4 = await call('PUT', `${inv()}/tools/recovery-order`, owner, T, { order: [A.id], expectedOrder: [okta.id, A.id] });
  assert(o4.status === 200 && JSON.stringify(await ranked()) === JSON.stringify([A.id]) && (await list()).find((t) => t.id === okta.id)?.recoveryRank === null, 'a tool left out of the order becomes unranked');
  assert((await call('PUT', `${inv(U)}/tools/recovery-order`, rival, U, { order: [A.id], expectedOrder: [] })).status === 400, "another tenant's tool id cannot be ranked");

  origLog('\n--- Cost and renewal (#249) ---');
  const cur = (await list()).find((t) => t.id === A.id) as Json;
  const c1 = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { annualCostCents: 1250000, renewalDate: '2027-03-31', expectedUpdatedAt: cur.updatedAt });
  assert(c1.status === 200 && c1.body?.tool?.annualCostCents === 1250000 && c1.body?.tool?.renewalDate === '2027-03-31', 'IR12 the owner sets the cost (USD cents) and the renewal date', c1.body);
  const viewerTool = (await list(viewer)).find((t) => t.id === A.id) as Json;
  const assessorTool = (await list(assessor)).find((t) => t.id === A.id) as Json;
  const ownerTool = (await list(owner)).find((t) => t.id === A.id) as Json;
  assert(!('annualCostCents' in viewerTool) && !('annualCostCents' in assessorTool) && viewerTool.renewalDate === '2027-03-31' && ownerTool.annualCostCents === 1250000, 'IR12 the VIEWER and the ASSESSOR get no annualCostCents key but see the renewal date; the owner sees 1250000');
  assert(!(await call('GET', `${inv()}/tools`, viewer, T)).text.includes('1250000'), 'the cost is nowhere in a reader\'s response');
  assert((await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { annualCostCents: -1, expectedUpdatedAt: c1.body?.tool?.updatedAt })).status === 400 && (await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { renewalDate: '2027-02-30', expectedUpdatedAt: c1.body?.tool?.updatedAt })).status === 400 && (await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { annualCostCents: 12.5, expectedUpdatedAt: c1.body?.tool?.updatedAt })).status === 400 && (await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { annualCostCents: 100000000001, expectedUpdatedAt: c1.body?.tool?.updatedAt })).status === 400, 'IR12 a negative, fractional or too large cost and an impossible date -> 400');
  const costStamp = c1.body?.tool?.updatedAt as string;

  origLog('\n--- Vendors (#248) ---');
  const v0 = await call('POST', `${inv()}/vendors`, owner, T, { name: 'Falcon Corp', contractStart: '2026-06-01', contractEnd: '2026-01-01' });
  assert(v0.status === 400 && v0.body?.code === 'invalid', 'IR13 a contract end before its start -> 400', v0);
  const v1 = await call('POST', `${inv()}/vendors`, owner, T, { name: 'Falcon Corp', kind: 'CSP', services: 'Managed endpoint service', contractStart: '2026-01-01', contractEnd: '2028-12-31', renewalDate: '2028-10-01', fedrampStatus: 'MODERATE', fedrampReference: 'REF-1', fedrampVerifiedOn: '2026-10-01', crmOnFile: true });
  const V = v1.body?.vendor as Json;
  assert(v1.status === 201 && V.kind === 'CSP' && V.fedrampStatus === 'MODERATE' && V.crmOnFile === true && V.contractEnd === '2028-12-31' && V.fedrampVerifiedOn === '2026-10-01', 'IR13 a valid vendor -> 201', v1.body);
  assert((await call('POST', `${inv()}/vendors`, owner, T, { name: 'FALCON corp' })).body?.code === 'duplicate_name' && (await call('POST', `${inv()}/vendors`, owner, T, { name: 'X', kind: 'PIRATE' })).status === 400 && (await call('POST', `${inv()}/vendors`, viewer, T, { name: 'Nope' })).status === 403 && (await call('GET', `${inv()}/vendors`, viewer, T)).body?.vendors?.length === 1, 'a duplicate vendor name -> 409, an unknown kind -> 400, a VIEWER cannot add but can read');
  const vUp = await call('PUT', `${inv()}/vendors/${V.id}`, owner, T, { contractEnd: '2025-01-01', expectedUpdatedAt: V.updatedAt });
  assert(vUp.status === 400 && vUp.body?.code === 'invalid', 'a PUT that makes the contract end earlier than its start -> 400');
  const v2 = await call('PUT', `${inv()}/vendors/${V.id}`, owner, T, { lastReviewDate: '2026-11-01', expectedUpdatedAt: V.updatedAt });
  assert(v2.status === 200 && v2.body?.changed === true && v2.body?.vendor?.lastReviewDate === '2026-11-01', 'a vendor PUT with the current stamp -> 200');
  const v3 = await call('PUT', `${inv()}/vendors/${V.id}`, owner, T, { lastReviewDate: '2026-11-02', expectedUpdatedAt: V.updatedAt });
  assert(v3.status === 409 && v3.body?.code === 'stale_write' && v3.body?.current?.updatedAt === v2.body?.vendor?.updatedAt && !v3.text.includes('Falcon'), 'a vendor PUT with the previous stamp -> 409 stale_write, no text', v3);
  const link = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { vendorId: V.id, vendorName: 'Falcon Corp', expectedUpdatedAt: costStamp });
  assert(link.status === 200 && link.body?.tool?.vendorId === V.id, 'IR13 a tool PUT with vendorId -> 200');
  const vDel = await call('DELETE', `${inv()}/vendors/${V.id}`, owner, T);
  const afterVendor = (await list()).find((t) => t.id === A.id) as Json;
  assert(vDel.status === 200 && vDel.body?.removed === V.id && afterVendor.vendorId === null && afterVendor.vendorName === 'Falcon Corp' && (await call('DELETE', `${inv()}/vendors/${V.id}`, owner, T)).status === 404, 'IR13 deleting the vendor keeps the tool and nulls its vendorId (the free-text vendor name stays)');
  const vU = (await call('POST', `${inv(U)}/vendors`, rival, U, { name: 'Rival vendor' })).body?.vendor as Json;
  const stampNow = afterVendor.updatedAt as string;
  const foreign = await call('PUT', `${inv()}/tools/${A.id}`, owner, T, { vendorId: vU.id, expectedUpdatedAt: stampNow });
  assert(foreign.status === 404 && foreign.body?.code === 'vendor_not_found', "IR14 another tenant's vendor id -> 404 vendor_not_found (PUT)", foreign);
  assert((await call('POST', `${inv()}/tools`, owner, T, { name: 'Foreign link', vendorId: vU.id })).body?.code === 'vendor_not_found' && (await call('POST', `${inv()}/tools/batch`, owner, T, { items: [{ name: 'Foreign batch', vendorId: vU.id }] })).body?.code === 'vendor_not_found', 'IR14 and on create and in a batch');
  assert((await call('PUT', `${inv()}/vendors/${V.id}`, owner, T, { notes: 'x', expectedUpdatedAt: stampNow })).status === 404 && (await call('PUT', `${inv(U)}/vendors/${vU.id}`, owner, U, { notes: 'x', expectedUpdatedAt: stampNow })).status === 403, 'a deleted vendor -> 404; a tenant that is not ours -> 403');

  origLog('\n--- History (digests only) ---');
  const ev = await call('GET', `${inv()}/events?entityId=${A.id}`, owner, T);
  const evs = ev.body?.events as Json[];
  const actions = evs.map((e) => e.action);
  assert(ev.status === 200 && actions[actions.length - 1] === 'created' && actions[0] === 'updated' && actions.every((a) => a === 'created' || a === 'updated'), 'IR16 the history of a tool is newest first, ending with created', actions);
  const created0 = evs[evs.length - 1];
  assert(created0.fields.name?.sha256?.length === 64 && created0.fields.name.length === 11 && created0.fields.deployment === 'CLOUD' && created0.fields.endUsers === 40 && created0.fields.origin === 'MANUAL' && created0.entityKind === 'tool', 'IR16 fields.name is {sha256, length}; enum values and counts are plain', created0.fields);
  assert(!ev.text.includes('MARK') && !ev.text.includes('Endpoint') && !ev.text.includes('1250000'), 'IR16 the history holds no name, mission or cost value');
  const costEvent = evs.find((e) => 'annualCostCents' in e.fields);
  assert(costEvent?.fields.annualCostCents?.sha256?.length === 64, 'the owner sees the digest of the cost in the history');
  const viewerEvents = await call('GET', `${inv()}/events?entityId=${A.id}`, viewer, T);
  assert(viewerEvents.status === 200 && viewerEvents.body?.events.length === evs.length && !(viewerEvents.body?.events as Json[]).some((e) => 'annualCostCents' in e.fields) && !viewerEvents.text.includes('annualCostCents'), 'IR16 the VIEWER sees the same events without any annualCostCents key');
  const all = (await call('GET', `${inv()}/events?limit=3`, owner, T)).body?.events as Json[];
  assert(all.length === 3 && (await call('GET', `${inv()}/events?entityId=..%2Fx`, owner, T)).status === 400 && (await call('GET', `${inv(U)}/events?entityId=${A.id}`, rival, U)).body?.events.length === 0, 'the history can be limited, a malformed entityId -> 400, another tenant sees none');
  const orderEvents = ((await call('GET', `${inv()}/events?limit=200`, owner, T)).body?.events as Json[]).filter((e) => e.entityKind === 'order');
  assert(orderEvents.length >= 2 && orderEvents[0].action === 'order_changed' && orderEvents[0].fields.count === 1 && orderEvents[0].fields.order?.sha256?.length === 64 && !JSON.stringify(orderEvents).includes(A.id), 'the recovery order is recorded as a count and a digest, never as ids');

  origLog('\n--- Usage across programs ---');
  const mkProgram = async (name: string, frameworkId: string) => (await call('POST', `/tenants/${T}/programs`, owner, T, { name, frameworkId })).body?.program?.id as string;
  const P1 = await mkProgram('Register P1', 'CMMC_L2');
  const P2 = await mkProgram('Register P2', 'CMMC_L1');
  const l2 = getFrameworkControls('CMMC_L2').map((c) => c.id);
  const l1 = getFrameworkControls('CMMC_L1').map((c) => c.id);
  const cat = [...CUI_CATEGORY_IDS][0];
  assert(Boolean(P1) && Boolean(P2), 'two programs exist');
  const pi = (p: string) => (method: string, sub: string, body?: unknown, token = owner) => call(method, `/program-inventory${sub}`, token, T, body, p);
  const in1 = pi(P1);
  const in2 = pi(P2);
  assert((await in1('PATCH', '/tools', { add: [A.id] })).status === 200 && (await in2('PATCH', '/tools', { add: [A.id] })).status === 200, 'the tool is in the boundary of both programs');
  assert((await in1('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: l2[0], evidenceSource: true }, { controlId: l2[1], evidenceSource: false }], expectedControlIds: [] })).status === 200 && (await in2('PUT', `/tools/${A.id}/controls`, { controls: [{ controlId: l1[0], evidenceSource: false }], expectedControlIds: [] })).status === 200, 'it is linked to two controls in P1 and one in P2');
  const di = await in1('PUT', '/data-inventory', { handlesFci: true, categories: [{ categoryId: cat, tools: [{ toolId: A.id, stores: true, processes: false, transmits: false }] }], expectedUpdatedAt: null });
  assert(di.status === 200, 'and named in the data inventory of P1', di.body);
  const usage = await call('GET', `${inv()}/tools/${A.id}/usage`, viewer, T);
  assert(usage.status === 200 && JSON.stringify(usage.body) === JSON.stringify({ programs: 2, controlLinks: 3, cuiLinks: 1 }), 'IR17 usage -> {programs:2, controlLinks:3, cuiLinks:1}', usage.body);
  const mem = await call('GET', `${inv()}/tool-memberships`, viewer, T);
  const memberships = mem.body?.memberships as Json[];
  assert(mem.status === 200 && memberships.length >= 2 && memberships.find((m) => m.programId === P1)?.declared === true && JSON.stringify(memberships.find((m) => m.programId === P2)?.toolIds) === JSON.stringify([A.id]) && memberships.every((m) => typeof m.archived === 'boolean'), 'GET /tool-memberships lists the declared tools of every program', mem.body);
  assert((await call('GET', `${inv(U)}/tool-memberships`, rival, U)).body?.memberships.length === 0, 'another tenant has no memberships');

  origLog('\n--- Delete ---');
  const del = await call('DELETE', `${inv()}/tools/${A.id}`, owner, T);
  assert(del.status === 200 && del.body?.removed === A.id && !(await list()).some((t) => t.id === A.id) && (await call('DELETE', `${inv()}/tools/${A.id}`, owner, T)).status === 404, 'a tool is deleted once (404 the second time)');
  assert((await in1('GET', '')).body?.controlLinks.length === 0 && (await in1('GET', '')).body?.toolIds.length === 0 && (await in1('GET', '/data-inventory')).body?.categories[0]?.tools.length === 0, 'its boundary, links and data-inventory rows are gone with it');
  const gone = ((await call('GET', `${inv()}/events?entityId=${A.id}`, owner, T)).body?.events as Json[]).map((e) => e.action);
  assert(gone[0] === 'deleted', 'the deletion is in the history');

  origLog('\n--- Limit ---');
  const bulkOwner = person('u_ir_bulk');
  const L = (await call('POST', '/tenants', bulkOwner, undefined, { name: 'Register Bulk Org' })).body?.tenant?.id as string;
  let made = 0;
  for (let from = 0; from < MAX_TOOLS_PER_TENANT; from += MAX_BATCH) {
    const n = Math.min(MAX_BATCH, MAX_TOOLS_PER_TENANT - from);
    const r = await call('POST', `${inv(L)}/tools/batch`, bulkOwner, L, { items: Array.from({ length: n }, (_, i) => ({ name: `Bulk tool ${from + i}` })) });
    made += (r.body?.created as Json[] | undefined)?.length ?? 0;
  }
  const over = await call('POST', `${inv(L)}/tools`, bulkOwner, L, { name: 'One too many' });
  assert(made === MAX_TOOLS_PER_TENANT && over.status === 429 && over.body?.code === 'limit', 'IR15 MAX_TOOLS_PER_TENANT tools through batches, then one more POST -> 429 limit', [made, over.status, over.body]);
  const overBatch = await call('POST', `${inv(L)}/tools/batch`, bulkOwner, L, { items: [{ name: 'Over A' }, { name: 'Over B' }] });
  assert(overBatch.status === 200 && overBatch.body?.created.length === 0 && (overBatch.body?.skipped as Json[]).every((s) => s.reason === 'limit') && (overBatch.body?.skipped as Json[]).length === 2, 'a batch past the limit skips every item as limit');
  assert((await call('GET', `${inv(L)}/tools`, bulkOwner, L)).body?.limit === MAX_TOOLS_PER_TENANT, 'GET /tools reports the limit');

  origLog('\n--- Logs ---');
  assert(captured.length > 0 && !captured.some((l) => l.includes('MARK')), 'IR18 no line the server logged contains the tool name (MARK)', captured.filter((l) => l.includes('MARK')));
  assert(!captured.some((l) => /Okta|Splunk|Falcon|Endpoint protection|Rival vendor/.test(l)), 'nor any other name, vendor or mission');
}

async function run() {
  sourceTests();
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
