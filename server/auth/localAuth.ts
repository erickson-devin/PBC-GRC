import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { deriveKey, MIN_MFA_KEY_LENGTH } from './mfaCrypto';
import type { MfaRequirement } from './mfaPolicy';

/**
 * Local (air-gapped) authentication primitives: HS256 JWTs and bcrypt password hashing.
 * Nothing here touches the network, so the platform runs fully on-prem with no external identity provider.
 * LOCAL_AUTH_SECRET (>= 32 characters) is required. There is intentionally NO default secret.
 */

export const LOCAL_TOKEN_ISSUER = 'pbc-grc-local';
export const LOCAL_TOKEN_AUDIENCE = 'pbc-grc';
export const MIN_SECRET_LENGTH = 32;
export const DEFAULT_TOKEN_TTL_SECONDS = 8 * 60 * 60;

export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt only hashes the first 72 bytes; longer inputs are rejected instead of being silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

export class LocalAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAuthConfigError';
  }
}

export class LocalTokenError extends Error {
  /** Why the token was refused: 'expired' is only ever set after the signature checked out. */
  readonly code: 'invalid' | 'expired' | 'revoked';

  constructor(message: string, code: 'invalid' | 'expired' | 'revoked' = 'invalid') {
    super(message);
    this.name = 'LocalTokenError';
    this.code = code;
  }
}

export function getLocalAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.LOCAL_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new LocalAuthConfigError(
      `LOCAL_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters (e.g. \`openssl rand -hex 32\`).`
    );
  }
  return secret;
}

/**
 * Startup validation: local accounts are the only identity mode. AUTH_MODE may be omitted or "local"; anything
 * else is refused. The signing secret is always required, and dev mock tokens can never be enabled in production.
 */
export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.AUTH_MODE ?? '';
  const mode = raw.trim().toLowerCase();
  if (mode !== '' && mode !== 'local') {
    throw new LocalAuthConfigError(
      `AUTH_MODE="${raw}" is not supported: PBC-GRC uses local accounts only. Remove AUTH_MODE or set it to "local".`
    );
  }
  getLocalAuthSecret(env);
  if (env.ALLOW_DEV_MOCK_TOKENS === 'true' && env.NODE_ENV === 'production') {
    throw new LocalAuthConfigError('ALLOW_DEV_MOCK_TOKENS must not be set when NODE_ENV=production');
  }
  getMfaRequirement(env);
  const mfaKey = (env.MFA_ENCRYPTION_KEY ?? '').trim();
  if (mfaKey !== '' && mfaKey.length < MIN_MFA_KEY_LENGTH) {
    throw new LocalAuthConfigError(
      `MFA_ENCRYPTION_KEY must be at least ${MIN_MFA_KEY_LENGTH} characters when set (e.g. \`openssl rand -hex 32\`), or left empty.`
    );
  }
}

/** Default when MFA_REQUIRED is unset or blank: every local account needs a second factor (NIST SP 800-171 3.5.3). */
export const DEFAULT_MFA_REQUIREMENT: MfaRequirement = 'all';

/** Parses MFA_REQUIRED (all | privileged | off, case-insensitive, blank = default). Anything else is a configuration error. */
export function getMfaRequirement(env: NodeJS.ProcessEnv = process.env): MfaRequirement {
  const value = (env.MFA_REQUIRED ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_MFA_REQUIREMENT;
  if (value === 'all' || value === 'privileged' || value === 'off') return value;
  throw new LocalAuthConfigError('MFA_REQUIRED must be one of: all, privileged, off (or left empty for the default).');
}

/** Warnings the server logs once at startup (the caller logs them; nothing here prints). */
export function authStartupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (getMfaRequirement(env) === 'off' && env.NODE_ENV === 'production') {
    return ['MFA_REQUIRED=off in production: multi-factor authentication is disabled; NIST SP 800-171 3.5.3 is not met by the application'];
  }
  return [];
}

// ----------------------------------------------------------------------------- JWT (HS256)

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** Session and mfa_pending tokens are signed with an HKDF-derived key, never with the raw LOCAL_AUTH_SECRET. */
function sessionSigningKey(env: NodeJS.ProcessEnv | undefined): Buffer {
  return deriveKey(getLocalAuthSecret(env), 'pbc-grc session-signing v1');
}

function signJwt(claims: object, key: Buffer): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Checks the algorithm and signature (constant-time) and returns the raw claims. Throws LocalTokenError otherwise. */
function verifyJwtSignature(token: string, key: Buffer): Record<string, unknown> {
  if (typeof token !== 'string') throw new LocalTokenError('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new LocalTokenError('Malformed token');
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown };
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  } catch {
    throw new LocalTokenError('Malformed token header');
  }
  // Pin the algorithm: never let the token choose it ("alg: none" and key-confusion attacks).
  if (header.alg !== 'HS256') throw new LocalTokenError('Unsupported token algorithm');

  const expected = crypto.createHmac('sha256', key).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new LocalTokenError('Invalid token signature');
  }

  try {
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (claims === null || typeof claims !== 'object') throw new Error('shape');
    return claims as Record<string, unknown>;
  } catch {
    throw new LocalTokenError('Malformed token payload');
  }
}

export interface LocalTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
  /** Token version at issue time; absent on tokens minted before 5.9 (read as 0). */
  ver?: number;
  /** Authentication methods used: ['pwd'] or ['pwd', 'otp']. */
  amr?: string[];
  purpose?: 'session';
  /** Random session reference: the only identifier of a session the client may see (the token itself lives in an HttpOnly cookie). */
  sid?: string;
}

/**
 * Signs a token whose claims match what authMiddleware reads: `sub` (uid), `email`, `name`. Tenant access is not
 * baked in: it comes from tenant_users via the x-tenant-id header, so revoking a membership takes effect at once.
 */
export function signLocalToken(
  user: { id: string; email: string; name: string; tokenVersion?: number },
  options: { ttlSeconds?: number; now?: number; env?: NodeJS.ProcessEnv; amr?: string[] } = {}
): { token: string; claims: LocalTokenClaims } {
  const env = options.env ?? process.env;
  const key = sessionSigningKey(env);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? Number(env.LOCAL_AUTH_TOKEN_TTL_SECONDS ?? DEFAULT_TOKEN_TTL_SECONDS);

  const claims: LocalTokenClaims = {
    iss: LOCAL_TOKEN_ISSUER,
    aud: LOCAL_TOKEN_AUDIENCE,
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + (Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TOKEN_TTL_SECONDS),
    amr: options.amr ?? ['pwd'],
    purpose: 'session',
    sid: crypto.randomBytes(16).toString('base64url'),
  };
  if (typeof user.tokenVersion === 'number') claims.ver = user.tokenVersion;

  return { token: signJwt(claims, key), claims };
}

/** Verifies signature (constant-time), algorithm, issuer, audience, purpose and expiry. Throws LocalTokenError otherwise. */
export function verifyLocalToken(token: string, options: { now?: number; env?: NodeJS.ProcessEnv } = {}): LocalTokenClaims {
  const key = sessionSigningKey(options.env);
  const claims = verifyJwtSignature(token, key) as Partial<LocalTokenClaims> & { purpose?: unknown };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== LOCAL_TOKEN_ISSUER || claims.aud !== LOCAL_TOKEN_AUDIENCE) {
    throw new LocalTokenError('Wrong token issuer or audience');
  }
  if (claims.purpose !== undefined && claims.purpose !== 'session') throw new LocalTokenError('Token is not a session token');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new LocalTokenError('Token has no subject');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new LocalTokenError('Token expired', 'expired');

  return claims as LocalTokenClaims;
}

// ----------------------------------------------------------------------------- MFA pending token

export const MFA_TOKEN_AUDIENCE = 'pbc-grc-mfa';
export const MFA_VERIFY_TTL_SECONDS = 300;
export const MFA_ENROL_TTL_SECONDS = 600;

export type MfaStage = 'verify' | 'enrol';

export interface MfaPendingClaims {
  iss: string;
  aud: string;
  sub: string;
  purpose: 'mfa_pending';
  stage: MfaStage;
  ver: number;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Proof that step one (the password) succeeded. It is NOT a session: its audience differs, so verifyLocalToken refuses
 * it, and routes accept it only in a request body. Single use is enforced by the route through `jti`.
 */
export function signMfaPendingToken(
  user: { id: string; tokenVersion: number },
  stage: MfaStage,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {}
): { token: string; claims: MfaPendingClaims } {
  const key = sessionSigningKey(options.env ?? process.env);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: MfaPendingClaims = {
    iss: LOCAL_TOKEN_ISSUER,
    aud: MFA_TOKEN_AUDIENCE,
    sub: user.id,
    purpose: 'mfa_pending',
    stage,
    ver: user.tokenVersion,
    jti: crypto.randomBytes(16).toString('base64url'),
    iat: now,
    exp: now + (stage === 'enrol' ? MFA_ENROL_TTL_SECONDS : MFA_VERIFY_TTL_SECONDS),
  };
  return { token: signJwt(claims, key), claims };
}

/** Verifies signature, algorithm, issuer, audience, purpose, stage and expiry. Throws LocalTokenError otherwise. */
export function verifyMfaPendingToken(
  token: string,
  stage: MfaStage,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {}
): MfaPendingClaims {
  const key = sessionSigningKey(options.env);
  const claims = verifyJwtSignature(token, key) as Partial<MfaPendingClaims>;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== LOCAL_TOKEN_ISSUER || claims.aud !== MFA_TOKEN_AUDIENCE) {
    throw new LocalTokenError('Wrong token issuer or audience');
  }
  if (claims.purpose !== 'mfa_pending') throw new LocalTokenError('Wrong token purpose');
  if (claims.stage !== stage) throw new LocalTokenError('Wrong token stage');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new LocalTokenError('Token has no subject');
  if (typeof claims.ver !== 'number') throw new LocalTokenError('Token has no version');
  if (typeof claims.jti !== 'string' || !claims.jti) throw new LocalTokenError('Token has no identifier');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new LocalTokenError('Token expired', 'expired');

  return claims as MfaPendingClaims;
}

// ----------------------------------------------------------------------------- Passwords (bcrypt)

function bcryptCost(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOCAL_AUTH_BCRYPT_COST);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : 12;
}

/** Returns an error message for an unacceptable new password, or null if it is fine. */
export function validateNewPassword(password: string, email?: string): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Password must not be the same as the email address';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  return bcrypt.hash(password, bcryptCost());
}

/** Never throws; empty or over-long input simply does not match. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** A valid bcrypt hash of a random value, compared against when the email is unknown so timing does not reveal it. */
export function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(crypto.randomBytes(24).toString('hex'), bcryptCost());
  return dummyHash;
}
