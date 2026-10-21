import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { LocalAuthConfigError, getMfaRequirement, signLocalToken, signMfaPendingToken, validateNewPassword } from '../auth/localAuth';
import { isMfaRequiredFor } from '../auth/mfaPolicy';
import { LocalUserExistsError, createLocalUser, deleteLocalUser, normalizeEmail } from '../auth/localUsers';
import { TenantExistsError, createTenantWithOwner } from '../db';
import { createInvitation } from '../invitations';
import {
  addPlatformAdmin,
  claimSetup,
  isSetupRequired,
  releaseSetupClaim,
  removePlatformAdmin,
  setupTokenMatches,
} from '../platformSetup';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import type { TenantRole } from '../../src/types/tenant';

/**
 * First-time setup wizard API, mounted at /api/v1/setup (public: nobody has an account yet).
 *
 * SECURITY: this is the one unauthenticated endpoint that creates an administrator, so it is open ONLY while the
 * installation has no administrator at all, and it closes for good the moment setup completes (see platformSetup.ts):
 *   - the first thing it checks is whether setup is still needed; once the lock exists every request gets 409;
 *   - the lock is claimed with one atomic INSERT, so two simultaneous requests cannot both create an administrator;
 *   - everything is validated BEFORE anything is written, and a failure part-way undoes what was written, including
 *     giving the lock back, so a half-finished attempt cannot strand the install or leave a stray account behind;
 *   - it is throttled per address;
 *   - SETUP_TOKEN, when set, must accompany the request: an operator who exposes a fresh install before they have
 *     completed setup can require proof that the person at the keyboard is the one who started the container.
 */
const router = Router();

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_INVITES = 50;
const INVITE_DAYS = 14;

// ---- per-IP throttle: setup is a one-off, so the limit is tight
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const attemptsByIp = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attemptsByIp.set(ip, recent);
  if (attemptsByIp.size > 1_000) attemptsByIp.clear();
  return recent.length > MAX_PER_WINDOW;
}

/** Test hook. */
export function __resetSetupThrottleForTests(): void {
  attemptsByIp.clear();
}

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

/**
 * GET /api/v1/setup/status   (public)
 * { setupRequired, tokenRequired }. `setupRequired` is false whenever an administrator exists (or the install already has data),
 * which is what makes the browser send everyone to the login page instead of the wizard.
 * Fails closed: if the database cannot be read the answer is "not required".
 */
router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const required = await isSetupRequired();
    res.json({ setupRequired: required, tokenRequired: required && Boolean((process.env.SETUP_TOKEN ?? '').trim()) });
  } catch (err: unknown) {
    console.error('[Setup] Could not read setup status:', errorMessage(err));
    res.json({ setupRequired: false, tokenRequired: false });
  }
});

interface ParsedSetup {
  companyName: string;
  adminName: string;
  email: string;
  password: string;
  inviteRole: TenantRole;
  invites: string[];
}

function parseBody(body: unknown): { value: ParsedSetup } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const companyName = typeof b.companyName === 'string' ? b.companyName.trim() : '';
  if (!companyName || companyName.length > 200) return { error: 'Company name is required (up to 200 characters)' };

  const email = typeof b.email === 'string' ? normalizeEmail(b.email) : '';
  if (!EMAIL_PATTERN.test(email) || email.length > 255) return { error: 'A valid administrator email address is required' };

  const adminName = typeof b.adminName === 'string' ? b.adminName.trim() : '';
  if (adminName.length > 255) return { error: 'Name is too long' };

  const password = b.password;
  if (typeof password !== 'string') return { error: 'A password is required' };
  const problem = validateNewPassword(password, email);
  if (problem) return { error: problem };

  const role = b.inviteRole === undefined ? 'ASSESSOR' : b.inviteRole;
  // Teammates invited during setup never get MSP_ADMIN: that role is granted later by an MSP Admin.
  if (!isTenantRole(role) || role === 'MSP_ADMIN') return { error: 'Invalid role for invited teammates' };

  const rawInvites = b.invites === undefined ? [] : b.invites;
  if (!Array.isArray(rawInvites) || rawInvites.length > MAX_INVITES) return { error: `Invite at most ${MAX_INVITES} teammates during setup` };
  const invites: string[] = [];
  for (const item of rawInvites) {
    const e = typeof item === 'string' ? normalizeEmail(item) : '';
    if (!EMAIL_PATTERN.test(e)) return { error: `"${String(item).slice(0, 80)}" is not a valid email address` };
    if (e !== email && !invites.includes(e)) invites.push(e); // the administrator is already a member
  }
  return { value: { companyName, adminName, email, password, inviteRole: role, invites } };
}

/**
 * POST /api/v1/setup   (public; open only until the first administrator exists)
 * Body: { companyName, email, password, adminName?, invites?: string[], inviteRole?, setupToken? }.
 * Creates, in order: the administrator's local account, the platform-administrator record (which also takes the
 * one-time lock), the primary tenant with the administrator as its TENANT_OWNER, and an invitation per teammate.
 * Responds 201 with a signed-in session for the new administrator (or, when MFA_REQUIRED is not `off`, { mfa: 'enrol', mfaToken }:
 * the administrator enrols a second factor first) and one-time invitation tokens (the server keeps
 * only their hashes; with no mail server on an air-gapped install, the administrator hands the links out).
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (throttled(req.ip || 'unknown')) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000));
    res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    return;
  }

  try {
    // 1. Closed for good once an administrator exists. Nothing else is looked at, so a locked install reveals nothing.
    if (!(await isSetupRequired())) {
      res.status(409).json({ error: 'Setup has already been completed on this installation.', code: 'setup_complete' });
      return;
    }
    // 2. Proof of presence, when the operator asked for it
    if (!setupTokenMatches((req.body ?? {}).setupToken)) {
      console.warn(`[Setup] Rejected setup attempt with a wrong setup token from ${req.ip}`);
      res.status(403).json({ error: 'The setup token is missing or incorrect.', code: 'invalid_setup_token' });
      return;
    }
    // 3. Validate everything before writing anything
    const parsed = parseBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const input = parsed.value;

    // 4. The administrator's account
    let user;
    try {
      user = await createLocalUser({ email: input.email, name: input.adminName, password: input.password });
    } catch (err: unknown) {
      if (err instanceof LocalUserExistsError) {
        res.status(409).json({ error: 'An account for this email already exists.', code: 'account_exists' });
        return;
      }
      throw err;
    }

    // 5. Take the one-time lock. If a concurrent request beat us to it, undo our account and stop.
    let claimed = false;
    let adminAdded = false;
    const undo = async (): Promise<void> => {
      if (adminAdded) await removePlatformAdmin(user.id).catch(() => undefined);
      if (claimed) await releaseSetupClaim().catch(() => undefined);
      await deleteLocalUser(user.id).catch(() => undefined);
    };
    try {
      claimed = await claimSetup(user.id);
      if (!claimed) {
        await deleteLocalUser(user.id);
        res.status(409).json({ error: 'Setup has already been completed on this installation.', code: 'setup_complete' });
        return;
      }
      await addPlatformAdmin({ userId: user.id, email: user.email });
      adminAdded = true;

      // 6. The primary tenant (atomic with its owner row)
      const orgName = input.companyName;
      const owner = { userId: user.id, email: user.email, name: user.name };
      let tenant;
      for (let attempt = 0; attempt < 3 && !tenant; attempt++) {
        try {
          tenant = (
            await createTenantWithOwner(
              {
                id: `tenant-${slugify(orgName)}-${crypto.randomBytes(4).toString('hex')}`,
                name: orgName,
                systemName: `${orgName} Enclave`,
                systemOwner: user.name,
                enabledFrameworks: ['CMMC_L1'],
                primaryFramework: 'CMMC_L1',
              },
              owner
            )
          ).tenant;
        } catch (err: unknown) {
          if (!(err instanceof TenantExistsError)) throw err;
        }
      }
      if (!tenant) throw new Error('Failed to allocate a unique tenant id');

      // 7. Team invitations. The installation is fully set up by now, so one bad invite must not undo it: report each.
      const invites: Array<{ email: string; role: TenantRole; token?: string; expiresAt?: string; error?: string }> = [];
      for (const email of input.invites) {
        try {
          const created = await createInvitation(tenant.id, {
            email,
            role: input.inviteRole,
            createdBy: user.email,
            createdByUserId: user.id,
            expiresInDays: INVITE_DAYS,
          });
          invites.push({ email, role: input.inviteRole, token: created.token, expiresAt: created.invitation.expiresAt });
        } catch (err: unknown) {
          invites.push({ email, role: input.inviteRole, error: errorMessage(err) || 'Invitation failed' });
        }
      }

      console.log(`[Setup] First-time setup completed: ${user.email} is the platform administrator; tenant ${tenant.id} created; ${invites.filter((i) => i.token).length} invitation(s) staged. Setup is now locked.`);
      const summary = { user: { id: user.id, email: user.email, name: user.name }, tenant: { id: tenant.id, name: tenant.name }, invites };
      // A platform administrator is always privileged: whenever MFA_REQUIRED is not `off`, the first administrator enrols a
      // second factor before getting a session (the wizard continues with the enrol-stage token).
      if (isMfaRequiredFor(getMfaRequirement(), { isPlatformAdmin: true, tenantRoles: ['TENANT_OWNER'] })) {
        const pending = signMfaPendingToken({ id: user.id, tokenVersion: user.tokenVersion }, 'enrol');
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({
          mfa: 'enrol',
          mfaToken: pending.token,
          expiresAt: new Date(pending.claims.exp * 1000).toISOString(),
          ...summary,
        });
        return;
      }
      const { token, claims } = signLocalToken({ id: user.id, email: user.email, name: user.name, tokenVersion: user.tokenVersion }, { amr: ['pwd'] });
      res.status(201).json({
        token,
        tokenType: 'Bearer',
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        expiresIn: claims.exp - claims.iat,
        mustChangePassword: false,
        mfaEnrolled: false,
        ...summary,
      });
    } catch (err: unknown) {
      await undo();
      throw err;
    }
  } catch (err: unknown) {
    if (err instanceof LocalAuthConfigError) {
      res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
      return;
    }
    console.error('[Setup] Setup failed:', errorMessage(err));
    res.status(500).json({ error: 'Setup failed. Nothing was changed; check the server log and try again.' });
  }
});

export default router;
