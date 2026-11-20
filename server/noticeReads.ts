import { getDbMode, pool } from './db';

/**
 * What a user has read of the release notes and the announcements (issue #260), in user_notice_reads (global, keyed by user so it follows
 * them across tenants and browsers). `ref` is a release version or an announcement id. Marking is idempotent.
 */

export type NoticeKind = 'release' | 'announcement';
export const NOTICE_KINDS: readonly NoticeKind[] = ['release', 'announcement'];
/** The shape the table's CHECK accepts for `ref`. */
export const NOTICE_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const memoryReads = new Set<string>();
const key = (userId: string, kind: NoticeKind, ref: string): string => JSON.stringify([userId, kind, ref]);

/** Test hook: nothing read. */
export function __resetNoticeReadsForTests(): void {
  memoryReads.clear();
}

export async function listReads(userId: string): Promise<{ releases: string[]; announcements: string[] }> {
  const out = { releases: [] as string[], announcements: [] as string[] };
  if (getDbMode() === 'memory') {
    for (const k of memoryReads) {
      const [u, kind, ref] = JSON.parse(k) as [string, NoticeKind, string];
      if (u !== userId) continue;
      (kind === 'release' ? out.releases : out.announcements).push(ref);
    }
    return out;
  }
  const res = await pool.query('SELECT kind, ref FROM user_notice_reads WHERE user_id = $1 ORDER BY read_at', [userId]);
  for (const r of res.rows as Array<{ kind: NoticeKind; ref: string }>) (r.kind === 'release' ? out.releases : out.announcements).push(r.ref);
  return out;
}

/** Marks one notice read for the user. Marking it again changes nothing. */
export async function markRead(userId: string, kind: NoticeKind, ref: string): Promise<void> {
  if (getDbMode() === 'memory') {
    memoryReads.add(key(userId, kind, ref));
    return;
  }
  await pool.query('INSERT INTO user_notice_reads (user_id, kind, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, kind, ref]);
}
