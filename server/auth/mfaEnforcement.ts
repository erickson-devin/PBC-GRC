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

// ----------------------------------------------------------------------------- request-time check (issue #39)

const MFA_REQUIREMENT_TTL_MS = 60_000;
const requirementCache = new Map<string, { required: boolean; atMs: number; mode: string }>();

/**
 * resolveMfaRequired for a request that already holds a session, cached per account and mode for 60 seconds so the
 * tenant-role lookup does not run on every call. A change that raises someone's privilege calls invalidateMfaRequirement,
 * so the next request sees it at once. Errors propagate (the caller answers 503).
 */
export async function mfaRequiredNow(user: { id: string; email: string }): Promise<boolean> {
  const mode = getMfaRequirement();
  const hit = requirementCache.get(user.id);
  const now = Date.now();
  if (hit && hit.mode === mode && now - hit.atMs < MFA_REQUIREMENT_TTL_MS) return hit.required;
  const required = await resolveMfaRequired(user);
  requirementCache.set(user.id, { required, atMs: now, mode });
  return required;
}

/** Forget the cached answer for one account (after a role change or an invitation that may have made it privileged). */
export function invalidateMfaRequirement(userId: string): void {
  requirementCache.delete(userId);
}

/** Test hook. */
export function __resetMfaRequirementCacheForTests(): void {
  requirementCache.clear();
}
