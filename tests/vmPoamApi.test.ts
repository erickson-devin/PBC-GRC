import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import { server } from '../server/index';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { __drainVmWorkerForTests } from '../server/vm/worker';
import { getVmSlaConfig } from '../server/vm/transitions';
import { createProgram } from '../server/programs';
import { firstProgram } from './programFixture';

/**
 * Vulnerability management, the POA&M read API (#274): GET /tenants/:id/vm/poam. Items of the program with their finding and host, the
 * rule that creates them, the upcoming deadlines (VM target program only), role / program / tenant isolation, limits, the overdue-without-item
 * count when automatic items are switched off, and that nothing about a finding reaches the console. Runs against the in-memory store with a
 * throw-away vault (see ./vmEnv). Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const DAY = 86_400_000;

// Everything written to the console from here on is kept, so that the log-hygiene case can read it back; the assertions print through the originals.
const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
const captured: string[] = [];
const keep = (...args: unknown[]) => { captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
console.log = keep;
console.warn = keep;
console.error = keep;

let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    rawLog(`  ✓ PASS: ${name}`);
  } else {
    rawError(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const say = (s: string) => rawLog(s);

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

async function ingest(token: string, payload: unknown) {
  vmIngestRateLimiter.reset();
  vmTokenRateLimiter.reset();
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: { ...HTTPS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: Buffer.from(JSON.stringify(payload)) });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: string[]) => [...xs].sort();

async function shutdown(code: number) {
  process.exitCode = code;
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  say('--- Setup: tenants, roles, one host with findings ---');
  process.env.PLATFORM_ADMIN_EMAILS = 'u_poam_admin@test.mil';
  delete process.env.VM_POAM_AUTOCREATE;
  const ownerA = person('u_poam_oa');
  const ownerB = person('u_poam_ob');
  const viewer = person('u_poam_v');
  const assessor = person('u_poam_as');
  const ownerE = person('u_poam_oe');
  const ownerN = person('u_poam_on');
  const admin = person('u_poam_admin');
  const mkTenant = async (who: string, name: string, extra: Record<string, unknown> = {}) => (await call('POST', '/tenants', who, undefined, { name, ...extra })).body?.tenant?.id as string;
  const A = await mkTenant(ownerA, 'Poam A');
  const B = await mkTenant(ownerB, 'Poam B');
  const E = await mkTenant(ownerE, 'Poam Empty');
  const NP = await mkTenant(ownerE, 'Poam No Program');
  const N = await mkTenant(admin, 'Poam Nist', { primaryFramework: 'NIST_800_53_REV5' });
  assert(Boolean(A && B && E && NP && N), 'six tenants created', { A, B, E, NP, N });
  const programA = await firstProgram(A);
  const programB = await firstProgram(B);
  const programE = await firstProgram(E);
  await call('POST', `/tenants/${A}/members`, ownerA, A, { userId: 'u_poam_v', email: 'u_poam_v@test.mil', role: 'VIEWER' });
  await call('POST', `/tenants/${A}/members`, ownerA, A, { userId: 'u_poam_as', email: 'u_poam_as@test.mil', role: 'ASSESSOR' });

  const poamOf = (tenant: string, who: string, query = '', headers: Record<string, string> = {}) => call('GET', `/tenants/${tenant}/vm/poam${query}`, who, tenant, undefined, headers);
  const itemIds = (r: { body: Json | null }) => ((r.body?.items ?? []) as Json[]).map((i) => i.id as string);
  const vulnIds = (items: Json[]) => items.map((i) => i.finding?.vulnId as string);

  say('\n--- P01-P03: authentication, tenant boundary, a tenant with no program ---');
  const p01 = await call('GET', `/tenants/${A}/vm/poam`, null, A);
  assert(p01.status === 401, 'P01 no session -> 401', p01.status);
  const p02 = await poamOf(A, ownerB);
  assert(p02.status === 403, "P02 another tenant's owner -> 403", p02.status);
  const p03 = await poamOf(NP, ownerE);
  assert(p03.status === 409 && p03.body?.code === 'program_required', 'P03 a tenant with no program -> 409 program_required', [p03.status, p03.body]);

  say('\n--- P04: a program with no findings ---');
  const p04 = await poamOf(E, ownerE);
  const b04 = (p04.body ?? {}) as Json;
  assert(
    p04.status === 200 && same(b04.items, []) && same(b04.upcoming, []) && b04.itemsTotal === 0 && b04.openItemsTotal === 0 && b04.upcomingTotal === 0 && b04.overdueWithoutItemCount === 0 && b04.programId === programE.id && b04.tenantId === E,
    'P04 an empty program -> 200 with no items, no upcoming rows and every total 0',
    p04.body,
  );
  assert(
    b04.rules?.isVmTarget === true && b04.rules?.vmTargetProgramId === programE.id && b04.rules?.autocreateEnabled === true && b04.rules?.controlId === 'RA.L2-3.11.3' && same(b04.rules?.slaDays, getVmSlaConfig()),
    'P04 the rules: the default program is the VM target, automatic items on, control RA.L2-3.11.3, the configured SLA days',
    b04.rules,
  );

  say('\n--- Ingest one host: an overdue CRITICAL, an upcoming HIGH, an overdue LOW with twelve packages ---');
  const tokenRes = await call('POST', `/tenants/${A}/vm/tokens`, ownerA, A, { name: 'poam-ingest' }, HTTPS);
  const tokenA = tokenRes.body?.token as string;
  const collectedAt = (offsetMs: number) => new Date(Date.now() - 60_000 + offsetMs).toISOString();
  const pkgs = Array.from({ length: 12 }, (_, i) => ({ name: `pkg${String(i + 1).padStart(2, '0')}`, version: '1.0' }));
  const hostFindings = () => [
    { vuln_id: 'CVE-2024-1001', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' },
    { vuln_id: 'CVE-2024-1002', severity: 'HIGH' },
    ...pkgs.map((p) => ({ vuln_id: 'CVE-2024-1003', severity: 'LOW', detected_at: '2020-01-01T00:00:00Z', package: p })),
  ];
  const payload = (at: string, extra: Record<string, unknown>[] = []) => ({
    schema_version: 1,
    source: { kind: 'WAZUH', label: 'poam-api-src' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: at,
    hosts: [{ agent_id: 'p1', hostname: 'host-p1', findings: [...hostFindings(), ...extra] }],
  });
  const first = await ingest(tokenA, payload(collectedAt(0)));
  await __drainVmWorkerForTests();
  assert(tokenRes.status === 201 && first.status === 202, 'the tenant has a token and one ingested run', [tokenRes.status, first.status]);
  const openFindings = async () => ((await call('GET', `/tenants/${A}/vm/findings?status=OPEN&limit=1000`, ownerA, A)).body?.findings ?? []) as Json[];

  say('\n--- P05-P06: items and upcoming deadlines ---');
  const p05 = await poamOf(A, ownerA);
  const b05 = (p05.body ?? {}) as Json;
  const generatedAt = Date.parse(b05.generatedAt);
  const open = await openFindings();
  const overdue = open.filter((f) => f.slaDueAt && Date.parse(f.slaDueAt) < generatedAt).map((f) => f.vulnId as string);
  const upcomingSet = open.filter((f) => f.slaDueAt && Date.parse(f.slaDueAt) >= generatedAt).map((f) => f.vulnId as string);
  const items05 = (b05.items ?? []) as Json[];
  assert(p05.status === 200 && same(sorted(overdue), ['CVE-2024-1001', 'CVE-2024-1003']), 'P05 the computed overdue set is the CRITICAL and the LOW', overdue);
  assert(same(sorted(vulnIds(items05)), sorted(overdue)) && b05.itemsTotal === overdue.length && b05.openItemsTotal === overdue.length, 'P05 the items are exactly the overdue findings', vulnIds(items05));
  assert(vulnIds(items05)[0] === 'CVE-2024-1001' && vulnIds(items05)[1] === 'CVE-2024-1003', 'P05 CRITICAL comes before LOW', vulnIds(items05));
  assert(
    items05.every((i) => i.controlId === 'RA.L2-3.11.3' && i.status === 'OPEN' && i.finding?.asset?.name === 'host-p1' && i.findingFirstSeenAt === '2020-01-01T00:00:00.000Z' && i.finding?.firstSeenAt === '2020-01-01T00:00:00.000Z'),
    'P05 each item: control RA.L2-3.11.3, OPEN, on host-p1, and its episode is the finding\'s first_seen_at',
    items05.map((i) => [i.controlId, i.status, i.findingFirstSeenAt]),
  );
  const low = items05.find((i) => i.finding?.vulnId === 'CVE-2024-1003') as Json;
  assert(low?.finding?.affectedPackages?.length === 10 && low?.finding?.affectedPackageCount === 12, 'P05 twelve packages: ten returned, the true count 12', [low?.finding?.affectedPackages?.length, low?.finding?.affectedPackageCount]);
  assert(typeof items05[0]?.weakness === 'string' && items05[0].weakness.length > 0 && items05[0].finding?.slaDueAt !== null && typeof items05[0].finding?.kev === 'boolean', 'P05 the stored weakness, the deadline and the KEV flag are returned');

  const up = (b05.upcoming ?? []) as Json[];
  assert(same(sorted(upcomingSet), ['CVE-2024-1002']) && same(sorted(up.map((u) => u.vulnId)), sorted(upcomingSet)) && b05.upcomingTotal === upcomingSet.length, 'P06 the upcoming list is the open findings not yet due', up.map((u) => u.vulnId));
  assert(up.every((u) => u.daysRemaining === Math.floor((Date.parse(u.slaDueAt) - generatedAt) / DAY) && u.assetName === 'host-p1' && u.slaDueAt) && b05.overdueWithoutItemCount === 0, 'P06 daysRemaining is floor((due - generatedAt) / 1 day) and no overdue finding lacks an item', up);

  say('\n--- P07: every role reads the same items ---');
  const pv = await poamOf(A, viewer);
  const pa = await poamOf(A, assessor);
  assert(pv.status === 200 && pa.status === 200 && same(itemIds(pv), itemIds(p05)) && same(itemIds(pa), itemIds(p05)), 'P07 a VIEWER and an ASSESSOR read the same item ids as the owner', [pv.status, pa.status]);

  say('\n--- P08: program isolation ---');
  const programA2 = await createProgram(A, { name: 'Poam second program', frameworkId: 'CMMC_L1' }, 'test');
  const p08 = await poamOf(A, ownerA, '', { 'x-program-id': programA2.id });
  const b08 = (p08.body ?? {}) as Json;
  assert(
    p08.status === 200 && b08.programId === programA2.id && same(b08.items, []) && b08.rules?.isVmTarget === false && b08.rules?.vmTargetProgramId === programA.id && same(b08.upcoming, []) && b08.upcomingTotal === 0 && b08.overdueWithoutItemCount === 0 && b08.itemsTotal === 0,
    'P08 a program that is not the VM target sees no items and no upcoming rows (the target\'s are not shown to it)',
    p08.body,
  );
  const p08b = await poamOf(A, ownerA, '', { 'x-program-id': programB.id });
  assert(p08b.status === 404 && p08b.body?.code === 'program_not_found', "P08 another tenant's program id in the header -> 404 program_not_found", [p08b.status, p08b.body]);
  const p08c = await poamOf(A, ownerA, '', { 'x-program-id': 'a b' });
  assert(p08c.status === 400, 'P08 a malformed program id -> 400', p08c.status);

  say('\n--- P09: tenant isolation ---');
  const p09 = await poamOf(B, ownerB);
  assert(p09.status === 200 && same(p09.body?.items, []) && !itemIds(p05).some((id) => p09.text.includes(id)) && !p09.text.includes('host-p1') && !p09.text.includes('CVE-2024-100'), "P09 another tenant's own answer holds no item, host or finding of tenant A", p09.body);

  say('\n--- P10: limits and paging ---');
  for (const q of ['?limit=0', '?limit=1001', '?limit=x', '?offset=-1', '?offset=x', '?upcomingLimit=1001', '?upcomingLimit=-1', '?status=bogus']) {
    const r = await poamOf(A, ownerA, q);
    assert(r.status === 400, `P10 ${q} -> 400`, [r.status, r.body]);
  }
  const l1 = await poamOf(A, ownerA, '?limit=1');
  const l2 = await poamOf(A, ownerA, '?limit=1&offset=1');
  assert(itemIds(l1).length === 1 && l1.body?.itemsTotal === 2 && itemIds(l2).length === 1 && itemIds(l2)[0] !== itemIds(l1)[0] && same([itemIds(l1)[0], itemIds(l2)[0]], itemIds(p05)), 'P10 limit=1 returns one item of two, offset=1 the other', [itemIds(l1), itemIds(l2)]);
  const u0 = await poamOf(A, ownerA, '?upcomingLimit=0');
  assert(u0.status === 200 && same(u0.body?.upcoming, []) && u0.body?.upcomingTotal === 1, 'P10 upcomingLimit=0 returns no rows but the true total', [u0.status, u0.body?.upcomingTotal]);
  const all = await poamOf(A, ownerA, '?status=all');
  assert(all.status === 200 && same(sorted(itemIds(all)), sorted(itemIds(p05))), 'P10 status=all -> 200 with the same two items', all.status);

  say('\n--- P11: automatic items switched off ---');
  process.env.VM_POAM_AUTOCREATE = 'false';
  const second = await ingest(tokenA, payload(collectedAt(30_000), [{ vuln_id: 'CVE-2024-1004', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }]));
  await __drainVmWorkerForTests();
  const p11 = await poamOf(A, ownerA);
  assert(second.status === 202 && p11.body?.rules?.autocreateEnabled === false, 'P11 the rules say automatic items are off', [second.status, p11.body?.rules]);
  assert(p11.body?.overdueWithoutItemCount === 1 && p11.body?.itemsTotal === 2, 'P11 one overdue finding has no item and no item was added', [p11.body?.overdueWithoutItemCount, p11.body?.itemsTotal]);
  delete process.env.VM_POAM_AUTOCREATE;
  const reproc = await call('POST', `/tenants/${A}/vm/runs/${second.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const p11b = await poamOf(A, ownerA);
  assert(reproc.status === 202 && p11b.body?.overdueWithoutItemCount === 0 && p11b.body?.itemsTotal === 3 && p11b.body?.rules?.autocreateEnabled === true, 'P11 with the switch back on, reprocessing the run creates the missing item', [reproc.status, p11b.body?.overdueWithoutItemCount, p11b.body?.itemsTotal]);

  say('\n--- P12: no program can hold items ---');
  await createProgram(N, { name: 'Poam NIST program', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE' }, 'test');
  const p12 = await poamOf(N, admin);
  assert(p12.status === 200 && p12.body?.rules?.vmTargetProgramId === null && p12.body?.rules?.isVmTarget === false && same(p12.body?.items, []), 'P12 a tenant whose only program is NIST 800-53 has no VM target: isVmTarget false, no items', [p12.status, p12.body?.rules]);

  say('\n--- P13: nothing about a finding reaches the console ---');
  const leaked = captured.filter((l) => /host-p1|pkg01|CVE-2024-100/.test(l));
  assert(captured.length > 0 && leaked.length === 0, 'P13 no host name, package or CVE id in the console output of the ingests, the worker and the reads', { lines: captured.length, leaked: leaked.length });

  console.log = rawLog;
  rawLog('\n================================================================');
  rawLog(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  rawLog('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  rawError('Unexpected test error:', err);
  shutdown(1);
});
