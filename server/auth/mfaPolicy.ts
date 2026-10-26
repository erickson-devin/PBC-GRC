import { canRoleWrite } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';

/**
 * Pure decision: must this person hold a second factor? `privileged` means a platform admin or anyone holding a
 * write role (TENANT_OWNER, MSP_ADMIN) in at least one tenant. The mode comes from getMfaRequirement (localAuth.ts).
 */
export type MfaRequirement = 'all' | 'privileged' | 'off';

export function isMfaRequiredFor(
  mode: MfaRequirement,
  subject: { isPlatformAdmin: boolean; tenantRoles: readonly TenantRole[] }
): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return subject.isPlatformAdmin || subject.tenantRoles.some((role) => canRoleWrite(role));
}
