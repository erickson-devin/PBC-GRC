import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { server } from '../server/index';
import { base32Decode, generateTotp } from '../server/auth/totp';
import { __resetMemoryLocalUsersForTests, createLocalUser } from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests, createTenantWithOwner } from '../server/db';
import { __resetMemoryInvitationsForTests, createInvitation, previewInvitation } from '../server/invitations';
import { __resetPlatformSetupForTests, addPlatformAdmin } from '../server/platformSetup';
import { __resetLoginThrottleForTests, __resetMfaStateForTests, __setMfaClockForTests } from '../server/routes/auth';
import { __resetSessionsForTests } from '../server/auth/sessionStore';
import { __resetMfaRequirementCacheForTests } from '../server/auth/mfaEnforcement';
import { __resetAccountEventsForTests } from '../server/auth/accountEvents';
import { __resetSystemUseNoticeForTests } from '../server/auth/systemUseNotice';
import { DEFAULT_SYSTEM_USE_NOTICE, SYSTEM_USE_NOTICE_MAX } from '../src/data/systemUseNotice';
import { sessionCookieFrom } from './sessionCookieJar';

/**
 * System use notification (issue #256), end to end through the real server: the public notice, the platform administrator's
 * editor (step-up code), the acknowledgement that /auth/login and /auth/register-with-invite require while the notice is on,
 * and the events that record it. The notice is off until saved, so every other suite signs in without it.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const PW = 'correct horse battery staple';
const T = Math.floor(Date.now() / 30000) * 30000 + 1000;
const STEP = 30000;
const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
const NOTICE_TEXT = 'Custom notice N4';

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
    /* no body */
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
const login = (email: string, password = PW, systemUseAck?: unknown) =>
  call('POST', '/auth/login', { body: systemUseAck === undefined ? { email, password } : { email, password, systemUseAck } });
async function mk(name: string): Promise<Acct> {
  const email = `${name}@notice.mil`;
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
  __resetSystemUseNoticeForTests();
  process.env.MFA_REQUIRED = 'off';
  setClock(T);

  const captured: string[] = [];
  const grab = (...args: unknown[]) => void captured.push(util.format(...args));

  // Fixtures (signed in while the notice is still off): a platform administrator with a second factor, a plain user, an enrolled user
  const adm = await mk('admin256');
  await addPlatformAdmin({ userId: adm.id, email: adm.email });
  await enrol(adm);
  const user = await mk('user256');
  const mfaUser = await mk('mfa256');
  await enrol(mfaUser);
  const owner = await mk('owner256');
  await createTenantWithOwner(
    { id: 'tenant-su-256', name: 'Org 256', systemName: 'Enclave 256', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: owner.id, email: owner.email, name: owner.email }
  );
  const adminStep1 = await login(adm.email);
  const adminTok = (adminStep1.body?.mfa === 'verify'
    ? (await call('POST', '/auth/mfa/verify', { body: { mfaToken: adminStep1.body.mfaToken, code: fresh(adm) } })).body?.token
    : adminStep1.body?.token) as string;
  const ownerTok = (await login(owner.email)).body?.token as string;
  const events = async () => ((await call('GET', '/platform/account-events?limit=200', { token: adminTok })).body?.events ?? []) as Array<Record<string, any>>;
  const ackEvents = async () => (await events()).filter((e) => e.action === 'system_use_acknowledged');
  const noticeEvents = async () => (await events()).filter((e) => e.action === 'system_use_notice_updated');
  const put = (body: Record<string, unknown>, token: string | null = adminTok) => call('PUT', '/platform/system-use-notice', { token: token ?? undefined, body });
  const putWithCode = (body: Record<string, unknown>) => put({ ...body, code: fresh(adm) });

  console.log.call(console, '--- N1 to N13: the notice, the editor and the acknowledgement ---');
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    // N1 the public default
    const n1 = await call('GET', '/auth/system-use-notice');
    assert(
      n1.status === 200 && /no-store/.test(n1.headers.get('cache-control') ?? '') && JSON.stringify(Object.keys(n1.body ?? {}).sort()) === JSON.stringify(['enabled', 'text', 'version']) &&
        n1.body?.enabled === false && n1.body?.version === 0 && n1.body?.text === DEFAULT_SYSTEM_USE_NOTICE && String(n1.body?.text).includes('Controlled Unclassified Information'),
      'N1: the anonymous GET -> 200, no-store, exactly { enabled, text, version }, off, version 0, the shared default text',
      [n1.status, n1.body && Object.keys(n1.body)]
    );

    // N2 off: no ack needed, none recorded
    const before2 = (await ackEvents()).length;
    const n2 = await login(user.email);
    assert(n2.status === 200 && (await ackEvents()).length === before2, 'N2: while the notice is off, a sign-in without an acknowledgement works and records no acknowledgement', [n2.status]);

    // N3 the editor refuses what it should, and changes nothing
    const refused = [
      (await put({ enabled: true, text: 'x', code: '000000' }, ownerTok)).status,
      (await put({ enabled: true, text: 'x', code: '000000' }, null)).status,
    ];
    const noCode = await put({ enabled: true, text: 'x' });
    const empty = await putWithCode({ enabled: true, text: '' });
    const blank = await putWithCode({ enabled: true, text: '   \r\n ' });
    const tooLong = await putWithCode({ enabled: true, text: 'a'.repeat(SYSTEM_USE_NOTICE_MAX + 1) });
    const control = await putWithCode({ enabled: true, text: 'a\u0001b' });
    const badEnabled = await putWithCode({ enabled: 'yes', text: 'x' });
    const wrongCode = await put({ enabled: true, text: 'x', code: '000000' });
    const getAfter = await call('GET', '/platform/system-use-notice', { token: adminTok });
    assert(refused[0] === 403 && refused[1] === 401, 'N3: a non-administrator gets 403 and no session gets 401', refused);
    assert(noCode.status === 400 && noCode.body?.reason === 'code_required', 'N3: no code -> 400 code_required', [noCode.status, noCode.body]);
    assert(wrongCode.status === 403 && wrongCode.body?.reason === 'invalid_code', 'N3: a wrong code -> 403 invalid_code', [wrongCode.status, wrongCode.body]);
    assert(
      [empty, blank, tooLong, control, badEnabled].every((r) => r.status === 400 && r.body?.reason === 'invalid_request'),
      'N3: empty, blank, 4001-character, control-character text and a non-boolean enabled -> 400 invalid_request',
      [empty.status, blank.status, tooLong.status, control.status, badEnabled.status]
    );
    assert(getAfter.status === 200 && getAfter.body?.version === 0 && getAfter.body?.enabled === false && (await noticeEvents()).length === 0, 'N3: none of them changed the notice or wrote an event', getAfter.body && { v: getAfter.body.version });
    const adminGet = getAfter.body ?? {};
    assert(
      JSON.stringify(Object.keys(adminGet).sort()) === JSON.stringify(['defaultText', 'enabled', 'maxLength', 'text', 'updatedAt', 'updatedByUserId', 'version']) && adminGet.maxLength === 4000 && adminGet.defaultText === DEFAULT_SYSTEM_USE_NOTICE && adminGet.updatedAt === null,
      'N3: the administrator GET returns the editing shape (defaultText, maxLength 4000, updatedAt null before the first save)',
      Object.keys(adminGet)
    );
    assert((await call('GET', '/platform/system-use-notice', { token: ownerTok })).status === 403, 'N3: a non-administrator cannot read the editing view either');

    // N4 an administrator saves
    const n4 = await putWithCode({ enabled: true, text: NOTICE_TEXT });
    const e4 = (await noticeEvents())[0];
    assert(
      n4.status === 200 && n4.body?.enabled === true && n4.body?.version === 1 && n4.body?.text === NOTICE_TEXT && n4.body?.defaultText === DEFAULT_SYSTEM_USE_NOTICE && n4.body?.updatedByUserId === adm.id,
      'N4: the administrator PUT -> 200 with the notice, version 1 and the default text',
      [n4.status, n4.body && { v: n4.body.version, e: n4.body.enabled }]
    );
    assert(
      e4?.action === 'system_use_notice_updated' && e4.actorKind === 'admin' && e4.actorUserId === adm.id && e4.targetUserId === adm.id && JSON.stringify(e4.details) === JSON.stringify({ noticeVersion: '1', noticeEnabled: true }),
      'N4: the newest event is system_use_notice_updated, actor = target = the administrator, details { noticeVersion, noticeEnabled } only',
      e4
    );

    // N5 the public view follows
    const n5 = await call('GET', '/auth/system-use-notice');
    assert(n5.status === 200 && JSON.stringify(n5.body) === JSON.stringify({ enabled: true, text: NOTICE_TEXT, version: 1 }), 'N5: the anonymous GET now returns the saved notice, enabled, version 1', n5.body && { v: n5.body.version });

    // N6 no acknowledgement
    const n6 = await login(user.email);
    const n6unknown = await login('nobody@notice.mil');
    const n6string = await login(user.email, PW, '1');
    assert(
      n6.status === 400 && n6.body?.reason === 'system_use_ack_required' && n6unknown.status === 400 && JSON.stringify(n6unknown.body) === JSON.stringify(n6.body) && n6string.status === 400 && n6string.body?.reason === 'system_use_ack_required',
      'N6: a sign-in without an acknowledgement (or with a non-number) -> 400 system_use_ack_required, the same body for an unknown email',
      [n6.status, n6unknown.status, n6string.status]
    );

    // N7 a stale acknowledgement
    const n7 = await login(user.email, PW, 0);
    assert(n7.status === 409 && n7.body?.reason === 'system_use_notice_changed', 'N7: an acknowledgement of another version -> 409 system_use_notice_changed', [n7.status, n7.body]);

    // N8 the right one
    const n8 = await login(user.email, PW, 1);
    const e8 = (await ackEvents())[0];
    assert(
      n8.status === 200 && e8?.actorKind === 'user' && e8.actorUserId === user.id && e8.targetUserId === user.id && e8.tenantId === null && JSON.stringify(e8.details) === JSON.stringify({ via: 'sign_in', noticeVersion: '1' }),
      'N8: the right acknowledgement + the right password -> 200 and a system_use_acknowledged event (actor = target = the user, no tenant, { via: sign_in, noticeVersion: 1 })',
      [n8.status, e8]
    );

    // N9 a wrong password records nothing
    const before9 = (await ackEvents()).length;
    const n9 = await login(user.email, 'not the password at all', 1);
    assert(n9.status === 401 && (await ackEvents()).length === before9, 'N9: acknowledgement 1 with a wrong password -> 401 and no new acknowledgement event', [n9.status]);

    // N10 an enrolled account: the event is written before the second step
    const before10 = (await ackEvents()).length;
    const n10 = await login(mfaUser.email, PW, 1);
    const e10 = (await ackEvents())[0];
    assert(n10.status === 200 && n10.body?.mfa === 'verify' && (await ackEvents()).length === before10 + 1 && e10?.actorUserId === mfaUser.id, 'N10: an account with a second factor gets the pending step, and the acknowledgement is already recorded', [n10.status, n10.body?.mfa]);

    // N11 registration with an invitation
    const newbie = 'newbie256@notice.mil';
    const inv = await createInvitation('tenant-su-256', { email: newbie, role: 'ASSESSOR', createdBy: owner.email, createdByUserId: owner.id, expiresInDays: 14 });
    const noAck = await call('POST', '/auth/register-with-invite', { body: { token: inv.token, password: PW, name: 'Newbie' } });
    const stale = await call('POST', '/auth/register-with-invite', { body: { token: inv.token, password: PW, name: 'Newbie', systemUseAck: 5 } });
    const stillPending = (await previewInvitation(inv.token))?.status === 'PENDING';
    const reg = await call('POST', '/auth/register-with-invite', { body: { token: inv.token, password: PW, name: 'Newbie', systemUseAck: 1 } });
    const e11 = (await ackEvents())[0];
    assert(
      noAck.status === 400 && noAck.body?.reason === 'system_use_ack_required' && stale.status === 409 && stale.body?.reason === 'system_use_notice_changed' && stillPending,
      'N11: registering without (or with a stale) acknowledgement -> 400 / 409 and the invitation is still PENDING',
      [noAck.status, stale.status, stillPending]
    );
    assert(
      reg.status === 201 && e11?.action === 'system_use_acknowledged' && e11.details?.via === 'invitation_registration' && e11.details?.noticeVersion === '1' && e11.actorUserId === e11.targetUserId,
      'N11: with the acknowledgement -> 201 and an acknowledgement event {via: invitation_registration}',
      [reg.status, e11]
    );

    // N13 turning it off again
    const n13 = await putWithCode({ enabled: false, text: NOTICE_TEXT });
    const n13login = await login(user.email);
    const n13public = await call('GET', '/auth/system-use-notice');
    assert(n13.status === 200 && n13.body?.version === 2 && n13.body?.enabled === false && n13login.status === 200 && n13public.body?.enabled === false && n13public.body?.version === 2, 'N13: saving enabled false -> version 2, and a sign-in without an acknowledgement works again', [n13.status, n13.body?.version, n13login.status]);
  } finally {
    console.log = out.log;
    console.warn = out.warn;
    console.error = out.error;
  }

  // N12 nothing leaked
  const allEvents = JSON.stringify(await events());
  assert(captured.length > 0 && captured.every((l) => !l.includes(NOTICE_TEXT)), 'N12: no log line written during N1 to N13 holds the notice text', captured.filter((l) => l.includes(NOTICE_TEXT)));
  assert(!allEvents.includes(NOTICE_TEXT) && !allEvents.includes('@'), 'N12: no account event holds the notice text or an address');
  assert(captured.some((l) => l.startsWith('[SystemUse] notice saved: version 1, enabled true by account ')), 'N12: the save is logged with its version only');

  console.log('\n--- N14: source checks ---');
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const store = read('../server/auth/systemUseNotice.ts');
  const route = read('../server/routes/platformSystemUseNotice.ts');
  const logs = [...store.split('\n'), ...route.split('\n')].filter((l) => l.includes('console.'));
  assert(logs.every((l) => !l.includes('.text') && !l.includes('notice_text') && !l.includes('NOTICE_TEXT')), 'N14: no console line in the notice store or route mentions the text', logs);
  assert(route.includes("requireAdminStepUp(req, res, 'system-use-notice')") && route.indexOf('validateSystemUseNoticeInput(') < route.indexOf('requireAdminStepUp('), 'N14: the PUT checks the body, then the step-up code');

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
