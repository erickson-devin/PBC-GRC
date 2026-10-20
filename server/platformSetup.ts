import crypto from 'crypto';
import { pool, getDbMode, memoryHasTenants } from './db';
import { platformAdminEmails } from './auth/platformAdmin';

/**
 * First-time setup state and the platform-admin store.
 *
 * Platform administrators come from two places: PLATFORM_ADMIN_EMAILS (server configuration, see auth/platformAdmin.ts)
 * and the `platform_admins` table, which the first-time setup wizard writes. A fresh installation has neither, which is
 * the only state in which setup is open.
 *
 * LOCKDOWN: setup is "claimed" by inserting the single `platform_setup` row (its primary key is pinned to 1, so a
 * second INSERT can never succeed). The claim is one atomic statement, so two simultaneous requests cannot both win,
 * and nothing in the application deletes the row once setup completed: after that the endpoint refuses every request,
 * even if the administrator account is later removed. The only way to reopen it is an operator editing the database.
 */

interface MemorySetup {
  adminUserId: string;
  completedAt: string;
}
let memorySetup: MemorySetup | null = null;
const memoryAdmins = new Map<string, { userId: string; email: string }>(); // key: lowercased email

const isMemory = (): boolean => getDbMode() === 'memory';
const norm = (email: string): string => email.trim().toLowerCase();

/** True once the wizard has completed (the lock row exists). */
export async function isSetupLocked(): Promise<boolean> {
  if (isMemory()) return memorySetup !== null;
  const res = await pool.query('SELECT 1 FROM platform_setup WHERE id = 1');
  return (res.rowCount ?? 0) > 0;
}

/**
 * Does this installation still need its first administrator? False as soon as ANY administrator exists: a configured
 * one (PLATFORM_ADMIN_EMAILS), one made by the wizard, or the setup lock itself. It is also false when the database
 * already holds data from an earlier deployment (accounts or tenants), so an upgraded install never opens the wizard
 * to an anonymous caller. `tenants` is under FORCE row-level security and cannot be read without a tenant context, so
 * on PostgreSQL the signal is `local_users`, which is global (not in RLS_TENANT_TABLES); in memory mode, the tenants map.
 */
export async function isSetupRequired(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (platformAdminEmails(env).size > 0) return false;
  if (await isSetupLocked()) return false;
  if (isMemory()) return memoryAdmins.size === 0 && !memoryHasTenants();
  const admins = await pool.query('SELECT 1 FROM platform_admins LIMIT 1');
  if ((admins.rowCount ?? 0) > 0) return false;
  const users = await pool.query('SELECT 1 FROM local_users LIMIT 1');
  return (users.rowCount ?? 0) === 0;
}

/**
 * Atomically takes the one-time setup lock for `adminUserId`. Returns false when somebody else already holds it, in
 * which case nothing was changed.
 */
export async function claimSetup(adminUserId: string): Promise<boolean> {
  if (isMemory()) {
    if (memorySetup) return false;
    memorySetup = { adminUserId, completedAt: new Date().toISOString() };
    return true;
  }
  const res = await pool.query(
    'INSERT INTO platform_setup (id, admin_user_id) VALUES (1, $1) ON CONFLICT DO NOTHING RETURNING id',
    [adminUserId]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Gives the lock back. ONLY for rolling back a setup that failed before it finished. */
export async function releaseSetupClaim(): Promise<void> {
  if (isMemory()) {
    memorySetup = null;
    return;
  }
  await pool.query('DELETE FROM platform_setup WHERE id = 1');
}

export async function addPlatformAdmin(user: { userId: string; email: string }): Promise<void> {
  const email = norm(user.email);
  if (isMemory()) {
    memoryAdmins.set(email, { userId: user.userId, email });
    return;
  }
  await pool.query(
    'INSERT INTO platform_admins (user_id, email) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
    [user.userId, email]
  );
}

export async function removePlatformAdmin(userId: string): Promise<void> {
  if (isMemory()) {
    for (const [email, a] of memoryAdmins) if (a.userId === userId) memoryAdmins.delete(email);
    return;
  }
  await pool.query('DELETE FROM platform_admins WHERE user_id = $1', [userId]);
}

/** Emails of the administrators created through the wizard (not the configured ones). */
export async function listStoredPlatformAdminEmails(): Promise<string[]> {
  if (isMemory()) return [...memoryAdmins.keys()];
  const res = await pool.query('SELECT email FROM platform_admins ORDER BY created_at ASC');
  return res.rows.map((r) => r.email as string);
}

/** Is this signed-in identity a stored platform administrator? Matches on user id AND the verified email. */
export async function isStoredPlatformAdmin(user: { uid?: string; email?: string } | null | undefined): Promise<boolean> {
  const email = user?.email ? norm(user.email) : '';
  if (!user?.uid || !email) return false;
  if (isMemory()) {
    const a = memoryAdmins.get(email);
    return Boolean(a && a.userId === user.uid);
  }
  const res = await pool.query('SELECT 1 FROM platform_admins WHERE user_id = $1 AND email = $2', [user.uid, email]);
  return (res.rowCount ?? 0) > 0;
}

/** Constant-time comparison for the optional SETUP_TOKEN. */
export function setupTokenMatches(provided: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = (env.SETUP_TOKEN ?? '').trim();
  if (!expected) return true; // no token configured: setup is gated only by being first
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided.trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Test hook. */
export function __resetPlatformSetupForTests(): void {
  memorySetup = null;
  memoryAdmins.clear();
}
