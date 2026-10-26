import { User, AuthProviderType, TenantRole } from '../types/tenant';

/**
 * Builds the app's user profile from a server session. The id is the server's own user id; the e-mail-derived
 * fallback only covers a session that did not carry one. Pure: it never touches browser storage.
 */
export function buildUserProfile(
  session: { id?: string; email: string; name: string | null },
  opts: { tenantId: string; role: TenantRole; organization: string; provider: AuthProviderType }
): User {
  const { email } = session;
  return {
    id: session.id || `user-${email.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20)}`,
    name: session.name || email.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase()),
    email,
    organization: opts.organization,
    authProvider: opts.provider,
    roles: {
      [opts.tenantId]: opts.role,
    },
  };
}
