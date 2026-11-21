import crypto from 'crypto';
import { getDbMode, pool } from './db';
import { recordAccountEvent } from './auth/accountEvents';
import { accountLogRef } from './auth/loginThrottle';
import { noticeTextProblem, normalizeNoticeText } from '../src/data/systemUseNotice';

/**
 * Platform announcements (issue #260): short messages a platform administrator posts to every user of every tenant, stored in
 * platform_announcements (global, no row security, like platform_system_use_notice). At most MAX_ACTIVE are active at once (not
 * withdrawn and not expired); a withdrawn row is kept. The title and body are never logged and never put in an account event: events
 * carry the announcement id only. The client renders both as plain text.
 */

export const ANNOUNCEMENT_LIMITS = { titleMax: 120, bodyMax: 2000, maxActive: 5, maxExpiryDays: 365 } as const;
export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  createdAt: string;
  expiresAt: string | null;
  createdByUserId: string;
  withdrawnAt: string | null;
  withdrawnByUserId: string | null;
}

export type AnnouncementInput = { title: string; body: string; severity: AnnouncementSeverity; expiresAt: string | null };
export type AnnouncementValidation = { ok: true; input: AnnouncementInput } | { ok: false; field: 'title' | 'body' | 'severity' | 'expiresAt' };

export class TooManyActiveError extends Error {
  constructor() {
    super(`At most ${ANNOUNCEMENT_LIMITS.maxActive} announcements can be active at once`);
    this.name = 'TooManyActiveError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

let clock: (() => number) | null = null;
const nowMs = (): number => (clock ? clock() : Date.now());
const memoryAnnouncements: Announcement[] = [];

/** Test hook: the time the announcement rules use (visibility, expiry, the 365-day limit). Null restores the real clock. */
export function __setAnnouncementClockForTests(fn: (() => number) | null): void {
  clock = fn;
}

/** Test hook: no announcements and the real clock. */
export function __resetAnnouncementsForTests(): void {
  memoryAnnouncements.length = 0;
  clock = null;
}

/**
 * The body of a post. title: 1 to 120 characters on one line. body: 1 to 2000 characters (line breaks allowed). severity: optional,
 * 'info' (default) or 'warning'. expiresAt: optional ISO time in the future and at most 365 days away. Names the first bad field.
 */
export function validateAnnouncementInput(body: unknown, atMs: number = nowMs()): AnnouncementValidation {
  if (!body || typeof body !== 'object') return { ok: false, field: 'title' };
  const { title, body: text, severity, expiresAt } = body as Record<string, unknown>;
  if (typeof title !== 'string' || noticeTextProblem(title) !== null) return { ok: false, field: 'title' };
  const cleanTitle = normalizeNoticeText(title);
  if (cleanTitle.length > ANNOUNCEMENT_LIMITS.titleMax || cleanTitle.includes('\n')) return { ok: false, field: 'title' };
  if (typeof text !== 'string' || noticeTextProblem(text) !== null) return { ok: false, field: 'body' };
  const cleanBody = normalizeNoticeText(text);
  if (cleanBody.length > ANNOUNCEMENT_LIMITS.bodyMax) return { ok: false, field: 'body' };
  let sev: AnnouncementSeverity = 'info';
  if (severity !== undefined && severity !== null) {
    if (severity !== 'info' && severity !== 'warning') return { ok: false, field: 'severity' };
    sev = severity;
  }
  let expires: string | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== 'string' || expiresAt.length > 40) return { ok: false, field: 'expiresAt' };
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms) || ms <= atMs || ms > atMs + ANNOUNCEMENT_LIMITS.maxExpiryDays * DAY_MS) return { ok: false, field: 'expiresAt' };
    expires = new Date(ms).toISOString();
  }
  return { ok: true, input: { title: cleanTitle, body: cleanBody, severity: sev, expiresAt: expires } };
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function rowToAnnouncement(r: Record<string, unknown>): Announcement {
  return {
    id: String(r.id),
    title: String(r.title),
    body: String(r.body),
    severity: r.severity === 'warning' ? 'warning' : 'info',
    createdAt: new Date(r.created_at as string).toISOString(),
    expiresAt: iso(r.expires_at),
    createdByUserId: String(r.created_by_user_id),
    withdrawnAt: iso(r.withdrawn_at),
    withdrawnByUserId: (r.withdrawn_by_user_id as string | null) ?? null,
  };
}

const COLUMNS = 'id, title, body, severity, expires_at, created_by_user_id, created_at, withdrawn_at, withdrawn_by_user_id';
const isActive = (a: Announcement, atMs: number): boolean => a.withdrawnAt === null && (a.expiresAt === null || Date.parse(a.expiresAt) > atMs);
const newestFirst = (a: Announcement, b: Announcement): number => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1);

/** The announcements every user sees now: not withdrawn, not expired, newest first, at most 5. */
export async function listVisibleAnnouncements(atMs: number = nowMs()): Promise<Announcement[]> {
  if (getDbMode() === 'memory') {
    return memoryAnnouncements
      .filter((a) => isActive(a, atMs))
      .sort(newestFirst)
      .slice(0, ANNOUNCEMENT_LIMITS.maxActive)
      .map((a) => ({ ...a }));
  }
  const res = await pool.query(
    `SELECT ${COLUMNS} FROM platform_announcements WHERE withdrawn_at IS NULL AND (expires_at IS NULL OR expires_at > $1::timestamptz) ORDER BY created_at DESC, id DESC LIMIT ${ANNOUNCEMENT_LIMITS.maxActive}`,
    [new Date(atMs).toISOString()]
  );
  return res.rows.map(rowToAnnouncement);
}

/** Every announcement, withdrawn and expired ones included, newest first (the administrator's list). */
export async function listAllAnnouncements(): Promise<Announcement[]> {
  if (getDbMode() === 'memory') return [...memoryAnnouncements].sort(newestFirst).map((a) => ({ ...a }));
  const res = await pool.query(`SELECT ${COLUMNS} FROM platform_announcements ORDER BY created_at DESC, id DESC`);
  return res.rows.map(rowToAnnouncement);
}

/** One announcement by id, or null. */
export async function getAnnouncement(id: string): Promise<Announcement | null> {
  if (getDbMode() === 'memory') {
    const found = memoryAnnouncements.find((a) => a.id === id);
    return found ? { ...found } : null;
  }
  const res = await pool.query(`SELECT ${COLUMNS} FROM platform_announcements WHERE id = $1`, [id.slice(0, 64)]);
  return (res.rowCount ?? 0) > 0 ? rowToAnnouncement(res.rows[0]) : null;
}

const logWho = (actor: { id: string; email?: string }): string => `account ${actor.email ? accountLogRef(actor.email) : actor.id}`;

/** Posts an announcement. Throws TooManyActiveError when 5 are already active. In PostgreSQL the row and the account event share one transaction. */
export async function postAnnouncement(input: AnnouncementInput, actor: { id: string; email?: string }): Promise<Announcement> {
  let saved: Announcement;
  if (getDbMode() === 'memory') {
    const at = nowMs();
    if (memoryAnnouncements.filter((a) => isActive(a, at)).length >= ANNOUNCEMENT_LIMITS.maxActive) throw new TooManyActiveError();
    saved = {
      id: crypto.randomUUID(),
      title: input.title,
      body: input.body,
      severity: input.severity,
      createdAt: new Date(at).toISOString(),
      expiresAt: input.expiresAt,
      createdByUserId: actor.id,
      withdrawnAt: null,
      withdrawnByUserId: null,
    };
    await recordAccountEvent({ actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'announcement_posted', details: { announcementId: saved.id } });
    memoryAnnouncements.push(saved);
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One poster at a time, so the limit of 5 holds under concurrent posts
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform_announcements'))");
      const active = await client.query('SELECT COUNT(*)::int AS n FROM platform_announcements WHERE withdrawn_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())');
      if (Number(active.rows[0].n) >= ANNOUNCEMENT_LIMITS.maxActive) throw new TooManyActiveError();
      const res = await client.query(
        `INSERT INTO platform_announcements (title, body, severity, expires_at, created_by_user_id)
         VALUES ($1::varchar, $2::text, $3::varchar, $4::timestamptz, $5::varchar) RETURNING ${COLUMNS}`,
        [input.title, input.body, input.severity, input.expiresAt, actor.id]
      );
      saved = rowToAnnouncement(res.rows[0]);
      await recordAccountEvent({ actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'announcement_posted', details: { announcementId: saved.id } }, client);
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`[Announcements] posted ${saved.id} (${saved.severity}) by ${logWho(actor)}`);
  return saved;
}

/** Withdraws an announcement. 'not_found' for an unknown id, 'already_withdrawn' when it was withdrawn before. */
export async function withdrawAnnouncement(id: string, actor: { id: string; email?: string }): Promise<Announcement | 'not_found' | 'already_withdrawn'> {
  let saved: Announcement;
  if (getDbMode() === 'memory') {
    const found = memoryAnnouncements.find((a) => a.id === id);
    if (!found) return 'not_found';
    if (found.withdrawnAt !== null) return 'already_withdrawn';
    await recordAccountEvent({ actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'announcement_withdrawn', details: { announcementId: found.id } });
    found.withdrawnAt = new Date(nowMs()).toISOString();
    found.withdrawnByUserId = actor.id;
    saved = { ...found };
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE platform_announcements SET withdrawn_at = NOW(), withdrawn_by_user_id = $2::varchar WHERE id = $1 AND withdrawn_at IS NULL RETURNING ${COLUMNS}`,
        [id.slice(0, 64), actor.id]
      );
      if ((res.rowCount ?? 0) === 0) {
        const exists = await client.query('SELECT 1 FROM platform_announcements WHERE id = $1', [id.slice(0, 64)]);
        await client.query('ROLLBACK');
        return (exists.rowCount ?? 0) > 0 ? 'already_withdrawn' : 'not_found';
      }
      saved = rowToAnnouncement(res.rows[0]);
      await recordAccountEvent({ actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'announcement_withdrawn', details: { announcementId: saved.id } }, client);
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`[Announcements] withdrawn ${saved.id} by ${logWho(actor)}`);
  return saved;
}
