import type { TenantRole } from '../types/tenant';

/** Single source of truth for role capabilities; imported by both the React client and the Express server. */
export const TENANT_ROLES: readonly TenantRole[] = ['TENANT_OWNER', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'];

/**
 * Roles allowed to change tenant data. ASSESSOR and VIEWER are strictly read-only:
 * an assessor evaluates the enclave, they must not be able to alter the evidence they assess.
 */
export const WRITE_ROLES: readonly TenantRole[] = ['TENANT_OWNER', 'MSP_ADMIN'];

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

export function canRoleWrite(role: TenantRole | null | undefined): boolean {
  return role != null && (WRITE_ROLES as readonly string[]).includes(role);
}
