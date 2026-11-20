import { ROLE_LABELS } from './roles';
import type { TenantRole } from '../types/tenant';
import type { AccountEvent, AccountEventFilter } from '../services/apiClient';

export const ACCOUNT_EVENTS_PAGE_SIZE = 50;
export const ACCOUNT_EVENTS_OLDER_ERROR = 'Older account events could not be loaded. Try again.';

export const ACCOUNT_EVENT_LABELS: Record<string, string> = {
  password_changed: 'Password changed',
  password_reset: 'Password reset by an administrator',
  mfa_enrolled: 'Two-step verification set up',
  mfa_reset: 'Two-step verification reset',
  recovery_codes_regenerated: 'Recovery codes regenerated',
  account_disabled: 'Account disabled',
  account_enabled: 'Account enabled',
  role_changed: 'Tenant role changed',
  member_removed: 'Removed from a tenant',
  signed_out: 'Signed out',
  session_revoked: 'Session ended by the server',
  step_up_failed: 'Administrator code refused',
  system_use_acknowledged: 'System use notice acknowledged',
  system_use_notice_updated: 'System use notice changed',
  vm_token_created: 'Service token created',
  vm_token_revoked: 'Service token revoked',
  membership_updated: 'Membership details changed',
  announcement_posted: 'Announcement posted',
  announcement_withdrawn: 'Announcement withdrawn',
};

export function accountEventLabel(action: string): string {
  return ACCOUNT_EVENT_LABELS[action] ?? `Unrecognised event (${action})`;
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** The email when the account is known, else a shortened id. */
export function accountName(id: string | null, emailById: Map<string, string>): string {
  if (!id) return 'Unknown';
  return emailById.get(id) ?? shortId(id);
}

const DETAIL_KEYS: Array<[string, string]> = [
  ['reason', 'Reason'],
  ['previousRole', 'Previous role'],
  ['newRole', 'New role'],
  ['via', 'Via'],
  ['attempted', 'Attempted'],
  ['mustChangePassword', 'Must change password'],
  ['noticeVersion', 'Notice version'],
  ['noticeEnabled', 'Notice shown'],
  ['tokenId', 'Service token'],
  ['field', 'Field'],
  ['previousValue', 'Previous'],
  ['newValue', 'New'],
  ['announcementId', 'Announcement'],
];
const VIA_TEXT: Record<string, string> = {
  sign_in: 'sign-in',
  session: 'account settings',
  member_update: 'team settings',
  tenant_created: 'tenant created',
  invitation: 'invitation',
  invitation_registration: 'invitation sign-up',
  sweep: 'automatic inactivity check',
};
const REASON_TEXT: Record<string, string> = {
  mfa_required: 'two-step verification required',
  signed_out: 'signed out',
  idle: 'inactivity',
  admin: 'administrator',
  dormant: 'account unused for too long',
};
const ATTEMPTED_TEXT: Record<string, string> = {
  'reset-password': 'reset password',
  'reset-mfa': 'reset two-step verification',
  disable: 'disable account',
  enable: 'enable account',
  restore: 'restore an account blocked for inactivity',
  'system-use-notice': 'change the system use notice',
  announcement: 'post or withdraw an announcement',
};

function detailValue(key: string, value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (key === 'previousRole' || key === 'newRole') return ROLE_LABELS[value as TenantRole] ?? value;
  if (key === 'via') return VIA_TEXT[value] ?? value;
  if (key === 'reason') return REASON_TEXT[value] ?? value;
  if (key === 'attempted') return ATTEMPTED_TEXT[value] ?? value;
  return value;
}

/** Known keys first in a fixed order, unknown keys after in object order; only strings and booleans are shown. */
export function accountEventDetails(details: Record<string, unknown>): string[] {
  const out: string[] = [];
  const show = (key: string, label: string) => {
    const v = details[key];
    if (typeof v === 'string' || typeof v === 'boolean') out.push(`${label}: ${detailValue(key, v)}`);
  };
  for (const [key, label] of DETAIL_KEYS) if (Object.prototype.hasOwnProperty.call(details, key)) show(key, label);
  const known = new Set(DETAIL_KEYS.map(([k]) => k));
  for (const key of Object.keys(details)) if (!known.has(key)) show(key, key);
  return out;
}

export interface AccountEventRow {
  key: string;
  at: string;
  action: string;
  actor: string;
  target: string;
  tenant: string;
  details: string[];
}

export function accountEventRows(
  events: AccountEvent[],
  accounts: Array<{ id: string; email: string }>,
  tenants: Array<{ id: string; name: string }>
): AccountEventRow[] {
  const emailById = new Map(accounts.map((a) => [a.id, a.email] as [string, string]));
  const nameById = new Map(tenants.map((t) => [t.id, t.name] as [string, string]));
  return events.map((e) => {
    let actor: string;
    const isVmToken = e.action.startsWith('vm_token_');
    if (isVmToken) actor = accountName(e.actorUserId, emailById);
    else if (e.actorKind === 'cli') actor = 'Command line';
    else if (e.actorKind === 'system') actor = 'System';
    else if (e.actorKind === 'admin') actor = `${accountName(e.actorUserId, emailById)} (administrator)`;
    else if (e.actorKind === 'user' && e.actorUserId && e.actorUserId === e.targetUserId) actor = 'The account itself';
    else actor = accountName(e.actorUserId, emailById);
    return {
      key: e.id,
      at: e.at,
      action: accountEventLabel(e.action),
      actor,
      target: isVmToken ? `Service token ${shortId(String(e.details?.tokenId ?? ''))}` : accountName(e.targetUserId, emailById),
      tenant: e.tenantId === null ? 'None' : (nameById.get(e.tenantId) ?? e.tenantId),
      details: accountEventDetails(e.details ?? {}),
    };
  });
}

export function formatEventTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

export function accountEventsErrorText(status: number, filtered = false): string {
  if (filtered && status === 400) return ACCOUNT_EVENTS_FILTER_REJECTED;
  if (status === 403) return 'Only a platform administrator can read account events.';
  if (status === 0) return 'Cannot reach the server, so the account events could not be loaded.';
  return 'The account events could not be loaded. Try again.';
}

export const ACCOUNT_EVENT_FILTER_ACTIONS: readonly string[] = Object.keys(ACCOUNT_EVENT_LABELS);
export const ACCOUNT_EVENTS_FILTERED_EMPTY = 'No account events match this filter. Choose another account or event, or clear the filter.';
export const ACCOUNT_EVENTS_FILTER_REJECTED = 'The server did not accept this filter. Clear the filter and try again.';
export const ACCOUNT_EVENTS_OLDEST = 'This is the oldest recorded event.';
export const ACCOUNT_EVENTS_OLDEST_MATCHING = 'This is the oldest matching event.';
export interface FilterOption { value: string; label: string }
export function accountEventFilterActive(f: AccountEventFilter): boolean { return Boolean(f.target) || Boolean(f.action); }
/** '' = all; accounts sorted by email; a target that is not in the list (deleted, or the list is not loaded) stays selectable by short id. */
export function accountFilterOptions(accounts: Array<{ id: string; email: string }> | null, target: string | null | undefined): FilterOption[] {
  const sorted = [...(accounts ?? [])].sort((a, b) => a.email.localeCompare(b.email));
  const out: FilterOption[] = [{ value: '', label: 'All accounts' }];
  if (target && !sorted.some((a) => a.id === target)) out.push({ value: target, label: accounts === null ? `Selected account (${shortId(target)})` : `Account no longer listed (${shortId(target)})` });
  for (const a of sorted) out.push({ value: a.id, label: a.email });
  return out;
}
export function actionFilterOptions(action: string | null | undefined): FilterOption[] {
  const out: FilterOption[] = [{ value: '', label: 'All events' }, ...ACCOUNT_EVENT_FILTER_ACTIONS.map((a) => ({ value: a, label: ACCOUNT_EVENT_LABELS[a] }))];
  if (action && !ACCOUNT_EVENT_FILTER_ACTIONS.includes(action)) out.push({ value: action, label: accountEventLabel(action) });
  return out;
}
export function accountEventFilterSummary(f: AccountEventFilter, accounts: Array<{ id: string; email: string }>): string {
  if (!accountEventFilterActive(f)) return '';
  const emailById = new Map(accounts.map((a) => [a.id, a.email] as [string, string]));
  const who = f.target ? accountName(f.target, emailById) : 'every account';
  return `Showing ${f.action ? `"${accountEventLabel(f.action)}"` : 'all'} events for ${who}.`;
}
export function accountEventsLoadedText(count: number, more: boolean): string {
  const base = count === 0 ? 'No matching account events.' : `${count} matching event${count === 1 ? '' : 's'} loaded.`;
  return more ? `${base} Older ones can be loaded with Load older.` : base;
}
