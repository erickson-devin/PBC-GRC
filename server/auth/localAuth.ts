import crypto from 'crypto';
import bcrypt from 'bcryptjs';

/**
 * Local (air-gapped) authentication primitives: HS256 JWTs and bcrypt password hashing.
 * Nothing here touches the network, so the platform runs with no Firebase / Google / Microsoft reachability.
 * Enable with AUTH_MODE=local and LOCAL_AUTH_SECRET (>= 32 characters). There is intentionally NO default secret.
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
  constructor(message: string) {
    super(message);
    this.name = 'LocalTokenError';
  }
}

export function isLocalAuthMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUTH_MODE || 'firebase').trim().toLowerCase() === 'local';
}

export function getLocalAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.LOCAL_AUTH_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new LocalAuthConfigError(
      `LOCAL_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters when AUTH_MODE=local (e.g. \`openssl rand -hex 32\`).`
    );
  }
  return secret;
}

/** Startup validation: refuse to run in local-auth mode without a proper signing secret. */
export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const mode = (env.AUTH_MODE || 'firebase').trim().toLowerCase();
  if (mode !== 'local' && mode !== 'firebase') {
    throw new LocalAuthConfigError(`Invalid AUTH_MODE "${env.AUTH_MODE}": expected "firebase" or "local".`);
  }
  if (mode === 'local') getLocalAuthSecret(env);
}

// ----------------------------------------------------------------------------- JWT (HS256)

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export interface LocalTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

/**
 * Signs a token whose claims match what authMiddleware reads: `sub` (uid), `email`, `name`. Tenant access is not
 * baked in: it comes from tenant_users via the x-tenant-id header, so revoking a membership takes effect at once.
 */
export function signLocalToken(
  user: { id: string; email: string; name: string },
  options: { ttlSeconds?: number; now?: number; env?: NodeJS.ProcessEnv } = {}
): { token: string; claims: LocalTokenClaims } {
  const env = options.env ?? process.env;
  const secret = getLocalAuthSecret(env);
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
  };

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${signature}`, claims };
}

/** Verifies signature (constant-time), algorithm, issuer, audience and expiry. Throws LocalTokenError otherwise. */
export function verifyLocalToken(token: string, options: { now?: number; env?: NodeJS.ProcessEnv } = {}): LocalTokenClaims {
  const secret = getLocalAuthSecret(options.env);
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

  const expected = crypto.createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new LocalTokenError('Invalid token signature');
  }

  let claims: Partial<LocalTokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw new LocalTokenError('Malformed token payload');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== LOCAL_TOKEN_ISSUER || claims.aud !== LOCAL_TOKEN_AUDIENCE) {
    throw new LocalTokenError('Wrong token issuer or audience');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new LocalTokenError('Token has no subject');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new LocalTokenError('Token expired');

  return claims as LocalTokenClaims;
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
