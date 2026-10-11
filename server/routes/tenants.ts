import { Router, Request, Response } from 'express';
import { getTenantRole, listTenantMembers, upsertTenantMember } from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may list members but never add or change them.
router.use(requireWriteRole);

const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** The tenant in the URL must be the tenant the caller authenticated against (x-tenant-id / token claims). */
function ensureActiveTenant(req: Request, res: Response): boolean {
  if (req.params.tenantId !== req.tenantId) {
    res.status(403).json({ error: 'Forbidden: the tenant in the URL does not match your active tenant' });
    return false;
  }
  return true;
}

/**
 * GET /api/v1/tenants/:tenantId/members
 * Lists the members of the active tenant and their roles.
 */
router.get('/:tenantId/members', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;

  try {
    const members = await listTenantMembers(tenantId);
    res.json({ tenantId, totalCount: members.length, members });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to list members for ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to list tenant members' });
  }
});

/**
 * POST /api/v1/tenants/:tenantId/members
 * Adds a user to the tenant, or changes the role of an existing member (upsert on user + tenant).
 * Body: { userId, email, name?, role }.
 * Caller must be a TENANT_OWNER or MSP_ADMIN (enforced by requireWriteRole). Additional rules:
 *   - only an MSP_ADMIN may grant or change the MSP_ADMIN role (no self-service privilege escalation);
 *   - nobody may change their own role.
 */
router.post('/:tenantId/members', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;

  const { userId, email, name, role } = req.body ?? {};

  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    res.status(400).json({ error: 'Invalid userId: 1-128 characters of letters, digits and . _ : @ -' });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }
  if (!isTenantRole(role)) {
    res.status(400).json({ error: 'Invalid role: expected TENANT_OWNER, MSP_ADMIN, ASSESSOR or VIEWER' });
    return;
  }
  if (name !== undefined && (typeof name !== 'string' || name.length > 255)) {
    res.status(400).json({ error: 'Invalid name' });
    return;
  }

  if (userId === req.user?.uid) {
    res.status(403).json({ error: 'Forbidden: you cannot change your own role' });
    return;
  }

  const existingRole = await getTenantRole(userId, tenantId);
  const callerIsMspAdmin = req.tenantRole === 'MSP_ADMIN';
  if ((role === 'MSP_ADMIN' || existingRole === 'MSP_ADMIN') && !callerIsMspAdmin) {
    res.status(403).json({ error: 'Forbidden: only an MSP Admin can grant or change the MSP Admin role' });
    return;
  }

  try {
    const member = await upsertTenantMember(tenantId, {
      userId,
      email: email.trim().toLowerCase(),
      name: (typeof name === 'string' && name.trim()) || email.split('@')[0],
      role,
    });
    console.log(
      `[Tenants API] ${req.user?.uid} set ${userId} to ${role} in ${tenantId} (previously ${existingRole ?? 'not a member'})`
    );
    res.status(existingRole ? 200 : 201).json({ tenantId, created: !existingRole, previousRole: existingRole, member });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to save member for ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to save tenant member' });
  }
});

export default router;
