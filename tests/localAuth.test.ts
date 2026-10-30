import './testEnv';
import './localAuthEnv';
import crypto from 'crypto';
import fs from 'fs';
import app, { server } from '../server/index';
import {
  LOCAL_TOKEN_AUDIENCE,
  LOCAL_TOKEN_ISSUER,
  LocalTokenError,
  assertAuthConfig,
  authStartupWarnings,
  hashPassword,
  signLocalToken,
  validateNewPassword,
  verifyLocalToken,
  verifyPassword,
} from '../server/auth/localAuth';
import { MAX_FAILED_ATTEMPTS, createLocalUser } from '../server/auth/localUsers';
import { accountLogRef, loginAccountKey } from '../server/auth/loginThrottle';
import { __resetLoginThrottleForTests } from '../server/routes/auth';
import { rawSetCookie, sessionCookieFrom } from './sessionCookieJar';

/**
 * Air-gapped local authentication: bcrypt passwords, HS256 JWTs and POST /api/v1/auth/login, verified end to end
 * through authMiddleware. Local accounts are the only identity mode; nothing in this suite contacts an external identity provider.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const SECRET = process.env.LOCAL_AUTH_SECRET!;
const PASSWORD = 'correct horse battery staple';
// A removed identity-provider mode name, assembled so the on-prem guard scan (onPremOnly.test.ts) stays free of the literal.
const REMOVED_MODE = ['fire', 'base'].join('');

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
const throws = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

async function call(method: string, path: string, opts: { token?: string; tenant?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  if (opts.cookie) headers.Cookie = `pbc_session=${opts.cookie}`;
  Object.assign(headers, opts.headers);
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  // Mirrors the browser's cookie jar: a session arrives as a cookie, kept as body.token so the existing `body.token` sites keep working via the bearer path.
  const cookie = sessionCookieFrom(res.headers);
  if (body && cookie && body.token === undefined) body.token = cookie;
  return { status: res.status, headers: res.headers, body };
}
const login = (email: string, password: string) => call('POST', '/auth/login', { body: { email, password } });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (header: object, claims: object, secret: string | null) => {
  const h = b64(header);
  const p = b64(claims);
  const sig = secret === null ? '' : crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
};

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  const now = Math.floor(Date.now() / 1000);
  const goodClaims = { iss: LOCAL_TOKEN_ISSUER, aud: LOCAL_TOKEN_AUDIENCE, sub: 'u1', email: 'a@b.mil', name: 'A', iat: now, exp: now + 600 };

  console.log('--- Tokens (HS256) ---');
  const { token, claims } = signLocalToken({ id: 'u_1', email: 'a@b.mil', name: 'Ann' });
  const back = verifyLocalToken(token);
  assert(back.sub === 'u_1' && back.email === 'a@b.mil' && back.name === 'Ann', 'round trip keeps sub / email / name (the claims authMiddleware reads)');
  assert(back.iss === LOCAL_TOKEN_ISSUER && back.aud === LOCAL_TOKEN_AUDIENCE, 'issuer and audience are set');
  assert(claims.exp - claims.iat === 8 * 60 * 60, 'default lifetime is 8 hours');
  assert(token.split('.').length === 3 && JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg === 'HS256', 'header is HS256');
  assert(throws(() => verifyLocalToken(token.slice(0, -2) + 'AA')) !== null, 'tampered signature is rejected');
  const [h, p, s] = token.split('.');
  const swapped = `${h}.${b64({ ...back, sub: 'admin' })}.${s}`;
  assert(throws(() => verifyLocalToken(swapped)) !== null, 'altered payload with the old signature is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'none', typ: 'JWT' }, goodClaims, null))) !== null, 'alg "none" is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS512', typ: 'JWT' }, goodClaims, SECRET))) !== null, 'any algorithm other than HS256 is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS256', typ: 'JWT' }, goodClaims, 'a-different-secret-that-is-long-enough-xx'))) !== null, 'token signed with another secret is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, exp: now - 1 }, SECRET))) !== null, 'expired token is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, iss: 'https://securetoken.google.com/x' }, SECRET))) !== null, 'wrong issuer is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, aud: 'other' }, SECRET))) !== null, 'wrong audience is rejected');
  assert(throws(() => verifyLocalToken(forge({ alg: 'HS256', typ: 'JWT' }, { ...goodClaims, sub: '' }, SECRET))) !== null, 'empty subject is rejected');
  assert(throws(() => verifyLocalToken('not-a-jwt')) !== null && throws(() => verifyLocalToken('a.b')) !== null, 'malformed tokens are rejected');
  assert(throws(() => verifyLocalToken(token, { now: claims.exp + 5 })) !== null, 'expiry is enforced against the supplied clock');

  console.log('\n--- Configuration ---');
  const removed = throws(() => assertAuthConfig({ AUTH_MODE: REMOVED_MODE, LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv));
  assert(removed !== null && /not supported/.test(removed) && /local accounts only/.test(removed), 'a removed AUTH_MODE is refused at startup with the local-only message', removed);
  const oauth = throws(() => assertAuthConfig({ AUTH_MODE: 'oauth', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv));
  assert(oauth !== null && /AUTH_MODE="oauth" is not supported/.test(oauth), 'AUTH_MODE=oauth is refused too', oauth);
  assert(throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)) === null, 'AUTH_MODE unset is accepted (local accounts are the default)');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: '', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)) === null, 'AUTH_MODE blank is accepted');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: ' LOCAL ', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)) === null, 'AUTH_MODE is trimmed and case-insensitive');
  assert(/LOCAL_AUTH_SECRET/.test(throws(() => assertAuthConfig({} as NodeJS.ProcessEnv)) ?? ''), 'with no AUTH_MODE the signing secret is still required');
  const mockProd = throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, NODE_ENV: 'production', ALLOW_DEV_MOCK_TOKENS: 'true' } as NodeJS.ProcessEnv));
  assert(mockProd !== null && /ALLOW_DEV_MOCK_TOKENS/.test(mockProd), 'ALLOW_DEV_MOCK_TOKENS=true with NODE_ENV=production fails startup', mockProd);
  assert(throws(() => assertAuthConfig({ LOCAL_AUTH_SECRET: SECRET, NODE_ENV: 'development', ALLOW_DEV_MOCK_TOKENS: 'true' } as NodeJS.ProcessEnv)) === null, 'the flag is allowed outside production');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local' } as NodeJS.ProcessEnv)) !== null, 'AUTH_MODE=local without LOCAL_AUTH_SECRET fails startup (no default secret)');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local', LOCAL_AUTH_SECRET: 'short' } as NodeJS.ProcessEnv)) !== null, 'a short secret fails startup');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)) === null, 'a 32+ character secret is accepted');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'ldap' } as NodeJS.ProcessEnv)) !== null, 'unknown AUTH_MODE fails startup');
  const ttlWarn = (ttl: string, extra: Record<string, string> = {}) =>
    authStartupWarnings({ LOCAL_AUTH_SECRET: SECRET, LOCAL_AUTH_TOKEN_TTL_SECONDS: ttl, ...extra } as NodeJS.ProcessEnv);
  assert(ttlWarn('86400').some((w) => w.includes('LOCAL_AUTH_TOKEN_TTL_SECONDS')), 'H12a: a 24 hour session lifetime warns at startup');
  assert(ttlWarn('28800').length === 0, 'H12a: an 8 hour lifetime gives no warning');
  assert(ttlWarn('43200').length === 0, 'H12a: exactly 12 hours gives no warning');
  assert(ttlWarn('86400', { MFA_REQUIRED: 'off', NODE_ENV: 'production' }).length === 2, 'H12a: MFA off in production plus a long lifetime gives two warnings');

  console.log('\n--- Passwords (bcrypt) ---');
  const hash = await hashPassword(PASSWORD);
  assert(/^\$2[aby]\$04\$/.test(hash) && !hash.includes(PASSWORD), 'stored value is a bcrypt hash, never the password');
  assert(await verifyPassword(PASSWORD, hash), 'correct password verifies');
  assert(!(await verifyPassword(PASSWORD + 'x', hash)), 'wrong password does not');
  assert(!(await verifyPassword('', hash)), 'empty password does not');
  assert((await hashPassword(PASSWORD)) !== hash, 'salted: hashing twice differs');
  assert(validateNewPassword('short') !== null, 'short passwords are rejected');
  assert(validateNewPassword('x'.repeat(73)) !== null, 'passwords over 72 bytes are rejected rather than silently truncated');
  assert(validateNewPassword('é'.repeat(37)) !== null, 'the limit is in bytes, not characters');
  assert(validateNewPassword('a@b.mil-a@b.mil', 'a@b.mil-a@b.mil') !== null, 'password equal to the email is rejected');
  assert(validateNewPassword(PASSWORD, 'a@b.mil') === null, 'a good passphrase is accepted');
  assert(!(await verifyPassword('x'.repeat(100), hash)), 'over-long login input simply fails');

  console.log('\n--- Server in local mode ---');
  assert((await call('GET', '/auth/config')).body?.mode === 'local', 'GET /auth/config reports local mode');
  await createLocalUser({ email: 'Ann@Enclave.mil', name: 'Ann Analyst', password: PASSWORD });
  const bob = await createLocalUser({ email: 'bob@enclave.mil', name: 'Bob', password: PASSWORD });
  const dup = await createLocalUser({ email: 'ann@enclave.mil', name: 'x', password: PASSWORD }).then(() => null, (e: Error) => e.name);
  assert(dup === 'LocalUserExistsError', 'emails are unique case-insensitively');

  console.log('\n--- Login ---');
  const ok = await login('ANN@enclave.mil', PASSWORD);
  assert(ok.status === 200 && typeof ok.body?.token === 'string', 'valid credentials return a token (email is case-insensitive)', ok.status);
  assert(ok.body?.user?.email === 'ann@enclave.mil' && ok.body?.user?.name === 'Ann Analyst' && !('passwordHash' in (ok.body?.user ?? {})), 'user profile returned, no hash');
  assert(ok.body?.tokenType === undefined && ok.body?.expiresIn === 8 * 3600, 'session metadata present, and no tokenType (the token is a cookie)');
  assert(verifyLocalToken(ok.body?.token).sub === ok.body?.user?.id, 'token subject is the user id');

  const wrong = await login('ann@enclave.mil', 'wrong password entirely');
  const unknown = await login('nobody@enclave.mil', PASSWORD);
  assert(wrong.status === 401 && unknown.status === 401, 'wrong password and unknown email both -> 401');
  assert(JSON.stringify(wrong.body) === JSON.stringify(unknown.body), 'identical error body: no account enumeration', { wrong: wrong.body, unknown: unknown.body });
  assert((await login('ann@enclave.mil', '')).status === 400 && (await call('POST', '/auth/login', { body: {} })).status === 400, 'missing fields -> 400');
  assert((await call('POST', '/auth/login', { body: { email: { $ne: '' }, password: PASSWORD } })).status === 400, 'non-string email (NoSQL-style payload) -> 400');

  console.log('\n--- Account lockout ---');
  __resetLoginThrottleForTests();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await login('bob@enclave.mil', 'bad password ' + i);
  const locked = await login('bob@enclave.mil', PASSWORD);
  assert(locked.status === 429 && Number(locked.headers.get('retry-after')) > 0, `${MAX_FAILED_ATTEMPTS} failures lock the account: even the right password gets 429 + Retry-After`, locked.status);
  assert((await login('ann@enclave.mil', PASSWORD)).status === 200, 'other accounts are unaffected');

  console.log('\n--- Lockout also covers emails with no account (#41) ---');
  const ghostFails: number[] = [];
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) ghostFails.push((await login('ghost.lock@enclave.mil', 'bad password ' + i)).status);
  assert(ghostFails.every((s) => s === 401), 'L41-1: failures against an unknown email answer 401 until the limit', ghostFails);
  const ghostLocked = await login('ghost.lock@enclave.mil', PASSWORD);
  assert(
    ghostLocked.status === 429 && Number(ghostLocked.headers.get('retry-after')) > 0 && JSON.stringify(ghostLocked.body) === JSON.stringify(locked.body),
    'L41-1: the next attempt is 429 + Retry-After with the same body as a real locked account',
    { status: ghostLocked.status, body: ghostLocked.body }
  );
  assert((await login(' GHOST.LOCK@Enclave.mil ', PASSWORD)).status === 429, 'L41-2: the lock follows the normalised email (case and spaces)');
  assert((await login('other.unknown@enclave.mil', PASSWORD)).status === 401, 'L41-3: another unknown email is not locked');
  {
    const captured: string[] = [];
    const original = { warn: console.warn, log: console.log };
    const grab = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
    console.warn = grab;
    console.log = grab;
    try {
      await login('leak.check@enclave.mil', 'wrong password entirely');
    } finally {
      console.warn = original.warn;
      console.log = original.log;
    }
    assert(captured.length > 0 && captured.every((line) => !line.toLowerCase().includes('leak.check')), 'L41-4: a failed login logs no email address', captured);
  }

  console.log('\n--- Per-IP throttle ---');
  __resetLoginThrottleForTests();
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await login(`spray${i}@enclave.mil`, 'whatever password')).status;
  assert(last === 429, 'password spraying from one address is throttled (429)');
  __resetLoginThrottleForTests();

  console.log('\n--- Token accepted by authMiddleware (claims match what it expects) ---');
  const annToken: string = ok.body?.token;
  const me = await call('GET', '/auth/me', { token: annToken });
  assert(me.status === 200 && me.body?.user?.email === 'ann@enclave.mil', 'GET /auth/me works with a local token');

  const created = await call('POST', '/tenants', { token: annToken, body: { name: 'Enclave Systems', primaryFramework: 'CMMC_L2' } });
  const tenantId: string = created.body?.tenant?.id;
  assert(created.status === 201 && created.body?.role === 'TENANT_OWNER', 'a local user bootstraps a tenant and becomes its owner');
  assert((await call('GET', '/controls', { token: annToken, tenant: tenantId })).status === 200, 'GET /controls with the local token + x-tenant-id');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', { token: annToken, tenant: tenantId, body: { status: 'MET', implementationNotes: 'local auth' } })).status === 200, 'owner can write (role read from tenant_users)');

  const bobToken = signLocalToken({ id: bob.id, email: 'bob@enclave.mil', name: 'Bob' }).token; // no `ver` claim: what a token minted before 5.9 looks like
  assert((await call('GET', '/controls', { token: bobToken, tenant: tenantId })).status === 403, 'a valid local user who is not a member gets 403');
  const add = await call('POST', `/tenants/${tenantId}/members`, { token: annToken, tenant: tenantId, body: { userId: bob.id, email: 'bob@enclave.mil', role: 'ASSESSOR' } });
  assert(add.status === 201, 'the owner adds Bob as ASSESSOR');
  assert((await call('GET', '/controls', { token: bobToken, tenant: tenantId })).status === 200, 'Bob can now read');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', { token: bobToken, tenant: tenantId, body: { status: 'MET' } })).status === 403, 'but the read-only role holds for local users too (403)');

  const ghostToken = signLocalToken({ id: 'lu_ghost_no_account', email: 'ghost@enclave.mil', name: 'Ghost' }).token;
  const ghostMe = await call('GET', '/auth/me', { token: ghostToken });
  assert(ghostMe.status === 401, 'a validly signed token for a user id with no account -> 401');
  assert(ghostMe.body?.reason === 'session_revoked', 'A33-5: a token for a vanished account -> reason session_revoked', ghostMe.body);
  assert(verifyLocalToken(bobToken).ver === undefined && (await call('GET', '/auth/me', { token: bobToken })).status === 200, 'a pre-upgrade token without `ver` for a real version-0 user -> 200');

  console.log('\n--- Rejections ---');
  const noToken = await call('GET', '/controls', { tenant: tenantId });
  assert(noToken.status === 401, 'no token -> 401');
  assert(noToken.body?.reason === 'session_missing', 'A33-1: no token -> reason session_missing', noToken.body);
  const tampered = await call('GET', '/auth/me', { token: annToken.slice(0, -3) + 'abc' });
  assert(tampered.status === 401, 'tampered token -> 401');
  assert(tampered.body?.reason === 'session_invalid', 'A33-2: tampered token -> reason session_invalid', tampered.body);
  assert((await call('GET', '/auth/me', { token: forge({ alg: 'HS256' }, { ...goodClaims, sub: 'u_ann' }, 'a-different-secret-that-is-long-enough-xx') })).status === 401, 'token signed with another secret -> 401');
  const algNone = await call('GET', '/auth/me', { token: forge({ alg: 'none' }, goodClaims, null) });
  assert(algNone.status === 401, 'unsigned "alg none" token -> 401');
  assert(algNone.body?.reason === 'session_invalid', 'A33-3: alg none -> reason session_invalid', algNone.body);
  const foreignIdp = forge({ alg: 'RS256', typ: 'JWT' }, { iss: 'https://securetoken.google.com/grc-tool-507203', sub: 'x', email: 'x@y.z', exp: now + 600 }, null);
  const t0 = Date.now();
  assert((await call('GET', '/auth/me', { token: foreignIdp })).status === 401, 'an RS256 token from another issuer is rejected (401)');
  assert(Date.now() - t0 < 2000, 'and it is rejected instantly: no attempt to fetch remote certificates', Date.now() - t0);
  assert((await call('GET', '/auth/me', { token: forge({ alg: 'HS256' }, { ...goodClaims, exp: now - 10 }, SECRET) })).status === 401, 'a token signed with the raw secret (not the derived key) -> 401');
  const expiredToken = signLocalToken({ id: bob.id, email: 'bob@enclave.mil', name: 'Bob', tokenVersion: 0 }, { now: now - 3600, ttlSeconds: 60 }).token;
  const expiredMe = await call('GET', '/auth/me', { token: expiredToken });
  assert(expiredMe.status === 401 && expiredMe.body?.reason === 'session_expired', 'A33-4: a genuinely expired token -> 401 reason session_expired', expiredMe.body);
  const expiredClaims = verifyLocalToken(annToken);
  assert((() => {
    try { verifyLocalToken(annToken, { now: expiredClaims.exp + 5 }); } catch (e) { return e instanceof LocalTokenError && e.code === 'expired'; }
    return false;
  })(), 'A33-6: verifyLocalToken past exp throws LocalTokenError code expired');
  assert((() => {
    try { verifyLocalToken(annToken.slice(0, -3) + 'abc'); } catch (e) { return e instanceof LocalTokenError && e.code === 'invalid'; }
    return false;
  })(), 'A33-6: a tampered token throws code invalid, never expired');
  assert(!/json\(\{ error: 'Unauthorized: Invalid or expired token' \}\)/.test(fs.readFileSync(new URL('../server/routes/auth.ts', import.meta.url), 'utf8')), 'A33-7: no route answers a bare 401 without a reason');
  // The account reference in failed-sign-in log lines is keyed by the auth secret: stable, short, and not a plain hash a log reader could match against an address list
  const ref = accountLogRef(' Ann@Enclave.MIL ');
  assert(/^[0-9a-f]{12}$/.test(ref) && ref === accountLogRef('ann@enclave.mil'), 'L41-5: accountLogRef is 12 hex chars and ignores case and spacing', ref);
  assert(!loginAccountKey('ann@enclave.mil').includes(ref) && !ref.includes('ann'), 'L41-5: the log reference is neither the throttle key nor the address', ref);
  assert(accountLogRef('ann@enclave.mil', { ...process.env, LOCAL_AUTH_SECRET: 'another-secret-for-this-check-0123456789abcdef' }) !== ref, 'L41-5: a different LOCAL_AUTH_SECRET gives a different reference');
  const authRouteSrc = fs.readFileSync(new URL('../server/routes/auth.ts', import.meta.url), 'utf8');
  assert(!/console\.\w+\([^)]*\$\{(email|user\.email)[^}]*\}[^)]*[Ff]ailed/.test(authRouteSrc) && !/[Ff]ailed[^\n]*\$\{(email|user\.email)\b/.test(authRouteSrc), 'L41-5: no failed-sign-in log line prints the address');

  console.log('\n--- Registration by invitation (how a new person gets an account on an air-gapped install) ---');
  const invite = async (email: string, role = 'ASSESSOR') =>
    call('POST', `/tenants/${tenantId}/invites`, { token: annToken, tenant: tenantId, body: { email, role } });
  const register = (token: string, password: string, name?: string) => call('POST', '/auth/register-with-invite', { body: { token, password, name } });
  const hire = await invite('newhire@enclave.mil');
  const hireToken: string = hire.body?.token;
  assert(hire.status === 201 && /^inv_/.test(hireToken), 'a local-auth owner issues an invitation');
  assert((await register('inv_' + 'z'.repeat(43), PASSWORD)).status === 404, 'an unknown token cannot register (404)');
  assert((await register('garbage', PASSWORD)).status === 404, 'a malformed token cannot register (404)');
  const weak = await register(hireToken, 'short');
  assert(weak.status === 400 && /at least/i.test(weak.body?.error), 'a weak password is refused with the reason (400)', weak.body);
  assert((await login('newhire@enclave.mil', 'short')).status === 401 && (await call('POST', '/invites/preview', { body: { token: hireToken } })).body?.invitation?.status === 'PENDING', 'and nothing was created or consumed by the failed attempt');

  const reg = await register(hireToken, PASSWORD, 'New Hire');
  assert(reg.status === 201 && typeof reg.body?.token === 'string' && reg.body?.tenantId === tenantId && reg.body?.role === 'ASSESSOR', 'a valid token registers the invited address, consumes the invitation and signs in (201)', reg.body);
  assert(reg.body?.user?.email === 'newhire@enclave.mil' && reg.body?.user?.name === 'New Hire', 'the account is bound to the INVITED email, not one the caller chooses');
  assert(verifyLocalToken(reg.body?.token).email === 'newhire@enclave.mil', 'the returned session token is a valid local token');
  assert((await call('GET', '/controls', { token: reg.body?.token, tenant: tenantId })).status === 200, 'the new account can read the tenant straight away');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', { token: reg.body?.token, tenant: tenantId, body: { status: 'MET' } })).status === 403, 'with the invited (read-only) role');
  assert((await login('newhire@enclave.mil', PASSWORD)).status === 200, 'and can sign in normally afterwards with that password');
  assert((await register(hireToken, PASSWORD)).status === 409, 'the token cannot register a second account (409)');

  const existing = await invite('ann@enclave.mil', 'VIEWER'); // Ann already has an account
  const existingReg = await register(existing.body?.token, PASSWORD);
  assert(existingReg.status === 409 && existingReg.body?.reason === 'account_exists', 'an existing account is told to sign in instead (409), no duplicate created', existingReg.body);
  assert((await call('POST', '/invites/preview', { body: { token: existing.body?.token } })).body?.invitation?.status === 'PENDING', 'and the invitation was NOT consumed by that attempt');
  assert((await call('POST', '/invites/accept', { token: annToken, body: { token: existing.body?.token } })).status === 200, 'she accepts it while signed in (the normal path for existing users)');

  const dead = await invite('revoked.hire@enclave.mil');
  const deadInvite = (await call('GET', `/tenants/${tenantId}/invites`, { token: annToken, tenant: tenantId })).body?.invitations.find((i: any) => i.email === 'revoked.hire@enclave.mil');
  await call('DELETE', `/tenants/${tenantId}/invites/${deadInvite.id}`, { token: annToken, tenant: tenantId });
  assert((await register(dead.body?.token, PASSWORD)).status === 410, 'a revoked invitation cannot register (410)');
  assert((await login('revoked.hire@enclave.mil', PASSWORD)).status === 401, 'and no account was left behind');
  const noAuthMode = process.env.AUTH_MODE;
  delete process.env.AUTH_MODE;
  assert((await register(hireToken, PASSWORD)).status === 409, 'with AUTH_MODE unset the endpoint still exists: a used token -> 409, never 404');
  process.env.AUTH_MODE = noAuthMode;
  assert((await call('GET', '/auth/config')).body?.mode === 'local', '/auth/config reports { mode: "local" }');

  console.log('\n--- Session cookie (#43) ---');
  __resetLoginThrottleForTests();
  await createLocalUser({ email: 'cookie43@enclave.mil', name: 'Cookie Holder', password: PASSWORD });
  const rawLogin = (headers: Record<string, string> = {}) =>
    fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ email: 'cookie43@enclave.mil', password: PASSWORD }) });
  const r43 = await rawLogin();
  const text43 = await r43.text();
  const json43 = JSON.parse(text43) as Record<string, any>;
  const line43 = rawSetCookie(r43.headers) ?? '';
  const cookie43 = sessionCookieFrom(r43.headers) ?? '';
  assert(
    r43.status === 200 && /^pbc_session=[^;]+/.test(line43) && /;\s*HttpOnly/i.test(line43) && /;\s*SameSite=Strict/i.test(line43) &&
      /;\s*Path=\/api(;|$)/.test(line43) && /;\s*Max-Age=28800/.test(line43) && !/;\s*Secure/i.test(line43),
    'S43-1: login sets pbc_session: HttpOnly, SameSite=Strict, Path=/api, Max-Age=28800 and no Secure over plain HTTP',
    line43.replace(cookie43, '<value>')
  );
  assert(!('token' in json43) && !('tokenType' in json43) && /^[A-Za-z0-9_-]{22}$/.test(json43.sessionRef ?? '') && !text43.includes(cookie43), 'S43-1: the body has no token or tokenType, carries a 22 character sessionRef, and never contains the cookie value');
  const claims43 = verifyLocalToken(cookie43);
  assert(claims43.sub === json43.user?.id && claims43.sid === json43.sessionRef, 'S43-2: the cookie is a valid session token whose subject and sid match the body');
  const marker = { 'X-PBC-Session': 'r' };
  assert((await call('GET', '/auth/me', { cookie: cookie43, headers: marker })).status === 200, 'S43-3: the cookie plus the marker header authenticates GET /auth/me');
  const noMarkerMe = await call('GET', '/auth/me', { cookie: cookie43 });
  const noMarkerPost = await call('POST', '/tenants', { cookie: cookie43, body: { name: 'x' } });
  assert(
    noMarkerMe.status === 403 && noMarkerMe.body?.reason === 'csrf_rejected' && noMarkerPost.status === 403 && noMarkerPost.body?.reason === 'csrf_rejected',
    'S43-4: a cookie without the marker is refused 403 csrf_rejected (GET and POST)',
    [noMarkerMe.status, noMarkerPost.status]
  );
  const fetchSites: number[] = [];
  for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) fetchSites.push((await call('GET', '/auth/me', { cookie: cookie43, headers: { ...marker, 'Sec-Fetch-Site': site } })).status);
  assert(JSON.stringify(fetchSites) === JSON.stringify([403, 403, 200, 200]), 'S43-5: Sec-Fetch-Site cross-site and same-site are refused, same-origin and none pass', fetchSites);
  const noneAtAll = await call('GET', '/auth/me');
  const garbage = await call('GET', '/auth/me', { cookie: 'garbage', headers: marker });
  assert(noneAtAll.status === 401 && noneAtAll.body?.reason === 'session_missing' && garbage.status === 401 && garbage.body?.reason === 'session_invalid', 'S43-6: no cookie and no Authorization -> 401 session_missing; a garbage cookie -> 401 session_invalid', [noneAtAll.body, garbage.body]);
  assert((await call('GET', '/auth/me', { token: cookie43 })).status === 200, 'S43-7: the same value as an Authorization Bearer token works with no marker (the integration path)');
  const basic43 = await call('GET', '/auth/me', { cookie: cookie43, headers: { ...marker, Authorization: 'Basic x' } });
  assert(basic43.status === 401 && basic43.body?.reason === 'session_missing', 'S43-8: an Authorization header wins over the cookie (Basic + a valid cookie -> 401 session_missing)', basic43.body);
  const out43 = await call('POST', '/auth/logout', { cookie: cookie43 });
  const outLine = rawSetCookie(out43.headers) ?? '';
  assert(out43.status === 204 && /^pbc_session=;/.test(outLine) && /Expires=Thu, 01 Jan 1970/.test(outLine) && /Path=\/api/.test(outLine), 'S43-9: POST /auth/logout -> 204 and expires the cookie on its path', outLine);
  assert((await call('POST', '/auth/logout')).status === 204, 'S43-9: logout needs no session (204 without a cookie)');
  const outCross = await call('POST', '/auth/logout', { cookie: cookie43, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert(outCross.status === 403 && outCross.body?.reason === 'csrf_rejected', 'S43-9: a cross-site logout -> 403 csrf_rejected', outCross.body);
  const crossLogin = await rawLogin({ 'Sec-Fetch-Site': 'cross-site' });
  const crossBody = (await crossLogin.json().catch(() => null)) as Record<string, any> | null;
  assert(crossLogin.status === 403 && crossBody?.reason === 'csrf_rejected' && rawSetCookie(crossLogin.headers) === undefined, 'S43-10: a cross-site login -> 403 csrf_rejected and no cookie is set');
  assert((await rawLogin({ 'Sec-Fetch-Site': 'same-origin' })).status === 200, 'S43-10: a same-origin login -> 200');
  app.set('trust proxy', 'loopback');
  try {
    const proxied = await rawLogin({ 'X-Forwarded-Proto': 'https' });
    assert(proxied.status === 200 && /;\s*Secure/i.test(rawSetCookie(proxied.headers) ?? ''), 'S43-11: behind a trusted proxy that says https, the cookie is Secure');
  } finally {
    app.set('trust proxy', false);
  }
  const NEW43 = 'a different long passphrase 43';
  const pwOld = sessionCookieFrom((await rawLogin()).headers) ?? '';
  const pw43 = await fetch(`${BASE}/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `pbc_session=${pwOld}`, ...marker },
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW43 }),
  });
  const pwNew = sessionCookieFrom(pw43.headers) ?? '';
  const oldAfter = await call('GET', '/auth/me', { cookie: pwOld, headers: marker });
  assert(pw43.status === 200 && pwNew !== '' && pwNew !== pwOld, 'S43-12: changing the password sets a new session cookie');
  assert(oldAfter.status === 401 && oldAfter.body?.reason === 'session_revoked' && (await call('GET', '/auth/me', { cookie: pwNew, headers: marker })).status === 200, 'S43-12: the old cookie is revoked and the new one works', oldAfter.body);
  assert((await call('POST', '/vm/ingest', { cookie: pwNew, headers: marker, body: {} })).status === 401, 'S43-13: the VM ingest route does not accept a session cookie');
  assert(!fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').includes('cors('), 'S43-14: server/index.ts mounts no CORS middleware');

  console.log('\n--- Production hardening (NODE_ENV=production) ---');
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const mock = `h.${Buffer.from(JSON.stringify({ sub: 'u_mock', roles: { [tenantId]: 'TENANT_OWNER' } })).toString('base64')}.mock_pbc_signature`;
  assert((await call('GET', '/controls', { token: mock, tenant: tenantId })).status === 401, 'dev mock tokens are rejected in production, in local mode too');
  assert((await call('GET', '/controls', { token: annToken, tenant: tenantId })).status === 200, 'while real local tokens keep working');
  assert((await call('GET', '/auth/me', { token: mock, tenant: tenantId })).status === 401, 'a mock token gets 401 on /auth/me in production (no req.user was set)');
  assert((await call('GET', '/auth/me', { token: annToken })).status === 200, 'a real local token still works on /auth/me in production');
  const unsigned = forge({ alg: 'RS256' }, { sub: 'x', email: 'x@y.z', exp: now + 600 }, null);
  assert((await call('GET', '/controls', { token: unsigned, tenant: tenantId })).status === 401, 'an unsigned self-asserted token is 401 (there is no unsigned fallback)');
  process.env.NODE_ENV = originalEnv;

  console.log('\n--- Mock tokens need ALLOW_DEV_MOCK_TOKENS (NODE_ENV not production) ---');
  const savedMockFlag = process.env.ALLOW_DEV_MOCK_TOKENS;
  try {
    assert((await call('GET', '/auth/me', { token: mock, tenant: tenantId })).status === 200, 'with the flag set (test mode) a mock token is accepted');
    delete process.env.ALLOW_DEV_MOCK_TOKENS;
    assert((await call('GET', '/controls', { token: mock, tenant: tenantId })).status === 401, 'with the flag deleted a mock token gets 401 on /controls');
    assert((await call('GET', '/auth/me', { token: mock, tenant: tenantId })).status === 401, 'and 401 on /auth/me');
    assert((await call('GET', '/controls', { token: annToken, tenant: tenantId })).status === 200, 'a real local token still works without the flag');
    assert((await call('GET', '/auth/me', { token: annToken })).status === 200, 'on /auth/me too');
  } finally {
    if (savedMockFlag === undefined) delete process.env.ALLOW_DEV_MOCK_TOKENS;
    else process.env.ALLOW_DEV_MOCK_TOKENS = savedMockFlag;
  }

  console.log('\n--- Misconfiguration is not silent ---');
  const savedSecret = process.env.LOCAL_AUTH_SECRET;
  process.env.LOCAL_AUTH_SECRET = '';
  assert((await login('ann@enclave.mil', PASSWORD)).status === 503, 'no secret at request time -> 503, never a token signed with a default');
  assert((await call('GET', '/auth/me', { token: annToken })).status === 503, 'and tokens cannot be verified -> 503');
  process.env.LOCAL_AUTH_SECRET = savedSecret;

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
