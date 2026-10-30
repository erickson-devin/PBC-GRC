import fs from 'fs';
import path from 'path';
import { ApiClient, ApiError } from '../src/services/apiClient';
import {
  isCrossTabReason,
  onSessionRejected,
  reportCrossTabEnd,
  reportResponseStatus,
  resetSessionSignal,
  sessionEndedMessage,
  SESSION_ENDED_MESSAGE,
  SESSION_MISMATCH_MESSAGE,
  SIGNED_OUT_ELSEWHERE_MESSAGE,
  SWITCHED_ELSEWHERE_MESSAGE,
} from '../src/services/sessionSignal';
import { crossTabChange, pinTabSession, readStoredSession, resetTabSession } from '../src/services/tabSession';

/**
 * Cross-tab session sync (#32): the rule that compares this tab's pinned session with the browser's stored one, the signal it
 * raises, the API client refusing to send for a session another tab ended or replaced, and source pins on the contexts.
 * Pure test: no server, no browser (a Map-backed localStorage and a stubbed fetch).
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

const REF_KEY = 'pbc_session_ref_v3';
const USER_KEY = 'pbc_session_auth_user_v2';
const U1 = '{"id":"u1","email":"a@x"}';
const U2 = '{"id":"u2"}';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
  configurable: true,
  writable: true,
});

const realFetch = globalThis.fetch;
let inits: RequestInit[] = [];
function stub(status: number, body: unknown) {
  inits = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    inits.push(init ?? {});
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body, clone() { return this; } } as unknown as Response;
  }) as typeof fetch;
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function attempt(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}
let heard: Array<[string, string | undefined]> = [];
function fresh() {
  resetSessionSignal();
  resetTabSession();
  store.clear();
  heard = [];
  onSessionRejected((t, reason) => heard.push([t, reason]));
}
function markerOf(init: RequestInit): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.['X-PBC-Session'];
}

const pinned = { ref: 'R1', userId: 'u1' };

console.log('--- crossTabChange ---');
assert(crossTabChange(null, 'R2', 'u2') === 'own' && crossTabChange(null, null, null) === 'own', 'S32-1 a tab with nothing pinned never reports a change');
assert(crossTabChange(pinned, 'R1', 'u1') === 'own' && crossTabChange(pinned, 'R1', null) === 'own', 'S32-2 the same reference is own');
assert(crossTabChange(pinned, null, null) === 'signed_out_elsewhere' && crossTabChange(pinned, null, 'u1') === 'signed_out_elsewhere', 'S32-3 no stored reference is signed out elsewhere');
assert(crossTabChange(pinned, 'R2', 'u2') === 'switched_elsewhere', 'S32-4 another reference and another user is a switch');
assert(crossTabChange(pinned, 'R1', 'u2') === 'switched_elsewhere', 'S32-5 the same reference with another user record is a switch');
assert(crossTabChange(pinned, 'R2', 'u1') === 'adopt', 'S32-6 another reference for the same user is adopted');
assert(crossTabChange(pinned, 'R2', null) === 'switched_elsewhere' && crossTabChange({ ref: 'R1', userId: null }, 'R2', 'u1') === 'switched_elsewhere', 'S32-7 an unknown owner is never adopted');

console.log('\n--- readStoredSession ---');
{
  const mk = (ref: string | null, user: string | null) => ({ getItem: (k: string) => (k === REF_KEY ? ref : k === USER_KEY ? user : null) });
  const a = readStoredSession(mk('R1', U1));
  const b = readStoredSession(mk('R1', 'not json'));
  const c = readStoredSession(mk('R1', '{"id":5}'));
  const d = readStoredSession(mk('', U1));
  const e = readStoredSession({ getItem: () => { throw new Error('storage unavailable'); } });
  assert(a.ref === 'R1' && a.userId === 'u1', 'S32-8a reads the reference and the user id');
  assert(b.ref === 'R1' && b.userId === null, 'S32-8b a user record that is not JSON has no id');
  assert(c.userId === null, 'S32-8c a non-string id is no id');
  assert(d.ref === null && d.userId === 'u1', 'S32-8d an empty reference is null');
  assert(e.ref === null && e.userId === null, 'S32-8e a throwing storage reads as empty');
}

console.log('\n--- messages ---');
assert(sessionEndedMessage('signed_out_elsewhere') === SIGNED_OUT_ELSEWHERE_MESSAGE && sessionEndedMessage('switched_elsewhere') === SWITCHED_ELSEWHERE_MESSAGE, 'S32-9a each cross-tab reason has its message');
assert(SIGNED_OUT_ELSEWHERE_MESSAGE !== SESSION_ENDED_MESSAGE && SWITCHED_ELSEWHERE_MESSAGE !== SESSION_ENDED_MESSAGE && !/token/i.test(SIGNED_OUT_ELSEWHERE_MESSAGE) && !/token/i.test(SWITCHED_ELSEWHERE_MESSAGE), 'S32-9b they differ from the generic text and never say token');
assert(isCrossTabReason('signed_out_elsewhere') && isCrossTabReason('switched_elsewhere') && !isCrossTabReason('session_revoked') && !isCrossTabReason(undefined) && !isCrossTabReason(null), 'S32-9c isCrossTabReason');
assert(isCrossTabReason('session_mismatch') === true, 'S149-c1 session_mismatch is a cross-tab reason');
assert(sessionEndedMessage('session_mismatch') === SESSION_MISMATCH_MESSAGE && SESSION_MISMATCH_MESSAGE !== SWITCHED_ELSEWHERE_MESSAGE && SESSION_MISMATCH_MESSAGE !== SESSION_ENDED_MESSAGE && !/token/i.test(SESSION_MISMATCH_MESSAGE), 'S149-c1b session_mismatch has its own text, never saying token');

(async () => {
  try {
    console.log('\n--- reportCrossTabEnd ---');
    fresh();
    reportCrossTabEnd('R1', 'switched_elsewhere');
    reportCrossTabEnd('R1', 'switched_elsewhere');
    reportCrossTabEnd('R1', 'switched_elsewhere');
    assert(heard.length === 0, 'S32-10a nothing is heard synchronously');
    await flush();
    assert(heard.length === 1 && heard[0][0] === 'R1' && heard[0][1] === 'switched_elsewhere', 'S32-10b three reports signal once, asynchronously', heard);
    reportResponseStatus(401, 'R1', 'R1');
    assert(heard.length === 1, 'S32-12 a later 401 on the same reference does not signal again', heard);
    fresh();
    reportCrossTabEnd(null, 'switched_elsewhere');
    reportCrossTabEnd(undefined, 'signed_out_elsewhere');
    await flush();
    assert(heard.length === 0, 'S32-11 no reference, no signal');

    console.log('\n--- Through ApiClient ---');
    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R1');
    store.set(USER_KEY, U1);
    stub(200, []);
    assert(ApiClient.getToken() === 'R1', 'S32-13a the own session is returned');
    await attempt(() => ApiClient.listMyTenants());
    await flush();
    assert(inits.length === 1 && markerOf(inits[0]) === 'R1' && heard.length === 0, 'S32-13b the request is sent with the own reference and nothing signals', { n: inits.length, heard });

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R2');
    store.set(USER_KEY, U2);
    stub(200, []);
    assert(ApiClient.getToken() === null, 'S32-14a another account in the stored session: no reference');
    const r14 = await attempt(() => ApiClient.listMyTenants());
    await flush();
    assert(r14.value === null && inits.length === 0, 'S32-14b nothing is sent', { r14, n: inits.length });
    assert(heard.length === 1 && heard[0][0] === 'R1' && heard[0][1] === 'switched_elsewhere', 'S32-14c the tab hears switched_elsewhere once', heard);

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R2');
    store.set(USER_KEY, U2);
    stub(200, {});
    const r15 = await attempt(() => ApiClient.changePassword('a', 'b', undefined, 'R1'));
    const e15 = r15.error as ApiError | undefined;
    assert(e15 instanceof ApiError && e15.status === 401 && e15.reason === 'switched_elsewhere' && e15.message === SWITCHED_ELSEWHERE_MESSAGE && inits.length === 0, 'S32-15 a request with an explicit marker is refused before it is sent', { r15, n: inits.length });

    fresh();
    pinTabSession('R1', 'u1');
    store.set(USER_KEY, U1);
    stub(200, { isPlatformAdmin: false });
    const r16 = await attempt(() => ApiClient.getPlatformStatus('R1'));
    await flush();
    assert(r16.value === null && inits.length === 0 && heard.length === 1 && heard[0][1] === 'signed_out_elsewhere', 'S32-16 a removed reference is signed out elsewhere', { r16, n: inits.length, heard });

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R2');
    store.set(USER_KEY, U1);
    stub(200, []);
    assert(ApiClient.getToken() === 'R2', 'S32-17a the same user rotated elsewhere is adopted');
    await attempt(() => ApiClient.listMyTenants());
    await flush();
    assert(inits.length === 1 && markerOf(inits[0]) === 'R2' && heard.length === 0, 'S32-17b the request carries the new reference, no signal', { n: inits.length, heard });

    fresh();
    store.set(REF_KEY, 'R2');
    assert(ApiClient.getToken() === 'R2', 'S32-18a nothing pinned: the stored reference is returned');
    await flush();
    assert(heard.length === 0, 'S32-18b nothing pinned: no signal');

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R2');
    store.set(USER_KEY, U2);
    stub(401, { error: 'Invalid email or password' });
    const r19 = await attempt(() => ApiClient.localLogin('a@x', 'p'));
    assert(r19.error instanceof ApiError && inits.length === 1 && markerOf(inits[0]) === undefined, 'S32-19 a sign-in carries no marker, so it is sent and answered', { n: inits.length });

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R1');
    store.set(USER_KEY, U1);
    stub(401, { error: 'x', reason: 'session_revoked' });
    await attempt(() => ApiClient.listMyTenants());
    await flush();
    assert(heard.length === 1 && heard[0][0] === 'R1' && heard[0][1] === 'session_revoked', 'S32-20 a server 401 on the own session still signals with its reason', heard);

    fresh();
    pinTabSession('R1', 'u1');
    store.set(REF_KEY, 'R1');
    store.set(USER_KEY, U1);
    stub(401, { error: 'x', reason: 'session_mismatch' });
    await attempt(() => ApiClient.listMyTenants());
    await flush();
    assert(heard.length === 1 && heard[0][0] === 'R1' && heard[0][1] === 'session_mismatch', 'S149-c2 a server 401 session_mismatch signals once with its reason', heard);
  } finally {
    globalThis.fetch = realFetch;
    resetSessionSignal();
    resetTabSession();
  }

  console.log('\n--- Source pins ---');
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
  const auth = read('src/context/AuthContext.tsx');
  const tenant = read('src/context/TenantContext.tsx');
  const tabSrc = read('src/services/tabSession.ts');
  const api = read('src/services/apiClient.ts');
  const slice = (src: string, from: string, to: string): string => {
    const a = src.indexOf(from);
    if (a < 0) return '';
    const b = src.indexOf(to, a + from.length);
    return b < 0 ? src.slice(a) : src.slice(a, b);
  };

  const onStorageSlice = slice(auth, 'const onStorage', 'const onVisible');
  assert(auth.includes("addEventListener('storage'") && auth.includes("removeEventListener('storage'") && auth.includes('visibilitychange')
    && onStorageSlice.includes('AUTH_SESSION_REF_KEY') && onStorageSlice.includes('AUTH_USER_KEY'), 'S32-21 AuthContext listens to storage, focus and visibility and removes them');

  const listener = slice(auth, 'onSessionRejected((token, reason)', 'The first tenant sync');
  const iRescue = listener.indexOf('rescueUnsavedText(');
  const iCross = listener.indexOf('isCrossTabReason(');
  const iLogout = listener.indexOf('void logout()');
  assert(iRescue >= 0 && iRescue < iCross && iCross < iLogout, 'S32-22 the listener rescues the text, then handles a cross-tab end, then logs out');

  const endSlice = slice(auth, 'const endSessionInThisTab', 'const logout = useCallback');
  assert(endSlice.includes('resetForSignOut()') && endSlice.includes('setIsAuthenticated(false)') && endSlice.includes('sessionEndedMessage(reason)') && endSlice.includes('pinTabSession(')
    && !endSlice.includes('ApiClient.signOut') && !endSlice.includes('localStorage.'), 'S32-23 endSessionInThisTab resets this tab only: no server call, no storage');

  const signalSrc = read('src/services/sessionSignal.ts');
  assert(slice(signalSrc, 'export function isCrossTabReason', '\n}').includes("'session_mismatch'"), 'S149-c3 isCrossTabReason accepts session_mismatch');

  const hus = slice(auth,'const handleUserSession', 'syncAuthUser(userProfile');
  const iUser = hus.indexOf('setItem(AUTH_USER_KEY');
  const iRef = hus.indexOf('setItem(AUTH_SESSION_REF_KEY');
  const iPin = hus.indexOf('pinTabSession(');
  assert(iUser >= 0 && iUser < iRef && iRef < iPin && iPin >= 0 && auth.indexOf('syncAuthUser(userProfile') > auth.indexOf('const handleUserSession') + iPin, 'S32-24 sign-in writes the user record, then the reference, then pins, then syncs');

  const syncSlice = slice(auth, '// Sync user and token to storage', 'useLayoutEffect(');
  assert(syncSlice.indexOf("tabSessionState() !== 'own'") >= 0 && syncSlice.indexOf("tabSessionState() !== 'own'") < syncSlice.indexOf('localStorage.'), 'S32-25 the storage-sync effect checks ownership before any storage access');

  const cp = slice(auth, 'const changePassword', 'const registerWithInvite');
  const iCpRef = cp.indexOf('setItem(AUTH_SESSION_REF_KEY');
  const iCpPin = cp.indexOf('pinTabSession(');
  assert(iCpRef >= 0 && iCpPin > iCpRef && iCpPin < cp.indexOf('syncAuthUser('), 'S32-26 changePassword pins the new reference right after storing it');

  const lo = slice(auth, 'const logout = useCallback', 'void ApiClient.signOut()');
  assert(lo.includes('isCrossTabReason(') && lo.includes('pinTabSession(null)'), 'S32-27 logout ends only this tab on a cross-tab state and unpins otherwise');

  const owns = tenant.match(/tabOwnsStoredSession\(\)/g) ?? [];
  const reset = slice(tenant, 'const resetForSignOut', 'resolveTenantForEmail');
  assert(owns.length >= 5 && reset.indexOf('tabOwnsStoredSession()') >= 0 && reset.indexOf('tabOwnsStoredSession()') < reset.indexOf('localStorage.removeItem'), 'S32-28 TenantContext guards its four persist effects and the sign-out clearing', { n: owns.length });

  assert(!/setItem|removeItem|console\.|fetch\(/.test(tabSrc), 'S32-29 tabSession.ts only reads');

  const af = slice(api, 'async function apiFetch', 'What GET /api/v1/tenants answered');
  assert(af.indexOf('isCrossTabReason(') >= 0 && af.indexOf('isCrossTabReason(') < af.indexOf('await fetch(input, init)'), 'S32-30 apiFetch refuses before it fetches');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
