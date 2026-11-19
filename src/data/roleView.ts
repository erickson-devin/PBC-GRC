import type { TenantRole } from '../types/tenant';
import { ROLE_LABELS, canManageRole, canRoleWrite, isTenantRole } from '../utils/roles';
import { errorMessage } from '../utils/errors';

/**
 * Role words and role logic for the team, invite, programs, accept and setup screens, in one place so the descriptions
 * cannot drift from the rules in src/utils/roles.ts. Pure: no React, no logging, no storage.
 */

/** The roles an invitation can carry from the UI: MSP Admin is provisioned by the service provider, not invited here. */
export type InviteRole = Exclude<TenantRole, 'MSP_ADMIN'>;

export const ROLE_SHORT_LABELS: Record<TenantRole, string> = {
  TENANT_OWNER: 'Owner',
  TENANT_ADMIN: 'Admin',
  MSP_ADMIN: 'MSP Admin',
  ASSESSOR: 'Assessor',
  VIEWER: 'Viewer',
};

export function roleLabel(role: unknown): string {
  return isTenantRole(role) ? ROLE_LABELS[role] : 'Unknown role';
}

export function roleShortLabel(role: unknown): string {
  return isTenantRole(role) ? ROLE_SHORT_LABELS[role] : 'Unknown';
}

export interface RoleDescription {
  can: string;
  cannot: string | null;
}

export const ROLE_DESCRIPTIONS: Record<TenantRole, RoleDescription> = {
  TENANT_OWNER: {
    can: 'Can do everything, including deciding who has access, changing any role and deleting programs.',
    cannot: null,
  },
  TENANT_ADMIN: {
    can: 'Can update controls, objectives, evidence, assets, software, the SSP, SSP imports, POA&M items and scanner tokens, and can create, edit and archive programs and invite and manage Assessors and Viewers.',
    cannot: 'Cannot add, change or remove Owners or Admins, and cannot delete programs.',
  },
  MSP_ADMIN: {
    can: 'Service provider role: can do everything a Tenant Owner can, and can grant the MSP Admin role.',
    cannot: null,
  },
  ASSESSOR: {
    can: 'Can read controls, evidence, assets and reports, and review SSP imports, to assess the organization.',
    cannot: 'Cannot change, upload or delete anything.',
  },
  VIEWER: {
    can: 'Can read controls, evidence, assets and reports.',
    cannot: 'Cannot change anything and cannot see SSP imports.',
  },
};

export function roleSummaryLine(role: TenantRole): string {
  const d = ROLE_DESCRIPTIONS[role];
  return d.cannot ? `${d.can} ${d.cannot}` : d.can;
}

export const ROLE_OPTION_HINTS: Record<TenantRole, string> = {
  TENANT_OWNER: 'full control, including who has access',
  TENANT_ADMIN: 'updates compliance data and programs, manages Assessors and Viewers',
  MSP_ADMIN: 'service provider, full control',
  ASSESSOR: 'read-only, also reviews SSP imports',
  VIEWER: 'read-only',
};

export function roleOptionLabel(role: TenantRole): string {
  return `${ROLE_LABELS[role]}: ${ROLE_OPTION_HINTS[role]}`;
}

export const INVITE_ROLE_ORDER: readonly InviteRole[] = ['TENANT_ADMIN', 'ASSESSOR', 'VIEWER', 'TENANT_OWNER'];
export const MEMBER_ROLE_ORDER: readonly TenantRole[] = ['MSP_ADMIN', 'TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER'];
export const SIMULATED_ROLES: readonly InviteRole[] = ['TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER'];

/** The invite dialog's options: what the actor may grant (see rolesGrantableBy), in display order, never MSP Admin. */
export function inviteRoleOptions(grantable: readonly TenantRole[]): InviteRole[] {
  return INVITE_ROLE_ORDER.filter((r) => grantable.includes(r));
}

export function defaultInviteRole(options: readonly InviteRole[]): InviteRole | null {
  if (options.includes('TENANT_ADMIN')) return 'TENANT_ADMIN';
  if (options.includes('VIEWER')) return 'VIEWER';
  return options[0] ?? null;
}

/** `mode` is the install's MFA_REQUIRED mode ('all' | 'privileged' | 'off'), or null when it is not known. */
export function requiresTwoStep(role: TenantRole, mode: string | null | undefined): boolean {
  return mode === 'all' || (mode === 'privileged' && canRoleWrite(role));
}

export function inviteTwoStepNote(role: TenantRole, mode: string | null | undefined): string | null {
  if (mode === 'all') {
    return 'Everyone on this installation must use two-step verification. They are asked to set it up before they can continue.';
  }
  if (mode === 'privileged' && canRoleWrite(role)) {
    return `${ROLE_LABELS[role]} accounts must use two-step verification on this installation. They are asked to set it up before they can continue.`;
  }
  return null;
}

export const ROLE_TEXT = {
  adminLimit: 'An Admin can only invite, change and remove Assessors and Viewers. Ask a Tenant Owner. Nothing was changed.',
  notGrantable: 'Your role cannot grant, change or remove that role. Nothing was changed.',
  ownerRequired: 'Only a Tenant Owner can do that. Nothing was changed.',
  lastOwner: 'This is the last Tenant Owner. Make another member a Tenant Owner first. Nothing was changed.',
  pendingInviteLocked:
    'This address already has a pending invitation that only a Tenant Owner can change. Ask a Tenant Owner to revoke it first. Nothing was sent.',
  managedByOwner: 'Managed by a Tenant Owner',
  managedByMsp: 'Managed by an MSP Admin',
  adminIntro:
    'As an Admin, you can invite, change and remove Assessors and Viewers. Only a Tenant Owner can add, change or remove Owners and Admins.',
  readOnlyIntro: 'Only a Tenant Owner or Admin can invite people or change roles.',
  ownerCaution: "A Tenant Owner has full control, including who else has access and every member's role.",
  noInviteRoles: 'Your role cannot invite people to this organization.',
  scopePlatformOnly: 'Only a platform administrator can change the licensed frameworks.',
  programsReadOnly:
    'Programs are read-only for your role. A Tenant Owner or Admin creates, edits and archives them, and a Tenant Owner deletes them.',
  archivedDeleteOwnerOnly: 'Only a Tenant Owner can delete an archived program. You can restore it.',
  programDeleteRefused: 'Only a Tenant Owner can delete a program. Nothing was deleted.',
  acceptTwoStep:
    'This installation can require two-step verification for Owners and Admins. If it does, you are asked to set it up right after accepting.',
  matrixTitle: 'What each role can do',
} as const;

export interface TeamRowInput {
  actor: TenantRole | null | undefined;
  canManageTenant: boolean;
  isSelf: boolean;
  isPending: boolean;
  memberRole: TenantRole;
  hasInvitation: boolean;
}

export interface TeamRowView {
  control: 'select' | 'badge';
  options: TenantRole[];
  inviteActions: boolean;
  remove: boolean;
  note: string | null;
}

/** What one team row offers the signed-in actor: a role select or a plain badge, the row actions, and why none are offered. */
export function teamRowView(i: TeamRowInput): TeamRowView {
  const manageable = i.canManageTenant && canManageRole(i.actor, i.memberRole);
  const control = manageable && !i.isSelf && !i.isPending ? 'select' : 'badge';
  return {
    control,
    options: control === 'select' ? MEMBER_ROLE_ORDER.filter((r) => canManageRole(i.actor, r)) : [],
    inviteActions: i.isPending && i.hasInvitation && manageable,
    remove: !i.isPending && !i.isSelf && manageable,
    note:
      i.canManageTenant && !i.isSelf && !manageable
        ? i.memberRole === 'MSP_ADMIN'
          ? ROLE_TEXT.managedByMsp
          : ROLE_TEXT.managedByOwner
        : null,
  };
}

export function teamIntroNote(actor: TenantRole | null | undefined, canManageTenant: boolean): string | null {
  if (actor === 'TENANT_ADMIN') return ROLE_TEXT.adminIntro;
  if (!canManageTenant) return ROLE_TEXT.readOnlyIntro;
  return null;
}

/** The rows of the role matrix: the four customer roles, plus MSP Admin first when the actor or any member holds it. */
export function matrixRoles(actor: TenantRole | null | undefined, memberRoles: readonly TenantRole[]): TenantRole[] {
  const base: TenantRole[] = ['TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER'];
  return actor === 'MSP_ADMIN' || memberRoles.includes('MSP_ADMIN') ? ['MSP_ADMIN', ...base] : base;
}

export function roleChangeNeedsConfirm(current: TenantRole, next: TenantRole): boolean {
  return next === 'TENANT_OWNER' || current === 'TENANT_OWNER' || next === 'MSP_ADMIN' || current === 'MSP_ADMIN';
}

export function roleChangeConfirmText(email: string, current: TenantRole, next: TenantRole): string {
  if (next === 'TENANT_OWNER') return `Make ${email} a Tenant Owner? ${ROLE_TEXT.ownerCaution}`;
  if (current === 'TENANT_OWNER') {
    return `Change ${email} from Tenant Owner to ${ROLE_LABELS[next]}? They will no longer control who has access.`;
  }
  return `Change ${email} from ${ROLE_LABELS[current]} to ${ROLE_LABELS[next]}?`;
}

export type TeamOp = 'member' | 'invite';

/** Maps the server's refusals (ApiError.reason is the response code) to one plain sentence; anything else keeps its message. */
export function teamActionErrorMessage(
  err: unknown,
  actor: TenantRole | null | undefined,
  op: TeamOp,
  fallback: string
): string {
  const e = (err && typeof err === 'object' ? err : {}) as { reason?: unknown; status?: unknown };
  if (e.reason === 'role_not_grantable') return actor === 'TENANT_ADMIN' ? ROLE_TEXT.adminLimit : ROLE_TEXT.notGrantable;
  if (e.reason === 'owner_required') return ROLE_TEXT.ownerRequired;
  if (e.reason === 'last_owner' || (op === 'member' && e.status === 409)) return ROLE_TEXT.lastOwner;
  return errorMessage(err) || fallback;
}

/** An invite refused as role_not_grantable for a role the actor CAN grant means a pending invitation for that address is locked. */
export function inviteErrorMessage(
  err: unknown,
  actor: TenantRole | null | undefined,
  chosen: TenantRole,
  fallback: string
): string {
  const reason = err && typeof err === 'object' ? (err as { reason?: unknown }).reason : undefined;
  if (reason === 'role_not_grantable' && canManageRole(actor, chosen)) return ROLE_TEXT.pendingInviteLocked;
  return teamActionErrorMessage(err, actor, 'invite', fallback);
}
