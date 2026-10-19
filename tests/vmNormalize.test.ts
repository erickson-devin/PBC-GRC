import {
  canonicalVulnId,
  normalizeWazuh,
  recheckSeverity,
  severityFromCvss,
  type NormalizedFinding,
  type NormalizedHost,
} from '../server/vm/adapters/wazuh';
import {
  VM_POAM_CONTROL_ID,
  VM_SLA_DEFAULTS,
  VM_WORKER_ACTOR,
  applyRun,
  effectiveSlaDays,
  firstSeenFor,
  foldRun,
  getVmSlaConfig,
  isPoamAutocreateEnabled,
  planPoamItems,
  poamWeakness,
  slaDueAt,
  staleRunsToRecover,
  worstSeverity,
  type ApplyRunInput,
  type LinkedPoamItem,
  type PoamCandidate,
  type VmSlaConfig,
} from '../server/vm/transitions';
import { kindKey, normalizeMac, planAssetMatches, type AgentAssetCandidate } from '../server/vm/assetMatch';
import { validateIngestPayload, type IngestPayload } from '../server/vm/ingestSchema';
import type { VmFinding, VmRun } from '../src/types/vm';

/**
 * Pure checks (no server, no database): the Wazuh adapter, the finding lifecycle reducer, SLA and POA&M planning, stale run
 * recovery and asset matching (docs/VULNERABILITY_MANAGEMENT.md, section 6).
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
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const SRC = 'src-wazuh';
const SRC2 = 'src-s1';
const T = 'tenant-t';
const R1 = '2026-01-01T00:00:00.000Z';
const R2 = '2026-01-08T00:00:00.000Z';
const R3 = '2026-01-15T00:00:00.000Z';
const A = 'asset-a';
const B = 'asset-b';
const SLA: VmSlaConfig = { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 };
const VID = 'CVE-2026-0001';
const DAY = 86_400_000;
const plus = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

let seq = 0;
const newId = () => `f-${++seq}`;

const finding = (o: Partial<VmFinding> = {}): VmFinding => ({
  id: 'f-existing',
  tenantId: T,
  assetId: A,
  vulnId: VID,
  status: 'OPEN',
  severity: 'HIGH',
  firstSeenAt: '2025-12-20T00:00:00.000Z',
  lastSeenAt: R1,
  resolvedAt: null,
  resolvedRunId: null,
  slaDueAt: '2026-01-19T00:00:00.000Z',
  packageName: 'openssl',
  packageVersion: '1.0',
  fixedVersion: '1.1',
  justification: null,
  decidedBy: null,
  decidedByUserId: null,
  decidedAt: null,
  ...o,
});

const nfind = (o: Partial<NormalizedFinding> = {}): NormalizedFinding => ({
  vulnId: VID,
  severity: 'HIGH',
  reportedSeverities: [o.severity ?? 'HIGH'],
  title: 'Test vulnerability',
  cvssV3: 7.5,
  detectedAt: null,
  publishedAt: null,
  refs: [],
  packages: [{ name: 'openssl', version: '1.0', fixedVersion: '1.1' }],
  ...o,
});

const nhost = (findings: NormalizedFinding[], o: Partial<NormalizedHost> = {}): NormalizedHost => ({
  agentId: '001',
  hostname: 'web-01',
  ip: '10.0.0.1',
  mac: '00:11:22:33:44:55',
  osName: 'Ubuntu',
  osVersion: '22.04',
  findings,
  ...o,
});

const runOf = (id: string, receivedAt: string, sourceId = SRC) => ({ id, sourceId, receivedAt, collectedAt: receivedAt });

interface Opts {
  run?: ReturnType<typeof runOf>;
  hosts?: Array<{ assetId: string; host: NormalizedHost }>;
  existing?: VmFinding[];
  sighted?: string[];
  kev?: string[];
  sla?: VmSlaConfig;
}
const apply = (o: Opts) => {
  const input: ApplyRunInput = {
    tenantId: T,
    run: o.run ?? runOf('run-1', R1),
    hosts: o.hosts ?? [{ assetId: A, host: nhost([nfind()]) }],
    existing: o.existing ?? [],
    sightedBySource: new Set(o.sighted ?? []),
    kev: new Set(o.kev ?? []),
    sla: o.sla ?? SLA,
    newId,
  };
  return applyRun(input);
};
const hostA = (findings: NormalizedFinding[]) => [{ assetId: A, host: nhost(findings) }];

// ---------- Lifecycle ----------
{
  const r = apply({ hosts: hostA([nfind({ detectedAt: '2025-12-20T00:00:00.000Z' })]) });
  const f = r.created[0];
  assert(r.created.length === 1 && f.status === 'OPEN', 'T01 new finding is OPEN', r.created);
  assert(f.firstSeenAt === '2025-12-20T00:00:00.000Z', 'T01 first_seen = detected_at', f.firstSeenAt);
  assert(f.lastSeenAt === R1, 'T01 last_seen = run received_at', f.lastSeenAt);
  assert(f.severity === 'HIGH' && f.slaDueAt === '2026-01-19T00:00:00.000Z', 'T01 HIGH, sla 2026-01-19', f);
  assert(r.sightings.length === 1 && r.sightings[0].findingId === f.id, 'T01 one sighting', r.sightings);
  assert(
    f.decidedBy === null && f.decidedAt === null && f.justification === null && f.resolvedAt === null,
    'T01 decision fields null',
  );
  assert(r.updated.length === 0 && r.resolved.length === 0, 'T01 no POA&M and no other output (planning is separate)');
}
{
  const r = apply({});
  assert(r.created[0].firstSeenAt === R1 && r.created[0].slaDueAt === '2026-01-31T00:00:00.000Z', 'T02 no detected_at -> first_seen = received_at, sla 2026-01-31', r.created[0]);
}
{
  const r = apply({ hosts: hostA([nfind({ detectedAt: '2026-02-01T00:00:00.000Z' })]) });
  assert(r.created[0].firstSeenAt === R1, 'T03 detected_at after received_at is clamped to received_at', r.created[0].firstSeenAt);
}
{
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id] });
  const next = foldRun([prev], r)[0];
  assert(next.lastSeenAt === R2, 'T04 re-sighting moves last_seen', next.lastSeenAt);
  assert(
    eq({ ...next, lastSeenAt: R1 }, prev) && r.created.length === 0 && r.resolved.length === 0,
    'T04 only last_seen moves',
    next,
  );
  assert(r.sightings.length === 1, 'T04 one sighting', r.sightings);
}
{
  const prev = finding({ severity: 'MEDIUM', slaDueAt: '2026-03-20T00:00:00.000Z' });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'HIGH' })]) });
  const next = r.updated[0];
  assert(next.severity === 'HIGH', 'T05 worse severity raises severity', next.severity);
  assert(next.slaDueAt === '2026-01-19T00:00:00.000Z', 'T05 SLA recomputed from existing first_seen', next.slaDueAt);
}
{
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'LOW' })]) });
  const next = foldRun([prev], r)[0];
  assert(next.severity === 'HIGH' && next.slaDueAt === prev.slaDueAt, 'T06 better severity keeps old severity and SLA', next);
  assert(r.sightings[0].reportedSeverity === 'LOW', 'T06 sighting carries reported LOW', r.sightings[0]);
}
{
  const prev = finding({ severity: 'LOW', slaDueAt: '2026-06-18T00:00:00.000Z' });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'UNKNOWN' })]) });
  const next = foldRun([prev], r)[0];
  assert(next.severity === 'UNKNOWN', 'T07 UNKNOWN after LOW -> UNKNOWN', next.severity);
  assert(next.slaDueAt === plus(prev.firstSeenAt, 90), 'T07 UNKNOWN uses the MEDIUM SLA', next.slaDueAt);
}
{
  const prev = finding({ severity: 'MEDIUM', slaDueAt: plus('2025-12-20T00:00:00.000Z', 90) });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'UNKNOWN' })]) });
  const next = foldRun([prev], r)[0];
  assert(next.severity === 'MEDIUM', 'T08 UNKNOWN after MEDIUM -> MEDIUM kept', next.severity);
}
{
  const prev = finding();
  const pk = [{ name: 'zlib', version: '2.0', fixedVersion: null }];
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ packages: pk })]) });
  const next = foldRun([prev], r)[0];
  assert(
    next.packageName === 'zlib' && next.packageVersion === '2.0' && next.fixedVersion === null,
    'T09 package fields come from the latest sighting',
    next,
  );
}
{
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  const res = r.resolved[0];
  assert(r.resolved.length === 1 && res.status === 'RESOLVED', 'T10 absent finding is RESOLVED', r.resolved);
  assert(res.resolvedAt === R2 && res.resolvedRunId === 'run-2', 'T10 resolved_at = R2.receivedAt, resolved_run_id run-2', res);
  assert(r.sightings.length === 0, 'T10 closure writes no sighting', r.sightings);
  assert(
    eq({ ...res, status: 'OPEN', resolvedAt: null, resolvedRunId: null }, prev),
    'T10 other fields unchanged',
    res,
  );
  assert(res.slaDueAt === prev.slaDueAt, 'T39 RESOLVED keeps sla_due_at', res.slaDueAt);
}
{
  const prev = finding({ assetId: B });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 0 && r.updated.length === 0, 'T11 asset not reported by the run is untouched', r);
}
{
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [], hosts: hostA([]) });
  assert(r.resolved.length === 0 && r.updated.length === 0, 'T12 finding sighted only by another source is untouched', r);
}
{
  // The finding was sighted by this source and by SRC2; this source's run no longer lists it. The spec closes it (limitation).
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2, SRC), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 1, 'T13 sighted by both sources, absent from this source run -> RESOLVED (spec as written)', r);
}
for (const [t, status] of [['T14', 'RISK_ACCEPTED'], ['T15', 'FALSE_POSITIVE']] as const) {
  const prev = finding({ status, justification: 'because', decidedBy: 'dev', decidedAt: R1 });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 0 && r.updated.length === 0, `${t} ${status} absent -> untouched`, r);
}
{
  const prev = finding({ status: 'RESOLVED', resolvedAt: R2, resolvedRunId: 'run-2' });
  const r = apply({ run: runOf('run-3', R3), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 0 && r.updated.length === 0, 'T16 RESOLVED absent again -> unchanged', r);
  assert(foldRun([prev], r)[0].resolvedRunId === 'run-2', 'T16 resolved_run_id stays', foldRun([prev], r)[0]);
}
{
  const prev = finding({ status: 'RESOLVED', resolvedAt: R2, resolvedRunId: 'run-2' });
  const r = apply({
    run: runOf('run-3', R3),
    existing: [prev],
    sighted: [prev.id],
    hosts: hostA([nfind({ detectedAt: '2025-12-20T00:00:00.000Z' })]),
  });
  const next = r.updated[0];
  assert(next.status === 'OPEN' && next.firstSeenAt === R3, 'T17 reopen -> OPEN, first_seen = R3 (older detected_at ignored)', next);
  assert(next.resolvedAt === null && next.resolvedRunId === null, 'T17 resolved fields null', next);
  assert(next.slaDueAt === plus(R3, 30), 'T17 SLA restarted', next.slaDueAt);
  assert(r.sightings.length === 1 && next.lastSeenAt === R3, 'T17 sighting written', r.sightings);
}
{
  const prev = finding({ status: 'RESOLVED', resolvedAt: R2, resolvedRunId: 'run-2' });
  const det = '2026-01-10T00:00:00.000Z';
  const r = apply({ run: runOf('run-3', R3), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ detectedAt: det })]) });
  assert(r.updated[0].firstSeenAt === det, 'T18 reopen with detected_at after the closing run -> first_seen = detected_at', r.updated[0]);
}
{
  const prev = finding({ status: 'RESOLVED', severity: 'CRITICAL', resolvedAt: R2, resolvedRunId: 'run-2' });
  const r = apply({ run: runOf('run-3', R3), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'LOW' })]) });
  const next = r.updated[0];
  assert(next.severity === 'LOW', 'T19 reopen takes reported severity (CRITICAL -> LOW)', next.severity);
  assert(next.slaDueAt === plus(next.firstSeenAt, 180), 'T19 SLA from new first_seen', next.slaDueAt);
}
for (const [t, status] of [['T20', 'RISK_ACCEPTED'], ['T21', 'FALSE_POSITIVE']] as const) {
  const prev = finding({ status, severity: 'LOW', justification: 'because', decidedBy: 'dev', decidedAt: R1 });
  const pk = [{ name: 'zlib', version: '2.0', fixedVersion: null }];
  const r = apply({
    run: runOf('run-2', R2),
    existing: [prev],
    sighted: [prev.id],
    hosts: hostA([nfind({ severity: 'CRITICAL', packages: pk })]),
  });
  const next = foldRun([prev], r)[0];
  assert(next.lastSeenAt === R2, `${t} ${status} re-sighted -> last_seen moves`, next.lastSeenAt);
  assert(eq({ ...next, lastSeenAt: R1 }, prev), `${t} severity/package/justification/decided_* unchanged`, next);
  assert(r.sightings.length === 1, `${t} sighting written`, r.sightings);
}
{
  const prev = finding({ status: 'RISK_ACCEPTED', justification: 'because', decidedBy: 'dev', decidedAt: R1 });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 0 && r.updated.length === 0 && r.sightings.length === 0, 'T22 RISK_ACCEPTED absent -> untouched, no sighting', r);
}
{
  const pk = [
    { name: 'zlib', version: '2.0', fixedVersion: null },
    { name: 'openssl', version: '1.0', fixedVersion: '1.1' },
  ];
  const r = apply({ hosts: hostA([nfind({ packages: pk })]) });
  assert(r.created.length === 1 && r.sightings.length === 1, 'T23 same CVE in two packages -> one finding, one sighting', r);
  assert(r.created[0].packageName === 'openssl' && r.created[0].packageVersion === '1.0', 'T23 package = smallest name/version', r.created[0]);
  assert((r.sightings[0].detail.packages as unknown[]).length === 2, 'T23 detail.packages.length is 2', r.sightings[0].detail);
}
{
  const r = apply({
    hosts: [
      { assetId: A, host: nhost([nfind()], { agentId: '001' }) },
      { assetId: B, host: nhost([nfind()], { agentId: '002', hostname: 'db-01' }) },
    ],
  });
  assert(r.created.length === 2 && r.sightings.length === 2, 'T24 same CVE on two hosts -> two findings, two sightings', r);
  assert(r.created[0].assetId === A && r.created[1].assetId === B, 'T24 one per asset', r.created);
}
{
  const adapted = normalizeWazuh(
    payload([{ agent_id: '001', findings: [finding1('cve-2026-0001'), finding1('CVE-2026-0001')] }]),
  );
  assert(adapted[0].findings.length === 1 && adapted[0].findings[0].vulnId === 'CVE-2026-0001', 'T25 lowercase cve id == uppercase -> one finding, canonical id', adapted[0].findings);
}
{
  const prev = finding();
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: [] });
  assert(
    r.created.length === 0 && r.updated.length === 0 && r.resolved.length === 0 && r.sightings.length === 0 && r.vulnIds.length === 0,
    'T26 run with zero hosts closes nothing, no output',
    r,
  );
}
{
  const open = finding({ id: 'f-open' });
  const other = finding({ id: 'f-other', vulnId: 'CVE-2026-0002' });
  const accepted = finding({ id: 'f-acc', vulnId: 'CVE-2026-0003', status: 'RISK_ACCEPTED', justification: 'x', decidedBy: 'dev', decidedAt: R1 });
  const open2 = finding({ id: 'f-open2', vulnId: 'CVE-2026-0004' });
  const r = apply({
    run: runOf('run-2', R2),
    existing: [open, other, accepted, open2],
    sighted: ['f-open', 'f-acc', 'f-open2'],
    hosts: hostA([]),
  });
  const ids = r.resolved.map((f) => f.id).sort();
  assert(eq(ids, ['f-open', 'f-open2']), 'T27 host with zero findings closes every OPEN finding of that source on that asset', ids);
  assert(r.updated.length === 0, 'T27 other-source and RISK_ACCEPTED untouched', r.updated);
}
{
  const prev = finding();
  const o: Opts = { run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind({ severity: 'CRITICAL' })]) };
  const first = apply(o);
  const after1 = foldRun([prev], first);
  const second = apply({ ...o, existing: after1 });
  const after2 = foldRun(after1, second);
  assert(eq(after1, after2), 'T28 applying the same run twice -> no further change', after2);
  assert(
    eq(first.sightings.map((s) => [s.findingId, s.runId]), second.sightings.map((s) => [s.findingId, s.runId])),
    'T28 sightings re-emitted with the same key',
  );
  const closeOpts: Opts = { run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) };
  const c1 = foldRun([prev], apply(closeOpts));
  const c2 = foldRun(c1, apply({ ...closeOpts, existing: c1 }));
  assert(eq(c1, c2), 'T28 closing twice -> no further change', c2);
}
{
  const prev = finding({ lastSeenAt: R3 });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([]) });
  assert(r.resolved.length === 0, 'T29 older run processed late never resolves a finding last seen after it', r.resolved);
}
{
  const prev = finding({ status: 'RESOLVED', resolvedAt: R3, resolvedRunId: 'run-3' });
  const r = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], hosts: hostA([nfind()]) });
  assert(r.updated.length === 0 && r.created.length === 0, 'T30 older run processed late never reopens a finding resolved after it', r);
  assert(r.sightings.length === 1, 'T30 the sighting is still recorded', r.sightings);
  const open = finding({ lastSeenAt: R3, severity: 'LOW' });
  const r2 = apply({ run: runOf('run-2', R2), existing: [open], sighted: [open.id], hosts: hostA([nfind({ severity: 'CRITICAL' })]) });
  const next = foldRun([open], r2)[0];
  assert(next.lastSeenAt === R3, 'T30 last_seen never moves backwards', next.lastSeenAt);
  assert(next.severity === 'LOW', 'T30 an older sighting does not change severity', next.severity);
}

// ---------- SLA ----------
{
  const sev = (s: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN') => slaDueAt(R1, s, false, SLA);
  assert(sev('CRITICAL') === '2026-01-16T00:00:00.000Z', 'T31 CRITICAL 15d', sev('CRITICAL'));
  assert(sev('HIGH') === '2026-01-31T00:00:00.000Z', 'T32 HIGH 30d', sev('HIGH'));
  assert(sev('MEDIUM') === '2026-04-01T00:00:00.000Z', 'T33 MEDIUM 90d', sev('MEDIUM'));
  assert(sev('LOW') === '2026-06-30T00:00:00.000Z', 'T34 LOW 180d', sev('LOW'));
  assert(sev('UNKNOWN') === sev('MEDIUM'), 'T35 UNKNOWN = MEDIUM', sev('UNKNOWN'));
  const r = apply({ kev: [VID] });
  assert(r.created[0].severity === 'HIGH' && r.created[0].slaDueAt === '2026-01-16T00:00:00.000Z', 'T36 KEV -> CRITICAL SLA, stored severity unchanged', r.created[0]);
  const longCrit: VmSlaConfig = { CRITICAL: 60, HIGH: 30, MEDIUM: 90, LOW: 180 };
  assert(effectiveSlaDays('HIGH', true, longCrit) === 30, 'T37 KEV = min(CRITICAL days, severity days): HIGH 30 < CRITICAL 60', effectiveSlaDays('HIGH', true, longCrit));
  assert(effectiveSlaDays('MEDIUM', true, longCrit) === 60, 'T37 KEV on MEDIUM with CRITICAL 60 -> 60', effectiveSlaDays('MEDIUM', true, longCrit));
  const prev = finding({ slaDueAt: plus('2025-12-20T00:00:00.000Z', 30) });
  const r2 = apply({ run: runOf('run-2', R2), existing: [prev], sighted: [prev.id], kev: [VID] });
  assert(r2.updated[0].slaDueAt === plus(prev.firstSeenAt, 15), 'T38 KEV learned between runs -> SLA recomputed at next sighting', r2.updated[0]);
}

// ---------- POA&M ----------
const NOW = '2026-03-01T00:00:00.000Z';
const cand = (f: Partial<VmFinding> = {}, kev = false): PoamCandidate => ({
  finding: finding({ firstSeenAt: R1, slaDueAt: '2026-01-31T00:00:00.000Z', ...f }),
  assetName: 'web-01',
  kev,
});
{
  const plan = planPoamItems([cand()], [], NOW);
  assert(plan.length === 1, 'T40 overdue OPEN without item -> one draft', plan);
  assert(plan[0].controlId === 'RA.L2-3.11.3' && plan[0].controlId === VM_POAM_CONTROL_ID, 'T40 against RA.L2-3.11.3', plan[0]);
  assert(plan[0].createdBy === 'system:vm-worker' && plan[0].createdBy === VM_WORKER_ACTOR, 'T40 created_by system:vm-worker', plan[0]);
  assert(plan[0].status === 'OPEN' && plan[0].mitigation === '' && plan[0].owner === '' && plan[0].scheduledCompletion === null, 'T40 draft is OPEN with empty mitigation/owner', plan[0]);
  assert(planPoamItems([cand({ slaDueAt: NOW })], [], NOW).length === 0, 'T41 sla == now is not overdue (strict <)');
  const once = planPoamItems([cand()], [{ findingId: 'f-existing', status: 'OPEN', createdAt: NOW }], NOW);
  assert(once.length === 0, 'T42 once: the second plan is empty', once);
  for (const status of ['OPEN', 'IN_PROGRESS'] as const) {
    const l: LinkedPoamItem[] = [{ findingId: 'f-existing', status, createdAt: '2025-01-01T00:00:00.000Z' }];
    assert(planPoamItems([cand()], l, NOW).length === 0, `T43 ${status} item blocks`);
  }
  const before: LinkedPoamItem[] = [{ findingId: 'f-existing', status: 'COMPLETED', createdAt: '2025-12-01T00:00:00.000Z' }];
  assert(planPoamItems([cand()], before, NOW).length === 1, 'T44a COMPLETED item created before the current first_seen_at does not block');
  const after: LinkedPoamItem[] = [{ findingId: 'f-existing', status: 'COMPLETED', createdAt: '2026-01-05T00:00:00.000Z' }];
  assert(planPoamItems([cand()], after, NOW).length === 0, 'T44b COMPLETED item created at/after first_seen_at blocks');
  const atFirst: LinkedPoamItem[] = [{ findingId: 'f-existing', status: 'COMPLETED', createdAt: R1 }];
  assert(planPoamItems([cand()], atFirst, NOW).length === 0, 'T44b created exactly at first_seen_at blocks');
  const otherFinding: LinkedPoamItem[] = [{ findingId: 'f-other', status: 'OPEN', createdAt: NOW }];
  assert(planPoamItems([cand()], otherFinding, NOW).length === 1, 'T43 an item of another finding does not block');
  for (const status of ['RESOLVED', 'RISK_ACCEPTED', 'FALSE_POSITIVE'] as const) {
    assert(planPoamItems([cand({ status })], [], NOW).length === 0, `T45 overdue ${status} -> none`);
  }
  const elsewhere = cand({ assetId: B });
  assert(planPoamItems([elsewhere], [], NOW).length === 1, 'T46 overdue on an asset not reported by the run still gets one (tenant-wide)');
  assert(planPoamItems([cand({ status: 'RESOLVED', resolvedAt: R2 })], [{ findingId: 'f-existing', status: 'OPEN', createdAt: R2 }], NOW).length === 0, 'T47 closing later leaves the item as is: no new draft');
  assert(planPoamItems([cand({ slaDueAt: null })], [], NOW).length === 0, 'T48 null sla -> none');
  const w = poamWeakness(cand({ severity: 'HIGH' }));
  assert(w === 'CVE-2026-0001 on web-01: HIGH severity, first seen 2026-01-01, remediation due 2026-01-31 (overdue).', 'T49 weakness text template', w);
  const wk = poamWeakness(cand({ severity: 'CRITICAL' }, true));
  assert(
    wk === 'CVE-2026-0001 on web-01: CRITICAL severity, known exploited (CISA KEV), first seen 2026-01-01, remediation due 2026-01-31 (overdue).',
    'T49 weakness text includes the KEV clause',
    wk,
  );
}

// ---------- Asset matching ----------
const acand = (o: Partial<AgentAssetCandidate> = {}): AgentAssetCandidate => ({
  id: 'asset-1',
  hostName: 'web-01',
  macAddress: '',
  agentIds: {},
  discoveryStatus: 'ACTIVE',
  lastVulnSeenAt: null,
  ...o,
});
const ahost = (o: Partial<NormalizedHost> = {}): NormalizedHost => nhost([], { agentId: '001', hostname: 'web-01', mac: '', ...o });
{
  const p = planAssetMatches([ahost()], [], 'WAZUH', 10);
  const d = p.toCreate[0];
  assert(p.toCreate.length === 1 && p.matched.length === 0, 'T50 unknown host -> create', p);
  assert(d.sourceOrigin === 'AGENT_REPORT' && d.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && d.cmmcAssetCategory === 'CONTRACTOR_RISK', 'T50 AGENT_REPORT + UNCONFIRMED_DISCOVERY + CONTRACTOR_RISK', d);
  assert(eq(d.agentIds, { wazuh: '001' }) && kindKey('WAZUH') === 'wazuh', 'T50 agentIds {wazuh: id}', d.agentIds);
  assert(d.hostName === 'web-01' && d.osProfile === 'Ubuntu' && d.notes === 'Reported by WAZUH agent 001 (Ubuntu 22.04). Unconfirmed: classify its CMMC category.', 'T50 draft fields', d);
  const weird = planAssetMatches([ahost({ osName: 'Linux <x>' })], [], 'WAZUH', 10);
  assert(weird.toCreate[0].osProfile === 'custom', 'T50 os name outside the allowed pattern -> custom', weird.toCreate[0]);
}
{
  const p = planAssetMatches([ahost({ hostname: '', agentId: '077' })], [], 'WAZUH', 10);
  assert(p.toCreate[0].hostName === 'wazuh-077', "T51 no hostname -> 'wazuh-<agent_id>'", p.toCreate[0]);
}
{
  const p = planAssetMatches([ahost({ agentId: '009' })], [acand({ agentIds: { s1: 'x' } })], 'WAZUH', 10);
  assert(p.matched.length === 1 && p.matched[0].by === 'hostname', 'T52 (setup) name matches the existing asset');
  const p2 = planAssetMatches([ahost({ agentId: '009', hostname: 'db-01' }), ahost({ agentId: '010', hostname: 'DB-01 ' })], [acand({ id: 'a1', hostName: 'DB-01' }), acand({ id: 'a2', hostName: 'db-01 ' })], 'WAZUH', 10);
  assert(p2.toCreate.length === 2 && p2.toCreate[0].hostName === 'db-01-2' && p2.toCreate[1].hostName === 'DB-01-3', 'T52 name taken -> -2 suffix (and -3 for the next)', p2.toCreate);
}
{
  const p = planAssetMatches([ahost({ agentId: '001', hostname: 'renamed' })], [acand({ agentIds: { wazuh: '001' } })], 'WAZUH', 10);
  assert(p.matched.length === 1 && p.matched[0].by === 'agent_id' && p.toCreate.length === 0, 'T53 agent id wins even if hostname changed', p);
}
{
  const p = planAssetMatches([ahost({ agentId: '002', hostname: 'other', mac: 'AA-BB-CC-DD-EE-FF' })], [acand({ hostName: 'x', macAddress: 'aa:bb:cc:dd:ee:ff', agentIds: { s1: 'k' } })], 'WAZUH', 10);
  assert(p.matched[0]?.by === 'mac', 'T54 MAC match when agent id unknown (normalized, case/separator-insensitive)', p);
  assert(eq(p.matched[0]?.agentIds, { s1: 'k', wazuh: '002' }), 'T54 agentIds merged', p.matched[0]);
}
{
  const p = planAssetMatches([ahost({ agentId: '003', hostname: '  WEB-01  ' })], [acand()], 'WAZUH', 10);
  assert(p.matched[0]?.by === 'hostname', 'T55 hostname match is case-insensitive and trimmed', p);
}
{
  const cs = [
    acand({ id: 'by-host', hostName: 'web-01' }),
    acand({ id: 'by-mac', hostName: 'zz', macAddress: '11:22:33:44:55:66' }),
    acand({ id: 'by-id', hostName: 'yy', agentIds: { wazuh: '001' } }),
  ];
  const p = planAssetMatches([ahost({ agentId: '001', hostname: 'web-01', mac: '11:22:33:44:55:66' })], cs, 'WAZUH', 10);
  assert(p.matched[0]?.assetId === 'by-id' && p.matched[0].by === 'agent_id', 'T56 precedence: agent id first', p.matched);
  const p2 = planAssetMatches([ahost({ agentId: '005', hostname: 'web-01', mac: '11:22:33:44:55:66' })], cs, 'WAZUH', 10);
  assert(p2.matched[0]?.assetId === 'by-mac' && p2.matched[0].by === 'mac', 'T56 precedence: MAC before hostname', p2.matched);
}
{
  const cs = [acand({ id: 'one', hostName: 'a', macAddress: '11:22:33:44:55:66' }), acand({ id: 'two', hostName: 'web-01', macAddress: '11-22-33-44-55-66' })];
  const p = planAssetMatches([ahost({ agentId: '006', hostname: 'web-01', mac: '112233445566' })], cs, 'WAZUH', 10);
  assert(p.matched[0]?.assetId === 'two' && p.matched[0].by === 'hostname', 'T57 ambiguous MAC falls through to hostname', p);
  const dup = [acand({ id: 'one', hostName: 'web-01' }), acand({ id: 'two', hostName: 'WEB-01' })];
  const p2 = planAssetMatches([ahost({ agentId: '007' })], dup, 'WAZUH', 10);
  assert(p2.matched.length === 0 && p2.toCreate.length === 1, 'T57 ambiguous hostname -> no match, create', p2);
  const ids = [acand({ id: 'one', agentIds: { wazuh: '001' } }), acand({ id: 'two', hostName: 'q', agentIds: { wazuh: '001' } })];
  const p3 = planAssetMatches([ahost({ agentId: '001' })], ids, 'WAZUH', 10);
  assert(p3.matched.length === 1 && p3.matched[0].by === 'hostname', 'T57 ambiguous agent id falls through to the next tier', p3);
}
{
  const p = planAssetMatches([ahost({ agentId: '001' }), ahost({ agentId: '002' })], [acand()], 'WAZUH', 10);
  assert(p.matched.length === 1 && p.toCreate.length === 1, 'T58 one asset claimed once per run', p);
  assert(p.toCreate[0].hostName === 'web-01-2', "T58 second host creates '-2'", p.toCreate[0]);
}
{
  const p2 = planAssetMatches([ahost({ agentId: 'new', hostname: 'old' })], [acand({ hostName: 'old', agentIds: { wazuh: 'old', s1: 'k' } })], 'WAZUH', 10);
  assert(eq(p2.matched[0]?.agentIds, { wazuh: 'new', s1: 'k' }), "T59 re-enrolled agent id replaces the kind's id, other kinds kept", p2.matched[0]);
}
{
  const p = planAssetMatches([ahost()], [acand({ discoveryStatus: 'DECOMMISSIONED' })], 'WAZUH', 10);
  assert(p.matched.length === 1 && p.toCreate.length === 0, 'T60 DECOMMISSIONED still matched', p);
  assert(!('discoveryStatus' in p.matched[0]), 'T60 the plan carries no status change', p.matched[0]);
}
{
  const p = planAssetMatches(
    [ahost({ agentId: '001', hostname: 'h1', mac: '' }), ahost({ agentId: '002', hostname: 'h2', mac: '00:00:00:00:00:00' })],
    [acand({ hostName: 'x', macAddress: '' }), acand({ id: 'asset-2', hostName: 'y', macAddress: '00:00:00:00:00:00' })],
    'WAZUH',
    10,
  );
  assert(p.matched.length === 0 && p.toCreate.length === 2, 'T61 empty/all-zero MAC never matches', p);
}
{
  const p = planAssetMatches(
    [ahost({ agentId: '001', hostname: 'web-01' }), ahost({ agentId: '002', hostname: 'n1' }), ahost({ agentId: '003', hostname: 'n2' })],
    [acand()],
    'WAZUH',
    1,
  );
  assert(p.matched.length === 1 && p.toCreate.length === 1 && p.toCreate[0].agentId === '002', 'T62 asset limit: capacity is used per create', p);
  assert(eq(p.skipped, [{ agentId: '003', reason: 'asset_limit' }]), 'T62 asset limit -> host skipped', p.skipped);
  const none = planAssetMatches([ahost({ agentId: '009', hostname: 'zz' })], [], 'WAZUH', 0);
  assert(none.toCreate.length === 0 && none.skipped.length === 1, 'T62 zero capacity -> skipped', none);
}

// ---------- Adapter ----------
function finding1(vuln_id: string, o: Record<string, unknown> = {}) {
  return { vuln_id, severity: 'HIGH' as const, ...o };
}
function payload(hosts: Array<Record<string, unknown>>): IngestPayload {
  return {
    source: { kind: 'WAZUH', label: 'wazuh-prod' },
    exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
    collected_at: '2026-10-18T12:00:00Z',
    hosts: hosts.map((h) => ({ findings: [], ...h })),
  } as unknown as IngestPayload;
}
{
  const dup = validateIngestPayload(payload([{ agent_id: '001' }, { agent_id: '001' }]));
  assert(!dup.ok && dup.error.includes('duplicate agent_id'), 'T63 duplicate agent_id rejected by the schema', dup);
}
{
  assert(canonicalVulnId('cve-2026-1234') === 'CVE-2026-1234', 'canonicalVulnId upper-cases cve- ids');
  assert(canonicalVulnId('CVE-2026-1234') === 'CVE-2026-1234', 'canonicalVulnId keeps an upper-case cve id');
  assert(canonicalVulnId('ghsa-abcd') === 'ghsa-abcd' && canonicalVulnId('RHSA-2026:1') === 'RHSA-2026:1', 'canonicalVulnId leaves other ids unchanged');

  const bands: Array<[number | null | undefined, string]> = [
    [10, 'CRITICAL'], [9.0, 'CRITICAL'], [8.9, 'HIGH'], [7.0, 'HIGH'], [6.9, 'MEDIUM'], [4.0, 'MEDIUM'],
    [3.9, 'LOW'], [0.1, 'LOW'], [0, 'UNKNOWN'], [null, 'UNKNOWN'], [undefined, 'UNKNOWN'],
  ];
  for (const [score, want] of bands) assert(severityFromCvss(score) === want, `severityFromCvss(${score}) -> ${want}`, severityFromCvss(score));

  assert(recheckSeverity('UNKNOWN', 9.8) === 'CRITICAL', 'recheckSeverity UNKNOWN + 9.8 -> CRITICAL');
  assert(recheckSeverity('UNKNOWN', null) === 'UNKNOWN' && recheckSeverity('UNKNOWN', 0) === 'UNKNOWN', 'recheckSeverity UNKNOWN without a score stays UNKNOWN');
  assert(recheckSeverity('HIGH', 2.0) === 'HIGH', 'recheckSeverity HIGH + 2.0 -> HIGH (reported severity never overridden)');
  let threw = false;
  try {
    recheckSeverity('SEVERE', 5);
  } catch {
    threw = true;
  }
  assert(threw, "recheckSeverity 'SEVERE' throws");

  assert(worstSeverity('LOW', 'UNKNOWN') === 'UNKNOWN' && worstSeverity('MEDIUM', 'UNKNOWN') === 'MEDIUM' && worstSeverity('HIGH', 'CRITICAL') === 'CRITICAL', 'worstSeverity ranks CRITICAL > HIGH > MEDIUM > UNKNOWN > LOW');

  const hosts = normalizeWazuh(
    payload([
      {
        agent_id: '001',
        hostname: '  web-01  ',
        findings: [
          finding1('cve-2026-0001', { severity: 'LOW', title: '', detected_at: '2026-01-10T00:00:00+00:00', cvss_v3: 3.1, refs: ['https://a.example/1'], package: { name: 'zlib', version: '2.0' } }),
          finding1('CVE-2026-0001', { severity: 'UNKNOWN', title: 'Heap overflow', detected_at: '2026-01-05T00:00:00Z', cvss_v3: 9.8, refs: ['https://a.example/1', 'https://a.example/2'], package: { name: 'openssl', version: '1.0', fixed_version: '1.1' } }),
          finding1('CVE-2026-0001', { severity: 'MEDIUM', package: { name: 'zlib', version: '2.0' } }),
          finding1('CVE-2026-0002', { severity: 'MEDIUM' }),
        ],
      },
      { agent_id: '002' },
    ]),
  );
  const f1 = hosts[0].findings[0];
  assert(hosts.length === 2 && hosts[0].findings.length === 2, 'normalizeWazuh groups findings by canonical id per host', hosts);
  assert(hosts[0].hostname === 'web-01', 'normalizeWazuh hostname trimmed', hosts[0].hostname);
  assert(hosts[0].ip === '' && hosts[0].mac === '' && hosts[0].osName === '' && hosts[0].osVersion === '', 'normalizeWazuh ip/mac/os default to empty');
  assert(f1.vulnId === 'CVE-2026-0001', 'normalizeWazuh canonical id', f1);
  assert(f1.detectedAt === '2026-01-05T00:00:00.000Z', 'normalizeWazuh earliest detectedAt (ISO)', f1.detectedAt);
  assert(f1.severity === 'CRITICAL', 'normalizeWazuh severity = worst (UNKNOWN + 9.8 rechecked to CRITICAL)', f1.severity);
  assert(eq(f1.reportedSeverities, ['LOW', 'CRITICAL', 'MEDIUM']), 'normalizeWazuh reportedSeverities are the rechecked severities in order', f1.reportedSeverities);
  assert(f1.title === 'Heap overflow' && f1.cvssV3 === 9.8, 'normalizeWazuh first non-empty title, max cvss', f1);
  assert(eq(f1.refs, ['https://a.example/1', 'https://a.example/2']), 'normalizeWazuh refs union in first-seen order', f1.refs);
  assert(
    eq(f1.packages, [
      { name: 'openssl', version: '1.0', fixedVersion: '1.1' },
      { name: 'zlib', version: '2.0', fixedVersion: null },
    ]),
    'normalizeWazuh packages deduped on (name, version) and sorted, fixedVersion null when absent',
    f1.packages,
  );
  assert(eq(hosts[0].findings[1].packages, []), 'normalizeWazuh missing package -> packages []', hosts[0].findings[1]);
  assert(hosts[1].findings.length === 0, 'normalizeWazuh host with no findings');
  const many = normalizeWazuh(
    payload([
      {
        agent_id: '001',
        findings: [finding1('CVE-2026-0009', { refs: Array.from({ length: 15 }, (_, i) => `https://a.example/${i}`) }), finding1('cve-2026-0009', { refs: Array.from({ length: 15 }, (_, i) => `https://b.example/${i}`) })],
      },
    ]),
  );
  assert(many[0].findings[0].refs.length === 20, 'normalizeWazuh refs capped at 20', many[0].findings[0].refs.length);
}

// ---------- Stale runs ----------
{
  const NOWMS = Date.parse('2026-03-01T00:10:00.000Z');
  const mk = (id: string, status: VmRun['status'], receivedAt: string, startedAt: string | null = null) =>
    ({ id, status, receivedAt, startedAt } as unknown as VmRun);
  const runs = [
    mk('recv-old', 'RECEIVED', '2026-03-01T00:05:00.000Z'),
    mk('recv-new', 'RECEIVED', '2026-03-01T00:09:30.000Z'),
    mk('norm-old', 'NORMALIZING', '2026-03-01T00:01:00.000Z', '2026-03-01T00:02:00.000Z'),
    mk('norm-fresh', 'NORMALIZING', '2026-03-01T00:01:00.000Z', '2026-03-01T00:09:00.000Z'),
    mk('norm-null', 'NORMALIZING', '2026-03-01T00:00:00.000Z', null),
    mk('done', 'NORMALIZED', '2026-03-01T00:00:00.000Z'),
    mk('failed', 'FAILED', '2026-03-01T00:00:00.000Z'),
    mk('active', 'RECEIVED', '2026-03-01T00:00:30.000Z'),
  ];
  const got = staleRunsToRecover(runs, NOWMS, (id) => id === 'active').map((r) => r.id);
  assert(eq(got, ['norm-null', 'norm-old', 'recv-old']), 'T70 staleRunsToRecover picks only old inactive RECEIVED/NORMALIZING runs, sorted by receivedAt', got);
}

// ---------- Environment ----------
{
  assert(eq(getVmSlaConfig({}), VM_SLA_DEFAULTS), 'getVmSlaConfig {} -> defaults', getVmSlaConfig({}));
  assert(eq(VM_SLA_DEFAULTS, { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 }), 'VM_SLA_DEFAULTS are 15/30/90/180');
  assert(getVmSlaConfig({ VM_SLA_DAYS_HIGH: '20' }).HIGH === 20, "getVmSlaConfig '20' -> 20");
  assert(getVmSlaConfig({ VM_SLA_DAYS_HIGH: ' 30 ' }).HIGH === 30 && getVmSlaConfig({ VM_SLA_DAYS_LOW: ' 45 ' }).LOW === 45, "getVmSlaConfig ' 30 ' is trimmed");
  for (const bad of ['', 'abc', '15.5', '-3']) {
    assert(getVmSlaConfig({ VM_SLA_DAYS_CRITICAL: bad }).CRITICAL === 15, `getVmSlaConfig '${bad}' -> default`);
  }
  assert(getVmSlaConfig({ VM_SLA_DAYS_MEDIUM: '0' }).MEDIUM === 1, "getVmSlaConfig '0' -> 1");
  assert(getVmSlaConfig({ VM_SLA_DAYS_MEDIUM: '99999' }).MEDIUM === 3650, "getVmSlaConfig '99999' -> 3650");

  for (const v of [undefined, '', 'true', 'TRUE', '1']) {
    assert(isPoamAutocreateEnabled({ VM_POAM_AUTOCREATE: v }) === true, `isPoamAutocreateEnabled(${JSON.stringify(v)}) -> true`);
  }
  for (const v of ['false', '0', 'no', 'off', 'OFF']) {
    assert(isPoamAutocreateEnabled({ VM_POAM_AUTOCREATE: v }) === false, `isPoamAutocreateEnabled(${JSON.stringify(v)}) -> false`);
  }
  assert(isPoamAutocreateEnabled({}) === true, 'isPoamAutocreateEnabled unset -> true');
}

// ---------- firstSeenFor and normalizeMac ----------
{
  assert(firstSeenFor(null, R1) === R1, 'firstSeenFor without detected_at -> received_at');
  assert(firstSeenFor('2025-12-20T00:00:00.000Z', R1) === '2025-12-20T00:00:00.000Z', 'firstSeenFor keeps a sane detected_at');
  assert(firstSeenFor('2025-12-20T00:00:00.000Z', R1, '2025-12-25T00:00:00.000Z') === R1, 'firstSeenFor ignores detected_at before published_at');
  assert(firstSeenFor('2010-01-01T00:00:00.000Z', R1) === R1, 'firstSeenFor ignores detected_at more than 10 years old');
  assert(firstSeenFor('not a date', R1) === R1, 'firstSeenFor ignores an unparseable detected_at');
  assert(firstSeenFor(R2, R3, null, R2) === R3, 'firstSeenFor on reopen needs detected_at strictly after resolved_at');
  assert(firstSeenFor('2026-01-10T00:00:00.000Z', R3, null, R2) === '2026-01-10T00:00:00.000Z', 'firstSeenFor on reopen keeps a later detected_at');

  assert(normalizeMac('AA:BB:CC:DD:EE:FF') === 'aabbccddeeff', 'normalizeMac strips colons and lower-cases');
  assert(normalizeMac('aa-bb-cc-dd-ee-ff') === 'aabbccddeeff' && normalizeMac('aabb.ccdd.eeff') === 'aabbccddeeff' && normalizeMac(' aa bb cc dd ee ff ') === 'aabbccddeeff', 'normalizeMac strips dashes, dots and spaces');
  assert(normalizeMac('') === '' && normalizeMac('00:00:00:00:00:00') === '' && normalizeMac('0000.0000.0000') === '', "normalizeMac '' and all-zero -> ''");
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exit(1);
