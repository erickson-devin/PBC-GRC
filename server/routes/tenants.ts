import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import {
  MyTenant,
  TenantExistsError,
  createTenantWithOwner,
  getTenantRole,
  listTenantMembers,
  listUserTenants,
  removeTenantMember,
  updateTenantSettings,
  upsertTenantMember,
  TenantSettingsPatch,
} from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import tenantInvitesRouter from './tenantInvites';
import tenantAssetsRouter from './assets';
import { isTenantRole } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

const ALLOWED_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CAGE_PATTERN = /^[A-Za-z0-9]{5}$/;

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'org';
}

/**
 * GET /api/v1/tenants   (authenticate-only: no x-tenant-id needed)
 * The tenants the signed-in user can access, each with THEIR role in it. This is what the UI should treat as the
 * source of truth for "which tenants do I have and what may I do", instead of cached browser state.
 *
 * Sources, matching what authMiddleware enforces:
 *   - membership: a tenant_users row (read in user context; see the discovery RLS policies)
 *   - claim:      a tenant the token grants access to (`roles` map, tenant_id, tenant_ids). Like in
 *                 authMiddleware, a `roles` claim wins over the tenant_users row.
 */
export async function listMyTenantsHandler(req: Request, res: Response): Promise<void> {
  const user = req.user!;

  try {
    const memberships = await listUserTenants(user.uid);
    const byId = new Map<string, MyTenant & { source: 'membership' | 'claim' }>(
      memberships.map((m) => [m.id, { ...m, source: 'membership' as const }])
    );

    // Every tenant the token grants access to. Effective role mirrors authMiddleware: the `roles` claim, else the
    // tenant_users row, else read-only VIEWER.
    for (const tenantId of new Set([...(req.claimedTenantIds ?? []), ...Object.keys(user.roles ?? {})])) {
      if (!TENANT_ID_PATTERN.test(tenantId)) continue;
      const claimed = user.roles?.[tenantId];
      const existing = byId.get(tenantId);
      const role: TenantRole = isTenantRole(claimed) ? claimed : existing?.role ?? 'VIEWER';
      if (existing) {
        existing.role = role;
        existing.source = 'claim';
      } else {
        byId.set(tenantId, {
          id: tenantId,
          name: tenantId,
          cageCode: null,
          samStatus: 'ACTIVE',
          systemName: '',
          systemOwner: '',
          industry: '',
          enabledFrameworks: [],
          primaryFramework: 'CMMC_L1',
          licenseTier: 'FOUNDATIONAL',
          createdAt: null,
          role,
          joinedAt: new Date(0).toISOString(),
          source: 'claim',
        });
      }
    }

    const tenants = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ userId: user.uid, totalCount: tenants.length, tenants });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to list tenants for ${user.uid}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to list tenants' });
  }
}

const SAM_STATUSES = ['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED'];

type FieldResult = { error: string } | { value: TenantSettingsPatch };

/**
 * Validates tenant settings from a request body. `create` requires a name; `patch` requires at least one field.
 * Unknown fields (notably licenseTier, id, createdAt) are ignored: they cannot be set through this API.
 */
function parseTenantFields(body: unknown, mode: 'create' | 'patch'): FieldResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const value: TenantSettingsPatch = {};

  if (b.name !== undefined || mode === 'create') {
    if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 255) {
      return { error: 'Invalid name: 2-255 characters required' };
    }
    value.name = b.name.trim();
  }
  if (b.cageCode !== undefined) {
    if (typeof b.cageCode !== 'string' || !CAGE_PATTERN.test(b.cageCode)) return { error: 'Invalid cageCode: 5 letters or digits' };
    value.cageCode = b.cageCode.toUpperCase();
  }
  if (b.samStatus !== undefined) {
    if (typeof b.samStatus !== 'string' || !SAM_STATUSES.includes(b.samStatus)) {
      return { error: 'Invalid samStatus: expected one of ' + SAM_STATUSES.join(', ') };
    }
    value.samStatus = b.samStatus;
  }
  for (const [field, max] of [['systemName', 255], ['systemOwner', 255], ['industry', 128]] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) return { error: 'Invalid ' + field };
    value[field] = v.trim();
  }
  if (b.primaryFramework !== undefined) {
    if (typeof b.primaryFramework !== 'string' || !ALLOWED_FRAMEWORKS.includes(b.primaryFramework)) {
      return { error: 'Invalid primaryFramework: expected one of ' + ALLOWED_FRAMEWORKS.join(', ') };
    }
    value.primaryFramework = b.primaryFramework;
  }
  if (b.enabledFrameworks !== undefined) {
    const list = b.enabledFrameworks;
    if (!Array.isArray(list) || list.length === 0 || !list.every((f) => typeof f === 'string' && ALLOWED_FRAMEWORKS.includes(f))) {
      return { error: 'Invalid enabledFrameworks: a non-empty list of supported frameworks' };
    }
    value.enabledFrameworks = [...new Set(list as string[])];
  }

  if (mode === 'patch' && Object.keys(value).length === 0) return { error: 'No updatable fields supplied' };
  return { value };
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
  const parsed = parseTenantFields(req.body, 'create');
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const fields = parsed.value;
  const primary = fields.primaryFramework ?? 'CMMC_L1';
  const enabledList = [...new Set([primary, ...(fields.enabledFrameworks ?? [])])];

  const orgName = fields.name!;
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
          cageCode: fields.cageCode,
          samStatus: fields.samStatus,
          systemName: fields.systemName || `${orgName} Enclave`,
          systemOwner: fields.systemOwner || owner.name,
          industry: fields.industry,
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

// Invitations: /api/v1/tenants/:tenantId/invites (create / list / revoke / resend / extend / edit)
router.use('/:tenantId/invites', tenantInvitesRouter);
router.use('/:tenantId/assets', tenantAssetsRouter);

const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

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

/**
 * DELETE /api/v1/tenants/:tenantId/members/:userId
 * Removes a member. Owner / MSP admin only. You cannot remove yourself, only an MSP admin can remove an MSP admin,
 * and the last TENANT_OWNER cannot be removed (the tenant would be left with nobody able to manage it).
 */
router.delete('/:tenantId/members/:userId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const userId = String(req.params.userId);

  if (!USER_ID_PATTERN.test(userId)) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }
  if (userId === req.user?.uid) {
    res.status(403).json({ error: 'Forbidden: you cannot remove yourself' });
    return;
  }

  try {
    const targetRole = await getTenantRole(userId, tenantId);
    if (!targetRole) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (targetRole === 'MSP_ADMIN' && req.tenantRole !== 'MSP_ADMIN') {
      res.status(403).json({ error: 'Forbidden: only an MSP Admin can remove an MSP Admin' });
      return;
    }
    if (targetRole === 'TENANT_OWNER') {
      const owners = (await listTenantMembers(tenantId)).filter((m) => m.role === 'TENANT_OWNER');
      if (owners.length <= 1) {
        res.status(409).json({ error: 'The last Tenant Owner cannot be removed. Promote another member first.' });
        return;
      }
    }
    await removeTenantMember(tenantId, userId);
    console.log('[Tenants API] ' + req.user?.uid + ' removed ' + userId + ' (' + targetRole + ') from ' + tenantId);
    res.json({ removed: true, userId, previousRole: targetRole });
  } catch (err: unknown) {
    console.error('[Tenants API] Failed to remove member:', errorMessage(err));
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * PATCH /api/v1/tenants/:tenantId
 * Updates the tenant's settings (name, CAGE code, SAM status, system name/owner, industry, frameworks).
 * Owner / MSP admin only (requireWriteRole). The license tier cannot be changed here.
 */
router.patch('/:tenantId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;

  const parsed = parseTenantFields(req.body, 'patch');
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const tenant = await updateTenantSettings(tenantId, parsed.value);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    console.log('[Tenants API] ' + req.user?.uid + ' updated ' + tenantId + ': ' + Object.keys(parsed.value).join(', '));
    res.json({ tenant });
  } catch (err: unknown) {
    console.error('[Tenants API] Failed to update ' + tenantId + ':', errorMessage(err));
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

export default router;
