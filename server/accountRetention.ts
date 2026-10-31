import { pruneAccountEvents, getAccountEventRetention, type AccountEventRetention } from './auth/accountEvents';
import { pruneExpiredSessions } from './auth/sessionStore';

/**
 * Daily housekeeping for the account event log (ACCOUNT_EVENT_RETENTION_DAYS, default 1095; 0 keeps everything) and the session table
 * (rows that expired more than a day ago). Same shape as assessmentEventRetention.ts: the first sweep runs FIRST_RUN_DELAY_MS after
 * boot, then every INTERVAL_MS, the timers never keep the process alive, and a sweep never throws or logs anything but counts and
 * SQLSTATE codes. The session sweep runs whatever the event retention is set to.
 */

export const FIRST_RUN_DELAY_MS = 10 * 60_000;
export const INTERVAL_MS = 24 * 3_600_000;

const sqlState = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

/** One sweep of both tables. Never throws. */
export async function sweepAccountData(retentionDays: number): Promise<void> {
  try {
    const sessions = await pruneExpiredSessions();
    if (sessions > 0) console.log(`[Retention] local_sessions: deleted ${sessions} expired row(s)`);
  } catch (err: unknown) {
    console.error(`[Retention] session sweep failed (code ${sqlState(err)})`);
  }
  if (retentionDays > 0) await pruneAccountEvents({ days: retentionDays });
}

let started = false;
let firstRun: NodeJS.Timeout | null = null;
let interval: NodeJS.Timeout | null = null;

/** Schedules the sweeps. Returns the effective event retention (for the startup log), or null when already started. */
export function startAccountRetention(env: NodeJS.ProcessEnv = process.env): AccountEventRetention | null {
  if (started) return null;
  started = true;
  const cfg = getAccountEventRetention(env);
  const sweep = (): void => {
    void sweepAccountData(cfg.days).catch(() => console.error('[Retention] account sweep failed'));
  };
  firstRun = setTimeout(sweep, FIRST_RUN_DELAY_MS);
  firstRun.unref();
  interval = setInterval(sweep, INTERVAL_MS);
  interval.unref();
  return cfg;
}

export function stopAccountRetention(): void {
  if (firstRun) clearTimeout(firstRun);
  if (interval) clearInterval(interval);
  firstRun = null;
  interval = null;
  started = false;
}
