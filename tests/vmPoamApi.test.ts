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
  const payload = (at: string, extra: Record<string, unknown>[] = [], exclude: string[] = []) => ({
    schema_version: 1,
    source: { kind: 'WAZUH', label: 'poam-api-src' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: at,
    hosts: [{ agent_id: 'p1', hostname: 'host-p1', findings: [...hostFindings().filter((f) => !exclude.includes(f.vuln_id)), ...extra] }],
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

  say('\n--- E01-E14: editing an item (PATCH /vm/poam/:itemId), its history and the single read ---');
  const OWNER_MARK = 'OWNER-MARK';
  const MITIGATION_MARK = 'MITIGATION-MARK';
  const patchItem = (tenant: string, who: string, id: string, body: unknown, headers: Record<string, string> = {}) => call('PATCH', `/tenants/${tenant}/vm/poam/${id}`, who, tenant, body, headers);
  const eventsOf = (tenant: string, who: string, id: string, headers: Record<string, string> = {}) => call('GET', `/tenants/${tenant}/vm/poam/${id}/events`, who, tenant, undefined, headers);
  const itemOf = (tenant: string, who: string, id: string, headers: Record<string, string> = {}) => call('GET', `/tenants/${tenant}/vm/poam/${id}`, who, tenant, undefined, headers);
  const rowFor = async (vuln: string, query = '?status=all'): Promise<Json> => (((await poamOf(A, ownerA, query)).body?.items ?? []) as Json[]).find((i) => i.finding?.vulnId === vuln) as Json;
  const row1001 = await rowFor('CVE-2024-1001');
  const row1004 = await rowFor('CVE-2024-1004');
  const id1001 = row1001?.id as string;
  const id1004 = row1004?.id as string;
  assert(Boolean(id1001 && id1004), 'E00 the items of CVE-2024-1001 and CVE-2024-1004 exist', [id1001, id1004]);
  const stamp0 = row1001.updatedAt as string;

  const e01a = await patchItem(A, viewer, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const e01b = await patchItem(A, assessor, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const after01 = await rowFor('CVE-2024-1001');
  assert(e01a.status === 403 && e01b.status === 403 && after01.owner === '' && after01.updatedAt === stamp0, 'E01 a VIEWER and an ASSESSOR cannot edit an item (403) and it is unchanged', [e01a.status, e01b.status, after01.owner]);

  const e02a = await patchItem(B, ownerB, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const e02b = await patchItem(A, ownerB, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const e02c = await itemOf(B, ownerB, id1001);
  const e02d = await eventsOf(B, ownerB, id1001);
  assert(e02a.status === 404 && e02b.status === 403 && e02c.status === 404 && e02d.status === 404, "E02 another tenant's item id is 404 in the owner's own tenant (edit, read, events) and 403 through tenant A", [e02a.status, e02b.status, e02c.status, e02d.status]);

  const A2h = { 'x-program-id': programA2.id };
  const e03a = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK }, A2h);
  const e03b = await patchItem(A, ownerA, 'no-such-item', { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const e03c = await patchItem(A, ownerA, 'a%20b', { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  const e03d = await itemOf(A, ownerA, id1001, A2h);
  const e03e = await eventsOf(A, ownerA, id1001, A2h);
  assert(
    [e03a, e03b, e03c, e03d, e03e].every((r) => r.status === 404) && same(e03a.body, e03b.body) && same(e03b.body, e03c.body),
    "E03 another program's item, an unknown id and a malformed id are all the same 404 (edit, read, events)",
    [e03a.status, e03b.status, e03c.status, e03d.status, e03e.status],
  );
  const e03f = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp0, owner: OWNER_MARK }, { 'x-program-id': programB.id });
  assert(e03f.status === 404 && e03f.body?.code === 'program_not_found', "E03 another tenant's program header -> 404 program_not_found", [e03f.status, e03f.body]);
  const e03g = await call('PATCH', `/tenants/${NP}/vm/poam/${id1001}`, ownerE, NP, { expectedUpdatedAt: stamp0, owner: OWNER_MARK });
  assert(e03g.status === 409 && e03g.body?.code === 'program_required', 'E03 a tenant with no program -> 409 program_required', [e03g.status, e03g.body]);

  // E04: an item in a program that was the VM target and is archived now is frozen
  const target2 = await call('PUT', `/tenants/${A}/programs/${programA2.id}/vm-target`, ownerA, A);
  const reprocessed = await call('POST', `/tenants/${A}/vm/runs/${second.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const itemsA2 = ((await poamOf(A, ownerA, '', A2h)).body?.items ?? []) as Json[];
  const target1 = await call('PUT', `/tenants/${A}/programs/${programA.id}/vm-target`, ownerA, A);
  const archived = await call('POST', `/tenants/${A}/programs/${programA2.id}/archive`, ownerA, A);
  assert(target2.status === 200 && reprocessed.status === 202 && itemsA2.length > 0 && target1.status === 200 && archived.status === 200, 'E04 setup: program A2 was the target, got items, the target went back and A2 is archived', [target2.status, reprocessed.status, itemsA2.length, target1.status, archived.status]);
  const e04 = await patchItem(A, ownerA, itemsA2[0].id as string, { expectedUpdatedAt: itemsA2[0].updatedAt, owner: OWNER_MARK }, A2h);
  const e04r = await itemOf(A, viewer, itemsA2[0].id as string, A2h);
  assert(e04.status === 409 && e04.body?.code === 'program_archived' && e04r.status === 200, 'E04 an archived program\'s item cannot be edited (409 program_archived) but can still be read', [e04.status, e04.body, e04r.status]);

  const e05a = await patchItem(A, ownerA, id1001, { owner: OWNER_MARK });
  const e05b = await patchItem(A, ownerA, id1001, { owner: OWNER_MARK, expectedUpdatedAt: 'yesterday' });
  const e05c = await patchItem(A, ownerA, id1001, { owner: OWNER_MARK, expectedUpdatedAt: null });
  assert([e05a, e05b, e05c].every((r) => r.status === 400 && r.body?.code === 'invalid_poam_patch' && r.body?.field === 'expectedUpdatedAt'), 'E05 a missing, null or invalid expectedUpdatedAt -> 400 naming the field', [e05a.status, e05b.status, e05c.status]);

  const invalid: Array<[string, unknown, string]> = [
    ['an owner of 256 characters', { owner: OWNER_MARK + 'x'.repeat(246) }, 'owner'],
    ['an owner with a control character', { owner: OWNER_MARK + '\u0007' }, 'owner'],
    ['a mitigation of 4001 characters', { mitigation: MITIGATION_MARK + 'x'.repeat(3986) }, 'mitigation'],
    ['a mitigation with a NUL', { mitigation: MITIGATION_MARK + '\u0000' }, 'mitigation'],
    ['a calendar date that does not exist', { scheduledCompletion: '2026-02-29' }, 'scheduledCompletion'],
    ['a date text that is not a date', { scheduledCompletion: MITIGATION_MARK }, 'scheduledCompletion'],
    ['a date out of range', { scheduledCompletion: '2100-01-01' }, 'scheduledCompletion'],
    ['a status that does not exist', { status: OWNER_MARK }, 'status'],
    ['a lower-case status', { status: 'open' }, 'status'],
    ['an unknown key', { foo: OWNER_MARK }, 'foo'],
    ['nothing to change', {}, 'body'],
  ];
  for (const [what, extra, wantField] of invalid) {
    const r = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp0, ...(extra as Json) });
    assert(r.status === 400 && r.body?.code === 'invalid_poam_patch' && r.body?.field === wantField && !r.text.includes(OWNER_MARK) && !r.text.includes(MITIGATION_MARK), `E06 ${what} -> 400 naming ${wantField}, never the value`, [r.status, r.body]);
  }
  const e06arr = await call('PATCH', `/tenants/${A}/vm/poam/${id1001}`, ownerA, A, [1, 2]);
  assert(e06arr.status === 400 && e06arr.body?.field === 'body', 'E06 an array body -> 400 body', [e06arr.status, e06arr.body]);

  const e07 = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp0, owner: `${OWNER_MARK} Alice`, mitigation: `${MITIGATION_MARK} patch it`, scheduledCompletion: '2026-12-15', status: 'IN_PROGRESS' });
  const item07 = (e07.body?.item ?? {}) as Json;
  assert(
    e07.status === 200 && e07.body?.changed === true && item07.owner === `${OWNER_MARK} Alice` && item07.mitigation === `${MITIGATION_MARK} patch it` && item07.scheduledCompletion === '2026-12-15' && item07.status === 'IN_PROGRESS' &&
      item07.updatedBy === 'u_poam_oa' && item07.statusChangedBy === 'u_poam_oa' && typeof item07.statusChangedAt === 'string' && Date.parse(item07.updatedAt) > Date.parse(stamp0) && item07.autoComplete === true && item07.id === id1001,
    'E07 the owner edits all four fields: 200, changed, the values echoed, updatedBy and statusChangedBy set, a newer updatedAt',
    e07.body,
  );
  const view07 = await rowFor('CVE-2024-1001');
  const viewerRow = ((await poamOf(A, viewer)).body?.items as Json[]).find((i) => i.id === id1001) as Json;
  assert(viewerRow?.owner === `${OWNER_MARK} Alice` && viewerRow?.mitigation === `${MITIGATION_MARK} patch it` && viewerRow?.scheduledCompletion === '2026-12-15' && view07.updatedAt === item07.updatedAt, 'E07 a VIEWER reads the same values in the list', viewerRow);
  const stamp1 = item07.updatedAt as string;

  const e08 = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp0, owner: `${OWNER_MARK}-2` });
  assert(e08.status === 409 && e08.body?.code === 'stale_write' && e08.body?.current?.updatedAt === stamp1 && e08.body?.current?.updatedBy === 'u_poam_oa' && !e08.text.includes(OWNER_MARK) && !e08.text.includes(MITIGATION_MARK), 'E08 the old stamp -> 409 stale_write with the current stamp and no item text', e08.body);

  const events09a = ((await eventsOf(A, viewer, id1001)).body?.events ?? []) as Json[];
  const e09 = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp1, owner: `${OWNER_MARK} Alice`, mitigation: `${MITIGATION_MARK} patch it`, scheduledCompletion: '2026-12-15', status: 'IN_PROGRESS' });
  const events09b = ((await eventsOf(A, viewer, id1001)).body?.events ?? []) as Json[];
  assert(e09.status === 200 && e09.body?.changed === false && e09.body?.item?.updatedAt === stamp1 && events09a.length === 1 && events09b.length === 1, 'E09 the same values again: 200, changed false, the stamp and the history unchanged', [e09.status, e09.body?.changed, events09a.length, events09b.length]);

  const e10 = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: stamp1, status: 'COMPLETED' });
  assert(e10.status === 409 && e10.body?.code === 'finding_still_open' && !e10.text.includes(OWNER_MARK), 'E10 COMPLETED while the scanner still reports the finding -> 409 finding_still_open', e10.body);

  const e11a = await patchItem(A, ownerA, id1004, { expectedUpdatedAt: row1004.updatedAt, status: 'RISK_ACCEPTED', mitigation: '' });
  const e11b = await patchItem(A, ownerA, id1004, { expectedUpdatedAt: row1004.updatedAt, status: 'RISK_ACCEPTED' });
  assert(e11a.status === 400 && e11a.body?.code === 'mitigation_required' && e11b.status === 400 && e11b.body?.code === 'mitigation_required', 'E11 RISK_ACCEPTED without a mitigation -> 400 mitigation_required', [e11a.status, e11b.status]);
  const e11c = await patchItem(A, ownerA, id1004, { expectedUpdatedAt: row1004.updatedAt, status: 'RISK_ACCEPTED', mitigation: `${MITIGATION_MARK} compensating control` });
  assert(e11c.status === 200 && e11c.body?.item?.status === 'RISK_ACCEPTED' && e11c.body?.changed === true, 'E11 RISK_ACCEPTED with a mitigation -> 200', e11c.body);
  const e11d = await patchItem(A, ownerA, id1004, { expectedUpdatedAt: e11c.body?.item?.updatedAt, mitigation: '' });
  assert(e11d.status === 400 && e11d.body?.code === 'mitigation_required', 'E11 emptying the mitigation of a RISK_ACCEPTED item that stays RISK_ACCEPTED -> 400 mitigation_required', [e11d.status, e11d.body]);
  const e11e = await patchItem(A, ownerA, id1004, { expectedUpdatedAt: e11c.body?.item?.updatedAt, mitigation: `${MITIGATION_MARK} updated` });
  assert(e11e.status === 200 && e11e.body?.item?.status === 'RISK_ACCEPTED', 'E11 changing its mitigation to another text is fine', [e11e.status]);

  const e12r = await eventsOf(A, viewer, id1001);
  const events12 = (e12r.body?.events ?? []) as Json[];
  const ev = events12[0] ?? {};
  assert(
    e12r.status === 200 && events12.length === 1 && ev.source === 'human' && ev.actor === 'u_poam_oa' && ev.oldStatus === 'OPEN' && ev.newStatus === 'IN_PROGRESS' && ev.oldScheduledCompletion === null && ev.newScheduledCompletion === '2026-12-15' &&
      ev.ownerChanged === true && ev.mitigationChanged === true && ev.runId === null && ev.itemId === id1001,
    'E12 a VIEWER reads the item history: one human event with the statuses, the dates and both changed flags',
    events12,
  );
  assert(!e12r.text.includes(OWNER_MARK) && !e12r.text.includes(MITIGATION_MARK) && !('newOwnerSha256' in ev) && !('actorUserId' in ev), 'E12 the history carries no owner or mitigation text, no digest and no user id');

  const g1 = await itemOf(A, viewer, id1001);
  const listed = ((await poamOf(A, viewer, '?status=all')).body?.items as Json[]).find((i) => i.id === id1001);
  assert(g1.status === 200 && same(g1.body?.item, listed), 'G01 a VIEWER reads one item and it equals the list row', [g1.status]);
  const g2 = await itemOf(A, assessor, id1001);
  const g3 = await call('GET', `/tenants/${NP}/vm/poam/${id1001}`, ownerE, NP);
  assert(g2.status === 200 && g3.status === 409 && g3.body?.code === 'program_required', 'G02 an ASSESSOR reads it too; a tenant with no program -> 409 program_required', [g2.status, g3.status]);
  const g4 = await itemOf(A, viewer, 'no-such-item');
  const g5 = await itemOf(A, viewer, 'a%20b');
  assert(g4.status === 404 && g5.status === 404 && same(g4.body, g5.body), 'G03 an unknown and a malformed id are the same 404', [g4.status, g5.status]);

  // E13: a later scan of the same host that no longer lists CVE-2024-1001 resolves the finding and completes its item
  const e13run = await ingest(tokenA, payload(collectedAt(55_000), [{ vuln_id: 'CVE-2024-1004', severity: 'CRITICAL', detected_at: '2020-01-01T00:00:00Z' }], ['CVE-2024-1001']));
  await __drainVmWorkerForTests();
  const row13 = await rowFor('CVE-2024-1001');
  assert(e13run.status === 202 && row13?.finding?.status === 'RESOLVED' && row13?.status === 'COMPLETED' && row13?.statusChangedBy === 'system:vm-worker', 'E13 a scan without CVE-2024-1001 resolves it and the worker completes the IN_PROGRESS item', [e13run.status, row13?.finding?.status, row13?.status, row13?.statusChangedBy]);
  const events13 = ((await eventsOf(A, viewer, id1001)).body?.events ?? []) as Json[];
  assert(events13.length === 2 && events13[0].source === 'system' && events13[0].actor === 'system:vm-worker' && events13[0].runId === e13run.body?.run_id && events13[0].newStatus === 'COMPLETED' && events13[0].oldStatus === 'IN_PROGRESS' && events13[1].source === 'human', 'E13 the history has the system event with the run id first, then the human one', events13);
  const g6 = await itemOf(A, viewer, id1001);
  assert(g6.status === 200 && g6.body?.item?.status === 'COMPLETED', 'G04 a COMPLETED item is still readable', [g6.status, g6.body?.item?.status]);

  // E14: a person reopens it: the worker no longer completes it
  const e14a = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: row13.updatedAt, status: 'OPEN' });
  assert(e14a.status === 200 && e14a.body?.item?.status === 'OPEN' && e14a.body?.item?.autoComplete === false && e14a.body?.item?.statusChangedBy === 'u_poam_oa', 'E14 reopening a COMPLETED item -> 200, OPEN, autoComplete false', e14a.body);
  const re14 = await call('POST', `/tenants/${A}/vm/runs/${e13run.body?.run_id}/reprocess`, ownerA, A);
  await __drainVmWorkerForTests();
  const row14 = await rowFor('CVE-2024-1001');
  assert(re14.status === 202 && row14?.status === 'OPEN' && row14?.autoComplete === false && row14?.updatedAt === e14a.body?.item?.updatedAt, 'E14 reprocessing the run leaves the reopened item OPEN and untouched', [re14.status, row14?.status, row14?.autoComplete]);
  const e14b = await patchItem(A, ownerA, id1001, { expectedUpdatedAt: row14.updatedAt, status: 'COMPLETED' });
  assert(e14b.status === 200 && e14b.body?.item?.status === 'COMPLETED' && e14b.body?.item?.autoComplete === false, 'E14 a person can complete it again (the finding is RESOLVED)', e14b.body);

  say('\n--- V01-V04: the VM target preview (GET /programs/:id/vm-target/preview) ---');
  const programA3 = await createProgram(A, { name: 'Poam third program', frameworkId: 'CMMC_L1' }, 'test');
  const previewOf = (tenant: string, who: string, programId: string) => call('GET', `/tenants/${tenant}/programs/${programId}/vm-target/preview`, who, tenant);
  const v01 = await previewOf(A, viewer, programA3.id);
  const nowMs = Date.now();
  const overdueNow = (await openFindings()).filter((f) => f.slaDueAt && Date.parse(f.slaDueAt) < nowMs).length;
  const targetView = (await poamOf(A, ownerA)).body as Json;
  assert(
    v01.status === 200 && v01.body?.programId === programA3.id && v01.body?.isTarget === false && v01.body?.eligible === true && v01.body?.ineligibleReason === null && v01.body?.currentTargetId === programA.id && v01.body?.currentTargetExplicit === true &&
      v01.body?.overdueWithoutItem === overdueNow && v01.body?.openPoamInCurrent === targetView.openItemsTotal && v01.body?.autocreateEnabled === true,
    'V01 a VIEWER previews a program that is not the target: the open overdue findings it would have no item for, the current target and its open items',
    [v01.body, overdueNow, targetView.openItemsTotal],
  );
  const v02 = await previewOf(A, ownerA, programA.id);
  assert(v02.status === 200 && v02.body?.isTarget === true && v02.body?.eligible === true && v02.body?.currentTargetId === programA.id, 'V02 the target\'s own preview -> isTarget true', v02.body);
  const nistProgram = (((await call('GET', `/tenants/${N}/programs`, admin, N)).body?.programs ?? []) as Json[]).find((p) => p.frameworkId === 'NIST_800_53_REV5');
  const v03 = await previewOf(N, admin, nistProgram?.id as string);
  assert(Boolean(nistProgram) && v03.status === 200 && v03.body?.eligible === false && v03.body?.ineligibleReason === 'invalid_vm_target' && v03.body?.isTarget === false && v03.body?.currentTargetId === null, 'V03 a NIST 800-53 program -> eligible false, invalid_vm_target', v03.body);
  const v04 = await previewOf(A, ownerA, programB.id);
  const v04b = await previewOf(A, ownerA, 'no-such-program');
  assert(v04.status === 404 && v04.body?.code === 'program_not_found' && v04b.status === 404, "V04 another tenant's program id and an unknown id -> 404 program_not_found", [v04.status, v04b.status]);
  const v05 = await previewOf(A, ownerA, programA2.id);
  assert(v05.status === 200 && v05.body?.eligible === false && v05.body?.ineligibleReason === 'program_archived', 'V05 an archived program -> eligible false, program_archived', v05.body);
  const v06 = await previewOf(A, null as unknown as string, programA3.id);
  assert(v06.status === 401, 'V06 no session -> 401', v06.status);

  say('\n--- P13: nothing about a finding reaches the console ---');
  const leaked = captured.filter((l) => /host-p1|pkg01|CVE-2024-100|OWNER-MARK|MITIGATION-MARK/.test(l));
  assert(captured.length > 0 && leaked.length === 0, 'P13 no host name, package, CVE id, owner or mitigation text in the console output of the ingests, the worker, the edits and the reads', { lines: captured.length, leaked: leaked.length });

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
