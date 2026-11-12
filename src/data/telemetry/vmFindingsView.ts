import { VM_FINDING_STATUSES, VM_SEVERITIES } from '../../types/vm';
import type { VmAffectedPackage, VmFinding, VmFindingStatus, VmSeverity } from '../../types/vm';

/**
 * The vulnerability findings the scanners report for one asset (GET .../vm/findings), read defensively from the API, and the rules the
 * read-only list shows them by: order, filters, captions and wording. Pure: no network, no storage.
 */

/** The server maximum for one request: the list never asks for more. */
export const FINDINGS_FETCH_LIMIT = 1000;
/** How many rows the table renders at first and per "Show more". */
export const FINDINGS_RENDER_STEP = 100;

export type FindingStatusFilter = 'ALL' | VmFindingStatus;
export type SeverityFilter = 'ALL' | VmSeverity;

export const FINDING_STATUS_FILTERS: FindingStatusFilter[] = ['OPEN', 'RESOLVED', 'RISK_ACCEPTED', 'FALSE_POSITIVE', 'ALL'];

export const SEVERITY_LABEL: Record<VmSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  UNKNOWN: 'Unknown',
};

export const STATUS_LABEL: Record<VmFindingStatus, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  RISK_ACCEPTED: 'Risk accepted',
  FALSE_POSITIVE: 'False positive',
};

export const SEVERITY_BADGE: Record<VmSeverity, string> = {
  CRITICAL: 'bg-rose-500/20 text-rose-200 border-rose-500/50',
  HIGH: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  MEDIUM: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  LOW: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  UNKNOWN: 'bg-slate-800 text-slate-300 border-slate-700',
};

export const STATUS_BADGE: Record<VmFindingStatus, string> = {
  OPEN: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  RESOLVED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  RISK_ACCEPTED: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  FALSE_POSITIVE: 'bg-slate-800 text-slate-300 border-slate-700',
};

export const FINDINGS_COPY = {
  heading: 'Vulnerabilities',
  note: 'What the scanner reports for this asset, updated by each scan. Read-only.',
  loading: 'Loading the vulnerabilities…',
  loadError: 'The vulnerabilities could not be loaded. The asset record is unaffected.',
  noScanner: 'No scanner has reported on this asset yet. Vulnerabilities appear here after a scan that includes it.',
  noOpen: 'No open vulnerabilities are reported for this asset.',
  noneAll: 'No vulnerabilities have been reported for this asset.',
  noMatch: 'No findings match the search and severity filter.',
  caption: 'Vulnerability findings reported by the scanner, most severe first',
  retry: 'Retry',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const isSeverity = (v: unknown): v is VmSeverity => typeof v === 'string' && (VM_SEVERITIES as readonly string[]).includes(v);
const isStatus = (v: unknown): v is VmFindingStatus => typeof v === 'string' && (VM_FINDING_STATUSES as readonly string[]).includes(v);

function parsePackages(raw: unknown): VmAffectedPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: VmAffectedPackage[] = [];
  for (const p of raw) {
    if (!isObj(p) || str(p.name) === '') continue;
    out.push({ name: str(p.name), version: str(p.version), fixedVersion: strOrNull(p.fixedVersion) });
  }
  return out;
}

function parseFinding(raw: unknown): VmFinding | null {
  if (!isObj(raw) || str(raw.id) === '' || str(raw.vulnId) === '' || !isStatus(raw.status)) return null;
  const affectedPackages = parsePackages(raw.affectedPackages);
  return {
    id: str(raw.id),
    tenantId: str(raw.tenantId),
    assetId: str(raw.assetId),
    vulnId: str(raw.vulnId),
    status: raw.status,
    severity: isSeverity(raw.severity) ? raw.severity : 'UNKNOWN',
    firstSeenAt: str(raw.firstSeenAt),
    lastSeenAt: str(raw.lastSeenAt),
    resolvedAt: strOrNull(raw.resolvedAt),
    resolvedRunId: strOrNull(raw.resolvedRunId),
    slaDueAt: strOrNull(raw.slaDueAt),
    packageName: str(raw.packageName),
    packageVersion: str(raw.packageVersion),
    fixedVersion: strOrNull(raw.fixedVersion),
    affectedPackages,
    affectedPackageCount: num(raw.affectedPackageCount) ?? affectedPackages.length,
    justification: strOrNull(raw.justification),
    decidedBy: strOrNull(raw.decidedBy),
    decidedByUserId: strOrNull(raw.decidedByUserId),
    decidedAt: strOrNull(raw.decidedAt),
  };
}

/** The findings of a findings response (the body); malformed items are dropped and the total falls back to the item count. */
export function parseVmFindings(raw: unknown): { totalCount: number; findings: VmFinding[] } {
  const list = isObj(raw) && Array.isArray(raw.findings) ? raw.findings : [];
  const findings = list.map(parseFinding).filter((f): f is VmFinding => f !== null);
  return { totalCount: isObj(raw) ? (num(raw.totalCount) ?? findings.length) : findings.length, findings };
}

/** The server's order: severity (Critical, High, Medium, Unknown, Low). */
const SEVERITY_RANK: Record<VmSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, UNKNOWN: 3, LOW: 4 };

const seenTime = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** A new array, most severe first, then the most recently seen, then by vulnerability id. The input is not changed. */
export function sortFindings(list: readonly VmFinding[]): VmFinding[] {
  return [...list].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const ta = seenTime(a.lastSeenAt);
    const tb = seenTime(b.lastSeenAt);
    if (ta !== tb) return ta > tb ? -1 : 1;
    return a.vulnId < b.vulnId ? -1 : a.vulnId > b.vulnId ? 1 : 0;
  });
}

/** Findings whose vulnerability id or any package name contains the query (case-insensitive), optionally of one severity. */
export function filterFindings(list: readonly VmFinding[], query: string, severity: SeverityFilter): VmFinding[] {
  const q = query.trim().toLowerCase();
  return list.filter((f) => {
    if (severity !== 'ALL' && f.severity !== severity) return false;
    if (q === '') return true;
    if (f.vulnId.toLowerCase().includes(q) || f.packageName.toLowerCase().includes(q)) return true;
    return f.affectedPackages.some((p) => p.name.toLowerCase().includes(q));
  });
}

export function severityCounts(list: readonly VmFinding[]): Record<VmSeverity, number> {
  const counts: Record<VmSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const f of list) counts[f.severity]++;
  return counts;
}

/** The first `max` affected packages of a finding and how many more there are (the stored list is capped, the count is the true total). */
export function affectedPackagesView(f: VmFinding, max = 3): { shown: VmAffectedPackage[]; more: number } {
  const source: VmAffectedPackage[] =
    f.affectedPackages.length === 0 && f.packageName !== ''
      ? [{ name: f.packageName, version: f.packageVersion, fixedVersion: f.fixedVersion }]
      : f.affectedPackages;
  const shown = source.slice(0, max);
  return { shown, more: Math.max(Math.max(f.affectedPackageCount, source.length) - shown.length, 0) };
}

export const packageLabel = (p: Pick<VmAffectedPackage, 'name' | 'version'>): string => `${p.name} ${p.version}`.trim();

export const fixText = (p: Pick<VmAffectedPackage, 'fixedVersion'>): string => (p.fixedVersion ? `fixed in ${p.fixedVersion}` : 'no fix reported');

export const moreText = (n: number): string => `and ${n} more`;

const plural = (n: number): string => `${n} finding${n === 1 ? '' : 's'}`;

export function findingsCaption(matched: number, loaded: number): string {
  return matched === loaded ? `Showing ${plural(loaded)}` : `Showing ${matched} of ${plural(loaded)}`;
}

/** Shown when the server's cap was reached: it does not say how many there are beyond it. */
export function findingsCapNotice(loaded: number): string | null {
  return loaded < FINDINGS_FETCH_LIMIT ? null : `Showing the first ${FINDINGS_FETCH_LIMIT} findings, most severe first. There may be more.`;
}

/** What to say when the server returned no findings; `scannerReported` is null while the host inventory is not known. */
export function findingsEmptyMessage(opts: { statusFilter: FindingStatusFilter; scannerReported: boolean | null }): string {
  const { statusFilter, scannerReported } = opts;
  if (scannerReported === false && (statusFilter === 'OPEN' || statusFilter === 'ALL')) return FINDINGS_COPY.noScanner;
  if (statusFilter === 'OPEN') return FINDINGS_COPY.noOpen;
  if (statusFilter === 'ALL') return FINDINGS_COPY.noneAll;
  return `No ${STATUS_LABEL[statusFilter].toLowerCase()} findings for this asset.`;
}
