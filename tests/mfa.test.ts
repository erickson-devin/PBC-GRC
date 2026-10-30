import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { spawnSync } from 'child_process';
import { server } from '../server/index';
import { signLocalToken, signMfaPendingToken, verifyLocalToken } from '../server/auth/localAuth';
import { accountLogRef } from '../server/auth/loginThrottle';
import { base32Decode, buildOtpauthUri, generateTotp } from '../server/auth/totp';
import {
  __resetMemoryLocalUsersForTests,
  clearLocalUserMfa,
  createLocalUser,
  findLocalUserByEmail,
  resetLocalUserMfa,
} from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests, createTenantWithOwner, upsertTenantMember } from '../server/db';
import { __resetMemoryInvitationsForTests, createInvitation } from '../server/invitations';
import { __resetPlatformSetupForTests, addPlatformAdmin } from '../server/platformSetup';
import { __resetLoginThrottleForTests, __resetMfaStateForTests, __setMfaClockForTests } from '../server/routes/auth';
import { sessionCookieFrom } from './sessionCookieJar';

/**
 * Second factor (TOTP) for local accounts, end to end through the real server: enrolment, the two-step login, replay and
 * clock drift, recovery codes, lockout, the pending token's limits, MFA_REQUIRED enforcement, password change, admin
 * actions, forced password change, sessions revoked by token_version, and that no secret is ever logged or returned twice.
 * Every code is computed from the enrolled secret against a controlled clock (the server's TOTP checks read it through
 * __setMfaClockForTests); lockout and throttle checks count attempts and never sleep.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const PW = 'correct horse battery staple';
const NEWPW = 'a brand new long passphrase';
const TEMPPW = 'temporary hand-out passphrase';
const T = Math.floor(Date.now() / 30000) * 30000 + 1000; // a fixed instant inside a TOTP step
const STEP = 30000;

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

// Every response body is kept (except enrol/start, which is the one place the secret may appear) for the final "no secret anywhere else" check.
const bodies: Array<{ path: string; text: string }> = [];
const allSecrets = new Set<string>();

async function call(method: string, path: string, opts: { token?: string; tenant?: string; body?: unknown; keepThrottle?: boolean; cookie?: string; headers?: Record<string, string> } = {}) {
  if (!opts.keepThrottle) __resetLoginThrottleForTests(); // the per-IP throttle is its own test (M9); the others must not trip it
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  if (opts.cookie) headers.Cookie = `pbc_session=${opts.cookie}`;
  Object.assign(headers, opts.headers);
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: Record<string, any> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* no body */
  }
  // Mirrors the browser's cookie jar: a session now arrives as a cookie, so the cookie value is kept as body.token and the existing
  // `body.token` call sites keep working (they send it back through the bearer path).
  const cookie = sessionCookieFrom(res.headers);
  if (body && cookie && body.token === undefined) body.token = cookie;
  if (path === '/auth/mfa/enrol/start') {
    if (typeof body?.secret === 'string') allSecrets.add(body.secret);
  } else {
    bodies.push({ path, text });
  }
  return { status: res.status, headers: res.headers, body, text };
}

interface Acct {
  email: string;
  id: string;
  pw: string;
  secret: Buffer | null;
  secretB32: string;
  recovery: string[];
  /** The last step offset (from T) this account used. */
  k: number;
}

const setMode = (mode: string) => {
  process.env.MFA_REQUIRED = mode;
};
const setClock = (ms: number | null) => __setMfaClockForTests(ms === null ? null : () => ms);
const login = (email: string, password = PW) => call('POST', '/auth/login', { body: { email, password } });
const codeAt = (a: Acct, ms: number) => generateTotp(a.secret!, ms);
/** A code the server will refuse for this account whatever the clock is (far outside the window). */
const badCode = (a: Acct) => codeAt(a, T + (a.k + 100) * STEP);
/** Moves the account to its next unused step, sets the server clock there and returns that step's code. */
const fresh = (a: Acct): string => {
  a.k += 1;
  setClock(T + a.k * STEP);
  return codeAt(a, T + a.k * STEP);
};

async function mk(email: string, opts?: { mustChangePassword?: boolean }): Promise<Acct> {
  const u = await createLocalUser({ email, name: email.split('@')[0], password: PW }, opts);
  return { email, id: u.id, pw: PW, secret: null, secretB32: '', recovery: [], k: 0 };
}

async function reset() {
  __resetMemoryLocalUsersForTests();
  __resetMemoryTenantsForTests();
  __resetPlatformSetupForTests();
  __resetMemoryInvitationsForTests();
  __resetLoginThrottleForTests();
  __resetMfaStateForTests();
  setClock(T);
  setMode('off');
}

/** Start + confirm with an enrol-stage token (or a session). Leaves the account at step offset 0. */
async function enrolWith(a: Acct, auth: { mfaToken?: string; token?: string }) {
  const body = auth.mfaToken ? { mfaToken: auth.mfaToken } : undefined;
  const start = await call('POST', '/auth/mfa/enrol/start', { token: auth.token, body });
  a.secretB32 = start.body?.secret ?? '';
  a.secret = a.secretB32 ? base32Decode(a.secretB32) : null;
  a.k = 0;
  setClock(T);
  const confirm = await call('POST', '/auth/mfa/enrol/confirm', {
    token: auth.token,
    body: { ...(body ?? {}), code: a.secret ? codeAt(a, T) : '000000' },
  });
  a.recovery = confirm.body?.recoveryCodes ?? [];
  return { start, confirm };
}

/** Enrols an account through its own session (mode off). Returns the pre-enrolment session token. */
async function enrol(a: Acct): Promise<string> {
  const previous = process.env.MFA_REQUIRED;
  setMode('off');
  const token: string = (await login(a.email, a.pw)).body?.token;
  await enrolWith(a, { token });
  setMode(previous ?? 'off');
  return token;
}

/** Password + one fresh code. */
async function signIn(a: Acct, factor?: { code?: string; recoveryCode?: string }) {
  const code = factor ? factor : { code: fresh(a) };
  const step1 = await login(a.email, a.pw);
  const step2 = step1.body?.mfa === 'verify' ? await call('POST', '/auth/mfa/verify', { body: { mfaToken: step1.body.mfaToken, ...code } }) : null;
  return { step1, step2, token: (step2?.body?.token ?? step1.body?.token) as string | undefined };
}

async function admin() {
  const adm = await mk('admin@mfa.mil');
  await addPlatformAdmin({ userId: adm.id, email: adm.email });
  await enrol(adm); // account management is a step-up (#38): the administrator holds a second factor
  const token = (await signIn(adm)).token as string;
  return { adm, token };
}

/** An administrator's account action: the body carries a fresh authenticator code (the step-up, #38). */
const adminAct = (a: Acct, tok: string, path: string, body: Record<string, unknown> = {}) => call('POST', path, { token: tok, body: { ...body, code: fresh(a) } });

const outcome = (r: { status: number; body: Record<string, any> | null }) => r.body?.mfa ?? (r.body?.token ? 'session' : `status ${r.status}`);

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const savedMfaKey = process.env.MFA_ENCRYPTION_KEY;
  process.env.MFA_ENCRYPTION_KEY = ''; // a developer's own key must not change what these tests derive
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------------------------------------------------ M1, M2
  console.log('--- M1/M2: enrolment needs a valid code; an unconfirmed enrolment does not gate login ---');
  await reset();
  const a1 = await mk('enr1@mfa.mil');
  const t1: string = (await login(a1.email)).body?.token;
  const start1 = await call('POST', '/auth/mfa/enrol/start', { token: t1 });
  assert(start1.status === 200 && /^[A-Z2-7]{32}$/.test(start1.body?.secret ?? ''), 'enrol/start returns a 32 character base32 secret (200)', start1.status);
  assert(
    start1.body?.otpauthUri === buildOtpauthUri({ issuer: 'PBC-GRC', accountName: a1.email, secretBase32: start1.body?.secret }) &&
      start1.body?.issuer === 'PBC-GRC' && start1.body?.algorithm === 'SHA1' && start1.body?.digits === 6 && start1.body?.period === 30,
    'with the otpauth URI for issuer PBC-GRC'
  );
  assert(start1.headers.get('cache-control') === 'no-store', 'and Cache-Control: no-store');
  const start1b = await call('POST', '/auth/mfa/enrol/start', { token: t1 });
  assert(start1b.status === 200 && start1b.body?.secret !== start1.body?.secret, 'starting again before confirming replaces the pending secret');
  a1.secretB32 = start1b.body?.secret;
  a1.secret = base32Decode(a1.secretB32);
  assert((await call('POST', '/auth/mfa/enrol/confirm', { token: t1, body: { code: codeAt({ ...a1, secret: base32Decode(start1.body?.secret) } as Acct, T) } })).status === 400, 'a code from the replaced secret is refused');
  setClock(T);
  const wrong1 = await call('POST', '/auth/mfa/enrol/confirm', { token: t1, body: { code: badCode(a1) } });
  assert(wrong1.status === 400 && wrong1.body?.reason === 'invalid_code', 'confirming with a wrong code -> 400 invalid_code', wrong1.body);
  assert((await call('GET', '/auth/mfa', { token: t1 })).body?.enrolled === false, 'and nothing is enrolled yet');
  const noStart = await mk('nostart@mfa.mil');
  const noStartTok: string = (await login(noStart.email)).body?.token;
  assert((await call('POST', '/auth/mfa/enrol/confirm', { token: noStartTok, body: { code: '123456' } })).body?.reason === 'mfa_not_started', 'confirm before start -> 409 mfa_not_started');
  assert((await call('POST', '/auth/mfa/enrol/confirm', { token: t1, body: {} })).status === 400, 'confirm without a code -> 400');
  const ok1 = await call('POST', '/auth/mfa/enrol/confirm', { token: t1, body: { code: codeAt(a1, T) } });
  a1.recovery = ok1.body?.recoveryCodes ?? [];
  assert(ok1.status === 200 && a1.recovery.length === 8 && a1.recovery.every((c) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(c)), 'the right code confirms it and returns 8 recovery codes (XXXXX-XXXXX)', ok1.body);
  assert(ok1.headers.get('cache-control') === 'no-store', 'confirm is no-store too');
  const st1 = await call('GET', '/auth/mfa', { token: t1 });
  assert(st1.body?.enrolled === true && st1.body?.recoveryCodesRemaining === 8 && st1.body?.required === false && st1.body?.mode === 'off', 'GET /auth/mfa -> enrolled, 8 codes left, not required, mode off', st1.body);
  assert((await call('POST', '/auth/mfa/enrol/start', { token: t1 })).body?.reason === 'mfa_already_enrolled', 'start again -> 409 mfa_already_enrolled');
  assert((await call('POST', '/auth/mfa/enrol/confirm', { token: t1, body: { code: codeAt(a1, T) } })).status === 409, 'confirm again -> 409');

  const a2 = await mk('pending2@mfa.mil');
  const t2: string = (await login(a2.email)).body?.token;
  await call('POST', '/auth/mfa/enrol/start', { token: t2 });
  const l2 = await login(a2.email);
  assert(l2.status === 200 && typeof l2.body?.token === 'string' && l2.body?.mfa === undefined, 'M2: an unconfirmed enrolment does not gate login (a session, no mfa step)', l2.body);

  // ------------------------------------------------------------------------------------------------------------ M3
  console.log('\n--- M3: two-step login ---');
  await reset();
  const a3 = await mk('two3@mfa.mil');
  await enrol(a3);
  const lastBefore3 = (await findLocalUserByEmail(a3.email))?.lastLoginAt?.getTime();
  const l3 = await login(a3.email);
  assert(l3.status === 200 && l3.body?.mfa === 'verify' && typeof l3.body?.mfaToken === 'string' && !('token' in (l3.body ?? {})), 'password step -> { mfa: "verify", mfaToken } and no session token', l3.body);
  assert(Array.isArray(l3.body?.methods) && l3.body.methods.includes('totp') && l3.body.methods.includes('recovery_code') && typeof l3.body?.expiresAt === 'string', 'with the accepted methods and an expiry');
  assert(l3.headers.get('cache-control') === 'no-store', 'and no-store');
  assert((await findLocalUserByEmail(a3.email))?.lastLoginAt?.getTime() === lastBefore3, 'step one alone does not record a successful login');
  const v3 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l3.body?.mfaToken, code: fresh(a3) } });
  assert(v3.status === 200 && typeof v3.body?.token === 'string' && v3.body?.mfaEnrolled === true && v3.body?.mustChangePassword === false, 'verify with the code (clock +30 s) -> a session carrying mfaEnrolled and mustChangePassword', v3.body);
  const c3 = verifyLocalToken(v3.body?.token);
  assert(JSON.stringify(c3.amr) === JSON.stringify(['pwd', 'otp']) && c3.ver === 0, 'the session records amr [pwd, otp] and the token version');
  assert((await call('GET', '/auth/me', { token: v3.body?.token })).status === 200, 'and works on /auth/me');
  assert((await findLocalUserByEmail(a3.email))?.lastLoginAt !== null, 'the completed login is recorded');
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: l3.body?.mfaToken } })).status === 400, 'verify without a code -> 400');
  assert((await call('POST', '/auth/mfa/verify', { body: { code: '123456' } })).status === 400, 'verify without a token -> 400');
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: 'x', code: '123456', recoveryCode: 'ABCDE-FGHJK' } })).status === 400, 'sending both a code and a recovery code -> 400');

  // ------------------------------------------------------------------------------------------------------------ M4
  console.log('\n--- M4: clock drift of one step ---');
  const T2 = T + (a3.k + 10) * STEP;
  a3.k += 10;
  setClock(T2);
  const l4a = await login(a3.email);
  const v4a = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l4a.body?.mfaToken, code: codeAt(a3, T2 - STEP) } });
  assert(v4a.status === 200, 'a code one step in the past is accepted', v4a.status);
  const l4b = await login(a3.email);
  const v4b = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l4b.body?.mfaToken, code: codeAt(a3, T2 - 2 * STEP) } });
  assert(v4b.status === 401 && v4b.body?.reason === 'invalid_code', 'two steps in the past -> 401 invalid_code', v4b.body);
  const v4c = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l4b.body?.mfaToken, code: codeAt(a3, T2 + 2 * STEP) } });
  assert(v4c.status === 401 && v4c.body?.reason === 'invalid_code', 'two steps in the future -> 401 invalid_code', v4c.body);
  const v4d = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l4b.body?.mfaToken, code: codeAt(a3, T2 + STEP) } });
  assert(v4d.status === 200, 'one step in the future is accepted, with the same token (failures do not burn it)', v4d.status);
  a3.k += 1;

  // ------------------------------------------------------------------------------------------------------------ M5
  console.log('\n--- M5: a code works once ---');
  await reset();
  const a5 = await mk('replay5@mfa.mil');
  await enrol(a5);
  const l5 = await login(a5.email);
  setClock(T);
  const r5 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l5.body?.mfaToken, code: codeAt(a5, T) } });
  assert(r5.status === 401 && r5.body?.reason === 'invalid_code', 'the code used to confirm the enrolment cannot be replayed at login', r5.body);
  const used = fresh(a5);
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: l5.body?.mfaToken, code: used } })).status === 200, 'the next step\'s code works');
  const l5b = await login(a5.email);
  const r5b = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l5b.body?.mfaToken, code: used } });
  assert(r5b.status === 401 && r5b.body?.reason === 'invalid_code', 'the same code for a second login in the same step -> 401', r5b.body);
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: l5b.body?.mfaToken, code: fresh(a5) } })).status === 200, 'and the following step\'s code -> 200');

  // ------------------------------------------------------------------------------------------------------------ M6, M7
  console.log('\n--- M6/M7: recovery codes are single use and stored hashed ---');
  await reset();
  const a6 = await mk('recov6@mfa.mil');
  await enrol(a6);
  const [c1, c2] = a6.recovery;
  const s6a = await signIn(a6, { recoveryCode: c1 });
  assert(s6a.step2?.status === 200 && s6a.step2?.body?.recoveryCodesRemaining === 7, 'a recovery code signs in and reports 7 remaining', s6a.step2?.body);
  const s6b = await signIn(a6, { recoveryCode: c1 });
  assert(s6b.step2?.status === 401 && s6b.step2?.body?.reason === 'invalid_code', 'the same recovery code again -> 401 invalid_code');
  const s6c = await signIn(a6, { recoveryCode: c2.toLowerCase().replace('-', '') });
  assert(s6c.step2?.status === 200 && s6c.step2?.body?.recoveryCodesRemaining === 6, 'a lower-case code without the hyphen is accepted (normalized): 6 remaining', s6c.step2?.body);
  assert((await call('GET', '/auth/mfa', { token: s6c.token })).body?.recoveryCodesRemaining === 6, 'GET /auth/mfa agrees');
  const a7 = await mk('hashed7@mfa.mil');
  await enrol(a7);
  const stored = await findLocalUserByEmail(a7.email);
  const dump = JSON.stringify(stored);
  assert(stored!.recoveryCodeHashes.length === 8 && stored!.recoveryCodeHashes.every((h) => /^[0-9a-f]{64}$/.test(h)), 'M7: the stored recovery digests are 8 hex HMACs');
  assert(a7.recovery.every((c) => !dump.includes(c) && !dump.includes(c.replace('-', ''))), 'no recovery code appears in the stored row');
  assert(!dump.includes(a7.secretB32) && /^v1\./.test(stored!.totpSecretEnc ?? ''), 'and the secret is stored encrypted, not as base32');

  // ------------------------------------------------------------------------------------------------------------ M8
  console.log('\n--- M8: second-factor failures count toward the lockout ---');
  await reset();
  const ma = await mk('lock8a@mfa.mil');
  await enrol(ma);
  const la = await login(ma.email);
  const failsA: number[] = [];
  for (let i = 0; i < 5; i++) failsA.push((await call('POST', '/auth/mfa/verify', { body: { mfaToken: la.body?.mfaToken, code: badCode(ma) } })).status);
  assert(failsA.every((s) => s === 401), '5 wrong codes are each refused (401)', failsA);
  const lockedA = await call('POST', '/auth/mfa/verify', { body: { mfaToken: la.body?.mfaToken, code: fresh(ma) } });
  assert(lockedA.status === 429 && Number(lockedA.headers.get('retry-after')) > 0, 'then even the right code gets 429 + Retry-After', lockedA.status);
  assert((await login(ma.email)).status === 429, 'and so does the password');

  const mb = await mk('lock8b@mfa.mil');
  await enrol(mb);
  await login(mb.email, 'wrong password entirely');
  await login(mb.email, 'wrong password entirely');
  const lb = await login(mb.email);
  assert(lb.body?.mfa === 'verify', '2 wrong passwords, then the right one -> the code step');
  for (let i = 0; i < 3; i++) await call('POST', '/auth/mfa/verify', { body: { mfaToken: lb.body?.mfaToken, code: badCode(mb) } });
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: lb.body?.mfaToken, code: fresh(mb) } })).status === 429, '2 password failures + 3 code failures lock the account');

  const mc = await mk('lock8c@mfa.mil');
  await enrol(mc);
  const lc1 = await login(mc.email);
  for (let i = 0; i < 3; i++) await call('POST', '/auth/mfa/verify', { body: { mfaToken: lc1.body?.mfaToken, code: badCode(mc) } });
  const lc2 = await login(mc.email);
  assert(lc2.body?.mfa === 'verify', '3 wrong codes, then a password login still reaches the code step');
  for (let i = 0; i < 2; i++) await call('POST', '/auth/mfa/verify', { body: { mfaToken: lc2.body?.mfaToken, code: badCode(mc) } });
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: lc2.body?.mfaToken, code: fresh(mc) } })).status === 429, 'a successful password step does not reset the counter: 2 more wrong codes lock it');

  // ------------------------------------------------------------------------------------------------------------ M9
  console.log('\n--- M9: per-IP throttle on the second step ---');
  __resetLoginThrottleForTests();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) statuses.push((await call('POST', '/auth/mfa/verify', { keepThrottle: true, body: { mfaToken: 'garbage', code: '123456' } })).status);
  assert(statuses.slice(0, 20).every((s) => s === 401) && statuses[20] === 429, '21 attempts from one address: the 21st is throttled (429)', statuses);
  __resetLoginThrottleForTests();

  // ------------------------------------------------------------------------------------------------------------ M10
  console.log('\n--- M10: secrets, codes and tokens are never logged ---');
  await reset();
  const captured: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const sent: string[] = [];
  const tokens: string[] = [];
  const a10 = await mk('logs10@mfa.mil');
  try {
    for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = (...args: unknown[]) => void captured.push(util.format(...args));
    await enrol(a10);
    const l10 = await login(a10.email);
    tokens.push(l10.body?.mfaToken);
    const good = fresh(a10);
    sent.push(good, badCode(a10));
    const bad10 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l10.body?.mfaToken, code: badCode(a10) } });
    const ok10 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l10.body?.mfaToken, code: good } });
    tokens.push(ok10.body?.token);
    const rec10 = await signIn(a10, { recoveryCode: a10.recovery[0] });
    tokens.push(rec10.step1.body?.mfaToken, rec10.token as string);
    const rcCode = fresh(a10);
    sent.push(rcCode);
    const regen10 = await call('POST', '/auth/mfa/recovery-codes', { token: rec10.token, body: { code: rcCode } });
    a10.recovery.push(...(regen10.body?.recoveryCodes ?? []));
    const pc = fresh(a10);
    sent.push(pc);
    const change = await call('POST', '/auth/password', { token: rec10.token, body: { currentPassword: PW, newPassword: NEWPW, code: pc } });
    tokens.push(change.body?.token);
    sent.push(codeAt(a10, T));
    assert(bad10.status === 401 && ok10.status === 200 && regen10.status === 200 && change.status === 200, 'the flow under capture behaves normally (failed verify, verify, recovery code, regeneration, password change)', [bad10.status, ok10.status, regen10.status, change.status]);
  } finally {
    Object.assign(console, original);
  }
  const log = captured.join('\n');
  const uri = buildOtpauthUri({ issuer: 'PBC-GRC', accountName: a10.email, secretBase32: a10.secretB32 });
  assert(captured.length > 0, 'the server did log during the flow');
  assert(!log.toLowerCase().includes(a10.email) && captured.some((l) => l.includes('Local login') && l.includes(accountLogRef(a10.email))), 'H12b: successful sign-ins log the pseudonymous account reference, never the email');
  assert(!log.includes(a10.secretB32) && !log.includes(uri) && !log.includes('otpauth://'), 'the base32 secret and the otpauth URI are not in the log');
  assert(sent.every((c) => !log.includes(c)), 'no code that was sent is in the log');
  assert(a10.recovery.every((c) => !log.includes(c) && !log.includes(c.replace('-', ''))), 'no recovery code is in the log');
  assert(tokens.filter(Boolean).every((t) => !log.includes(t)), 'no pending or session token is in the log');
  assert(!log.includes(PW) && !log.includes(NEWPW), 'no password is in the log');

  const staticFiles = [
    'server/auth/totp.ts',
    'server/auth/mfaCrypto.ts',
    'server/auth/mfaEnforcement.ts',
    'server/auth/localUsers.ts',
    'server/auth/localAuth.ts',
    'server/routes/auth.ts',
    'server/routes/platformUsers.ts',
    'server/routes/setup.ts',
    'server/middleware/authMiddleware.ts',
    'server/auth/session.ts',
    'scripts/resetLocalUserMfa.ts',
    'scripts/createLocalUser.ts',
  ];
  const banned = /\b(secret|secretBase32|otpauthUri|uri|recoveryCodes?|code|mfaToken|password|newPassword|currentPassword)\b/i;
  const offending = staticFiles.flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((line, i) => ({ f, n: i + 1, line }))
      .filter((x) => x.line.includes('console.') && banned.test(x.line))
      .map((x) => `${x.f}:${x.n}`)
  );
  assert(offending.length === 0, 'static scan: no console call in the auth, MFA, route and script files names a secret, code, token or password', offending);

  // ------------------------------------------------------------------------------------------------------------ M11
  console.log('\n--- M11: step two is unreachable without step one ---');
  await reset();
  const a11 = await mk('gate11@mfa.mil');
  const pre11 = await enrol(a11); // a session from before the enrolment
  const u11 = await mk('plain11@mfa.mil');
  const invalidAt = async (token: string, label: string) => {
    const r = await call('POST', '/auth/mfa/verify', { body: { mfaToken: token, code: fresh(a11) } });
    assert(r.status === 401 && r.body?.reason === 'mfa_token_invalid', label, r.body);
  };
  await invalidAt(signMfaPendingToken({ id: a11.id, tokenVersion: 0 }, 'verify', { env: { LOCAL_AUTH_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv }).token, 'a token signed with another secret -> 401 mfa_token_invalid');
  await invalidAt(signMfaPendingToken({ id: a11.id, tokenVersion: 0 }, 'verify', { now: nowSec() - 1000 }).token, 'an expired token -> 401 mfa_token_invalid');
  await invalidAt(pre11, 'a session token passed as the mfaToken -> 401 mfa_token_invalid');
  await invalidAt('not-a-token', 'a random string -> 401 mfa_token_invalid');
  await invalidAt(signMfaPendingToken({ id: a11.id, tokenVersion: 0 }, 'enrol').token, 'an enrol-stage token at verify -> 401 mfa_token_invalid');
  const wrongStage = await call('POST', '/auth/mfa/enrol/start', { body: { mfaToken: signMfaPendingToken({ id: u11.id, tokenVersion: 0 }, 'verify').token } });
  assert(wrongStage.status === 401 && wrongStage.body?.reason === 'mfa_token_invalid', 'a verify-stage token at enrol/start -> 401 mfa_token_invalid', wrongStage.body);
  const pend = (await login(a11.email)).body?.mfaToken as string;
  const viaHeader = [
    (await call('POST', '/auth/mfa/enrol/start', { token: pend })).status,
    (await call('GET', '/auth/me', { token: pend })).status,
    (await call('GET', '/tenants', { token: pend })).status,
    (await call('GET', '/controls', { token: pend, tenant: 'tenant-mfa-none' })).status,
  ];
  assert(viaHeader.every((s) => s === 401), 'a pending token in the Authorization header is refused everywhere (enrol/start, /auth/me, /tenants, /controls)', viaHeader);
  const jtiLogin = await login(a11.email);
  assert((await call('POST', '/auth/mfa/verify', { body: { mfaToken: jtiLogin.body?.mfaToken, code: fresh(a11) } })).status === 200, 'a fresh pending token verifies once');
  await invalidAt(jtiLogin.body?.mfaToken, 'and a second use of the same token (jti) -> 401 mfa_token_invalid');
  const v11 = await mk('ver11@mfa.mil');
  await enrol(v11);
  const lv = await login(v11.email);
  await clearLocalUserMfa(v11.id); // bumps token_version
  const verMismatch = await call('POST', '/auth/mfa/verify', { body: { mfaToken: lv.body?.mfaToken, code: fresh(v11) } });
  assert(verMismatch.status === 401 && verMismatch.body?.reason === 'mfa_token_invalid', 'a token issued before a version bump -> 401 mfa_token_invalid', verMismatch.body);

  // ------------------------------------------------------------------------------------------------------------ M12, M13, M17, M18, M19 (admin)
  console.log('\n--- M12: an admin reset revokes the factor and requires a new credential ---');
  await reset();
  const { adm, token: admTok } = await admin();
  const a12 = await mk('reset12@mfa.mil');
  const s12 = await enrol(a12);
  const sOtp12 = (await signIn(a12)).token as string;
  const reset12 = await adminAct(adm, admTok, `/platform/users/${a12.id}/reset-password`, { newPassword: TEMPPW });
  assert(reset12.status === 200 && reset12.body?.mustChangePassword === true && /change/i.test(reset12.body?.message ?? ''), 'the admin reset -> 200 and says the person must change the temporary credential', reset12.body);
  const list12 = await call('GET', '/platform/users', { token: admTok });
  const row12 = list12.body?.users?.find((u: any) => u.id === a12.id);
  assert(row12?.mfaEnrolled === false && row12?.mustChangePassword === true, 'GET /platform/users shows mfaEnrolled false', row12);
  assert((await call('GET', '/auth/me', { token: s12 })).status === 401 && (await call('GET', '/auth/me', { token: sOtp12 })).status === 401, 'every earlier session is 401');
  assert((await login(a12.email, PW)).status === 401, 'the old credential no longer works');
  const after12 = await login(a12.email, TEMPPW);
  assert(after12.status === 200 && typeof after12.body?.token === 'string' && after12.body?.mfaEnrolled === false && after12.body?.mustChangePassword === true, 'mode off: the temporary credential gives a session flagged mustChangePassword, with no factor', after12.body);
  const b12 = await mk('reset12b@mfa.mil');
  await enrol(b12);
  await adminAct(adm, admTok, `/platform/users/${b12.id}/reset-password`, { newPassword: TEMPPW });
  setMode('all');
  assert((await login(b12.email, TEMPPW)).body?.mfa === 'enrol', 'mode all: the same login now asks to enrol again');
  setMode('off');

  console.log('\n--- M13: disabling revokes the factor ---');
  const a13 = await mk('disable13@mfa.mil');
  await enrol(a13);
  const s13 = (await signIn(a13)).token as string;
  const dis13 = await adminAct(adm, admTok, `/platform/users/${a13.id}/disable`);
  assert(dis13.status === 200 && dis13.body?.user?.disabled === true, 'disable -> 200');
  const me13 = await call('GET', '/auth/me', { token: s13 });
  assert(me13.status === 401, 'their session is 401 at once');
  assert(me13.body?.reason === 'session_revoked', 'A33-8: and the reason is session_revoked', me13.body);
  const en13 = await adminAct(adm, admTok, `/platform/users/${a13.id}/enable`);
  assert(en13.status === 200 && en13.body?.user?.disabled === false && en13.body?.user?.mfaEnrolled === false, 'enable -> 200, and the factor is gone', en13.body);
  const l13 = await login(a13.email);
  assert(l13.status === 200 && typeof l13.body?.token === 'string' && l13.body?.mfa === undefined && l13.body?.mfaEnrolled === false, 'mode off: login gives a session with no MFA step');
  assert((await call('GET', '/auth/me', { token: s13 })).status === 401, 'and the session from before the disable stays dead after enabling');

  console.log('\n--- M17: a disabled account cannot complete either step ---');
  const a17 = await mk('disable17@mfa.mil');
  await enrol(a17);
  const pending17 = (await login(a17.email)).body?.mfaToken as string;
  await adminAct(adm, admTok, `/platform/users/${a17.id}/disable`);
  const dead17 = await login(a17.email);
  const wrong17 = await login(a13.email, 'definitely the wrong one');
  assert(dead17.status === 401 && dead17.text === wrong17.text, 'step one for a disabled account is byte-identical to a wrong-password answer', [dead17.text, wrong17.text]);
  const late17 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: pending17, code: fresh(a17) } });
  assert(late17.status === 401, 'a pending token taken before the disable is refused with a valid code', late17.body);

  console.log('\n--- M18: sessions issued before a reset or disable are rejected afterwards ---');
  const a18 = await mk('revoke18@mfa.mil');
  const s18 = (await login(a18.email)).body?.token as string;
  assert((await call('GET', '/tenants', { token: s18 })).status === 200, 'a session works');
  await adminAct(adm, admTok, `/platform/users/${a18.id}/reset-password`, { newPassword: TEMPPW });
  assert((await call('GET', '/auth/me', { token: s18 })).status === 401 && (await call('GET', '/tenants', { token: s18 })).status === 401, 'after an admin reset: /auth/me and /tenants -> 401');
  assert((await call('GET', '/auth/me', { token: s18 })).body?.reason === 'session_revoked', 'A33-9: after an admin reset the reason is session_revoked');
  const b18 = await mk('revoke18b@mfa.mil');
  const sb18 = (await login(b18.email)).body?.token as string;
  await adminAct(adm, admTok, `/platform/users/${b18.id}/disable`);
  assert((await call('GET', '/auth/me', { token: sb18 })).status === 401, 'after a disable -> 401');
  await adminAct(adm, admTok, `/platform/users/${b18.id}/enable`);
  assert((await call('GET', '/auth/me', { token: sb18 })).status === 401, 'and still 401 after enabling');
  const c18 = await mk('revoke18c@mfa.mil');
  const sc18a = (await login(c18.email)).body?.token as string;
  const sc18b = (await login(c18.email)).body?.token as string;
  const changed18 = await call('POST', '/auth/password', { token: sc18a, body: { currentPassword: PW, newPassword: NEWPW } });
  assert(changed18.status === 200 && (await call('GET', '/auth/me', { token: sc18b })).status === 401 && (await call('GET', '/auth/me', { token: changed18.body?.token })).status === 200, 'after the person changes their own credential: other sessions 401, the new one works');
  assert((await call('GET', '/auth/me', { token: sc18b })).body?.reason === 'session_revoked', 'A33-10: another session after a self password change has reason session_revoked');
  const d18 = await mk('revoke18d@mfa.mil');
  await enrol(d18);
  const sd18 = (await signIn(d18)).token as string;
  await resetLocalUserMfa(d18.email);
  assert((await call('GET', '/auth/me', { token: sd18 })).status === 401, 'after resetLocalUserMfa (the CLI path) -> 401');

  console.log('\n--- M19: only a platform administrator may manage accounts ---');
  const u19 = await mk('plain19@mfa.mil');
  const t19 = (await login(u19.email)).body?.token as string;
  const t19Target = await mk('target19@mfa.mil');
  const denied = [
    (await call('GET', '/platform/users', { token: t19 })).status,
    (await call('POST', `/platform/users/${t19Target.id}/reset-password`, { token: t19, body: { newPassword: TEMPPW } })).status,
    (await call('POST', `/platform/users/${t19Target.id}/disable`, { token: t19 })).status,
    (await call('POST', `/platform/users/${t19Target.id}/enable`, { token: t19 })).status,
    (await call('POST', `/platform/users/${t19Target.id}/reset-mfa`, { token: t19 })).status,
  ];
  assert(denied.every((s) => s === 403), 'a non-admin gets 403 on all five endpoints', denied);
  const selfs = [
    await call('POST', `/platform/users/${adm.id}/disable`, { token: admTok }),
    await call('POST', `/platform/users/${adm.id}/reset-password`, { token: admTok, body: { newPassword: TEMPPW } }),
    await call('POST', `/platform/users/${adm.id}/reset-mfa`, { token: admTok }),
  ];
  assert(selfs.every((r) => r.status === 409 && r.body?.reason === 'self'), 'an admin acting on themselves -> 409 self (disable, reset-password, reset-mfa)', selfs.map((r) => r.status));
  assert((await call('POST', '/platform/users/lu_nonexistent_id/disable', { token: admTok })).status === 404, 'an unknown id -> 404');
  assert((await call('POST', `/platform/users/${t19Target.id}/reset-password`, { token: admTok, body: { newPassword: 'short' } })).body?.reason === 'weak_password', 'a weak temporary credential -> 400 weak_password');
  const listed = (await call('GET', '/platform/users', { token: admTok })).body?.users ?? [];
  const leakKey = /hash|secret|totp|recovery/i;
  assert(listed.length > 0 && listed.every((u: any) => !Object.keys(u).some((k) => leakKey.test(k))), 'no listed user carries a hash, secret, totp or recovery field');
  const resetBody = (await adminAct(adm, admTok, `/platform/users/${t19Target.id}/reset-password`, { newPassword: TEMPPW })).body;
  assert(!Object.keys(resetBody?.user ?? {}).some((k) => leakKey.test(k)) && !JSON.stringify(resetBody).includes(TEMPPW), 'nor does an action response, and it does not echo the credential');

  // ------------------------------------------------------------------------------------------------------------ M26
  console.log('\n--- M26: regenerating the recovery codes ---');
  const a26 = await mk('regen26@mfa.mil');
  await enrol(a26);
  const oldCodes = [...a26.recovery];
  const s26 = (await signIn(a26)).token as string;
  const regen = (body: Record<string, unknown>) => call('POST', '/auth/mfa/recovery-codes', { token: s26, body });
  assert((await regen({})).status === 400, 'no code -> 400');
  setClock(T);
  const replayed26 = await regen({ code: codeAt(a26, T) });
  assert(replayed26.status === 403 && replayed26.body?.reason === 'invalid_code', 'a replayed code -> 403 invalid_code', replayed26.body);
  const ok26 = await regen({ code: fresh(a26) });
  const newCodes: string[] = ok26.body?.recoveryCodes ?? [];
  assert(ok26.status === 200 && newCodes.length === 8 && ok26.body?.recoveryCodesRemaining === 8 && ok26.headers.get('cache-control') === 'no-store', 'a fresh code -> 200 with 8 new recovery codes (no-store)', ok26.body);
  assert(newCodes.every((c) => !oldCodes.includes(c)), 'and they are new');
  const old26 = await signIn(a26, { recoveryCode: oldCodes[0] });
  assert(old26.step2?.status === 401, 'an old recovery code at verify -> 401');
  const new26 = await signIn(a26, { recoveryCode: newCodes[0] });
  assert(new26.step2?.status === 200 && new26.step2?.body?.recoveryCodesRemaining === 7, 'a new recovery code -> 200 (7 left)', new26.step2?.body);
  assert((await call('GET', '/auth/mfa', { token: new26.token })).body?.recoveryCodesRemaining === 7, 'GET /auth/mfa -> recoveryCodesRemaining 7');
  const plain26 = await mk('regen26b@mfa.mil');
  const pt26 = (await login(plain26.email)).body?.token as string;
  assert((await call('POST', '/auth/mfa/recovery-codes', { token: pt26, body: { code: '123456' } })).body?.reason === 'mfa_not_enrolled', 'an account with no factor -> 409 mfa_not_enrolled');
  const mc26 = await mk('regen26c@mfa.mil', { mustChangePassword: true });
  const mct26 = (await login(mc26.email)).body?.token as string;
  assert((await call('POST', '/auth/mfa/recovery-codes', { token: mct26, body: { code: '123456' } })).body?.reason === 'password_change_required', 'a session flagged mustChangePassword -> 403 password_change_required');

  // ------------------------------------------------------------------------------------------------------------ M27
  console.log('\n--- M27: admin reset-mfa ---');
  const a27 = await mk('resetmfa27@mfa.mil');
  await enrol(a27);
  const s27 = (await signIn(a27)).token as string;
  const r27 = await adminAct(adm, admTok, `/platform/users/${a27.id}/reset-mfa`);
  assert(r27.status === 200 && r27.body?.user?.mfaEnrolled === false, 'reset-mfa -> 200, mfaEnrolled false', r27.body);
  assert((await call('GET', '/auth/me', { token: s27 })).status === 401, 'the prior session is 401');
  const l27 = await login(a27.email);
  assert(l27.status === 200 && typeof l27.body?.token === 'string' && l27.body?.mfa === undefined, 'mode off: login gives a session with no MFA step');
  assert((await call('POST', `/platform/users/${a27.id}/reset-mfa`, { token: t19 })).status === 403, 'a non-admin -> 403');

  // ------------------------------------------------------------------------------------------------------------ M29
  console.log('\n--- M29: administrator step-up (#38) ---');
  await reset();
  const { adm: adm29, token: admTok29 } = await admin();
  const T29 = await mk('step29@mfa.mil');
  const act29 = (action: string, body: Record<string, unknown> = {}, who: { id?: string; tok?: string } = {}) =>
    call('POST', `/platform/users/${who.id ?? T29.id}/${action}`, { token: who.tok ?? admTok29, body });
  const disabled29 = async () => (await findLocalUserByEmail(T29.email))?.disabled;
  const swallow: string[] = [];
  const original29 = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture29 = (on: boolean) => {
    for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = on ? (...args: unknown[]) => void swallow.push(util.format(...args)) : original29[key];
  };
  const sent29: string[] = [];

  const s1_38 = await act29('disable');
  assert(s1_38.status === 400 && s1_38.body?.reason === 'code_required' && (await disabled29()) === false, 'S38-1: disabling an account without a code -> 400 code_required, and the target is untouched', s1_38.body);
  const bad29 = badCode(adm29);
  sent29.push(bad29);
  capture29(true);
  let s2_38;
  try {
    s2_38 = await act29('disable', { code: bad29 });
  } finally {
    capture29(false);
  }
  assert(s2_38.status === 403 && s2_38.body?.reason === 'invalid_code' && (await disabled29()) === false, 'S38-2: a wrong code -> 403 invalid_code, and the target stays enabled', s2_38.body);
  const c3_38 = fresh(adm29);
  const s3a_38 = await act29('disable', { code: c3_38 });
  const s3b_38 = await act29('enable', { code: c3_38 });
  assert(s3a_38.status === 200 && s3b_38.status === 403 && s3b_38.body?.reason === 'invalid_code' && (await disabled29()) === true, 'S38-3: a code works once: the same code on the next action -> 403 invalid_code, and the target stays disabled', [s3a_38.status, s3b_38.status]);

  const k4_38 = adm29.k;
  capture29(true);
  let s4_38: Array<{ status: number }>;
  try {
    s4_38 = [
      await adminAct(adm29, admTok29, `/platform/users/${T29.id}/enable`),
      await adminAct(adm29, admTok29, `/platform/users/${T29.id}/reset-password`, { newPassword: TEMPPW }),
      await adminAct(adm29, admTok29, `/platform/users/${T29.id}/reset-mfa`),
      await adminAct(adm29, admTok29, `/platform/users/${T29.id}/disable`),
    ];
  } finally {
    capture29(false);
  }
  for (let k = k4_38 + 1; k <= adm29.k; k++) sent29.push(codeAt(adm29, T + k * STEP));
  assert(s4_38.every((r) => r.status === 200), 'S38-4: with a fresh code each, enable, reset-password, reset-mfa and disable all succeed (200)', s4_38.map((r) => r.status));

  const c5_38 = fresh(adm29);
  const s5a_38 = await act29('reset-password', { newPassword: 'short', code: c5_38 });
  const s5b_38 = await act29('reset-password', { newPassword: TEMPPW, code: c5_38 });
  assert(s5a_38.status === 400 && s5a_38.body?.reason === 'weak_password' && s5b_38.status === 200, 'S38-5: a rejected new value does not spend the code (400 weak_password, then the same code -> 200)', [s5a_38.status, s5b_38.status]);
  const c6_38 = fresh(adm29);
  const s6a_38 = await act29('reset-password', { newPassword: TEMPPW, code: c6_38 }, { id: adm29.id });
  const s6b_38 = await act29('enable', { code: c6_38 });
  assert(s6a_38.status === 409 && s6a_38.body?.reason === 'self' && s6b_38.status === 200, 'S38-6: acting on yourself is 409 self before the step-up, so the code is not spent', [s6a_38.status, s6b_38.status]);

  const adm2 = await mk('admin29b@mfa.mil');
  await addPlatformAdmin({ userId: adm2.id, email: adm2.email });
  const tok2 = (await login(adm2.email)).body?.token as string;
  const s7_38: number[] = [];
  const r7_38: unknown[] = [];
  for (const mode of ['off', 'all', 'privileged']) {
    setMode(mode);
    const r = await act29('disable', { code: '123456' }, { tok: tok2 });
    s7_38.push(r.status);
    r7_38.push(r.body?.reason);
  }
  setMode('off');
  assert(s7_38.every((s) => s === 409) && r7_38.every((r) => r === 'mfa_not_enrolled') && (await disabled29()) === false, 'S38-7: an administrator with no second factor of their own -> 409 mfa_not_enrolled in every MFA_REQUIRED mode, target untouched', [s7_38, r7_38]);

  const s8a_38 = await act29('disable', { recoveryCode: adm29.recovery[0] });
  const s8b_38 = await act29('disable', { code: adm29.recovery[0] });
  const s8c_38 = await signIn(adm29, { recoveryCode: adm29.recovery[0] });
  assert(
    s8a_38.status === 400 && s8a_38.body?.reason === 'code_required' && s8b_38.status === 403 && s8b_38.body?.reason === 'invalid_code' && s8c_38.step2?.status === 200,
    'S38-8: a recovery code is never a step-up (no code -> 400; as the code -> 403) and is not consumed by it (it still signs in)',
    [s8a_38.status, s8b_38.status, s8c_38.step2?.status]
  );

  const swallowed = swallow.join('\n');
  const stepLines = swallow.filter((l) => l.includes('Step-up'));
  assert(
    sent29.every((c) => !swallowed.includes(c)) && stepLines.length > 0 && stepLines.every((l) => !l.includes(adm29.email)) && swallowed.includes('Step-up refused'),
    'S38-9: the server logged the refusal ("Step-up refused"), with no code that was sent and no address on that line',
    stepLines
  );

  const u29 = await mk('plain29@mfa.mil');
  await enrol(u29);
  const uTok = (await signIn(u29)).token as string;
  assert((await act29('disable', { code: fresh(u29) }, { tok: uTok })).status === 403, 'S38-10: a non-administrator with a valid code of their own -> 403');

  const adm3 = await mk('admin29c@mfa.mil');
  await addPlatformAdmin({ userId: adm3.id, email: adm3.email });
  await enrol(adm3);
  const tok3 = (await signIn(adm3)).token as string;
  const s11_38: Array<{ status: number; body: Record<string, any> | null }> = [];
  for (let i = 0; i < 5; i++) s11_38.push(await act29('disable', { code: badCode(adm3) }, { tok: tok3 }));
  const s11last_38 = await act29('disable', { code: fresh(adm3) }, { tok: tok3 });
  assert(s11_38.every((r) => r.status === 403 && r.body?.reason === 'invalid_code') && s11last_38.status === 429, 'S38-11: five wrong codes lock the administrator: each -> 403 invalid_code, then even a right code -> 429', [s11_38.map((r) => r.status), s11last_38.status]);

  const puSrc = fs.readFileSync('server/routes/platformUsers.ts', 'utf8').replace(/\r\n/g, '\n');
  const blocks = puSrc.split('router.post(').slice(1);
  const ordered = (block: string, mutation: string, validation?: string): boolean => {
    const resolve = block.indexOf('resolveTarget(');
    const step = block.indexOf('requireAdminStepUp(');
    const mutate = block.indexOf(mutation);
    return resolve >= 0 && step > resolve && mutate > step && (validation === undefined || (block.indexOf(validation) > resolve && block.indexOf(validation) < step));
  };
  assert(
    blocks.length === 4 &&
      ordered(blocks[0], 'setLocalUserPassword(', 'validateNewPassword(') && ordered(blocks[1], 'clearLocalUserMfa(') &&
      ordered(blocks[2], 'setLocalUserDisabled(') && ordered(blocks[3], 'setLocalUserDisabled('),
    'S38-12: static: every platform-user mutation resolves the target (and validates the new value) before the step-up, and the step-up comes before the mutation'
  );

  // ------------------------------------------------------------------------------------------------------------ M14
  console.log('\n--- M14: enforcement modes ---');
  await reset();
  process.env.PLATFORM_ADMIN_EMAILS = 'pc@mfa.mil';
  try {
    const { adm: adm14 } = await admin();
    void adm14;
    const O = await mk('owner14@mfa.mil');
    await createTenantWithOwner(
      { id: 'tenant-mfa-a', name: 'A Org', systemName: 'A Enclave', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
      { userId: O.id, email: O.email, name: 'Owner' }
    );
    const X = await mk('both14@mfa.mil');
    await createTenantWithOwner(
      { id: 'tenant-mfa-b', name: 'B Org', systemName: 'B Enclave', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
      { userId: X.id, email: X.email, name: 'Both' }
    );
    await upsertTenantMember('tenant-mfa-a', { userId: X.id, email: X.email, name: 'Both', role: 'ASSESSOR' });
    const member = async (email: string, role: 'VIEWER' | 'MSP_ADMIN') => {
      const a = await mk(email);
      await upsertTenantMember('tenant-mfa-a', { userId: a.id, email, name: email, role });
      return a;
    };
    const V = await member('viewer14@mfa.mil', 'VIEWER');
    const M = await member('msp14@mfa.mil', 'MSP_ADMIN');
    const E = await member('enrolled14@mfa.mil', 'VIEWER');
    await enrol(E);
    const P = await mk('stored14@mfa.mil');
    await addPlatformAdmin({ userId: P.id, email: P.email });
    const Pc = await mk('pc@mfa.mil');
    const L = await mk('loner14@mfa.mil');
    const users: Record<string, Acct> = { V, O, M, P, Pc, L, X, E };
    const expected: Record<string, Record<string, string>> = {
      off: { V: 'session', O: 'session', M: 'session', P: 'session', Pc: 'session', L: 'session', X: 'session', E: 'verify' },
      all: { V: 'enrol', O: 'enrol', M: 'enrol', P: 'enrol', Pc: 'enrol', L: 'enrol', X: 'enrol', E: 'verify' },
      privileged: { V: 'session', O: 'enrol', M: 'enrol', P: 'enrol', Pc: 'enrol', L: 'session', X: 'enrol', E: 'verify' },
    };
    for (const mode of ['off', 'all', 'privileged']) {
      setMode(mode);
      const got: Record<string, string> = {};
      for (const [name, acct] of Object.entries(users)) got[name] = outcome(await login(acct.email));
      assert(JSON.stringify(got) === JSON.stringify(expected[mode]), `MFA_REQUIRED=${mode}: viewer, owner, MSP admin, stored admin, configured admin, no-tenant user, mixed roles, enrolled user`, got);
    }
    setMode('yes');
    assert((await login(V.email)).status === 503, 'MFA_REQUIRED=yes (invalid) -> login 503, never a session');
    setMode('Privileged ');
    assert(outcome(await login(O.email)) === 'enrol', 'the value is trimmed and case-insensitive');
    setMode('');
    assert(outcome(await login(V.email)) === 'enrol', 'blank means the default (all)');
  } finally {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    setMode('off');
  }

  // ------------------------------------------------------------------------------------------------------------ M15
  console.log('\n--- M15: required but not enrolled -> the account can only enrol ---');
  await reset();
  const a15 = await mk('must15@mfa.mil');
  setMode('all');
  const l15 = await login(a15.email);
  assert(l15.body?.mfa === 'enrol' && !('token' in (l15.body ?? {})), 'login -> { mfa: "enrol", mfaToken }, no session', l15.body);
  const tok15: string = l15.body?.mfaToken;
  const blocked15 = [
    (await call('GET', '/auth/me', { token: tok15 })).status,
    (await call('GET', '/tenants', { token: tok15 })).status,
    (await call('POST', '/auth/password', { token: tok15, body: { currentPassword: PW, newPassword: NEWPW } })).status,
    (await call('POST', '/auth/mfa/verify', { body: { mfaToken: tok15, code: '123456' } })).status,
  ];
  assert(blocked15.every((s) => s === 401), 'the enrol token is refused on /auth/me, /tenants, /auth/password and /auth/mfa/verify', blocked15);
  const e15 = await enrolWith(a15, { mfaToken: tok15 });
  assert(e15.start.status === 200 && e15.confirm.status === 200 && typeof e15.confirm.body?.token === 'string' && e15.confirm.body?.recoveryCodes?.length === 8, 'enrol/start and enrol/confirm with that token -> a session and the recovery codes', e15.confirm.body);
  assert(e15.confirm.body?.mfaEnrolled === true && e15.confirm.body?.mustChangePassword === false, 'carrying mfaEnrolled and mustChangePassword');
  assert((await call('GET', '/tenants', { token: e15.confirm.body?.token })).status === 200, 'the session works');
  assert((await call('POST', '/auth/mfa/enrol/confirm', { body: { mfaToken: tok15, code: fresh(a15) } })).status === 401, 'and the enrol token is spent');
  const st15 = await call('GET', '/auth/mfa', { token: e15.confirm.body?.token });
  assert(st15.body?.required === true && st15.body?.mode === 'all', 'GET /auth/mfa reports required and the mode');
  setMode('off');

  // ------------------------------------------------------------------------------------------------------------ M16
  console.log('\n--- M16: changing the password needs the current password and a fresh code ---');
  await reset();
  const e16 = await mk('chg16@mfa.mil');
  await enrol(e16);
  const S16 = (await signIn(e16)).token as string;
  const pwc = (token: string, body: Record<string, unknown>) => call('POST', '/auth/password', { token, body });
  const r16a = await pwc(S16, { currentPassword: PW, newPassword: NEWPW });
  assert(r16a.status === 400 && r16a.body?.reason === 'code_required', 'an enrolled account without a code -> 400 code_required', r16a.body);
  const r16b = await pwc(S16, { currentPassword: 'not the current one', newPassword: NEWPW, code: fresh(e16) });
  assert(r16b.status === 403 && r16b.body?.reason === 'invalid_current_password', 'a wrong current password -> 403 invalid_current_password', r16b.body);
  const r16c = await pwc(S16, { currentPassword: PW, newPassword: NEWPW, code: badCode(e16) });
  assert(r16c.status === 403 && r16c.body?.reason === 'invalid_code', 'right password, wrong code -> 403 invalid_code', r16c.body);
  const r16d = await pwc(S16, { currentPassword: PW, newPassword: 'short', code: fresh(e16) });
  assert(r16d.status === 400 && r16d.body?.reason === 'weak_password', 'a weak new password -> 400 weak_password', r16d.body);
  setClock(T);
  const r16e = await pwc(S16, { currentPassword: PW, newPassword: NEWPW, code: codeAt(e16, T) });
  assert(r16e.status === 403 && r16e.body?.reason === 'invalid_code', 'a replayed code -> 403', r16e.body);
  const r16f = await pwc(S16, { currentPassword: PW, newPassword: NEWPW, code: fresh(e16) });
  assert(r16f.status === 200 && typeof r16f.body?.token === 'string' && r16f.body?.mustChangePassword === false && r16f.body?.mfaEnrolled === true, 'the right password, a fresh code and a good new value -> 200 and a new session', r16f.body);
  assert((await call('GET', '/auth/me', { token: S16 })).status === 401, 'the old session -> 401');
  assert((await call('GET', '/auth/me', { token: r16f.body?.token })).status === 200 && verifyLocalToken(r16f.body?.token).amr?.includes('otp') === true, 'the new session works and records the code (amr includes otp)');
  e16.pw = NEWPW;
  assert((await login(e16.email, NEWPW)).body?.mfa === 'verify', 'the new password -> the code step');
  assert((await login(e16.email, PW)).status === 401, 'the old password -> 401');
  const u16 = await mk('plain16@mfa.mil');
  const ut16 = (await login(u16.email)).body?.token as string;
  const ur16 = await pwc(ut16, { currentPassword: PW, newPassword: NEWPW });
  assert(ur16.status === 200 && ur16.body?.mfaEnrolled === false, 'an account with no factor changes it with the passwords alone');
  const w16 = await mk('lock16@mfa.mil');
  const wt16 = (await login(w16.email)).body?.token as string;
  const wrongs: number[] = [];
  for (let i = 0; i < 5; i++) wrongs.push((await pwc(wt16, { currentPassword: 'wrong wrong wrong ' + i, newPassword: NEWPW })).status);
  const locked16 = await pwc(wt16, { currentPassword: PW, newPassword: NEWPW });
  assert(wrongs.every((s) => s === 403) && locked16.status === 429 && Number(locked16.headers.get('retry-after')) > 0, '5 wrong current passwords lock the account (429 + Retry-After)', [wrongs, locked16.status]);

  // ------------------------------------------------------------------------------------------------------------ M20
  console.log('\n--- M20: the CLI reset ---');
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/resetLocalUserMfa.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DB_MODE: 'memory' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const noArgs = cli([]);
  assert(noArgs.status === 2 && /Usage/.test(noArgs.stderr), 'no email -> exit 2 with a usage message', { status: noArgs.status, err: noArgs.stderr.slice(0, 200) });
  const mem = cli(['ann@x.mil']);
  assert(mem.status === 1 && /DB_MODE=memory/.test(mem.stderr), 'under DB_MODE=memory -> exit 1 and says why', { status: mem.status, err: mem.stderr.slice(0, 200) });
  await reset();
  const a20 = await mk('cli20@mfa.mil');
  await enrol(a20);
  const s20 = (await signIn(a20)).token as string;
  const res20 = await resetLocalUserMfa(a20.email);
  assert(res20.found && res20.hadFactor, 'the reset reports that a factor existed');
  assert((await call('GET', '/auth/me', { token: s20 })).status === 401, 'the prior session is 401');
  const l20 = await login(a20.email);
  assert(l20.status === 200 && typeof l20.body?.token === 'string', 'and the next login (mode off) is a session');
  assert(!(await resetLocalUserMfa('nobody@mfa.mil')).found, 'an unknown email is reported as not found');
  const createSrc = fs.readFileSync('scripts/createLocalUser.ts', 'utf8');
  assert(/mustChangePassword:\s*true/.test(createSrc), 'the create-user script hands out a temporary credential (mustChangePassword: true)');

  // ------------------------------------------------------------------------------------------------------------ M21
  console.log('\n--- M21: registering with an invitation ---');
  await reset();
  const owner21 = await mk('owner21@mfa.mil');
  await createTenantWithOwner(
    { id: 'tenant-mfa-21', name: 'Org 21', systemName: 'Enclave 21', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: owner21.id, email: owner21.email, name: 'Owner' }
  );
  const invite = async (email: string, role: 'ASSESSOR' | 'TENANT_OWNER') =>
    (await createInvitation('tenant-mfa-21', { email, role, createdBy: owner21.email, createdByUserId: owner21.id, expiresInDays: 14 })).token;
  const register = (token: string, name: string) => call('POST', '/auth/register-with-invite', { body: { token, password: PW, name } });
  setMode('all');
  const inv1 = await invite('new21a@mfa.mil', 'ASSESSOR');
  const reg1 = await register(inv1, 'New A');
  assert(reg1.status === 201 && reg1.body?.mfa === 'enrol' && typeof reg1.body?.mfaToken === 'string' && !('token' in (reg1.body ?? {})) && reg1.body?.tenantId === 'tenant-mfa-21' && reg1.body?.role === 'ASSESSOR', 'mode all: 201 { mfa: "enrol", mfaToken, tenantId, role } and no session', reg1.body);
  assert((await call('POST', '/invites/preview', { body: { token: inv1 } })).body?.invitation?.status === 'ACCEPTED', 'the invitation is consumed');
  const n21 = { email: 'new21a@mfa.mil', id: '', pw: PW, secret: null, secretB32: '', recovery: [], k: 0 } as Acct;
  const conf1 = await enrolWith(n21, { mfaToken: reg1.body?.mfaToken });
  assert(conf1.confirm.status === 200 && typeof conf1.confirm.body?.token === 'string', 'enrolling with that token gives a session');
  assert((await call('GET', '/controls', { token: conf1.confirm.body?.token, tenant: 'tenant-mfa-21' })).status === 200, 'which can read the tenant');
  setMode('privileged');
  const reg2 = await register(await invite('new21b@mfa.mil', 'ASSESSOR'), 'New B');
  assert(reg2.status === 201 && typeof reg2.body?.token === 'string' && reg2.body?.mfa === undefined && reg2.body?.mfaEnrolled === false, 'privileged + an ASSESSOR invitation: a session straight away', reg2.body);
  const reg3 = await register(await invite('new21c@mfa.mil', 'TENANT_OWNER'), 'New C');
  assert(reg3.status === 201 && reg3.body?.mfa === 'enrol' && reg3.body?.role === 'TENANT_OWNER', 'privileged + a TENANT_OWNER invitation: enrol first', reg3.body);
  setMode('off');

  // ------------------------------------------------------------------------------------------------------------ M30
  console.log('\n--- M30: platform-admin addresses and invitations (go-live H1) ---');
  await reset();
  const owner30 = await mk('owner30@mfa.mil');
  await createTenantWithOwner(
    { id: 'tenant-mfa-30', name: 'Org 30', systemName: 'Enclave 30', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: owner30.id, email: owner30.email, name: 'Owner' }
  );
  const tok30: string = (await login(owner30.email)).body?.token;
  const inviteVia = (email: string) => call('POST', '/tenants/tenant-mfa-30/invites', { token: tok30, tenant: 'tenant-mfa-30', body: { email, role: 'VIEWER' } });
  const savedAdmins = process.env.PLATFORM_ADMIN_EMAILS;
  try {
    process.env.PLATFORM_ADMIN_EMAILS = 'pa-target@mfa.mil';
    const h1 = await inviteVia('pa-target@mfa.mil');
    assert(h1.status === 403 && h1.body?.reason === 'platform_admin_email' && h1.body?.token === undefined, 'H1-1: a tenant owner cannot invite a listed platform-administrator address', h1.body);
    const h2 = await inviteVia('PA-Target@MFA.mil');
    assert(h2.status === 403 && h2.body?.reason === 'platform_admin_email', 'H1-2: the match ignores case', h2.body);

    delete process.env.PLATFORM_ADMIN_EMAILS;
    const later = await inviteVia('pa-later@mfa.mil');
    assert(later.status === 201 && typeof later.body?.token === 'string', 'H1-3: (setup) the invitation is created while the address is not listed', later.body);
    process.env.PLATFORM_ADMIN_EMAILS = 'pa-later@mfa.mil';
    const regLater = await call('POST', '/auth/register-with-invite', { body: { token: later.body?.token, password: PW, name: 'Later' } });
    assert(regLater.status === 403 && regLater.body?.reason === 'platform_admin_account' && regLater.body?.token === undefined, 'H1-3: registering with that token once the address is listed -> 403 platform_admin_account', regLater.body);
    assert((await login('pa-later@mfa.mil')).status === 401, 'H1-3: and no account was created (login 401)');
    assert((await call('POST', '/invites/preview', { body: { token: later.body?.token } })).body?.invitation?.status === 'PENDING', 'H1-3: the invitation was not consumed');

    process.env.PLATFORM_ADMIN_EMAILS = 'pa-target@mfa.mil';
    const ctl = await inviteVia('other@mfa.mil');
    const regCtl = await call('POST', '/auth/register-with-invite', { body: { token: ctl.body?.token, password: PW, name: 'Other' } });
    assert(ctl.status === 201 && regCtl.status === 201, 'H1-4: control: an unlisted address is invited (201) and registers (201)', [ctl.status, regCtl.status]);

    delete process.env.PLATFORM_ADMIN_EMAILS;
    const plain = await inviteVia('patch30@mfa.mil');
    process.env.PLATFORM_ADMIN_EMAILS = 'pa-target@mfa.mil';
    const patched = await call('PATCH', `/tenants/tenant-mfa-30/invites/${plain.body?.invitation?.id}`, { token: tok30, tenant: 'tenant-mfa-30', body: { email: 'pa-target@mfa.mil' } });
    assert(plain.status === 201 && patched.status === 403 && patched.body?.reason === 'platform_admin_email', 'H1-5: editing an invitation to a listed address -> 403 platform_admin_email', [plain.status, patched.status, patched.body]);
  } finally {
    if (savedAdmins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = savedAdmins;
    setMode('off');
  }

  // ------------------------------------------------------------------------------------------------------------ M22, M23
  console.log('\n--- M22/M23: tokens for unknown accounts and tokens from before the upgrade ---');
  const ghost = signLocalToken({ id: 'lu_ghost', email: 'ghost@mfa.mil', name: 'Ghost' }).token;
  assert((await call('GET', '/auth/me', { token: ghost })).status === 401, 'a validly signed token for an id with no account -> 401');
  const real = await mk('real23@mfa.mil');
  const old = signLocalToken({ id: real.id, email: real.email, name: 'Real' }).token; // no tokenVersion: no `ver` claim
  assert(verifyLocalToken(old).ver === undefined && (await call('GET', '/auth/me', { token: old })).status === 200, 'a pre-upgrade token (no ver) for a real version-0 user -> 200');
  const wrongVer = signLocalToken({ id: real.id, email: real.email, name: 'Real', tokenVersion: 5 }).token;
  assert((await call('GET', '/auth/me', { token: wrongVer })).status === 401, 'a token with the wrong version -> 401');

  // ------------------------------------------------------------------------------------------------------------ M24
  console.log('\n--- M24: an unreadable stored factor fails closed ---');
  const a24 = await mk('unreadable24@mfa.mil');
  await enrol(a24);
  const savedSecret = process.env.LOCAL_AUTH_SECRET;
  process.env.LOCAL_AUTH_SECRET = 'a-different-signing-secret-of-forty-characters-xx';
  try {
    const l24 = await login(a24.email);
    assert(l24.body?.mfa === 'verify', 'the password step still works');
    const v24 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: l24.body?.mfaToken, code: fresh(a24) } });
    assert(v24.status === 503 && v24.body?.reason === 'mfa_unavailable' && !('token' in (v24.body ?? {})), 'a valid code cannot be checked -> 503 mfa_unavailable and no session', v24.body);
  } finally {
    process.env.LOCAL_AUTH_SECRET = savedSecret;
  }
  assert((await signIn(a24)).token !== undefined, 'with the secret restored the same account signs in again');

  // ------------------------------------------------------------------------------------------------------------ M25
  console.log('\n--- M25: a forced password change leaves exactly one request open ---');
  await reset();
  const { adm: adm25, token: admTok25 } = await admin();
  const f25 = await mk('forced25@mfa.mil', { mustChangePassword: true });
  const lf = await login(f25.email);
  assert(lf.status === 200 && typeof lf.body?.token === 'string' && lf.body?.mustChangePassword === true, 'a CLI-style account logs in with mustChangePassword: true', lf.body);
  const gate = [
    await call('GET', '/auth/me', { token: lf.body?.token }),
    await call('GET', '/tenants', { token: lf.body?.token }),
    await call('POST', '/auth/mfa/enrol/start', { token: lf.body?.token }),
  ];
  assert(gate.every((r) => r.status === 403 && r.body?.reason === 'password_change_required'), '/auth/me, /tenants and enrol/start -> 403 password_change_required', gate.map((r) => [r.status, r.body?.reason]));
  assert((await call('POST', '/auth/password', { token: lf.body?.token, body: { currentPassword: PW, newPassword: 'short' } })).status === 400, 'a weak new value on the open request -> 400');
  const fixed = await call('POST', '/auth/password', { token: lf.body?.token, body: { currentPassword: PW, newPassword: NEWPW } });
  assert(fixed.status === 200 && fixed.body?.mustChangePassword === false && typeof fixed.body?.token === 'string', 'the right current password -> 200 and a new session with mustChangePassword: false', fixed.body);
  assert((await call('GET', '/auth/me', { token: lf.body?.token })).status === 401, 'the old session -> 401');
  assert((await call('GET', '/auth/me', { token: fixed.body?.token })).status === 200, 'the new session works on /auth/me');

  const g25 = await mk('hand25@mfa.mil');
  await enrol(g25);
  await adminAct(adm25, admTok25, `/platform/users/${g25.id}/reset-password`, { newPassword: TEMPPW });
  const lg = await login(g25.email, TEMPPW);
  assert(lg.status === 200 && lg.body?.mustChangePassword === true && lg.body?.mfaEnrolled === false, 'after an admin reset (mode off): a session with mustChangePassword true and no factor', lg.body);

  const h25 = await mk('hand25b@mfa.mil');
  await enrol(h25);
  await adminAct(adm25, admTok25, `/platform/users/${h25.id}/reset-password`, { newPassword: TEMPPW });
  setMode('all');
  const lh = await login(h25.email, TEMPPW);
  assert(lh.body?.mfa === 'enrol', 'mode all: the temporary credential leads to enrolment');
  const eh = await enrolWith(h25, { mfaToken: lh.body?.mfaToken });
  assert(eh.confirm.status === 200 && eh.confirm.body?.mustChangePassword === true, 'the session after confirming still has mustChangePassword: true', eh.confirm.body);
  const gateH = [
    (await call('GET', '/auth/me', { token: eh.confirm.body?.token })).status,
    (await call('GET', '/tenants', { token: eh.confirm.body?.token })).status,
    (await call('GET', '/auth/mfa', { token: eh.confirm.body?.token })).status,
  ];
  assert(gateH.every((s) => s === 403), 'and only /auth/password is open to it', gateH);
  const doneH = await call('POST', '/auth/password', { token: eh.confirm.body?.token, body: { currentPassword: TEMPPW, newPassword: NEWPW, code: fresh(h25) } });
  assert(doneH.status === 200 && doneH.body?.mustChangePassword === false, 'changing it (with the current credential and a code) clears the flag', doneH.body);
  assert((await call('GET', '/tenants', { token: doneH.body?.token })).status === 200, 'and the new session is a normal one');
  setMode('off');

  // ------------------------------------------------------------------------------------------------------------ M28
  console.log('\n--- M28: the startup warning ---');
  const indexSrc = fs.readFileSync('server/index.ts', 'utf8');
  assert(/authStartupWarnings\(\)/.test(indexSrc) && /console\.warn\('\[Startup\] ' \+ w\)/.test(indexSrc), 'server/index.ts logs authStartupWarnings() through console.warn');

  // ------------------------------------------------------------------------------------------------------------ the secret never came back
  console.log('\n--- No response other than enrol/start carried a secret ---');
  const leaks = bodies.filter((b) => [...allSecrets].some((s) => b.text.includes(s))).map((b) => b.path);
  assert(allSecrets.size > 10 && leaks.length === 0, 'across every response in this suite, the base32 secret appears only in enrol/start', leaks);

  process.env.MFA_ENCRYPTION_KEY = savedMfaKey ?? '';
  setClock(null);
  setMode('off');
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
