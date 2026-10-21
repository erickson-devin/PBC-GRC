import { listUserTenants } from '../db';
import { getMfaRequirement } from './localAuth';
import { isMfaRequiredFor } from './mfaPolicy';
import { isPlatformAdminUser } from './platformAdmin';

/**
 * Must this person hold a second factor under the configured MFA_REQUIRED mode? Reads the mode on every call, so a bad
 * value is a configuration error (LocalAuthConfigError) and a database error propagates: login fails closed.
 * Under `off` and `all` nothing else is looked up; `privileged` needs the platform-admin check and the tenant roles.
 */
export async function resolveMfaRequired(user: { id: string; email: string }): Promise<boolean> {
  const mode = getMfaRequirement();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  const isPlatformAdmin = await isPlatformAdminUser({ uid: user.id, email: user.email });
  const tenantRoles = (await listUserTenants(user.id)).map((t) => t.role);
  return isMfaRequiredFor(mode, { isPlatformAdmin, tenantRoles });
}
