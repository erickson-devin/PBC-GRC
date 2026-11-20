/**
 * Platform announcements (issue #260): the wording and the rules of the editor on the administrator screen. Pure: no React, no
 * services, no storage. The server enforces the same limits; this file only gives the early message and the text for each refusal.
 * Titles and texts are never logged and are rendered as plain text.
 */
import type { AdminAnnouncement, AnnouncementLimits } from '../services/apiClient';
import { normalizeNoticeText } from './systemUseNotice';
import { formatUtcDate, formatUtcDateTime } from '../utils/utcDates';
import { utcToday } from '../utils/memberProfile';

export const ANNOUNCEMENT_TEXT = {
  heading: 'Announcements',
  lead: "Short messages shown in every person's What's new panel, for example planned maintenance. A warning is also shown as a banner at the top of the app until each person dismisses it.",
  cuiWarning: 'Shown to every user of every organization on this server. Do not include CUI.',
  formLegend: 'New announcement',
  titleLabel: 'Title',
  bodyLabel: 'Text',
  severityLegend: 'Type',
  severityInfo: "Information: shown in What's new",
  severityWarning: 'Warning: also shown as a banner at the top of the app until each person dismisses it',
  endToggle: 'Stop showing it after a set day',
  endLabel: 'Last day shown',
  previewHeading: 'Preview',
  codeLabel: 'Code from your authenticator app',
  codeHelp: 'Posting and withdrawing need a fresh code. A code works once.',
  needsMfa: 'Set up two-step verification on your own account before you post or withdraw announcements.',
  post: 'Post announcement',
  posting: 'Posting…',
  clear: 'Clear',
  posted: "Posted. People see it the next time they open the app or the What's new panel.",
  activeEmpty: 'No active announcements.',
  endedHeading: 'Withdrawn and ended',
  loading: 'Loading announcements…',
  loadFailed: 'The announcements could not be loaded. Check the connection to the server and try again.',
  forbidden: 'Only platform administrators can post or withdraw announcements.',
  withdraw: 'Withdraw',
  withdrawing: 'Withdrawing…',
  withdrawTitle: 'Withdraw announcement',
  withdrawLead: 'stops being shown to everyone right away, including people who have not read it yet. This cannot be undone: post it again if it is still needed.',
  withdrawn: 'Withdrawn. It is no longer shown.',
  refresh: 'Refresh',
  cancel: 'Cancel',
} as const;

export interface AnnouncementDraft {
  title: string;
  body: string;
  hasEnd: boolean;
  endDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Control characters other than a line break and a tab (the same set the system use notice refuses). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdMs(ymd: string): number | null {
  if (!YMD.test(ymd)) return null;
  const ms = Date.parse(`${ymd}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === ymd ? ms : null;
}

/** The last day an announcement can be shown: the server accepts an end up to maxExpiryDays from now. */
export function maxAnnouncementEndDate(nowMs: number, limits: AnnouncementLimits): string {
  const t = ymdMs(utcToday(nowMs)) ?? nowMs;
  return new Date(t + (limits.maxExpiryDays - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** The moment the announcement stops: the start of the day after the last day shown, in UTC. */
export function announcementEndIso(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString();
}

export function announcementEndText(ymd: string): string {
  return ymdMs(ymd) === null ? '' : `Shown until 23:59 UTC on ${formatUtcDate(ymd)}.`;
}

/** The first problem with a draft, or null. Mirrors the server's checks so the message comes before the code is asked for. */
export function announcementDraftProblem(d: AnnouncementDraft, limits: AnnouncementLimits, nowMs: number): string | null {
  if (d.title.trim().length === 0) return 'Enter a title.';
  if (/[\r\n]/.test(d.title.trim())) return 'The title must be one line.';
  if (d.title.trim().length > limits.titleMax) return `The title can be at most ${limits.titleMax} characters.`;
  const body = normalizeNoticeText(d.body);
  if (body.length === 0) return 'Enter the announcement text.';
  if (body.length > limits.bodyMax) return `The text can be at most ${limits.bodyMax} characters.`;
  if (CONTROL_CHARS.test(body)) return 'The text contains control characters.';
  if (d.hasEnd) {
    const end = ymdMs(d.endDate);
    if (end === null) return 'Choose the last day the announcement is shown, or turn off the end date.';
    if (end < (ymdMs(utcToday(nowMs)) ?? 0)) return 'The end date has already passed in UTC.';
    if (end > (ymdMs(maxAnnouncementEndDate(nowMs, limits)) ?? 0)) return `The end date can be at most ${limits.maxExpiryDays} days away.`;
  }
  return null;
}

function createdDesc(a: AdminAnnouncement, b: AdminAnnouncement): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** Active: not withdrawn and not yet past its end. Both lists newest first. */
export function splitAnnouncements(list: readonly AdminAnnouncement[], nowMs: number): { active: AdminAnnouncement[]; ended: AdminAnnouncement[] } {
  const active: AdminAnnouncement[] = [];
  const ended: AdminAnnouncement[] = [];
  for (const a of list) {
    const live = !a.withdrawnAt && (!a.expiresAt || Date.parse(a.expiresAt) > nowMs);
    (live ? active : ended).push(a);
  }
  return { active: active.sort(createdDesc), ended: ended.sort(createdDesc) };
}

export function activeHeadingText(n: number, max: number): string {
  return `Active (${n} of ${max})`;
}

export function atLimitText(max: number): string {
  return `There are ${max} active announcements, the most allowed. Withdraw one to post another.`;
}

export function announcementMetaText(a: AdminAnnouncement, nowMs: number): string {
  const posted = `Posted ${formatUtcDateTime(a.createdAt)}`;
  if (a.withdrawnAt) return `${posted} · Withdrawn ${formatUtcDateTime(a.withdrawnAt)}`;
  if (a.expiresAt) return `${posted} · ${Date.parse(a.expiresAt) > nowMs ? 'Shown until' : 'Ended'} ${formatUtcDateTime(a.expiresAt)}`;
  return posted;
}

/** The text after a refused or failed post or withdraw. The server's `reason` is read before the status (a wrong code is a 403). */
export function announcementErrorMessage(err: unknown, op: 'post' | 'withdraw', limits: AnnouncementLimits): string {
  const e = err as { status?: unknown; reason?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : -1;
  switch (e?.reason) {
    case 'invalid_request':
      return 'The announcement was not accepted. Check the title (one line), the text and the end date.';
    case 'code_required':
      return 'Enter the 6-digit code from your authenticator app.';
    case 'invalid_code':
      return 'That code is not correct or was already used. Wait for the next code in your authenticator app and try again.';
    case 'mfa_not_enrolled':
      return ANNOUNCEMENT_TEXT.needsMfa;
    case 'too_many_active':
      return `There are already ${limits.maxActive} active announcements. Withdraw one before posting another. Nothing was posted.`;
    case 'already_withdrawn':
      return 'This announcement was already withdrawn. The list was reloaded.';
    case 'not_found':
      return 'This announcement no longer exists. The list was reloaded.';
    default:
      break;
  }
  if (status === 404) return 'This announcement no longer exists. The list was reloaded.';
  if (status === 403) return ANNOUNCEMENT_TEXT.forbidden;
  if (status === 423 || status === 429) return 'Too many attempts. Wait a few minutes, then try again with a new code.';
  if (status === 0) return 'Cannot reach the server. Nothing was changed. Check your connection and try again.';
  if (status === 401) return 'Your session has ended. Sign in again.';
  return op === 'post' ? 'The announcement could not be posted. Try again.' : 'The announcement could not be withdrawn. Try again.';
}

/** Whether the list on screen is probably out of date after this failure, so it is loaded again. */
export function refreshesAnnouncements(err: unknown): boolean {
  const e = err as { status?: unknown; reason?: unknown } | null;
  return e?.reason === 'already_withdrawn' || e?.reason === 'not_found' || e?.reason === 'too_many_active' || e?.status === 404;
}
