import { errorMessage } from '../../src/utils/errors';
import { enumerateSchedulerSources, setSourceStaleSince } from './store';
import type { SchedulerSourceRow } from './store';
import { latestSnapshotAt, runVmSnapshot } from './snapshotWriter';
import { getVmSnapshotConfig, planStalenessChanges, snapshotDue } from './snapshot';

/**
 * The in-process scheduler of the vulnerability management module (docs/VULNERABILITY_MANAGEMENT.md, sections 2.2 and 7).
 * One tick lists every tenant's sources (the only cross-tenant read, see enumerateSchedulerSources), then for each tenant,
 * under that tenant's own context: records which sources went stale (or recovered) and writes the tenant's snapshot when the
 * latest one is old enough. Nothing leaves the process; there is no immediate tick at boot, and the timer never keeps the
 * process alive.
 */

export interface VmSchedulerTickResult {
  skipped: boolean;
  tenants: number;
  staleSet: number;
  staleCleared: number;
  snapshots: string[];
  errors: number;
}

const emptyResult = (skipped: boolean): VmSchedulerTickResult => ({ skipped, tenants: 0, staleSet: 0, staleCleared: 0, snapshots: [], errors: 0 });

let ticking = false;

/** One tick. Never throws; a tick already running makes this one return `skipped`. */
export async function runVmSchedulerTick(opts: { now?: Date; onlyTenantIds?: string[] } = {}): Promise<VmSchedulerTickResult> {
  // Synchronous on purpose: two calls in the same turn must not both pass.
  if (ticking) return emptyResult(true);
  ticking = true;
  const result = emptyResult(false);
  try {
    const now = opts.now ?? new Date();
    const cfg = getVmSnapshotConfig();
    const only = opts.onlyTenantIds ? new Set(opts.onlyTenantIds) : null;
    const byTenant = new Map<string, SchedulerSourceRow[]>();
    try {
      for (const row of await enumerateSchedulerSources()) {
        if (only && !only.has(row.tenantId)) continue;
        const list = byTenant.get(row.tenantId);
        if (list) list.push(row);
        else byTenant.set(row.tenantId, [row]);
      }
    } catch (err: unknown) {
      console.error('[VM Scheduler] could not list the sources:', errorMessage(err));
      result.errors += 1;
      return result;
    }

    for (const [tenantId, rows] of byTenant) {
      result.tenants += 1;
      try {
        for (const change of planStalenessChanges(rows, now.getTime())) {
          const changed = await setSourceStaleSince(change.tenantId, change.sourceId, change.staleSince, change.lastRunAt);
          if (!changed) continue;
          if (change.staleSince === null) result.staleCleared += 1;
          else result.staleSet += 1;
        }
        if (snapshotDue(await latestSnapshotAt(tenantId), now.getTime(), cfg.snapshotIntervalHours)) {
          await runVmSnapshot(tenantId, { now, trigger: 'scheduler' });
          result.snapshots.push(tenantId);
        }
      } catch (err: unknown) {
        console.error('[VM Scheduler] tenant ' + tenantId + ':', errorMessage(err));
        result.errors += 1;
      }
    }
    return result;
  } finally {
    ticking = false;
  }
}

export const __runVmSchedulerTickForTests = runVmSchedulerTick;

let timer: NodeJS.Timeout | null = null;

/** Starts the interval. Returns the effective settings, or null when it is already running. */
export function startVmScheduler(env: NodeJS.ProcessEnv = process.env): { tickMinutes: number; snapshotIntervalHours: number } | null {
  if (timer) return null;
  const cfg = getVmSnapshotConfig(env);
  timer = setInterval(() => {
    void runVmSchedulerTick().catch((err: unknown) => console.error('[VM Scheduler] tick failed:', errorMessage(err)));
  }, cfg.tickMinutes * 60_000);
  timer.unref();
  return { tickMinutes: cfg.tickMinutes, snapshotIntervalHours: cfg.snapshotIntervalHours };
}

export function stopVmScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
