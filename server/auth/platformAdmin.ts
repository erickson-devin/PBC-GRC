/**
 * Platform administrators: the operators of THIS installation (the people who run an on-premises / air-gapped enclave
 * platform), as opposed to the owners of the individual tenants on it.
 *
 * Only a platform administrator decides a tenant's assessment program (which compliance frameworks it may use), so that
 * one install can host segregated tenants for different workflows (a CMMC Level 2 enclave, a separate NIST SP 800-53
 * tenant, ...) and a tenant owner cannot widen their own tenant's scope.
 *
 * Who they are is server configuration, never something the client asserts: the e-mail addresses in PLATFORM_ADMIN_EMAILS
 * (comma-separated, case-insensitive). The address is the verified identity of the authenticated user (a signed token), so
 * it works the same with local accounts and with an external identity provider. With the variable unset there are no
 * platform administrators: every tenant is created with the default program (fails closed).
 */
export function platformAdminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.PLATFORM_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isPlatformAdmin(user: { email?: string } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const email = user?.email?.trim().toLowerCase();
  return Boolean(email) && platformAdminEmails(env).has(email as string);
}

/**
 * Is this signed-in user a platform administrator: configured in PLATFORM_ADMIN_EMAILS, or created by the first-time
 * setup wizard (stored in the database). Use this on the server; the synchronous check above only knows the configuration.
 */
export async function isPlatformAdminUser(user: { uid?: string; email?: string } | null | undefined): Promise<boolean> {
  if (isPlatformAdmin(user)) return true;
  const { isStoredPlatformAdmin } = await import('../platformSetup');
  return isStoredPlatformAdmin(user);
}
