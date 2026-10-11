import { Router, Request, Response } from 'express';
import {
  InvitationError,
  InvitationRecord,
  MAX_INVITE_DAYS,
  createInvitation,
  extendInvitation,
  listInvitations,
  revokeInvitation,
  rotateInvitation,
  updateInvitation,
} from '../invitations';
import { ensureActiveTenant, ensureTenantAdmin } from './tenantGuards';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import type { TenantRole } from '../../src/types/tenant';

/**
 * Tenant-scoped invitation management, mounted at /api/v1/tenants/:tenantId/invites by the tenants router, AFTER
 * requireWriteRole: every write is already limited to TENANT_OWNER / MSP_ADMIN, and reading the list is checked here.
 * The plaintext token is only ever returned by create and resend, once.
 */
const router = Router({ mergeParams: true });

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** Only an MSP admin may hand out (or touch an invitation for) the MSP_ADMIN role: no self-service escalation. */
function mayHandle(req: Request, res: Response, role: TenantRole): boolean {
  if (role === 'MSP_ADMIN' && req.tenantRole !== 'MSP_ADMIN') {
    res.status(403).json({ error: 'Forbidden: only an MSP Admin can invite or change an MSP Admin' });
    return false;
  }
  return true;
}

function sendInvitationError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof InvitationError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'limit' ? 429 : 409;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[Invitations API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const publicView = (r: InvitationRecord) => r; // records never contain the token or its hash

/** GET /api/v1/tenants/:tenantId/invites: every invitation (pending, accepted, revoked, expired). No tokens. */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res) || !ensureTenantAdmin(req, res)) return;
  try {
    const invitations = await listInvitations(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: invitations.length, invitations: invitations.map(publicView) });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to list invitations');
  }
});

/**
 * POST /api/v1/tenants/:tenantId/invites
 * Body: { email, role, expiresInDays? }. Returns { invitation, token }: the token is shown ONCE; the server keeps
 * only its hash. An earlier pending invitation for the same email is revoked.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { email, role, expiresInDays } = req.body ?? {};

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }
  if (!isTenantRole(role)) {
    res.status(400).json({ error: 'Invalid role: expected TENANT_OWNER, MSP_ADMIN, ASSESSOR or VIEWER' });
    return;
  }
  if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || !Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_INVITE_DAYS)) {
    res.status(400).json({ error: 'Invalid expiresInDays: between 1 and ' + MAX_INVITE_DAYS });
    return;
  }
  if (!mayHandle(req, res, role)) return;

  const user = req.user!;
  try {
    const { invitation, token } = await createInvitation(req.tenantId!, {
      email,
      role,
      expiresInDays,
      createdBy: user.name ? user.name + ' (' + (user.email ?? user.uid) + ')' : user.email ?? user.uid,
      createdByUserId: user.uid,
    });
    console.log('[Invitations API] ' + user.uid + ' invited ' + invitation.email + ' as ' + role + ' to ' + req.tenantId);
    res.status(201).json({ invitation: publicView(invitation), token });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to create invitation');
  }
});

/** POST .../invites/:inviteId/resend: issues a NEW token (the old link stops working) and restarts the expiry. */
router.post('/:inviteId/resend', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { expiresInDays } = req.body ?? {};
  if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > MAX_INVITE_DAYS)) {
    res.status(400).json({ error: 'Invalid expiresInDays: between 1 and ' + MAX_INVITE_DAYS });
    return;
  }
  try {
    const existing = (await listInvitations(req.tenantId!)).find((i) => i.id === req.params.inviteId);
    if (existing && !mayHandle(req, res, existing.role)) return;
    const { invitation, token } = await rotateInvitation(req.tenantId!, String(req.params.inviteId), expiresInDays);
    res.json({ invitation: publicView(invitation), token });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to resend invitation');
  }
});

/** POST .../invites/:inviteId/extend  { days }: pushes the expiry out; the link stays the same. */
router.post('/:inviteId/extend', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { days } = req.body ?? {};
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 1 || days > MAX_INVITE_DAYS) {
    res.status(400).json({ error: 'Invalid days: between 1 and ' + MAX_INVITE_DAYS });
    return;
  }
  try {
    const existing = (await listInvitations(req.tenantId!)).find((i) => i.id === req.params.inviteId);
    if (existing && !mayHandle(req, res, existing.role)) return;
    res.json({ invitation: publicView(await extendInvitation(req.tenantId!, String(req.params.inviteId), days)) });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to extend invitation');
  }
});

/** PATCH .../invites/:inviteId  { email?, role? }: edits an invitation that has not been used. */
router.patch('/:inviteId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { email, role } = req.body ?? {};
  if (email === undefined && role === undefined) {
    res.status(400).json({ error: 'No updatable fields supplied' });
    return;
  }
  if (email !== undefined && (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim()))) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }
  if (role !== undefined && !isTenantRole(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  try {
    const existing = (await listInvitations(req.tenantId!)).find((i) => i.id === req.params.inviteId);
    if (existing && !mayHandle(req, res, existing.role)) return;
    if (role !== undefined && !mayHandle(req, res, role)) return;
    res.json({ invitation: publicView(await updateInvitation(req.tenantId!, String(req.params.inviteId), { email, role })) });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to update invitation');
  }
});

/** DELETE .../invites/:inviteId: revokes. An accepted invitation cannot be revoked (remove the member instead). */
router.delete('/:inviteId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const existing = (await listInvitations(req.tenantId!)).find((i) => i.id === req.params.inviteId);
    if (existing && !mayHandle(req, res, existing.role)) return;
    const invitation = await revokeInvitation(req.tenantId!, String(req.params.inviteId));
    console.log('[Invitations API] ' + req.user?.uid + ' revoked invitation ' + invitation.id + ' in ' + req.tenantId);
    res.json({ invitation: publicView(invitation) });
  } catch (err: unknown) {
    sendInvitationError(res, err, 'Failed to revoke invitation');
  }
});

export default router;
