import {
  VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS,
  VM_NOTES_BEGIN,
  VM_NOTES_END,
  VM_SNAPSHOT_ACTOR,
  VM_SNAPSHOT_CONTROLS,
  VM_SNAPSHOT_FIXED_CONTROLS,
  VM_SNAPSHOT_OPTIONAL_CONTROL,
  computeSnapshot,
  formatDuration,
  getVmSnapshotConfig,
  manualSnapshotAllowed,
  newEvidenceId,
  newSnapshotId,
  planStalenessChanges,
  renderNotesBlock,
  renderSnapshotMarkdown,
  replaceDelimitedBlock,
  snapshotControlIds,
  snapshotDue,
  snapshotFileKeys,
  type SnapshotInput,
  type SnapshotReport,
} from '../server/vm/snapshot';

/**
 * Pure checks (no server, no database, no clock): the snapshot evaluation rules, the Markdown report, the notes block and the
 * scheduling decisions (docs/VULNERABILITY_MANAGEMENT.md, sections 2.2 and 7).
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
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

type Source = SnapshotInput['sources'][number];
type Run = SnapshotInput['runs'][number];
type Asset = SnapshotInput['assets'][number];
type Finding = SnapshotInput['findings'][number];

const NOW = '2026-10-18T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const WINDOW_START = '2026-10-11T12:00:00.000Z';
const SEEN = '2026-10-18T06:00:00.000Z';
const MIN = 60_000;
const SNAP_ID = 'vmsnap_1760788800000_abcde';

const source = (id: string, label: string, over: Partial<Source> = {}): Source => ({
  id,
  kind: 'WAZUH',
  label,
  enabled: true,
  expectedIntervalMinutes: 1440,
  lastRunAt: SEEN,
  staleSince: null,
  ...over,
});
const run = (id: string, sourceId: string, receivedAt: string, status: Run['status'] = 'NORMALIZED', error: string | null = null): Run => ({
  id,
  sourceId,
  receivedAt,
  status,
  error,
});
const asset = (
  id: string,
  hostName: string,
  cmmcCategory: Asset['cmmcCategory'],
  discoveryStatus: Asset['discoveryStatus'],
  lastVulnSeenAt: string | null = SEEN,
): Asset => ({ id, hostName, cmmcCategory, discoveryStatus, lastVulnSeenAt });
const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  assetId: 'a1',
  vulnId: `CVE-${id}`,
  status: 'OPEN',
  severity: 'HIGH',
  slaDueAt: '2026-12-01T00:00:00.000Z',
  resolvedAt: null,
  ...over,
});

/** Base fixture F0: one fresh source, four fully covered in-scope assets, no findings. */
function f0(): SnapshotInput {
  return {
    snapshotId: SNAP_ID,
    tenantId: 't1',
    now: NOW,
    windowHours: 168,
    coverageThreshold: 0.95,
    sources: [source('s1', 'wazuh-a')],
    runs: [run('r1', 's1', SEEN), run('r0', 's1', '2026-10-10T00:00:00.000Z')],
    assets: [
      asset('a1', 'h-cui', 'CUI_ASSET', 'ACTIVE'),
      asset('a2', 'h-spa', 'SECURITY_PROTECTION', 'ACTIVE'),
      asset('a3', 'h-crma', 'CONTRACTOR_RISK', 'ACTIVE'),
      asset('a4', 'h-sa', 'SPECIALIZED_ASSET', 'STALE'),
    ],
    findings: [],
    kevVulnIds: [],
    poamItems: [],
  };
}
const withInput = (over: Partial<SnapshotInput>): SnapshotInput => ({ ...f0(), ...over });
const compute = (over: Partial<SnapshotInput> = {}): SnapshotReport => computeSnapshot(withInput(over));

/** n in-scope CUI assets of which `covered` were seen in the window. */
function manyAssets(n: number, covered: number): Asset[] {
  return Array.from({ length: n }, (_, i) =>
    asset(`m${String(i).padStart(2, '0')}`, `h${String(i).padStart(2, '0')}`, 'CUI_ASSET', 'ACTIVE', i < covered ? SEEN : '2026-10-01T00:00:00.000Z'),
  );
}

console.log('\n=== Snapshot evaluation ===');
{
  const r = compute();
  const s1 = r.sources.items[0];
  assert(
    r.sources.total === 1 && r.sources.enabled === 1 && r.sources.withinInterval === 1 &&
      s1.ageMinutes === 360 && s1.stale === false && s1.staleForMinutes === null && s1.runsInWindow === 1 && s1.failedRunsInWindow === 0,
    'S01 all sources fresh, full coverage -> criteria met: sources',
    r.sources,
  );
  assert(
    r.coverage.inScopeTotal === 4 && r.coverage.covered === 4 && r.coverage.ratio === 1 &&
      eq(r.coverage.byCategory, {
        CUI_ASSET: { total: 1, covered: 1 },
        SECURITY_PROTECTION: { total: 1, covered: 1 },
        CONTRACTOR_RISK: { total: 1, covered: 1 },
        SPECIALIZED_ASSET: { total: 1, covered: 1 },
      }) &&
      eq(r.coverage.excluded, { unconfirmed: 0, decommissioned: 0, outOfScope: 0 }),
    'S01 all sources fresh, full coverage -> criteria met: coverage',
    r.coverage,
  );
  assert(
    eq(r.findings, {
      openBySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
      openTotal: 0, kevOpen: 0, overdueOpen: 0, overdueCriticalOrKev: 0, openWithinSla: 0, openSlaCompliance: 1,
      closedInWindow: 0, closedInWindowWithinSla: 0, closedSlaCompliance: null, riskAccepted: 0, falsePositive: 0, openOnDecommissioned: 0,
    }) &&
      eq(r.poam, { overdueWithPoam: 0, overdueWithoutPoam: 0, openItems: 0 }) &&
      eq(r.assets.neverReported, []) && eq(r.assets.stale, []) && r.assets.staleThresholdMinutes === 1440,
    'S01 all sources fresh, full coverage -> criteria met: findings, poam, asset lists',
    { f: r.findings, p: r.poam, a: r.assets },
  );
  assert(
    r.criteria.sourcesWithinInterval.reason === 'All 1 enabled source(s) reported within their expected interval.' &&
      r.criteria.coverage.reason === '4 of 4 in-scope assets (1.00) reported in the last 168 h; threshold 0.95.' &&
      r.criteria.noOverdueCriticalOrKev.reason === 'No OPEN CRITICAL or KEV finding is past its SLA deadline.' &&
      r.criteria.met === true,
    'S01 all sources fresh, full coverage -> criteria met: reasons and met',
    r.criteria,
  );
  assert(
    r.version === 1 && r.snapshotId === SNAP_ID && r.tenantId === 't1' && r.generatedAt === NOW &&
      eq(r.window, { start: WINDOW_START, end: NOW, hours: 168 }) && eq(r.thresholds, { coverage: 0.95 }),
    'S01 report header: version, ids, window, thresholds',
    { v: r.version, w: r.window },
  );
}
{
  const r = compute({
    sources: [source('s1', 'wazuh-a'), source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' })],
  });
  const s2 = r.sources.items.find((i) => i.id === 's2')!;
  assert(
    s2.ageMinutes === 5760 && s2.stale === true && s2.staleForMinutes === 4320 && r.sources.withinInterval === 1 && r.sources.enabled === 2 &&
      r.criteria.sourcesWithinInterval.reason === '1 of 2 enabled source(s) outside their expected interval: wazuh-b (stale 3d).' &&
      r.criteria.met === false,
    'S02 one stale source -> criterion 1 not met',
    { s2, c: r.criteria },
  );
}
{
  const first = compute({ sources: [source('s1', 'wazuh-a', { lastRunAt: '2026-10-17T12:00:00.000Z' })] });
  const second = compute({ sources: [source('s1', 'wazuh-a', { lastRunAt: '2026-10-17T11:59:59.999Z' })] });
  assert(
    first.sources.items[0].stale === false && first.sources.items[0].ageMinutes === 1440 &&
      second.sources.items[0].stale === true && second.sources.items[0].staleForMinutes === 0 &&
      second.criteria.sourcesWithinInterval.reason.endsWith('wazuh-a (stale 0m).'),
    'S03 source interval boundary is strict',
    { a: first.sources.items[0], b: second.sources.items[0] },
  );
}
{
  const r = compute({
    sources: [source('s1', 'wazuh-a'), source('s3', 'old', { enabled: false, lastRunAt: '2026-09-01T00:00:00.000Z' })],
  });
  const s3 = r.sources.items.find((i) => i.id === 's3')!;
  assert(
    s3.enabled === false && s3.stale === false && s3.staleForMinutes === null &&
      r.sources.total === 2 && r.sources.enabled === 1 && r.sources.withinInterval === 1 &&
      r.criteria.sourcesWithinInterval.met === true,
    'S04 disabled stale source is ignored',
    { s3, s: r.sources },
  );
}
{
  const r = compute({ sources: [source('s1', 'wazuh-a', { lastRunAt: null })] });
  const s1 = r.sources.items[0];
  assert(
    s1.stale === true && s1.ageMinutes === null && s1.staleForMinutes === null &&
      r.criteria.sourcesWithinInterval.reason === '1 of 1 enabled source(s) outside their expected interval: wazuh-a (never reported).',
    'S05 enabled source that never ran is stale',
    { s1, c: r.criteria },
  );
}
{
  const none = compute({ sources: [] });
  const onlyDisabled = compute({ sources: [source('s3', 'old', { enabled: false })] });
  assert(
    none.sources.total === 0 && none.sources.enabled === 0 && none.sources.withinInterval === 0 &&
      none.criteria.sourcesWithinInterval.reason === 'No enabled vulnerability source has reported.' && none.criteria.met === false &&
      onlyDisabled.sources.total === 1 && onlyDisabled.sources.enabled === 0 && onlyDisabled.sources.withinInterval === 0 &&
      onlyDisabled.criteria.sourcesWithinInterval.reason === 'No enabled vulnerability source has reported.' &&
      onlyDisabled.criteria.met === false,
    'S06 no sources -> criterion 1 not met with reason',
    { none: none.criteria, dis: onlyDisabled.criteria },
  );
}
{
  const r = compute({ assets: manyAssets(20, 19) });
  assert(
    r.coverage.covered === 19 && r.coverage.inScopeTotal === 20 && r.coverage.ratio === 0.95 && r.criteria.coverage.met === true &&
      r.criteria.coverage.reason === '19 of 20 in-scope assets (0.95) reported in the last 168 h; threshold 0.95.' &&
      r.assets.stale.length === 1 && r.assets.stale[0].hostName === 'h19',
    'S07 coverage exactly at threshold is met',
    { c: r.coverage, reason: r.criteria.coverage, stale: r.assets.stale },
  );
}
{
  const r = compute({ assets: manyAssets(19, 18) });
  assert(
    r.coverage.ratio === 18 / 19 && r.criteria.coverage.met === false &&
      r.criteria.coverage.reason === '18 of 19 in-scope assets (0.94) reported in the last 168 h; threshold 0.95.',
    'S08 coverage just below threshold is not met',
    r.criteria.coverage,
  );
}
{
  const covered = (seen: string): number => {
    const input = f0();
    input.assets[0].lastVulnSeenAt = seen;
    return computeSnapshot(input).coverage.covered;
  };
  const got = [covered('2026-10-11T12:00:00.000Z'), covered('2026-10-11T11:59:59.999Z'), covered('2026-10-18T13:00:00.000Z')];
  assert(eq(got, [4, 3, 4]), 'S09 window start is inclusive', got);
}
{
  const input = f0();
  input.assets.push(
    asset('o1', 'h-oos', 'OUT_OF_SCOPE', 'ACTIVE'),
    asset('u1', 'h-unconf', 'CONTRACTOR_RISK', 'UNCONFIRMED_DISCOVERY'),
    asset('d1', 'h-dec', 'CUI_ASSET', 'DECOMMISSIONED', null),
    asset('d2', 'h-dec-oos', 'OUT_OF_SCOPE', 'DECOMMISSIONED'),
  );
  const r = computeSnapshot(input);
  assert(
    r.coverage.inScopeTotal === 4 && r.coverage.covered === 4 &&
      eq(r.coverage.excluded, { unconfirmed: 1, decommissioned: 2, outOfScope: 1 }) &&
      r.assets.neverReported.length === 0,
    'S10 in-scope definition',
    { c: r.coverage, n: r.assets.neverReported },
  );
}
{
  const r = compute({
    assets: [asset('u1', 'h-u1', 'CONTRACTOR_RISK', 'UNCONFIRMED_DISCOVERY'), asset('u2', 'h-u2', 'CUI_ASSET', 'UNCONFIRMED_DISCOVERY')],
  });
  assert(
    r.coverage.inScopeTotal === 0 && r.coverage.ratio === null && r.criteria.coverage.met === false &&
      r.criteria.coverage.reason === 'No in-scope assets in the inventory; coverage cannot be measured.' &&
      r.coverage.excluded.unconfirmed === 2,
    'S11 zero in-scope assets -> coverage cannot be measured',
    { c: r.coverage, r: r.criteria.coverage },
  );
}
{
  const input = f0();
  input.assets.push(
    asset('a5', 'h-new', 'CUI_ASSET', 'ACTIVE', null),
    asset('a6', 'printer', 'SPECIALIZED_ASSET', 'UNCONFIRMED_DISCOVERY', null),
    asset('a7', 'h-oos', 'OUT_OF_SCOPE', 'ACTIVE', null),
  );
  const r = computeSnapshot(input);
  assert(
    eq(r.assets.neverReported.map((a) => a.hostName), ['h-new', 'printer']) &&
      r.assets.neverReported[1].discoveryStatus === 'UNCONFIRMED_DISCOVERY' &&
      r.coverage.inScopeTotal === 5 && r.coverage.covered === 4 && r.coverage.ratio === 0.8 &&
      !r.assets.neverReported.some((a) => a.assetId === 'a7') && r.assets.stale.length === 0,
    'S12 never-reported assets are listed',
    { n: r.assets.neverReported, c: r.coverage },
  );
}
{
  const input = f0();
  input.assets[0].lastVulnSeenAt = '2026-10-15T12:00:00.000Z';
  input.assets[1].lastVulnSeenAt = '2026-10-01T00:00:00.000Z';
  const r = computeSnapshot(input);
  assert(
    eq(r.assets.stale.map((a) => [a.hostName, a.ageMinutes]), [['h-cui', 4320], ['h-spa', 25200]]) && r.coverage.covered === 3,
    'S13 stale asset seen inside and before the window',
    { s: r.assets.stale, c: r.coverage.covered },
  );
}
{
  const input = f0();
  input.assets[0].lastVulnSeenAt = '2026-10-15T12:00:00.000Z';
  input.assets[1].lastVulnSeenAt = '2026-10-01T00:00:00.000Z';
  input.sources.push(source('s2', 'wazuh-b', { expectedIntervalMinutes: 10080 }));
  const r = computeSnapshot(input);
  assert(
    r.assets.staleThresholdMinutes === 10080 && eq(r.assets.stale.map((a) => a.hostName), ['h-spa']),
    'S14 asset stale threshold uses the largest enabled interval',
    { t: r.assets.staleThresholdMinutes, s: r.assets.stale },
  );
}
{
  const staleWith = (seen: string): boolean => {
    const input = f0();
    input.assets[0].lastVulnSeenAt = seen;
    return computeSnapshot(input).assets.stale.some((a) => a.assetId === 'a1');
  };
  const exact = new Date(NOW_MS - 1440 * MIN).toISOString();
  const over = new Date(NOW_MS - 1440 * MIN - 1).toISOString();
  assert(staleWith(exact) === false && staleWith(over) === true, 'S15 asset staleness boundary is strict', { exact: staleWith(exact), over: staleWith(over) });
}
{
  const r = compute({
    findings: [
      finding('c1', { severity: 'CRITICAL' }),
      finding('h1', { severity: 'HIGH' }),
      finding('h2', { severity: 'HIGH' }),
      finding('m1', { severity: 'MEDIUM' }),
      finding('l1', { severity: 'LOW' }),
      finding('u1', { severity: 'UNKNOWN' }),
      finding('x1', { status: 'RESOLVED', severity: 'HIGH', resolvedAt: '2026-10-01T00:00:00.000Z' }),
      finding('ra', { status: 'RISK_ACCEPTED', severity: 'CRITICAL' }),
      finding('fp', { status: 'FALSE_POSITIVE', severity: 'LOW' }),
    ],
  });
  const f = r.findings;
  assert(
    eq(f.openBySeverity, { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 1, UNKNOWN: 1 }) &&
      eq(Object.keys(f.openBySeverity), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']) &&
      f.openTotal === 6 && f.riskAccepted === 1 && f.falsePositive === 1 && f.overdueOpen === 0 && f.openSlaCompliance === 1,
    'S16 open findings by severity incl. UNKNOWN',
    f,
  );
}
{
  const r = compute({
    findings: [
      finding('f1', { vulnId: 'CVE-A' }),
      finding('f2', { vulnId: 'CVE-B' }),
      finding('f3', { vulnId: 'CVE-A', status: 'RESOLVED', resolvedAt: '2026-10-12T00:00:00.000Z' }),
    ],
    kevVulnIds: ['CVE-A'],
  });
  assert(r.findings.kevOpen === 1, 'S17 KEV open count', r.findings);
}
{
  const r = compute({ findings: [finding('f1', { severity: 'CRITICAL', slaDueAt: '2026-10-17T00:00:00.000Z' })] });
  assert(
    r.findings.overdueOpen === 1 && r.findings.overdueCriticalOrKev === 1 && r.findings.openWithinSla === 0 && r.findings.openSlaCompliance === 0 &&
      r.criteria.noOverdueCriticalOrKev.reason === '1 OPEN CRITICAL or KEV finding(s) past their SLA deadline.' &&
      r.criteria.noOverdueCriticalOrKev.met === false,
    'S18 overdue CRITICAL -> criterion 3 not met',
    { f: r.findings, c: r.criteria.noOverdueCriticalOrKev },
  );
}
{
  const r = compute({ findings: [finding('f1', { severity: 'HIGH', slaDueAt: '2026-10-17T00:00:00.000Z' })] });
  assert(
    r.findings.overdueOpen === 1 && r.findings.overdueCriticalOrKev === 0 && r.criteria.noOverdueCriticalOrKev.met === true && r.criteria.met === true,
    'S19 overdue HIGH is reported but does not fail criterion 3',
    r.findings,
  );
}
{
  const r = compute({
    findings: [finding('f1', { vulnId: 'CVE-K', severity: 'MEDIUM', slaDueAt: '2026-10-17T00:00:00.000Z' })],
    kevVulnIds: ['CVE-K'],
  });
  assert(r.findings.overdueCriticalOrKev === 1 && r.criteria.noOverdueCriticalOrKev.met === false,'S20 overdue KEV of any severity fails criterion 3', r.findings);
}
{
  const r = compute({
    findings: [finding('f1', { severity: 'CRITICAL', slaDueAt: NOW }), finding('f2', { severity: 'HIGH', slaDueAt: null })],
  });
  assert(
    r.findings.overdueOpen === 0 && r.findings.openWithinSla === 2 && r.findings.openSlaCompliance === 1,
    'S21 SLA deadline equal to now is not overdue; null deadline is within SLA',
    r.findings,
  );
}
{
  const none = compute();
  const four = compute({
    findings: [
      finding('f1', { slaDueAt: '2026-10-17T00:00:00.000Z' }),
      finding('f2'),
      finding('f3'),
      finding('f4'),
    ],
  });
  assert(
    none.findings.openSlaCompliance === 1 && four.findings.openSlaCompliance === 0.75,
    'S22 SLA compliance with zero OPEN is 100%, 1 of 4 overdue is 75%',
    { a: none.findings.openSlaCompliance, b: four.findings.openSlaCompliance },
  );
}
{
  const resolved = (id: string, resolvedAt: string, slaDueAt: string | null): Finding =>
    finding(id, { status: 'RESOLVED', resolvedAt, slaDueAt });
  const r = compute({
    findings: [
      resolved('x1', '2026-10-12T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
      resolved('x2', '2026-10-05T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
      resolved('x3', '2026-10-13T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      resolved('x4', WINDOW_START, WINDOW_START),
    ],
  });
  const none = compute({ findings: [resolved('x2', '2026-10-05T00:00:00.000Z', '2026-10-20T00:00:00.000Z')] });
  assert(
    r.findings.closedInWindow === 3 && r.findings.closedInWindowWithinSla === 2 && r.findings.closedSlaCompliance === 2 / 3 &&
      none.findings.closedInWindow === 0 && none.findings.closedSlaCompliance === null,
    'S23 closed in window vs before window',
    { r: r.findings, none: none.findings },
  );
}
{
  const overdue = '2026-10-17T00:00:00.000Z';
  const r = compute({
    findings: [
      finding('f1', { slaDueAt: overdue }),
      finding('f2', { slaDueAt: overdue }),
      finding('f3', { slaDueAt: overdue }),
      finding('f4'),
    ],
    poamItems: [
      { id: 'p1', findingId: 'f1', status: 'OPEN' },
      { id: 'p2', findingId: 'f2', status: 'COMPLETED' },
      { id: 'p3', findingId: 'f4', status: 'IN_PROGRESS' },
      { id: 'p4', findingId: null, status: 'RISK_ACCEPTED' },
    ],
  });
  assert(eq(r.poam, { overdueWithPoam: 1, overdueWithoutPoam: 2, openItems: 2 }), 'S24 POA&M linkage', r.poam);
}
{
  const input = f0();
  input.assets.push(asset('a8', 'h-gone', 'CUI_ASSET', 'DECOMMISSIONED'));
  input.findings = [finding('f1', { assetId: 'a8', severity: 'CRITICAL', slaDueAt: '2026-10-17T00:00:00.000Z' })];
  const r = computeSnapshot(input);
  assert(
    r.findings.openTotal === 0 && r.findings.overdueCriticalOrKev === 0 && r.findings.openOnDecommissioned === 1 &&
      r.criteria.noOverdueCriticalOrKev.met === true,
    'S25 findings on decommissioned assets are excluded and counted apart',
    r.findings,
  );
}
{
  const r = compute({
    runs: [
      run('r1', 's1', SEEN),
      run('r2', 's1', '2026-10-12T00:00:00.000Z', 'FAILED', 'boom'),
      run('r3', 's1', WINDOW_START),
      run('r0', 's1', '2026-10-10T00:00:00.000Z'),
    ],
  });
  assert(
    r.sources.items[0].runsInWindow === 3 && r.sources.items[0].failedRunsInWindow === 1 && r.sources.items[0].lastRunFailed === false,
    'S26 runs in window per source',
    r.sources.items[0],
  );
}
{
  const s02 = compute({ sources: [source('s1', 'wazuh-a'), source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' })] });
  const s08 = compute({ assets: manyAssets(19, 18) });
  const s18 = compute({ findings: [finding('f1', { severity: 'CRITICAL', slaDueAt: '2026-10-17T00:00:00.000Z' })] });
  const all = compute({
    sources: [source('s1', 'wazuh-a'), source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' })],
    assets: manyAssets(19, 18),
    findings: [finding('f1', { severity: 'CRITICAL', slaDueAt: '2026-10-17T00:00:00.000Z' })],
  });
  const flags = (r: SnapshotReport): boolean[] => [
    r.criteria.sourcesWithinInterval.met,
    r.criteria.coverage.met,
    r.criteria.noOverdueCriticalOrKev.met,
    r.criteria.met,
  ];
  assert(
    eq(flags(s02), [false, true, true, false]) && eq(flags(s08), [true, false, true, false]) && eq(flags(s18), [true, true, false, false]) &&
      eq(flags(all), [false, false, false, false]) && eq(flags(compute()), [true, true, true, true]),
    'S27 criteria aggregate',
    { s02: flags(s02), s08: flags(s08), s18: flags(s18), all: flags(all) },
  );
}

/** F0 + S12 + S16 (shared by S28 and M01). */
function busyInput(): SnapshotInput {
  const input = f0();
  input.assets.push(
    asset('a5', 'h-new', 'CUI_ASSET', 'ACTIVE', null),
    asset('a6', 'printer', 'SPECIALIZED_ASSET', 'UNCONFIRMED_DISCOVERY', null),
    asset('a7', 'h-oos', 'OUT_OF_SCOPE', 'ACTIVE', null),
  );
  input.sources.push(source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' }));
  input.runs.push(run('r5', 's2', '2026-10-14T12:00:00.000Z'));
  input.findings = [
    finding('c1', { severity: 'CRITICAL' }),
    finding('h1', { severity: 'HIGH' }),
    finding('h2', { severity: 'HIGH' }),
    finding('m1', { severity: 'MEDIUM' }),
    finding('l1', { severity: 'LOW' }),
    finding('u1', { severity: 'UNKNOWN' }),
    finding('x1', { status: 'RESOLVED', resolvedAt: '2026-10-12T00:00:00.000Z' }),
  ];
  input.kevVulnIds = ['CVE-c1', 'CVE-h1'];
  input.poamItems = [{ id: 'p1', findingId: 'c1', status: 'OPEN' }];
  return input;
}
{
  const a = busyInput();
  const b = busyInput();
  b.sources.reverse();
  b.runs.reverse();
  b.assets.reverse();
  b.findings.reverse();
  b.poamItems.reverse();
  b.kevVulnIds = [...b.kevVulnIds].reverse();
  assert(
    JSON.stringify(computeSnapshot(a)) === JSON.stringify(computeSnapshot(b)),
    'S28 report is deterministic and order-independent',
  );
}
{
  const failedRun = run('r2', 's1', '2026-10-18T08:00:00.000Z', 'FAILED', 'The stored payload could not be read.');
  const r = compute({ runs: [...f0().runs, failedRun] });
  const s1 = r.sources.items[0];
  assert(
    r.sources.withinInterval === 0 && s1.stale === false && s1.lastRunFailed === true && s1.lastRun?.id === 'r2' &&
      s1.lastRun?.error === 'The stored payload could not be read.' &&
      r.criteria.sourcesWithinInterval.reason === '1 of 1 enabled source(s) outside their expected interval: wazuh-a (last run failed).' &&
      r.criteria.met === false,
    'S29 source whose latest run FAILED fails criterion 1',
    { s1, c: r.criteria },
  );
}
{
  const runs = [
    ...f0().runs,
    run('r2', 's1', '2026-10-18T08:00:00.000Z', 'FAILED', 'The stored payload could not be read.'),
    run('r3', 's1', '2026-10-18T09:00:00.000Z', 'NORMALIZED'),
  ];
  const r = compute({ runs });
  assert(
    r.sources.items[0].lastRunFailed === false && r.sources.withinInterval === 1 && r.criteria.sourcesWithinInterval.met === true && r.criteria.met === true,
    'S30 a later NORMALIZED run clears the failed-run flag',
    r.sources.items[0],
  );
}
{
  const r = compute({
    sources: [source('s1', 'wazuh-a', { lastRunAt: '2026-10-14T12:00:00.000Z' })],
    runs: [run('r0', 's1', '2026-10-10T00:00:00.000Z'), run('rf', 's1', '2026-10-14T12:00:00.000Z', 'FAILED', 'boom')],
  });
  assert(
    r.criteria.sourcesWithinInterval.reason === '1 of 1 enabled source(s) outside their expected interval: wazuh-a (stale 3d, last run failed).' &&
      r.sources.items[0].stale === true && r.sources.items[0].lastRunFailed === true,
    'S31 stale and failed combine in one list item',
    r.criteria.sourcesWithinInterval,
  );
}

console.log('\n=== Markdown report ===');
{
  const report = computeSnapshot(busyInput());
  const md = renderSnapshotMarkdown(report);
  assert(
    md === renderSnapshotMarkdown(report) && md === renderSnapshotMarkdown(JSON.parse(JSON.stringify(report)) as SnapshotReport) &&
      md.includes(report.generatedAt) && md.includes(report.snapshotId) &&
      md.startsWith('# Vulnerability management snapshot 2026-10-18\n'),
    'M01 markdown is deterministic',
  );
}
{
  const input = f0();
  input.sources = [source('s1', 'a*b_[c]')];
  input.assets.push(asset('a5', 'evil|<b>x</b>', 'CUI_ASSET', 'ACTIVE', null));
  const md = renderSnapshotMarkdown(computeSnapshot(input));
  assert(
    md.includes('evil\\|\\<b\\>x\\</b\\>') && md.includes('a\\*b\\_\\[c\\]') && !md.includes('<b>'),
    'M02 markdown escapes exporter strings',
  );
}
{
  const input = f0();
  input.sources.push(source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' }));
  input.assets.push(
    asset('a5', 'h-new', 'CUI_ASSET', 'ACTIVE', null),
    asset('a6', 'printer', 'SPECIALIZED_ASSET', 'UNCONFIRMED_DISCOVERY', null),
  );
  input.assets[0].lastVulnSeenAt = '2026-10-15T12:00:00.000Z';
  input.assets[1].lastVulnSeenAt = '2026-10-01T00:00:00.000Z';
  const md = renderSnapshotMarkdown(computeSnapshot(input));
  const section = (title: string): string => {
    const start = md.indexOf(`## ${title}\n`);
    const next = md.indexOf('\n## ', start + 1);
    return start < 0 ? '' : md.slice(start, next < 0 ? undefined : next);
  };
  const clean = renderSnapshotMarkdown(computeSnapshot(f0()));
  assert(
    section('Sources').includes('wazuh-b') &&
      section('Assets never reported').includes('h-new') && section('Assets never reported').includes('printer') &&
      section('Assets stale').includes('h-cui') && section('Assets stale').includes('h-spa') &&
      clean.includes('## Assets never reported\n\n(none)') && clean.includes('## Assets stale\n\nNot reported for more than 1d.\n\n(none)'),
    'M03 markdown includes stale-source and never-reported/stale asset sections',
  );
}
{
  const failedRun = run('r2', 's1', '2026-10-18T08:00:00.000Z', 'FAILED', 'The stored payload could not be read.');
  const md = renderSnapshotMarkdown(compute({ runs: [...f0().runs, failedRun] }));
  assert(
    md.includes('r2') && md.includes('The stored payload could not be read.') && md.includes('FAILED') &&
      md.includes('| Last run | Status | Failure |'),
    'M04 markdown source table shows the failed run id and message',
  );
}

console.log('\n=== Notes block ===');
const b1 = `${VM_NOTES_BEGIN}\nfirst\n${VM_NOTES_END}`;
const b2 = `${VM_NOTES_BEGIN}\nsecond\n${VM_NOTES_END}`;
const b3 = `${VM_NOTES_BEGIN}\nthird\n${VM_NOTES_END}`;
assert(replaceDelimitedBlock('', b1) === b1, 'B01 block into empty notes');
assert(
  replaceDelimitedBlock('Human text.', b1) === `Human text.\n\n${b1}` &&
    replaceDelimitedBlock('Human text.\n', b1) === `Human text.\n\n${b1}` &&
    replaceDelimitedBlock('A\n\n', b1) === `A\n\n${b1}`,
  'B02 append after text with one blank line',
);
assert(
  replaceDelimitedBlock(`Before\n\n${b1}\n\nAfter`, b2) === `Before\n\n${b2}\n\nAfter`,
  'B03 replace in place, text outside untouched',
);
{
  const out = replaceDelimitedBlock(replaceDelimitedBlock('X', b1), b2);
  assert(out === `X\n\n${b2}` && count(out, VM_NOTES_BEGIN) === 1, 'B04 second snapshot replaces the block', out);
}
assert(
  replaceDelimitedBlock(`A\n${b1}\nB\n${b1}`, b2) === `A\n${b2}\nB\n`,
  'B05 duplicate blocks collapse to one',
);
{
  const dangling = `A ${VM_NOTES_BEGIN} B`;
  const once = replaceDelimitedBlock(dangling, b2);
  const twice = replaceDelimitedBlock(once, b3);
  assert(once === `${dangling}\n\n${b2}` && twice === `${dangling}\n\n${b3}`, 'B06 dangling begin marker is preserved, not swallowed', { once, twice });
}
assert(
  replaceDelimitedBlock('L1\r\nL2', b1) === `L1\r\nL2\n\n${b1}` && replaceDelimitedBlock('L1\r\n', b1) === `L1\r\n\n${b1}`,
  'B07 CRLF notes',
);
{
  const block = renderNotesBlock(computeSnapshot(f0()), ['ev_vmsnap_1_aaaaa', 'ev_vmsnap_1_bbbbb']);
  assert(
    block ===
      '<!-- vm-snapshot:begin -->\n[VM snapshot 2026-10-18] criteria MET: yes | sources within interval: 1/1 | coverage 1.00 (4/4) of 0.95 | overdue CRITICAL/KEV: 0 | evidence: ev_vmsnap_1_aaaaa, ev_vmsnap_1_bbbbb\n<!-- vm-snapshot:end -->',
    'B08 block line for F0',
    block,
  );
}
{
  const input = f0();
  input.sources.push(source('s2', 'wazuh-b', { lastRunAt: '2026-10-14T12:00:00.000Z' }));
  input.assets = manyAssets(19, 18);
  input.findings = [finding('f1', { severity: 'CRITICAL', slaDueAt: '2026-10-17T00:00:00.000Z' })];
  const block = renderNotesBlock(computeSnapshot(input), ['e1']);
  const noSources = renderNotesBlock(compute({ sources: [] }), []);
  const noAssets = renderNotesBlock(compute({ assets: [] }), []);
  assert(
    block.includes(
      'criteria MET: no | sources within interval: 1/2 (wazuh-b stale 3d) | coverage 0.94 (18/19) of 0.95 | overdue CRITICAL/KEV: 1',
    ) &&
      noSources.includes('sources within interval: 0/0') &&
      noAssets.includes('coverage n/a (0/0) of 0.95'),
    'B09 block line with stale source and failing criteria',
    { block, noSources, noAssets },
  );
}
{
  const input = f0();
  input.sources.push(source('s2', '<!-- vm-snapshot:end -->x|y', { lastRunAt: '2026-10-14T12:00:00.000Z' }));
  const block = renderNotesBlock(computeSnapshot(input), ['e1']);
  assert(
    count(block, VM_NOTES_END) === 1 && count(block, VM_NOTES_BEGIN) === 1 && block.includes('_!-- vm-snapshot:end --_x/y'),
    'B10 marker injection through a source label is neutralised',
    block,
  );
}
{
  const failedRun = run('r2', 's1', '2026-10-18T08:00:00.000Z', 'FAILED', 'The stored payload could not be read.');
  const block = renderNotesBlock(compute({ runs: [...f0().runs, failedRun] }), ['e1']);
  assert(
    block.includes('sources within interval: 0/1 (wazuh-a last run failed)'),
    'B11 notes block names the failed source',
    block,
  );
}

console.log('\n=== Environment parsing ===');
{
  const tick = (v: string | undefined): number => getVmSnapshotConfig({ VM_SCHEDULER_TICK_MINUTES: v }).tickMinutes;
  const got = [undefined, '', '15', ' 15 ', '0', '5000', 'abc', '1.5', '-5'].map(tick);
  assert(eq(got, [60, 60, 15, 15, 1, 1440, 60, 60, 60]), 'E01 VM_SCHEDULER_TICK_MINUTES parsing', got);
}
{
  const hours = (v: string | undefined): number => getVmSnapshotConfig({ VM_SNAPSHOT_INTERVAL_HOURS: v }).snapshotIntervalHours;
  const got = [undefined, '24', '0', '99999', 'x'].map(hours);
  assert(eq(got, [168, 24, 1, 8760, 168]), 'E02 VM_SNAPSHOT_INTERVAL_HOURS parsing', got);
}
{
  const thr = (v: string | undefined): number => getVmSnapshotConfig({ VM_COVERAGE_THRESHOLD: v }).coverageThreshold;
  const got = [undefined, '0.9', ' 0.8 ', '1', '0', '.9', '1.5', '-0.1', '95', 'abc', '0.9x'].map(thr);
  assert(eq(got, [0.95, 0.9, 0.8, 1, 0, 0.9, 0.95, 0.95, 0.95, 0.95, 0.95]), 'E03 VM_COVERAGE_THRESHOLD parsing (0..1, invalid -> default)', got);
}

console.log('\n=== Scheduling decisions ===');
{
  const got = [0, 59, 60, 1439, 1440, 4320].map(formatDuration);
  assert(eq(got, ['0m', '59m', '1h', '23h', '1d', '3d']), 'D01 formatDuration', got);
}
{
  const T = NOW_MS;
  const got = [
    snapshotDue(null, T, 168),
    snapshotDue(new Date(T - (168 * 60 - 1) * MIN).toISOString(), T, 168),
    snapshotDue(new Date(T - 168 * 60 * MIN).toISOString(), T, 168),
    snapshotDue(new Date(T + 60 * MIN).toISOString(), T, 168),
  ];
  assert(eq(got, [true, false, true, false]), 'D02 snapshotDue', got);
}
{
  const LAST = '2026-10-18T06:00:00.000Z';
  const interval = 1440;
  const plan = (row: Partial<Parameters<typeof planStalenessChanges>[0][number]>) =>
    planStalenessChanges(
      [{ tenantId: 't1', sourceId: 's1', enabled: true, expectedIntervalMinutes: interval, lastRunAt: LAST, staleSince: null, ...row }],
      NOW_MS,
    );
  const staleRun = '2026-10-14T12:00:00.000Z';
  const expectedSince = new Date(Date.parse(staleRun) + interval * MIN).toISOString();
  const a = plan({ lastRunAt: staleRun, staleSince: null });
  const b = plan({ lastRunAt: staleRun, staleSince: expectedSince });
  const c = plan({ lastRunAt: LAST, staleSince: '2026-10-15T12:00:00.000Z' });
  const d = plan({ lastRunAt: LAST, staleSince: null });
  const e = plan({ enabled: false, lastRunAt: staleRun, staleSince: null });
  const f = plan({ lastRunAt: null, staleSince: null });
  assert(
    eq(a, [{ tenantId: 't1', sourceId: 's1', staleSince: expectedSince, lastRunAt: staleRun }]) &&
      eq(b, []) &&
      eq(c, [{ tenantId: 't1', sourceId: 's1', staleSince: null, lastRunAt: LAST }]) &&
      eq(d, []) && eq(e, []) &&
      eq(f, [{ tenantId: 't1', sourceId: 's1', staleSince: NOW, lastRunAt: null }]),
    'D03 planStalenessChanges',
    { a, b, c, d, e, f },
  );
}
{
  const t = 1_760_000_000_000;
  const got = [
    manualSnapshotAllowed(null, t),
    manualSnapshotAllowed(t, t + 59_999),
    manualSnapshotAllowed(t, t + 60_000),
  ];
  assert(eq(got, [true, false, true]) && VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS === 60_000, 'D04 manualSnapshotAllowed', got);
}

console.log('\n=== Identifiers and files ===');
{
  const fixed = newSnapshotId(1760788800000, () => 'abcde');
  const random = newSnapshotId(1760788800000);
  assert(fixed === SNAP_ID && /^vmsnap_\d{13}_[0-9a-f]{5}$/.test(random), 'I01 snapshot id format', { fixed, random });
}
{
  const ids = Array.from({ length: 50 }, () => newEvidenceId(1760788800000));
  assert(
    ids.every((id) => /^ev_vmsnap_\d{13}_[0-9a-f]{5}$/.test(id) && /^[A-Za-z0-9_-]+$/.test(id) && (id + '__inh_164_308_a__1__ii__D_').length <= 64) &&
      new Set(ids).size === 50,
    'I02 evidence id pattern',
    ids.slice(0, 3),
  );
}
{
  assert(
    eq(snapshotFileKeys('vmsnap_1_abcde'), { json: 'vm/snapshots/vmsnap_1_abcde.json', md: 'vm/snapshots/vmsnap_1_abcde.md' }),
    'I03 file naming',
  );
}

console.log('\n=== Controls ===');
{
  // Only SI.L1-3.14.1 is defined by both CMMC levels; the RA and CA controls are Level 2 only.
  const defining = (id: string): Set<string> => (id === 'SI.L1-3.14.1' ? new Set(['CMMC_L2', 'CMMC_L1']) : new Set(['CMMC_L2']));
  const L2_ALL = ['RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1', 'CA.L2-3.12.3'];
  const l1 = snapshotControlIds({ enabledFrameworks: ['CMMC_L1'] }, defining);
  const l2 = snapshotControlIds({ enabledFrameworks: ['CMMC_L2'] }, defining);
  const none = snapshotControlIds(null, defining);
  // The fake defining() maps every id to CMMC frameworks only, so a NIST-only program defines none of them.
  const nist = snapshotControlIds({ enabledFrameworks: ['NIST_800_53_REV5'] }, defining);
  const both = snapshotControlIds({ enabledFrameworks: ['NIST_800_53_REV5', 'CMMC_L2'] }, defining);
  assert(
    eq(l1, ['SI.L1-3.14.1']) && eq(l2, L2_ALL) && eq(none, ['RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1']) && eq(nist, []) && eq(both, L2_ALL) &&
      eq([...VM_SNAPSHOT_CONTROLS], L2_ALL) && eq([...VM_SNAPSHOT_FIXED_CONTROLS], none) &&
      VM_SNAPSHOT_OPTIONAL_CONTROL === 'CA.L2-3.12.3' && VM_SNAPSHOT_ACTOR === 'system:vm-snapshot',
    'C01 controls: each of the four only when the program defines it; no program record -> the three fixed ids',
    { l1, l2, none, nist, both },
  );
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
process.exit(passed === total ? 0 : 1);
