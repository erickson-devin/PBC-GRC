import type { PoolClient } from 'pg';
import { getDbMode, pool } from '../db';

/**
 * Account event log (issue #40): an append-only trail of security-relevant changes to local accounts, in local_account_events.
 * Who (an id or a kind, never a name or an email), what (a closed list of actions), when, and ids and codes as details.
 * Writes made by a local_users mutation go in the SAME transaction as the change (pass the transaction's client); writes made
 * after a tenant membership change are best effort (callers log `[AccountEvents] write failed (code ...)` and carry on).
 * Memory mode (DB_MODE=memory) keeps the events in an array. The table is guarded against UPDATE, DELETE and TRUNCATE in
 * PostgreSQL (see schema.ts); only the retention sweep below may delete.
 */

export const ACCOUNT_EVENT_ACTIONS = [
  'password_changed',
  'password_reset',
  'mfa_enrolled',
  'mfa_reset',
  'recovery_codes_regenerated',
  'account_disabled',
  'account_enabled',
  'role_changed',
  'member_removed',
  'signed_out',
  'session_revoked',
  'step_up_failed',
] as const;
export type AccountEventAction = (typeof ACCOUNT_EVENT_ACTIONS)[number];

export type AccountEventActorKind = 'user' | 'admin' | 'cli' | 'system';
const ACTOR_KINDS: readonly string[] = ['user', 'admin', 'cli', 'system'];

export type AccountEventDetails = Record<string, string | boolean>;

export interface AccountEventInput {
  actorKind: AccountEventActorKind;
  actorUserId?: string | null;
  targetUserId: string;
  action: AccountEventAction;
  /** The tenant a role change applied to; global events leave it out. */
  scopeTenantId?: string | null;
  details?: AccountEventDetails;
}

export interface AccountEventRow {
  id: string;
  at: string;
  actorKind: AccountEventActorKind;
  actorUserId: string | null;
  targetUserId: string;
  action: AccountEventAction;
  tenantId: string | null;
  details: AccountEventDetails;
}

export class AccountEventDetailsError extends Error {
  constructor() {
    super('Account event details accept ids and codes only');
    this.name = 'AccountEventDetailsError';
  }
}

const DETAIL_KEYS: readonly string[] = ['reason', 'via', 'previousRole', 'newRole', 'attempted', 'mustChangePassword'];
const DETAIL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Only the listed keys, with booleans or short code-like strings: never free text, an email address or a name. */
export function sanitizeAccountEventDetails(details: unknown): AccountEventDetails {
  if (details === undefined || details === null) return {};
  if (typeof details !== 'object' || Array.isArray(details)) throw new AccountEventDetailsError();
  const out: AccountEventDetails = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (!DETAIL_KEYS.includes(key)) throw new AccountEventDetailsError();
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && DETAIL_VALUE.test(value)) out[key] = value;
    else throw new AccountEventDetailsError();
  }
  return out;
}

function checkInput(input: AccountEventInput): { details: AccountEventDetails; actorUserId: string | null; scopeTenantId: string | null } {
  if (!ACTOR_KINDS.includes(input.actorKind) || !(ACCOUNT_EVENT_ACTIONS as readonly string[]).includes(input.action)) throw new AccountEventDetailsError();
  const actorUserId = input.actorUserId ?? null;
  const scopeTenantId = input.scopeTenantId ?? null;
  if (!ID_PATTERN.test(input.targetUserId) || (actorUserId !== null && !ID_PATTERN.test(actorUserId)) || (scopeTenantId !== null && !ID_PATTERN.test(scopeTenantId))) {
    throw new AccountEventDetailsError();
  }
  return { details: sanitizeAccountEventDetails(input.details), actorUserId, scopeTenantId };
}

// ----------------------------------------------------------------------------- memory mode

interface MemoryEvent extends AccountEventRow {
  atMs: number;
}
const memoryEvents: MemoryEvent[] = [];
let memorySeq = 0;
let clock: (() => number) | null = null;
const nowMs = (): number => (clock ? clock() : Date.now());

const sqlState = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

/**
 * Appends one event. With a pg `client` (a transaction the caller owns) the row joins that transaction; otherwise it goes through the pool.
 * Throws on a bad input or a database error: callers decide whether that is fatal (same-transaction writes) or logged (post-commit writes).
 */
export async function recordAccountEvent(input: AccountEventInput, client?: Pick<PoolClient, 'query'>): Promise<void> {
  const { details, actorUserId, scopeTenantId } = checkInput(input);
  if (getDbMode() === 'memory') {
    const atMs = nowMs();
    memoryEvents.push({
      id: String(++memorySeq),
      at: new Date(atMs).toISOString(),
      atMs,
      actorKind: input.actorKind,
      actorUserId,
      targetUserId: input.targetUserId,
      action: input.action,
      tenantId: scopeTenantId,
      details,
    });
    return;
  }
  await (client ?? pool).query(
    'INSERT INTO local_account_events (actor_kind, actor_user_id, target_user_id, action, scope_tenant_id, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [input.actorKind, actorUserId, input.targetUserId, input.action, scopeTenantId, JSON.stringify(details)]
  );
}

/** Post-commit write: logs only the SQLSTATE code on failure and never throws. */
export async function recordAccountEventBestEffort(input: AccountEventInput): Promise<void> {
  try {
    await recordAccountEvent(input);
  } catch (err: unknown) {
    console.error(`[AccountEvents] write failed (code ${sqlState(err)})`);
  }
}

/** Newest first by id. `beforeId` (a numeric string) pages to older events. */
export async function listAccountEvents(opts: { limit?: number; beforeId?: string | null } = {}): Promise<AccountEventRow[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && /^\d{1,18}$/.test(opts.beforeId) ? opts.beforeId : null;
  if (getDbMode() === 'memory') {
    return memoryEvents
      .filter((e) => before === null || Number(e.id) < Number(before))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit)
      .map(({ atMs: _atMs, ...row }) => ({ ...row, details: { ...row.details } }));
  }
  const res = await pool.query(
    `SELECT id, at, actor_kind, actor_user_id, target_user_id, action, scope_tenant_id, details FROM local_account_events
      WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT $2`,
    [before, limit]
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    at: new Date(r.at as string).toISOString(),
    actorKind: r.actor_kind as AccountEventActorKind,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    targetUserId: r.target_user_id as string,
    action: r.action as AccountEventAction,
    tenantId: (r.scope_tenant_id as string | null) ?? null,
    details: (r.details ?? {}) as AccountEventDetails,
  }));
}

// ----------------------------------------------------------------------------- retention

export const DEFAULT_ACCOUNT_EVENT_RETENTION_DAYS = 1095;
export const ACCOUNT_EVENT_RETENTION_BATCH = 1000;
const DAY_MS = 24 * 3_600_000;

export interface AccountEventRetention {
  days: number;
  source: 'default' | 'env' | 'invalid';
  warning: string | null;
}

/** ACCOUNT_EVENT_RETENTION_DAYS: default 1095, 0 keeps everything, an unusable value keeps everything and warns. */
export function getAccountEventRetention(env: NodeJS.ProcessEnv = process.env): AccountEventRetention {
  const raw = (env.ACCOUNT_EVENT_RETENTION_DAYS ?? '').trim();
  if (raw === '') return { days: DEFAULT_ACCOUNT_EVENT_RETENTION_DAYS, source: 'default', warning: null };
  if (/^\d{1,5}$/.test(raw)) {
    const days = Number(raw);
    const warning = days > 0 && days < 365 ? 'ACCOUNT_EVENT_RETENTION_DAYS is shorter than 365 days: a C3PAO assessment may look back further' : null;
    return { days, source: 'env', warning };
  }
  return { days: 0, source: 'invalid', warning: 'ACCOUNT_EVENT_RETENTION_DAYS is not a whole number of days: account events are kept (no deletion)' };
}

export function describeAccountEventRetention(cfg: AccountEventRetention): string {
  return cfg.days > 0
    ? `Account event retention: events older than ${cfg.days} days are deleted daily (ACCOUNT_EVENT_RETENTION_DAYS)`
    : 'Account event retention: events are kept forever (ACCOUNT_EVENT_RETENTION_DAYS=0)';
}

export interface AccountEventPruneResult {
  skipped: boolean;
  /** rows deleted (or, with dryRun, that would be) */
  deleted: number;
  errors: number;
}

let pruning = false;

/**
 * Deletes the events older than `days` (default: the setting; 0 keeps everything). The DELETE runs in batches, each in its own transaction
 * with app.account_event_retention on, the only way past the append-only trigger. Never throws; logs counts and SQLSTATE codes only.
 */
export async function pruneAccountEvents(opts: { now?: Date; days?: number; batch?: number; dryRun?: boolean } = {}): Promise<AccountEventPruneResult> {
  if (pruning) return { skipped: true, deleted: 0, errors: 0 };
  pruning = true;
  const result: AccountEventPruneResult = { skipped: false, deleted: 0, errors: 0 };
  try {
    const days = opts.days ?? getAccountEventRetention().days;
    if (!(days > 0)) return { skipped: true, deleted: 0, errors: 0 };
    const cutoff = new Date((opts.now ?? new Date()).getTime() - days * DAY_MS);
    const batch = Math.max(1, Math.floor(opts.batch ?? ACCOUNT_EVENT_RETENTION_BATCH));
    const dryRun = opts.dryRun === true;
    await Promise.resolve();
    if (getDbMode() === 'memory') {
      const due = memoryEvents.filter((e) => e.atMs < cutoff.getTime());
      if (!dryRun) for (const e of due) memoryEvents.splice(memoryEvents.indexOf(e), 1);
      result.deleted = due.length;
    } else if (dryRun) {
      const res = await pool.query('SELECT COUNT(*) AS n FROM local_account_events WHERE at < $1', [cutoff.toISOString()]);
      result.deleted = Number(res.rows[0]?.n ?? 0);
    } else {
      for (;;) {
        const client = await pool.connect();
        let n = 0;
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.account_event_retention', 'on', true)");
          const res = await client.query(
            'DELETE FROM local_account_events WHERE id IN (SELECT id FROM local_account_events WHERE at < $1 ORDER BY id LIMIT $2)',
            [cutoff.toISOString(), batch]
          );
          await client.query('COMMIT');
          n = res.rowCount ?? 0;
        } catch (err: unknown) {
          await client.query('ROLLBACK').catch(() => undefined);
          console.error(`[Retention] account events: failed (code ${sqlState(err)})`);
          result.errors += 1;
          break;
        } finally {
          client.release();
        }
        result.deleted += n;
        if (n < batch) break;
      }
    }
    if (result.deleted > 0) console.log(`[Retention] local_account_events: ${dryRun ? 'would delete' : 'deleted'} ${result.deleted} row(s) older than ${days} days`);
    return result;
  } catch (err: unknown) {
    console.error(`[Retention] account events: sweep failed (code ${sqlState(err)})`);
    result.errors += 1;
    return result;
  } finally {
    pruning = false;
  }
}

// ----------------------------------------------------------------------------- test hooks

export function __setAccountEventClockForTests(fn: (() => number) | null): void {
  clock = fn;
}
export function __resetAccountEventsForTests(): void {
  memoryEvents.length = 0;
  memorySeq = 0;
  clock = null;
  pruning = false;
}
