import { getDbMode, pool } from './db';
import { pruneControlAssessmentEventsInScope, pruneMemoryControlAssessmentEvents } from './controlAssessments';
import { pruneMemoryObjectiveEvents, pruneObjectiveEventsInScope } from './controlObjectives';

/**
 * Retention of the control change history (control_assessment_events and control_objective_events: who, when, SHA-256 of the notes, never their text).
 * A daily in-process sweep deletes the events older than ASSESSMENT_EVENT_RETENTION_DAYS (default 1095, three years; 0 keeps everything). The sweep
 * lists every program with the SELECT-only app.event_retention policy (see DISCOVERY_POLICIES), then deletes under each program's own tenant and
 * program settings, so the row policies still confine every DELETE to one program. It never throws and never logs notes, names or error messages:
 * only counts, tenant ids and SQLSTATE codes. The first run is delayed after boot; the timers never keep the process alive.
 */

export const DEFAULT_ASSESSMENT_EVENT_RETENTION_DAYS = 1095;
/** A C3PAO assessment may look back about a year; a shorter retention only earns a warning. */
export const RECOMMENDED_MIN_DAYS = 365;
/** Rows per DELETE statement (one transaction each), so a large backlog never holds a long lock. */
export const RETENTION_BATCH = 1000;
export const FIRST_RUN_DELAY_MS = 10 * 60_000;
export const INTERVAL_MS = 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;

export interface AssessmentEventRetention {
  days: number;
  source: 'default' | 'env' | 'invalid';
  warning: string | null;
}

/** The retention setting. An unusable value keeps the history (days 0) rather than guessing: nothing is deleted on a typo. */
export function getAssessmentEventRetention(env: NodeJS.ProcessEnv = process.env): AssessmentEventRetention {
  const raw = (env.ASSESSMENT_EVENT_RETENTION_DAYS ?? '').trim();
  if (raw === '') return { days: DEFAULT_ASSESSMENT_EVENT_RETENTION_DAYS, source: 'default', warning: null };
  if (/^\d{1,5}$/.test(raw)) {
    const days = Number(raw);
    const warning = days > 0 && days < RECOMMENDED_MIN_DAYS ? 'ASSESSMENT_EVENT_RETENTION_DAYS is shorter than 365 days: a C3PAO assessment may look back further' : null;
    return { days, source: 'env', warning };
  }
  return { days: 0, source: 'invalid', warning: 'ASSESSMENT_EVENT_RETENTION_DAYS is not a whole number of days: history is kept (no deletion)' };
}

/** Events created before this instant are due for deletion; null when nothing is ever deleted (days 0). */
export function retentionCutoff(now: Date, days: number): Date | null {
  if (!(days > 0)) return null;
  return new Date(now.getTime() - days * DAY_MS);
}

export function describeRetention(cfg: AssessmentEventRetention): string {
  return cfg.days > 0
    ? `Assessment history retention: control change events older than ${cfg.days} days are deleted daily (ASSESSMENT_EVENT_RETENTION_DAYS)`
    : 'Assessment history retention: control change events are kept forever (ASSESSMENT_EVENT_RETENTION_DAYS=0)';
}

export interface PruneResult {
  skipped: boolean;
  /** control_assessment_events deleted (or, with dryRun, that would be) */
  deleted: number;
  /** control_objective_events deleted (or that would be) */
  deletedObjectives: number;
  /** programs (memory mode: scopes) that held events due for deletion, or in PostgreSQL that were swept */
  scopes: number;
  errors: number;
}

const emptyResult = (skipped: boolean): PruneResult => ({ skipped, deleted: 0, deletedObjectives: 0, scopes: 0, errors: 0 });

let running = false;

const sqlState = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

/** Every (tenant, program) pair. One transaction on the pool with the retention GUC on; the policy is SELECT-only. */
async function listProgramScopes(): Promise<{ tenantId: string; programId: string }[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.event_retention', 'on', true)");
    const res = await client.query('SELECT tenant_id, id FROM programs ORDER BY tenant_id, id');
    await client.query('COMMIT');
    return res.rows.map((r) => ({ tenantId: String(r.tenant_id), programId: String(r.id) }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** One sweep. Never throws; a sweep already running makes this one return `skipped`. Days 0 (keep forever) is skipped too. */
export async function pruneAssessmentEvents(
  opts: { now?: Date; days?: number; batchSize?: number; dryRun?: boolean; onlyTenantIds?: readonly string[] } = {}
): Promise<PruneResult> {
  // Synchronous on purpose: two calls in the same turn must not both pass.
  if (running) return emptyResult(true);
  running = true;
  const result = emptyResult(false);
  try {
    const days = opts.days ?? getAssessmentEventRetention().days;
    const cutoff = retentionCutoff(opts.now ?? new Date(), days);
    if (!cutoff) return emptyResult(true);
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? RETENTION_BATCH));
    const dryRun = opts.dryRun === true;
    const only = opts.onlyTenantIds ? new Set(opts.onlyTenantIds) : null;
    await Promise.resolve(); // yield once, so a call made in the same turn meets the flag in memory mode too (PostgreSQL awaits anyway)

    if (getDbMode() === 'memory') {
      const sweepOpts = { dryRun, onlyTenantIds: opts.onlyTenantIds };
      const a = pruneMemoryControlAssessmentEvents(cutoff, sweepOpts);
      const o = pruneMemoryObjectiveEvents(cutoff, sweepOpts);
      result.deleted = a.deleted;
      result.deletedObjectives = o.deleted;
      result.scopes = Math.max(a.scopes, o.scopes);
    } else {
      let scopes: { tenantId: string; programId: string }[] = [];
      try {
        scopes = (await listProgramScopes()).filter((s) => !only || only.has(s.tenantId));
      } catch (err: unknown) {
        console.error(`[Retention] could not list the programs (code ${sqlState(err)})`);
        result.errors += 1;
        return result;
      }
      for (const scope of scopes) {
        result.scopes += 1;
        try {
          result.deleted += await pruneControlAssessmentEventsInScope(scope, cutoff, batchSize, dryRun);
          result.deletedObjectives += await pruneObjectiveEventsInScope(scope, cutoff, batchSize, dryRun);
        } catch (err: unknown) {
          console.error(`[Retention] tenant ${scope.tenantId}: failed (code ${sqlState(err)})`);
          result.errors += 1;
        }
      }
    }

    const verb = dryRun ? 'would delete' : 'deleted';
    if (result.deleted > 0) console.log(`[Retention] control_assessment_events: ${verb} ${result.deleted} row(s) older than ${days} days in ${result.scopes} program(s)`);
    if (result.deletedObjectives > 0) console.log(`[Retention] control_objective_events: ${verb} ${result.deletedObjectives} row(s) older than ${days} days in ${result.scopes} program(s)`);
    return result;
  } catch (err: unknown) {
    console.error(`[Retention] sweep failed (code ${sqlState(err)})`);
    result.errors += 1;
    return result;
  } finally {
    running = false;
  }
}

/** queryWithProgram strips every other character from an id, so only ids that survive that are swept. */
const SCOPE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Operator only. The (tenant, program) pairs that still hold events older than the cutoff although the program is gone (the history has no
 * foreign key to programs, and the daily sweep lists programs, so it never reaches them). FORCE row security is lifted on the two event tables
 * only to find them, and the transaction always rolls back (restoring it): nothing is ever committed with FORCE off. programs is read through
 * app.event_retention. The deletes then run through the row-confined per-program functions.
 */
async function listDeletedProgramScopes(cutoff: Date): Promise<{ tenantId: string; programId: string }[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT set_config('app.event_retention', 'on', true)");
    await client.query('ALTER TABLE control_assessment_events NO FORCE ROW LEVEL SECURITY');
    await client.query('ALTER TABLE control_objective_events NO FORCE ROW LEVEL SECURITY');
    const res = await client.query(
      `SELECT DISTINCT e.tenant_id, e.program_id FROM (
         SELECT tenant_id, program_id FROM control_assessment_events WHERE program_id IS NOT NULL AND created_at < $1
         UNION SELECT tenant_id, program_id FROM control_objective_events WHERE created_at < $1) e
       WHERE NOT EXISTS (SELECT 1 FROM programs p WHERE p.tenant_id = e.tenant_id AND p.id = e.program_id)
       ORDER BY 1, 2`,
      [cutoff.toISOString()]
    );
    return res.rows.map((r) => ({ tenantId: String(r.tenant_id), programId: String(r.program_id) }));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined); // restores FORCE
    client.release();
  }
}

/**
 * Operator pass (scripts/pruneAssessmentEvents.ts --include-deleted-programs, issue #150): deletes the events older than the cutoff of programs that
 * no longer exist. Not part of the daily sweep. Same guard, cutoff, batch and dry-run handling as pruneAssessmentEvents; never throws; logs only
 * counts and SQLSTATE codes (no tenant id). Memory mode returns `skipped`: its sweep already covers deleted programs.
 */
export async function pruneDeletedProgramEvents(
  opts: { now?: Date; days?: number; batchSize?: number; dryRun?: boolean; onlyTenantIds?: readonly string[] } = {}
): Promise<PruneResult> {
  if (running) return emptyResult(true);
  running = true;
  const result = emptyResult(false);
  try {
    const days = opts.days ?? getAssessmentEventRetention().days;
    const cutoff = retentionCutoff(opts.now ?? new Date(), days);
    if (!cutoff) return emptyResult(true);
    if (getDbMode() === 'memory') return emptyResult(true);
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? RETENTION_BATCH));
    const dryRun = opts.dryRun === true;
    const only = opts.onlyTenantIds ? new Set(opts.onlyTenantIds) : null;

    let scopes: { tenantId: string; programId: string }[] = [];
    try {
      scopes = (await listDeletedProgramScopes(cutoff)).filter((s) => (!only || only.has(s.tenantId)) && SCOPE_ID.test(s.tenantId) && SCOPE_ID.test(s.programId));
    } catch (err: unknown) {
      console.error(`[Retention] deleted programs: could not list (code ${sqlState(err)})`);
      result.errors += 1;
      return result;
    }
    for (const scope of scopes) {
      result.scopes += 1;
      try {
        result.deleted += await pruneControlAssessmentEventsInScope(scope, cutoff, batchSize, dryRun);
        result.deletedObjectives += await pruneObjectiveEventsInScope(scope, cutoff, batchSize, dryRun);
      } catch (err: unknown) {
        console.error(`[Retention] a deleted program's events: failed (code ${sqlState(err)})`);
        result.errors += 1;
      }
    }
    const verb = dryRun ? 'would delete' : 'deleted';
    console.log(`[Retention] deleted programs: ${verb} ${result.deleted} control_assessment_events and ${result.deletedObjectives} control_objective_events row(s) older than ${days} days in ${result.scopes} program(s)`);
    return result;
  } catch (err: unknown) {
    console.error(`[Retention] deleted programs: sweep failed (code ${sqlState(err)})`);
    result.errors += 1;
    return result;
  } finally {
    running = false;
  }
}

let started = false;
let firstRun: NodeJS.Timeout | null = null;
let interval: NodeJS.Timeout | null = null;

/**
 * Schedules the sweep: the first one FIRST_RUN_DELAY_MS after boot, then every INTERVAL_MS. Returns the effective setting, or null when already
 * started. With days 0 (keep forever, or an unusable value) nothing is scheduled but the setting is still returned for the startup log.
 */
export function startAssessmentEventRetention(env: NodeJS.ProcessEnv = process.env): AssessmentEventRetention | null {
  if (started) return null;
  started = true;
  const cfg = getAssessmentEventRetention(env);
  if (cfg.days > 0) {
    const sweep = (): void => {
      void pruneAssessmentEvents({ days: cfg.days }).catch(() => console.error('[Retention] sweep failed'));
    };
    firstRun = setTimeout(sweep, FIRST_RUN_DELAY_MS);
    firstRun.unref();
    interval = setInterval(sweep, INTERVAL_MS);
    interval.unref();
  }
  return cfg;
}

export function stopAssessmentEventRetention(): void {
  if (firstRun) clearTimeout(firstRun);
  if (interval) clearInterval(interval);
  firstRun = null;
  interval = null;
  started = false;
}
