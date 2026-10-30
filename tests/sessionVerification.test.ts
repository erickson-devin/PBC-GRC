import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionVerifyingScreen } from '../src/components/auth/SessionVerifyingScreen';
import { ApiClient, ApiError } from '../src/services/apiClient';
import { onSessionRejected, resetSessionSignal } from '../src/services/sessionSignal';
import {
  SESSION_VERIFY_TIMEOUT_MS,
  initialSessionCheck,
  mayLoadServerData,
  nextSessionCheck,
  outcomeFromSyncError,
  shouldHoldForVerification,
  type SessionCheck,
} from '../src/data/sessionVerification';

/**
 * A reload with a stored session waits for the server's first answer: the state machine, the ApiClient result that tells a
 * dead session from an outage, and the wiring in the contexts (source checks).
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

console.log('--- initialSessionCheck ---');
assert(initialSessionCheck(true, true) === 'verifying', 'a stored token and user verify');
assert(initialSessionCheck(true, false) === 'none', 'a token without a user does not');
assert(initialSessionCheck(false, true) === 'none', 'a user without a token does not');
assert(initialSessionCheck(false, false) === 'none', 'nothing stored does not');

console.log('\n--- outcomeFromSyncError ---');
assert(outcomeFromSyncError(new ApiError(0, 'x')) === 'offline', 'a network failure is offline');
assert([500, 502, 503, 429, 404].every((s) => outcomeFromSyncError(new ApiError(s, 'x')) === 'offline'), '5xx, 429 and other 4xx are offline');
assert(outcomeFromSyncError(new Error('x')) === 'offline', 'a plain Error is offline');
assert(outcomeFromSyncError(null) === 'offline', 'a non-error is offline');
assert(outcomeFromSyncError(new ApiError(401, 'x')) === 'rejected', 'a 401 is rejected');

console.log('\n--- nextSessionCheck ---');
const sync = (outcome: 'verified' | 'rejected' | 'password_change_required' | 'offline') => ({ type: 'sync' as const, outcome });
const rows: Array<[SessionCheck, Parameters<typeof nextSessionCheck>[1], SessionCheck, string]> = [
  ['verifying', sync('verified'), 'verified', 'verifying + verified'],
  ['verifying', sync('password_change_required'), 'verified', 'verifying + password change required'],
  ['verifying', sync('offline'), 'offline', 'verifying + offline'],
  ['verifying', sync('rejected'), 'none', 'verifying + rejected'],
  ['verifying', { type: 'timeout' }, 'offline', 'verifying + timeout'],
  ['offline', sync('verified'), 'verified', 'offline + verified'],
  ['offline', sync('rejected'), 'none', 'offline + rejected'],
  ['offline', sync('offline'), 'offline', 'offline + offline'],
  ['offline', { type: 'timeout' }, 'offline', 'offline + timeout'],
  ['verified', { type: 'timeout' }, 'verified', 'verified + timeout'],
  ['verified', sync('offline'), 'verified', 'verified + offline'],
  ['none', { type: 'timeout' }, 'none', 'none + timeout'],
  ['none', sync('verified'), 'none', 'none + verified'],
  ['none', { type: 'signedIn' }, 'verified', 'none + signedIn'],
  ['verifying', { type: 'signedIn' }, 'verified', 'verifying + signedIn'],
];
for (const [from, event, to, name] of rows) assert(nextSessionCheck(from, event) === to, `${name} -> ${to}`);
const all: SessionCheck[] = ['none', 'verifying', 'verified', 'offline'];
assert(all.every((c) => nextSessionCheck(c, { type: 'signedOut' }) === 'none'), 'signed out is none from every state');

console.log('\n--- constants and the hold rule ---');
assert(SESSION_VERIFY_TIMEOUT_MS === 8000, 'the verification limit is 8 seconds');
assert(shouldHoldForVerification('verifying') === true, 'verifying holds the app');
assert(['none', 'verified', 'offline'].every((c) => shouldHoldForVerification(c as SessionCheck) === false), 'the other states do not');

console.log('\n--- ApiClient.listMyTenantsResult, against a stubbed fetch ---');
let stored: string | null = 'sess';
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => stored, setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
const realFetch = globalThis.fetch;
function stub(status: number, body: unknown) {
  globalThis.fetch = (async () => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => body }) as Response) as typeof fetch;
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
    stub(200, []);
    let r = await attempt(() => ApiClient.listMyTenantsResult());
    assert(JSON.stringify(r.value) === JSON.stringify({ kind: 'ok', tenants: [] }), '200 [] is ok with no tenants', r);

    fresh();
    stub(401, { error: 'x' });
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert((r.value as { kind?: string } | undefined)?.kind === 'rejected' && signals.length === 1, '401 is rejected and signals once', { r, signals });

    fresh();
    stub(403, { reason: 'password_change_required' });
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert((r.value as { kind?: string } | undefined)?.kind === 'password_change_required' && signals.length === 0, '403 password_change_required is its own result and does not signal', { r, signals });

    fresh();
    stub(403, { reason: 'other' });
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert(r.error instanceof ApiError && r.error.status === 403, 'another 403 throws an ApiError with its status', r);

    fresh();
    stub(500, { error: 'boom' });
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert(r.error instanceof ApiError && r.error.status === 500 && signals.length === 0, '500 throws an ApiError 500 and does not signal', { r, signals });

    fresh();
    stub(503, {});
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert(r.error instanceof ApiError && r.error.status === 503, '503 throws an ApiError 503', r);

    fresh();
    globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
    r = await attempt(() => ApiClient.listMyTenantsResult());
    assert(r.error instanceof ApiError && r.error.status === 0 && signals.length === 0, 'a network failure throws an ApiError 0 and does not signal', { r, signals });

    fresh();
    stub(401, { error: 'x' });
    r = await attempt(() => ApiClient.listMyTenants());
    assert(r.value === null && signals.length === 1, 'listMyTenants still resolves null on a 401 and signals once', { r, signals });

    fresh();
    stub(403, { reason: 'password_change_required' });
    r = await attempt(() => ApiClient.listMyTenants());
    assert(r.value === null, 'listMyTenants still resolves null when the password must be changed', r);
  } finally {
    globalThis.fetch = realFetch;
    resetSessionSignal();
  }

  console.log('\n--- Static checks: the wiring ---');
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
  const auth = read('src/context/AuthContext.tsx');
  assert(auth.includes('initialSessionCheck('), 'AuthContext starts from initialSessionCheck()');
  assert(/setTimeout\([^;]*SESSION_VERIFY_TIMEOUT_MS/.test(auth), 'AuthContext limits the wait with SESSION_VERIFY_TIMEOUT_MS in a setTimeout');
  const logoutBody = auth.slice(auth.indexOf('const logout = useCallback'), auth.indexOf('const openAuthModal'));
  assert(logoutBody.includes('signedOut'), 'logout applies signedOut');
  const applyBody = auth.slice(auth.indexOf('const applySession = useCallback'), auth.indexOf('const loginWithEmailPassword'));
  assert(applyBody.includes('signedIn'), 'applySession applies signedIn');
  assert(/sessionCheck,\n/.test(auth.slice(auth.indexOf('const value = useMemo'))), 'sessionCheck is part of the context value');
  const tenant = read('src/context/TenantContext.tsx');
  const syncBody = tenant.slice(tenant.indexOf('const syncTenantsFromServer = useCallback'), tenant.indexOf('// Reload with an existing session'));
  assert(syncBody.includes('listMyTenantsResult(') && syncBody.includes('outcome:'), 'the tenant sync uses listMyTenantsResult() and records an outcome');

  // #34: refreshTeam ignores stale answers (per tenant, and across a sign-out)
  const refreshTeamBody = tenant.slice(tenant.indexOf('const refreshTeam = useCallback'), tenant.indexOf('const refreshAllTeams'));
  const teamCatchAt = refreshTeamBody.indexOf('catch (err');
  const teamCatchCheckAt = refreshTeamBody.indexOf('isCurrentResponse(', teamCatchAt);
  assert(
    refreshTeamBody.includes('teamEpoch') && refreshTeamBody.split('isCurrentResponse(').length - 1 >= 2
      && teamCatchCheckAt > teamCatchAt && teamCatchCheckAt < refreshTeamBody.indexOf("console.warn('[Team]"),
    'T34-1 refreshTeam checks the epoch and sequence on success and before the catch warns'
  );
  const resetBody = tenant.slice(tenant.indexOf('const resetForSignOut = useCallback'), tenant.indexOf('Domain-based auto-tenant matching'));
  assert(resetBody.includes('teamEpoch.current++') && resetBody.includes('setTeamError(null)'), 'T34-2 sign-out invalidates the team loads and clears the team error');

  // #36: no programs or team request during the forced password change
  assert(
    mayLoadServerData(true, false) === true && mayLoadServerData(true, true) === false && mayLoadServerData(false, false) === false && mayLoadServerData(false, true) === false,
    'P36-1 mayLoadServerData: only with a token and not paused'
  );
  const programsEffectStart = tenant.indexOf('// Programs follow the active tenant');
  const programsEffectBody = tenant.slice(programsEffectStart, tenant.indexOf('commitPrograms, serverLoadsPaused]', programsEffectStart) + 40);
  assert(programsEffectStart > 0 && programsEffectBody.includes('mayLoadServerData(') && programsEffectBody.includes('serverLoadsPaused]'), 'P36-2 the programs effect waits while the loads are paused and re-runs when they resume');
  const teamEffectStart = tenant.indexOf('// A server-backed tenant\'s team and invitations live on the server');
  const teamEffectBody = tenant.slice(teamEffectStart, tenant.indexOf('refreshTeam, serverLoadsPaused]', teamEffectStart) + 40);
  assert(teamEffectStart > 0 && teamEffectBody.includes('mayLoadServerData(') && teamEffectBody.includes('serverLoadsPaused]'), 'P36-3 the team effect waits while the loads are paused and re-runs when they resume');
  assert(auth.includes('useLayoutEffect(') && auth.includes('setServerLoadsPaused(isAuthenticated && mustChangePassword)'), 'P36-4 AuthContext pauses the loads in a layout effect while the password change is pending');
  const programsBody = tenant.slice(tenant.indexOf('const refreshPrograms = useCallback'), tenant.indexOf('// Programs follow the active tenant'));
  assert(programsBody.includes('password_change_required') && programsBody.indexOf('password_change_required') < programsBody.indexOf("console.warn('[Programs]"), 'P36-5 refreshPrograms treats password_change_required as idle, before it warns');

  console.log('\n--- Screens ---');
  const verifyingHtml = renderToStaticMarkup(React.createElement(SessionVerifyingScreen));
  assert(
    ['role="status"', 'aria-live="polite"', 'aria-busy="true"', 'Checking your session with the server', 'Verifying your session'].every((s) => verifyingHtml.includes(s)),
    'U1-1 the verifying screen is a polite busy status with the explanation'
  );
  assert(!verifyingHtml.includes('<button') && !verifyingHtml.includes('<input'), 'U1-1 the verifying screen has no controls');
  const app = read('src/App.tsx');
  const holdAt = app.indexOf('if (shouldHoldForVerification(sessionCheck)) return <SessionVerifyingScreen />;');
  assert(holdAt >= 0 && holdAt < app.indexOf('if (isAuthenticated && mustChangePassword)'), 'U1-2 the verifying screen is returned before the password-change screen');
  const rootSlice = app.slice(app.indexOf('// Unknown paths (and /)'), app.indexOf('const navigateToApp'));
  assert(rootSlice.includes('shouldHoldForVerification(sessionCheck)'), 'U1-3 root resolution waits for the verification');
  assert(/\[currentRoute, authLoading, isAuthenticated, setup\.state, sessionCheck\]/.test(rootSlice), 'U1-3 the root-resolution effect depends on sessionCheck');
  assert(
    app.includes("import { SessionVerifyingScreen } from './components/auth/SessionVerifyingScreen';")
      && app.includes("import { shouldHoldForVerification } from './data/sessionVerification';"),
    'U1-4 App imports the screen and the gate'
  );
  const header = read('src/components/layout/Header.tsx');
  const noticeAt = header.indexOf('<SessionOfflineNotice />');
  assert(noticeAt >= 0 && noticeAt < header.indexOf('<BrowserOnlyNotesBanner />') && header.includes("from './SessionOfflineNotice'"), 'U1-5 the Header hosts the offline notice above the browser-only banner');
  const notice = read('src/components/layout/SessionOfflineNotice.tsx');
  assert(
    ["sessionCheck === 'offline'", 'syncTenantsFromServer(undefined, { force: true })', 'role="status"', 'aria-live="polite"', 'aria-label="Hide this notice"', 'setDismissed(false)'].every((s) => notice.includes(s))
      && /was === 'offline' && sessionCheck === 'verified'/.test(notice),
    'U1-6 the offline notice retries, hides per episode, announces and detects the recovery'
  );
  assert(!/console\.|localStorage|sessionStorage|indexedDB/.test(notice), 'U1-6 the offline notice logs and stores nothing');
  const headerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'layout', 'Header.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert(/sessionCheck === 'offline' \? \(/.test(headerSrc) && headerSrc.includes('OFFLINE'), 'U1-7 the header badge says OFFLINE, not LIVE ENCLAVE, while the cached app is shown');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
