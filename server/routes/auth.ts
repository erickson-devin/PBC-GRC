import { Router, Request, Response } from 'express';
import {
  LocalAuthConfigError,
  LocalTokenError,
  getDummyHash,
  getMfaRequirement,
  hashPassword,
  signLocalToken,
  signMfaPendingToken,
  validateNewPassword,
  verifyMfaPendingToken,
  verifyPassword,
  type MfaStage,
} from '../auth/localAuth';
import {
  MfaKeyConfigError,
  MfaSecretUnreadableError,
  decryptTotpSecret,
  encryptTotpSecret,
  hashRecoveryCode,
} from '../auth/mfaCrypto';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from '../auth/totp';
import { resolveMfaRequired } from '../auth/mfaEnforcement';
import {
  LocalUserExistsError,
  confirmTotp,
  consumeRecoveryCode,
  consumeTotpStep,
  createLocalUser,
  deleteLocalUser,
  findLocalUserByEmail,
  findLocalUserById,
  registerFailedLogin,
  registerSuccessfulLogin,
  replaceRecoveryCodeHashes,
  setLocalUserPassword,
  setPendingTotpSecret,
  type LocalUser,
} from '../auth/localUsers';
import { previewInvitation, redeemInvitation } from '../invitations';
import { accountLogRef, createLoginThrottle, loginAccountKey } from '../auth/loginThrottle';
import { SESSION_REVOKED, authOnlyMiddleware } from '../middleware/authMiddleware';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

/**
 * GET /api/v1/auth/config   (public)
 * Reports the identity mode. Local accounts are the only mode; the endpoint stays so the client can confirm it.
 */
router.get('/config', (_req: Request, res: Response): void => {
  res.json({ mode: 'local' });
});

// ---- per-IP throttle (in addition to per-account lockout) -------------------------------------
const loginThrottle = createLoginThrottle();

/** Test hook. */
export function __resetLoginThrottleForTests(): void {
  loginThrottle.reset();
}

const INVALID_CREDENTIALS = { error: 'Invalid email or password' };

// ---- second factor: shared helpers ------------------------------------------------------------
const MFA_ISSUER = 'PBC-GRC';
const MFA_METHODS = ['totp', 'recovery_code'];
const RECOVERY_CODE_COUNT = 8;
const LOCKED_MESSAGE = 'Account temporarily locked after repeated failed sign-ins. Try again later.';
const MFA_TOKEN_INVALID = { error: 'The sign-in step has expired or is no longer valid. Sign in again.', reason: 'mfa_token_invalid' };

let mfaClock: (() => number) | null = null;
/** Test hook: the clock every TOTP check uses. Lockouts and token lifetimes always use the real clock. */
export function __setMfaClockForTests(fn: (() => number) | null): void {
  mfaClock = fn;
}
const mfaNow = (): number => (mfaClock ? mfaClock() : Date.now());

// A pending token works once: the jti of every token that completed its step is remembered until the map is full
// (bounded, oldest first, expired entries dropped first). Pending tokens live 5 to 10 minutes, so a token cannot outlive its entry in practice.
const MAX_USED_JTIS = 10_000;
const usedJtis = new Map<string, number>(); // jti -> token expiry (seconds)

function markJtiUsed(jti: string, expSeconds: number): boolean {
  if (usedJtis.has(jti)) return false;
  if (usedJtis.size >= MAX_USED_JTIS) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [key, exp] of usedJtis) if (exp <= nowSeconds) usedJtis.delete(key);
    while (usedJtis.size >= MAX_USED_JTIS) {
      const oldest = usedJtis.keys().next().value;
      if (oldest === undefined) break;
      usedJtis.delete(oldest);
    }
  }
  usedJtis.set(jti, expSeconds);
  return true;
}

/** Test hook. */
export function __resetMfaStateForTests(): void {
  usedJtis.clear();
}

const isEnrolled = (user: LocalUser): boolean => user.totpConfirmedAt !== null && user.totpSecretEnc !== null;
const noStore = (res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
};

type SessionSubject = Pick<LocalUser, 'id' | 'email' | 'name' | 'tokenVersion' | 'mustChangePassword'>;

/** The body every session-issuing response shares. */
function sessionBody(user: SessionSubject, amr: string[], mfaEnrolled: boolean): Record<string, unknown> {
  const { token, claims } = signLocalToken({ id: user.id, email: user.email, name: user.name, tokenVersion: user.tokenVersion }, { amr });
  return {
    token,
    tokenType: 'Bearer',
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    expiresIn: claims.exp - claims.iat,
    user: { id: user.id, email: user.email, name: user.name },
    mustChangePassword: user.mustChangePassword,
    mfaEnrolled,
  };
}

/** The "step two follows" body: proof that step one succeeded, not a session. */
function pendingBody(user: Pick<LocalUser, 'id' | 'tokenVersion'>, stage: MfaStage): Record<string, unknown> {
  const { token, claims } = signMfaPendingToken({ id: user.id, tokenVersion: user.tokenVersion }, stage);
  return { mfa: stage, mfaToken: token, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/**
 * Resolves a pending token (accepted ONLY from the request body) to its account, or null when it is forged, expired,
 * of the wrong stage, already used, issued before a version bump, or for an unknown or disabled account.
 */
async function resolvePending(token: unknown, stage: MfaStage): Promise<{ user: LocalUser; jti: string; exp: number } | null> {
  if (typeof token !== 'string' || !token || token.length > 2048) return null;
  let claims;
  try {
    claims = verifyMfaPendingToken(token, stage);
  } catch (err: unknown) {
    if (err instanceof LocalTokenError) return null;
    throw err;
  }
  if (usedJtis.has(claims.jti)) return null;
  const user = await findLocalUserById(claims.sub);
  if (!user || user.disabled || user.tokenVersion !== claims.ver) return null;
  return { user, jti: claims.jti, exp: claims.exp };
}

/** Answers 429 and returns true while the account is locked. */
function respondIfLocked(res: Response, user: LocalUser): boolean {
  if (!user.lockedUntil || user.lockedUntil.getTime() <= Date.now()) return false;
  res.setHeader('Retry-After', String(Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000)));
  res.status(429).json({ error: LOCKED_MESSAGE });
  return true;
}

/** Checks a TOTP code against the stored secret (the shared test clock applies). Throws MfaSecretUnreadableError when the secret cannot be read. */
function checkTotpCode(user: LocalUser, code: unknown): { ok: true; step: number } | { ok: false } {
  if (!user.totpSecretEnc || user.totpConfirmedAt === null) return { ok: false };
  const secret = decryptTotpSecret(user.totpSecretEnc, user.id);
  const result = verifyTotp(secret, code, { nowMs: mfaNow(), lastUsedStep: user.totpLastUsedStep });
  return result.ok ? { ok: true, step: result.step } : { ok: false };
}

/** Maps the known failure types to their status; everything else is a 500 with the generic message. */
function respondWithError(res: Response, err: unknown, what: string): void {
  if (err instanceof LocalAuthConfigError || err instanceof MfaKeyConfigError) {
    console.error('[Auth] Local auth misconfigured:', err.message);
    res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
    return;
  }
  if (err instanceof MfaSecretUnreadableError) {
    console.error('[Auth] ' + what + ' failed: the stored second factor could not be read');
    res.status(503).json({ error: 'The second factor could not be read. Ask an administrator to reset it.', reason: 'mfa_unavailable' });
    return;
  }
  console.error('[Auth] ' + what + ' failed:', errorMessage(err));
  res.status(500).json({ error: what + ' failed' });
}

/** Authenticates the Authorization header (session) when the handler needs it. True when the request may continue. */
function requireSession(req: Request, res: Response): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    authOnlyMiddleware(req, res, () => resolve(true)).then(() => resolve(false), () => resolve(false));
  });
}

/**
 * POST /api/v1/auth/login   (public)
 * Body: { email, password }. Returns a short-lived HS256 JWT carrying `sub`, `email` and `name`, which
 * authMiddleware verifies with the local secret. The failure response is identical for an unknown
 * email, a wrong password and a disabled account, and a hash is compared in every case, so neither the
 * message nor the timing reveals which emails exist. Accounts lock for 15 minutes after 5 consecutive failures.
 * With a confirmed second factor (or when MFA_REQUIRED demands one) the response is { mfa: 'verify' | 'enrol', mfaToken, ... }
 * instead of a session; the session comes from POST /auth/mfa/verify or /auth/mfa/enrol/confirm.
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const ipHit = loginThrottle.hitIp(req.ip || 'unknown');
  if (ipHit.limited) {
    res.setHeader('Retry-After', String(ipHit.retryAfterSeconds));
    res.status(429).json({ error: 'Too many login attempts. Try again shortly.' });
    return;
  }

  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 255 || password.length > 1024) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const accountKey = loginAccountKey(email);
  try {
    const user = await findLocalUserByEmail(email);

    // Real accounts lock in the store; every address (real or not) also locks in memory, so the answer never tells them apart.
    const storeLock = user?.lockedUntil && user.lockedUntil.getTime() > Date.now() ? Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) : 0;
    const retryAfter = Math.max(storeLock, loginThrottle.accountLockedFor(accountKey));
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Account temporarily locked after repeated failed sign-ins. Try again later.' });
      return;
    }

    const matches = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

    if (!user || user.disabled || !matches) {
      if (user && !user.disabled) await registerFailedLogin(user);
      loginThrottle.recordAccountFailure(accountKey);
      console.warn(`[Auth] Failed local login (account ${accountLogRef(email)}) from ${req.ip}`);
      res.status(401).json(INVALID_CREDENTIALS);
      return;
    }
    loginThrottle.clearAccount(accountKey);

    // Step one succeeded. When a second step follows, the failure counter is NOT reset here: otherwise someone who holds
    // the password could reset it between guesses at the code. The final step resets it.
    if (isEnrolled(user)) {
      noStore(res);
      console.log(`[Auth] Local login (second factor pending): ${user.email}`);
      res.json({ ...pendingBody(user, 'verify'), methods: MFA_METHODS });
      return;
    }
    if (await resolveMfaRequired(user)) {
      noStore(res);
      console.log(`[Auth] Local login (second factor enrolment required): ${user.email}`);
      res.json(pendingBody(user, 'enrol'));
      return;
    }

    await registerSuccessfulLogin(user);
    console.log(`[Auth] Local login: ${user.email}`);
    res.json(sessionBody(user, ['pwd'], false));
  } catch (err: unknown) {
    respondWithError(res, err, 'Login');
  }
});

/**
 * POST /api/v1/auth/register-with-invite   (public)
 * Body: { token, name?, password }. How a brand-new person gets an account on an air-gapped install: holding the
 * invitation token proves they received it at the invited address, so the account is created for THAT email, the
 * invitation is consumed, and they are signed in, in one step. If an account for the email already exists they are
 * told to sign in instead (409 account_exists), and nothing is consumed.
 */
router.post('/register-with-invite', async (req: Request, res: Response): Promise<void> => {
  const ipHit = loginThrottle.hitIp(req.ip || 'unknown');
  if (ipHit.limited) {
    res.setHeader('Retry-After', String(ipHit.retryAfterSeconds));
    res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    return;
  }

  const { token, name, password } = req.body ?? {};
  if (typeof token !== 'string' || !/^inv_[A-Za-z0-9_-]{20,128}$/.test(token)) {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }
  if (typeof password !== 'string' || (name !== undefined && (typeof name !== 'string' || name.length > 255))) {
    res.status(400).json({ error: 'A password is required' });
    return;
  }

  try {
    const invite = await previewInvitation(token);
    if (!invite) {
      res.status(404).json({ error: 'Invitation not found' });
      return;
    }
    if (invite.status === 'EXPIRED' || invite.status === 'REVOKED') {
      res.status(410).json({ error: 'This invitation is no longer valid. Ask your administrator to send a new one.', reason: invite.status.toLowerCase() });
      return;
    }
    if (invite.status === 'ACCEPTED') {
      res.status(409).json({ error: 'This invitation has already been used.', reason: 'used' });
      return;
    }
    if (await findLocalUserByEmail(invite.email)) {
      res.status(409).json({ error: 'An account for this email already exists. Sign in instead.', reason: 'account_exists' });
      return;
    }

    let user;
    try {
      user = await createLocalUser({ email: invite.email, name: typeof name === 'string' ? name : '', password });
    } catch (err: unknown) {
      if (err instanceof LocalUserExistsError) {
        res.status(409).json({ error: 'An account for this email already exists. Sign in instead.', reason: 'account_exists' });
      } else {
        // Password policy problems (length, etc.) are safe and useful to show
        res.status(400).json({ error: errorMessage(err) || 'Invalid registration details' });
      }
      return;
    }

    const result = await redeemInvitation(token, { uid: user.id, email: user.email, name: user.name });
    if (!result.ok) {
      await deleteLocalUser(user.id); // do not leave an account behind for an invitation that could not be consumed
      res.status(result.reason === 'used' ? 409 : result.reason === 'invalid' ? 404 : 410).json({ error: 'This invitation can no longer be used.', reason: result.reason });
      return;
    }

    console.log('[Auth] Registered ' + user.email + ' via invitation into ' + result.tenantId + ' as ' + result.role);
    // The invited role may make this account subject to MFA_REQUIRED (privileged): then they enrol before they get a session.
    if (await resolveMfaRequired(user)) {
      noStore(res);
      res.status(201).json({ ...pendingBody(user, 'enrol'), tenantId: result.tenantId, role: result.role });
      return;
    }
    res.status(201).json({ ...sessionBody(user, ['pwd'], false), tenantId: result.tenantId, role: result.role });
  } catch (err: unknown) {
    respondWithError(res, err, 'Registration');
  }
});

/**
 * GET /api/v1/auth/me
 * The authenticated user's profile as the server sees it.
 */
router.get('/me', authOnlyMiddleware, (req: Request, res: Response): void => {
  const { uid, email, name } = req.user!;
  res.json({ user: { id: uid, email, name } });
});

// ---- second factor: endpoints -----------------------------------------------------------------

function tooManyAttempts(req: Request, res: Response): boolean {
  const ipHit = loginThrottle.hitIp(req.ip || 'unknown');
  if (!ipHit.limited) return false;
  res.setHeader('Retry-After', String(ipHit.retryAfterSeconds));
  res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  return true;
}

/**
 * POST /api/v1/auth/mfa/verify   (public; needs the pending token from login)
 * Body: { mfaToken, code } or { mfaToken, recoveryCode }. A wrong or replayed code counts toward the same account lockout as a
 * wrong password. Success returns the session (amr pwd + otp); the pending token then cannot be used again.
 */
router.post('/mfa/verify', async (req: Request, res: Response): Promise<void> => {
  if (tooManyAttempts(req, res)) return;
  noStore(res);

  const { mfaToken, code, recoveryCode } = req.body ?? {};
  const byCode = typeof code === 'string' && code.length > 0 && code.length <= 16 && recoveryCode === undefined;
  const byRecovery = typeof recoveryCode === 'string' && recoveryCode.length > 0 && recoveryCode.length <= 64 && code === undefined;
  if (typeof mfaToken !== 'string' || !mfaToken || (!byCode && !byRecovery)) {
    res.status(400).json({ error: 'A sign-in token and either a code or a recovery code are required', reason: 'invalid_request' });
    return;
  }

  try {
    const pending = await resolvePending(mfaToken, 'verify');
    if (!pending) {
      res.status(401).json(MFA_TOKEN_INVALID);
      return;
    }
    const { user } = pending;
    if (respondIfLocked(res, user)) return;
    if (!isEnrolled(user)) {
      res.status(401).json(MFA_TOKEN_INVALID);
      return;
    }

    let accepted = false;
    let usedRecovery = false;
    if (byCode) {
      const checked = checkTotpCode(user, code);
      accepted = checked.ok && (await consumeTotpStep(user.id, checked.step));
    } else {
      const normalized = normalizeRecoveryCode(recoveryCode);
      accepted = normalized !== null && (await consumeRecoveryCode(user.id, hashRecoveryCode(normalized)));
      usedRecovery = accepted;
    }
    if (!accepted) {
      await registerFailedLogin(user);
      console.warn(`[Auth] Failed second factor (account ${accountLogRef(user.email)}) from ${req.ip}`);
      res.status(401).json({ error: 'That code is not valid', reason: 'invalid_code' });
      return;
    }
    if (!markJtiUsed(pending.jti, pending.exp)) {
      res.status(401).json(MFA_TOKEN_INVALID);
      return;
    }

    await registerSuccessfulLogin(user);
    const body = sessionBody(user, ['pwd', 'otp'], true);
    if (usedRecovery) body.recoveryCodesRemaining = (await findLocalUserById(user.id))?.recoveryCodeHashes.length ?? 0;
    console.log(`[Auth] Local login (second factor): ${user.email}`);
    res.json(body);
  } catch (err: unknown) {
    respondWithError(res, err, 'Verification');
  }
});

/** The account an enrolment call acts for: the enrol-stage pending token in the body, or else a session. Null after answering. */
async function resolveEnrolSubject(req: Request, res: Response): Promise<{ user: LocalUser; pending: { jti: string; exp: number } | null } | null> {
  if (req.body?.mfaToken !== undefined) {
    const pending = await resolvePending(req.body.mfaToken, 'enrol');
    if (!pending) {
      res.status(401).json(MFA_TOKEN_INVALID);
      return null;
    }
    return { user: pending.user, pending };
  }
  if (!(await requireSession(req, res))) return null;
  const user = await findLocalUserById(req.user!.uid);
  if (!user) {
    res.status(401).json(SESSION_REVOKED);
    return null;
  }
  return { user, pending: null };
}

/**
 * POST /api/v1/auth/mfa/enrol/start   (enrol-stage mfaToken in the body, or a session)
 * Creates (or replaces) the pending secret. The secret is returned here and nowhere else; it only becomes a factor once
 * /enrol/confirm accepts a code from it.
 */
router.post('/mfa/enrol/start', async (req: Request, res: Response): Promise<void> => {
  if (tooManyAttempts(req, res)) return;
  noStore(res);
  try {
    const subject = await resolveEnrolSubject(req, res);
    if (!subject) return;
    const { user } = subject;
    if (isEnrolled(user)) {
      res.status(409).json({ error: 'A second factor is already set up for this account', reason: 'mfa_already_enrolled' });
      return;
    }
    const secret = generateTotpSecret();
    if (!(await setPendingTotpSecret(user.id, encryptTotpSecret(secret, user.id)))) {
      res.status(409).json({ error: 'A second factor is already set up for this account', reason: 'mfa_already_enrolled' });
      return;
    }
    const secretBase32 = base32Encode(secret, { padding: false });
    res.json({
      secret: secretBase32,
      otpauthUri: buildOtpauthUri({ issuer: MFA_ISSUER, accountName: user.email, secretBase32 }),
      issuer: MFA_ISSUER,
      accountName: user.email,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });
  } catch (err: unknown) {
    respondWithError(res, err, 'Enrolment');
  }
});

/**
 * POST /api/v1/auth/mfa/enrol/confirm   (enrol-stage mfaToken in the body, or a session)
 * Body: { code, mfaToken? }. A valid code from the pending secret makes it the account's factor and returns the one-time recovery
 * codes. With the pending token it also returns the session (the step that login stopped at). A wrong code is 400 and is not
 * counted toward the lockout (the caller already holds the secret); the per-IP throttle still applies.
 */
router.post('/mfa/enrol/confirm', async (req: Request, res: Response): Promise<void> => {
  if (tooManyAttempts(req, res)) return;
  noStore(res);
  try {
    const code = req.body?.code;
    if (typeof code !== 'string' || !code || code.length > 16) {
      res.status(400).json({ error: 'A code is required', reason: 'invalid_request' });
      return;
    }
    const subject = await resolveEnrolSubject(req, res);
    if (!subject) return;
    const { user, pending } = subject;
    if (isEnrolled(user)) {
      res.status(409).json({ error: 'A second factor is already set up for this account', reason: 'mfa_already_enrolled' });
      return;
    }
    if (!user.totpSecretEnc) {
      res.status(409).json({ error: 'Start the enrolment first', reason: 'mfa_not_started' });
      return;
    }
    const secret = decryptTotpSecret(user.totpSecretEnc, user.id);
    const checked = verifyTotp(secret, code, { nowMs: mfaNow(), lastUsedStep: null });
    if (!checked.ok) {
      res.status(400).json({ error: 'That code is not valid', reason: 'invalid_code' });
      return;
    }
    const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    const hashes = recoveryCodes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c) as string));
    if (!(await confirmTotp(user.id, checked.step, hashes))) {
      res.status(409).json({ error: 'A second factor is already set up for this account', reason: 'mfa_already_enrolled' });
      return;
    }
    const enrolledAt = new Date().toISOString();
    if (!pending) {
      console.log(`[Auth] Second factor enrolled: ${user.email}`);
      res.json({ recoveryCodes, enrolledAt });
      return;
    }
    markJtiUsed(pending.jti, pending.exp);
    await registerSuccessfulLogin(user);
    console.log(`[Auth] Second factor enrolled, local login: ${user.email}`);
    res.json({ recoveryCodes, enrolledAt, ...sessionBody(user, ['pwd', 'otp'], true) });
  } catch (err: unknown) {
    respondWithError(res, err, 'Enrolment');
  }
});

/**
 * GET /api/v1/auth/mfa   (session)
 * { enrolled, enrolledAt, recoveryCodesRemaining, required, mode }: what the account settings screen needs.
 */
router.get('/mfa', authOnlyMiddleware, async (req: Request, res: Response): Promise<void> => {
  noStore(res);
  try {
    const user = await findLocalUserById(req.user!.uid);
    if (!user) {
      res.status(401).json(SESSION_REVOKED);
      return;
    }
    const enrolled = isEnrolled(user);
    res.json({
      enrolled,
      enrolledAt: enrolled ? user.totpConfirmedAt!.toISOString() : null,
      recoveryCodesRemaining: enrolled ? user.recoveryCodeHashes.length : 0,
      required: await resolveMfaRequired(user),
      mode: getMfaRequirement(),
    });
  } catch (err: unknown) {
    respondWithError(res, err, 'Status lookup');
  }
});

/**
 * POST /api/v1/auth/mfa/recovery-codes   (session)
 * Body: { code }. Needs a fresh authenticator code (a replayed one is refused and counts as a failure). Replaces ALL stored
 * recovery codes with 8 new ones, returned once. 409 mfa_not_enrolled when there is no confirmed factor.
 */
router.post('/mfa/recovery-codes', authOnlyMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (tooManyAttempts(req, res)) return;
  noStore(res);
  const code = req.body?.code;
  if (typeof code !== 'string' || !code || code.length > 16) {
    res.status(400).json({ error: 'A code is required', reason: 'invalid_request' });
    return;
  }
  try {
    const user = await findLocalUserById(req.user!.uid);
    if (!user || user.disabled) {
      res.status(401).json(SESSION_REVOKED);
      return;
    }
    if (!isEnrolled(user)) {
      res.status(409).json({ error: 'No second factor is set up for this account', reason: 'mfa_not_enrolled' });
      return;
    }
    if (respondIfLocked(res, user)) return;
    const checked = checkTotpCode(user, code);
    if (!checked.ok || !(await consumeTotpStep(user.id, checked.step))) {
      await registerFailedLogin(user);
      res.status(403).json({ error: 'That code is not valid', reason: 'invalid_code' });
      return;
    }
    const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    const hashes = recoveryCodes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c) as string));
    if (!(await replaceRecoveryCodeHashes(user.id, hashes))) {
      res.status(409).json({ error: 'No second factor is set up for this account', reason: 'mfa_not_enrolled' });
      return;
    }
    console.log(`[Auth] Recovery codes regenerated: ${user.email}`);
    res.json({ recoveryCodes, recoveryCodesRemaining: RECOVERY_CODE_COUNT });
  } catch (err: unknown) {
    respondWithError(res, err, 'Recovery code regeneration');
  }
});

/**
 * POST /api/v1/auth/password   (session)
 * Body: { currentPassword, newPassword, code? }. Needs the current password and, for an enrolled account, a fresh code. A wrong
 * current password or code counts toward the lockout. Success ends every other session (token_version), clears a forced-change
 * flag and returns a new session. This is the only request a session flagged must_change_password may make.
 */
router.post('/password', authOnlyMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (tooManyAttempts(req, res)) return;
  noStore(res);

  const { currentPassword, newPassword, code } = req.body ?? {};
  if (
    typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024 ||
    typeof newPassword !== 'string' || !newPassword || newPassword.length > 1024 ||
    (code !== undefined && (typeof code !== 'string' || code.length > 16))
  ) {
    res.status(400).json({ error: 'The current and the new credentials are required', reason: 'invalid_request' });
    return;
  }

  try {
    const user = await findLocalUserById(req.user!.uid);
    if (!user || user.disabled) {
      res.status(401).json(SESSION_REVOKED);
      return;
    }
    if (respondIfLocked(res, user)) return;

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await registerFailedLogin(user);
      console.warn(`[Auth] Failed credential change (account ${accountLogRef(user.email)}) from ${req.ip}`);
      res.status(403).json({ error: 'The current credential is incorrect', reason: 'invalid_current_password' });
      return;
    }

    let step: number | null = null;
    if (isEnrolled(user)) {
      if (code === undefined || code === '') {
        res.status(400).json({ error: 'A code from your authenticator app is required', reason: 'code_required' });
        return;
      }
      const checked = checkTotpCode(user, code);
      if (!checked.ok) {
        await registerFailedLogin(user);
        res.status(403).json({ error: 'That code is not valid', reason: 'invalid_code' });
        return;
      }
      step = checked.step;
    }

    const problem = validateNewPassword(newPassword, user.email);
    if (problem) {
      res.status(400).json({ error: problem, reason: 'weak_password' });
      return;
    }

    // The code is spent only now, so a rejected new value does not burn it; a concurrent use of the same code loses here.
    if (step !== null && !(await consumeTotpStep(user.id, step))) {
      await registerFailedLogin(user);
      res.status(403).json({ error: 'That code is not valid', reason: 'invalid_code' });
      return;
    }
    if (!(await setLocalUserPassword(user.id, await hashPassword(newPassword)))) {
      res.status(401).json(SESSION_REVOKED);
      return;
    }
    const updated = await findLocalUserById(user.id);
    if (!updated) {
      res.status(401).json(SESSION_REVOKED);
      return;
    }
    console.log(`[Auth] Sign-in credential changed: ${user.email}`);
    res.json(sessionBody(updated, step !== null ? ['pwd', 'otp'] : ['pwd'], isEnrolled(updated)));
  } catch (err: unknown) {
    respondWithError(res, err, 'Credential change');
  }
});

export default router;
