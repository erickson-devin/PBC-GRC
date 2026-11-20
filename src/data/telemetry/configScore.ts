/**
 * The configuration score rule (#215), shared by the asset inventory view and the server's per-asset summary so both count the same
 * way. Pure: no React, storage or console, and only type imports. Counts only: no scan titles, rule text or host data pass through here.
 */
import type { VmConfigResult, VmConfigScan } from '../../types/vm';

export function groupConfigResultCounts(counts: Partial<Record<VmConfigResult, number>>): { pass: number; fail: number; error: number; other: number } {
  const n = (k: VmConfigResult): number => counts[k] ?? 0;
  return {
    pass: n('pass') + n('fixed'),
    fail: n('fail'),
    error: n('error') + n('unknown'),
    other: n('notapplicable') + n('notchecked') + n('notselected') + n('informational'),
  };
}

/** Passing rules as a share of the passing, failing and errored ones, rounded half up; null when there are none. */
export function configScore(pass: number, fail: number, error: number): number | null {
  const denominator = pass + fail + error;
  return denominator === 0 ? null : Math.round((100 * pass) / denominator);
}

export interface ConfigScanSummary {
  lastScannedAt: string | null;
  scans: number;
  pass: number;
  fail: number;
  error: number;
  other: number;
  score: number | null;
}

/** The given scans (one asset's latest scans) summed. */
export function summarizeConfigScans(scans: ReadonlyArray<Pick<VmConfigScan, 'scannedAt' | 'resultCounts'>>): ConfigScanSummary {
  let pass = 0;
  let fail = 0;
  let error = 0;
  let other = 0;
  let lastScannedAt: string | null = null;
  for (const scan of scans) {
    const g = groupConfigResultCounts(scan.resultCounts);
    pass += g.pass;
    fail += g.fail;
    error += g.error;
    other += g.other;
    if (lastScannedAt === null || Date.parse(scan.scannedAt) > Date.parse(lastScannedAt)) lastScannedAt = scan.scannedAt;
  }
  return { lastScannedAt, scans: scans.length, pass, fail, error, other, score: configScore(pass, fail, error) };
}
