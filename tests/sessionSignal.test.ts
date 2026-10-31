import fs from 'fs';
import path from 'path';
import { ApiClient, ApiError } from '../src/services/apiClient';
import {
  sessionRefFromHeaders,
  holdSessionSignal,
  isSessionRejection,
  onSessionRejected,
  releaseSessionSignal,
  reportResponseStatus,
  resetSessionSignal,
  sessionEndedMessage,
  isReauthReason,
  MFA_REQUIRED_MESSAGE,
  SESSION_IDLE_MESSAGE,
  SESSION_ENDED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  SESSION_MISMATCH_MESSAGE,
  SESSION_REVOKED_MESSAGE,
} from '../src/services/sessionSignal';

/**
 * "The server ended this session" signal: the rule that decides when a 401 means sign out, the listener plumbing, and the API
 * client against a stubbed fetch (login, second-factor and wrong-password failures must never signal).
 * Pure test: no server, no browser.
 */
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

console.log('--- isSessionRejection ---');
assert(isSessionRejection(401, 'tokA', 'tokA') === true, 'a 401 on the stored bearer is a session rejection');
assert(isSessionRejection(401, null, 'tokA') === false, 'a 401 on a request without a bearer is not');
assert(isSessionRejection(403, 'tokA', 'tokA') === false, 'a 403 is not');
assert([500, 503, 0, 200, 404].every((s) => isSessionRejection(s, 'tokA', 'tokA') === false), '5xx, network failures and other statuses are not');
assert(isSessionRejection(401, 'tokOld', 'tokNew') === false, 'a 401 on a bearer that is no longer the stored token is not (stale request)');
assert(isSessionRejection(401, 'tokA', null) === false, 'a 401 when nothing is stored is not');

console.log('\n--- sessionRefFromHeaders ---');
assert(sessionRefFromHeaders({ 'X-PBC-Session': 'abc' }) === 'abc', 'a record with X-PBC-Session');
assert(sessionRefFromHeaders({ 'x-pbc-session': 'abc' }) === 'abc', 'a record with lowercase x-pbc-session');
assert(sessionRefFromHeaders(new Headers({ 'X-PBC-Session': 'abc' })) === 'abc', 'a Headers instance');
assert(sessionRefFromHeaders([['Content-Type', 'x'], ['X-PBC-Session', 'abc']]) === 'abc', 'an array of pairs');
assert(sessionRefFromHeaders({ Authorization: 'Bearer abc' }) === null, 'an Authorization bearer is not a session reference');
assert(sessionRefFromHeaders({ 'X-PBC-Session': '  ' }) === null, 'a blank reference is null');
assert(sessionRefFromHeaders(undefined) === null && sessionRefFromHeaders({ 'Content-Type': 'x' }) === null, 'no headers or no marker is null');

console.log('\n--- reportResponseStatus and the listeners ---');
resetSessionSignal();
let heard: string[] = [];
let off = onSessionRejected((t) => heard.push(t));
reportResponseStatus(401, 'tokA', 'tokA');
reportResponseStatus(401, 'tokA', 'tokA');
reportResponseStatus(401, 'tokA', 'tokA');
assert(heard.length === 1 && heard[0] === 'tokA', 'three reports for the same token signal once');
reportResponseStatus(401, 'tokB', 'tokB');
assert(heard.length === 2 && heard[1] === 'tokB', 'a different token signals again');
reportResponseStatus(500, 'tokC', 'tokC');
reportResponseStatus(401, 'tokC', 'tokD');
assert(heard.length === 2, 'non-rejections never signal');

resetSessionSignal();
heard = [];
off = onSessionRejected((t) => heard.push(t));
holdSessionSignal('tokA');
reportResponseStatus(401, 'tokA', 'tokA');
assert(heard.length === 0, 'a held token does not signal');
releaseSessionSignal('tokA');
reportResponseStatus(401, 'tokA', 'tokA');
assert(heard.length === 1, 'after release the token signals');

resetSessionSignal();
heard = [];
off = onSessionRejected((t) => heard.push(t));
off();
reportResponseStatus(401, 'tokA', 'tokA');
assert(heard.length === 0, 'an unsubscribed listener hears nothing');

resetSessionSignal();
heard = [];
onSessionRejected(() => {
  throw new Error('boom');
});
onSessionRejected((t) => heard.push(t));
reportResponseStatus(401, 'tokA', 'tokA');
assert(heard.length === 1, 'a throwing listener does not stop the next one');
resetSessionSignal();

console.log('\n--- The reason travels with the signal ---');
resetSessionSignal();
const heardReasons: Array<[string, string | undefined]> = [];
onSessionRejected((t, reason) => heardReasons.push([t, reason]));
reportResponseStatus(401, 'tokA', 'tokA', 'session_expired');
assert(heardReasons.length === 1 && heardReasons[0][0] === 'tokA' && heardReasons[0][1] === 'session_expired', 'C33-1 the reason reaches the listener');
reportResponseStatus(401, 'tokB', 'tokB', null);
assert(heardReasons.length === 2 && heardReasons[1][1] === undefined, 'a null reason reaches the listener as undefined');
resetSessionSignal();

assert(sessionEndedMessage('session_expired') === SESSION_EXPIRED_MESSAGE && sessionEndedMessage('session_revoked') === SESSION_REVOKED_MESSAGE, 'C33-4 expired and revoked have their own texts');
assert(['session_missing', 'session_invalid', undefined, null, 'garbage'].every((r) => sessionEndedMessage(r) === SESSION_ENDED_MESSAGE), 'missing, invalid, unknown and absent reasons get the generic text');
assert(sessionEndedMessage('session_mismatch') === SESSION_MISMATCH_MESSAGE, 'S149-1 session_mismatch has its own text');
assert(sessionEndedMessage('session_idle') === SESSION_IDLE_MESSAGE && sessionEndedMessage('mfa_required') === MFA_REQUIRED_MESSAGE, 'S163-S1 session_idle and mfa_required have their own texts');
assert(isReauthReason('session_idle') && isReauthReason('mfa_required') && !isReauthReason('session_revoked') && !isReauthReason('session_expired') && !isReauthReason(undefined) && !isReauthReason(null), 'S163-S2 only session_idle and mfa_required are re-authentication reasons');
assert([SESSION_IDLE_MESSAGE, MFA_REQUIRED_MESSAGE].every((m) => !/token/i.test(m)) && SESSION_IDLE_MESSAGE.includes('inactivity'), 'S163-S3 the new texts name no token');
assert([SESSION_ENDED_MESSAGE, SESSION_EXPIRED_MESSAGE, SESSION_REVOKED_MESSAGE, SESSION_MISMATCH_MESSAGE].every((m) => !/token/i.test(m)), 'no session message mentions a token');

console.log('\n--- Through ApiClient, against a stubbed fetch ---');
let stored: string | null = 'sess';
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => stored, setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
const realFetch = globalThis.fetch;
let fetchCalls = 0;
function stub(status: number, body: unknown, before?: () => void) {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    before?.();
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
  }) as typeof fetch;
}
async function attempt(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}
let signals: string[] = [];
function fresh() {
  resetSessionSignal();
  signals = [];
  stored = 'sess';
  onSessionRejected((t) => signals.push(t));
}

(async () => {
  try {
    fresh();
    stub(401, { error: 'Unauthorized: Invalid or expired token' });
    let r = await attempt(() => ApiClient.listMyTenants());
    assert(r.value === null && signals.length === 1 && signals[0] === 'sess', 'listMyTenants 401 resolves null and signals once', { r, signals });

    fresh();
    stub(401, { error: 'x' });
    r = await attempt(() => ApiClient.getPlatformStatus());
    assert(r.value === null && signals.length === 1, 'getPlatformStatus 401 resolves null and signals once', { r, signals });

    fresh();
    stub(401, { error: 'Invalid email or password' });
    r = await attempt(() => ApiClient.localLogin('ann@enclave.mil', 'bad'));
    assert(r.error instanceof ApiError && r.error.status === 401 && signals.length === 0, 'a failed login is a 401 ApiError and does not signal', { signals });

    for (const reason of ['invalid_code', 'mfa_token_invalid']) {
      fresh();
      stub(401, { error: 'x', reason });
      r = await attempt(() => ApiClient.verifyMfa('tok', { code: '000000' }));
      assert(r.error instanceof ApiError && r.error.reason === reason && signals.length === 0, `verifyMfa ${reason} throws and does not signal`, { signals });
    }

    fresh();
    stub(401, { error: 'x', reason: 'mfa_token_invalid' });
    r = await attempt(() => ApiClient.confirmMfaEnrolment('123456', 'tok'));
    assert(r.error instanceof ApiError && signals.length === 0, 'confirmMfaEnrolment with a pending token does not signal', { signals });

    fresh();
    stub(403, { error: 'x', reason: 'password_change_required' });
    r = await attempt(() => ApiClient.getMfaStatus());
    assert(r.error instanceof ApiError && r.error.status === 403 && signals.length === 0, 'password_change_required (403) does not signal', { signals });

    fresh();
    stub(403, { error: 'x', reason: 'invalid_current_password' });
    r = await attempt(() => ApiClient.changePassword('a', 'b', undefined, 'sess'));
    assert(r.error instanceof ApiError && r.error.status === 403 && signals.length === 0, 'a wrong current password (403) does not signal', { signals });

    fresh();
    stub(500, { error: 'x' });
    r = await attempt(() => ApiClient.getControls('t'));
    assert(r.error instanceof ApiError && r.error.status === 500 && signals.length === 0, 'a 500 does not signal', { signals });

    fresh();
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    r = await attempt(() => ApiClient.getControls('t'));
    assert(r.error instanceof ApiError && r.error.status === 0 && signals.length === 0, 'a network failure is ApiError status 0 and does not signal', { signals });

    fresh();
    stub(401, { error: 'x' }, () => {
      stored = 'sess2';
    });
    r = await attempt(() => ApiClient.listMyTenants());
    assert(signals.length === 0, 'a stale request (the stored token changed meanwhile) does not signal', { signals });

    fresh();
    stub(401, { error: 'x' });
    r = await attempt(() => ApiClient.getStorageInfo('t', 'tok-1'));
    assert(r.value === null && signals.length === 0, 'getStorageInfo with another token than the stored one resolves null and does not signal', { r, signals });

    fresh();
    stub(401, { error: 'x' });
    const all = await Promise.allSettled([ApiClient.getControls('t'), ApiClient.getEvidence('t'), ApiClient.listMyTenants()]);
    assert(all.length === 3 && signals.length === 1 && signals[0] === 'sess', 'three simultaneous 401s signal exactly once', { signals });

    fresh();
    stored = null;
    stub(401, { error: 'x' });
    r = await attempt(() => ApiClient.listMyTenants());
    const r2 = await attempt(() => ApiClient.getControls('t'));
    assert(r.value === null && r2.error !== undefined && fetchCalls === 0 && signals.length === 0, 'with no stored token no request is sent and nothing signals', { fetchCalls, signals });
    assert(r2.error instanceof Error && r2.error.message === 'Not authenticated: no active session', 'S182-1 getControls without a session says there is no active session', { message: (r2.error as Error | undefined)?.message });
    stored = null;
    fetchCalls = 0;
    const r3 = await attempt(() => ApiClient.getEvidence('t'));
    assert(r3.error instanceof Error && r3.error.message === 'Not authenticated: no active session' && fetchCalls === 0, 'S182-2 getEvidence without a session says the same and sends nothing', { fetchCalls });

    fresh();
    const reasons: Array<string | undefined> = [];
    onSessionRejected((_t, reason) => reasons.push(reason));
    globalThis.fetch = (async () => {
      const res = { ok: false, status: 401, statusText: '', json: async () => ({ error: 'x', reason: 'session_revoked' }), clone: () => res };
      return res as unknown as Response;
    }) as typeof fetch;
    await attempt(() => ApiClient.listMyTenants());
    assert(signals.length === 1 && reasons.length === 1 && reasons[0] === 'session_revoked', 'C33-2 a 401 body reason is passed to the listener', { signals, reasons });

    fresh();
    const reasons2: Array<string | undefined> = [];
    onSessionRejected((_t, reason) => reasons2.push(reason));
    stub(401, { error: 'x', reason: 'session_revoked' });
    await attempt(() => ApiClient.listMyTenants());
    assert(signals.length === 1 && reasons2.length === 1 && reasons2[0] === undefined, 'C33-3 a response without clone() still signals once, with no reason', { signals, reasons2 });
  } finally {
    globalThis.fetch = realFetch;
    resetSessionSignal();
  }

  console.log('\n--- Static check: only the anonymous calls use a raw fetch ---');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/services/apiClient.ts'), 'utf8').split(/\r?\n/);
  const rawFetch = src.filter((line) => /(^|[^.\w])fetch\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  const allowed = ['return await fetch(input, init)', 'res = await fetch(input, init)', '/api/v1/setup/status', '/api/v1/health', '/api/v1/controls/frameworks', 'fetch(url)'];
  const unexpected = rawFetch.filter((line) => !allowed.some((a) => line.includes(a)));
  assert(rawFetch.length === 5 && unexpected.length === 0, 'the only raw fetch calls are inside apiFetch and the anonymous status, health, frameworks and mappings reads', { rawFetch });

  const apiSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/apiClient.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert(!apiSrc.includes('ID token') && apiSrc.split("'Not authenticated: no active session'").length - 1 === 2, 'S182-3 apiClient names no ID token and has the no-session message exactly twice');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
