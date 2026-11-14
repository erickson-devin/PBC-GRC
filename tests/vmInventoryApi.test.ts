import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import { server } from '../server/index';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { __drainVmWorkerForTests, __setVmWorkerFaultForTests } from '../server/vm/worker';
import { changeProgramAssets } from '../server/programAssets';
import { createProgram } from '../server/programs';
import { firstProgram } from './programFixture';

/**
 * Host inventory over HTTP (issue #229 phase 2): a push that carries hardware and software, the assets it creates and fills, the two read
 * endpoints, the rule that a person's value is never overwritten, access, and a run that fails part-way. Runs against the in-memory store
 * with a throw-away vault (see ./vmEnv); the worker is drained, never timed. Every value is made up. Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const H1_NAME = 'INV-HOST-ONE';
const H2_NAME = 'INV-HOST-TWO';
const H1_IP = '10.77.0.11';
const H1_MAC = 'AA:BB:CC:77:00:11';
const H1_SERIAL = 'INV-SERIAL-0001';
const PKG_MARK = 'inv-pkg-mark';

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
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (tenant) h['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

const resetLimiters = () => {
  vmIngestRateLimiter.reset();
  vmTokenRateLimiter.reset();
};

async function ingest(token: string, payload: unknown) {
  resetLimiters();
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: { ...HTTPS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: Buffer.from(JSON.stringify(payload)) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

const pkgs = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ name: `${PKG_MARK}-${i}`, version: `1.${i}`, vendor: 'Fake Vendor', architecture: 'x86_64', type: 'msi' }));

function inventoryPayload(label: string, collectedAt: string, o: { ip?: string; serial?: string; h1Software?: Json[] } = {}): Json {
  return {
    schema_version: 1,
    source: { kind: 'WAZUH', label },
    exporter: { name: 'pbc-vm-exporter', version: '1.0.0' },
    collected_at: collectedAt,
    hosts: [
      {
        agent_id: '001',
        hostname: H1_NAME,
        ip: o.ip ?? H1_IP,
        mac: H1_MAC,
        os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', platform: 'windows', kernel: '10.0.22631.1' },
        findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }],
        hardware: { architecture: 'x86_64', cpu_name: 'Fake CPU', cpu_cores: 8, cpu_mhz: 2400, memory_bytes: 17179869184, serial_number: o.serial ?? H1_SERIAL },
        software: o.h1Software ?? pkgs(3),
      },
      {
        agent_id: '002',
        hostname: H2_NAME,
        software: [{ name: `${PKG_MARK}-two-a`, version: '2' }, { name: `${PKG_MARK}-two-b`, version: '2' }],
      },
    ],
  };
}

async function shutdown(code: number) {
  process.exitCode = code;
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Setup: users, tenants, tokens ---');
  process.env.PLATFORM_ADMIN_EMAILS = 'u_inv_admin@test.mil';
  const admin = person('u_inv_admin');
  const viewer = person('u_inv_viewer');
  const owner2 = person('u_inv_o2');
  const mkTenant = async (who: string, name: string, extra: Record<string, unknown> = {}) => (await call('POST', '/tenants', who, undefined, { name, ...extra })).body?.tenant?.id as string;
  const T1 = await mkTenant(admin, 'Inv One', { primaryFramework: 'CMMC_L2' });
  await firstProgram(T1, 'CMMC_L2'); // a tenant starts with no program: the program-wide reads need the organization default
  const T2 = await mkTenant(owner2, 'Inv Other');
  assert(Boolean(T1 && T2), 'two tenants created', { T1, T2 });
  await call('POST', `/tenants/${T1}/members`, admin, T1, { userId: 'u_inv_viewer', email: 'u_inv_viewer@test.mil', role: 'VIEWER' });
  const tok1 = (await call('POST', `/tenants/${T1}/vm/tokens`, admin, T1, { name: 'inv-ingest' }, HTTPS)).body?.token as string;
  const tok2 = (await call('POST', `/tenants/${T2}/vm/tokens`, owner2, T2, { name: 'inv-ingest' }, HTTPS)).body?.token as string;
  assert(Boolean(tok1 && tok2), 'service tokens created');

  const assetsOf = async (tenant: string, who: string) => ((await call('GET', `/tenants/${tenant}/assets`, who, tenant)).body?.assets ?? []) as Json[];
  const byName = async (name: string) => (await assetsOf(T1, admin)).find((a) => a.hostName === name) as Json;
  const runOf = async (id: string) => (((await call('GET', `/tenants/${T1}/vm/runs`, admin, T1)).body?.runs ?? []) as Json[]).find((r) => r.id === id) as Json;
  const inventoryOf = async (assetId: string, who = admin, tenant = T1) => call('GET', `/tenants/${tenant}/vm/assets/${assetId}/inventory`, who, tenant);
  const softwareOf = async (assetId: string, query = '', who = admin, tenant = T1) => call('GET', `/tenants/${tenant}/vm/assets/${assetId}/software${query}`, who, tenant);

  console.log('\n--- A1: whoami advertises inventory ---');
  resetLimiters();
  const who = await fetch(`${BASE}/vm/whoami`, { headers: { ...HTTPS, Authorization: `Bearer ${tok1}` } });
  const whoBody = (await who.json()) as Json;
  assert(who.status === 200 && JSON.stringify(whoBody.features) === '["whoami","inventory"]', 'A1 GET /vm/whoami lists the inventory feature', whoBody.features);

  console.log('\n--- A2: two hosts, one with findings and hardware, one inventory-only ---');
  const captured: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const capture = (...args: unknown[]) => { captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture; console.info = capture;
  let pushed: Awaited<ReturnType<typeof ingest>>;
  try {
    pushed = await ingest(tok1, inventoryPayload('inv-main', '2026-11-10T12:00:00Z'));
    await __drainVmWorkerForTests();
  } finally {
    console.log = original.log; console.error = original.error; console.warn = original.warn; console.info = original.info;
  }
  const run1 = await runOf(pushed.body?.run_id);
  assert(pushed.status === 202 && run1?.status === 'NORMALIZED', 'A2 the push is accepted and NORMALIZED', [pushed.status, run1]);
  const h1 = await byName(H1_NAME);
  const h2 = await byName(H2_NAME);
  assert(h1?.sourceOrigin === 'AGENT_REPORT' && h2?.sourceOrigin === 'AGENT_REPORT' && h2?.discoveryStatus === 'UNCONFIRMED_DISCOVERY', 'A2 both hosts became scanner-created assets (the inventory-only one unconfirmed)', [h1?.sourceOrigin, h2?.sourceOrigin]);
  assert(h1?.osProfile === 'win11' && h1?.notes.includes('Microsoft Windows 11 Pro'), 'A2 the Windows 11 host gets the win11 profile and keeps the raw name in its notes', [h1?.osProfile, h1?.notes]);
  assert(h1?.ipAddress === H1_IP && h1?.macAddress === H1_MAC && h1?.serialNumber === H1_SERIAL, 'A2 ip, MAC and serial number are on the asset', [h1?.ipAddress, h1?.macAddress, h1?.serialNumber]);
  assert(h2?.osProfile === 'custom' && h2?.ipAddress === '' && h2?.serialNumber === '', 'A2 the inventory-only host has nothing to fill', h2);
  const log = captured.join('\n');
  assert(/NORMALIZED/.test(log) && /5 software items/.test(log), 'A2 the worker log line counts the software items', log.split('\n').filter((l) => l.includes('NORMALIZED')));
  assert(!log.includes(H1_NAME) && !log.includes(H1_SERIAL) && !log.includes(PKG_MARK) && !log.includes(H1_MAC) && !log.includes(H1_IP), 'A2 nothing of the inventory reaches the log', undefined);

  console.log('\n--- A3-A4: the read endpoints ---');
  const inv1 = await inventoryOf(h1.id);
  const o1 = (inv1.body?.observed ?? []) as Json[];
  assert(inv1.status === 200 && inv1.body?.tenantId === T1 && inv1.body?.assetId === h1.id && o1.length === 1, 'A3 the inventory of H1 has one source view', inv1.body);
  assert(o1[0]?.sourceLabel === 'inv-main' && o1[0]?.sourceKind === 'WAZUH' && o1[0]?.hostname === H1_NAME && o1[0]?.ipAddress === H1_IP && o1[0]?.os?.platform === 'windows' && o1[0]?.os?.kernel === '10.0.22631.1', 'A3 it carries the source, addresses and OS', o1[0]);
  assert(o1[0]?.hardware?.memoryBytes === 17179869184 && typeof o1[0]?.hardware?.memoryBytes === 'number' && o1[0]?.hardware?.cpuCores === 8 && o1[0]?.softwareReported === true && o1[0]?.softwareCount === 3, 'A3 hardware numbers are numbers; the package count is 3', o1[0]?.hardware);
  const inv2 = await inventoryOf(h2.id);
  assert(((inv2.body?.observed ?? []) as Json[])[0]?.hardware === null && ((inv2.body?.observed ?? []) as Json[])[0]?.softwareCount === 2, 'A5 the inventory-only host reports no hardware and 2 packages', inv2.body);
  const sw1 = await softwareOf(h1.id);
  assert(sw1.status === 200 && sw1.body?.totalCount === 3 && sw1.body?.items?.length === 3 && sw1.body?.items?.[0]?.name === `${PKG_MARK}-0` && sw1.body?.items?.[0]?.vendor === 'Fake Vendor', 'A4 the software endpoint lists the packages by name', sw1.body);
  const swLimited = await softwareOf(h1.id, '?limit=2');
  assert(swLimited.body?.totalCount === 3 && swLimited.body?.items?.length === 2, 'A4 limit cuts the items, not the total', swLimited.body);
  const sourceId = o1[0]?.sourceId as string;
  assert((await softwareOf(h1.id, `?sourceId=${sourceId}`)).body?.items?.length === 3 && (await softwareOf(h1.id, '?sourceId=nope')).body?.items?.length === 0, 'A4 the source filter narrows the list');
  assert((await softwareOf(h1.id, '?limit=0')).status === 400 && (await softwareOf(h1.id, '?limit=10001')).status === 400 && (await softwareOf(h1.id, '?limit=abc')).status === 400 && (await softwareOf(h1.id, '?sourceId=a%20b')).status === 400, 'A4 a limit outside 1..10000 or a malformed source id is a 400');

  console.log('\n--- P1-P8: the program-wide reads (issue #279) ---');
  const pCaptured: string[] = [];
  const pCapture = (...args: unknown[]) => { pCaptured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = pCapture; console.error = pCapture; console.warn = pCapture; console.info = pCapture;
  try {
    const progSoftware = async (query = '', who = admin, headers: Record<string, string> = {}) => call('GET', `/tenants/${T1}/vm/inventory/software${query}`, who, T1, undefined, headers);
    const progHosts = async (who = admin, headers: Record<string, string> = {}) => call('GET', `/tenants/${T1}/vm/inventory/hosts`, who, T1, undefined, headers);
    const p1 = await progSoftware();
    const groupOf = (body: Json | null, name: string) => ((body?.items ?? []) as Json[]).find((g) => String(g.name).toLowerCase() === name.toLowerCase());
    assert(p1.status === 200 && p1.body?.tenantId === T1 && p1.body?.totalGroups === 5 && p1.body?.truncated === false && p1.body?.declared === false && typeof p1.body?.programId === 'string', 'P1 the program software aggregate lists 5 distinct packages', p1.body);
    assert(groupOf(p1.body, `${PKG_MARK}-0`)?.assetCount === 1 && groupOf(p1.body, `${PKG_MARK}-0`)?.vendor === 'Fake Vendor' && (groupOf(p1.body, `${PKG_MARK}-0`)?.assetIds as string[])?.join() === h1.id, 'P1b a group carries its vendor, asset count and asset ids', groupOf(p1.body, `${PKG_MARK}-0`));
    const rep = await ingest(tok1, { ...inventoryPayload('inv-main', '2026-11-10T13:00:00Z'), hosts: [{ agent_id: '002', hostname: H2_NAME, software: [{ name: `${PKG_MARK}-two-a`, version: '2' }, { name: `${PKG_MARK}-two-b`, version: '2' }, { name: `${PKG_MARK}-0`.toUpperCase(), version: '1.0', vendor: 'FAKE VENDOR' }] }] });
    await __drainVmWorkerForTests();
    const p2 = await progSoftware();
    assert(rep.status === 202 && p2.body?.totalGroups === 5 && groupOf(p2.body, `${PKG_MARK}-0`)?.assetCount === 2, 'P2 the same package on two assets (other case and vendor case) is still one group', p2.body);
    assert((await progSoftware('', viewer)).status === 200 && (await progHosts(viewer)).status === 200, 'P3 a viewer can read both');
    const p4a = await progSoftware('?limit=0');
    const p4b = await progSoftware('?limit=20001');
    const p4c = await progSoftware('?limit=abc');
    const p4d = await progSoftware('?limit=1');
    assert(p4a.status === 400 && p4b.status === 400 && p4c.status === 400 && p4a.body?.error === 'Invalid limit: between 1 and 20000', 'P4 a limit outside 1..20000 is a 400', p4a.body);
    assert(p4d.status === 200 && p4d.body?.items?.length === 1 && p4d.body?.truncated === true && p4d.body?.totalGroups === 5, 'P4b limit=1 returns one group and says it is truncated', p4d.body);
    const program2 = await createProgram(T1, { name: 'Inventory boundary', frameworkId: 'CMMC_L2' }, 'u_inv_admin');
    await changeProgramAssets(T1, program2.id, { add: [h2.id], remove: [] }, { actor: 'test', userId: null });
    const p5 = await progSoftware('', admin, { 'x-program-id': program2.id });
    const p5h = await progHosts(admin, { 'x-program-id': program2.id });
    assert(p5.body?.declared === true && p5.body?.programId === program2.id && p5.body?.totalGroups === 3 && !groupOf(p5.body, `${PKG_MARK}-1`) && groupOf(p5.body, `${PKG_MARK}-0`)?.assetCount === 1, 'P5 a program that declares only H2 sees only H2\'s packages', p5.body);
    assert(((p5h.body?.hosts ?? []) as Json[]).length === 1 && p5h.body?.hosts?.[0]?.assetId === h2.id, 'P5b and only H2\'s host row', p5h.body);
    assert((await progSoftware('', admin, { 'x-program-id': 'no-such-program' })).status === 404 && (await progHosts(admin, { 'x-program-id': 'no-such-program' })).status === 404, 'P6 an unknown program is a 404');
    const p7 = await progHosts();
    const p7h1 = ((p7.body?.hosts ?? []) as Json[]).find((h) => h.assetId === h1.id);
    const p7h2 = ((p7.body?.hosts ?? []) as Json[]).find((h) => h.assetId === h2.id);
    assert(p7.status === 200 && p7h1?.os?.name === 'Microsoft Windows 11 Pro' && p7h1?.hardware?.cpuCores === 8 && p7h1?.sourceLabel === 'inv-main' && p7h2?.hardware === null, 'P7 the host read carries the OS and hardware, and H2 has no hardware', p7.body);
    assert((await call('GET', `/tenants/${T1}/vm/inventory/software`, owner2, T1)).status >= 400 && (await call('GET', `/tenants/${T1}/vm/inventory/hosts`, null, T1)).status === 401, 'P3b a non-member and an anonymous caller are refused');
    const noProgram = await call('GET', `/tenants/${T2}/vm/inventory/software`, owner2, T2);
    assert(noProgram.status === 409 && noProgram.body?.code === 'program_required', 'P3c a tenant with no program yet gets 409 program_required', noProgram.body);
  } finally {
    console.log = original.log; console.error = original.error; console.warn = original.warn; console.info = original.info;
  }
  const pLog = pCaptured.join('\n');
  assert(!pLog.includes(PKG_MARK) && !pLog.toLowerCase().includes(H1_NAME.toLowerCase()) && !pLog.includes(H2_NAME) && !pLog.includes(H1_SERIAL), 'P8 nothing of the inventory reaches the log during the program-wide reads', undefined);

  console.log('\n--- A6: a person edits the asset, the next run does not overwrite ---');
  const edit = await call('PUT', `/tenants/${T1}/assets/${h1.id}`, admin, T1, { ipAddress: '10.200.0.9', serialNumber: 'OWNER-SERIAL', macAddress: '11:22:33:44:55:66' });
  assert(edit.status === 200, 'A6 the owner edits ip, serial and MAC', edit.body);
  const second = await ingest(tok1, inventoryPayload('inv-main', '2026-11-11T12:00:00Z', { ip: '10.77.0.99', serial: 'SCANNER-SERIAL-2', h1Software: pkgs(2) }));
  await __drainVmWorkerForTests();
  assert(second.status === 202 && (await runOf(second.body?.run_id))?.status === 'NORMALIZED', 'A6 the second push is NORMALIZED');
  const h1b = await byName(H1_NAME);
  assert(h1b.ipAddress === '10.200.0.9' && h1b.serialNumber === 'OWNER-SERIAL' && h1b.macAddress === '11:22:33:44:55:66', 'A6 the person\'s ip, serial and MAC are kept', [h1b.ipAddress, h1b.serialNumber, h1b.macAddress]);
  const o1b = ((await inventoryOf(h1.id)).body?.observed ?? []) as Json[];
  assert(o1b.length === 1 && o1b[0].ipAddress === '10.77.0.99' && o1b[0].hardware?.serialNumber === 'SCANNER-SERIAL-2' && o1b[0].softwareCount === 2, 'A6 the observed view shows the scanner value and the replaced package list', o1b[0]);
  assert((await softwareOf(h1.id)).body?.totalCount === 2, 'A6 the package list was replaced (2 now)');

  console.log('\n--- A7: a human-created asset keeps its blank IP ---');
  const manual = await call('POST', `/tenants/${T1}/assets`, admin, T1, { hostName: 'INV-MANUAL', cmmcAssetCategory: 'CUI_ASSET' });
  const manualId = manual.body?.asset?.id as string;
  const manualPush = await ingest(tok1, { schema_version: 1, source: { kind: 'WAZUH', label: 'inv-main' }, exporter: { name: 'pbc-vm-exporter', version: '1.0.0' }, collected_at: '2026-11-12T12:00:00Z', hosts: [{ agent_id: '003', hostname: 'INV-MANUAL', ip: '10.77.0.30', hardware: { serial_number: 'MANUAL-SERIAL' } }] });
  await __drainVmWorkerForTests();
  const manualAfter = await byName('INV-MANUAL');
  assert(manual.status === 201 && manualPush.status === 202 && manualAfter?.id === manualId, 'A7 the push matched the manual asset by name', [manual.status, manualPush.status]);
  assert(manualAfter.ipAddress === '' && manualAfter.serialNumber === '' && manualAfter.sourceOrigin === 'MANUAL_ENTRY', 'A7 its blank IP and serial stay blank, its origin unchanged', manualAfter);
  const manualObs = ((await inventoryOf(manualId)).body?.observed ?? []) as Json[];
  assert(manualObs[0]?.ipAddress === '10.77.0.30' && manualObs[0]?.hardware?.serialNumber === 'MANUAL-SERIAL', 'A7 the observed values are there to compare');

  console.log('\n--- A8: access ---');
  assert((await inventoryOf(h1.id, viewer)).status === 200 && (await softwareOf(h1.id, '', viewer)).status === 200, 'A8 a viewer can read both endpoints');
  assert((await inventoryOf('00000000-0000-4000-8000-000000000000')).status === 404 && (await softwareOf('00000000-0000-4000-8000-000000000000')).status === 404, 'A8 an unknown asset is a 404');
  assert((await inventoryOf('bad%20id')).status === 404 && (await softwareOf('bad%20id')).status === 404, 'A8 a malformed asset id is a 404');
  assert((await inventoryOf(h1.id, owner2, T2)).status === 404 && (await softwareOf(h1.id, '', owner2, T2)).status === 404, "A8 another tenant's request for the asset is a 404");
  assert((await inventoryOf(h1.id, owner2, T1)).status >= 400 && (await call('GET', `/tenants/${T1}/vm/assets/${h1.id}/inventory`, null, T1)).status === 401, 'A8 a non-member and an anonymous caller are refused');

  console.log('\n--- A9: a payload without inventory stores none ---');
  const plain = await ingest(tok2, { schema_version: 1, source: { kind: 'WAZUH', label: 'plain' }, exporter: { name: 'pbc-vm-exporter', version: '1.0.0' }, collected_at: '2026-11-10T12:00:00Z', hosts: [{ agent_id: '009', hostname: 'INV-PLAIN', findings: [{ vuln_id: 'CVE-2024-0002', severity: 'LOW' }] }] });
  await __drainVmWorkerForTests();
  const plainAsset = ((await assetsOf(T2, owner2)).find((a) => a.hostName === 'INV-PLAIN')) as Json;
  const plainInv = await inventoryOf(plainAsset?.id, owner2, T2);
  assert(plain.status === 202 && plainInv.status === 200 && (plainInv.body?.observed ?? []).length === 0 && (await softwareOf(plainAsset.id, '', owner2, T2)).body?.totalCount === 0, 'A9 a host with findings only has no inventory rows', plainInv.body);

  console.log('\n--- A10: a run that fails part-way ---');
  __setVmWorkerFaultForTests('after_save');
  const faulty = await ingest(tok1, { schema_version: 1, source: { kind: 'WAZUH', label: 'inv-fault' }, exporter: { name: 'pbc-vm-exporter', version: '1.0.0' }, collected_at: '2026-11-13T12:00:00Z', hosts: [{ agent_id: '050', hostname: 'INV-FAULT', software: [{ name: 'fault-pkg' }] }] });
  await __drainVmWorkerForTests();
  __setVmWorkerFaultForTests(null);
  const faultyRun = await runOf(faulty.body?.run_id);
  // The in-memory store has no transactions, so what was saved before the fault stays here; PostgreSQL rolls it back (scripts/verifyVmLive.ts).
  assert(faulty.status === 202 && faultyRun?.status === 'FAILED' && faultyRun.error === 'Normalization failed unexpectedly. Check the server log.' && !JSON.stringify(faultyRun).includes('fault-pkg') && !JSON.stringify(faultyRun).includes('INV-FAULT'), 'A10 the run is FAILED with the generic message and no payload value', faultyRun);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
