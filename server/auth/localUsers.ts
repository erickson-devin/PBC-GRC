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
  /** Bumped on a password change, a disable and an MFA reset: sessions and pending tokens with an older value are dead. */
  tokenVersion: number;
  /** AES-256-GCM blob (see mfaCrypto). Set while enrolment is pending and after it is confirmed. */
  totpSecretEnc: string | null;
  totpConfirmedAt: Date | null;
  totpLastUsedStep: number | null;
  /** Keyed HMAC-SHA256 hex digests of the unused recovery codes. */
  recoveryCodeHashes: string[];
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export type PublicLocalUser = Omit<LocalUser, 'passwordHash' | 'totpSecretEnc' | 'recoveryCodeHashes'>;

export class LocalUserExistsError extends Error {
  constructor(email: string) {
    super(`A local user with email ${email} already exists`);
    this.name = 'LocalUserExistsError';
  }
}

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const memoryUsers = new Map<string, LocalUser>(); // key: lowercased email

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const asDate = (value: unknown): Date | null => (value ? new Date(value as string) : null);

function mapRow(row: Record<string, unknown>): LocalUser {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    passwordHash: row.password_hash as string,
    disabled: row.disabled as boolean,
    failedAttempts: row.failed_attempts as number,
    lockedUntil: asDate(row.locked_until),
    tokenVersion: Number(row.token_version ?? 0),
    totpSecretEnc: (row.totp_secret_enc as string | null) ?? null,
    totpConfirmedAt: asDate(row.totp_confirmed_at),
    // pg returns BIGINT as a string.
    totpLastUsedStep: row.totp_last_used_step === null || row.totp_last_used_step === undefined ? null : Number(row.totp_last_used_step),
    recoveryCodeHashes: (row.recovery_code_hashes as string[] | null) ?? [],
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: asDate(row.last_login_at),
    createdAt: (asDate(row.created_at) ?? new Date()),
  };
}

/** Strips everything that must never leave the server: the password hash, the encrypted TOTP secret and the recovery digests. */
export function toPublicUser(user: LocalUser): PublicLocalUser {
  const { passwordHash: _passwordHash, totpSecretEnc: _totpSecretEnc, recoveryCodeHashes: _recoveryCodeHashes, ...rest } = user;
  return rest;
}

export async function createLocalUser(
  input: { email: string; name: string; password: string },
  options: { mustChangePassword?: boolean } = {}
): Promise<PublicLocalUser> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw new Error('Invalid email address');
  const name = input.name.trim() || email.split('@')[0];
  const problem = validateNewPassword(input.password, email);
  if (problem) throw new Error(problem);
  const passwordHash = await hashPassword(input.password);
  const mustChangePassword = options.mustChangePassword === true;

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
      tokenVersion: 0,
      totpSecretEnc: null,
      totpConfirmedAt: null,
      totpLastUsedStep: null,
      recoveryCodeHashes: [],
      mustChangePassword,
      lastLoginAt: null,
      createdAt: new Date(),
    };
    memoryUsers.set(email, user);
    return toPublicUser(user);
  }

  try {
    const res = await pool.query(
      'INSERT INTO local_users (email, name, password_hash, must_change_password) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, name, passwordHash, mustChangePassword]
    );
    return toPublicUser(mapRow(res.rows[0]));
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

function memoryUserById(id: string): LocalUser | null {
  for (const u of memoryUsers.values()) if (u.id === id) return u;
  return null;
}

export async function findLocalUserById(id: string): Promise<LocalUser | null> {
  if (getDbMode() === 'memory') return memoryUserById(id);
  const res = await pool.query('SELECT * FROM local_users WHERE id = $1', [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** The two values a per-request revocation check needs (plus the forced-password-change flag). Null when there is no such account. */
export async function getLocalUserAuthState(
  id: string
): Promise<{ tokenVersion: number; disabled: boolean; mustChangePassword: boolean } | null> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(id);
    return u ? { tokenVersion: u.tokenVersion, disabled: u.disabled, mustChangePassword: u.mustChangePassword } : null;
  }
  const res = await pool.query('SELECT token_version, disabled, must_change_password FROM local_users WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? { tokenVersion: Number(row.token_version), disabled: Boolean(row.disabled), mustChangePassword: Boolean(row.must_change_password) } : null;
}

export type ListedLocalUser = PublicLocalUser & { mfaEnrolled: boolean };

export async function listLocalUsers(): Promise<ListedLocalUser[]> {
  const users: LocalUser[] =
    getDbMode() === 'memory'
      ? [...memoryUsers.values()]
      : (await pool.query('SELECT * FROM local_users ORDER BY created_at, email')).rows.map(mapRow);
  return users.map((u) => ({ ...toPublicUser(u), mfaEnrolled: u.totpConfirmedAt !== null }));
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
      stored.lastLoginAt = new Date();
    }
    return;
  }
  await pool.query(
    'UPDATE local_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
    [user.id]
  );
}

// ----------------------------------------------------------------------------- second factor

const CLEARED_FACTOR_SQL = "totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_used_step = NULL, recovery_code_hashes = '{}'";

function clearFactor(u: LocalUser): void {
  u.totpSecretEnc = null;
  u.totpConfirmedAt = null;
  u.totpLastUsedStep = null;
  u.recoveryCodeHashes = [];
}

/** Stores a pending (unconfirmed) secret. Refuses, returning false, when a factor is already confirmed or the user is unknown. */
export async function setPendingTotpSecret(userId: string, encrypted: string): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u || u.totpConfirmedAt) return false;
    u.totpSecretEnc = encrypted;
    return true;
  }
  const res = await pool.query(
    'UPDATE local_users SET totp_secret_enc = $2 WHERE id = $1 AND totp_confirmed_at IS NULL RETURNING 1',
    [userId, encrypted]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Confirms enrolment: needs a pending secret and no confirmed factor. Records the matched step (so the confirming code
 * cannot be replayed at login) and stores the recovery code digests.
 */
export async function confirmTotp(userId: string, step: number, recoveryCodeHashes: string[]): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u || !u.totpSecretEnc || u.totpConfirmedAt) return false;
    u.totpConfirmedAt = new Date();
    u.totpLastUsedStep = step;
    u.recoveryCodeHashes = [...recoveryCodeHashes];
    return true;
  }
  const res = await pool.query(
    `UPDATE local_users SET totp_confirmed_at = NOW(), totp_last_used_step = $2, recovery_code_hashes = $3
      WHERE id = $1 AND totp_secret_enc IS NOT NULL AND totp_confirmed_at IS NULL RETURNING 1`,
    [userId, step, recoveryCodeHashes]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Atomically records a used TOTP step. False when the step is not newer than the last used one (a replay) or no factor is confirmed. */
export async function consumeTotpStep(userId: string, step: number): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u || !u.totpConfirmedAt) return false;
    if (u.totpLastUsedStep !== null && u.totpLastUsedStep >= step) return false;
    u.totpLastUsedStep = step;
    return true;
  }
  const res = await pool.query(
    `UPDATE local_users SET totp_last_used_step = $2
      WHERE id = $1 AND totp_confirmed_at IS NOT NULL AND (totp_last_used_step IS NULL OR totp_last_used_step < $2) RETURNING 1`,
    [userId, step]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Replaces every recovery code digest of an ENROLLED user (regeneration). False when no factor is confirmed. */
export async function replaceRecoveryCodeHashes(userId: string, hashes: string[]): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u || !u.totpConfirmedAt) return false;
    u.recoveryCodeHashes = [...hashes];
    return true;
  }
  const res = await pool.query(
    'UPDATE local_users SET recovery_code_hashes = $2 WHERE id = $1 AND totp_confirmed_at IS NOT NULL RETURNING 1',
    [userId, hashes]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Atomically removes one recovery code digest. False when it is not in the list (unknown, or already used). */
export async function consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u) return false;
    const i = u.recoveryCodeHashes.indexOf(hash);
    if (i < 0) return false;
    u.recoveryCodeHashes.splice(i, 1);
    return true;
  }
  const res = await pool.query(
    'UPDATE local_users SET recovery_code_hashes = array_remove(recovery_code_hashes, $2) WHERE id = $1 AND $2 = ANY(recovery_code_hashes) RETURNING 1',
    [userId, hash]
  );
  return (res.rowCount ?? 0) > 0;
}

// ----------------------------------------------------------------------------- account changes

/**
 * Replaces the password hash and bumps the token version (every other session dies). The forced-change flag is cleared
 * unless `mustChangePassword` is true, which is how an admin reset hands out a temporary password. Returns false for an unknown id.
 */
export async function setLocalUserPassword(
  userId: string,
  passwordHash: string,
  opts: { mustChangePassword?: boolean } = {}
): Promise<boolean> {
  const must = opts.mustChangePassword === true;
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u) return false;
    u.passwordHash = passwordHash;
    u.tokenVersion += 1;
    u.mustChangePassword = must;
    return true;
  }
  const res = await pool.query(
    'UPDATE local_users SET password_hash = $2, token_version = token_version + 1, must_change_password = $3 WHERE id = $1 RETURNING 1',
    [userId, passwordHash, must]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setMustChangePassword(userId: string, value: boolean): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u) return false;
    u.mustChangePassword = value;
    return true;
  }
  const res = await pool.query('UPDATE local_users SET must_change_password = $2 WHERE id = $1 RETURNING 1', [userId, value]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Disabling bumps the token version and removes the factor; enabling clears the lockout (the factor is not restored).
 * Returns false for an unknown id.
 */
export async function setLocalUserDisabled(userId: string, disabled: boolean): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u) return false;
    u.disabled = disabled;
    if (disabled) {
      u.tokenVersion += 1;
      clearFactor(u);
    } else {
      u.failedAttempts = 0;
      u.lockedUntil = null;
    }
    return true;
  }
  const sql = disabled
    ? `UPDATE local_users SET disabled = TRUE, token_version = token_version + 1, ${CLEARED_FACTOR_SQL} WHERE id = $1 RETURNING 1`
    : 'UPDATE local_users SET disabled = FALSE, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING 1';
  const res = await pool.query(sql, [userId]);
  return (res.rowCount ?? 0) > 0;
}

/** Removes the factor and recovery codes and bumps the token version. Returns false for an unknown id. */
export async function clearLocalUserMfa(userId: string): Promise<boolean> {
  if (getDbMode() === 'memory') {
    const u = memoryUserById(userId);
    if (!u) return false;
    clearFactor(u);
    u.tokenVersion += 1;
    return true;
  }
  const res = await pool.query(
    `UPDATE local_users SET ${CLEARED_FACTOR_SQL}, token_version = token_version + 1 WHERE id = $1 RETURNING 1`,
    [userId]
  );
  return (res.rowCount ?? 0) > 0;
}

/** CLI recovery path: clears the factor, bumps the token version and the lockout. `hadFactor` is true when a confirmed factor existed. */
export async function resetLocalUserMfa(email: string): Promise<{ found: boolean; hadFactor: boolean }> {
  const key = normalizeEmail(email);
  if (getDbMode() === 'memory') {
    const u = memoryUsers.get(key);
    if (!u) return { found: false, hadFactor: false };
    const hadFactor = u.totpConfirmedAt !== null;
    clearFactor(u);
    u.tokenVersion += 1;
    u.failedAttempts = 0;
    u.lockedUntil = null;
    return { found: true, hadFactor };
  }
  const res = await pool.query(
    `WITH prev AS (SELECT id, totp_confirmed_at IS NOT NULL AS had FROM local_users WHERE email = $1)
     UPDATE local_users u SET ${CLEARED_FACTOR_SQL}, token_version = u.token_version + 1, failed_attempts = 0, locked_until = NULL
       FROM prev WHERE u.id = prev.id RETURNING prev.had AS had`,
    [key]
  );
  return res.rows[0] ? { found: true, hadFactor: Boolean(res.rows[0].had) } : { found: false, hadFactor: false };
}

/** Removes a local account. Used to roll back a registration whose invitation could not be consumed. */
export async function deleteLocalUser(id: string): Promise<void> {
  if (getDbMode() === 'memory') {
    for (const [email, u] of memoryUsers) if (u.id === id) memoryUsers.delete(email);
    return;
  }
  await pool.query('DELETE FROM local_users WHERE id = $1', [id]);
}

/** Test hook. */
export function __resetMemoryLocalUsersForTests(): void {
  memoryUsers.clear();
}
