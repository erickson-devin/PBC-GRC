import type { TenantRole } from '../types/tenant';
import { canManageRole } from '../utils/roles';

/** Dormant accounts (#257): pure text and view logic shared by the admin console and the team screen. No logging; never the server's message. */

export type DisabledReason = 'admin' | 'dormant';

export const NEVER_SIGNED_IN = 'Never signed in';

export const DORMANCY_TEXT = {
  sectionTitle: 'Blocked due to inactivity',
  restoreTitle: 'Restore account',
  restoreButton: 'Restore',
  restoreBusy: 'Restoring…',
  restoreLead: 'was blocked automatically because nobody signed in to the account for too long.',
  restoreBody: 'Restoring lets this person sign in again right away. Restore only people who still need access to this organization.',
  codeLabel: 'Code from your authenticator app',
  codeHelp: 'Use the current code from your own authenticator app. A code works once.',
  codeFormat: 'Enter the 6-digit code from your authenticator app.',
  ownerNeedsMfa: 'Set up two-step verification on your own account (Account settings) before you restore members, or ask a platform administrator to restore this account.',
  adminCannotRestore: 'Only an MSP Admin or a Tenant Owner can restore these accounts.',
  ownerRestores: 'A Tenant Owner can restore this account.',
  mspRestores: 'An MSP Admin or a platform administrator can restore this account.',
  notRecorded: 'Not recorded',
  notJoined: 'Not joined yet',
  notAvailable: 'Not available',
  consoleBadge: 'Disabled: inactive',
  teamBadge: 'Blocked: inactive',
  disabledBadge: 'Disabled',
  adminRestoreBody: 'to sign in again. It was disabled automatically because nobody signed in to it for too long. Restore only accounts that still need access.',
} as const;

export const RESTORE_ERROR_TEXT = {
  code_required: 'Enter the 6-digit code from your authenticator app.',
  invalid_request: 'The request was not accepted. Close this dialog and try again.',
  invalid_code: 'That code is not correct or was already used. Wait for the next code in your authenticator app and try again.',
  owner_required: 'Only an MSP Admin or a Tenant Owner can restore an account blocked for inactivity. Nothing was changed.',
  role_not_grantable: 'Your role cannot restore a member with this role. Ask an MSP Admin or a platform administrator. Nothing was changed.',
  not_found: 'This person is no longer a member of this organization. Nothing was changed.',
  not_dormant: 'This account is no longer blocked for inactivity: it was already restored, or a platform administrator disabled it. Nothing was changed.',
  mfa_not_enrolled: 'You need two-step verification on your own account to restore members. Set it up in Account settings first, or ask a platform administrator to restore this account.',
  locked: 'Too many attempts. Wait a few minutes, then try again with a new code.',
  unreachable: 'Cannot reach the server. Nothing was changed. Check your connection and try again.',
  session: 'Your session has ended. Sign in again, then restore the account.',
  failed: 'The account could not be restored. Try again.',
} as const;

/** The refusal codes the restore endpoint sends as `reason`. */
const SERVER_REASONS = ['code_required', 'invalid_request', 'invalid_code', 'owner_required', 'role_not_grantable', 'not_dormant', 'mfa_not_enrolled'] as const;

/** A non-negative integer, else null (0 means automatic blocking is off). */
export function parseDormantDays(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

export function parseDisabledReason(raw: unknown): DisabledReason | null {
  return raw === 'admin' || raw === 'dormant' ? raw : null;
}

export function formatDateTime(at: string | null | undefined): string {
  if (!at) return DORMANCY_TEXT.notRecorded;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

export function formatLastSignIn(at: string | null | undefined): string {
  return at ? formatDateTime(at) : NEVER_SIGNED_IN;
}

export function dormancyPolicyText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'Inactive accounts are not disabled automatically on this installation (ACCOUNT_DORMANT_DAYS is 0).';
  return `Accounts with no sign-in for ${days} day${days === 1 ? '' : 's'} are disabled automatically (ACCOUNT_DORMANT_DAYS). Restore one with its Restore button.`;
}

export function teamDormancyPolicyText(days: number | null): string {
  if (days === null) return 'These accounts were blocked automatically because nobody signed in to them for a long time.';
  if (days === 0) return 'Automatic blocking for inactivity is now turned off, but these accounts were blocked before.';
  return `Accounts with no sign-in for ${days} day${days === 1 ? '' : 's'} are blocked automatically.`;
}

export function disabledDetail(reason: DisabledReason | null, disabledAt: string | null): string | null {
  if (reason === 'dormant') return disabledAt ? `Disabled for inactivity on ${formatDateTime(disabledAt)}` : 'Disabled for inactivity';
  if (reason === 'admin') return disabledAt ? `Disabled by an administrator on ${formatDateTime(disabledAt)}` : 'Disabled by an administrator';
  return disabledAt ? `Disabled on ${formatDateTime(disabledAt)}` : null;
}

export interface DormancyMember {
  id: string;
  userId?: string;
  email: string;
  role: TenantRole;
  status: 'ACTIVE' | 'PENDING_INVITE';
  lastLoginAt?: string | null;
  accountDisabled?: boolean;
  disabledReason?: DisabledReason | null;
  disabledAt?: string | null;
}

export function isDormancyBlocked(m: DormancyMember): boolean {
  return m.status === 'ACTIVE' && m.accountDisabled === true && m.disabledReason === 'dormant';
}

/** The column and the section need the account facts: write roles on a server-backed tenant. */
export function showLastSignInColumn(canManageTenant: boolean, serverBacked: boolean): boolean {
  return canManageTenant && serverBacked;
}

export function memberSignInText(m: DormancyMember): string {
  if (m.status !== 'ACTIVE') return DORMANCY_TEXT.notJoined;
  if (m.lastLoginAt === undefined) return DORMANCY_TEXT.notAvailable;
  return formatLastSignIn(m.lastLoginAt);
}

export function memberAccountBadge(m: DormancyMember): { label: string; tone: 'amber' | 'rose' } | null {
  if (m.status !== 'ACTIVE' || m.accountDisabled !== true) return null;
  return m.disabledReason === 'dormant'
    ? { label: DORMANCY_TEXT.teamBadge, tone: 'amber' }
    : { label: DORMANCY_TEXT.disabledBadge, tone: 'rose' };
}

/** Only an MSP Admin or a Tenant Owner restores, never themselves, and only a role they could manage. */
export function canRestoreMember(actor: TenantRole | null | undefined, memberRole: TenantRole, isSelf: boolean): boolean {
  return !isSelf && (actor === 'TENANT_OWNER' || actor === 'MSP_ADMIN') && canManageRole(actor, memberRole);
}

export interface BlockedMemberRow {
  id: string;
  userId: string;
  email: string;
  lastSignIn: string;
  blockedOn: string;
  canRestore: boolean;
  note: string | null;
}

export function blockedMemberRows(members: readonly DormancyMember[], actor: TenantRole | null | undefined, selfEmail: string): BlockedMemberRow[] {
  return members
    .filter(isDormancyBlocked)
    .map((m) => {
      const canRestore = canRestoreMember(actor, m.role, m.email.toLowerCase() === selfEmail.toLowerCase());
      return {
        id: m.id,
        userId: m.userId ?? m.id,
        email: m.email,
        lastSignIn: formatLastSignIn(m.lastLoginAt),
        blockedOn: formatDateTime(m.disabledAt),
        canRestore,
        note: canRestore ? null : (m.role === 'MSP_ADMIN' ? DORMANCY_TEXT.mspRestores : DORMANCY_TEXT.ownerRestores),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

export function restoreCodeReady(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function restoreSuccessText(email: string): string {
  return `${email} can sign in again.`;
}

/** Maps the server's refusal (ApiError.reason / status) to one sentence; never the server's own message. */
export function restoreErrorMessage(err: unknown): string {
  const e = (err && typeof err === 'object' ? err : {}) as { reason?: unknown; status?: unknown };
  const known = SERVER_REASONS.find((r) => r === e.reason);
  if (known) return RESTORE_ERROR_TEXT[known];
  if (e.status === 404) return RESTORE_ERROR_TEXT.not_found;
  if (e.status === 429) return RESTORE_ERROR_TEXT.locked;
  if (e.status === 0) return RESTORE_ERROR_TEXT.unreachable;
  if (e.status === 401) return RESTORE_ERROR_TEXT.session;
  if (e.status === 403) return RESTORE_ERROR_TEXT.owner_required;
  return RESTORE_ERROR_TEXT.failed;
}

/** The team listing is stale when the member is gone or already restored. */
export function restoreRefreshesTeam(err: unknown): boolean {
  const e = (err && typeof err === 'object' ? err : {}) as { reason?: unknown; status?: unknown };
  return e.reason === 'not_dormant' || e.status === 404;
}
