import { getDbMode, pool } from '../db';
import { getLocalUserAuthState } from './localUsers';

/**
 * Server-side sessions (issue #163; NIST SP 800-171 3.1.10 / 3.1.11): one local_sessions row per signed token, keyed by the token's random
 * `sid` claim (never the token). The row lets a sign-out and an idle timeout end a session before the token expires. Memory mode
 * (DB_MODE=memory) keeps the rows in a Map. `issuedAt` / `expiresAt` are the token's `iat` / `exp` claims, in epoch SECONDS.
 */

/** A request refreshes last_seen_at in the database at most this often per session; the in-process value is always current. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
const TOUCH_MAP_LIMIT = 50_000;
const PRUNE_GRACE_MS = 24 * 3_600_000;
const SESSION_PRUNE_BATCH = 1000;

export type SessionRevokeReason = 'signed_out' | 'idle' | 'mfa_required' | 'admin';

export interface SessionRecordInput {
  sid: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  mfaVerified: boolean;
}

export interface SessionAuthState {
  tokenVersion: number;
  disabled: boolean;
  mustChangePassword: boolean;
  /** Null when there is no row for this sid (a token issued before sessions were recorded). */
  session: { lastSeenMs: number; revokedReason: string | null; mfaVerified: boolean } | null;
}

interface MemorySession {
  userId: string;
  issuedAt: number;
  expiresAt: number;
  lastSeenMs: number;
  revokedReason: string | null;
  mfaVerified: boolean;
}

const memorySessions = new Map<string, MemorySession>();
/** In-process last request time per sid and when it was last written to the database (a Map keeps insertion order: the oldest goes first). */
const touched = new Map<string, { lastSeenMs: number; lastWrittenMs: number }>();
let clock: (() => number) | null = null;
let writeCount = 0;

/** The store's notion of now (a test can move it). */
export const sessionNowMs = (): number => (clock ? clock() : Date.now());

function remember(sid: string, atMs: number): void {
  touched.delete(sid);
  touched.set(sid, { lastSeenMs: atMs, lastWrittenMs: atMs });
  while (touched.size > TOUCH_MAP_LIMIT) {
    const oldest = touched.keys().next().value;
    if (oldest === undefined) break;
    touched.delete(oldest);
  }
}

/** Records the session of a freshly signed token. Throws on a store error: sign-in fails closed. */
export async function recordSession(input: SessionRecordInput): Promise<void> {
  const now = sessionNowMs();
  if (getDbMode() === 'memory') {
    memorySessions.set(input.sid, {
      userId: input.userId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      lastSeenMs: now,
      revokedReason: null,
      mfaVerified: input.mfaVerified,
    });
    remember(input.sid, now);
    return;
  }
  await pool.query(
    'INSERT INTO local_sessions (sid, user_id, issued_at, expires_at, last_seen_at, mfa_verified) VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6)',
    [input.sid, input.userId, input.issuedAt, input.expiresAt, new Date(now), input.mfaVerified]
  );
  remember(input.sid, now);
}

/**
 * The per-request read: the account state and the session row in ONE query. Null when the account does not exist.
 * `session` is null when the sid has no row.
 */
export async function getSessionAuthState(userId: string, sid: string | undefined): Promise<SessionAuthState | null> {
  if (getDbMode() === 'memory') {
    const u = await getLocalUserAuthState(userId);
    if (!u) return null;
    const s = sid ? memorySessions.get(sid) : undefined;
    return {
      ...u,
      session: s && s.userId === userId ? { lastSeenMs: s.lastSeenMs, revokedReason: s.revokedReason, mfaVerified: s.mfaVerified } : null,
    };
  }
  const res = await pool.query(
    `SELECT u.token_version, u.disabled, u.must_change_password, s.last_seen_at, s.revoked_at, s.revoke_reason, s.mfa_verified
       FROM local_users u LEFT JOIN local_sessions s ON s.sid = $2 AND s.user_id = u.id WHERE u.id = $1`,
    [userId, sid ?? '']
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    tokenVersion: Number(row.token_version),
    disabled: Boolean(row.disabled),
    mustChangePassword: Boolean(row.must_change_password),
    session:
      row.last_seen_at === null || row.last_seen_at === undefined
        ? null
        : { lastSeenMs: new Date(row.last_seen_at as string).getTime(), revokedReason: (row.revoke_reason as string | null) ?? null, mfaVerified: Boolean(row.mfa_verified) },
  };
}

/** Adopts a validly signed token that has no row yet (issued before sessions were recorded). Never replaces an existing row, revoked or not. */
export async function adoptSession(input: SessionRecordInput): Promise<void> {
  const now = sessionNowMs();
  if (getDbMode() === 'memory') {
    if (!memorySessions.has(input.sid)) {
      memorySessions.set(input.sid, {
        userId: input.userId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        lastSeenMs: now,
        revokedReason: null,
        mfaVerified: input.mfaVerified,
      });
      remember(input.sid, now);
    }
    return;
  }
  await pool.query(
    `INSERT INTO local_sessions (sid, user_id, issued_at, expires_at, last_seen_at, mfa_verified)
     VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6) ON CONFLICT (sid) DO NOTHING`,
    [input.sid, input.userId, input.issuedAt, input.expiresAt, new Date(now), input.mfaVerified]
  );
  remember(input.sid, now);
}

/** The newest in-process last-seen time of a session, or null when this process has not seen it. */
export function getTouchedLastSeen(sid: string): number | null {
  return touched.get(sid)?.lastSeenMs ?? null;
}

/**
 * Marks the session as seen now. The in-process time always moves; the database is written only when the last write is at least
 * SESSION_TOUCH_INTERVAL_MS old, so a busy client costs one UPDATE a minute. A write failure is returned to the caller to ignore.
 */
export async function touchSession(sid: string, atMs: number = sessionNowMs()): Promise<void> {
  const entry = touched.get(sid);
  if (!entry) {
    remember(sid, atMs);
    touched.get(sid)!.lastWrittenMs = 0;
  } else {
    entry.lastSeenMs = atMs;
  }
  const e = touched.get(sid)!;
  if (atMs - e.lastWrittenMs < SESSION_TOUCH_INTERVAL_MS) return;
  e.lastWrittenMs = atMs;
  writeCount += 1;
  if (getDbMode() === 'memory') {
    const s = memorySessions.get(sid);
    if (s && s.revokedReason === null) s.lastSeenMs = atMs;
    return;
  }
  await pool.query('UPDATE local_sessions SET last_seen_at = $2 WHERE sid = $1 AND revoked_at IS NULL', [sid, new Date(atMs)]);
}

/** Ends a session. Returns the number of rows changed: 0 when it was already revoked or never existed. */
export async function revokeSession(sid: string, reason: SessionRevokeReason): Promise<number> {
  touched.delete(sid);
  if (getDbMode() === 'memory') {
    const s = memorySessions.get(sid);
    if (!s || s.revokedReason !== null) return 0;
    s.revokedReason = reason;
    return 1;
  }
  const res = await pool.query('UPDATE local_sessions SET revoked_at = NOW(), revoke_reason = $2 WHERE sid = $1 AND revoked_at IS NULL', [sid, reason]);
  return res.rowCount ?? 0;
}

/** Deletes the rows that expired more than a day ago (never before the token itself could expire), in batches. Returns how many. */
export async function pruneExpiredSessions(atMs: number = sessionNowMs(), batch: number = SESSION_PRUNE_BATCH): Promise<number> {
  const cutoffMs = atMs - PRUNE_GRACE_MS;
  if (getDbMode() === 'memory') {
    let n = 0;
    for (const [sid, s] of memorySessions) {
      if (s.expiresAt * 1000 < cutoffMs) {
        memorySessions.delete(sid);
        touched.delete(sid);
        n += 1;
      }
    }
    return n;
  }
  const size = Math.max(1, Math.floor(batch));
  let total = 0;
  for (;;) {
    const res = await pool.query('DELETE FROM local_sessions WHERE sid IN (SELECT sid FROM local_sessions WHERE expires_at < $1 LIMIT $2)', [new Date(cutoffMs), size]);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < size) return total;
  }
}

/** Memory mode: a deleted account takes its sessions with it (PostgreSQL does it with ON DELETE CASCADE). */
export function dropMemorySessionsForUser(userId: string): void {
  for (const [sid, s] of memorySessions) {
    if (s.userId === userId) {
      memorySessions.delete(sid);
      touched.delete(sid);
    }
  }
}

// ----------------------------------------------------------------------------- test hooks

export function __setSessionClockForTests(fn: (() => number) | null): void {
  clock = fn;
}
export function __resetSessionsForTests(): void {
  memorySessions.clear();
  touched.clear();
  clock = null;
  writeCount = 0;
}
export function __sessionWriteCountForTests(): number {
  return writeCount;
}
export function __sessionStateForTests(sid: string): { userId: string; revokedReason: string | null; lastSeenMs: number; mfaVerified: boolean } | null {
  const s = memorySessions.get(sid);
  return s ? { userId: s.userId, revokedReason: s.revokedReason, lastSeenMs: s.lastSeenMs, mfaVerified: s.mfaVerified } : null;
}
