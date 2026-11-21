/**
 * What's new (issue #260): the view rules of the release notes panel, the unread badge and the warning banner. Pure: no React, no
 * services, no storage. Whether something is read is kept by the server; this file only decides what to show from the last answer.
 */
import { compareVersions, unreadCount, type ReleaseNotes } from './releaseNotes/releaseNotes';
import type { NoticeAnnouncement, NoticeKind, NoticesSnapshot } from '../services/apiClient';
import { formatUtcDate, formatUtcDateTime } from '../utils/utcDates';

export type WhatsNewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'error' }
  | ({ kind: 'loaded'; stale: boolean } & NoticesSnapshot);

export type NoticesOutcome = { ok: true; snapshot: NoticesSnapshot } | { ok: false; status: number };
export type Release = ReleaseNotes['releases'][number];

/** A tab that becomes visible again after this long asks the server again. There is no timer. */
export const NOTICES_RELOAD_MS = 5 * 60 * 1000;

export const WHATS_NEW_TEXT = {
  button: "What's new",
  panelTitle: "What's new",
  close: "Close What's new",
  announcementsHeading: 'Announcements',
  announcementsFrom: 'From the platform administrator of this server',
  noAnnouncements: 'No announcements right now.',
  loading: 'Checking for announcements…',
  offline: 'The server cannot be reached, so announcements are not shown and nothing can be marked as read. The release notes below come with the app.',
  loadFailed: 'Announcements could not be loaded.',
  stale: 'Could not check the server just now. Showing what was loaded earlier.',
  retry: 'Try again',
  markRead: 'Mark as read',
  marking: 'Saving…',
  read: 'Read',
  unreadTag: 'New',
  warning: 'Warning',
  info: 'Information',
  thisVersion: 'This version',
  earlierHeading: 'Earlier versions',
  notesLoading: 'Loading the release notes…',
  notesFailed: 'The release notes in this copy of the app could not be read.',
  bannerLabel: 'Platform announcement',
  bannerOpen: "Read in What's new",
  dismiss: 'Dismiss',
} as const;

export function noticeKey(kind: NoticeKind, ref: string): string {
  return `${kind}:${ref}`;
}

/** The next state after a load: success replaces everything, a failure keeps what was loaded before (marked stale). */
export function nextNoticesState(prev: WhatsNewState, o: NoticesOutcome): WhatsNewState {
  if (o.ok) return { kind: 'loaded', stale: false, ...o.snapshot };
  if (o.status === 401) return { kind: 'idle' };
  if (prev.kind === 'loaded') return { ...prev, stale: true };
  return o.status === 0 ? { kind: 'offline' } : { kind: 'error' };
}

/** The state after a successful "mark as read": the release version is added once, or that one announcement is set to read. */
export function applyRead(s: WhatsNewState, kind: NoticeKind, ref: string): WhatsNewState {
  if (s.kind !== 'loaded') return s;
  if (kind === 'release') {
    return s.releaseReads.includes(ref) ? s : { ...s, releaseReads: [...s.releaseReads, ref] };
  }
  return { ...s, announcements: s.announcements.map((a) => (a.id === ref ? { ...a, read: true } : a)) };
}

/** The number on the badge: 0 unless the server answered. When this copy has no notes for the version, they cannot be unread. */
export function whatsNewBadgeCount(s: WhatsNewState): number {
  if (s.kind !== 'loaded') return 0;
  return unreadCount({
    currentVersion: s.currentVersion,
    readVersions: s.notesAvailable ? s.releaseReads : [...s.releaseReads, s.currentVersion],
    announcements: s.announcements.map((a) => ({ id: a.id, read: a.read })),
  });
}

export function whatsNewButtonLabel(n: number): string {
  return n > 0 ? `${WHATS_NEW_TEXT.button}, ${n} unread` : WHATS_NEW_TEXT.button;
}

export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}

/** Warnings first, then the newest first. */
export function sortAnnouncements(list: readonly NoticeAnnouncement[]): NoticeAnnouncement[] {
  return [...list].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warning' ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

/** The banner shows the newest unread warning, and how many other unread announcements wait in the panel. */
export function bannerAnnouncement(s: WhatsNewState): { announcement: NoticeAnnouncement; moreCount: number } | null {
  if (s.kind !== 'loaded') return null;
  const unread = s.announcements.filter((a) => !a.read);
  const warning = sortAnnouncements(unread).find((a) => a.severity === 'warning');
  if (!warning) return null;
  return { announcement: warning, moreCount: unread.length - 1 };
}

export function bannerMoreText(n: number): string {
  return n === 1 ? "1 more announcement in What's new." : `${n} more announcements in What's new.`;
}

export function shouldReloadNotices(lastLoadedAtMs: number | null, nowMs: number): boolean {
  return lastLoadedAtMs === null || nowMs - lastLoadedAtMs >= NOTICES_RELOAD_MS;
}

export interface ReleaseView {
  currentVersion: string;
  current: Release | null;
  earlier: Release[];
  read: boolean | null;
  canMark: boolean;
  missingText: string | null;
}

/** Which notes are "this version" and which are earlier. Without the server's answer the newest bundled release stands in. */
export function releaseView(notes: ReleaseNotes, s: WhatsNewState): ReleaseView {
  const loaded = s.kind === 'loaded';
  const v = loaded ? s.currentVersion : notes.releases[0]?.version ?? '';
  const current = notes.releases.find((r) => r.version === v) ?? null;
  const earlier = notes.releases.filter((r) => compareVersions(r.version, v) < 0);
  const read = loaded ? s.releaseReads.includes(v) : null;
  return {
    currentVersion: v,
    current,
    earlier,
    read,
    canMark: loaded && s.notesAvailable && !!current && !read,
    missingText: current ? null : `The release notes for version ${v} are not in this copy of the app. Reload the page to load them.`,
  };
}

export function releasedText(ymd: string): string {
  return `Released ${formatUtcDate(ymd)}`;
}

export function postedText(a: { createdAt: string; expiresAt: string | null }): string {
  return `Posted ${formatUtcDateTime(a.createdAt)}${a.expiresAt ? ` · Shown until ${formatUtcDateTime(a.expiresAt)}` : ''}`;
}

/** The message after a failed "mark as read" (an ApiError carries status and, for the server's coded refusals, reason). */
export function markReadErrorMessage(err: unknown): string {
  const e = err as { status?: unknown; reason?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : -1;
  if (e?.reason === 'not_found' || status === 404) return 'This announcement is no longer shown. The list was reloaded.';
  if (status === 0) return 'Cannot reach the server. It was not marked as read.';
  if (status === 401) return 'Your session has ended. Sign in again.';
  return 'It could not be marked as read. Try again.';
}
