import crypto from 'crypto';

/**
 * Key derivation and at-rest protection for the second factor. Imports nothing from localAuth (localAuth imports this).
 * Three independent keys come from HKDF-SHA256 with distinct `info` labels:
 *  - session signing (IKM = LOCAL_AUTH_SECRET);
 *  - TOTP secret encryption and the recovery-code pepper (IKM = MFA_ENCRYPTION_KEY when set, else LOCAL_AUTH_SECRET).
 */

export type KeyInfo = 'pbc-grc session-signing v1' | 'pbc-grc totp-secret v1' | 'pbc-grc recovery-pepper v1';

export const MIN_MFA_KEY_LENGTH = 32;

export class MfaKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfaKeyConfigError';
  }
}

/** Deliberately generic: it never carries the blob, the secret or the cause. */
export class MfaSecretUnreadableError extends Error {
  constructor() {
    super('The stored second factor could not be read');
    this.name = 'MfaSecretUnreadableError';
  }
}

export function deriveKey(ikm: string, info: KeyInfo, _env: NodeJS.ProcessEnv = process.env): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, '', info, 32));
}

/** The input keying material for the TOTP and pepper keys: MFA_ENCRYPTION_KEY when set and long enough, else LOCAL_AUTH_SECRET. */
function mfaIkm(env: NodeJS.ProcessEnv): string {
  const dedicated = (env.MFA_ENCRYPTION_KEY ?? '').trim();
  if (dedicated.length >= MIN_MFA_KEY_LENGTH) return dedicated;
  const secret = env.LOCAL_AUTH_SECRET ?? '';
  if (secret.length < MIN_MFA_KEY_LENGTH) {
    throw new MfaKeyConfigError(`LOCAL_AUTH_SECRET must be set to at least ${MIN_MFA_KEY_LENGTH} characters.`);
  }
  return secret;
}

const aadFor = (userId: string): Buffer => Buffer.from(`local_users:${userId}`, 'utf8');

/** AES-256-GCM, random 12-byte IV, AAD binds the blob to its row. Format: v1.<iv>.<ciphertext>.<tag> (base64url). */
export function encryptTotpSecret(secret: Buffer, userId: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = deriveKey(mfaIkm(env), 'pbc-grc totp-secret v1', env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(userId));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

/** Throws MfaSecretUnreadableError for anything that does not authenticate: wrong row, wrong key, tampering, bad format. */
export function decryptTotpSecret(blob: string, userId: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  try {
    const parts = typeof blob === 'string' ? blob.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('format');
    const iv = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('format');
    const key = deriveKey(mfaIkm(env), 'pbc-grc totp-secret v1', env);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new MfaSecretUnreadableError();
  }
}

/** Keyed hash of a NORMALIZED recovery code (hex HMAC-SHA256): a stolen database cannot be brute-forced without the key. */
export function hashRecoveryCode(normalized: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = deriveKey(mfaIkm(env), 'pbc-grc recovery-pepper v1', env);
  return crypto.createHmac('sha256', key).update(normalized).digest('hex');
}
