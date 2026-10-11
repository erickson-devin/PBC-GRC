import { Router, Request, Response } from 'express';
import {
  LocalAuthConfigError,
  getDummyHash,
  isLocalAuthMode,
  signLocalToken,
  verifyPassword,
} from '../auth/localAuth';
import {
  findLocalUserByEmail,
  registerFailedLogin,
  registerSuccessfulLogin,
} from '../auth/localUsers';
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
 * GET /api/v1/auth/me
 * The authenticated user's profile as the server sees it.
 */
router.get('/me', authOnlyMiddleware, (req: Request, res: Response): void => {
  const { uid, email, name } = req.user!;
  res.json({ user: { id: uid, email, name } });
});

export default router;
