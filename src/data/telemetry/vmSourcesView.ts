import type { VmRun, VmSource } from '../../types/vm';

/**
 * Connected scanners (field test 0.3.1): the pure status of one VM source for the ConnectedScannersPanel. Type imports only: no react,
 * no storage, no logging. The run error shown is the server's own fixed text for a failed run; a payload is never shown.
 */

export type SourceState = 'never' | 'ok' | 'stale' | 'failed';

export const DEFAULT_EXPECTED_INTERVAL_MINUTES = 1440;

export interface SourceStatus {
  state: SourceState;
  /** When the newest run was received (ISO), or null when the source has never pushed. */
  lastPushAt: string | null;
  counts: { hosts: number; findings: number; configResults: number } | null;
  exporterVersion: string | null;
  error: string | null;
  warning: string | null;
}

export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  never: 'Never pushed',
  ok: 'OK',
  stale: 'Stale',
  failed: 'Failed',
};

type SourceFields = Pick<VmSource, 'lastRunAt' | 'lastNormalizedAt' | 'staleSince'>;
type RunFields = Pick<VmRun, 'status' | 'error' | 'warning' | 'hostCount' | 'findingCount' | 'configResultCount' | 'exporterVersion'>;

/**
 * never: the source has no run. failed: its newest run FAILED. stale: the newest NORMALIZED run (else the newest run) is older than the
 * expected interval, or the server marked it stale. Otherwise ok. `latestRun` is the newest run of this source, or null when unknown.
 */
export function sourceStatus(
  source: SourceFields,
  latestRun: RunFields | null,
  now: number,
  expectedIntervalMinutes: number = DEFAULT_EXPECTED_INTERVAL_MINUTES,
): SourceStatus {
  const status: SourceStatus = {
    state: 'ok',
    lastPushAt: source.lastRunAt,
    counts: latestRun ? { hosts: latestRun.hostCount, findings: latestRun.findingCount, configResults: latestRun.configResultCount } : null,
    exporterVersion: latestRun?.exporterVersion || null,
    error: latestRun?.status === 'FAILED' ? latestRun.error || null : null,
    warning: latestRun?.warning || null,
  };
  if (!source.lastRunAt) return { ...status, state: 'never' };
  if (latestRun?.status === 'FAILED') return { ...status, state: 'failed' };
  const reference = Date.parse(source.lastNormalizedAt ?? source.lastRunAt ?? '');
  const interval = Number.isFinite(expectedIntervalMinutes) && expectedIntervalMinutes > 0 ? expectedIntervalMinutes : DEFAULT_EXPECTED_INTERVAL_MINUTES;
  if (source.staleSince || (Number.isFinite(reference) && now - reference > interval * 60_000)) return { ...status, state: 'stale' };
  return status;
}

/** The newest run of each source, from a list of runs (any order). */
export function latestRunBySource<T extends Pick<VmRun, 'sourceId' | 'receivedAt'>>(runs: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const run of runs) {
    const seen = latest.get(run.sourceId);
    if (!seen || Date.parse(run.receivedAt) > Date.parse(seen.receivedAt)) latest.set(run.sourceId, run);
  }
  return latest;
}

export const CONNECTED_SCANNERS_COPY = {
  heading: 'Connected scanners',
  loading: 'Loading scanners…',
  loadError: 'The scanners could not be loaded.',
  empty: 'No scanner has pushed yet. Set up the exporter below.',
  never: 'Never',
  retry: 'Retry',
} as const;
