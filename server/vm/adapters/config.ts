import type { IngestPayload } from '../ingestSchema';
import { VM_CONFIG_RESULTS, type VmConfigResult, type VmConfigSeverity } from '../../../src/types/vm';

/**
 * Configuration adapter: turns the `configuration` lists of a validated ingest payload into one record per scan, keyed by the
 * host's agent id (docs/VULNERABILITY_MANAGEMENT.md, section 5.5). Pure: no database, no filesystem.
 */

export interface NormalizedRuleResult {
  ruleId: string;
  cce: string | null;
  result: VmConfigResult;
  severity: VmConfigSeverity | null;
  title: string;
}

export interface NormalizedConfigScan {
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkTitle: string;
  profileId: string;
  profileTitle: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: string | null;
  /** ISO 8601 in UTC. */
  scannedAt: string;
  sourceSha256: string | null;
  results: NormalizedRuleResult[];
  /** Rules per result value; every value in VM_CONFIG_RESULTS is present. */
  counts: Record<VmConfigResult, number>;
}

export function emptyResultCounts(): Record<VmConfigResult, number> {
  const counts = {} as Record<VmConfigResult, number>;
  for (const r of VM_CONFIG_RESULTS) counts[r] = 0;
  return counts;
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The scans of every host that reports any, by agent id. Rules are sorted by id so a reprocessed run stores the same rows. */
export function normalizeConfiguration(payload: IngestPayload): Map<string, NormalizedConfigScan[]> {
  const out = new Map<string, NormalizedConfigScan[]>();
  for (const host of payload.hosts) {
    if (!host.configuration || host.configuration.length === 0) continue;
    const scans: NormalizedConfigScan[] = host.configuration.map((scan) => {
      const counts = emptyResultCounts();
      const results: NormalizedRuleResult[] = scan.results.map((r) => {
        counts[r.result] += 1;
        return { ruleId: r.rule_id, cce: r.cce ?? null, result: r.result, severity: r.severity ?? null, title: r.title ?? '' };
      });
      results.sort((a, b) => cmp(a.ruleId, b.ruleId));
      return {
        benchmarkId: scan.benchmark.id,
        benchmarkVersion: scan.benchmark.version ?? '',
        benchmarkTitle: scan.benchmark.title ?? '',
        profileId: scan.profile?.id ?? '',
        profileTitle: scan.profile?.title ?? '',
        scannerName: scan.scanner.name,
        scannerVersion: scan.scanner.version ?? '',
        startedAt: iso(scan.started_at),
        scannedAt: iso(scan.scanned_at) as string,
        sourceSha256: scan.source_sha256 ?? null,
        results,
        counts,
      };
    });
    out.set(host.agent_id, scans);
  }
  return out;
}
