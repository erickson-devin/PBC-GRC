import { randomBytes } from 'crypto';
import { CATEGORY_INFO } from '../../src/data/telemetry/assetScope';
import type { AssetDiscoveryStatus, CmmcAssetCategory } from '../../src/types/telemetry';
import { VM_SEVERITIES } from '../../src/types/vm';
import type { VmFinding, VmPoamItem, VmRun, VmRunStatus, VmSeverity, VmSource } from '../../src/types/vm';

/**
 * The pure core of the vulnerability management snapshot (docs/VULNERABILITY_MANAGEMENT.md, section 7): the evaluation of the
 * three assessor criteria over a window, the Markdown report, the delimited block written into control notes, and the small
 * scheduling decisions. Nothing here reads the database, the filesystem or the clock, so every rule is testable in isolation
 * (tests/vmSnapshot.test.ts). The caller supplies `now` and the rows.
 */

export const VM_SNAPSHOT_ACTOR = 'system:vm-snapshot';

/** Controls every tenant program that has a program record and defines them receives; see snapshotControlIds. */
export const VM_SNAPSHOT_CONTROLS = ['RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1', 'CA.L2-3.12.3'] as const;
/** Controls used when the tenant has no program record at all. */
export const VM_SNAPSHOT_FIXED_CONTROLS = ['RA.L2-3.11.2', 'RA.L2-3.11.3', 'SI.L1-3.14.1'] as const;
export const VM_SNAPSHOT_OPTIONAL_CONTROL = 'CA.L2-3.12.3';

export const VM_NOTES_BEGIN = '<!-- vm-snapshot:begin -->';
export const VM_NOTES_END = '<!-- vm-snapshot:end -->';

/** Minimum gap between two manual snapshots of one tenant. */
export const VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface VmSnapshotConfig {
  tickMinutes: number;
  snapshotIntervalHours: number;
  coverageThreshold: number;
}

/** Read on every call, so tests and operators can change the environment without restarting the module. */
export function getVmSnapshotConfig(env: NodeJS.ProcessEnv = process.env): VmSnapshotConfig {
  const readInt = (key: string, fallback: number, min: number, max: number): number => {
    const raw = (env[key] ?? '').trim();
    if (!/^\d+$/.test(raw)) return fallback;
    return Math.min(max, Math.max(min, Number(raw)));
  };
  const rawThreshold = (env.VM_COVERAGE_THRESHOLD ?? '').trim();
  let coverageThreshold = 0.95;
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawThreshold)) {
    const n = Number(rawThreshold);
    if (n >= 0 && n <= 1) coverageThreshold = n;
  }
  return {
    tickMinutes: readInt('VM_SCHEDULER_TICK_MINUTES', 60, 1, 1440),
    snapshotIntervalHours: readInt('VM_SNAPSHOT_INTERVAL_HOURS', 168, 1, 8760),
    coverageThreshold,
  };
}

type CoverageCategory = 'CUI_ASSET' | 'SECURITY_PROTECTION' | 'CONTRACTOR_RISK' | 'SPECIALIZED_ASSET';
const COVERAGE_CATEGORIES: readonly CoverageCategory[] = ['CUI_ASSET', 'SECURITY_PROTECTION', 'CONTRACTOR_RISK', 'SPECIALIZED_ASSET'];

export interface SnapshotInput {
  snapshotId: string;
  tenantId: string;
  /** ISO timestamp the report is evaluated at. */
  now: string;
  windowHours: number;
  coverageThreshold: number;
  sources: Pick<VmSource, 'id' | 'kind' | 'label' | 'enabled' | 'expectedIntervalMinutes' | 'lastRunAt' | 'staleSince'>[];
  runs: Pick<VmRun, 'id' | 'sourceId' | 'receivedAt' | 'status' | 'error'>[];
  assets: {
    id: string;
    hostName: string;
    cmmcCategory: CmmcAssetCategory;
    discoveryStatus: AssetDiscoveryStatus;
    lastVulnSeenAt: string | null;
  }[];
  findings: Pick<VmFinding, 'id' | 'assetId' | 'vulnId' | 'status' | 'severity' | 'slaDueAt' | 'resolvedAt'>[];
  kevVulnIds: readonly string[];
  poamItems: Pick<VmPoamItem, 'id' | 'findingId' | 'status'>[];
}

export interface SnapshotAssetRef {
  assetId: string;
  hostName: string;
  cmmcCategory: CmmcAssetCategory;
  discoveryStatus: AssetDiscoveryStatus;
  lastVulnSeenAt: string | null;
  ageMinutes: number | null;
}

export interface SnapshotSourceItem {
  id: string;
  label: string;
  kind: VmSource['kind'];
  enabled: boolean;
  expectedIntervalMinutes: number;
  lastRunAt: string | null;
  staleSince: string | null;
  ageMinutes: number | null;
  /** Interval staleness only: an enabled source that never ran or exceeded its interval. */
  stale: boolean;
  staleForMinutes: number | null;
  runsInWindow: number;
  failedRunsInWindow: number;
  /** The source's most recent run is FAILED (a broken exporter would otherwise look fresh: last_run_at moves at receive time). */
  lastRunFailed: boolean;
  lastRun: { id: string; receivedAt: string; status: VmRunStatus; error: string | null } | null;
}

export interface SnapshotReport {
  version: 1;
  snapshotId: string;
  tenantId: string;
  generatedAt: string;
  window: { start: string; end: string; hours: number };
  thresholds: { coverage: number };
  sources: { total: number; enabled: number; withinInterval: number; items: SnapshotSourceItem[] };
  coverage: {
    inScopeTotal: number;
    covered: number;
    ratio: number | null;
    byCategory: Record<CoverageCategory, { total: number; covered: number }>;
    excluded: { unconfirmed: number; decommissioned: number; outOfScope: number };
  };
  findings: {
    openBySeverity: Record<VmSeverity, number>;
    openTotal: number;
    kevOpen: number;
    overdueOpen: number;
    overdueCriticalOrKev: number;
    openWithinSla: number;
    openSlaCompliance: number;
    closedInWindow: number;
    closedInWindowWithinSla: number;
    closedSlaCompliance: number | null;
    riskAccepted: number;
    falsePositive: number;
    openOnDecommissioned: number;
  };
  poam: { overdueWithPoam: number; overdueWithoutPoam: number; openItems: number };
  assets: { staleThresholdMinutes: number; neverReported: SnapshotAssetRef[]; stale: SnapshotAssetRef[] };
  criteria: {
    met: boolean;
    sourcesWithinInterval: { met: boolean; reason: string };
    coverage: { met: boolean; reason: string };
    noOverdueCriticalOrKev: { met: boolean; reason: string };
  };
}

export function formatDuration(minutes: number): string {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

/** An enabled source is stale when it never ran or its last run is older than its interval (strict: "exceeds"). */
export function isSourceStale(
  s: Pick<VmSource, 'enabled' | 'expectedIntervalMinutes' | 'lastRunAt'>,
  nowMs: number,
): boolean {
  if (!s.enabled) return false;
  if (s.lastRunAt === null) return true;
  return nowMs - Date.parse(s.lastRunAt) > s.expectedIntervalMinutes * MINUTE_MS;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const lowerThenId = (a: { text: string; id: string }, b: { text: string; id: string }): number =>
  byText(a.text.toLowerCase(), b.text.toLowerCase()) || byText(a.id, b.id);

/** Why an enabled source fails criterion 1, as the text between the parentheses; null when it does not fail. */
function sourceProblem(item: SnapshotSourceItem): string | null {
  if (!item.enabled) return null;
  const parts: string[] = [];
  if (item.stale) {
    parts.push(item.staleForMinutes === null ? 'never reported' : `stale ${formatDuration(item.staleForMinutes)}`);
  }
  if (item.lastRunFailed) parts.push('last run failed');
  return parts.length ? parts.join(', ') : null;
}

const pct = (covered: number, total: number): string => (Math.floor((covered * 100) / total) / 100).toFixed(2);

export function computeSnapshot(input: SnapshotInput): SnapshotReport {
  const nowMs = Date.parse(input.now);
  const windowStartMs = nowMs - input.windowHours * HOUR_MS;
  const generatedAt = new Date(nowMs).toISOString();
  const windowStart = new Date(windowStartMs).toISOString();
  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    return t >= windowStartMs && t <= nowMs;
  };

  // Sources.
  const sortedSources = [...input.sources].sort((a, b) =>
    lowerThenId({ text: a.label, id: a.id }, { text: b.label, id: b.id }),
  );
  const items: SnapshotSourceItem[] = sortedSources.map((s) => {
    const runs = input.runs.filter((r) => r.sourceId === s.id);
    let latest: (typeof runs)[number] | null = null;
    for (const r of runs) {
      if (
        latest === null ||
        Date.parse(r.receivedAt) > Date.parse(latest.receivedAt) ||
        (Date.parse(r.receivedAt) === Date.parse(latest.receivedAt) && r.id > latest.id)
      ) {
        latest = r;
      }
    }
    const windowRuns = runs.filter((r) => inWindow(r.receivedAt));
    const lastRunMs = s.lastRunAt === null ? null : Date.parse(s.lastRunAt);
    const stale = isSourceStale(s, nowMs);
    const intervalMs = s.expectedIntervalMinutes * MINUTE_MS;
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      enabled: s.enabled,
      expectedIntervalMinutes: s.expectedIntervalMinutes,
      lastRunAt: s.lastRunAt,
      staleSince: s.staleSince,
      ageMinutes: lastRunMs === null ? null : Math.floor((nowMs - lastRunMs) / MINUTE_MS),
      stale,
      staleForMinutes: stale && lastRunMs !== null ? Math.floor((nowMs - lastRunMs - intervalMs) / MINUTE_MS) : null,
      runsInWindow: windowRuns.length,
      failedRunsInWindow: windowRuns.filter((r) => r.status === 'FAILED').length,
      lastRunFailed: latest !== null && latest.status === 'FAILED',
      lastRun: latest
        ? { id: latest.id, receivedAt: latest.receivedAt, status: latest.status, error: latest.error }
        : null,
    };
  });
  const enabledItems = items.filter((i) => i.enabled);
  const failingItems = enabledItems.filter((i) => sourceProblem(i) !== null);
  const sourcesMet = enabledItems.length > 0 && failingItems.length === 0;
  const sourcesReason =
    enabledItems.length === 0
      ? 'No enabled vulnerability source has reported.'
      : failingItems.length === 0
        ? `All ${enabledItems.length} enabled source(s) reported within their expected interval.`
        : `${failingItems.length} of ${enabledItems.length} enabled source(s) outside their expected interval: ${failingItems
            .map((i) => `${i.label} (${sourceProblem(i)})`)
            .join(', ')}.`;

  // Asset coverage (summarizeScope semantics: decommissioned, unconfirmed and out-of-scope assets are not in the denominator).
  const byCategory = {} as Record<CoverageCategory, { total: number; covered: number }>;
  for (const c of COVERAGE_CATEGORIES) byCategory[c] = { total: 0, covered: 0 };
  const excluded = { unconfirmed: 0, decommissioned: 0, outOfScope: 0 };
  let inScopeTotal = 0;
  let covered = 0;
  for (const a of input.assets) {
    if (a.discoveryStatus === 'DECOMMISSIONED') {
      excluded.decommissioned += 1;
      continue;
    }
    if (a.discoveryStatus === 'UNCONFIRMED_DISCOVERY') {
      excluded.unconfirmed += 1;
      continue;
    }
    if (!CATEGORY_INFO[a.cmmcCategory].inScope) {
      excluded.outOfScope += 1;
      continue;
    }
    const isCovered = a.lastVulnSeenAt !== null && Date.parse(a.lastVulnSeenAt) >= windowStartMs;
    inScopeTotal += 1;
    byCategory[a.cmmcCategory as CoverageCategory].total += 1;
    if (isCovered) {
      covered += 1;
      byCategory[a.cmmcCategory as CoverageCategory].covered += 1;
    }
  }
  const ratio = inScopeTotal === 0 ? null : covered / inScopeTotal;
  const coverageMet = ratio !== null && ratio >= input.coverageThreshold;
  const coverageReason =
    ratio === null
      ? 'No in-scope assets in the inventory; coverage cannot be measured.'
      : `${covered} of ${inScopeTotal} in-scope assets (${pct(covered, inScopeTotal)}) reported in the last ${input.windowHours} h; threshold ${String(input.coverageThreshold)}.`;

  // Asset lists: every asset that is neither decommissioned nor out of scope, unconfirmed ones included.
  const staleThresholdMinutes = enabledItems.length
    ? Math.max(...enabledItems.map((i) => i.expectedIntervalMinutes))
    : 1440;
  const neverReported: SnapshotAssetRef[] = [];
  const staleAssets: SnapshotAssetRef[] = [];
  const listed = input.assets
    .filter((a) => a.discoveryStatus !== 'DECOMMISSIONED' && a.cmmcCategory !== 'OUT_OF_SCOPE')
    .sort((a, b) => lowerThenId({ text: a.hostName, id: a.id }, { text: b.hostName, id: b.id }));
  for (const a of listed) {
    const seenMs = a.lastVulnSeenAt === null ? null : Date.parse(a.lastVulnSeenAt);
    const ref: SnapshotAssetRef = {
      assetId: a.id,
      hostName: a.hostName,
      cmmcCategory: a.cmmcCategory,
      discoveryStatus: a.discoveryStatus,
      lastVulnSeenAt: a.lastVulnSeenAt,
      ageMinutes: seenMs === null ? null : Math.max(0, Math.floor((nowMs - seenMs) / MINUTE_MS)),
    };
    if (seenMs === null) neverReported.push(ref);
    else if (nowMs - seenMs > staleThresholdMinutes * MINUTE_MS) staleAssets.push(ref);
  }

  // Findings. Those on decommissioned assets are left out of every count.
  const decommissionedIds = new Set(
    input.assets.filter((a) => a.discoveryStatus === 'DECOMMISSIONED').map((a) => a.id),
  );
  const kev = new Set(input.kevVulnIds);
  const openBySeverity = {} as Record<VmSeverity, number>;
  for (const s of VM_SEVERITIES) openBySeverity[s] = 0;
  const f = {
    openTotal: 0,
    kevOpen: 0,
    overdueOpen: 0,
    overdueCriticalOrKev: 0,
    closedInWindow: 0,
    closedInWindowWithinSla: 0,
    riskAccepted: 0,
    falsePositive: 0,
    openOnDecommissioned: 0,
  };
  const overdueFindingIds = new Set<string>();
  for (const fi of input.findings) {
    if (decommissionedIds.has(fi.assetId)) {
      if (fi.status === 'OPEN') f.openOnDecommissioned += 1;
      continue;
    }
    if (fi.status === 'OPEN') {
      f.openTotal += 1;
      openBySeverity[fi.severity] += 1;
      const isKev = kev.has(fi.vulnId);
      if (isKev) f.kevOpen += 1;
      if (fi.slaDueAt !== null && Date.parse(fi.slaDueAt) < nowMs) {
        f.overdueOpen += 1;
        overdueFindingIds.add(fi.id);
        if (fi.severity === 'CRITICAL' || isKev) f.overdueCriticalOrKev += 1;
      }
    } else if (fi.status === 'RESOLVED') {
      if (fi.resolvedAt !== null && inWindow(fi.resolvedAt)) {
        f.closedInWindow += 1;
        if (fi.slaDueAt === null || Date.parse(fi.resolvedAt) <= Date.parse(fi.slaDueAt)) f.closedInWindowWithinSla += 1;
      }
    } else if (fi.status === 'RISK_ACCEPTED') {
      f.riskAccepted += 1;
    } else if (fi.status === 'FALSE_POSITIVE') {
      f.falsePositive += 1;
    }
  }
  const openWithinSla = f.openTotal - f.overdueOpen;

  // POA&M linkage of the overdue findings.
  const activeItem = (status: string): boolean => status === 'OPEN' || status === 'IN_PROGRESS';
  const linked = new Set<string>();
  let openItems = 0;
  for (const item of input.poamItems) {
    if (!activeItem(item.status)) continue;
    openItems += 1;
    if (item.findingId !== null) linked.add(item.findingId);
  }
  let overdueWithPoam = 0;
  for (const id of overdueFindingIds) if (linked.has(id)) overdueWithPoam += 1;

  const overdueMet = f.overdueCriticalOrKev === 0;

  return {
    version: 1,
    snapshotId: input.snapshotId,
    tenantId: input.tenantId,
    generatedAt,
    window: { start: windowStart, end: generatedAt, hours: input.windowHours },
    thresholds: { coverage: input.coverageThreshold },
    sources: {
      total: items.length,
      enabled: enabledItems.length,
      withinInterval: enabledItems.length - failingItems.length,
      items,
    },
    coverage: { inScopeTotal, covered, ratio, byCategory, excluded },
    findings: {
      openBySeverity,
      openTotal: f.openTotal,
      kevOpen: f.kevOpen,
      overdueOpen: f.overdueOpen,
      overdueCriticalOrKev: f.overdueCriticalOrKev,
      openWithinSla,
      openSlaCompliance: f.openTotal ? openWithinSla / f.openTotal : 1,
      closedInWindow: f.closedInWindow,
      closedInWindowWithinSla: f.closedInWindowWithinSla,
      closedSlaCompliance: f.closedInWindow ? f.closedInWindowWithinSla / f.closedInWindow : null,
      riskAccepted: f.riskAccepted,
      falsePositive: f.falsePositive,
      openOnDecommissioned: f.openOnDecommissioned,
    },
    poam: { overdueWithPoam, overdueWithoutPoam: overdueFindingIds.size - overdueWithPoam, openItems },
    assets: { staleThresholdMinutes, neverReported, stale: staleAssets },
    criteria: {
      met: sourcesMet && coverageMet && overdueMet,
      sourcesWithinInterval: { met: sourcesMet, reason: sourcesReason },
      coverage: { met: coverageMet, reason: coverageReason },
      noOverdueCriticalOrKev: {
        met: overdueMet,
        reason: overdueMet
          ? 'No OPEN CRITICAL or KEV finding is past its SLA deadline.'
          : `${f.overdueCriticalOrKev} OPEN CRITICAL or KEV finding(s) past their SLA deadline.`,
      },
    },
  };
}

/** Exporter-controlled text is escaped so it cannot inject Markdown or HTML into the report. */
function mdText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[\\|<>[\]`*_#]/g, (c) => `\\${c}`);
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
const fmtRatio = (r: number | null): string => (r === null ? 'n/a' : r.toFixed(4));

function assetTable(refs: readonly SnapshotAssetRef[]): string[] {
  if (refs.length === 0) return ['(none)'];
  return [
    '| Host | Category | Discovery | Last seen | Age |',
    '| --- | --- | --- | --- | --- |',
    ...refs.map(
      (a) =>
        `| ${mdText(a.hostName)} | ${mdText(CATEGORY_INFO[a.cmmcCategory].short)} | ${mdText(a.discoveryStatus)} | ${a.lastVulnSeenAt ?? '(never)'} | ${a.ageMinutes === null ? '(never)' : formatDuration(a.ageMinutes)} |`,
    ),
  ];
}

export function renderSnapshotMarkdown(report: SnapshotReport): string {
  const c = report.criteria;
  const L: string[] = [];
  L.push(`# Vulnerability management snapshot ${report.generatedAt.slice(0, 10)}`, '');
  L.push(`- Snapshot: \`${report.snapshotId}\``);
  L.push(`- Generated: ${report.generatedAt}`);
  L.push(`- Window: ${report.window.start} to ${report.window.end} (${report.window.hours} h)`);
  L.push(`- Coverage threshold: ${String(report.thresholds.coverage)}`, '');

  L.push('## Criteria', '');
  L.push(`Overall: ${c.met ? 'MET' : 'NOT MET'}`, '');
  L.push(`- Sources within expected interval: ${c.sourcesWithinInterval.met ? 'met' : 'not met'}. ${mdText(c.sourcesWithinInterval.reason)}`);
  L.push(`- Asset coverage: ${c.coverage.met ? 'met' : 'not met'}. ${mdText(c.coverage.reason)}`);
  L.push(`- No overdue CRITICAL or KEV finding: ${c.noOverdueCriticalOrKev.met ? 'met' : 'not met'}. ${mdText(c.noOverdueCriticalOrKev.reason)}`, '');

  L.push('## Sources', '');
  if (report.sources.items.length === 0) {
    L.push('(none)');
  } else {
    L.push('| Source | Kind | Enabled | Interval (min) | Last run at | Age | Stale | Runs in window | Failed in window | Last run | Status | Failure |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of report.sources.items) {
      const stale = s.stale ? (s.staleForMinutes === null ? 'never reported' : `yes (${formatDuration(s.staleForMinutes)})`) : 'no';
      L.push(
        `| ${mdText(s.label)} | ${mdText(s.kind)} | ${yesNo(s.enabled)} | ${s.expectedIntervalMinutes} | ${s.lastRunAt ?? '(never)'} | ${s.ageMinutes === null ? '(never)' : formatDuration(s.ageMinutes)} | ${stale} | ${s.runsInWindow} | ${s.failedRunsInWindow} | ${s.lastRun ? mdText(s.lastRun.id) : '(none)'} | ${s.lastRun ? mdText(s.lastRun.status) : '(none)'} | ${s.lastRun && s.lastRun.error !== null ? mdText(s.lastRun.error) : '(none)'} |`,
      );
    }
  }
  L.push('');

  const cov = report.coverage;
  L.push('## Asset coverage', '');
  L.push(`In-scope assets reported in the window: ${cov.covered} of ${cov.inScopeTotal} (ratio ${fmtRatio(cov.ratio)}).`, '');
  L.push('| Category | In scope | Reported |', '| --- | --- | --- |');
  for (const k of COVERAGE_CATEGORIES) {
    L.push(`| ${mdText(CATEGORY_INFO[k].short)} | ${cov.byCategory[k].total} | ${cov.byCategory[k].covered} |`);
  }
  L.push('');
  L.push(
    `Excluded from the count: ${cov.excluded.unconfirmed} unconfirmed, ${cov.excluded.decommissioned} decommissioned, ${cov.excluded.outOfScope} out of scope.`,
    '',
  );

  const f = report.findings;
  L.push('## Open findings', '');
  L.push('| Severity | Open |', '| --- | --- |');
  for (const s of VM_SEVERITIES) L.push(`| ${s} | ${f.openBySeverity[s]} |`);
  L.push('');
  L.push(`- Open total: ${f.openTotal}`);
  L.push(`- Known exploited (KEV) open: ${f.kevOpen}`);
  L.push(`- Risk accepted: ${f.riskAccepted}`);
  L.push(`- False positive: ${f.falsePositive}`);
  L.push(`- Open on decommissioned assets (not counted above): ${f.openOnDecommissioned}`, '');

  L.push('## SLA', '');
  L.push(`- Overdue open: ${f.overdueOpen} (CRITICAL or KEV: ${f.overdueCriticalOrKev})`);
  L.push(`- Open within SLA: ${f.openWithinSla} of ${f.openTotal} (${(f.openSlaCompliance * 100).toFixed(1)}%)`);
  L.push(
    `- Closed in the window: ${f.closedInWindow}, within SLA: ${f.closedInWindowWithinSla}${f.closedSlaCompliance === null ? '' : ` (${(f.closedSlaCompliance * 100).toFixed(1)}%)`}`,
    '',
  );

  const p = report.poam;
  L.push('## POA&M', '');
  L.push(`- Overdue findings with an open POA&M item: ${p.overdueWithPoam}`);
  L.push(`- Overdue findings without one: ${p.overdueWithoutPoam}`);
  L.push(`- Open POA&M items: ${p.openItems}`, '');

  L.push('## Assets never reported', '');
  L.push(...assetTable(report.assets.neverReported), '');
  L.push('## Assets stale', '');
  L.push(`Not reported for more than ${formatDuration(report.assets.staleThresholdMinutes)}.`, '');
  L.push(...assetTable(report.assets.stale), '');
  return L.join('\n');
}

/** Keeps an exporter-controlled label from closing or opening the notes block. */
function blockText(label: string): string {
  return label.replace(/[<>]/g, '_').replace(/\|/g, '/');
}

export function renderNotesBlock(report: SnapshotReport, evidenceIds: readonly string[]): string {
  const problems = report.sources.items
    .map((i) => ({ label: i.label, text: sourceProblem(i) }))
    .filter((p): p is { label: string; text: string } => p.text !== null)
    .map((p) => `${blockText(p.label)} ${p.text}`);
  const cov = report.coverage;
  const line = [
    `[VM snapshot ${report.generatedAt.slice(0, 10)}] criteria MET: ${yesNo(report.criteria.met)}`,
    `sources within interval: ${report.sources.withinInterval}/${report.sources.enabled}${problems.length ? ` (${problems.join(', ')})` : ''}`,
    `coverage ${cov.ratio === null ? 'n/a' : pct(cov.covered, cov.inScopeTotal)} (${cov.covered}/${cov.inScopeTotal}) of ${String(report.thresholds.coverage)}`,
    `overdue CRITICAL/KEV: ${report.findings.overdueCriticalOrKev}`,
    `evidence: ${evidenceIds.length ? evidenceIds.join(', ') : 'none'}`,
  ].join(' | ');
  return `${VM_NOTES_BEGIN}\n${line}\n${VM_NOTES_END}`;
}

const BLOCK_RE = /<!-- vm-snapshot:begin -->(?:(?!<!-- vm-snapshot:begin -->)[\s\S])*?<!-- vm-snapshot:end -->/g;

/**
 * Replaces the first complete block in the notes and removes any further ones. A dangling begin marker is not a block and is
 * left alone. With no block the new one is appended after one blank line. Text outside the markers is never touched.
 */
export function replaceDelimitedBlock(notes: string, block: string): string {
  let replaced = false;
  const out = notes.replace(BLOCK_RE, () => {
    if (replaced) return '';
    replaced = true;
    return block;
  });
  if (replaced) return out;
  if (notes === '') return block;
  if (notes.endsWith('\n\n')) return notes + block;
  if (notes.endsWith('\n')) return `${notes}\n${block}`;
  return `${notes}\n\n${block}`;
}

const BLOCK_SOURCE = BLOCK_RE.source;
const FIRST_BLOCK_RE = new RegExp(BLOCK_SOURCE);
const LEADING_BLOCK_RE = new RegExp(`^${BLOCK_SOURCE}(?:\\r?\\n){0,2}`);
const INNER_BLOCK_RE = new RegExp(`(?:\\r?\\n){0,2}${BLOCK_SOURCE}`, 'g');

/** The first complete block in the notes, or null. A dangling begin marker is not a block. */
export function extractDelimitedBlock(notes: string): string | null {
  const m = FIRST_BLOCK_RE.exec(notes);
  return m ? m[0] : null;
}

/** Removes every complete block with its separating blank line; dangling markers and all other text are left alone. */
export function stripDelimitedBlocks(notes: string): string {
  return notes.replace(LEADING_BLOCK_RE, '').replace(INNER_BLOCK_RE, '');
}

/**
 * The notes to store when a person (or the SSP import) writes `newNotes` over `previousNotes`: any block in the new text is
 * removed (it could be forged or stale) and the one from the previous notes, else `fallbackBlock`, is put back.
 */
export function composeCommittedNotes(previousNotes: string, newNotes: string, fallbackBlock: string | null): string {
  const block = extractDelimitedBlock(previousNotes) ?? fallbackBlock;
  const cleaned = stripDelimitedBlocks(newNotes);
  return block === null ? cleaned : replaceDelimitedBlock(cleaned, block);
}

export interface SchedulerSourceInput {
  tenantId: string;
  sourceId: string;
  enabled: boolean;
  expectedIntervalMinutes: number;
  lastRunAt: string | null;
  staleSince: string | null;
}

/** The stale_since writes a tick should make: set when a source went stale, cleared when it recovered or was disabled. */
export function planStalenessChanges(
  rows: readonly SchedulerSourceInput[],
  nowMs: number,
): Array<{ tenantId: string; sourceId: string; staleSince: string | null; lastRunAt: string | null }> {
  const changes: Array<{ tenantId: string; sourceId: string; staleSince: string | null; lastRunAt: string | null }> = [];
  for (const r of rows) {
    const stale = isSourceStale(r, nowMs);
    if (stale && r.staleSince === null) {
      const since =
        r.lastRunAt === null ? nowMs : Date.parse(r.lastRunAt) + r.expectedIntervalMinutes * MINUTE_MS;
      changes.push({ tenantId: r.tenantId, sourceId: r.sourceId, staleSince: new Date(since).toISOString(), lastRunAt: r.lastRunAt });
    } else if (!stale && r.staleSince !== null) {
      changes.push({ tenantId: r.tenantId, sourceId: r.sourceId, staleSince: null, lastRunAt: r.lastRunAt });
    }
  }
  return changes;
}

/** True when the tenant has no snapshot yet or the latest is at least `hours` old. */
export function snapshotDue(latestIso: string | null, nowMs: number, hours: number): boolean {
  if (latestIso === null) return true;
  const latestMs = Date.parse(latestIso);
  if (Number.isNaN(latestMs)) return true;
  return nowMs - latestMs >= hours * HOUR_MS;
}

export function manualSnapshotAllowed(lastMs: number | null | undefined, nowMs: number): boolean {
  if (lastMs === null || lastMs === undefined) return true;
  return nowMs - lastMs >= VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS;
}

const randomSuffix = (): string => randomBytes(3).toString('hex').slice(0, 5);

export function newSnapshotId(nowMs: number, rand: () => string = randomSuffix): string {
  return `vmsnap_${nowMs}_${rand()}`;
}

/** Matches the evidence id pattern (letters, digits, underscore, hyphen; no dots) and leaves room for the inherited suffix. */
export function newEvidenceId(nowMs: number, rand: () => string = randomSuffix): string {
  return `ev_vmsnap_${nowMs}_${rand()}`;
}

export function snapshotFileKeys(id: string): { json: string; md: string } {
  return { json: `vm/snapshots/${id}.json`, md: `vm/snapshots/${id}.md` };
}

/**
 * The controls a snapshot attaches evidence and notes to: each of the four only when the tenant's program defines it, so no
 * control_assessments row appears outside the program. A tenant with no program record gets the three fixed ids.
 */
export function snapshotControlIds(
  program: { enabledFrameworks: string[] } | null,
  defining: (id: string) => Set<string>,
): string[] {
  if (program === null) return [...VM_SNAPSHOT_FIXED_CONTROLS];
  return VM_SNAPSHOT_CONTROLS.filter((id) => {
    const frameworks = defining(id);
    return program.enabledFrameworks.some((fw) => frameworks.has(fw));
  });
}
