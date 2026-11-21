import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import {
  MyTenant,
  MemberProfile,
  MemberProfilePatch,
  PrimaryContactConflictError,
  TenantExistsError,
  createTenantWithOwner,
  getTenantRole,
  listTenantMembers,
  listUserTenants,
  membershipNowMs,
  removeTenantMember,
  updateTenantMemberProfile,
  updateTenantSettings,
  upsertTenantMember,
  TenantSettingsPatch,
} from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { isPlatformAdminUser } from '../auth/platformAdmin';
import { recordAccountEventBestEffort } from '../auth/accountEvents';
import { invalidateMfaRequirement } from '../auth/mfaEnforcement';
import { getAccountDormantDays } from '../auth/localAuth';
import { findLocalUserById, getLocalUserAccountSummaries, setLocalUserDisabled, type LocalUserAccountSummary } from '../auth/localUsers';
import { requireAdminStepUp } from './auth';
import { ensureActiveTenant, ensureOwnerRole, roleNotGrantableBody } from './tenantGuards';
import tenantInvitesRouter from './tenantInvites';
import tenantAssetsRouter from './assets';
import tenantSoftwareRouter from './software';
import tenantInventoryRouter from './inventory';
import tenantDocumentsRouter from './documents';
import tenantTeamsRouter from './teams';
import tenantResponsibilitiesRouter from './responsibilities';
import sspImportsRouter from './sspImports';
import aiAssistRouter from './aiAssist';
import vmRouter from './vm';
import programsRouter from './programs';
import { optionalProgramContext, programContext } from '../middleware/programContext';
import { clearUserProgramDefault } from '../userProgramDefaults';
import { TENANT_ROLES, canChangeMemberRole, canManageRole, canRemoveMember, canRoleWrite, isOwnerLevel, isTenantRole } from '../../src/utils/roles';
import { checkNewExpiry, isAffiliation, isUsPerson, membershipExpired, type Affiliation, type UsPerson } from '../../src/utils/memberProfile';
import type { TenantRole } from '../../src/types/tenant';
import { errorMessage } from '../../src/utils/errors';
import { validateStackProfile } from '../../src/data/stackProfileSchema';

const router = Router();

const ALLOWED_FRAMEWORKS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY', 'NIST_800_171_R3'];
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
    const allMemberships = await listUserTenants(user.uid);
    // A membership whose access expiry date has passed is not offered (authMiddleware refuses it too); it is listed under expiredTenants so the
    // client can say so. A token claim for the same tenant is unaffected, as in authMiddleware.
    const nowMs = membershipNowMs();
    const memberships = allMemberships.filter((m) => !membershipExpired(m.accessExpiresOn, nowMs));
    const expiredTenants = allMemberships
      .filter((m) => membershipExpired(m.accessExpiresOn, nowMs))
      .map((m) => ({ id: m.id, name: m.name, expiredOn: m.accessExpiresOn ?? '' }));
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
          stackProfile: null,
          createdAt: null,
          role,
          joinedAt: new Date(0).toISOString(),
          accessExpiresOn: null,
          source: 'claim',
        });
      }
    }

    const tenants = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    // A claim-sourced tenant is not also reported as expired.
    res.json({ userId: user.uid, totalCount: tenants.length, tenants, expiredTenants: expiredTenants.filter((e) => !byId.has(e.id)) });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to list tenants for ${user.uid}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to list tenants' });
  }
}

const SAM_STATUSES = ['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED'];

type FieldResult = { error: string } | { value: TenantSettingsPatch };

/**
 * Validates tenant settings from a request body. `create` requires a name; `patch` requires at least one field.
 * Unknown fields (notably id, createdAt) are ignored: they cannot be set through this API.
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

  if (b.stackProfile !== undefined) {
    const checked = validateStackProfile(b.stackProfile);
    if (!checked.ok) return { error: 'Invalid stackProfile' };
    value.stackProfile = checked.value;
  }

  if (mode === 'patch' && Object.keys(value).length === 0) return { error: 'No updatable fields supplied' };
  return { value };
}

/**
 * POST /api/v1/tenants   (authenticate-only: the caller does not belong to any tenant yet)
 * Creates a tenant and makes the authenticated user its first TENANT_OWNER, atomically.
 * Body: { name, systemName?, systemOwner?, cageCode?, industry?, primaryFramework?, enabledFrameworks? }.
 * The assessment program (primaryFramework / enabledFrameworks) is decided by platform administrators (see
 * auth/platformAdmin.ts). Anyone else gets the default program, CMMC Level 1 only: what they send for it is ignored,
 * so a self-service tenant cannot be created with a wider scope.
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
  const admin = await isPlatformAdminUser(user);
  const primary = admin ? fields.primaryFramework ?? 'CMMC_L1' : 'CMMC_L1';
  const enabledList = admin ? [...new Set([primary, ...(fields.enabledFrameworks ?? [])])] : [primary];

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
        },
        owner
      );
      // The creator is now a TENANT_OWNER: a privileged role, so the second-factor requirement is looked up afresh on their next request.
      invalidateMfaRequirement(owner.userId);
      await recordAccountEventBestEffort({ actorKind: 'user', actorUserId: owner.userId, targetUserId: owner.userId, action: 'role_changed', scopeTenantId: id, details: { newRole: 'TENANT_OWNER', via: 'tenant_created' } });
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
router.use('/:tenantId/software', tenantSoftwareRouter);
// The Tools and Services register: tools, vendors and their history, tenant-wide (a program's boundary and links are /program-inventory)
router.use('/:tenantId/inventory', tenantInventoryRouter);
// The document register: governance documents, tenant-wide (a program's declared set, links and attachments are /program-documents)
router.use('/:tenantId/documents', tenantDocumentsRouter);
// Teams (named groups of members, for assignments) and the responsibilities of a person or a team across the programs; labels, they grant nothing
router.use('/:tenantId/teams', tenantTeamsRouter);
router.use('/:tenantId/responsibilities', tenantResponsibilitiesRouter);
// SSP imports resolve the program from x-program-id (409 program_required when the tenant has none); the VM module only optionally (most of it
// is tenant-wide); the programs API itself (it works on archived programs and names them in the URL) and ai-assist do not.
router.use('/:tenantId/programs', programsRouter);
router.use('/:tenantId/ssp-imports', programContext, sspImportsRouter);
router.use('/:tenantId/ai-assist', aiAssistRouter);
router.use('/:tenantId/vm', optionalProgramContext, vmRouter);

const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** What the member list shows of a local account (ISO times, no email or name): sign-in history and why it is disabled. */
function accountView(s: LocalUserAccountSummary) {
  return {
    lastLoginAt: s.lastLoginAt ? s.lastLoginAt.toISOString() : null,
    disabled: s.disabled,
    disabledReason: s.disabled ? (s.disabledReason ?? 'admin') : null,
    disabledAt: s.disabledAt ? s.disabledAt.toISOString() : null,
  };
}

/** What the write roles see of a member's profile (issues #258, #259): the expiry and whether it has passed, affiliation, US person flag. */
function membershipView(profile: MemberProfile, nowMs: number) {
  return {
    accessExpiresOn: profile.accessExpiresOn,
    expired: membershipExpired(profile.accessExpiresOn, nowMs),
    affiliation: profile.affiliation,
    usPerson: profile.usPerson,
    usPersonRecordedAt: profile.usPersonRecordedAt,
  };
}

/**
 * GET /api/v1/tenants/:tenantId/members
 * Lists the members of the active tenant and their roles. For the write roles each member also carries `account`: the sign-in and
 * disabled state of their local account (null when there is none); the read roles always get `account: null`. `dormantDays` is the
 * inactivity limit (0 = off), issue #257. Every role gets `primaryContact` (boolean); `membership` (access expiry, affiliation, US person
 * flag, issues #258, #259) is for the write roles and null for the others.
 */
router.get('/:tenantId/members', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;

  try {
    const listed = await listTenantMembers(tenantId);
    const summaries = canRoleWrite(req.tenantRole) ? await getLocalUserAccountSummaries(listed.map((m) => m.userId)) : new Map<string, LocalUserAccountSummary>();
    const canSeeProfile = canRoleWrite(req.tenantRole);
    const nowMs = membershipNowMs();
    const members = listed.map((m) => {
      // The profile is picked from, never spread: the read roles get the primary contact flag and nothing else of it.
      const { profile, ...rest } = m;
      const summary = summaries.get(m.userId);
      return {
        ...rest,
        account: summary ? accountView(summary) : null,
        primaryContact: profile.primaryContact,
        membership: canSeeProfile ? membershipView(profile, nowMs) : null,
      };
    });
    res.json({ tenantId, totalCount: members.length, members, dormantDays: getAccountDormantDays() });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to list members for ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to list tenant members' });
  }
});

/**
 * POST /api/v1/tenants/:tenantId/members
 * Adds a user to the tenant, or changes the role of an existing member (upsert on user + tenant).
 * Body: { userId, email, name?, role }.
 * Caller must be a TENANT_OWNER, TENANT_ADMIN or MSP_ADMIN (enforced by requireWriteRole). Additional rules:
 *   - the caller may only set a role it can grant and only change a member whose current role it can manage
 *     (canChangeMemberRole): an Admin manages Assessors and Viewers, an Owner everything but MSP_ADMIN, an MSP_ADMIN all;
 *   - nobody may change their own role;
 *   - the last TENANT_OWNER cannot be demoted.
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
    res.status(400).json({ error: 'Invalid role: expected one of ' + TENANT_ROLES.join(', ') });
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
  // The caller's role is req.tenantRole, never the body: the new role and the member's current role must both be ones it may manage.
  if (!canChangeMemberRole(req.tenantRole, existingRole, role)) {
    res.status(403).json(roleNotGrantableBody(req.tenantRole, existingRole && !canManageRole(req.tenantRole, existingRole) ? existingRole : role));
    return;
  }
  if (existingRole === 'TENANT_OWNER' && role !== 'TENANT_OWNER') {
    const owners = (await listTenantMembers(tenantId)).filter((m) => m.role === 'TENANT_OWNER');
    if (owners.length <= 1) {
      res.status(409).json({ error: 'The last Tenant Owner cannot be demoted. Promote another member first.', code: 'last_owner' });
      return;
    }
  }

  try {
    // An owner-level role never carries an expiry: a promotion clears it (the upsert does that), and the change is recorded below.
    const clearedExpiry = isOwnerLevel(role) && existingRole && !isOwnerLevel(existingRole)
      ? (await listTenantMembers(tenantId)).find((m) => m.userId === userId)?.profile.accessExpiresOn ?? null
      : null;
    const upserted = await upsertTenantMember(tenantId, {
      userId,
      email: email.trim().toLowerCase(),
      name: (typeof name === 'string' && name.trim()) || email.split('@')[0],
      role,
    });
    const { profile: _profile, ...member } = upserted;
    // A raised role may make the person subject to the second-factor requirement mid-session: look it up afresh on their next request.
    invalidateMfaRequirement(userId);
    await recordAccountEventBestEffort({
      actorKind: 'user',
      actorUserId: req.user?.uid ?? null,
      targetUserId: userId,
      action: 'role_changed',
      scopeTenantId: tenantId,
      details: { ...(existingRole ? { previousRole: existingRole } : {}), newRole: role, via: 'member_update' },
    });
    if (clearedExpiry !== null) {
      await recordAccountEventBestEffort({
        actorKind: 'user',
        actorUserId: req.user?.uid ?? null,
        targetUserId: userId,
        action: 'membership_updated',
        scopeTenantId: tenantId,
        details: { field: 'access_expiry', previousValue: clearedExpiry, newValue: 'none', reason: 'owner_level_role', via: 'member_update' },
      });
    }
    console.log(
      `[Tenants API] ${req.user?.uid} set ${userId} to ${role} in ${tenantId} (previously ${existingRole ?? 'not a member'})`
    );
    res.status(existingRole ? 200 : 201).json({ tenantId, created: !existingRole, previousRole: existingRole, member, ...(clearedExpiry !== null ? { accessExpiryCleared: true } : {}) });
  } catch (err: unknown) {
    console.error(`[Tenants API] Failed to save member for ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to save tenant member' });
  }
});

/**
 * DELETE /api/v1/tenants/:tenantId/members/:userId
 * Removes a member. Write roles only. You cannot remove yourself, you can only remove a member whose role you can manage
 * (canRemoveMember: an Admin cannot remove an Owner or another Admin, only an MSP admin removes an MSP admin),
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
    if (!canRemoveMember(req.tenantRole, targetRole)) {
      res.status(403).json(roleNotGrantableBody(req.tenantRole, targetRole));
      return;
    }
    if (targetRole === 'TENANT_OWNER') {
      const owners = (await listTenantMembers(tenantId)).filter((m) => m.role === 'TENANT_OWNER');
      if (owners.length <= 1) {
        res.status(409).json({ error: 'The last Tenant Owner cannot be removed. Promote another member first.', code: 'last_owner' });
        return;
      }
    }
    await removeTenantMember(tenantId, userId);
    await clearUserProgramDefault(tenantId, userId).catch((err: unknown) => console.warn('[Tenants API] Could not clear the default program of a removed member:', errorMessage(err)));
    await recordAccountEventBestEffort({ actorKind: 'user', actorUserId: req.user?.uid ?? null, targetUserId: userId, action: 'member_removed', scopeTenantId: tenantId, details: { previousRole: targetRole } });
    console.log('[Tenants API] ' + req.user?.uid + ' removed ' + userId + ' (' + targetRole + ') from ' + tenantId);
    res.json({ removed: true, userId, previousRole: targetRole });
  } catch (err: unknown) {
    console.error('[Tenants API] Failed to remove member:', errorMessage(err));
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

const MEMBER_PROFILE_KEYS = ['accessExpiresOn', 'affiliation', 'usPerson', 'primaryContact'];

/** The 400 body for a member profile request that is malformed; `field` names the offending key (never its value). */
function invalidProfileField(field: string) {
  return { error: `Invalid ${field}`, code: 'invalid_request', field };
}

/**
 * PATCH /api/v1/tenants/:tenantId/members/:userId   (write roles; requireWriteRole)
 * Body (at least one key, no others): { accessExpiresOn?: 'YYYY-MM-DD' | null, affiliation?: 'EMPLOYEE' | 'CONTRACTOR' | 'ESP' | null,
 * usPerson?: 'US_PERSON' | 'OTHER' | null, primaryContact?: boolean }  (issues #258, #259).
 * The caller must be able to manage the member's role (canManageRole). Nobody sets their own expiry or US person flag (403 self). The US
 * person flag and the primary contact are for the owner level (403 owner_required). An owner-level member never carries an expiry (409
 * owner_cannot_expire). A date must be today (UTC) or later and at most MAX_EXPIRY_DAYS ahead (400 expiry_in_past, expiry_too_far).
 * Answers { tenantId, userId, primaryContact, membership, changed }; one membership_updated account event per changed field. The US person
 * value is never recorded in an event and nothing here logs a name, an email or a value.
 */
router.patch('/:tenantId/members/:userId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const userId = String(req.params.userId);

  if (!USER_ID_PATTERN.test(userId)) {
    res.status(400).json({ error: 'Invalid userId', code: 'invalid_request', field: 'userId' });
    return;
  }

  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json(invalidProfileField('body'));
    return;
  }
  const keys = Object.keys(body);
  const unknownKey = keys.find((k) => !MEMBER_PROFILE_KEYS.includes(k));
  if (unknownKey !== undefined) {
    res.status(400).json(invalidProfileField('body'));
    return;
  }
  if (keys.length === 0) {
    res.status(400).json(invalidProfileField('body'));
    return;
  }
  const b = body as Record<string, unknown>;
  const patch: MemberProfilePatch = {};
  const nowMs = membershipNowMs();
  if ('accessExpiresOn' in b) {
    if (b.accessExpiresOn === null) patch.accessExpiresOn = null;
    else if (typeof b.accessExpiresOn === 'string') {
      const problem = checkNewExpiry(b.accessExpiresOn, nowMs);
      if (problem === 'invalid_request') {
        res.status(400).json(invalidProfileField('accessExpiresOn'));
        return;
      }
      if (problem) {
        res.status(400).json({ error: problem === 'expiry_in_past' ? 'The access expiry date is in the past' : 'The access expiry date is too far ahead', code: problem, field: 'accessExpiresOn' });
        return;
      }
      patch.accessExpiresOn = b.accessExpiresOn;
    } else {
      res.status(400).json(invalidProfileField('accessExpiresOn'));
      return;
    }
  }
  if ('affiliation' in b) {
    if (b.affiliation !== null && !isAffiliation(b.affiliation)) {
      res.status(400).json(invalidProfileField('affiliation'));
      return;
    }
    patch.affiliation = b.affiliation as Affiliation | null;
  }
  if ('usPerson' in b) {
    if (b.usPerson !== null && !isUsPerson(b.usPerson)) {
      res.status(400).json(invalidProfileField('usPerson'));
      return;
    }
    patch.usPerson = b.usPerson as UsPerson | null;
  }
  if ('primaryContact' in b) {
    if (typeof b.primaryContact !== 'boolean') {
      res.status(400).json(invalidProfileField('primaryContact'));
      return;
    }
    patch.primaryContact = b.primaryContact;
  }

  try {
    const targetRole = await getTenantRole(userId, tenantId);
    if (!targetRole) {
      res.status(404).json({ error: 'Member not found', code: 'member_not_found' });
      return;
    }
    if (!canManageRole(req.tenantRole, targetRole)) {
      res.status(403).json(roleNotGrantableBody(req.tenantRole, targetRole));
      return;
    }
    if (userId === req.user?.uid && ('accessExpiresOn' in patch || 'usPerson' in patch)) {
      res.status(403).json({ error: 'Forbidden: you cannot change your own access expiry or US person status', code: 'self' });
      return;
    }
    if (('usPerson' in patch || 'primaryContact' in patch) && !ensureOwnerRole(req, res)) return;
    if (typeof patch.accessExpiresOn === 'string' && isOwnerLevel(targetRole)) {
      res.status(409).json({ error: 'An owner-level member cannot have an access expiry date', code: 'owner_cannot_expire' });
      return;
    }

    const result = await updateTenantMemberProfile(tenantId, userId, patch, req.user!.uid);
    if (!result) {
      res.status(404).json({ error: 'Member not found', code: 'member_not_found' });
      return;
    }
    const { before, after } = result;
    const changes: Array<{ field: string; previous: string; next: string }> = [];
    if (before.accessExpiresOn !== after.accessExpiresOn) changes.push({ field: 'access_expiry', previous: before.accessExpiresOn ?? 'none', next: after.accessExpiresOn ?? 'none' });
    if (before.affiliation !== after.affiliation) changes.push({ field: 'affiliation', previous: before.affiliation ?? 'none', next: after.affiliation ?? 'none' });
    if (before.usPerson !== after.usPerson) changes.push({ field: 'us_person', previous: '', next: '' });
    if (before.primaryContact !== after.primaryContact) changes.push({ field: 'primary_contact', previous: String(before.primaryContact), next: String(after.primaryContact) });
    for (const c of changes) {
      await recordAccountEventBestEffort({
        actorKind: 'user',
        actorUserId: req.user?.uid ?? null,
        targetUserId: userId,
        action: 'membership_updated',
        scopeTenantId: tenantId,
        // The US person flag is personal data and the log is readable across tenants: only the fact that it changed is recorded.
        details: c.field === 'us_person' ? { field: c.field, via: 'member_update' } : { field: c.field, previousValue: c.previous, newValue: c.next, via: 'member_update' },
      });
    }
    console.log(`[Tenants API] ${req.user?.uid} updated the membership of ${userId} in ${tenantId}: ${changes.map((c) => c.field).join(', ') || 'no change'}`);
    res.json({ tenantId, userId, primaryContact: after.primaryContact, membership: membershipView(after, nowMs), changed: changes.map((c) => c.field) });
  } catch (err: unknown) {
    if (err instanceof PrimaryContactConflictError) {
      res.status(409).json({ error: 'Another member was just named the primary contact. Reload and try again.', code: 'primary_contact_conflict' });
      return;
    }
    console.error(`[Tenants API] Failed to update the membership of ${userId} in ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to update the member' });
  }
});

/**
 * POST /api/v1/tenants/:tenantId/members/:userId/restore   Body: { code }
 * Restores a member whose account was disabled for inactivity (IA.L2-3.5.6). Tenant Owner or MSP Admin only, for a member whose role the
 * caller can manage, and with the caller's own fresh second-factor code (requireAdminStepUp, checked last so a refused request does not
 * spend the code). Only an account disabled for inactivity: an administrator's disable stays with the platform administrators.
 * Answers { restored: true, userId, account }; logs ids only.
 */
router.post('/:tenantId/members/:userId/restore', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const userId = String(req.params.userId);

  if (!USER_ID_PATTERN.test(userId)) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }
  if (userId === req.user?.uid) {
    res.status(403).json({ error: 'Forbidden: you cannot restore your own account' });
    return;
  }
  if (!ensureOwnerRole(req, res)) return;

  try {
    const targetRole = await getTenantRole(userId, tenantId);
    if (!targetRole) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (!canManageRole(req.tenantRole, targetRole)) {
      res.status(403).json(roleNotGrantableBody(req.tenantRole, targetRole));
      return;
    }
    const target = await findLocalUserById(userId);
    if (!target) {
      res.status(404).json({ error: 'No such account', reason: 'not_found' });
      return;
    }
    if (!(target.disabled && target.disabledReason === 'dormant')) {
      res.status(409).json({ error: 'This account is not blocked for inactivity', reason: 'not_dormant' });
      return;
    }
    if (!(await requireAdminStepUp(req, res, 'restore'))) return;
    await setLocalUserDisabled(userId, false, {
      actorKind: 'user',
      actorUserId: req.user!.uid,
      targetUserId: userId,
      action: 'account_enabled',
      scopeTenantId: tenantId,
      details: { reason: 'dormant', via: 'member_update' },
    });
    console.log(`[Tenants API] ${req.user!.uid} restored ${userId} in ${tenantId}`);
    const summary = (await getLocalUserAccountSummaries([userId])).get(userId);
    res.json({ restored: true, userId, account: summary ? accountView(summary) : null });
  } catch (err: unknown) {
    console.error('[Tenants API] Failed to restore member:', errorMessage(err));
    res.status(500).json({ error: 'Failed to restore member' });
  }
});

/**
 * PATCH /api/v1/tenants/:tenantId
 * Updates the tenant's settings (name, CAGE code, SAM status, system name/owner, industry, frameworks).
 * Write roles only (requireWriteRole: Owner, Admin, MSP admin). The assessment program (primaryFramework / enabledFrameworks) can only be
 * changed by a platform administrator: a tenant owner cannot widen their own tenant's scope.
 */
router.patch('/:tenantId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;

  const parsed = parseTenantFields(req.body, 'patch');
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  if ((parsed.value.primaryFramework !== undefined || parsed.value.enabledFrameworks !== undefined) && !(await isPlatformAdminUser(req.user))) {
    res.status(403).json({ error: "Forbidden: only a platform administrator can change a tenant's licensed frameworks" });
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
