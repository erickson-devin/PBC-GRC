import { ROLE_LABELS } from './roles';
import type { TenantRole } from '../types/tenant';
import type { AccountEvent } from '../services/apiClient';

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
];
const VIA_TEXT: Record<string, string> = {
  sign_in: 'sign-in',
  session: 'account settings',
  member_update: 'team settings',
  tenant_created: 'tenant created',
  invitation: 'invitation',
  invitation_registration: 'invitation sign-up',
};
const REASON_TEXT: Record<string, string> = {
  mfa_required: 'two-step verification required',
  signed_out: 'signed out',
  idle: 'inactivity',
  admin: 'administrator',
};
const ATTEMPTED_TEXT: Record<string, string> = {
  'reset-password': 'reset password',
  'reset-mfa': 'reset two-step verification',
  disable: 'disable account',
  enable: 'enable account',
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
    if (e.actorKind === 'cli') actor = 'Command line';
    else if (e.actorKind === 'system') actor = 'System';
    else if (e.actorKind === 'admin') actor = `${accountName(e.actorUserId, emailById)} (administrator)`;
    else if (e.actorKind === 'user' && e.actorUserId && e.actorUserId === e.targetUserId) actor = 'The account itself';
    else actor = accountName(e.actorUserId, emailById);
    return {
      key: e.id,
      at: e.at,
      action: accountEventLabel(e.action),
      actor,
      target: accountName(e.targetUserId, emailById),
      tenant: e.tenantId === null ? 'None' : (nameById.get(e.tenantId) ?? e.tenantId),
      details: accountEventDetails(e.details ?? {}),
    };
  });
}

export function formatEventTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

export function accountEventsErrorText(status: number): string {
  if (status === 403) return 'Only a platform administrator can read account events.';
  if (status === 0) return 'Cannot reach the server, so the account events could not be loaded.';
  return 'The account events could not be loaded. Try again.';
}
