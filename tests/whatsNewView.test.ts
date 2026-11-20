import fs from 'fs';
import path from 'path';
import { ApiClient, ApiError, DEFAULT_ANNOUNCEMENT_LIMITS } from '../src/services/apiClient';
import type { AdminAnnouncement, NoticeAnnouncement, NoticesSnapshot } from '../src/services/apiClient';
import { parseReleaseNotes } from '../src/data/releaseNotes/releaseNotes';
import {
  NOTICES_RELOAD_MS,
  applyRead,
  badgeText,
  bannerAnnouncement,
  bannerMoreText,
  markReadErrorMessage,
  nextNoticesState,
  postedText,
  releaseView,
  releasedText,
  shouldReloadNotices,
  sortAnnouncements,
  whatsNewBadgeCount,
  whatsNewButtonLabel,
  type WhatsNewState,
} from '../src/data/whatsNewView';
import {
  ANNOUNCEMENT_TEXT,
  activeHeadingText,
  announcementDraftProblem,
  announcementEndIso,
  announcementEndText,
  announcementErrorMessage,
  announcementMetaText,
  atLimitText,
  maxAnnouncementEndDate,
  refreshesAnnouncements,
  splitAnnouncements,
} from '../src/data/announcementsView';

/**
 * What's new (issue #260): the view rules of the panel, badge and banner, the announcement editor rules, the ApiClient methods
 * against a stubbed fetch, and the wiring in the components (source checks). Pure test: no server, no browser.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.log(`  ✗ FAIL: ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

const ann = (id: string, o: Partial<NoticeAnnouncement> = {}): NoticeAnnouncement => ({
  id, title: `T ${id}`, body: `B ${id}`, severity: 'info', createdAt: '2026-11-19T10:00:00.000Z', expiresAt: null, read: false, ...o,
});
const snap = (o: Partial<NoticesSnapshot> = {}): NoticesSnapshot => ({ currentVersion: '0.6.0', notesAvailable: true, releaseReads: [], announcements: [], ...o });
const loaded = (o: Partial<NoticesSnapshot> = {}, stale = false): WhatsNewState => ({ kind: 'loaded', stale, ...snap(o) });

console.log('--- W1 badge ---');
assert(whatsNewBadgeCount(loaded({ announcements: [ann('a'), ann('b', { read: true })] })) === 2, 'W1: release plus one unread announcement is 2');
assert(whatsNewBadgeCount(loaded({ releaseReads: ['0.6.0'], announcements: [ann('a'), ann('b', { read: true })] })) === 1, 'W1: a read release leaves the announcement');
assert(whatsNewBadgeCount(loaded({ notesAvailable: false, announcements: [ann('a'), ann('b', { read: true })] })) === 1, 'W1: no notes for this version, so the release cannot be unread');
assert((['offline', 'loading', 'idle', 'error'] as const).every((k) => whatsNewBadgeCount({ kind: k }) === 0), 'W1: offline, loading, idle and error show no badge');
assert(whatsNewButtonLabel(0) === "What's new" && whatsNewButtonLabel(3) === "What's new, 3 unread", 'W1: the button label');
assert(badgeText(12) === '9+' && badgeText(3) === '3' && badgeText(9) === '9', 'W1: the badge text caps at 9+');

console.log('\n--- W2 nextNoticesState ---');
const s1 = nextNoticesState({ kind: 'idle' }, { ok: true, snapshot: snap() });
assert(s1.kind === 'loaded' && s1.stale === false, 'W2: idle plus ok is loaded, not stale', s1);
assert(nextNoticesState({ kind: 'loading' }, { ok: false, status: 0 }).kind === 'offline', 'W2: loading plus status 0 is offline');
assert(nextNoticesState({ kind: 'loading' }, { ok: false, status: 500 }).kind === 'error', 'W2: loading plus 500 is error');
const withAnn = loaded({ announcements: [ann('a')] });
const s2 = nextNoticesState(withAnn, { ok: false, status: 0 });
assert(s2.kind === 'loaded' && s2.stale === true && s2.announcements.length === 1 && s2.announcements[0].id === 'a', 'W2: loaded plus a failure keeps the data, stale', s2);
assert(nextNoticesState(withAnn, { ok: false, status: 401 }).kind === 'idle', 'W2: loaded plus 401 is idle');
const s3 = nextNoticesState(loaded({}, true), { ok: true, snapshot: snap() });
assert(s3.kind === 'loaded' && s3.stale === false, 'W2: a stale state plus ok is fresh');

console.log('\n--- W3 applyRead ---');
const r1 = applyRead(loaded(), 'release', '0.6.0');
assert(r1.kind === 'loaded' && r1.releaseReads.join() === '0.6.0', 'W3: a release adds its version');
const r2 = applyRead(r1, 'release', '0.6.0');
assert(r2.kind === 'loaded' && r2.releaseReads.length === 1, 'W3: ... once');
const r3 = applyRead(loaded({ announcements: [ann('a'), ann('b')] }), 'announcement', 'b');
assert(r3.kind === 'loaded' && r3.announcements.find((a) => a.id === 'b')?.read === true && r3.announcements.find((a) => a.id === 'a')?.read === false, 'W3: an announcement sets only its own read');
const off: WhatsNewState = { kind: 'offline' };
assert(applyRead(off, 'release', '0.6.0') === off, 'W3: a state that is not loaded comes back unchanged');

console.log('\n--- W4 order and banner ---');
const list = [
  ann('i1', { createdAt: '2026-11-19T12:00:00.000Z' }),
  ann('w-old', { severity: 'warning', createdAt: '2026-11-18T12:00:00.000Z' }),
  ann('w-new', { severity: 'warning', createdAt: '2026-11-19T08:00:00.000Z' }),
  ann('w-read', { severity: 'warning', createdAt: '2026-11-19T23:00:00.000Z', read: true }),
];
assert(sortAnnouncements(list).map((a) => a.id).join() === 'w-read,w-new,w-old,i1', 'W4: warnings first, then newest first', sortAnnouncements(list).map((a) => a.id));
const b = bannerAnnouncement(loaded({ announcements: list }));
assert(b?.announcement.id === 'w-new' && b.moreCount === 2, 'W4: the banner shows the newest unread warning and counts the other unread ones', b);
assert(bannerAnnouncement(loaded({ announcements: [ann('i1'), ann('w', { severity: 'warning', read: true })] })) === null, 'W4: no unread warning, no banner');
assert(bannerAnnouncement({ kind: 'offline' }) === null, 'W4: no banner when the server did not answer');
assert(bannerMoreText(1) === "1 more announcement in What's new." && bannerMoreText(2) === "2 more announcements in What's new.", 'W4: the "more" text');

console.log('\n--- W5 reload rule ---');
assert(shouldReloadNotices(null, 0) === true, 'W5: never loaded reloads');
assert(shouldReloadNotices(0, NOTICES_RELOAD_MS - 1) === false, 'W5: just under 5 minutes does not');
assert(shouldReloadNotices(0, NOTICES_RELOAD_MS) === true, 'W5: 5 minutes does');

console.log('\n--- W6 releaseView ---');
const notes = parseReleaseNotes({
  schemaVersion: 1,
  releases: [
    { version: '0.6.0', date: '2026-11-19', summary: 'Six', sections: [{ heading: 'New', items: ['One'] }] },
    { version: '0.5.0', date: '2026-11-01', summary: 'Five', sections: [{ heading: 'New', items: ['Two'] }] },
  ],
});
const v1 = releaseView(notes, loaded());
assert(v1.current?.version === '0.6.0' && v1.earlier.map((r) => r.version).join() === '0.5.0' && v1.canMark === true && v1.read === false && v1.missingText === null, 'W6: loaded at 0.6.0', v1);
const v2 = releaseView(notes, { kind: 'offline' });
assert(v2.currentVersion === '0.6.0' && v2.read === null && v2.canMark === false, 'W6: offline uses the newest bundled release and cannot mark', v2);
const v3 = releaseView(notes, loaded({ currentVersion: '0.7.0' }));
assert(v3.current === null && v3.missingText === 'The release notes for version 0.7.0 are not in this copy of the app. Reload the page to load them.', 'W6: a version without notes says so', v3);
assert(releaseView(notes, loaded({ releaseReads: ['0.6.0'] })).canMark === false, 'W6: after read, canMark is false');
assert(releaseView(notes, loaded({ notesAvailable: false })).canMark === false, 'W6: no server-side notes, canMark is false');
assert(releasedText('2026-11-19') === 'Released 19 Nov 2026', 'W6: releasedText');
assert(postedText({ createdAt: '2026-11-20T14:05:00.000Z', expiresAt: null }) === 'Posted 20 Nov 2026, 14:05 UTC', 'W6: postedText without an end');
assert(postedText({ createdAt: '2026-11-20T14:05:00.000Z', expiresAt: '2026-11-25T00:00:00.000Z' }) === 'Posted 20 Nov 2026, 14:05 UTC · Shown until 25 Nov 2026, 00:00 UTC', 'W6: postedText with an end');

console.log('\n--- W7 markReadErrorMessage ---');
assert(markReadErrorMessage({ status: 404 }) === 'This announcement is no longer shown. The list was reloaded.', 'W7: 404');
assert(markReadErrorMessage({ status: 400, reason: 'not_found' }) === 'This announcement is no longer shown. The list was reloaded.', 'W7: reason not_found');
assert(markReadErrorMessage({ status: 0 }) === 'Cannot reach the server. It was not marked as read.', 'W7: unreachable');
assert(markReadErrorMessage({ status: 401 }) === 'Your session has ended. Sign in again.', 'W7: 401');
assert(markReadErrorMessage(new Error('x')) === 'It could not be marked as read. Try again.', 'W7: anything else');

console.log('\n--- AN1 announcement draft checks ---');
const L = DEFAULT_ANNOUNCEMENT_LIMITS;
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const okDraft = { title: 'Maintenance', body: 'Tonight', hasEnd: false, endDate: '' };
const prob = (o: Partial<typeof okDraft>) => announcementDraftProblem({ ...okDraft, ...o }, L, NOW);
assert(prob({}) === null, 'AN1: a good draft has no problem');
assert(prob({ title: '   ' }) === 'Enter a title.', 'AN1: empty title');
assert(prob({ title: 'a\nb' }) === 'The title must be one line.', 'AN1: multi-line title');
assert(prob({ title: 'x'.repeat(121) }) === 'The title can be at most 120 characters.', 'AN1: long title');
assert(prob({ body: '  \n ' }) === 'Enter the announcement text.', 'AN1: empty text');
assert(prob({ body: 'x'.repeat(2001) }) === 'The text can be at most 2000 characters.', 'AN1: long text');
assert(prob({ body: 'a\u0001b' }) === 'The text contains control characters.', 'AN1: control characters');
assert(prob({ hasEnd: true, endDate: '' }) === 'Choose the last day the announcement is shown, or turn off the end date.', 'AN1: end date missing');
assert(prob({ hasEnd: true, endDate: '2026-11-18' }) === 'The end date has already passed in UTC.', 'AN1: end date in the past');
assert(prob({ hasEnd: true, endDate: '2026-11-19' }) === null, 'AN1: today is allowed');
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) + n * 86400000).toISOString().slice(0, 10);
assert(prob({ hasEnd: true, endDate: addDays('2026-11-19', 364) }) === null, 'AN1: 364 days ahead is allowed');
assert(prob({ hasEnd: true, endDate: addDays('2026-11-19', 365) }) === 'The end date can be at most 365 days away.', 'AN1: 365 days ahead is too far');
assert(maxAnnouncementEndDate(NOW, L) === addDays('2026-11-19', 364), 'AN1: maxAnnouncementEndDate');

console.log('\n--- AN2 end moment ---');
assert(announcementEndIso('2026-11-19') === '2026-11-20T00:00:00.000Z', 'AN2: the end is the start of the next UTC day');
assert(announcementEndIso('2026-12-31') === '2027-01-01T00:00:00.000Z', 'AN2: across a year');
assert(announcementEndText('2026-11-19') === 'Shown until 23:59 UTC on 19 Nov 2026.', 'AN2: announcementEndText');
// the server accepts an end at most maxExpiryDays from now: the latest allowed day must stay inside it
assert(Date.parse(announcementEndIso(maxAnnouncementEndDate(NOW, L))) <= NOW + L.maxExpiryDays * 86400000, 'AN2: the latest day ends inside the server limit');

console.log('\n--- AN3 split and texts ---');
const adm = (id: string, o: Partial<AdminAnnouncement> = {}): AdminAnnouncement => ({
  id, title: id, body: id, severity: 'info', createdAt: '2026-11-19T10:00:00.000Z', expiresAt: null,
  createdByUserId: 'u1', withdrawnAt: null, withdrawnByUserId: null, ...o,
});
const split = splitAnnouncements([
  adm('act-old', { createdAt: '2026-11-17T10:00:00.000Z' }),
  adm('act-new', { expiresAt: '2026-12-01T00:00:00.000Z' }),
  adm('withdrawn', { withdrawnAt: '2026-11-19T11:00:00.000Z', withdrawnByUserId: 'u1' }),
  adm('lapsed', { expiresAt: '2026-11-19T11:00:00.000Z' }),
], NOW);
assert(split.active.map((a) => a.id).join() === 'act-new,act-old', 'AN3: active, newest first', split.active.map((a) => a.id));
assert(split.ended.map((a) => a.id).sort().join() === 'lapsed,withdrawn', 'AN3: withdrawn and lapsed are ended', split.ended.map((a) => a.id));
assert(activeHeadingText(2, 5) === 'Active (2 of 5)', 'AN3: activeHeadingText');
assert(atLimitText(5) === 'There are 5 active announcements, the most allowed. Withdraw one to post another.', 'AN3: atLimitText');
assert(announcementMetaText(adm('x', { withdrawnAt: '2026-11-19T11:00:00.000Z' }), NOW).includes('Withdrawn 19 Nov 2026, 11:00 UTC'), 'AN3: withdrawn meta');
assert(announcementMetaText(adm('x', { expiresAt: '2026-12-01T00:00:00.000Z' }), NOW).includes('Shown until 1 Dec 2026, 00:00 UTC'), 'AN3: active meta with an end');
assert(announcementMetaText(adm('x', { expiresAt: '2026-11-19T11:00:00.000Z' }), NOW).includes('Ended 19 Nov 2026, 11:00 UTC'), 'AN3: lapsed meta');

console.log('\n--- AN4 error texts ---');
const em = (err: unknown, op: 'post' | 'withdraw' = 'post') => announcementErrorMessage(err, op, L);
assert(em({ reason: 'invalid_code', status: 403 }).startsWith('That code is not correct'), 'AN4: invalid_code is read before the 403 status');
assert(em({ reason: 'code_required', status: 400 }) === 'Enter the 6-digit code from your authenticator app.', 'AN4: code_required');
assert(em({ reason: 'mfa_not_enrolled', status: 403 }) === ANNOUNCEMENT_TEXT.needsMfa, 'AN4: mfa_not_enrolled');
assert(em({ reason: 'too_many_active', status: 409 }) === 'There are already 5 active announcements. Withdraw one before posting another. Nothing was posted.', 'AN4: too_many_active');
assert(em({ reason: 'invalid_request', status: 400 }).startsWith('The announcement was not accepted.'), 'AN4: invalid_request');
assert(em({ reason: 'already_withdrawn', status: 409 }, 'withdraw') === 'This announcement was already withdrawn. The list was reloaded.', 'AN4: already_withdrawn');
assert(em({ status: 404 }, 'withdraw') === 'This announcement no longer exists. The list was reloaded.', 'AN4: 404');
assert(em({ status: 403 }) === ANNOUNCEMENT_TEXT.forbidden, 'AN4: a plain 403');
assert(em({ status: 429 }).startsWith('Too many attempts.') && em({ status: 423 }).startsWith('Too many attempts.'), 'AN4: lockout');
assert(em({ status: 0 }).startsWith('Cannot reach the server.'), 'AN4: unreachable');
assert(em({ status: 401 }) === 'Your session has ended. Sign in again.', 'AN4: 401');
assert(em({ status: 500 }) === 'The announcement could not be posted. Try again.' && em({ status: 500 }, 'withdraw') === 'The announcement could not be withdrawn. Try again.', 'AN4: anything else, per operation');
assert(em(new Error('boom')) === 'The announcement could not be posted. Try again.', 'AN4: a non-ApiError');
const allTexts = [...['invalid_request', 'code_required', 'invalid_code', 'mfa_not_enrolled', 'too_many_active', 'already_withdrawn', 'not_found'].map((r) => em({ reason: r })), em({ status: 0 }), em({ status: 401 }), em({ status: 429 })];
assert(allTexts.every((t) => !t.includes('_')), 'AN4: no machine key leaks into a text', allTexts);
assert(refreshesAnnouncements({ reason: 'already_withdrawn' }) && refreshesAnnouncements({ reason: 'not_found' }) && refreshesAnnouncements({ reason: 'too_many_active' }) && refreshesAnnouncements({ status: 404 }), 'AN5: these failures reload the list');
assert(!refreshesAnnouncements({ reason: 'invalid_code', status: 403 }) && !refreshesAnnouncements({ status: 500 }) && !refreshesAnnouncements(null), 'AN5: these do not');

console.log('\n--- API1-API4 against a stubbed fetch ---');
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
const realFetch = globalThis.fetch;
interface Seen { url: string; init: RequestInit }
let seen: Seen | null = null;
function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
  }) as typeof fetch;
}
const headerNames = (s: Seen | null) => Object.keys((s?.init.headers as Record<string, string> | undefined) ?? {}).map((h) => h.toLowerCase());
async function attempt(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}

(async () => {
  try {
    stub(200, { currentVersion: '0.6.0', notesAvailable: true, releaseReads: ['0.5.0', 7], announcements: [{ id: 'a', title: 'T', body: 'B', severity: 'loud', createdAt: '2026-11-19T10:00:00.000Z', expiresAt: null }, { id: 5 }] });
    let r = await attempt(() => ApiClient.getNotices());
    const n = r.value as NoticesSnapshot;
    assert(seen?.url.endsWith('/api/v1/me/notices') === true && (seen?.init.method ?? 'GET') === 'GET', 'API1: GET /api/v1/me/notices', seen?.url);
    assert(seen?.init.cache === 'no-store', 'API1: not cached', seen?.init.cache);
    assert(!headerNames(seen).includes('x-tenant-id') && !headerNames(seen).includes('x-program-id'), 'API1: no organization or program header', headerNames(seen));
    assert(n.announcements.length === 1 && n.announcements[0].severity === 'info' && n.announcements[0].read === false, 'API1: a bogus severity is info, a missing read is false, a bad entry is dropped', n);
    assert(n.releaseReads.join() === '0.5.0', 'API1: only string release reads are kept', n.releaseReads);

    stub(200, { notesAvailable: true });
    r = await attempt(() => ApiClient.getNotices());
    assert(r.error instanceof ApiError && r.error.status === 502, 'API1: a missing currentVersion is an ApiError 502', r.error);

    stub(204, null);
    r = await attempt(() => ApiClient.markNoticeRead('release', '0.5.0'));
    assert(r.error === undefined && seen?.url.endsWith('/api/v1/me/notices/read') === true && seen?.init.method === 'POST' && seen?.init.body === '{"kind":"release","ref":"0.5.0"}', 'API2: markNoticeRead posts kind and ref', seen);

    const created = { id: 'n1', title: 'T', body: 'B', severity: 'info', createdAt: '2026-11-19T10:00:00.000Z', expiresAt: null, createdByUserId: 'u1', withdrawnAt: null, withdrawnByUserId: null };
    stub(201, { announcement: created });
    r = await attempt(() => ApiClient.postAnnouncement({ title: 'T', body: 'B', severity: 'info', expiresAt: null }, '123456'));
    const sent = JSON.parse(String(seen?.init.body)) as Record<string, unknown>;
    assert(seen?.url.endsWith('/api/v1/platform/announcements') === true && !('expiresAt' in sent) && sent.code === '123456' && sent.title === 'T', 'API3: postAnnouncement leaves out a null expiresAt and sends the code', sent);

    stub(200, { announcement: { ...created, withdrawnAt: '2026-11-19T11:00:00.000Z', withdrawnByUserId: 'u1' } });
    r = await attempt(() => ApiClient.withdrawAnnouncement('a 1', '123456'));
    assert(seen?.url.endsWith('/api/v1/platform/announcements/a%201/withdraw') === true && seen?.init.body === '{"code":"123456"}', 'API4: withdrawAnnouncement encodes the id and sends the code', seen);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n--- SRC source checks ---');
  const header = read('src/components/layout/Header.tsx');
  const panel = read('src/components/layout/WhatsNewPanel.tsx');
  const section = read('src/components/admin/AnnouncementsSection.tsx');
  const dash = read('src/components/admin/SuperAdminDashboard.tsx');
  assert(header.includes("import { WhatsNewPanel } from './WhatsNewPanel'") && header.includes("import { AnnouncementBanner } from './AnnouncementBanner'"), 'SRC1: Header imports the panel and the banner');
  assert(header.indexOf('<BrowserOnlyNotesBanner />') < header.indexOf('<AnnouncementBanner'), 'SRC1: the banner comes after the browser-only notes banner');
  assert(header.includes('aria-haspopup="dialog"') && header.includes('whatsNewButtonLabel(unread)'), 'SRC1: the button names the unread count and opens a dialog');
  assert(panel.includes("import('../../data/releaseNotes/releaseNotes.json')") && panel.includes('max-h-[') && panel.includes('whitespace-pre-line'), 'SRC2: the panel loads the notes lazily, caps its height and shows text as text');
  const forbidden = /dangerouslySetInnerHTML|console\.|localStorage|sessionStorage|\balert\(/;
  const files = ['src/components/layout/WhatsNewPanel.tsx', 'src/components/layout/AnnouncementBanner.tsx', 'src/components/admin/AnnouncementsSection.tsx', 'src/hooks/useWhatsNew.ts', 'src/data/whatsNewView.ts', 'src/data/announcementsView.ts'];
  for (const f of files) assert(!forbidden.test(read(f)), `SRC3: ${f} has no HTML injection, console, browser storage or alert`);
  assert(section.includes(ANNOUNCEMENT_TEXT.cuiWarning) || section.includes('ANNOUNCEMENT_TEXT.cuiWarning'), 'SRC4: the section shows the CUI warning');
  assert(ANNOUNCEMENT_TEXT.cuiWarning === 'Shown to every user of every organization on this server. Do not include CUI.', 'SRC4: the CUI warning text');
  assert(ANNOUNCEMENT_TEXT.codeLabel === 'Code from your authenticator app' && section.includes('ANNOUNCEMENT_TEXT.codeLabel'), 'SRC4: the code field label');
  assert(section.includes('<fieldset disabled=') && section.includes('role="alertdialog"') && section.includes('autoComplete="one-time-code"'), 'SRC4: the form is disabled while busy, the withdraw dialog is an alertdialog, the code is one-time');
  assert(dash.indexOf('<SystemUseNoticeSection />') !== -1 && dash.indexOf('<SystemUseNoticeSection />') < dash.indexOf('<AnnouncementsSection />'), 'SRC5: the console mounts the section after the system use notice');
  const vite = read('vite.config.ts');
  assert(vite.includes("'/src/data/releaseNotes/'") && vite.includes("'release-notes'"), 'SRC6: the release notes JSON is its own lazy chunk');

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  if (passed !== total) process.exitCode = 1;
})();
