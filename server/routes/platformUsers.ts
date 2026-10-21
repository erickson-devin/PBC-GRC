import { Router, Request, Response, NextFunction } from 'express';
import { hashPassword, validateNewPassword } from '../auth/localAuth';
import {
  clearLocalUserMfa,
  findLocalUserById,
  listLocalUsers,
  resetLocalUserMfa,
  setLocalUserDisabled,
  setLocalUserPassword,
  type LocalUser,
} from '../auth/localUsers';
import { isPlatformAdminUser } from '../auth/platformAdmin';
import { errorMessage } from '../../src/utils/errors';

/**
 * Local-account administration, mounted at /api/v1/platform/users behind authOnlyMiddleware. Platform administrators only.
 * An administrator can never act on their own account here (409 self): their own credential change goes through
 * POST /auth/password, which asks for the current credential and the second-factor code. Only actor and target emails are logged.
 */
const router = Router();

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json({ error: 'Forbidden: only a platform administrator can manage local accounts' });
      return;
    }
    next();
  } catch (err: unknown) {
    console.error('[PlatformUsers] Administrator check failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to check administrator rights' });
  }
});

/** What the console may see of an account: never a hash, a secret or a recovery digest. */
function summarize(u: Pick<LocalUser, 'id' | 'email' | 'name' | 'disabled' | 'lockedUntil' | 'lastLoginAt' | 'createdAt' | 'mustChangePassword'> & { mfaEnrolled: boolean }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    disabled: u.disabled,
    mfaEnrolled: u.mfaEnrolled,
    mustChangePassword: u.mustChangePassword,
    lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

const summarizeStored = (u: LocalUser) => summarize({ ...u, mfaEnrolled: u.totpConfirmedAt !== null });

/** Resolves :userId to the target account, or answers (400 / 409 self / 404) and returns null. */
async function resolveTarget(req: Request, res: Response): Promise<LocalUser | null> {
  const id = String(req.params.userId ?? '');
  if (!USER_ID_PATTERN.test(id)) {
    res.status(400).json({ error: 'Invalid user id', reason: 'invalid_request' });
    return null;
  }
  if (id === req.user!.uid) {
    res.status(409).json({ error: 'You cannot do this to your own account here', reason: 'self' });
    return null;
  }
  const target = await findLocalUserById(id);
  if (!target) {
    res.status(404).json({ error: 'No such account', reason: 'not_found' });
    return null;
  }
  return target;
}

const failed = (res: Response, err: unknown, what: string): void => {
  console.error('[PlatformUsers] ' + what + ' failed:', errorMessage(err));
  res.status(500).json({ error: what + ' failed' });
};

/** GET /api/v1/platform/users: every local account, for the administration console. */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ users: (await listLocalUsers()).map(summarize) });
  } catch (err: unknown) {
    failed(res, err, 'Listing accounts');
  }
});

/**
 * POST /api/v1/platform/users/:userId/reset-password   Body: { newPassword }
 * Sets a TEMPORARY credential: the person must change it at their next sign-in (nothing else works until they do). Every session
 * of theirs ends, their second factor and recovery codes are removed (they enrol again), and a lockout is cleared.
 */
router.post('/:userId/reset-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    const { newPassword } = req.body ?? {};
    const problem = typeof newPassword === 'string' ? validateNewPassword(newPassword, target.email) : 'A new temporary credential is required';
    if (problem) {
      res.status(400).json({ error: problem, reason: 'weak_password' });
      return;
    }
    await setLocalUserPassword(target.id, await hashPassword(newPassword), { mustChangePassword: true });
    await resetLocalUserMfa(target.email); // clears the factor and the recovery codes, bumps the token version, clears the lockout
    console.log(`[PlatformUsers] ${req.user!.email} reset the sign-in credential of ${target.email} (change required at next sign-in)`);
    const updated = (await findLocalUserById(target.id)) ?? target;
    res.json({
      user: summarizeStored(updated),
      mustChangePassword: true,
      message: 'The temporary credential is set. The person must change it at their next sign-in, and must enrol a second factor again.',
    });
  } catch (err: unknown) {
    failed(res, err, 'Credential reset');
  }
});

/** POST /api/v1/platform/users/:userId/reset-mfa: removes the second factor and recovery codes and ends their sessions. */
router.post('/:userId/reset-mfa', async (req: Request, res: Response): Promise<void> => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    await clearLocalUserMfa(target.id);
    console.log(`[PlatformUsers] ${req.user!.email} removed the second factor of ${target.email}`);
    res.json({ user: summarizeStored((await findLocalUserById(target.id)) ?? target) });
  } catch (err: unknown) {
    failed(res, err, 'Second factor reset');
  }
});

/** POST /api/v1/platform/users/:userId/disable: blocks sign-in, ends their sessions and removes the factor. */
router.post('/:userId/disable', async (req: Request, res: Response): Promise<void> => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    await setLocalUserDisabled(target.id, true);
    console.log(`[PlatformUsers] ${req.user!.email} disabled ${target.email}`);
    res.json({ user: summarizeStored((await findLocalUserById(target.id)) ?? target) });
  } catch (err: unknown) {
    failed(res, err, 'Disabling the account');
  }
});

/** POST /api/v1/platform/users/:userId/enable: allows sign-in again and clears a lockout. The factor is not restored. */
router.post('/:userId/enable', async (req: Request, res: Response): Promise<void> => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    await setLocalUserDisabled(target.id, false);
    console.log(`[PlatformUsers] ${req.user!.email} enabled ${target.email}`);
    res.json({ user: summarizeStored((await findLocalUserById(target.id)) ?? target) });
  } catch (err: unknown) {
    failed(res, err, 'Enabling the account');
  }
});

export default router;
