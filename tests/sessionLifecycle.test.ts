import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { server } from '../server/index';
import {
  LocalAuthConfigError,
  assertAuthConfig,
  authStartupWarnings,
  getSessionIdleMinutes,
  signLocalToken,
} from '../server/auth/localAuth';
import {
  __resetSessionsForTests,
  __sessionStateForTests,
  __sessionWriteCountForTests,
  __setSessionClockForTests,
  pruneExpiredSessions,
  recordSession,
} from '../server/auth/sessionStore';
import { __resetMemoryLocalUsersForTests, createLocalUser, deleteLocalUser } from '../server/auth/localUsers';
import { __resetLoginThrottleForTests } from '../server/routes/auth';
import { rawSetCookie, sessionCookieFrom } from './sessionCookieJar';

/**
 * Server-side sessions (issue #163): the idle timeout (SESSION_IDLE_MINUTES), sign-out that revokes the session on the server,
 * adoption of tokens that have no row yet, the throttled last-seen write, expiry pruning, and that no log line names an account,
 * a session id or a cookie. The session store reads a controllable clock, so nothing here sleeps.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const SECRET = process.env.LOCAL_AUTH_SECRET!;
const PW = 'correct horse battery staple';
const MIN = 60_000;

let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
};

async function call(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  __resetLoginThrottleForTests();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = `pbc_session=${opts.cookie}`;
  Object.assign(headers, opts.headers);
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  const cookie = sessionCookieFrom(res.headers);
  if (body && cookie && body.token === undefined) body.token = cookie;
  return { status: res.status, headers: res.headers, body };
}

interface Session {
  cookie: string;
  sid: string;
}
const login = async (email: string): Promise<Session> => {
  const r = await call('POST', '/auth/login', { body: { email, password: PW } });
  return { cookie: r.body?.token as string, sid: r.body?.sessionRef as string };
};
/** GET /auth/me through the cookie path, with the marker the SPA sends. */
const meCookie = (s: Session) => call('GET', '/auth/me', { cookie: s.cookie, headers: { 'X-PBC-Session': s.sid } });
const meBearer = (s: Session) => call('GET', '/auth/me', { token: s.cookie });

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  delete process.env.SESSION_IDLE_MINUTES;
  __resetMemoryLocalUsersForTests();
  __resetSessionsForTests();
  const ann = await createLocalUser({ email: 'ann.lifecycle@enclave.mil', name: 'Ann Lifecycle', password: PW });
  let clock = Date.now();
  const setClock = (ms: number) => {
    clock = ms;
  };
  __setSessionClockForTests(() => clock);

  console.log('--- Configuration (SESSION_IDLE_MINUTES) ---');
  const FIXED = 'SESSION_IDLE_MINUTES must be a whole number of minutes from 0 to 1440 (0 disables the idle timeout; empty means the default, 15).';
  assert(
    getSessionIdleMinutes({} as NodeJS.ProcessEnv) === 15 &&
      getSessionIdleMinutes({ SESSION_IDLE_MINUTES: '0' } as NodeJS.ProcessEnv) === 0 &&
      getSessionIdleMinutes({ SESSION_IDLE_MINUTES: ' 30 ' } as NodeJS.ProcessEnv) === 30 &&
      getSessionIdleMinutes({ SESSION_IDLE_MINUTES: '1440' } as NodeJS.ProcessEnv) === 1440,
    'S163-1: unset -> 15, "0" -> 0, " 30 " -> 30, "1440" -> 1440'
  );
  const badValues = ['1441', '-1', '1.5', 'abc'];
  const badErrors = badValues.map((v) => throws(() => getSessionIdleMinutes({ SESSION_IDLE_MINUTES: v } as NodeJS.ProcessEnv)));
  assert(badErrors.every((e) => e instanceof LocalAuthConfigError && e.message === FIXED), 'S163-1: "1441", "-1", "1.5" and "abc" each throw LocalAuthConfigError with the fixed message', badErrors.map((e) => e?.message));
  assert(throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, SESSION_IDLE_MINUTES: 'x' } as NodeJS.ProcessEnv)) instanceof LocalAuthConfigError, 'S163-2: assertAuthConfig refuses an unusable SESSION_IDLE_MINUTES');
  const warnProd = authStartupWarnings({ SESSION_IDLE_MINUTES: '0', NODE_ENV: 'production', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv);
  const warnTest = authStartupWarnings({ SESSION_IDLE_MINUTES: '0', NODE_ENV: 'test', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv);
  assert(warnProd.some((w) => w.includes('3.1.11')) && !warnTest.some((w) => w.includes('3.1.11')), 'S163-3: SESSION_IDLE_MINUTES=0 warns about 3.1.11 in production, not in test', [warnProd, warnTest]);

  console.log('\n--- Idle timeout ---');
  const t0 = clock;
  const s4 = await login(ann.email);
  const st4 = __sessionStateForTests(s4.sid);
  assert(st4 !== null && st4.userId === ann.id && st4.revokedReason === null && st4.lastSeenMs === t0, 'S163-4: after login the session row has the user, no revocation and last seen = the login time', st4);

  setClock(t0 + 14 * MIN);
  assert((await meCookie(s4)).status === 200, 'S163-5: a request 14 minutes after the last one -> 200');

  const s6 = await login(ann.email);
  const base6 = __sessionWriteCountForTests();
  setClock(clock + 14 * MIN);
  await meCookie(s6);
  setClock(clock + 30_000);
  await meCookie(s6);
  assert(__sessionWriteCountForTests() - base6 === 1, 'S163-6: two requests 30 seconds apart cause exactly one last-seen write', __sessionWriteCountForTests() - base6);

  // 7, 8, 19 (captured)
  const captured: string[] = [];
  const origConsole = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...args: unknown[]) => void captured.push(util.format(...args));
  const s7 = await login(ann.email);
  setClock(clock + 5 * MIN);
  await meCookie(s7); // the last request
  setClock(clock + 15 * MIN + 1000);
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  let r7;
  let r8;
  try {
    r7 = await meCookie(s7);
    r8 = await meCookie(s7);
  } finally {
    console.log = origConsole.log;
    console.warn = origConsole.warn;
    console.error = origConsole.error;
  }
  const line7 = rawSetCookie(r7.headers) ?? '';
  assert(
    r7.status === 401 && r7.body?.reason === 'session_idle' && r7.body?.error === 'Unauthorized: the session ended after a period of inactivity' && /^pbc_session=;/.test(line7) && /Expires=Thu, 01 Jan 1970/.test(line7),
    'S163-7: 15 minutes and a second after the last request -> 401 session_idle with the fixed text, and the cookie is cleared',
    [r7.status, r7.body, line7]
  );
  assert(r8.status === 401 && r8.body?.reason === 'session_idle', 'S163-8: the same cookie again -> 401 session_idle', [r8.status, r8.body]);
  const s8b = await login(ann.email);
  assert((await meCookie(s8b)).status === 200, 'S163-8: a new sign-in works');

  const s9 = await login(ann.email);
  setClock(clock + 15 * MIN);
  assert((await meCookie(s9)).status === 200, 'S163-9: a request exactly at last seen + 15:00.000 -> 200 (strictly greater ends it)');

  process.env.SESSION_IDLE_MINUTES = '0';
  const s10 = await login(ann.email);
  setClock(clock + 7 * 3_600_000);
  assert((await meCookie(s10)).status === 200, 'S163-10: SESSION_IDLE_MINUTES=0: a request 7 hours later -> 200');
  const cfg0 = await call('GET', '/auth/config');
  assert(cfg0.body?.sessionIdleSeconds === 0, 'S163-18: GET /auth/config with SESSION_IDLE_MINUTES=0 -> sessionIdleSeconds 0', cfg0.body);
  delete process.env.SESSION_IDLE_MINUTES;
  const cfg15 = await call('GET', '/auth/config');
  assert(cfg15.status === 200 && cfg15.body?.mode === 'local' && cfg15.body?.sessionIdleSeconds === 900, 'S163-18: GET /auth/config by default -> mode local and sessionIdleSeconds 900', cfg15.body);

  const s11 = await login(ann.email);
  setClock(clock + 16 * MIN);
  const r11 = await meBearer(s11);
  assert(r11.status === 401 && r11.body?.reason === 'session_idle' && rawSetCookie(r11.headers) === undefined, 'S163-11: the Authorization path after the idle period -> 401 session_idle and no Set-Cookie', [r11.status, r11.body, rawSetCookie(r11.headers)]);

  console.log('\n--- Sign-out revokes the session ---');
  const s12 = await login(ann.email);
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  let out12;
  let after12;
  try {
    out12 = await call('POST', '/auth/logout', { cookie: s12.cookie, headers: { 'X-PBC-Session': s12.sid } });
    after12 = await meCookie(s12);
  } finally {
    console.log = origConsole.log;
    console.warn = origConsole.warn;
    console.error = origConsole.error;
  }
  assert(out12.status === 204 && after12.status === 401 && after12.body?.reason === 'session_revoked', 'S163-12: logout with the cookie and marker -> 204; the same cookie on /auth/me -> 401 session_revoked', [out12.status, after12.status, after12.body]);
  const s12b = await login(ann.email);
  const out12b = await call('POST', '/auth/logout', { token: s12b.cookie });
  const after12b = await meBearer(s12b);
  assert(out12b.status === 204 && after12b.status === 401 && after12b.body?.reason === 'session_revoked', 'S163-12: a Bearer logout revokes that token too', [out12b.status, after12b.status]);

  const expired = signLocalToken({ id: ann.id, email: ann.email, name: ann.name, tokenVersion: 0 }, { now: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 }).token;
  const out13a = await call('POST', '/auth/logout');
  const out13b = await call('POST', '/auth/logout', { cookie: 'garbage.cookie.value' });
  const out13c = await call('POST', '/auth/logout', { cookie: expired });
  assert([out13a.status, out13b.status, out13c.status].every((s) => s === 204), 'S163-13: logout without a cookie, with a garbage cookie and with an expired token -> 204 each', [out13a.status, out13b.status, out13c.status]);

  const s14a = await login(ann.email);
  const s14b = await login(ann.email);
  await call('POST', '/auth/logout', { cookie: s14a.cookie, headers: { 'X-PBC-Session': s14a.sid } });
  assert((await meCookie(s14a)).status === 401 && (await meCookie(s14b)).status === 200, 'S163-14: logging out one of two sessions of the same account leaves the other at 200');

  console.log('\n--- Adoption of tokens without a row ---');
  const legacy = signLocalToken({ id: ann.id, email: ann.email, name: ann.name, tokenVersion: 0 });
  assert(__sessionStateForTests(legacy.claims.sid as string) === null, 'S163-15: (setup) a token minted outside the login has no session row');
  const first15 = await call('GET', '/auth/me', { token: legacy.token });
  const adopted = __sessionStateForTests(legacy.claims.sid as string);
  assert(first15.status === 200 && adopted !== null && adopted.userId === ann.id, 'S163-15: its first request -> 200 and the row now exists (adopted)', [first15.status, adopted]);
  await call('POST', '/auth/logout', { token: legacy.token });
  const second15 = await call('GET', '/auth/me', { token: legacy.token });
  assert(second15.status === 401 && second15.body?.reason === 'session_revoked', 'S163-15: after logout the token -> 401 session_revoked (a revoked row is never re-adopted)', [second15.status, second15.body]);
  const legacy2 = signLocalToken({ id: ann.id, email: ann.email, name: ann.name, tokenVersion: 0 });
  await call('POST', '/auth/logout', { token: legacy2.token });
  assert((await call('GET', '/auth/me', { token: legacy2.token })).status === 401, 'S163-15: logging a never-seen token out revokes it before it can be adopted');

  console.log('\n--- Pruning and account deletion ---');
  const base = Math.floor(clock / 1000);
  const mkRow = (sid: string, exp: number) => recordSession({ sid, userId: ann.id, issuedAt: exp - 3600, expiresAt: exp, mfaVerified: false });
  await mkRow('prune_old_session_00000001', base - 2 * 86_400);
  await mkRow('prune_recent_session_0000001', base - 3600);
  await mkRow('prune_future_session_000001', base + 3600);
  const pruned = await pruneExpiredSessions(clock);
  assert(
    pruned === 1 && __sessionStateForTests('prune_old_session_00000001') === null && __sessionStateForTests('prune_recent_session_0000001') !== null && __sessionStateForTests('prune_future_session_000001') !== null,
    'S163-16: pruning at t0 removes only the row that expired two days ago',
    pruned
  );
  const doomed = await createLocalUser({ email: 'doomed.lifecycle@enclave.mil', name: 'Doomed', password: PW });
  const sDoomed = await login(doomed.email);
  await deleteLocalUser(doomed.id);
  assert(__sessionStateForTests(sDoomed.sid) === null, 'S163-17: deleting the account removes its sessions (memory mode)');

  console.log('\n--- No identifying value in the log ---');
  const secrets = [ann.email, ann.name, 'Ann Lifecycle', s7.sid, s7.cookie, s12.sid, s12.cookie];
  assert(captured.length > 0 && captured.every((l) => secrets.every((v) => !l.includes(v))), 'S163-19: the log lines of an idle refusal and a sign-out hold no email, name, session id or cookie value', captured);

  console.log('\n--- Middleware order ---');
  const mw = fs.readFileSync(new URL('../server/middleware/authMiddleware.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const iAuth = mw.indexOf('authenticateToken(token)');
  const iMismatch = mw.indexOf('res.status(401).json(SESSION_MISMATCH)');
  const iMfa = mw.indexOf("revokeSession(authenticated.sid, 'mfa_required')");
  const iMust = mw.indexOf('authenticated.mustChangePassword');
  assert(iAuth > 0 && iAuth < iMismatch && iMismatch < iMfa && iMfa < iMust, 'S163-20: authentication, then the marker match, then the mid-session MFA check, then the must-change-password gate', [iAuth, iMismatch, iMfa, iMust]);

  __setSessionClockForTests(null);
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
