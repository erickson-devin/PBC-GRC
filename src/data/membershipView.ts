import { canManageRole, canRoleWrite, isOwnerLevel } from '../utils/roles';
import { MAX_EXPIRY_DAYS, parseExpiryDate, accessEndsAtMs, membershipExpired, checkNewExpiry, utcToday, type Affiliation, type UsPerson } from '../utils/memberProfile';
import { formatUtcDate, formatLocalDateTime } from '../utils/utcDates';
import type { TeamMember, TenantRole } from '../types/tenant';
import type { ExpiredMembership } from './tenantSync';

/**
 * Pure view logic for the member access details (issues #258, #259): the access end date, affiliation, US-person status and primary
 * contact on the Team settings screen, and the notices a member sees about their own access. No React and no services: the screens
 * pass in the clock. Every access end is the end of the day in UTC, and the text says so.
 */

/** The fields the member PATCH accepts; send only what changes. */
export interface MemberProfilePatch {
  accessExpiresOn?: string | null;
  affiliation?: Affiliation | null;
  usPerson?: UsPerson | null;
  primaryContact?: boolean;
}

export type UsPersonFilter = 'all' | 'US_PERSON' | 'OTHER' | 'NOT_RECORDED';
export const US_PERSON_FILTERS: readonly UsPersonFilter[] = ['all', 'US_PERSON', 'OTHER', 'NOT_RECORDED'];

/** An access end within this many days is shown as "soon". */
export const SOON_DAYS = 14;

export const AFFILIATION_LABELS: Record<Affiliation, string> = { EMPLOYEE: 'Employee', CONTRACTOR: 'Contractor', ESP: 'External service provider' };
export const US_PERSON_LABELS = { US_PERSON: 'US person', OTHER: 'Other (not a US person)', NOT_RECORDED: 'Not recorded' } as const;
export const US_PERSON_CHIPS = { US_PERSON: 'US person', OTHER: 'Not a US person', NOT_RECORDED: 'US person: not recorded' } as const;

export const MEMBERSHIP_TEXT = {
  editTitle: 'Access details',
  editButtonTitle: 'Access details',
  expiryLegend: 'Access end date',
  noEndDate: 'No end date',
  endsOnDate: 'Ends on a date',
  lastDayLabel: 'Last day of access',
  quickLabel: 'Quick pick:',
  expiryHelp: 'Access stops at 23:59 UTC on the last day. Dates are in UTC, so the end can fall on a different local day. Ending access does not delete the person\'s account or their work.',
  ownerNeverExpires: 'MSP Admins and Tenant Owners never have an access end date, so the organization always keeps someone who can manage it.',
  selfExpiry: 'You cannot set an end date on your own access.',
  expiredRestoreHint: 'Their access has ended. Remove the end date or choose a later one to let them back in right away.',
  affiliationLabel: 'Affiliation',
  affiliationHelp: 'Whether this person works for the organization, as a contractor, or for an external service provider.',
  usPersonLegend: 'US-person status',
  usPersonHelp: 'Recorded by an MSP Admin or a Tenant Owner after checking it. People cannot set this for themselves. The change is logged without the value.',
  usPersonSelf: 'Another MSP Admin or Tenant Owner must record your own US-person status.',
  usPersonFilterLegend: 'US-person status',
  usPersonFilterHint: 'Recorded by an MSP Admin or a Tenant Owner; people cannot set it for themselves. Pending invitations are not counted.',
  primaryContactLabel: 'Primary contact for this organization',
  primaryContactHelp: 'Every member sees who the primary contact is, so they know whom to ask about access. An organization has at most one.',
  primaryBadge: 'Primary contact',
  expiredBadge: 'Access expired',
  saveButton: 'Save details',
  saveBusy: 'Saving…',
  cancel: 'Cancel',
  noChanges: 'No changes yet.',
  offlineSave: 'The server cannot be reached. Changes can be saved when the connection is back.',
  offlineTitle: 'The server cannot be reached',
  filterEmpty: 'No members match this US-person filter.',
  searchEmpty: 'No matching members found in this enclave.',
  missingDate: 'Choose the last day of access, or choose "No end date".',
  dateInPast: 'That date has already passed in UTC. Choose today (UTC) or a later date.',
  dateTooFar: 'The end date can be at most 10 years away.',
} as const;

export const MEMBER_PROFILE_ERROR_TEXT = {
  owner_cannot_expire: 'MSP Admins and Tenant Owners cannot have an access end date. Nothing was changed.',
  expiry_in_past: 'That end date has already passed in UTC. Choose today (UTC) or a later date. Nothing was changed.',
  expiry_too_far: 'The end date can be at most 10 years away. Nothing was changed.',
  self: 'You cannot set your own access end date or US-person status. Ask another MSP Admin or Tenant Owner. Nothing was changed.',
  owner_required: 'Only an MSP Admin or a Tenant Owner can record US-person status or choose the primary contact. Nothing was changed.',
  role_not_grantable: 'Your role cannot change this member\'s details. Nothing was changed.',
  primary_contact_conflict: 'Someone else changed the primary contact at the same moment. The team list was reloaded: check it and try again.',
  member_not_found: 'This person is no longer a member of this organization. The team list was reloaded. Nothing was changed.',
  invalid_request: 'The change was not accepted. Check the fields and try again.',
  membership_expired: 'Your own access to this organization has ended. Nothing was changed.',
  unreachable: 'Cannot reach the server. Nothing was changed. Check your connection and try again.',
  session: 'Your session has ended. Sign in again, then make the change.',
  forbidden: 'You do not have permission to change this member. Nothing was changed.',
  failed: 'The details could not be saved. Try again.',
} as const;

type ServerReason = 'owner_cannot_expire' | 'expiry_in_past' | 'expiry_too_far' | 'self' | 'owner_required' | 'role_not_grantable' | 'primary_contact_conflict' | 'member_not_found' | 'invalid_request' | 'membership_expired';
const SERVER_REASONS: readonly string[] = ['owner_cannot_expire', 'expiry_in_past', 'expiry_too_far', 'self', 'owner_required', 'role_not_grantable', 'primary_contact_conflict', 'member_not_found', 'invalid_request', 'membership_expired'];

/** An active member whose membership facts the server sent (write roles only). */
export function hasMembershipFacts(m: TeamMember): boolean {
  return m.status === 'ACTIVE' && m.accessExpiresOn !== undefined;
}

/** The membership chips, filter and details only exist for a write role on a server-stored organization the server sent facts for. */
export function showMembershipDetails(canManageTenant: boolean, serverBacked: boolean, members: readonly TeamMember[]): boolean {
  return canManageTenant && serverBacked && members.some(hasMembershipFacts);
}

export function usPersonCounts(members: readonly TeamMember[]): { all: number; usPerson: number; other: number; notRecorded: number } {
  const c = { all: 0, usPerson: 0, other: 0, notRecorded: 0 };
  for (const m of members) {
    if (!hasMembershipFacts(m)) continue;
    c.all++;
    if (m.usPerson === 'US_PERSON') c.usPerson++;
    else if (m.usPerson === 'OTHER') c.other++;
    else c.notRecorded++;
  }
  return c;
}

/** 'all' keeps every row (pending invitations too); any other value keeps only the members that have that status. */
export function filterByUsPerson<T extends TeamMember>(members: readonly T[], f: UsPersonFilter): T[] {
  if (f === 'all') return [...members];
  return members.filter((m) => {
    if (!hasMembershipFacts(m)) return false;
    return f === 'NOT_RECORDED' ? m.usPerson == null : m.usPerson === f;
  });
}

export function usPersonFilterLabel(f: UsPersonFilter, c: ReturnType<typeof usPersonCounts>): string {
  switch (f) {
    case 'all': return `All (${c.all})`;
    case 'US_PERSON': return `US person (${c.usPerson})`;
    case 'OTHER': return `Other (${c.other})`;
    default: return `Not recorded (${c.notRecorded})`;
  }
}

export function teamEmptyText(f: UsPersonFilter): string {
  return f === 'all' ? MEMBERSHIP_TEXT.searchEmpty : MEMBERSHIP_TEXT.filterEmpty;
}

export interface ExpiryView {
  state: 'none' | 'active' | 'soon' | 'expired';
  chip: string | null;
  text: string;
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;

/** How an access end date reads right now. `daysLeft` is whole UTC days from today to the last day (0 = the last day is today). */
export function expiryView(expiresOn: string | null | undefined, nowMs: number): ExpiryView {
  if (expiresOn === null || expiresOn === undefined || expiresOn === '') return { state: 'none', chip: null, text: 'No end date', daysLeft: null };
  const ends = accessEndsAtMs(expiresOn);
  if (ends === null) return { state: 'expired', chip: MEMBERSHIP_TEXT.expiredBadge, text: 'The access end date cannot be read, so access is refused.', daysLeft: null };
  const d = formatUtcDate(expiresOn);
  if (nowMs >= ends) return { state: 'expired', chip: `Access expired ${d}`, text: `Access ended at 23:59 UTC on ${d}.`, daysLeft: null };
  const daysLeft = Math.round((Date.parse(`${expiresOn}T00:00:00.000Z`) - Date.parse(`${utcToday(nowMs)}T00:00:00.000Z`)) / DAY_MS);
  const text = `Access ends at 23:59 UTC on ${d}.`;
  if (daysLeft === 0) return { state: 'soon', chip: 'Access ends today (23:59 UTC)', text, daysLeft };
  if (daysLeft === 1) return { state: 'soon', chip: 'Access ends tomorrow (23:59 UTC)', text, daysLeft };
  if (daysLeft <= SOON_DAYS) return { state: 'soon', chip: `Access ends in ${daysLeft} days (${d}, 23:59 UTC)`, text, daysLeft };
  return { state: 'active', chip: `Access ends ${d} (23:59 UTC)`, text, daysLeft };
}

/** The member cannot open the organization: the server said so, or the end date has passed. Rows without membership facts are never expired. */
export function memberIsExpired(m: TeamMember, nowMs: number): boolean {
  if (!hasMembershipFacts(m)) return false;
  return m.membershipExpired === true || membershipExpired(m.accessExpiresOn, nowMs);
}

export function expiredSummaryText(n: number): string | null {
  if (n <= 0) return null;
  if (n === 1) return '1 member can no longer open this organization because their access end date has passed. Open their access details to extend it or remove it.';
  return `${n} members can no longer open this organization because their access end dates have passed. Open their access details to extend or remove them.`;
}

export interface MemberEditView {
  canEdit: boolean;
  expiry: 'edit' | 'owner_never' | 'self' | 'hidden';
  affiliation: boolean;
  usPerson: 'edit' | 'self' | 'hidden';
  primaryContact: boolean;
}

/** What the signed-in person may change on one member. The server enforces the same rules; this only mirrors them so the screen does not offer what would be refused. */
export function memberEditView(i: { actor: TenantRole | null | undefined; memberRole: TenantRole; isSelf: boolean; isPending: boolean; serverBacked: boolean; hasFacts: boolean }): MemberEditView {
  const base = i.serverBacked && i.hasFacts && !i.isPending && canRoleWrite(i.actor) && canManageRole(i.actor, i.memberRole);
  if (!base) return { canEdit: false, expiry: 'hidden', affiliation: false, usPerson: 'hidden', primaryContact: false };
  const actorOwner = isOwnerLevel(i.actor);
  return {
    canEdit: true,
    expiry: isOwnerLevel(i.memberRole) ? 'owner_never' : i.isSelf ? 'self' : 'edit',
    affiliation: true,
    usPerson: !actorOwner ? 'hidden' : i.isSelf ? 'self' : 'edit',
    primaryContact: actorOwner,
  };
}

export interface MemberProfileDraft {
  hasExpiry: boolean;
  expiresOn: string;
  affiliation: Affiliation | '';
  usPerson: UsPerson | '';
  primaryContact: boolean;
}

export function profileDraftFrom(m: TeamMember): MemberProfileDraft {
  return {
    hasExpiry: !!m.accessExpiresOn,
    expiresOn: m.accessExpiresOn ?? '',
    affiliation: m.affiliation ?? '',
    usPerson: m.usPerson ?? '',
    primaryContact: m.primaryContact === true,
  };
}

/** 'YYYY-MM-DD' plus whole days, in UTC. A value that is not a date comes back unchanged. */
export function addDaysUtc(ymd: string, days: number): string {
  const ok = parseExpiryDate(ymd);
  if (ok === null) return ymd;
  const [y, m, d] = ok.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The latest end date the server accepts today. */
export function maxExpiryDate(nowMs: number): string {
  return addDaysUtc(utcToday(nowMs), MAX_EXPIRY_DAYS);
}

/** Only the fields this person may edit and that differ from what the member has now. */
export function profilePatchFrom(m: TeamMember, d: MemberProfileDraft, v: MemberEditView): MemberProfilePatch {
  const patch: MemberProfilePatch = {};
  if (v.expiry === 'edit') {
    const next = d.hasExpiry ? d.expiresOn : null;
    if (next !== (m.accessExpiresOn ?? null)) patch.accessExpiresOn = next;
  }
  if (v.affiliation) {
    const next = d.affiliation === '' ? null : d.affiliation;
    if (next !== (m.affiliation ?? null)) patch.affiliation = next;
  }
  if (v.usPerson === 'edit') {
    const next = d.usPerson === '' ? null : d.usPerson;
    if (next !== (m.usPerson ?? null)) patch.usPerson = next;
  }
  if (v.primaryContact && d.primaryContact !== (m.primaryContact === true)) patch.primaryContact = d.primaryContact;
  return patch;
}

/** A reason the draft cannot be saved, or null. The end date is only checked when it is part of the change. */
export function draftProblem(m: TeamMember, d: MemberProfileDraft, v: MemberEditView, nowMs: number): string | null {
  const patch = profilePatchFrom(m, d, v);
  if (!('accessExpiresOn' in patch) || !d.hasExpiry) return null;
  if (!parseExpiryDate(d.expiresOn)) return MEMBERSHIP_TEXT.missingDate;
  const check = checkNewExpiry(d.expiresOn, nowMs);
  if (check === 'expiry_in_past') return MEMBERSHIP_TEXT.dateInPast;
  if (check === 'expiry_too_far') return MEMBERSHIP_TEXT.dateTooFar;
  return null;
}

export function patchSummaryText(p: MemberProfilePatch): string {
  const parts: string[] = [];
  if ('accessExpiresOn' in p) parts.push(p.accessExpiresOn ? `end access at 23:59 UTC on ${formatUtcDate(p.accessExpiresOn)}` : 'remove the access end date');
  if ('affiliation' in p) parts.push(p.affiliation ? `set the affiliation to ${AFFILIATION_LABELS[p.affiliation]}` : 'clear the affiliation');
  if ('usPerson' in p) parts.push(p.usPerson ? `record the US-person status as ${US_PERSON_LABELS[p.usPerson]}` : 'clear the US-person status');
  if ('primaryContact' in p) parts.push(p.primaryContact ? 'make them the primary contact' : 'remove them as the primary contact');
  return parts.length === 0 ? MEMBERSHIP_TEXT.noChanges : `Saving will ${parts.join(', ')}.`;
}

/** The help under the primary-contact box: names who is replaced when the box is ticked for somebody else. */
export function primaryContactHelp(members: readonly TeamMember[], targetId: string, checked: boolean): string {
  if (checked) {
    const other = members.find((x) => x.id !== targetId && x.primaryContact === true);
    if (other) return `This replaces ${other.email} as the primary contact.`;
  }
  return MEMBERSHIP_TEXT.primaryContactHelp;
}

export function usPersonRecordedText(at: string | null | undefined): string | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  return `Last recorded on ${formatUtcDate(new Date(ms).toISOString().slice(0, 10))} (UTC).`;
}

/** Added to the confirmation when a member who has an end date becomes an MSP Admin or a Tenant Owner (the server removes the date). Starts with a space. */
export function ownerPromotionExpiryNote(next: TenantRole, accessExpiresOn: string | null | undefined): string | null {
  if (!isOwnerLevel(next) || !accessExpiresOn) return null;
  return ` Their access end date (${formatUtcDate(accessExpiresOn)}, 23:59 UTC) will be removed, because MSP Admins and Tenant Owners never have one.`;
}

/** The moment access ends, in UTC and in the viewer's own time. Empty until the date is a real one. */
export function expiryPreviewText(ymd: string, fmt?: (d: Date) => string): string {
  const ends = accessEndsAtMs(ymd);
  if (ends === null) return '';
  return `Access ends at 23:59 UTC on ${formatUtcDate(ymd)} (${formatLocalDateTime(ends - 60000, fmt)} your time).`;
}

/** The banner a member sees when their own access ends within SOON_DAYS; null otherwise. */
export function memberExpiryBannerText(orgName: string, expiresOn: string | null | undefined, nowMs: number, fmt?: (d: Date) => string): string | null {
  const v = expiryView(expiresOn, nowMs);
  if (v.state !== 'soon' || !expiresOn || v.daysLeft === null) return null;
  const ends = accessEndsAtMs(expiresOn);
  if (ends === null) return null;
  const local = formatLocalDateTime(ends - 60000, fmt);
  const when = v.daysLeft === 0 ? 'ends today at 23:59 UTC' : v.daysLeft === 1 ? 'ends tomorrow at 23:59 UTC' : `ends in ${v.daysLeft} days, at 23:59 UTC on ${formatUtcDate(expiresOn)}`;
  return `Your access to ${orgName} ${when} (${local} your time). Ask the organization's owner to extend it if you still need it.`;
}

export function accessEndedText(orgName: string, expiredOn: string | null): string {
  return expiredOn
    ? `Your access to ${orgName} ended on ${formatUtcDate(expiredOn)} (UTC). Ask the organization's owner to extend it.`
    : `Your access to ${orgName} has ended. Ask the organization's owner to extend it.`;
}

/** Which ended-access notices to show: not dismissed, and either the organization was in this browser's list or nothing else is left to open. */
export function accessEndedToShow(expired: readonly ExpiredMembership[], cachedServerTenantIds: readonly string[], remainingServerCount: number, dismissed: readonly string[]): ExpiredMembership[] {
  return expired.filter((e) => !dismissed.includes(e.id) && (cachedServerTenantIds.includes(e.id) || remainingServerCount === 0));
}

/** Adds `next` to `prev` by id (the newer entry wins, the first position is kept). */
export function mergeAccessEnded(prev: readonly ExpiredMembership[], next: readonly ExpiredMembership[]): ExpiredMembership[] {
  const out = [...prev];
  for (const n of next) {
    const i = out.findIndex((p) => p.id === n.id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

const errParts = (err: unknown): { reason: string | undefined; status: number | undefined } => {
  const e = (err ?? {}) as { reason?: unknown; status?: unknown };
  return { reason: typeof e.reason === 'string' ? e.reason : undefined, status: typeof e.status === 'number' ? e.status : undefined };
};

/** A fixed message for a refused or failed member change. The server's own text is never shown. */
export function memberProfileErrorMessage(err: unknown): string {
  const { reason, status } = errParts(err);
  if (reason && SERVER_REASONS.includes(reason)) return MEMBER_PROFILE_ERROR_TEXT[reason as ServerReason];
  if (status === 404) return MEMBER_PROFILE_ERROR_TEXT.member_not_found;
  if (status === 400) return MEMBER_PROFILE_ERROR_TEXT.invalid_request;
  if (status === 0) return MEMBER_PROFILE_ERROR_TEXT.unreachable;
  if (status === 401) return MEMBER_PROFILE_ERROR_TEXT.session;
  if (status === 403) return MEMBER_PROFILE_ERROR_TEXT.forbidden;
  return MEMBER_PROFILE_ERROR_TEXT.failed;
}

/** The change was refused because the team list is out of date: reload it. */
export function memberProfileRefreshesTeam(err: unknown): boolean {
  const { reason, status } = errParts(err);
  return reason === 'primary_contact_conflict' || reason === 'member_not_found' || status === 404;
}

export function profileSavedText(email: string): string {
  return `Access details saved for ${email}.`;
}
