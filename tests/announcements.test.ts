import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { server } from '../server/index';
import { base32Decode, generateTotp } from '../server/auth/totp';
import { __resetMemoryLocalUsersForTests, createLocalUser } from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests } from '../server/db';
import { __resetMemoryInvitationsForTests } from '../server/invitations';
import { __resetPlatformSetupForTests, addPlatformAdmin } from '../server/platformSetup';
import { __resetLoginThrottleForTests, __resetMfaStateForTests, __setMfaClockForTests } from '../server/routes/auth';
import { __resetSessionsForTests } from '../server/auth/sessionStore';
import { __resetMfaRequirementCacheForTests } from '../server/auth/mfaEnforcement';
import { __resetAccountEventsForTests } from '../server/auth/accountEvents';
import { __resetAnnouncementsForTests, __setAnnouncementClockForTests } from '../server/announcements';
import { __resetNoticeReadsForTests } from '../server/noticeReads';
import { sessionCookieFrom } from './sessionCookieJar';

/**
 * What's new and platform announcements (issue #260), end to end through the real server: the per-user notices endpoint, the
 * platform administrator's post and withdraw (step-up code), the limit of 5 active, expiry, per-user read state, and the events that
 * record posting and withdrawing (the announcement id only; the title and body never reach a log or an event).
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const PW = 'correct horse battery staple';
const T = Math.floor(Date.now() / 30000) * 30000 + 1000;
const STEP = 30000;
const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    out.log(`  ✓ PASS: ${name}`);
  } else {
    out.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  __resetLoginThrottleForTests();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: Record<string, any> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* no body (204) */
  }
  const cookie = sessionCookieFrom(res.headers);
  if (body && cookie && body.token === undefined) body.token = cookie;
  return { status: res.status, headers: res.headers, body, text };
}

interface Acct {
  email: string;
  id: string;
  secret: Buffer | null;
  k: number;
}
const setClock = (ms: number | null) => __setMfaClockForTests(ms === null ? null : () => ms);
const fresh = (a: Acct): string => {
  a.k += 1;
  setClock(T + a.k * STEP);
  return generateTotp(a.secret!, T + a.k * STEP);
};
const login = (email: string) => call('POST', '/auth/login', { body: { email, password: PW } });
async function mk(name: string): Promise<Acct> {
  const email = `${name}@announce.mil`;
  const u = await createLocalUser({ email, name: `Name ${name}`, password: PW });
  return { email, id: u.id, secret: null, k: 0 };
}
async function enrol(a: Acct): Promise<void> {
  process.env.MFA_REQUIRED = 'off';
  const token: string = (await login(a.email)).body?.token;
  const start = await call('POST', '/auth/mfa/enrol/start', { token });
  a.secret = start.body?.secret ? base32Decode(start.body.secret) : null;
  a.k = 0;
  setClock(T);
  await call('POST', '/auth/mfa/enrol/confirm', { token, body: { code: generateTotp(a.secret!, T) } });
}

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  __resetMemoryLocalUsersForTests();
  __resetMemoryTenantsForTests();
  __resetPlatformSetupForTests();
  __resetMemoryInvitationsForTests();
  __resetMfaStateForTests();
  __resetSessionsForTests();
  __resetMfaRequirementCacheForTests();
  __resetAccountEventsForTests();
  __resetAnnouncementsForTests();
  __resetNoticeReadsForTests();
  process.env.MFA_REQUIRED = 'off';
  setClock(T);

  const captured: string[] = [];
  const grab = (...args: unknown[]) => void captured.push(util.format(...args));

  const adm = await mk('admin260');
  await addPlatformAdmin({ userId: adm.id, email: adm.email });
  await enrol(adm);
  const alice = await mk('alice260');
  const bob = await mk('bob260');
  const adminStep1 = await login(adm.email);
  const adminTok = (adminStep1.body?.mfa === 'verify'
    ? (await call('POST', '/auth/mfa/verify', { body: { mfaToken: adminStep1.body.mfaToken, code: fresh(adm) } })).body?.token
    : adminStep1.body?.token) as string;
  const aliceTok = (await login(alice.email)).body?.token as string;
  const bobTok = (await login(bob.email)).body?.token as string;

  const events = async () => ((await call('GET', '/platform/account-events?limit=200', { token: adminTok })).body?.events ?? []) as Array<Record<string, any>>;
  const notices = (token: string) => call('GET', '/me/notices', { token });
  const post = (body: Record<string, unknown>, token: string = adminTok) => call('POST', '/platform/announcements', { token, body });
  const postWithCode = (body: Record<string, unknown>) => post({ ...body, code: fresh(adm) });
  const withdraw = (id: string, withCode = true) => call('POST', `/platform/announcements/${encodeURIComponent(id)}/withdraw`, { token: adminTok, body: withCode ? { code: fresh(adm) } : {} });
  const markRead = (token: string, body: unknown) => call('POST', '/me/notices/read', { token, body });

  const TITLE = 'Planned outage ZQ-TITLE-7';
  const BODY = 'The server restarts tonight ZQ-BODY-7';

  console.log.call(console, "--- A1 to A12: notices, announcements and read state ---");
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    // A1 a member's first look
    const a1 = await notices(aliceTok);
    assert(
      a1.status === 200 && /no-store/.test(a1.headers.get('cache-control') ?? '') && a1.body?.currentVersion === pkgVersion && typeof a1.body?.notesAvailable === 'boolean' &&
        JSON.stringify(a1.body?.announcements) === '[]' && JSON.stringify(a1.body?.releaseReads) === '[]',
      'A1: GET /me/notices -> 200, no-store, the package.json version, no announcements, nothing read',
      [a1.status, a1.body]
    );
    assert(a1.body?.notesAvailable === true, 'A1: the notes of the running version ship in the image (notesAvailable)');
    assert((await call('GET', '/me/notices')).status === 401, 'A1: no session -> 401');

    // A2 mark the release notes read
    const a2 = await markRead(aliceTok, { kind: 'release', ref: pkgVersion });
    const a2again = await markRead(aliceTok, { kind: 'release', ref: pkgVersion });
    const a2get = await notices(aliceTok);
    assert(a2.status === 204 && a2again.status === 204 && JSON.stringify(a2get.body?.releaseReads) === JSON.stringify([pkgVersion]), 'A2: marking the current notes read -> 204 (again too), and releaseReads lists the version once', [a2.status, a2again.status, a2get.body?.releaseReads]);
    assert(JSON.stringify((await notices(bobTok)).body?.releaseReads) === '[]', 'A2: another user has not read it');

    // A3 bad reads
    const a3a = await markRead(aliceTok, { kind: 'release', ref: '9.9.9' });
    const a3b = await markRead(aliceTok, { kind: 'x', ref: pkgVersion });
    const a3c = await markRead(aliceTok, { kind: 'release', ref: 'a b' });
    const a3d = await markRead(aliceTok, { kind: 'announcement', ref: 'no-such-announcement' });
    const a3e = await markRead(aliceTok, {});
    assert(a3a.status === 404 && a3a.body?.code === 'not_found' && a3d.status === 404, 'A3: a version without notes and an unknown announcement -> 404 not_found', [a3a.status, a3d.status]);
    assert([a3b, a3c, a3e].every((r) => r.status === 400 && r.body?.code === 'invalid_request'), 'A3: a bad kind, a bad ref and an empty body -> 400 invalid_request', [a3b.status, a3c.status, a3e.status]);

    // A4 only a platform administrator
    const valid = { title: TITLE, body: BODY, code: '000000' };
    const a4 = await post(valid, aliceTok);
    const a4get = await call('GET', '/platform/announcements', { token: aliceTok });
    const a4withdraw = await call('POST', '/platform/announcements/x/withdraw', { token: aliceTok, body: { code: '000000' } });
    assert(a4.status === 403 && a4get.status === 403 && a4withdraw.status === 403, 'A4: a non-administrator gets 403 on post, list and withdraw', [a4.status, a4get.status, a4withdraw.status]);
    assert((await call('POST', '/platform/announcements', { body: valid })).status === 401, 'A4: no session -> 401');

    // A5 the step-up code
    const a5none = await post({ title: TITLE, body: BODY });
    const a5wrong = await post(valid);
    assert(a5none.status === 400 && a5none.body?.reason === 'code_required' && a5wrong.status === 403 && a5wrong.body?.reason === 'invalid_code', 'A5: no code -> 400 code_required; a wrong code -> 403 invalid_code', [a5none.status, a5wrong.status]);
    assert((await notices(aliceTok)).body?.announcements.length === 0, 'A5: neither posted anything');

    // A6 validation comes before the code
    const bads: Array<[string, Record<string, unknown>, string]> = [
      ['an empty title', { title: '', body: BODY }, 'title'],
      ['a title with a line break', { title: 'a\nb', body: BODY }, 'title'],
      ['a 121-character title', { title: 'a'.repeat(121), body: BODY }, 'title'],
      ['an empty body', { title: TITLE, body: '  ' }, 'body'],
      ['a 2001-character body', { title: TITLE, body: 'b'.repeat(2001) }, 'body'],
      ['a body with a control character', { title: TITLE, body: 'a\u0001b' }, 'body'],
      ['an unknown severity', { title: TITLE, body: BODY, severity: 'critical' }, 'severity'],
      ['an expiry in the past', { title: TITLE, body: BODY, expiresAt: new Date(Date.now() - 3600000).toISOString() }, 'expiresAt'],
      ['an expiry over 365 days away', { title: TITLE, body: BODY, expiresAt: new Date(Date.now() + 366 * 86400000).toISOString() }, 'expiresAt'],
      ['an expiry that is not a date', { title: TITLE, body: BODY, expiresAt: 'tomorrow-ish' }, 'expiresAt'],
    ];
    for (const [name, body, field] of bads) {
      const r = await postWithCode(body);
      assert(r.status === 400 && r.body?.reason === 'invalid_request' && r.body?.field === field, `A6: ${name} -> 400 invalid_request, field ${field}`, [r.status, r.body]);
    }
    const a6nocode = await post({ title: '', body: BODY });
    assert(a6nocode.status === 400 && a6nocode.body?.reason === 'invalid_request', 'A6: an invalid body is refused before the code is asked for', [a6nocode.status, a6nocode.body]);
    assert((await notices(aliceTok)).body?.announcements.length === 0 && (await call('GET', '/platform/announcements', { token: adminTok })).body?.announcements.length === 0, 'A6: none of them posted anything');

    // A7 a valid post
    const a7 = await postWithCode({ title: `  ${TITLE}  `, body: BODY, severity: 'warning' });
    const first = a7.body?.announcement;
    const a7view = (await notices(aliceTok)).body?.announcements ?? [];
    assert(
      a7.status === 201 && typeof first?.id === 'string' && first.title === TITLE && first.body === BODY && first.severity === 'warning' && first.expiresAt === null && first.createdByUserId === adm.id && first.withdrawnAt === null,
      'A7: an administrator post with a code -> 201 { announcement } (title trimmed, severity warning, no expiry)',
      a7.body
    );
    assert(
      a7view.length === 1 && JSON.stringify(Object.keys(a7view[0]).sort()) === JSON.stringify(['body', 'createdAt', 'expiresAt', 'id', 'read', 'severity', 'title']) && a7view[0].id === first?.id && a7view[0].read === false,
      'A7: a member now sees it with exactly { id, title, body, severity, createdAt, expiresAt, read }, read false',
      a7view
    );
    const a7default = await postWithCode({ title: 'Second one', body: 'text' });
    assert(a7default.status === 201 && a7default.body?.announcement?.severity === 'info', 'A7: the severity defaults to info');
    const a7list = await call('GET', '/platform/announcements', { token: adminTok });
    assert(
      a7list.status === 200 && a7list.body?.announcements.length === 2 && a7list.body?.limits?.maxActive === 5 && a7list.body?.limits?.titleMax === 120 && a7list.body?.limits?.bodyMax === 2000 && a7list.body?.announcements[0].title === 'Second one',
      'A7: the administrator list shows both, newest first, with the limits',
      [a7list.status, a7list.body?.limits]
    );

    // A8 read state is per user
    const a8 = await markRead(aliceTok, { kind: 'announcement', ref: first?.id });
    const a8alice = (await notices(aliceTok)).body?.announcements ?? [];
    const a8bob = (await notices(bobTok)).body?.announcements ?? [];
    assert(
      a8.status === 204 && a8alice.find((a: any) => a.id === first?.id)?.read === true && a8alice.find((a: any) => a.title === 'Second one')?.read === false && a8bob.every((a: any) => a.read === false),
      'A8: marking an announcement read -> 204; it is read for her only',
      [a8.status, a8alice.map((a: any) => a.read), a8bob.map((a: any) => a.read)]
    );

    // A9 at most 5 active
    const a9ok = [];
    for (let i = 3; i <= 5; i++) a9ok.push((await postWithCode({ title: `Notice ${i}`, body: 'text' })).status);
    const a9 = await postWithCode({ title: 'Sixth', body: 'text' });
    assert(a9ok.every((s) => s === 201) && a9.status === 409 && a9.body?.reason === 'too_many_active', 'A9: five active are accepted, the sixth -> 409 too_many_active', [a9ok, a9.status, a9.body]);
    assert((await notices(aliceTok)).body?.announcements.length === 5 && (await call('GET', '/platform/announcements', { token: adminTok })).body?.announcements.length === 5, 'A9: the refused one was not stored');

    // A10 withdraw
    const a10 = await withdraw(first?.id);
    const a10view = (await notices(aliceTok)).body?.announcements ?? [];
    const a10again = await withdraw(first?.id);
    const a10unknown = await withdraw('no-such-id');
    const a10nocode = await withdraw(first?.id, false);
    const a10list = (await call('GET', '/platform/announcements', { token: adminTok })).body?.announcements ?? [];
    const withdrawnRow = a10list.find((a: any) => a.id === first?.id);
    assert(
      a10.status === 200 && a10.body?.announcement?.id === first?.id && typeof a10.body?.announcement?.withdrawnAt === 'string' && a10view.length === 4 && !a10view.some((a: any) => a.id === first?.id),
      'A10: withdrawing -> 200 and it is no longer shown to members',
      [a10.status, a10view.length]
    );
    assert(a10again.status === 409 && a10again.body?.reason === 'already_withdrawn' && a10unknown.status === 404 && a10unknown.body?.reason === 'not_found', 'A10: withdrawing again -> 409 already_withdrawn; an unknown id -> 404 not_found', [a10again.status, a10unknown.status]);
    assert(a10nocode.status === 400 && a10nocode.body?.reason === 'code_required', 'A10: withdrawing without a code -> 400 code_required', [a10nocode.status]);
    assert(withdrawnRow?.withdrawnByUserId === adm.id && a10list.length === 5, 'A10: the administrator list keeps the withdrawn one, with who withdrew it');
    const a10read = await markRead(bobTok, { kind: 'announcement', ref: first?.id });
    assert(a10read.status === 404, 'A10: a withdrawn announcement cannot be marked read (404)', [a10read.status]);

    // A11 expiry
    const expires = new Date(Date.now() + 3600000).toISOString();
    const a11 = await postWithCode({ title: 'Short lived', body: 'text', expiresAt: expires });
    const a11before = (await notices(aliceTok)).body?.announcements ?? [];
    __setAnnouncementClockForTests(() => Date.now() + 2 * 3600000);
    const a11after = (await notices(aliceTok)).body?.announcements ?? [];
    const a11read = await markRead(aliceTok, { kind: 'announcement', ref: a11.body?.announcement?.id });
    const a11list = (await call('GET', '/platform/announcements', { token: adminTok })).body?.announcements ?? [];
    __setAnnouncementClockForTests(null);
    assert(
      a11.status === 201 && a11.body?.announcement?.expiresAt === expires && a11before.some((a: any) => a.title === 'Short lived') && !a11after.some((a: any) => a.title === 'Short lived') && a11after.length === 4,
      'A11: an announcement with expiresAt is listed, and after the expiry (clock hook, +2 hours) it is not',
      [a11.status, a11before.length, a11after.length]
    );
    assert(a11read.status === 404 && a11list.some((a: any) => a.title === 'Short lived'), 'A11: an expired one cannot be marked read, but the administrator list still shows it', [a11read.status]);
  } finally {
    console.log = out.log;
    console.warn = out.warn;
    console.error = out.error;
  }

  // A12 events and logs
  const all = await events();
  const posted = all.filter((e) => e.action === 'announcement_posted');
  const withdrawn = all.filter((e) => e.action === 'announcement_withdrawn');
  assert(posted.length === 6 && withdrawn.length === 1, 'A12: six announcement_posted and one announcement_withdrawn event', [posted.length, withdrawn.length]);
  assert(
    [...posted, ...withdrawn].every((e) => e.actorKind === 'admin' && e.actorUserId === adm.id && e.targetUserId === adm.id && JSON.stringify(Object.keys(e.details)) === '["announcementId"]' && typeof e.details.announcementId === 'string'),
    'A12: each event is by the administrator and its details hold announcementId only',
    posted[0]
  );
  assert(withdrawn[0]?.details?.announcementId === (await call('GET', '/platform/announcements', { token: adminTok })).body?.announcements.find((a: any) => a.withdrawnAt)?.id, 'A12: the withdrawn event names the withdrawn announcement');
  const allText = JSON.stringify(all);
  assert(!allText.includes('ZQ-TITLE-7') && !allText.includes('ZQ-BODY-7') && !allText.includes('Short lived'), 'A12: no account event holds a title or a body');
  assert(captured.length > 0 && captured.every((l) => !l.includes('ZQ-TITLE-7') && !l.includes('ZQ-BODY-7') && !l.includes('Short lived') && !l.includes('Second one')), 'A12: no log line written during A1 to A11 holds a title or a body', captured.filter((l) => l.includes('ZQ-')));
  assert(captured.some((l) => l.startsWith('[Announcements] posted ')) && captured.some((l) => l.startsWith('[Announcements] withdrawn ')), 'A12: posting and withdrawing are logged by id');

  console.log('\n--- A13: source checks ---');
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const store = read('../server/announcements.ts');
  const reads = read('../server/noticeReads.ts');
  const admin = read('../server/routes/platformAnnouncements.ts');
  const mine = read('../server/routes/notices.ts');
  const logs = [store, reads, admin, mine].flatMap((s) => s.split('\n')).filter((l) => l.includes('console.'));
  assert(logs.every((l) => !/\.(title|body)\b|input\./.test(l)), 'A13: no console line in the announcement code mentions a title or a body', logs);
  assert(admin.includes("requireAdminStepUp(req, res, 'announcement')") && admin.indexOf('validateAnnouncementInput(') < admin.indexOf('requireAdminStepUp('), 'A13: the post checks the body, then the step-up code');
  const api = read('../server/routes/api.ts');
  assert(/router\.use\('\/me\/notices', authOnlyMiddleware, noticesRouter\)/.test(api) && /router\.use\('\/platform\/announcements', authOnlyMiddleware, platformAnnouncementsRouter\)/.test(api), 'A13: both routers are mounted behind the authenticated-only middleware');

  setClock(null);
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
