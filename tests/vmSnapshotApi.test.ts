import './testEnv';
import { VM_TEST_VAULT } from './vmEnv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { server } from '../server/index';
import { vmIngestRateLimiter, vmTokenRateLimiter } from '../server/routes/vmIngest';
import { __drainVmWorkerForTests } from '../server/vm/worker';
import { __setVmSourceEnabledForTests, recordReceivedRun, updateRun } from '../server/vm/store';
import { __resetVmSnapshotLimiterForTests, __setVmSnapshotFaultForTests } from '../server/vm/snapshotWriter';
import { __runVmSchedulerTickForTests, startVmScheduler, stopVmScheduler } from '../server/vm/scheduler';
import { VM_NOTES_BEGIN, VM_NOTES_END } from '../server/vm/snapshot';
import { readControlAssessments } from '../server/controlAssessments';
import { createProgram, ensureDefaultProgram } from '../server/programs';
import { queryWithProgram } from '../server/db';
import { readTenantFile } from '../server/evidence/storage';
import { insertPoamItems, loadSnapshotFindings } from '../server/vm/findingsStore';

/**
 * Vulnerability-management Phase 5 over HTTP: the snapshot endpoints (evidence files and rows, inheritance, control notes,
 * the per-tenant rate limit, read-back with the integrity check) and the in-process scheduler (staleness, due snapshots,
 * re-entrancy, per-tenant failure isolation). Runs against the in-memory store with a throw-away vault (see ./vmEnv).
 * Boots the server on port 8080: run it alone.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const HTTPS = { 'X-Forwarded-Proto': 'https' };
const ACTOR = 'system:vm-snapshot';
const HOUR = 3_600_000;

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

async function ingest(token: string, bytes: Buffer) {
  resetLimiters();
  const res = await fetch(`${BASE}/vm/ingest`, { method: 'POST', headers: { ...HTTPS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: bytes });
  const text = await res.text();
  let parsed: Json | null = null;
  try { parsed = JSON.parse(text) as Json; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

function payloadOf(label: string, agents: string[]): Record<string, any> {
  return {
    schema_version: 1,
    source: { kind: 'WAZUH', label },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: agents.map((id, i) => ({
      agent_id: id,
      hostname: 'host-' + id,
      findings: [
        { vuln_id: 'CVE-2024-0001', severity: 'HIGH' },
        ...(i === 0 ? [{ vuln_id: 'CVE-2024-0002', severity: 'LOW' }] : []),
      ],
    })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const count = (s: string, needle: string) => s.split(needle).length - 1;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SNAPSHOT_ID = /^vmsnap_\d{13}_[0-9a-f]{5}$/;
const EVIDENCE_ID = /^ev_vmsnap_\d{13}_[0-9a-f]{5}$/;
const INHERITED_TARGETS = ['164.308(a)(1)(ii)(D)', 'CC7.1', 'SI-2'];

async function shutdown(code: number) {
  process.exitCode = code;
  stopVmScheduler();
  await __drainVmWorkerForTests().catch(() => undefined);
  try { fs.rmSync(VM_TEST_VAULT, { recursive: true, force: true }); } catch { /* best effort */ }
  server.closeAllConnections();
  server.close();
}

/** A received run the worker never sees: enough to give a tenant a source and a run to evaluate. */
let runCounter = 0;
const dummyRun = (label: string) => {
  runCounter += 1;
  return {
    id: `run_snap_${runCounter}_${crypto.randomBytes(3).toString('hex')}`,
    kind: 'WAZUH' as const,
    label,
    collectedAt: null,
    exporterName: 'snap-test',
    exporterVersion: '1',
    hostCount: 0,
    findingCount: 0,
    rawPath: path.join(VM_TEST_VAULT, 'tenants', 'none', 'vm', 'runs', `dummy_${runCounter}.json`),
    rawSha256: crypto.randomBytes(32).toString('hex'),
    rawBytes: 0,
  };
};

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  console.log('--- Setup: users, tenants, sources ---');
  process.env.PLATFORM_ADMIN_EMAILS = 'u_snap_admin@test.mil';
  const owner1 = person('u_snap_o1');
  const viewer = person('u_snap_v');
  const admin = person('u_snap_admin');
  const owner3 = person('u_snap_o3');
  const owner4 = person('u_snap_o4');
  const mkTenant = async (who: string, name: string, extra: Record<string, unknown> = {}) =>
    (await call('POST', '/tenants', who, undefined, { name, ...extra })).body?.tenant?.id as string;
  const L1 = await mkTenant(owner1, 'Snap L1');
  const L2 = await mkTenant(admin, 'Snap L2', { primaryFramework: 'CMMC_L2' });
  const N = await mkTenant(owner3, 'Snap N');
  const S = await mkTenant(owner4, 'Snap S');
  assert(Boolean(L1 && L2 && N && S), 'four tenants created (L1 default program, L2 CMMC Level 2 by an administrator, N without a source, S)', { L1, L2, N, S });
  await call('POST', `/tenants/${L1}/members`, owner1, L1, { userId: 'u_snap_v', email: 'u_snap_v@test.mil', role: 'VIEWER' });

  const tokenRes = await call('POST', `/tenants/${L1}/vm/tokens`, owner1, L1, { name: 'snap-ingest' }, HTTPS);
  const l1Token = tokenRes.body?.token as string;
  const l1Ingest = await ingest(l1Token, Buffer.from(JSON.stringify(payloadOf('wazuh-snap', ['001', '002']))));
  await __drainVmWorkerForTests();
  assert(tokenRes.status === 201 && l1Ingest.status === 202, 'tenant L1 has a service token and one ingested run of two hosts', [tokenRes.status, l1Ingest.status]);
  await recordReceivedRun(L2, dummyRun('l2-src'));
  const sSource = await recordReceivedRun(S, dummyRun('src-s'));
  const sId = sSource.source.id;

  const evidenceOf = async (tenant: string, who: string) => ((await call('GET', '/evidence', who, tenant)).body?.evidence ?? []) as Json[];
  const snapshotRowsOf = async (tenant: string, who: string) => (await evidenceOf(tenant, who)).filter((e) => e.uploadedBy === ACTOR);
  const controlsOf = async (tenant: string, who: string, framework: string) => ((await call('GET', `/controls?framework=${framework}`, who, tenant)).body?.controls ?? []) as Json[];
  const controlOf = async (tenant: string, who: string, framework: string, id: string) => (await controlsOf(tenant, who, framework)).find((c) => c.id === id) as Json;
  const snapshotPost = (tenant: string, who: string) => call('POST', `/tenants/${tenant}/vm/snapshot`, who, tenant);
  const sourcesOf = async (tenant: string, who: string) => ((await call('GET', `/tenants/${tenant}/vm/sources`, who, tenant)).body?.sources ?? []) as Json[];
  const snapFile = (tenant: string, id: string, ext: string) => path.join(VM_TEST_VAULT, 'tenants', tenant, 'vm', 'snapshots', `${id}.${ext}`);

  console.log('\n--- A01-A06: a Level 1 tenant ---');
  const put1 = await call('PUT', '/controls/SI.L1-3.14.1', owner1, L1, { status: 'MET', implementationNotes: 'Human text before.' });
  assert(put1.status === 200, 'A01 the owner sets SI.L1-3.14.1 to MET with human notes (200)', put1.body);

  const post1 = await snapshotPost(L1, owner1);
  const snap1 = (post1.body?.snapshot ?? {}) as Json;
  assert(post1.status === 201 && SNAPSHOT_ID.test(snap1.id), 'A02 POST /vm/snapshot -> 201 with a snapshot id', post1.body);
  assert(same(snap1.controls, ['SI.L1-3.14.1']) && Array.isArray(snap1.evidenceIds) && snap1.evidenceIds.length === 2 && snap1.evidenceIds.every((e: string) => EVIDENCE_ID.test(e)), 'A02 a Level 1 program gets only SI.L1-3.14.1: two evidence ids (json and markdown)', snap1);

  const jsonPath1 = snapFile(L1, snap1.id, 'json');
  const mdPath1 = snapFile(L1, snap1.id, 'md');
  const rows1 = await snapshotRowsOf(L1, owner1);
  const jsonRow1 = rows1.find((e) => e.name === `${snap1.id}.json` && e.syncStatus === 'local_storage');
  assert(fs.existsSync(jsonPath1) && fs.existsSync(mdPath1), 'A03 both files exist under <vault>/tenants/<L1>/vm/snapshots/');
  assert(fs.existsSync(jsonPath1) && Boolean(jsonRow1) && sha256(fs.readFileSync(jsonPath1)) === jsonRow1?.fileHash, 'A03 the sha256 of the json file equals the evidence row fileHash', jsonRow1);
  assert(fs.existsSync(jsonPath1) && JSON.parse(fs.readFileSync(jsonPath1, 'utf8')).snapshotId === snap1.id, 'A03 the json file holds the report of that snapshot');

  const today = String(snap1.createdAt).slice(0, 10);
  const base1 = rows1.filter((e) => e.syncStatus === 'local_storage');
  const inh1 = rows1.filter((e) => e.syncStatus === 'inherited');
  assert(rows1.length === 8, 'A04 eight evidence rows are written by the snapshot actor (2 base + 6 inherited)', rows1.length);
  assert(
    base1.length === 2 && base1.every((e) => e.controlId === 'SI.L1-3.14.1' && e.description === `Automated vulnerability management snapshot ${today}`) &&
      same(base1.map((e) => e.mimeType).sort(), ['application/json', 'text/markdown']),
    'A04 the base rows sit on SI.L1-3.14.1 with the description, as application/json and text/markdown',
    base1,
  );
  assert(
    inh1.length === 6 && same([...new Set(inh1.map((e) => e.controlId))].sort(), INHERITED_TARGETS) && inh1.every((e) => String(e.description).startsWith('[Inherited from SI.L1-3.14.1] ')),
    'A04 six inherited rows sit on SI-2, CC7.1 and 164.308(a)(1)(ii)(D)',
    inh1.map((e) => e.controlId),
  );
  assert(!rows1.some((e) => /^(RA|CA)\.L2-/.test(e.controlId)), 'A04 no row sits on an RA.L2 or CA.L2 control');

  const verifyIds = [...(snap1.evidenceIds as string[]), inh1[0]?.id as string];
  const verified: Json[] = [];
  for (const id of verifyIds) verified.push(((await call('GET', `/evidence/${id}/verify-integrity`, owner1, L1)).body ?? {}) as Json);
  assert(verified.length === 3 && verified.every((v) => v.verified === true && v.status === 'INTEGRITY_VERIFIED'), 'A05 /verify-integrity passes for the two base ids and one inherited id', verified);

  const si1 = await controlOf(L1, owner1, 'CMMC_L1', 'SI.L1-3.14.1');
  const notes1 = String(si1?.implementationNotes);
  assert(si1?.status === 'MET', 'A06 the human status MET is untouched', si1?.status);
  assert(notes1.startsWith(`Human text before.\n\n${VM_NOTES_BEGIN}`) && count(notes1, VM_NOTES_BEGIN) === 1 && count(notes1, VM_NOTES_END) === 1, 'A06 the notes keep the human text, then one delimited block', notes1);
  assert((snap1.evidenceIds as string[]).every((e) => notes1.includes(e)), 'A06 the block names both evidence ids');

  console.log('\n--- A07-A09: rate limit, second snapshot, rows ---');
  const again = await snapshotPost(L1, owner1);
  assert(again.status === 429 && again.body?.error === 'vm_snapshot_too_soon' && typeof again.body?.retryAfterSeconds === 'number' && again.body.retryAfterSeconds > 0, 'A07 an immediate second POST -> 429 vm_snapshot_too_soon with retryAfterSeconds', again.body);

  __resetVmSnapshotLimiterForTests();
  const put2 = await call('PUT', '/controls/SI.L1-3.14.1', owner1, L1, { status: 'MET', implementationNotes: `${notes1}\n\nHuman text after.` });
  const post2 = await snapshotPost(L1, owner1);
  const snap2 = (post2.body?.snapshot ?? {}) as Json;
  assert(put2.status === 200 && post2.status === 201 && SNAPSHOT_ID.test(snap2.id) && snap2.id !== snap1.id, 'A08 after the limit is reset and the human adds text, a second snapshot -> 201 with a new id', [put2.status, post2.body]);
  const si2 = await controlOf(L1, owner1, 'CMMC_L1', 'SI.L1-3.14.1');
  const notes2 = String(si2?.implementationNotes);
  assert(count(notes2, VM_NOTES_BEGIN) === 1 && count(notes2, VM_NOTES_END) === 1, 'A08 the notes still hold exactly one begin and one end marker', notes2);
  assert(notes2.startsWith('Human text before.') && notes2.includes('Human text after.'), 'A08 the human text before and after the block survives');
  assert((snap2.evidenceIds as string[]).every((e) => notes2.includes(e)) && !(snap1.evidenceIds as string[]).some((e) => notes2.includes(e)), 'A08 the block holds the new evidence ids and none of the old ones');
  assert(si2?.status === 'MET', 'A08 the status is still MET', si2?.status);
  assert((await snapshotRowsOf(L1, owner1)).length === 16, 'A08 sixteen snapshot rows in total after two snapshots', (await snapshotRowsOf(L1, owner1)).length);

  const live1 = await readControlAssessments({ tenantId: L1, programId: (await ensureDefaultProgram(L1)).id });
  assert(!live1.has('RA.L2-3.11.2') && !live1.has('RA.L2-3.11.3'), 'A09 a Level 1 tenant gets no control row on RA.L2-3.11.2 or RA.L2-3.11.3');
  assert(String(live1.get('SI.L1-3.14.1')?.notes).includes(VM_NOTES_BEGIN), 'A09 only SI.L1-3.14.1 carries the block');

  console.log('\n--- A10: a Level 2 tenant ---');
  const put3 = await call('PUT', '/controls/RA.L2-3.11.2', admin, L2, { status: 'NOT_MET', implementationNotes: '' });
  const post3 = await snapshotPost(L2, admin);
  const snap3 = (post3.body?.snapshot ?? {}) as Json;
  assert(put3.status === 200 && post3.status === 201, 'A10 the L2 owner sets RA.L2-3.11.2 and takes a snapshot (200, 201)', [put3.body, post3.body]);
  assert(
    Array.isArray(snap3.controls) && snap3.controls.length === 4 && snap3.controls.includes('CA.L2-3.12.3') && Array.isArray(snap3.evidenceIds) && snap3.evidenceIds.length === 8,
    'A10 four controls including CA.L2-3.12.3 and eight evidence ids',
    snap3,
  );
  assert((await snapshotRowsOf(L2, admin)).length === 14, 'A10 fourteen snapshot rows (8 base + 6 inherited from SI.L1-3.14.1)', (await snapshotRowsOf(L2, admin)).length);
  const live3 = await readControlAssessments({ tenantId: L2, programId: (await ensureDefaultProgram(L2)).id });
  assert(live3.get('RA.L2-3.11.2')?.status === 'NOT_MET', 'A10 RA.L2-3.11.2 is still NOT_MET', live3.get('RA.L2-3.11.2'));
  assert(live3.get('CA.L2-3.12.3')?.status === 'NOT_STARTED' && String(live3.get('CA.L2-3.12.3')?.notes).includes(VM_NOTES_BEGIN), 'A10 the created CA.L2-3.12.3 row is NOT_STARTED and carries the block', live3.get('CA.L2-3.12.3'));

  console.log('\n--- A11-A16: access, listing, read-back, no source, storage ---');
  const viewerPost = await snapshotPost(L1, viewer);
  const viewerList = await call('GET', `/tenants/${L1}/vm/snapshots`, viewer, L1);
  assert(viewerPost.status === 403 && viewerList.status === 200, 'A11 a VIEWER cannot POST a snapshot (403) but can list snapshots (200)', [viewerPost.status, viewerList.status]);
  assert((await snapshotPost(L1, admin)).status === 403, "A12 another tenant's owner posting to L1 -> 403");

  const list = await call('GET', `/tenants/${L1}/vm/snapshots`, owner1, L1);
  const listed = (list.body?.snapshots ?? []) as Json[];
  assert(list.body?.totalCount === 2 && listed.length === 2 && listed[0].id === snap2.id && listed[1].id === snap1.id, 'A13 two snapshots, newest first', listed.map((s) => s.id));
  assert(listed.every((s) => Array.isArray(s.evidenceIds) && s.evidenceIds.length === 2 && Array.isArray(s.controls) && s.controls.length === 1), 'A13 each lists 2 evidence ids and 1 control');

  const latest = await call('GET', `/tenants/${L1}/vm/snapshot/latest`, owner1, L1);
  const report = (latest.body?.report ?? {}) as Json;
  assert(latest.status === 200 && report.snapshotId === snap2.id, 'A14 GET /snapshot/latest -> 200 with the newest report', latest.body?.snapshot);
  assert(report.coverage?.inScopeTotal === 0 && report.coverage?.excluded?.unconfirmed === 2 && report.findings?.openBySeverity?.HIGH === 2 && report.findings?.openBySeverity?.LOW === 1 && report.criteria?.coverage?.met === false, 'A14 the report: no in-scope assets, two unconfirmed, 2 HIGH and 1 LOW open, coverage not met', report.coverage);
  const original = fs.readFileSync(snapFile(L1, snap2.id, 'json'));
  fs.writeFileSync(snapFile(L1, snap2.id, 'json'), Buffer.concat([original, Buffer.from(' ')]));
  const tampered = await call('GET', `/tenants/${L1}/vm/snapshot/latest`, owner1, L1);
  const jsonRow2 = (await snapshotRowsOf(L1, owner1)).find((e) => e.name === `${snap2.id}.json` && e.syncStatus === 'local_storage');
  const tamperedVerify = await call('GET', `/evidence/${jsonRow2?.id}/verify-integrity`, owner1, L1);
  assert(tampered.status === 409 && tampered.body?.error === 'vm_snapshot_integrity_mismatch', 'A14 one appended byte -> 409 vm_snapshot_integrity_mismatch', tampered.body);
  assert(tamperedVerify.body?.status === 'INTEGRITY_MISMATCH', 'A14 and /verify-integrity reports INTEGRITY_MISMATCH', tamperedVerify.body);
  fs.writeFileSync(snapFile(L1, snap2.id, 'json'), original);
  assert((await call('GET', `/tenants/${L1}/vm/snapshot/latest`, owner1, L1)).status === 200, 'A14 after restoring the bytes the report reads back again (200)');

  const noSource = await snapshotPost(N, owner3);
  const noLatest = await call('GET', `/tenants/${N}/vm/snapshot/latest`, owner3, N);
  assert(noSource.status === 409 && noSource.body?.error === 'vm_no_sources' && (await snapshotRowsOf(N, owner3)).length === 0, 'A15 a tenant without a source -> 409 vm_no_sources and nothing written', noSource.body);
  assert(noLatest.status === 404 && noLatest.body?.error === 'vm_snapshot_not_found', 'A15 and it has no latest snapshot (404 vm_snapshot_not_found)', noLatest.body);

  process.env.STORAGE_PROVIDER = 'gcs';
  __resetVmSnapshotLimiterForTests();
  const noStore = await snapshotPost(L1, owner1);
  process.env.STORAGE_PROVIDER = 'local';
  assert(noStore.status === 503 && noStore.body?.error === 'vm_requires_local_storage', 'A16 a non-local STORAGE_PROVIDER at runtime (gcs) -> 503 vm_requires_local_storage', noStore.body);
  const afterGcs = await snapshotPost(L1, owner1);
  assert(afterGcs.status !== 429 && afterGcs.status === 201, 'A16 the next POST is not rate limited (the failed one did not consume the window)', afterGcs.body);

  console.log('\n--- A17-A24: the scheduler ---');
  const t17a = await __runVmSchedulerTickForTests({ onlyTenantIds: [L1, N, S] });
  assert(t17a.skipped === false && same(t17a.snapshots, [S]), 'A17 the first tick snapshots only S (L1 is recent, N has no source)', t17a);
  const t17b = await __runVmSchedulerTickForTests({ onlyTenantIds: [L1, N, S] });
  assert(same(t17b.snapshots, []), 'A17 the next tick snapshots nothing', t17b);
  const t17c = await __runVmSchedulerTickForTests({ now: new Date(Date.now() + 169 * HOUR), onlyTenantIds: [L1, N, S] });
  assert(t17c.snapshots.includes(S) && t17c.snapshots.includes(L1) && !t17c.snapshots.includes(N), 'A17 a tick 169 h later snapshots S and L1', t17c);

  const sAfter = (await sourcesOf(S, owner4)).find((s) => s.id === sId) as Json;
  assert(sAfter?.staleSince === new Date(Date.parse(sAfter.lastRunAt) + 1440 * 60_000).toISOString(), 'A18 the stale source has stale_since = last run + its interval', [sAfter?.staleSince, sAfter?.lastRunAt]);
  const t18 = await __runVmSchedulerTickForTests({ onlyTenantIds: [L1, S] });
  const sCleared = (await sourcesOf(S, owner4)).find((s) => s.id === sId) as Json;
  assert(sCleared?.staleSince === null && t18.staleCleared >= 1, 'A18 a tick at the real time clears stale_since', [sCleared?.staleSince, t18]);

  const t19 = await __runVmSchedulerTickForTests({ now: new Date(Date.now() + 48 * HOUR), onlyTenantIds: [S] });
  const sStale = (await sourcesOf(S, owner4)).find((s) => s.id === sId) as Json;
  assert(sStale?.staleSince !== null && t19.staleSet >= 1, 'A19 a tick 48 h later marks the source stale', [sStale?.staleSince, t19]);
  await recordReceivedRun(S, dummyRun('src-s'));
  const sReceived = (await sourcesOf(S, owner4)).find((s) => s.id === sId) as Json;
  assert(sReceived?.staleSince === null, 'A19 a received run clears stale_since', sReceived?.staleSince);

  __setVmSourceEnabledForTests(sId, false);
  await __runVmSchedulerTickForTests({ now: new Date(Date.now() + 48 * HOUR), onlyTenantIds: [S] });
  const sDisabled = (await sourcesOf(S, owner4)).find((s) => s.id === sId) as Json;
  __setVmSourceEnabledForTests(sId, true);
  assert(sDisabled?.enabled === false && sDisabled?.staleSince === null, 'A20 a disabled source is never marked stale', [sDisabled?.enabled, sDisabled?.staleSince]);

  const [r1, r2] = await Promise.all([__runVmSchedulerTickForTests({ onlyTenantIds: [S] }), __runVmSchedulerTickForTests({ onlyTenantIds: [S] })]);
  assert([r1, r2].filter((r) => r.skipped).length === 1, 'A21 two ticks started together: exactly one is skipped', [r1, r2]);

  __setVmSnapshotFaultForTests(S);
  const t22 = await __runVmSchedulerTickForTests({ now: new Date(Date.now() + 400 * HOUR), onlyTenantIds: [S, L1] });
  __setVmSnapshotFaultForTests(null);
  assert(t22.errors === 1 && t22.snapshots.includes(L1) && !t22.snapshots.includes(S), 'A22 a failing tenant is counted and the next tenant still runs', t22);

  const outside = await readTenantFile(L1, path.join(VM_TEST_VAULT, 'tenants', L2, 'x'));
  const inside = await readTenantFile(L1, snapFile(L1, snap2.id, 'json'));
  assert(outside === null && Buffer.isBuffer(inside), 'A23 readTenantFile refuses another tenant directory (null) and reads one of its own (Buffer)', [outside, inside]);

  assert(startVmScheduler() === null, 'A24 the server already started the scheduler: startVmScheduler() -> null');

  console.log('\n--- A25: a failed latest run ---');
  await sleep(5);
  const failedRun = await recordReceivedRun(S, dummyRun('src-s'));
  await updateRun(S, failedRun.run.id, { status: 'FAILED', error: 'The stored payload could not be read.', finishedAt: new Date().toISOString() });
  __resetVmSnapshotLimiterForTests();
  const post25a = await snapshotPost(S, owner4);
  const latest25a = await call('GET', `/tenants/${S}/vm/snapshot/latest`, owner4, S);
  const rep25a = (latest25a.body?.report ?? {}) as Json;
  assert(post25a.status === 201 && rep25a.snapshotId === post25a.body?.snapshot?.id, 'A25 a snapshot is taken while the latest run is FAILED (201)', post25a.body);
  assert(rep25a.criteria?.sourcesWithinInterval?.met === false && String(rep25a.criteria?.sourcesWithinInterval?.reason).includes('(last run failed)'), 'A25 a source whose latest run FAILED makes criterion 1 not met', rep25a.criteria?.sourcesWithinInterval);
  assert(rep25a.sources?.items?.[0]?.lastRun?.error === 'The stored payload could not be read.', 'A25 the report shows the fixed failure message of that run', rep25a.sources?.items?.[0]?.lastRun);

  await sleep(5);
  const okRun = await recordReceivedRun(S, dummyRun('src-s'));
  await updateRun(S, okRun.run.id, { status: 'NORMALIZED', finishedAt: new Date().toISOString() });
  __resetVmSnapshotLimiterForTests();
  await sleep(5);
  const post25b = await snapshotPost(S, owner4);
  const latest25b = await call('GET', `/tenants/${S}/vm/snapshot/latest`, owner4, S);
  const rep25b = (latest25b.body?.report ?? {}) as Json;
  assert(post25b.status === 201 && rep25b.snapshotId === post25b.body?.snapshot?.id && rep25b.criteria?.sourcesWithinInterval?.met === true, 'A25 a NORMALIZED run after it makes criterion 1 met again', rep25b.criteria?.sourcesWithinInterval);

  console.log('\n--- A26: the snapshot belongs to the default program only ---');
  const defaultL1 = await ensureDefaultProgram(L1);
  const programB = await createProgram(L1, { name: 'Snap L1 second program', frameworkId: 'CMMC_L1' }, 'u_snap_o1');
  const scopeDefault = { tenantId: L1, programId: defaultL1.id };
  const scopeB = { tenantId: L1, programId: programB.id };
  const liveDefault = await readControlAssessments(scopeDefault);
  const liveB = await readControlAssessments(scopeB);
  assert(String(liveDefault.get('SI.L1-3.14.1')?.notes).includes(VM_NOTES_BEGIN), 'A26 the default program carries the snapshot block on SI.L1-3.14.1');
  assert(![...liveB.values()].some((c) => String(c.notes).includes(VM_NOTES_BEGIN)), 'A26 a second program holds no snapshot block', [...liveB.keys()]);
  const evidenceIn = async (scope: { tenantId: string; programId: string }) =>
    (await queryWithProgram(scope, 'SELECT id, program_id, uploaded_by FROM evidence_metadata WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId])).rows.filter((r) => r.uploaded_by === ACTOR);
  const evDefault = await evidenceIn(scopeDefault);
  const evB = await evidenceIn(scopeB);
  assert(evDefault.length >= 8 && evDefault.every((r) => r.program_id === defaultL1.id), 'A26 the default program holds the snapshot evidence rows, all stamped with its id', evDefault.length);
  assert(evB.length === 0, 'A26 a second program holds no system:vm-snapshot evidence', evB.length);
  __resetVmSnapshotLimiterForTests();
  const postB = await call('POST', `/tenants/${L1}/vm/snapshot`, owner1, L1, undefined, { 'x-program-id': programB.id });
  const evBAfter = await evidenceIn(scopeB);
  const evDefaultAfter = await evidenceIn(scopeDefault);
  assert(postB.status === 201 && evBAfter.length === 0 && evDefaultAfter.length > evDefault.length, 'A26 a snapshot requested with x-program-id of the second program still lands in the default program', [postB.status, evBAfter.length, evDefaultAfter.length]);

  console.log('\n--- A27: the VM target program receives the snapshot ---');
  const setB = await call('PUT', `/tenants/${L1}/programs/${programB.id}/vm-target`, owner1, L1);
  const setBViewer = await call('PUT', `/tenants/${L1}/programs/${programB.id}/vm-target`, viewer, L1);
  assert(setB.status === 200 && setB.body?.program?.vmTarget === true && setBViewer.status === 403, 'A27a the owner sets the second program as the VM target (200, vmTarget true); a VIEWER gets 403', [setB.status, setB.body?.program?.vmTarget, setBViewer.status]);

  const evDefaultBefore27 = (await evidenceIn(scopeDefault)).length;
  __resetVmSnapshotLimiterForTests();
  const post27 = await snapshotPost(L1, owner1);
  const snap27 = (post27.body?.snapshot ?? {}) as Json;
  const evB27 = await evidenceIn(scopeB);
  const evDefault27 = await evidenceIn(scopeDefault);
  assert(post27.status === 201 && snap27.programId === programB.id, 'A27b a manual snapshot without a header lands in the target program (201, snapshot.programId)', [post27.status, snap27.programId]);
  assert(Array.isArray(snap27.controls) && snap27.controls.length > 0 && evB27.length === 2 * snap27.controls.length * (1 + INHERITED_TARGETS.length), 'A27b the target program holds 2 files x controls x (1 + inheritance targets) evidence rows', [evB27.length, snap27.controls]);
  assert(evDefault27.length === evDefaultBefore27, 'A27b the default program gains no evidence rows', [evDefault27.length, evDefaultBefore27]);

  const liveB27 = await readControlAssessments(scopeB);
  assert(String(liveB27.get('SI.L1-3.14.1')?.notes).includes(VM_NOTES_BEGIN), 'A27c the target program carries the snapshot block on SI.L1-3.14.1');

  const list27 = await call('GET', `/tenants/${L1}/vm/snapshots`, owner1, L1);
  const latest27 = await call('GET', `/tenants/${L1}/vm/snapshot/latest`, owner1, L1);
  assert(list27.body?.totalCount === 1 && list27.body?.snapshots?.[0]?.id === snap27.id && latest27.status === 200 && latest27.body?.report?.snapshotId === snap27.id, 'A27d the listing and the latest snapshot follow the target program', [list27.body?.totalCount, list27.body?.snapshots?.[0]?.id, latest27.status]);

  const tick27 = await __runVmSchedulerTickForTests({ now: new Date(Date.now() + 169 * HOUR), onlyTenantIds: [L1] });
  const evB27b = await evidenceIn(scopeB);
  assert(tick27.snapshots.includes(L1) && evB27b.length > evB27.length, 'A27e the scheduler writes its due snapshot into the target program', [tick27, evB27b.length, evB27.length]);

  const archiveB = await call('POST', `/tenants/${L1}/programs/${programB.id}/archive`, owner1, L1);
  assert(archiveB.status === 409 && archiveB.body?.code === 'program_is_vm_target', 'A27f archiving the VM target is refused (409 program_is_vm_target)', [archiveB.status, archiveB.body]);

  const draft = {
    findingId: 'fnd_a27g_' + crypto.randomBytes(4).toString('hex'),
    controlId: 'RA.L2-3.11.3' as const,
    weakness: 'A27g',
    mitigation: '' as const,
    owner: '' as const,
    scheduledCompletion: null,
    status: 'OPEN' as const,
    createdBy: 'system:vm-worker' as const,
  };
  await insertPoamItems(L1, [draft], null, defaultL1.id);
  const poamB = (await loadSnapshotFindings(L1, programB.id)).poam;
  const poamDefault = (await loadSnapshotFindings(L1, defaultL1.id)).poam;
  assert(poamB.length === 0 && poamDefault.length >= 1, 'A27g the snapshot input holds only the program\'s own POA&M items (memory matches RLS)', [poamB.length, poamDefault.length]);

  const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
  const workerSrc = src('server/vm/worker.ts');
  assert(workerSrc.includes('resolveVmTargetProgram(') && !workerSrc.includes('ensureDefaultProgram('), 'A27h the worker resolves the VM target program and no longer the default');
  assert(!src('server/routes/vm.ts').includes('ensureDefaultProgram('), 'A27h the snapshot route no longer pins the default program');

  const setDefault = await call('PUT', `/tenants/${L1}/programs/${defaultL1.id}/vm-target`, owner1, L1);
  const evBBefore27i = (await evidenceIn(scopeB)).length;
  const evDefaultBefore27i = (await evidenceIn(scopeDefault)).length;
  __resetVmSnapshotLimiterForTests();
  const post27i = await snapshotPost(L1, owner1);
  const evBAfter27i = (await evidenceIn(scopeB)).length;
  const evDefaultAfter27i = (await evidenceIn(scopeDefault)).length;
  assert(setDefault.status === 200 && post27i.status === 201 && evDefaultAfter27i > evDefaultBefore27i && evBAfter27i === evBBefore27i, 'A27i moving the target back to the default program sends the next snapshot there and none to the second program', [setDefault.status, post27i.status, evDefaultBefore27i, evDefaultAfter27i, evBBefore27i, evBAfter27i]);

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
