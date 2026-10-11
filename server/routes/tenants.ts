import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { TenantExistsError, createTenantWithOwner, getTenantRole, listTenantMembers, upsertTenantMember } from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

const ALLOWED_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];
const CAGE_PATTERN = /^[A-Za-z0-9]{5}$/;

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'org';
}

/**
 * POST /api/v1/tenants   (authenticate-only: the caller does not belong to any tenant yet)
 * Creates a tenant and makes the authenticated user its first TENANT_OWNER, atomically.
 * Body: { name, systemName?, systemOwner?, cageCode?, industry?, primaryFramework?, enabledFrameworks? }.
 * The license tier is never taken from the client: new tenants start on FOUNDATIONAL.
 * Set ALLOW_TENANT_CREATION=false to turn self-service creation off (e.g. when provisioning is admin-only).
 */
export async function createTenantHandler(req: Request, res: Response): Promise<void> {
  if (process.env.ALLOW_TENANT_CREATION === 'false') {
    res.status(403).json({ error: 'Forbidden: tenant creation is disabled on this server' });
    return;
  }

  const user = req.user!;
  const { name, systemName, systemOwner, cageCode, industry, primaryFramework, enabledFrameworks } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 255) {
    res.status(400).json({ error: 'Invalid name: 2-255 characters required' });
    return;
  }
  if (cageCode !== undefined && (typeof cageCode !== 'string' || !CAGE_PATTERN.test(cageCode))) {
    res.status(400).json({ error: 'Invalid cageCode: 5 letters or digits' });
    return;
  }
  for (const [field, value, max] of [['systemName', systemName, 255], ['systemOwner', systemOwner, 255], ['industry', industry, 128]] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
      res.status(400).json({ error: `Invalid ${field}` });
      return;
    }
  }
  const primary = primaryFramework === undefined ? 'CMMC_L1' : primaryFramework;
  if (typeof primary !== 'string' || !ALLOWED_FRAMEWORKS.includes(primary)) {
    res.status(400).json({ error: `Invalid primaryFramework: expected one of ${ALLOWED_FRAMEWORKS.join(', ')}` });
    return;
  }
  const enabled: unknown = enabledFrameworks === undefined ? [primary] : enabledFrameworks;
  if (!Array.isArray(enabled) || enabled.length === 0 || !enabled.every((f) => typeof f === 'string' && ALLOWED_FRAMEWORKS.includes(f))) {
    res.status(400).json({ error: 'Invalid enabledFrameworks: a non-empty list of supported frameworks' });
    return;
  }
  const enabledList = [...new Set([primary, ...(enabled as string[])])];

  const orgName = name.trim();
  const owner = {
    userId: user.uid,
    email: (user.email || `${user.uid}@no-email.invalid`).toLowerCase(),
    name: user.name || (user.email ? user.email.split('@')[0] : user.uid),
  };

  // Random suffix makes ids unguessable and collisions practically impossible; retry covers the rest.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `tenant-${slugify(orgName)}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      const created = await createTenantWithOwner(
        {
          id,
          name: orgName,
          cageCode: cageCode?.toUpperCase(),
          systemName: (typeof systemName === 'string' && systemName.trim()) || `${orgName} Enclave`,
          systemOwner: (typeof systemOwner === 'string' && systemOwner.trim()) || owner.name,
          industry,
          enabledFrameworks: enabledList,
          primaryFramework: primary,
          licenseTier: 'FOUNDATIONAL',
        },
        owner
      );
      console.log(`[Tenants API] ${owner.userId} created tenant ${id} and is its TENANT_OWNER`);
      res.status(201).json({ tenant: created.tenant, member: created.member, role: 'TENANT_OWNER' });
      return;
    } catch (err: unknown) {
      if (err instanceof TenantExistsError) continue;
      console.error('[Tenants API] Failed to create tenant:', errorMessage(err));
      res.status(500).json({ error: 'Failed to create tenant' });
      return;
    }
  }
  res.status(500).json({ error: 'Failed to allocate a unique tenant id; please retry' });
}

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
