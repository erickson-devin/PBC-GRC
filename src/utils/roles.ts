import type { TenantRole } from '../types/tenant';

/** Single source of truth for role capabilities; imported by both the React client and the Express server. */
export const TENANT_ROLES: readonly TenantRole[] = ['TENANT_OWNER', 'TENANT_ADMIN', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'];

/**
 * Roles allowed to change tenant data: Tenant Owner, Admin and MSP Admin. ASSESSOR and VIEWER are strictly read-only:
 * an assessor evaluates the enclave, they must not be able to alter the evidence they assess.
 */
export const WRITE_ROLES: readonly TenantRole[] = ['TENANT_OWNER', 'TENANT_ADMIN', 'MSP_ADMIN'];

/**
 * Owner-level roles: the write roles that also manage the team's top tier (grant Owner or Admin) and may delete programs.
 * A Tenant Admin works on the tenant's data and manages Assessors and Viewers only.
 */
export const OWNER_LEVEL_ROLES: readonly TenantRole[] = ['TENANT_OWNER', 'MSP_ADMIN'];

export function isOwnerLevel(role: TenantRole | null | undefined): boolean {
  return role != null && (OWNER_LEVEL_ROLES as readonly string[]).includes(role);
}

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * Roles that may SEE SSP imports (the suggestions and the uploaded document, which can contain CUI): the write roles, and
 * Assessors, who review but cannot change or commit anything. Viewers see none of it.
 */
export function canRoleReviewSspImports(role: TenantRole | null | undefined): boolean {
  return role === 'ASSESSOR' || canRoleWrite(role);
}

export function canRoleWrite(role: TenantRole | null | undefined): boolean {
  return role != null && (WRITE_ROLES as readonly string[]).includes(role);
}

/** Human-readable role names for the UI. */
export const ROLE_LABELS: Record<TenantRole, string> = {
  TENANT_OWNER: 'Tenant Owner',
  TENANT_ADMIN: 'Admin',
  MSP_ADMIN: 'MSP Admin',
  ASSESSOR: 'Assessor',
  VIEWER: 'Viewer',
};

/** Privilege order, lowest to highest. Used so that accepting an invitation can never LOWER someone's role. */
const ROLE_RANK: Record<TenantRole, number> = { VIEWER: 0, ASSESSOR: 1, TENANT_ADMIN: 2, TENANT_OWNER: 3, MSP_ADMIN: 4 };

/**
 * The roles an actor may grant, and so the roles whose holders (and pending invitations) the actor may change or remove.
 * MSP Admin: all. Tenant Owner: everything but MSP Admin. Admin: Assessor and Viewer only. Everyone else: none.
 * The actor is always the caller's role from the server (req.tenantRole), never a value from the request body.
 */
export function rolesGrantableBy(actor: TenantRole | null | undefined): TenantRole[] {
  if (actor === 'MSP_ADMIN') return [...TENANT_ROLES];
  if (actor === 'TENANT_OWNER') return TENANT_ROLES.filter((r) => r !== 'MSP_ADMIN');
  if (actor === 'TENANT_ADMIN') return TENANT_ROLES.filter((r) => r === 'ASSESSOR' || r === 'VIEWER');
  return [];
}

export function canManageRole(actor: TenantRole | null | undefined, role: TenantRole): boolean {
  return rolesGrantableBy(actor).includes(role);
}

/** Setting a member to `next`: the actor must be able to grant `next` and, when the member already has a role, to manage it. */
export function canChangeMemberRole(
  actor: TenantRole | null | undefined,
  targetCurrent: TenantRole | null,
  next: TenantRole
): boolean {
  return canManageRole(actor, next) && (targetCurrent == null || canManageRole(actor, targetCurrent));
}

export function canRemoveMember(actor: TenantRole | null | undefined, targetRole: TenantRole): boolean {
  return canManageRole(actor, targetRole);
}

export function maxRole(a: TenantRole | null | undefined, b: TenantRole): TenantRole {
  return a != null && ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}
