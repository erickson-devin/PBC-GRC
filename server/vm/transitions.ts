import type { VmFinding, VmPoamStatus, VmRun, VmSeverity } from '../../src/types/vm';
import type { NormalizedHost } from './adapters/wazuh';

/**
 * The pure core of vulnerability management (docs/VULNERABILITY_MANAGEMENT.md, section 6): how one normalized run changes the
 * findings of a tenant, which findings are due a POA&M item, and which runs a restart left unfinished. Nothing here reads the
 * database, the filesystem or the clock, so every transition is testable in isolation (tests/vmNormalize.test.ts).
 */

export type VmSlaConfig = Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;

/** Remediation deadline in days after first sight. */
export const VM_SLA_DEFAULTS: VmSlaConfig = { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 };

const DAY_MS = 86_400_000;

/** Read on every call, so tests and operators can change the environment without restarting the module. */
export function getVmSlaConfig(env: NodeJS.ProcessEnv = process.env): VmSlaConfig {
  const read = (key: keyof VmSlaConfig): number => {
    const raw = (env[`VM_SLA_DAYS_${key}`] ?? '').trim();
    if (!/^\d+$/.test(raw)) return VM_SLA_DEFAULTS[key];
    return Math.min(3650, Math.max(1, Number(raw)));
  };
  return { CRITICAL: read('CRITICAL'), HIGH: read('HIGH'), MEDIUM: read('MEDIUM'), LOW: read('LOW') };
}

/** VM_POAM_AUTOCREATE: on unless explicitly switched off. */
export function isPoamAutocreateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.VM_POAM_AUTOCREATE ?? '').trim().toLowerCase());
}

/** UNKNOWN ranks above LOW: a finding nobody could grade is not assumed harmless. */
export const SEVERITY_RANK: Record<VmSeverity, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, UNKNOWN: 2, LOW: 1 };

export function worstSeverity(a: VmSeverity, b: VmSeverity): VmSeverity {
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

/** UNKNOWN is held to the MEDIUM deadline. A known exploited vulnerability is never allowed longer than a CRITICAL one. */
export function effectiveSlaDays(severity: VmSeverity, kev: boolean, cfg: VmSlaConfig): number {
  const days = severity === 'UNKNOWN' ? cfg.MEDIUM : cfg[severity];
  return kev ? Math.min(cfg.CRITICAL, days) : days;
}

export function slaDueAt(firstSeenAt: string, severity: VmSeverity, kev: boolean, cfg: VmSlaConfig): string {
  return new Date(Date.parse(firstSeenAt) + effectiveSlaDays(severity, kev, cfg) * DAY_MS).toISOString();
}

/**
 * When the SLA clock starts. The scanner's detected_at is trusted only inside sane bounds: never after the run was received,
 * never before the vulnerability was published, never more than 10 years back. On a reopen only a detection after the closing
 * run counts, otherwise the clock restarts at receivedAt.
 */
export function firstSeenFor(
  detectedAt: string | null,
  receivedAt: string,
  publishedAt?: string | null,
  resolvedAt?: string | null,
): string {
  if (!detectedAt) return receivedAt;
  const d = Date.parse(detectedAt);
  const r = Date.parse(receivedAt);
  if (Number.isNaN(d) || Number.isNaN(r)) return receivedAt;
  if (d > r) return receivedAt;
  if (publishedAt) {
    const p = Date.parse(publishedAt);
    if (!Number.isNaN(p) && d < p) return receivedAt;
  }
  if (d < r - 3650 * DAY_MS) return receivedAt;
  if (resolvedAt) {
    const c = Date.parse(resolvedAt);
    if (!Number.isNaN(c) && !(d > c)) return receivedAt;
  }
  return new Date(d).toISOString();
}

export interface RunContext {
  id: string;
  sourceId: string;
  receivedAt: string;
  collectedAt: string | null;
}

export interface ReportedHost {
  assetId: string;
  host: NormalizedHost;
}

export interface ApplyRunInput {
  tenantId: string;
  run: RunContext;
  hosts: ReportedHost[];
  /** The findings of the reported assets (any source, any status). */
  existing: VmFinding[];
  /** Ids of findings this source has ever sighted: only those may be closed by this source's run. */
  sightedBySource: ReadonlySet<string>;
  /** Vulnerability ids on the CISA KEV list. */
  kev: ReadonlySet<string>;
  sla: VmSlaConfig;
  newId: () => string;
}

export interface SightingDraft {
  findingId: string;
  runId: string;
  sourceId: string;
  reportedSeverity: VmSeverity;
  reportedAt: string;
  detail: Record<string, unknown>;
}

export interface ApplyRunResult {
  created: VmFinding[];
  updated: VmFinding[];
  resolved: VmFinding[];
  sightings: SightingDraft[];
  /** Sorted, unique canonical ids seen in the run. */
  vulnIds: string[];
}

const maxIso = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) ? b : a);

const same = (a: VmFinding, b: VmFinding): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Applies one run to the tenant's findings. Returns new objects only; the inputs are never mutated. */
export function applyRun(input: ApplyRunInput): ApplyRunResult {
  const { tenantId, run, existing, sightedBySource, kev, sla, newId } = input;
  const received = run.receivedAt;
  const result: ApplyRunResult = { created: [], updated: [], resolved: [], sightings: [], vulnIds: [] };

  const byKey = new Map<string, VmFinding>();
  for (const f of existing) byKey.set(`${f.assetId}\u0000${f.vulnId}`, f);

  const vulnIds = new Set<string>();
  const sightedIds = new Set<string>();
  const reportedAssets = new Set<string>();

  for (const { assetId, host } of input.hosts) {
    reportedAssets.add(assetId);
    for (const nf of host.findings) {
      vulnIds.add(nf.vulnId);
      const pkg = [...nf.packages].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.version < y.version ? -1 : x.version > y.version ? 1 : 0))[0];
      const pkgFields = {
        packageName: pkg ? pkg.name : '',
        packageVersion: pkg ? pkg.version : '',
        fixedVersion: pkg ? pkg.fixedVersion : null,
      };
      const isKev = kev.has(nf.vulnId);
      const prev = byKey.get(`${assetId}\u0000${nf.vulnId}`);

      let finding: VmFinding | null = null;
      if (!prev) {
        const firstSeenAt = firstSeenFor(nf.detectedAt, received, nf.publishedAt);
        finding = {
          id: newId(),
          tenantId,
          assetId,
          vulnId: nf.vulnId,
          status: 'OPEN',
          severity: nf.severity,
          firstSeenAt,
          lastSeenAt: received,
          resolvedAt: null,
          resolvedRunId: null,
          slaDueAt: slaDueAt(firstSeenAt, nf.severity, isKev, sla),
          ...pkgFields,
          justification: null,
          decidedBy: null,
          decidedByUserId: null,
          decidedAt: null,
        };
        result.created.push(finding);
      } else if (prev.status === 'OPEN') {
        const next: VmFinding = { ...prev, lastSeenAt: maxIso(prev.lastSeenAt, received) };
        if (Date.parse(received) >= Date.parse(prev.lastSeenAt)) {
          next.severity = worstSeverity(prev.severity, nf.severity);
          Object.assign(next, pkgFields);
          next.slaDueAt = slaDueAt(prev.firstSeenAt, next.severity, isKev, sla);
        }
        finding = next;
        if (!same(prev, next)) result.updated.push(next);
      } else if (prev.status === 'RESOLVED') {
        const outOfOrder = prev.resolvedAt !== null && Date.parse(prev.resolvedAt) > Date.parse(received);
        finding = prev;
        if (!outOfOrder) {
          const firstSeenAt = firstSeenFor(nf.detectedAt, received, nf.publishedAt, prev.resolvedAt);
          const next: VmFinding = {
            ...prev,
            status: 'OPEN',
            firstSeenAt,
            lastSeenAt: received,
            resolvedAt: null,
            resolvedRunId: null,
            severity: nf.severity,
            ...pkgFields,
            slaDueAt: slaDueAt(firstSeenAt, nf.severity, isKev, sla),
          };
          finding = next;
          result.updated.push(next);
        }
      } else {
        // RISK_ACCEPTED / FALSE_POSITIVE: a person decided; only the last-seen time follows the scanner.
        const next: VmFinding = { ...prev, lastSeenAt: maxIso(prev.lastSeenAt, received) };
        finding = prev;
        if (!same(prev, next)) {
          finding = next;
          result.updated.push(next);
        }
      }

      sightedIds.add(finding.id);
      result.sightings.push({
        findingId: finding.id,
        runId: run.id,
        sourceId: run.sourceId,
        reportedSeverity: nf.severity,
        reportedAt: run.collectedAt ?? run.receivedAt,
        detail: {
          vulnId: nf.vulnId,
          title: nf.title,
          cvssV3: nf.cvssV3,
          detectedAt: nf.detectedAt,
          publishedAt: nf.publishedAt,
          refs: nf.refs,
          reportedSeverities: nf.reportedSeverities,
          packages: nf.packages,
          host: {
            agentId: host.agentId,
            hostname: host.hostname,
            ip: host.ip,
            mac: host.mac,
            osName: host.osName,
            osVersion: host.osVersion,
          },
        },
      });
    }
  }

  // Closure: this source reported the asset, and no longer reports a finding it once did.
  for (const f of existing) {
    if (f.status !== 'OPEN') continue;
    if (!reportedAssets.has(f.assetId)) continue;
    if (sightedIds.has(f.id)) continue;
    if (!sightedBySource.has(f.id)) continue;
    if (Date.parse(f.lastSeenAt) > Date.parse(received)) continue;
    result.resolved.push({ ...f, status: 'RESOLVED', resolvedAt: received, resolvedRunId: run.id });
  }

  result.vulnIds = [...vulnIds].sort();
  return result;
}

/** The findings after the run: updated and resolved ones replaced by id, created ones appended. */
export function foldRun(existing: VmFinding[], result: ApplyRunResult): VmFinding[] {
  const replace = new Map<string, VmFinding>();
  for (const f of result.updated) replace.set(f.id, f);
  for (const f of result.resolved) replace.set(f.id, f);
  return [...existing.map((f) => replace.get(f.id) ?? f), ...result.created];
}

export const VM_POAM_CONTROL_ID = 'RA.L2-3.11.3';
export const VM_WORKER_ACTOR = 'system:vm-worker';

export interface PoamCandidate {
  finding: VmFinding;
  assetName: string;
  kev: boolean;
}

export interface LinkedPoamItem {
  findingId: string;
  status: VmPoamStatus;
  createdAt: string;
}

export interface PoamDraft {
  findingId: string;
  controlId: 'RA.L2-3.11.3';
  weakness: string;
  mitigation: '';
  owner: '';
  scheduledCompletion: null;
  status: 'OPEN';
  createdBy: 'system:vm-worker';
}

export function poamWeakness(c: PoamCandidate): string {
  const f = c.finding;
  const first = f.firstSeenAt.slice(0, 10);
  const due = (f.slaDueAt ?? '').slice(0, 10);
  return `${f.vulnId} on ${c.assetName}: ${f.severity} severity${c.kev ? ', known exploited (CISA KEV)' : ''}, first seen ${first}, remediation due ${due} (overdue).`;
}

/**
 * One POA&M item per open episode of an overdue finding. A linked item blocks a new one while it is OPEN or IN_PROGRESS, or when
 * it was created at or after the finding's current first_seen_at (the same episode). A finding that was closed, reopened and
 * went overdue again gets a new item.
 */
export function planPoamItems(candidates: PoamCandidate[], linked: LinkedPoamItem[], now: string): PoamDraft[] {
  const nowMs = Date.parse(now);
  const drafts: PoamDraft[] = [];
  for (const c of candidates) {
    const f = c.finding;
    if (f.status !== 'OPEN' || f.slaDueAt === null) continue;
    if (!(Date.parse(f.slaDueAt) < nowMs)) continue;
    const blocked = linked.some(
      (l) =>
        l.findingId === f.id &&
        (l.status === 'OPEN' || l.status === 'IN_PROGRESS' || Date.parse(l.createdAt) >= Date.parse(f.firstSeenAt)),
    );
    if (blocked) continue;
    drafts.push({
      findingId: f.id,
      controlId: VM_POAM_CONTROL_ID,
      weakness: poamWeakness(c),
      mitigation: '',
      owner: '',
      scheduledCompletion: null,
      status: 'OPEN',
      createdBy: VM_WORKER_ACTOR,
    });
  }
  return drafts;
}

/** Runs a restart left behind: RECEIVED or NORMALIZING for longer than staleAfterMs and not being processed now. Oldest first. */
export function staleRunsToRecover(
  runs: VmRun[],
  nowMs: number,
  isActive: (id: string) => boolean,
  staleAfterMs = 2 * 60 * 1000,
): VmRun[] {
  return runs
    .filter((r) => {
      if (isActive(r.id)) return false;
      if (r.status === 'RECEIVED') return Date.parse(r.receivedAt) < nowMs - staleAfterMs;
      if (r.status === 'NORMALIZING') return Date.parse(r.startedAt ?? r.receivedAt) < nowMs - staleAfterMs;
      return false;
    })
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}
