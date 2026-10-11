import type { Tenant, TenantInvitation, TenantRole, TeamMember } from '../types/tenant';
import { isTenantRole } from '../utils/roles';

/**
 * Pure mapping between the server's invitation / member records and the UI's TenantInvitation / TeamMember.
 * The server is the source of truth for server-backed tenants; this is only how its data is shown. Invitation tokens
 * are never part of a listing (the server stores a hash), so a token exists in the browser only for the moment an
 * invitation is created or resent, and is never persisted.
 */

export type ServerInvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface ServerInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByUserId: string | null;
  revokedAt: string | null;
  status: ServerInvitationStatus;
}

export interface ServerMember {
  userId: string;
  email: string;
  name: string;
  tenantId: string;
  role: TenantRole;
  createdAt: string;
}

const STATUSES: readonly string[] = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'];
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Defensive parse of GET .../invites: malformed entries and unknown roles/statuses are dropped. */
export function parseServerInvitations(raw: unknown): ServerInvitation[] {
  const list = (raw as { invitations?: unknown } | null)?.invitations;
  if (!Array.isArray(list)) return [];
  return list.map(parseServerInvitation).filter((i): i is ServerInvitation => i !== null);
}

export function parseServerInvitation(item: unknown): ServerInvitation | null {
  const i = item as Record<string, unknown> | null;
  if (!i || typeof i.id !== 'string' || !i.id || typeof i.tenantId !== 'string' || !isTenantRole(i.role) || !STATUSES.includes(i.status as string)) return null;
  return {
    id: i.id,
    tenantId: i.tenantId,
    email: str(i.email),
    role: i.role,
    createdBy: str(i.createdBy),
    createdAt: str(i.createdAt),
    expiresAt: str(i.expiresAt),
    acceptedAt: strOrNull(i.acceptedAt),
    acceptedByUserId: strOrNull(i.acceptedByUserId),
    revokedAt: strOrNull(i.revokedAt),
    status: i.status as ServerInvitationStatus,
  };
}

/** Defensive parse of GET .../members. */
export function parseServerMembers(raw: unknown): ServerMember[] {
  const list = (raw as { members?: unknown } | null)?.members;
  if (!Array.isArray(list)) return [];
  const out: ServerMember[] = [];
  for (const item of list) {
    const m = item as Record<string, unknown> | null;
    if (!m || typeof m.userId !== 'string' || !m.userId || !isTenantRole(m.role)) continue;
    out.push({ userId: m.userId, email: str(m.email), name: str(m.name), tenantId: str(m.tenantId), role: m.role, createdAt: str(m.createdAt) });
  }
  return out;
}

/** The UI's invitation for a server record. `token` is only known right after create / resend. */
export function toTenantInvitation(
  inv: ServerInvitation,
  tenant: Pick<Tenant, 'name' | 'systemName' | 'cageCode' | 'licenseTier'> | undefined,
  token = ''
): TenantInvitation {
  return {
    id: inv.id,
    token,
    tenantId: inv.tenantId,
    tenantName: tenant?.name ?? inv.tenantId,
    email: inv.email,
    role: inv.role,
    invitedBy: inv.createdBy,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    status: inv.status,
    acceptedAt: inv.acceptedAt ?? undefined,
    acceptedByUserId: inv.acceptedByUserId ?? undefined,
    // Inviting someone as owner is the onboarding hand-over; everything else is a staff invite.
    type: inv.role === 'TENANT_OWNER' ? 'TENANT_ONBOARDING' : 'STAFF_INVITE',
    systemName: tenant?.systemName,
    cageCode: tenant?.cageCode,
    licenseTier: tenant?.licenseTier,
    serverBacked: true,
  };
}

/** Id used for a pending invitation's row in the team table. */
export const pendingMemberId = (invitationId: string): string => `invite:${invitationId}`;

/** Active members first, then pending invitations as PENDING_INVITE rows. Accepted/revoked/expired ones are not rows. */
export function buildTeam(
  tenantId: string,
  members: readonly ServerMember[],
  invitations: readonly ServerInvitation[],
  tokens: Readonly<Record<string, string>> = {}
): TeamMember[] {
  const active: TeamMember[] = members.map((m) => ({
    id: m.userId,
    userId: m.userId,
    tenantId,
    email: m.email,
    name: m.name || m.email.split('@')[0],
    role: m.role,
    status: 'ACTIVE' as const,
    joinedAt: m.createdAt || undefined,
  }));

  const pending: TeamMember[] = invitations
    .filter((i) => i.status === 'PENDING')
    .map((i) => ({
      id: pendingMemberId(i.id),
      tenantId,
      email: i.email,
      name: i.email.split('@')[0].replace('.', ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: i.role,
      status: 'PENDING_INVITE' as const,
      invitedAt: i.createdAt,
      invitationId: i.id,
      invitationToken: tokens[i.id] || undefined, // only present for links created/resent in this session
    }));

  return [...active, ...pending];
}

/**
 * Replaces the server-backed invitations of ONE tenant with the server's current list; everything else (other
 * tenants, sandbox / legacy browser-only invitations) is left untouched.
 */
export function mergeServerInvitations(
  current: readonly TenantInvitation[],
  tenantId: string,
  fromServer: readonly TenantInvitation[]
): TenantInvitation[] {
  return [...fromServer, ...current.filter((i) => !(i.tenantId === tenantId && i.serverBacked))];
}

/** localStorage must never hold server-issued invitation data: the server owns it (and tokens are secrets). */
export const persistableInvitations = (all: readonly TenantInvitation[]): TenantInvitation[] => all.filter((i) => !i.serverBacked);
