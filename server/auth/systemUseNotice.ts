import { getDbMode, pool } from '../db';
import { recordAccountEvent } from './accountEvents';
import { accountLogRef } from './loginThrottle';
import { DEFAULT_SYSTEM_USE_NOTICE, SYSTEM_USE_NOTICE_MAX, noticeTextProblem, normalizeNoticeText } from '../../src/data/systemUseNotice';

/**
 * The system use notification (issue #256): one platform-wide notice shown before sign-in, stored in platform_system_use_notice
 * (a single row, id = 1, like platform_setup). Off until a platform administrator saves it (no row: disabled, version 0, default text).
 * `version` counts saves. While the notice is enabled, /auth/login and /auth/register-with-invite refuse a request that does not
 * carry the current version as `systemUseAck`, before any account lookup. The text is never logged; events carry only the version.
 */

export { DEFAULT_SYSTEM_USE_NOTICE, SYSTEM_USE_NOTICE_MAX };

export interface StoredSystemUseNotice {
  enabled: boolean;
  text: string;
  version: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

const NO_ROW: StoredSystemUseNotice = { enabled: false, text: DEFAULT_SYSTEM_USE_NOTICE, version: 0, updatedAt: null, updatedByUserId: null };

let memoryNotice: StoredSystemUseNotice | null = null;

/** Test hook: back to "never saved". */
export function __resetSystemUseNoticeForTests(): void {
  memoryNotice = null;
}

export async function getSystemUseNotice(): Promise<StoredSystemUseNotice> {
  if (getDbMode() === 'memory') return memoryNotice ? { ...memoryNotice } : { ...NO_ROW };
  const res = await pool.query('SELECT enabled, notice_text, version, updated_at, updated_by_user_id FROM platform_system_use_notice WHERE id = 1');
  if ((res.rowCount ?? 0) === 0) return { ...NO_ROW };
  return rowToNotice(res.rows[0]);
}

function rowToNotice(r: Record<string, unknown>): StoredSystemUseNotice {
  return {
    enabled: r.enabled === true,
    text: String(r.notice_text),
    version: Number(r.version),
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    updatedByUserId: (r.updated_by_user_id as string | null) ?? null,
  };
}

export type SystemUseNoticeInput = { enabled: boolean; text: string };

/** The body of a save: `enabled` a boolean, `text` a string of 1 to 4000 characters (after trimming) without control characters. Null when invalid. */
export function validateSystemUseNoticeInput(body: unknown): SystemUseNoticeInput | null {
  if (!body || typeof body !== 'object') return null;
  const { enabled, text } = body as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || typeof text !== 'string') return null;
  if (noticeTextProblem(text) !== null) return null;
  return { enabled, text: normalizeNoticeText(text) };
}

/** Saves the notice and bumps its version. In PostgreSQL the row and the account event share one transaction. */
export async function saveSystemUseNotice(input: SystemUseNoticeInput, actor: { id: string; email?: string }): Promise<StoredSystemUseNotice> {
  let saved: StoredSystemUseNotice;
  if (getDbMode() === 'memory') {
    const version = (memoryNotice?.version ?? 0) + 1;
    saved = { enabled: input.enabled, text: input.text, version, updatedAt: new Date().toISOString(), updatedByUserId: actor.id };
    await recordAccountEvent({ actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'system_use_notice_updated', details: { noticeVersion: String(version), noticeEnabled: input.enabled } });
    memoryNotice = saved;
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO platform_system_use_notice (id, enabled, notice_text, version, updated_at, updated_by_user_id)
         VALUES (1, $1::boolean, $2::text, 1, NOW(), $3::varchar)
         ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, notice_text = EXCLUDED.notice_text,
           version = platform_system_use_notice.version + 1, updated_at = NOW(), updated_by_user_id = EXCLUDED.updated_by_user_id
         RETURNING enabled, notice_text, version, updated_at, updated_by_user_id`,
        [input.enabled, input.text, actor.id]
      );
      saved = rowToNotice(res.rows[0]);
      await recordAccountEvent(
        { actorKind: 'admin', actorUserId: actor.id, targetUserId: actor.id, action: 'system_use_notice_updated', details: { noticeVersion: String(saved.version), noticeEnabled: input.enabled } },
        client
      );
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`[SystemUse] notice saved: version ${saved.version}, enabled ${saved.enabled} by account ${actor.email ? accountLogRef(actor.email) : actor.id}`);
  return saved;
}

const ACK_REQUIRED = { error: 'Acknowledge the system use notice to sign in', reason: 'system_use_ack_required' } as const;
const NOTICE_CHANGED = { error: 'The system use notice has changed. Read it again.', reason: 'system_use_notice_changed' } as const;

export type SystemUseAckCheck = { ok: true; version: number | null } | { ok: false; status: 400 | 409; body: { error: string; reason: string } };

/**
 * Checks the `systemUseAck` of a sign-in or registration request. Disabled notice: ok, nothing to record (`version: null`).
 * Enabled: the ack must be the current version (400 when missing or not an integer, 409 when stale).
 */
export async function checkSystemUseAck(ack: unknown): Promise<SystemUseAckCheck> {
  const notice = await getSystemUseNotice();
  if (!notice.enabled) return { ok: true, version: null };
  if (typeof ack !== 'number' || !Number.isInteger(ack)) return { ok: false, status: 400, body: { ...ACK_REQUIRED } };
  if (ack !== notice.version) return { ok: false, status: 409, body: { ...NOTICE_CHANGED } };
  return { ok: true, version: notice.version };
}
