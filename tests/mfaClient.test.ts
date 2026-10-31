import fs from 'fs';
import path from 'path';
import { ApiClient, ApiError, getLastRequestAt, mfaErrorMessage, parseLocalLoginResult } from '../src/services/apiClient';
import { clearLock, writeLock } from '../src/services/idleLock';
import { MFA_REQUIRED_MESSAGE, SESSION_IDLE_MESSAGE } from '../src/services/sessionSignal';
import { pinTabSession, resetTabSession } from '../src/services/tabSession';
import { scrubLegacySessionToken } from '../src/services/legacySessionScrub';
import { buildUserProfile } from '../src/utils/userProfile';
import { groupSecret } from '../src/components/auth/MfaEnrolmentPanel';
import { ACCOUNT_EVENTS_PAGE_SIZE, accountEventLabel, accountEventRows, accountEventsErrorText, formatEventTime } from '../src/utils/accountEvents';
import { showOwnerMfaNotice } from '../src/utils/sessionLock';
import type { AccountEvent } from '../src/services/apiClient';

/**
 * Phase 5.9 client: the sign-in response parser, the plain-language error messages, the second-factor calls (against a stubbed
 * fetch) and static checks that no secret, code, link or recovery code is ever stored or logged by the client.
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
function throwsApiError(fn: () => unknown, status: number): boolean {
  try {
    fn();
    return false;
  } catch (err: unknown) {
    return err instanceof ApiError && err.status === status;
  }
}

const session = { sessionRef: 'r', expiresAt: '2030-01-01T00:00:00.000Z', expiresIn: 28800, user: { id: 'lu_1', email: 'ann@enclave.mil', name: 'Ann' } };

console.log('--- parseLocalLoginResult ---');
const s1 = parseLocalLoginResult(session);
assert(s1.kind === 'session' && s1.kind === 'session' && s1.sessionRef === 'r' && s1.user.email === 'ann@enclave.mil', 'a session body parses to kind session');
assert(s1.kind === 'session' && s1.mustChangePassword === false && s1.mfaEnrolled === false, 'the flags default to false when the server sent none');
const s2 = parseLocalLoginResult({ ...session, mustChangePassword: true, mfaEnrolled: true });
assert(s2.kind === 'session' && s2.mustChangePassword === true && s2.mfaEnrolled === true, 'mustChangePassword and mfaEnrolled are carried through on the session kind');
const s3 = parseLocalLoginResult({ ...session, mfaEnrolled: true, recoveryCodesRemaining: 7 });
assert(s3.kind === 'session' && s3.recoveryCodesRemaining === 7, 'recoveryCodesRemaining is carried through');
const v = parseLocalLoginResult({ mfa: 'verify', mfaToken: 'm', expiresAt: 'x', methods: ['totp', 'recovery_code'] });
assert(v.kind === 'mfa' && v.stage === 'verify' && v.mfaToken === 'm' && v.methods?.length === 2, 'verify stage parses with its methods');
const e1 = parseLocalLoginResult({ mfa: 'enrol', mfaToken: 'm', expiresAt: 'x' });
assert(e1.kind === 'mfa' && e1.stage === 'enrol' && e1.methods === undefined, 'enrol stage parses');
assert(throwsApiError(() => parseLocalLoginResult({}), 502), 'an empty body is a 502 ApiError');
assert(throwsApiError(() => parseLocalLoginResult(null), 502) && throwsApiError(() => parseLocalLoginResult('x'), 502), 'null and a string are 502 ApiErrors');
assert(throwsApiError(() => parseLocalLoginResult({ mfa: 'bogus', mfaToken: 'm' }), 502), 'an unknown mfa stage is a 502 ApiError');
assert(throwsApiError(() => parseLocalLoginResult({ mfa: 'verify', expiresAt: 'x' }), 502), 'a pending step without a token is a 502 ApiError');
assert(throwsApiError(() => parseLocalLoginResult({ ...session, sessionRef: '' }), 502) && throwsApiError(() => parseLocalLoginResult({ ...session, user: null }), 502), 'a session without a reference or user is a 502 ApiError');
// C43-1: the old token-style body (no sessionRef) is not a session
assert(throwsApiError(() => parseLocalLoginResult({ token: 't', user: { email: 'a' }, expiresAt: 'x' }), 502), 'a body with a token but no sessionRef is a 502 ApiError');

console.log('\n--- mfaErrorMessage ---');
assert(!/session has expired|expired/i.test(mfaErrorMessage(401, { reason: 'invalid_code' })) && /code/i.test(mfaErrorMessage(401, { reason: 'invalid_code' })), 'invalid_code does not say the session expired');
assert(!/session has expired|expired/i.test(mfaErrorMessage(403, { reason: 'invalid_code' })), 'invalid_code on a 403 does not say it either');
assert(/sign in again/i.test(mfaErrorMessage(401, { reason: 'mfa_token_invalid' })), 'mfa_token_invalid says to sign in again');
assert(/wait|try again/i.test(mfaErrorMessage(429, {})), '429 says to wait and try again');
assert(/change/i.test(mfaErrorMessage(403, { reason: 'password_change_required' })) && /password/i.test(mfaErrorMessage(403, { reason: 'password_change_required' })), 'password_change_required mentions changing the password');
assert(/administrator/i.test(mfaErrorMessage(503, { reason: 'mfa_unavailable' })), 'mfa_unavailable says to contact the administrator');
assert(/not correct/i.test(mfaErrorMessage(403, { reason: 'invalid_current_password' })), 'invalid_current_password is plain');
assert(mfaErrorMessage(400, { reason: 'weak_password', error: 'Password must be at least 12 characters.' }) === 'Password must be at least 12 characters.', 'weak_password shows the server\'s own explanation');
assert(mfaErrorMessage(400, { reason: 'password_reused' }) === 'That password was used recently. Choose one you have not used before.', 'password_reused has its own plain text');
assert(/own account/i.test(mfaErrorMessage(409, { reason: 'self' })), 'self explains the restriction');
assert(mfaErrorMessage(400, null).length > 0 && mfaErrorMessage(500, undefined).length > 0, 'unknown shapes still give a message');
for (const m of [mfaErrorMessage(401, { reason: 'invalid_code' }), mfaErrorMessage(401, { reason: 'mfa_token_invalid' }), mfaErrorMessage(429, {}), mfaErrorMessage(403, { reason: 'password_change_required' })]) {
  assert(!/mfa_|invalid_code|reason|undefined|\[object/i.test(m), `no machine code leaks into "${m.slice(0, 40)}..."`);
}

console.log('\n--- groupSecret ---');
assert(groupSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') === 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 'a 32-character secret is grouped in fours');
assert(groupSecret('ABCDEF') === 'ABCD EF' && groupSecret('ABCD') === 'ABCD' && groupSecret('') === '', 'short and empty secrets');

console.log('\n--- The calls, against a stubbed fetch ---');
type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
// The stored session the account calls read their bearer token from
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
function stub(status: number, body: unknown) {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
}
const headerOf = (c: Call, name: string): string | undefined => (c.init.headers as Record<string, string> | undefined)?.[name];

(async () => {
  try {
    stub(200, { mfa: 'verify', mfaToken: 'tok', expiresAt: 'x', methods: ['totp'] });
    const login = await ApiClient.localLogin('ann@enclave.mil', 'pw');
    assert(login.kind === 'mfa' && login.stage === 'verify' && login.mfaToken === 'tok', 'localLogin returns the pending step as a union member');

    stub(401, { error: 'Invalid email or password' });
    let err: unknown;
    try { await ApiClient.localLogin('ann@enclave.mil', 'bad'); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 401 && err.message === 'Invalid email or password', 'a failed login keeps the server\'s message');

    stub(200, { ...session, mfaEnrolled: true, recoveryCodesRemaining: 3 });
    const verified = await ApiClient.verifyMfa('tok', { recoveryCode: 'ABCDE-FGHJK' });
    const verifyBody = JSON.parse(String(calls[0].init.body));
    assert(verified.sessionRef === 'r' && verified.recoveryCodesRemaining === 3 && !('kind' in verified), 'verifyMfa returns the session (without the union tag)');
    assert(verifyBody.mfaToken === 'tok' && verifyBody.recoveryCode === 'ABCDE-FGHJK' && !('code' in verifyBody), 'a recovery code is sent as recoveryCode');
    assert(headerOf(calls[0], 'X-PBC-Session') === undefined, 'verifyMfa sends no session marker header (the pending token travels in the body)');

    stub(401, { error: 'x', reason: 'invalid_code' });
    err = undefined;
    try { await ApiClient.verifyMfa('tok', { code: '000000' }); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 401 && err.reason === 'invalid_code' && !/expired/i.test(err.message), 'a wrong code is an ApiError with reason invalid_code and no "expired" message', err);

    stub(401, { error: 'x', reason: 'mfa_token_invalid' });
    err = undefined;
    try { await ApiClient.verifyMfa('tok', { code: '000000' }); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.reason === 'mfa_token_invalid' && /sign in again/i.test(err.message), 'a dead pending token says to sign in again');

    stub(200, { secret: 'GEZDGNBVGY3TQOJQ', otpauthUri: 'otpauth://totp/x', issuer: 'PBC-GRC', accountName: 'ann@enclave.mil', algorithm: 'SHA1', digits: 6, period: 30 });
    const start = await ApiClient.startMfaEnrolment('tok');
    assert(start.secret === 'GEZDGNBVGY3TQOJQ' && start.digits === 6 && JSON.parse(String(calls[0].init.body)).mfaToken === 'tok' && headerOf(calls[0], 'X-PBC-Session') === undefined, 'startMfaEnrolment(token) posts the pending token and no session header');

    stub(200, { recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'], enrolledAt: '2030-01-01T00:00:00.000Z', ...session, mfaEnrolled: true });
    const confirmed = await ApiClient.confirmMfaEnrolment('123456', 'tok');
    assert(confirmed.recoveryCodes.length === 2 && confirmed.session?.sessionRef === 'r', 'confirmMfaEnrolment on the pending path returns the codes and the session');

    stub(200, { recoveryCodes: ['AAAAA-BBBBB'], enrolledAt: '2030-01-01T00:00:00.000Z' });
    const confirmed2 = await ApiClient.confirmMfaEnrolment('123456');
    assert(confirmed2.session === null, 'without a pending token there is no session in the result');

    stub(200, { recoveryCodes: 'not an array' });
    err = undefined;
    try { await ApiClient.confirmMfaEnrolment('123456', 'tok'); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 502, 'malformed recovery codes are a 502');

    stub(200, { ...session, mustChangePassword: false, mfaEnrolled: true });
    const changed = await ApiClient.changePassword('old-old-old-1', 'new-new-new-1', '123456', 'sess');
    const changeBody = JSON.parse(String(calls[0].init.body));
    assert(changed.sessionRef === 'r' && changeBody.currentPassword === 'old-old-old-1' && changeBody.newPassword === 'new-new-new-1' && changeBody.code === '123456' && headerOf(calls[0], 'X-PBC-Session') === 'sess', 'changePassword sends the credentials and code with the session and returns the new session');

    stub(403, { error: 'You must change your password before continuing', reason: 'password_change_required' });
    err = undefined;
    try { await ApiClient.getMfaStatus(); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 403 && err.reason === 'password_change_required' && /change your password/i.test(err.message), 'a 403 password_change_required surfaces its reason and a plain message');

    stub(200, { enrolled: true, enrolledAt: '2030-01-01T00:00:00.000Z', recoveryCodesRemaining: 5, required: true, mode: 'all' });
    const status = await ApiClient.getMfaStatus();
    assert(status.enrolled && status.recoveryCodesRemaining === 5 && status.mode === 'all' && headerOf(calls[0], 'X-PBC-Session') === 'sess', 'getMfaStatus maps the status and sends the session');
    // C43-2: cookie requests are same-origin and carry no Authorization header
    assert(calls[0].init.credentials === 'same-origin' && headerOf(calls[0], 'Authorization') === undefined, 'getMfaStatus sends credentials same-origin and no Authorization header');

    stub(403, { error: 'x', reason: 'invalid_current_password' });
    err = undefined;
    try { await ApiClient.changePassword('a', 'b', undefined, 'sess'); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 403 && err.reason === 'invalid_current_password' && /not correct/i.test(err.message), 'a wrong current password is a 403 with its reason, not an expired session');

    stub(200, { users: [{ id: 'lu_2', email: 'bob@enclave.mil', name: 'Bob', disabled: false, mfaEnrolled: true, mustChangePassword: true, lockedUntil: null, lastLoginAt: null, createdAt: '2030-01-01T00:00:00.000Z' }] });
    const users = await ApiClient.listLocalUsers();
    assert(users.length === 1 && users[0].mfaEnrolled && users[0].mustChangePassword && headerOf(calls[0], 'X-PBC-Session') === 'sess', 'listLocalUsers maps the accounts and sends the session');

    stub(200, { user: users[0], mustChangePassword: true, message: 'ok' });
    const reset = await ApiClient.adminResetPassword('lu_2', 'a-temporary-pass-1', '123456');
    assert(calls[0].url.endsWith('/platform/users/lu_2/reset-password') && JSON.parse(String(calls[0].init.body)).newPassword === 'a-temporary-pass-1' && reset.user.id === 'lu_2', 'adminResetPassword posts to the reset-password route');
    // C38-1: the administrator's own authenticator code travels in the body
    const resetBody = JSON.parse(String(calls[0].init.body));
    assert(JSON.stringify(resetBody) === JSON.stringify({ newPassword: 'a-temporary-pass-1', code: '123456' }), 'adminResetPassword sends the new password and the step-up code', resetBody);
    stub(200, { user: users[0] });
    await ApiClient.adminResetMfa('lu_2', '123456');
    await ApiClient.disableUser('lu_2', '123456');
    await ApiClient.enableUser('lu_2', '123456');
    assert(calls.map((c) => c.url.split('/platform/users/')[1]).join(',') === 'lu_2/reset-mfa,lu_2/disable,lu_2/enable', 'reset-mfa, disable and enable post to their routes');
    // C38-2
    assert(calls.length === 3 && calls.every((c) => String(c.init.body) === JSON.stringify({ code: '123456' })), 'reset-mfa, disable and enable send exactly { code }', calls.map((c) => c.init.body));

    stub(409, { error: 'x', reason: 'self' });
    err = undefined;
    try { await ApiClient.disableUser('lu_1', '123456'); } catch (e) { err = e; }
    assert(err instanceof ApiError && err.status === 409 && err.reason === 'self', 'acting on your own account is a 409 with reason self');

    stub(200, { recoveryCodes: ['AAAAA-BBBBB'], recoveryCodesRemaining: 1 });
    const regen = await ApiClient.regenerateRecoveryCodes('123456');
    assert(calls[0].url.endsWith('/auth/mfa/recovery-codes') && regen.recoveryCodes.length === 1 && regen.recoveryCodesRemaining === 1, 'regenerateRecoveryCodes posts the code and returns the new set');

    // C43-3: signOut never throws, whatever the server (or the network) does
    stub(401, { error: 'x' });
    let signOutOk = true;
    try { await ApiClient.signOut(); } catch { signOutOk = false; }
    assert(signOutOk && calls[0].url.endsWith('/auth/logout') && calls[0].init.method === 'POST', 'signOut posts to /auth/logout and resolves on a 401');
    calls.length = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      throw new Error('network down');
    }) as typeof fetch;
    signOutOk = true;
    try { await ApiClient.signOut(); } catch { signOutOk = false; }
    assert(signOutOk && calls.length === 1 && calls[0].url.endsWith('/auth/logout') && calls[0].init.method === 'POST', 'signOut resolves when the network call throws');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n--- buildUserProfile: the server id, no invented "verified" flag ---');
  const profileOpts = { tenantId: 't1', role: 'TENANT_OWNER' as const, organization: 'Focus', provider: 'password' as const };
  const withId = buildUserProfile({ id: 'u-123', email: 'devin.erickson@focus.com', name: 'Devin Erickson' }, profileOpts);
  assert(withId.id === 'u-123', 'the profile id is the server user id', withId.id);
  assert(JSON.stringify(withId.roles) === JSON.stringify({ t1: 'TENANT_OWNER' }), 'the role is keyed by the tenant id', withId.roles);
  assert(!('emailVerified' in withId), 'no emailVerified flag is made up');
  const noId = buildUserProfile({ id: '', email: 'devin.erickson@focus.com', name: 'Devin Erickson' }, profileOpts);
  assert(noId.id === 'user-devin-erickson-focus', 'without a server id the e-mail-derived id is the fallback', noId.id);
  const noName = buildUserProfile({ id: 'u-123', email: 'devin.erickson@focus.com', name: null }, profileOpts);
  assert(noName.name === 'Devin Erickson', 'without a name the display name comes from the e-mail', noName.name);

  console.log('\n--- Static checks: nothing secret is stored or logged by the client ---');
  const root = process.cwd();
  const files = ['src/context/AuthContext.tsx', 'src/services/apiClient.ts', 'src/components/auth/MfaEnrolmentPanel.tsx', 'src/components/auth/MfaChallengeForm.tsx'];
  const sources = files.map((f) => ({ f, lines: fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/) }));
  const storageHits = sources.flatMap(({ f, lines }) =>
    lines.map((line, i) => ({ f, i: i + 1, line })).filter(({ line }) => /localStorage|sessionStorage|indexedDB/i.test(line) && /mfa|secret|recovery|otpauth/i.test(line))
  );
  assert(storageHits.length === 0, 'no line that touches localStorage, sessionStorage or IndexedDB mentions mfa, secret, recovery or otpauth', storageHits);
  const setItemHits = sources.flatMap(({ f, lines }) => lines.map((line, i) => ({ f, i: i + 1, line })).filter(({ line }) => /\.setItem\(/.test(line) && /mfa|secret|recovery|otpauth/i.test(line)));
  assert(setItemHits.length === 0, 'no setItem call carries anything named mfa, secret, recovery or otpauth', setItemHits);
  const consoleHits = sources.flatMap(({ f, lines }) => lines.map((line, i) => ({ f, i: i + 1, line })).filter(({ line }) => /console\./.test(line) && /\b(secret|otpauthUri|otpauth|recoveryCodes?|mfaToken|code|codes|password|newPassword|currentPassword|info)\b/i.test(line)));
  assert(consoleHits.length === 0, 'no console call in those files mentions a secret, code, recovery code, token or password', consoleHits);
  const authCtx = fs.readFileSync(path.join(root, 'src/context/AuthContext.tsx'), 'utf8');
  const storedKeys = Array.from(authCtx.matchAll(/const (AUTH_[A-Z_]+_KEY) = '([^']+)'/g)).map((m) => m[2]);
  assert(storedKeys.length === 3 && storedKeys.every((k) => /^pbc_session_(auth_user_v2|flags_v2|ref_v3)$/.test(k)), 'AuthContext stores exactly three keys: the user, the session reference and two account flags', storedKeys);
  assert(/const \[mfaChallenge, setMfaChallenge\] = useState/.test(authCtx) && !/localStorage\.setItem\([^)]*[Cc]hallenge/.test(authCtx), 'the pending second step is React state only');
  const authLf = authCtx.replace(/\r?\n/g, '\n');
  const fnBody = (head: string, tail: string) => {
    const start = authLf.indexOf(head);
    const end = authLf.indexOf(tail, start);
    return start >= 0 && end > start ? authLf.slice(start, end) : '';
  };
  assert(/syncAuthUser\(/.test(fnBody('const changePassword = useCallback', 'const registerWithInvite')), 'changePassword re-syncs the tenants and roles after the change');
  assert(/resetForSignOut\(\)/.test(fnBody('const logout = useCallback', 'const openAuthModal')), 'logout clears the cached tenant state');
  const applyBody = fnBody('const applySession = useCallback', 'const loginWithEmailPassword');
  assert(/session\.mustChangePassword\s*\)/.test(applyBody) && /skipServerSync/.test(fnBody('const handleUserSession = useCallback', 'const applySession')), 'applySession hands the forced-change flag to the sign-in sync, which skips the server calls');

  const logoutRegion = fnBody('const logout = useCallback', 'const openAuthModal');
  assert(/onSessionRejected\(/.test(logoutRegion) && /latestSessionRef\.current/.test(logoutRegion), 'a session the server rejected signs the person out (and only for the token still in use)');
  const signalSrc = fs.readFileSync(path.join(root, 'src/services/sessionSignal.ts'), 'utf8');
  assert(signalSrc.includes("'Your session has ended. Please sign in again.'") && authLf.includes('sessionEndedMessage('), 'the sign-out message after a rejected session is plain, and chosen by the reason');
  const changeRegion = fnBody('const changePassword = useCallback', 'const registerWithInvite');
  const setItemAt = changeRegion.indexOf('localStorage.setItem(AUTH_SESSION_REF_KEY');
  assert(/holdSessionSignal\(/.test(changeRegion) && setItemAt >= 0 && changeRegion.indexOf('releaseSessionSignal(', setItemAt) > setItemAt, 'changePassword holds the old token\'s signal and releases it after the new token is stored');

  // C43-4: the client holds no bearer credential and no longer knows the old token key
  const clientSrc = fs.readFileSync(path.join(root, 'src/services/apiClient.ts'), 'utf8');
  assert(!clientSrc.includes('Bearer ') && !authCtx.includes('Bearer '), 'apiClient.ts and AuthContext.tsx contain no "Bearer " text');
  assert(!clientSrc.includes('pbc_session_id_token_v2') && !authCtx.includes('pbc_session_id_token_v2'), 'neither file mentions the old token storage key');
  assert(!authCtx.includes('sessionStorage'), 'AuthContext.tsx does not touch sessionStorage');

  // #143: the Accretion modal shows a service-token push, not a session token the browser cannot hand out
  const modal = fs.readFileSync(path.join(root, 'src/components/telemetry/AccretionIntegrationModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const tokensModal = fs.readFileSync(path.join(root, 'src/components/auth/ApiTokensModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert(!modal.includes('SESSION_TOKEN'), 'S143-1 AccretionIntegrationModal.tsx shows no SESSION_TOKEN (the session is an HttpOnly cookie)');
  assert(!/no separate sensor key/i.test(modal), 'S143-2 AccretionIntegrationModal.tsx no longer says there is no separate sensor key');
  const header = '-H "Authorization: Bearer <SERVICE_TOKEN>"';
  assert(modal.includes(header) && tokensModal.includes(header), 'S143-3 the Accretion and API Keys modals show the same service-token header');
  assert(modal.includes('exporters/pbc-vm-exporter'), 'S143-4 AccretionIntegrationModal.tsx names the exporter as the supported scanner path');
  assert(modal.includes('copyText(') && !modal.includes('copyToClipboard('), 'S143-5 AccretionIntegrationModal.tsx reports a failed copy');

  // C144: the session reference has session-reference names in code (the stored idToken field keeps its historical name)
  const renamedFiles = ['src/services/apiClient.ts', 'src/context/AuthContext.tsx', 'src/context/TenantContext.tsx', 'src/context/AssessmentContext.tsx', 'src/hooks/useStorageConfig.ts', 'src/hooks/useLocalEvidenceCopies.ts', 'src/hooks/useFailedMoveAssets.ts', 'src/hooks/useLocalAssetScrub.ts', 'src/hooks/useFailedMoveControls.ts', 'src/data/audit/storageDriver.ts'];
  assert(renamedFiles.every(rel => !/\bgetToken\(/.test(fs.readFileSync(path.join(root, rel), 'utf8'))), 'C144-1 no client file calls getToken(): it is getSessionRef()');
  assert(!/\b(setIdToken|idTokenRef)\b/.test(authCtx) && authCtx.includes('const [sessionRef, setSessionRef] = useState'), 'C144-2 AuthContext holds the session reference as sessionRef');
  assert(/\bgetSessionRef\(\): string \| null/.test(clientSrc), 'C144-3 ApiClient exposes getSessionRef()');
  assert(/idToken\?: string;/.test(fs.readFileSync(path.join(root, 'src/types/tenant.ts'), 'utf8')) && fs.readFileSync(path.join(root, 'src/services/legacySessionScrub.ts'), 'utf8').includes('record.idToken') && authCtx.includes("const AUTH_SESSION_REF_KEY = 'pbc_session_ref_v3'"), 'C144-4 the stored idToken field and the storage key keep their names');

  console.log('\n--- scrubLegacySessionToken ---');
  const jwtLike = 'h.p.s';
  const store = new Map<string, string>([
    ['pbc_session_id_token_v2', jwtLike],
    ['pbc_session_auth_user_v2', JSON.stringify({ email: 'a@b', idToken: jwtLike })],
    ['pbc_active_user_v4', JSON.stringify({ name: 'A', idToken: jwtLike })],
  ]);
  const mapStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  assert(scrubLegacySessionToken(mapStorage) === 3, 'the first run changes three things');
  const scrubbedUser = JSON.parse(store.get('pbc_session_auth_user_v2') as string);
  const scrubbedActive = JSON.parse(store.get('pbc_active_user_v4') as string);
  assert(!store.has('pbc_session_id_token_v2') && scrubbedUser.email === 'a@b' && !('idToken' in scrubbedUser) && scrubbedActive.name === 'A' && !('idToken' in scrubbedActive), 'the token key is gone and both user records keep their fields without idToken');
  assert(scrubLegacySessionToken(mapStorage) === 0, 'a second run changes nothing');
  store.set('pbc_active_user_v4', JSON.stringify({ name: 'A', idToken: 'abcDEF_-123' }));
  store.set('pbc_session_auth_user_v2', '{bad');
  assert(scrubLegacySessionToken(mapStorage) === 0 && JSON.parse(store.get('pbc_active_user_v4') as string).idToken === 'abcDEF_-123' && store.get('pbc_session_auth_user_v2') === '{bad', 'a session reference that is not JWT-shaped is kept and invalid JSON is left alone');

  console.log('\n--- C38: administrator step-up ---');
  // C38-3
  assert(/two-step verification/.test(mfaErrorMessage(409, { reason: 'mfa_not_enrolled' })) && !/mfa_/.test(mfaErrorMessage(409, { reason: 'mfa_not_enrolled' })), 'mfa_not_enrolled gets a plain message');
  // C38-4
  const dashLf = fs.readFileSync(path.join(root, 'src/components/admin/SuperAdminDashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert(dashLf.includes('id="admin-step-up-code"') && dashLf.includes('autoComplete="one-time-code"') && dashLf.includes('inputMode="numeric"'), 'the account-action dialog has a one-time-code input');
  const runStart = dashLf.indexOf('const runAccountAction = async');
  const runBody = dashLf.slice(runStart, dashLf.indexOf('// Destruction state', runStart));
  const closeBody = dashLf.slice(dashLf.indexOf('const closeAccountAction'), runStart);
  const apiCalls = runBody.match(/ApiClient\.\w+\([^)]*\)/g) ?? [];
  assert(runStart > 0 && apiCalls.length === 4 && apiCalls.every((c) => c.includes('stepUpCode')), 'all four account actions pass stepUpCode', apiCalls);
  const finallyBody = runBody.slice(runBody.indexOf('finally {'));
  assert(closeBody.includes("setStepUpCode('')") && finallyBody.includes("setStepUpCode('')"), 'the code is cleared on close and in finally');
  assert(!/console\./.test(runBody) && !/localStorage/.test(runBody), 'runAccountAction neither logs nor stores anything');

  console.log('\n--- S163: idle lock and role change ---');
  assert(mfaErrorMessage(401, { reason: 'mfa_required' }) === MFA_REQUIRED_MESSAGE, 'S163-M1 mfa_required has its plain text');
  assert(mfaErrorMessage(401, { reason: 'session_idle' }) === SESSION_IDLE_MESSAGE, 'S163-M2 session_idle has its plain text');
  const lockStore = new Map<string, string>([['pbc_session_ref_v3', 'sess']]);
  const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k: string) => (lockStore.has(k) ? (lockStore.get(k) as string) : null), setItem: (k: string, v: string) => void lockStore.set(k, v), removeItem: (k: string) => void lockStore.delete(k) },
    configurable: true,
    writable: true,
  });
  try {
    resetTabSession();
    pinTabSession('sess', 'lu_1');
    writeLock(globalThis.localStorage, 'sess', Date.now());
    stub(200, { enrolled: false });
    let lockErr: unknown;
    try { await ApiClient.getMfaStatus(); } catch (e) { lockErr = e; }
    assert(calls.length === 0 && lockErr instanceof ApiError && lockErr.status === 401 && lockErr.reason === 'session_locked' && lockErr.message === SESSION_IDLE_MESSAGE, 'S163-M3 while locked a request with the session marker is refused without a fetch', { calls: calls.length });
    stub(200, { sessionIdleSeconds: 900 });
    const cfg = await ApiClient.getAuthConfig();
    assert(cfg.sessionIdleSeconds === 900 && calls.length === 1 && headerOf(calls[0], 'X-PBC-Session') === undefined && calls[0].url.endsWith('/auth/config'), 'S163-M4 getAuthConfig is anonymous and works while locked');
    stub(204, null);
    await ApiClient.signOut();
    assert(calls.length === 1 && calls[0].url.endsWith('/auth/logout'), 'S163-M5 signOut (no marker) still goes out while locked');
    clearLock(globalThis.localStorage);
    stub(200, { enrolled: false });
    await ApiClient.getMfaStatus();
    assert(calls.length === 1, 'S163-M6 after the lock is cleared requests go out again');
    assert(getLastRequestAt() > 0, 'S163-M7 apiFetch records when it last sent a request');
    stub(200, { events: [{ id: 12, at: 'x', actorKind: 'admin', actorUserId: 'a', targetUserId: 't', action: 'account_disabled', tenantId: null, details: { via: 'session' } }, { nope: true }], nextBefore: 12 });
    const page = await ApiClient.listAccountEvents(50, '99');
    assert(calls[0].url.endsWith('/platform/account-events?limit=50&before=99') && page.events.length === 1 && page.events[0].id === '12' && page.nextBefore === '12', 'S163-M8 listAccountEvents sends limit and before, reads ids as strings and drops malformed rows', { url: calls[0].url, page });
    stub(200, { events: [] });
    const empty = await ApiClient.listAccountEvents();
    assert(calls[0].url.endsWith('/platform/account-events') && empty.nextBefore === null, 'S163-M9 listAccountEvents without arguments has no query and no next page');
    stub(200, { recoveryCodes: ['AAAAA-BBBBB'], enrolledAt: 'x', ...session, mfaEnrolled: true });
    const replaced = await ApiClient.confirmMfaEnrolment('123456');
    assert(replaced.session?.sessionRef === 'r' && replaced.session.mfaEnrolled === true, 'S163-M10 enrolment from a session returns the replacement session');
  } finally {
    globalThis.fetch = realFetch;
    resetTabSession();
    Object.defineProperty(globalThis, 'localStorage', { value: realStorage, configurable: true, writable: true });
  }

  console.log('\n--- S40 account events / S39 owner notice ---');
  {
    const readUi = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
    const codes = ['password_changed', 'password_reset', 'mfa_enrolled', 'mfa_reset', 'recovery_codes_regenerated', 'account_disabled', 'account_enabled', 'role_changed', 'member_removed', 'signed_out', 'session_revoked', 'step_up_failed'];
    assert(codes.every((c) => accountEventLabel(c) !== c && !accountEventLabel(c).startsWith('Unrecognised')) && accountEventLabel('password_reset') === 'Password reset by an administrator' && accountEventLabel('x_y') === 'Unrecognised event (x_y)', 'S40-U1 every action code has a plain label; unknown codes are named as unrecognised');
    const ev = (over: Partial<AccountEvent>): AccountEvent => ({ id: '1', at: '2026-01-01T00:00:00Z', actorKind: 'admin', actorUserId: 'u_admin', targetUserId: 'u_t', action: 'account_disabled', tenantId: null, details: {}, ...over });
    const accounts = [{ id: 'u_admin', email: 'admin@x.test' }, { id: 'u_t', email: 't@x.test' }];
    const r2 = accountEventRows([ev({})], accounts, [])[0];
    assert(r2.actor === 'admin@x.test (administrator)' && r2.target === 't@x.test' && r2.tenant === 'None' && r2.details.length === 0, 'S40-U2 an administrator disabling an account', r2);
    assert(accountEventRows([ev({ targetUserId: 'abcdef0123456789' })], [], [])[0].target === 'abcdef01…' && accountEventRows([ev({ targetUserId: 'u_9' })], [], [])[0].target === 'u_9', 'S40-U3 long ids are shortened, short ones stay');
    assert(accountEventRows([ev({ actorKind: 'cli', actorUserId: null })], [], [])[0].actor === 'Command line' && accountEventRows([ev({ actorKind: 'system', actorUserId: null })], [], [])[0].actor === 'System', 'S40-U3 cli and system actors');
    assert(accountEventRows([ev({ actorKind: 'user', actorUserId: 'u_t' })], [], [])[0].actor === 'The account itself' && accountEventRows([ev({ actorKind: 'user', actorUserId: null })], [], [])[0].actor === 'Unknown', 'S40-U3 an account acting on itself, and an unknown user');
    const r4 = accountEventRows([ev({ action: 'role_changed', tenantId: 't1', details: { previousRole: 'ASSESSOR', newRole: 'TENANT_OWNER', via: 'member_update' } })], [], [{ id: 't1', name: 'Acme' }])[0];
    assert(JSON.stringify(r4.details) === JSON.stringify(['Previous role: Assessor', 'New role: Tenant Owner', 'Via: team settings']) && r4.tenant === 'Acme', 'S40-U4 role change details use role labels and the tenant name', r4);
    assert(accountEventRows([ev({ tenantId: 't9' })], [], [{ id: 't1', name: 'Acme' }])[0].tenant === 't9', 'S40-U4 a tenant that is not listed shows its id');
    assert(JSON.stringify(accountEventRows([ev({ details: { mustChangePassword: true } })], [], [])[0].details) === JSON.stringify(['Must change password: yes']), 'S40-U5 booleans read yes/no');
    assert(JSON.stringify(accountEventRows([ev({ details: { attempted: 'disable' } })], [], [])[0].details) === JSON.stringify(['Attempted: disable account']), 'S40-U5 attempted actions read in words');
    assert(JSON.stringify(accountEventRows([ev({ details: { foo: 'bar', nested: { a: 1 } } })], [], [])[0].details) === JSON.stringify(['foo: bar']), 'S40-U5 unknown string keys follow; nested values are not shown');
    assert(accountEventsErrorText(403) === 'Only a platform administrator can read account events.' && accountEventsErrorText(0) === 'Cannot reach the server, so the account events could not be loaded.' && accountEventsErrorText(500) === 'The account events could not be loaded. Try again.' && formatEventTime('not-a-date') === 'not-a-date' && ACCOUNT_EVENTS_PAGE_SIZE === 50, 'S40-U6 error texts, time fallback and page size');
    const panelSrc = readUi('src/components/admin/AccountEventsPanel.tsx');
    const dashSrc = readUi('src/components/admin/SuperAdminDashboard.tsx');
    assert(['ApiClient.listAccountEvents(ACCOUNT_EVENTS_PAGE_SIZE, nextBefore)', 'Load older', 'No account events have been recorded yet.', '<caption className="sr-only">', 'scope="col"'].every((s) => panelSrc.includes(s)) && !/dangerouslySetInnerHTML|console\.|errorMessage\(|\.message/.test(panelSrc) && dashSrc.includes('<AccountEventsPanel localUsers={localUsers} tenants={tenants} refreshKey={usersVersion} />'), 'S40-U7 the panel pages, has a captioned table, shows no raw message; the console mounts it');
    assert(showOwnerMfaNotice('privileged', false) && showOwnerMfaNotice('all', false) && !showOwnerMfaNotice('privileged', true) && !showOwnerMfaNotice('off', false) && !showOwnerMfaNotice(null, false), 'S39-U1 the owner notice shows only for a person without two-step verification under privileged or all');
    assert(readUi('src/components/onboarding/OnboardingModal.tsx').includes('<OwnerMfaNotice') && readUi('src/components/layout/TenantSwitcher.tsx').includes('<OwnerMfaNotice') && readUi('src/components/auth/OwnerMfaNotice.tsx').includes('ApiClient.getMfaStatus()') && readUi('src/pages/AcceptInvitePage.tsx').includes('Owners must use two-step verification'), 'S39-U1 the notice is wired into onboarding, the tenant switcher and the invitation page');
  }

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
})();
