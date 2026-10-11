import { Router, Request, Response } from 'express';
import {
  LocalAuthConfigError,
  getDummyHash,
  isLocalAuthMode,
  signLocalToken,
  verifyPassword,
} from '../auth/localAuth';
import {
  LocalUserExistsError,
  createLocalUser,
  deleteLocalUser,
  findLocalUserByEmail,
  registerFailedLogin,
  registerSuccessfulLogin,
} from '../auth/localUsers';
import { previewInvitation, redeemInvitation } from '../invitations';
import { authOnlyMiddleware } from '../middleware/authMiddleware';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

/**
 * GET /api/v1/auth/config   (public)
 * Tells the browser which identity provider this server uses, so the client never guesses from build-time env.
 */
router.get('/config', (_req: Request, res: Response): void => {
  res.json({ mode: isLocalAuthMode() ? 'local' : 'firebase' });
});

// ---- per-IP throttle (in addition to per-account lockout) -------------------------------------
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 20;
const attemptsByIp = new Map<string, number[]>();

function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attemptsByIp.set(ip, recent);
  if (attemptsByIp.size > 10_000) attemptsByIp.clear(); // bound memory under a spray from many addresses
  return recent.length > MAX_ATTEMPTS_PER_WINDOW;
}

/** Test hook. */
export function __resetLoginThrottleForTests(): void {
  attemptsByIp.clear();
}

const INVALID_CREDENTIALS = { error: 'Invalid email or password' };

/**
 * POST /api/v1/auth/login   (public; only when AUTH_MODE=local)
 * Body: { email, password }. Returns a short-lived HS256 JWT carrying `sub`, `email` and `name`, which
 * authMiddleware accepts exactly like a Firebase ID token. The failure response is identical for an unknown
 * email, a wrong password and a disabled account, and a hash is compared in every case, so neither the
 * message nor the timing reveals which emails exist. Accounts lock for 15 minutes after 5 consecutive failures.
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  if (!isLocalAuthMode()) {
    res.status(404).json({ error: 'Local authentication is not enabled on this server' });
    return;
  }

  if (throttled(req.ip || 'unknown')) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000));
    res.status(429).json({ error: 'Too many login attempts. Try again shortly.' });
    return;
  }

  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 255 || password.length > 1024) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    const user = await findLocalUserByEmail(email);

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Account temporarily locked after repeated failed sign-ins. Try again later.' });
      return;
    }

    const matches = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

    if (!user || user.disabled || !matches) {
      if (user && !user.disabled) await registerFailedLogin(user);
      console.warn(`[Auth] Failed local login for ${email.toLowerCase()} from ${req.ip}`);
      res.status(401).json(INVALID_CREDENTIALS);
      return;
    }

    await registerSuccessfulLogin(user);
    const { token, claims } = signLocalToken({ id: user.id, email: user.email, name: user.name });
    console.log(`[Auth] Local login: ${user.email}`);
    res.json({
      token,
      tokenType: 'Bearer',
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      expiresIn: claims.exp - claims.iat,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: unknown) {
    if (err instanceof LocalAuthConfigError) {
      console.error('[Auth] Local auth misconfigured:', err.message);
      res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
      return;
    }
    console.error('[Auth] Login failed:', errorMessage(err));
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/v1/auth/register-with-invite   (public; only when AUTH_MODE=local)
 * Body: { token, name?, password }. How a brand-new person gets an account on an air-gapped install: holding the
 * invitation token proves they received it at the invited address, so the account is created for THAT email, the
 * invitation is consumed, and they are signed in, in one step. If an account for the email already exists they are
 * told to sign in instead (409 account_exists), and nothing is consumed.
 */
router.post('/register-with-invite', async (req: Request, res: Response): Promise<void> => {
  if (!isLocalAuthMode()) {
    res.status(404).json({ error: 'Local authentication is not enabled on this server' });
    return;
  }
  if (throttled(req.ip || 'unknown')) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000));
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

    const { token: sessionToken, claims } = signLocalToken({ id: user.id, email: user.email, name: user.name });
    console.log('[Auth] Registered ' + user.email + ' via invitation into ' + result.tenantId + ' as ' + result.role);
    res.status(201).json({
      token: sessionToken,
      tokenType: 'Bearer',
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      expiresIn: claims.exp - claims.iat,
      user: { id: user.id, email: user.email, name: user.name },
      tenantId: result.tenantId,
      role: result.role,
    });
  } catch (err: unknown) {
    if (err instanceof LocalAuthConfigError) {
      res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
      return;
    }
    console.error('[Auth] register-with-invite failed:', errorMessage(err));
    res.status(500).json({ error: 'Registration failed' });
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

export default router;
