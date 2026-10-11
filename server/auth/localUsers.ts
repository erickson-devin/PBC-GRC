import { pool, getDbMode } from '../db';
import { hashPassword, validateNewPassword } from './localAuth';

/** Storage for local (air-gapped) identities: PostgreSQL `local_users`, or process memory when DB_MODE=memory. */

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface LocalUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  disabled: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export class LocalUserExistsError extends Error {
  constructor(email: string) {
    super(`A local user with email ${email} already exists`);
    this.name = 'LocalUserExistsError';
  }
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const memoryUsers = new Map<string, LocalUser>(); // key: lowercased email

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function mapRow(row: Record<string, unknown>): LocalUser {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    passwordHash: row.password_hash as string,
    disabled: row.disabled as boolean,
    failedAttempts: row.failed_attempts as number,
    lockedUntil: row.locked_until ? new Date(row.locked_until as string) : null,
  };
}

type PublicLocalUser = Omit<LocalUser, 'passwordHash'>;

function withoutHash(user: LocalUser): PublicLocalUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export async function createLocalUser(input: { email: string; name: string; password: string }): Promise<PublicLocalUser> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw new Error('Invalid email address');
  const name = input.name.trim() || email.split('@')[0];
  const problem = validateNewPassword(input.password, email);
  if (problem) throw new Error(problem);
  const passwordHash = await hashPassword(input.password);

  if (getDbMode() === 'memory') {
    if (memoryUsers.has(email)) throw new LocalUserExistsError(email);
    const user: LocalUser = {
      id: `lu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      name,
      passwordHash,
      disabled: false,
      failedAttempts: 0,
      lockedUntil: null,
    };
    memoryUsers.set(email, user);
    return withoutHash(user);
  }

  try {
    const res = await pool.query(
      'INSERT INTO local_users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [email, name, passwordHash]
    );
    return withoutHash(mapRow(res.rows[0]));
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '23505') throw new LocalUserExistsError(email);
    throw err;
  }
}

export async function findLocalUserByEmail(email: string): Promise<LocalUser | null> {
  const key = normalizeEmail(email);
  if (getDbMode() === 'memory') return memoryUsers.get(key) ?? null;
  const res = await pool.query('SELECT * FROM local_users WHERE email = $1', [key]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Counts a failed attempt and locks the account for LOCKOUT_MINUTES after MAX_FAILED_ATTEMPTS in a row. */
export async function registerFailedLogin(user: LocalUser): Promise<void> {
  const attempts = user.failedAttempts + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;

  if (getDbMode() === 'memory') {
    const stored = memoryUsers.get(user.email);
    if (stored) {
      stored.failedAttempts = lockedUntil ? 0 : attempts;
      stored.lockedUntil = lockedUntil;
    }
    return;
  }
  await pool.query('UPDATE local_users SET failed_attempts = $2, locked_until = $3 WHERE id = $1', [
    user.id,
    lockedUntil ? 0 : attempts,
    lockedUntil,
  ]);
}

export async function registerSuccessfulLogin(user: LocalUser): Promise<void> {
  if (getDbMode() === 'memory') {
    const stored = memoryUsers.get(user.email);
    if (stored) {
      stored.failedAttempts = 0;
      stored.lockedUntil = null;
    }
    return;
  }
  await pool.query(
    'UPDATE local_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
    [user.id]
  );
}

/** Test hook. */
export function __resetMemoryLocalUsersForTests(): void {
  memoryUsers.clear();
}
