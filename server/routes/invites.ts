import { Router, Request, Response } from 'express';
import { previewInvitation, redeemInvitation } from '../invitations';
import { authOnlyMiddleware } from '../middleware/authMiddleware';
import { recordAccountEventBestEffort } from '../auth/accountEvents';
import { invalidateMfaRequirement } from '../auth/mfaEnforcement';
import { createRateLimiter } from '../middleware/rateLimit';
import { errorMessage } from '../../src/utils/errors';

/**
 * Invitation redemption by the INVITEE (mounted at /api/v1/invites).
 *  - POST /preview: public, token only. Lets the accept page show which organisation and role before sign-in.
 *  - POST /accept:  authenticated. Consumes the token and adds the caller to the tenant.
 * The token travels in the request body, never the URL, so it stays out of access logs and browser history.
 */
const router = Router();

export const inviteRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
router.use(inviteRateLimiter);

const TOKEN_PATTERN = /^inv_[A-Za-z0-9_-]{20,128}$/;

function tokenFrom(req: Request): string | null {
  const token = (req.body ?? {}).token;
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null;
}

router.post('/preview', async (req: Request, res: Response): Promise<void> => {
  const token = tokenFrom(req);
  if (!token) {
    res.status(404).json({ error: 'Invitation not found' }); // a malformed token is just an unknown one
    return;
  }
  try {
    const preview = await previewInvitation(token);
    if (!preview) {
      res.status(404).json({ error: 'Invitation not found' });
      return;
    }
    res.json({ invitation: preview });
  } catch (err: unknown) {
    console.error('[Invites API] preview failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to look up the invitation' });
  }
});

const REASON_RESPONSES = {
  invalid: { status: 404, error: 'Invitation not found' },
  expired: { status: 410, error: 'This invitation has expired. Ask your administrator to send a new one.' },
  revoked: { status: 410, error: 'This invitation has been revoked by the organisation.' },
  used: { status: 409, error: 'This invitation has already been used.' },
  email_mismatch: { status: 403, error: 'This invitation was issued to a different email address. Sign in with the invited address.' },
} as const;

router.post('/accept', authOnlyMiddleware, async (req: Request, res: Response): Promise<void> => {
  const token = tokenFrom(req);
  if (!token) {
    res.status(404).json({ error: 'Invitation not found' });
    return;
  }
  const user = req.user!;
  try {
    const result = await redeemInvitation(token, { uid: user.uid, email: user.email, name: user.name });
    if (!result.ok) {
      const { status, error } = REASON_RESPONSES[result.reason];
      console.warn('[Invites API] accept refused (' + result.reason + ') for ' + user.uid);
      res.status(status).json({ error, reason: result.reason });
      return;
    }
    // The invited role may be privileged: look the second-factor requirement up afresh on this person's next request.
    invalidateMfaRequirement(user.uid);
    await recordAccountEventBestEffort({
      actorKind: 'user',
      actorUserId: user.uid,
      targetUserId: user.uid,
      action: 'role_changed',
      scopeTenantId: result.tenantId,
      details: { ...(result.previousRole ? { previousRole: result.previousRole } : {}), newRole: result.role, via: 'invitation' },
    });
    console.log('[Invites API] ' + user.uid + ' accepted invitation ' + result.invitationId + ' -> ' + result.tenantId + ' as ' + result.role);
    res.json({ tenantId: result.tenantId, role: result.role, previousRole: result.previousRole });
  } catch (err: unknown) {
    console.error('[Invites API] accept failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to accept the invitation' });
  }
});

export default router;
