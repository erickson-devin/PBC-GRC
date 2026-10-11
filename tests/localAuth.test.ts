import './testEnv';
import './localAuthEnv';
import crypto from 'crypto';
import { server } from '../server/index';
import {
  LOCAL_TOKEN_AUDIENCE,
  LOCAL_TOKEN_ISSUER,
  assertAuthConfig,
  hashPassword,
  signLocalToken,
  validateNewPassword,
  verifyLocalToken,
  verifyPassword,
} from '../server/auth/localAuth';
import { MAX_FAILED_ATTEMPTS, createLocalUser } from '../server/auth/localUsers';
import { __resetLoginThrottleForTests } from '../server/routes/auth';

/**
 * Air-gapped local authentication: bcrypt passwords, HS256 JWTs and POST /api/v1/auth/login, verified end to end
 * through authMiddleware with AUTH_MODE=local. Nothing in this suite (or in local mode) contacts Firebase / Google.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const SECRET = process.env.LOCAL_AUTH_SECRET!;
const PASSWORD = 'correct horse battery staple';

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

async function call(method: string, path: string, opts: { token?: string; tenant?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, any> | null };
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
  assert(assertAuthConfig({ AUTH_MODE: 'firebase' } as NodeJS.ProcessEnv) === undefined, 'firebase mode needs no local secret');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local' } as NodeJS.ProcessEnv)) !== null, 'AUTH_MODE=local without LOCAL_AUTH_SECRET fails startup (no default secret)');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local', LOCAL_AUTH_SECRET: 'short' } as NodeJS.ProcessEnv)) !== null, 'a short secret fails startup');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'local', LOCAL_AUTH_SECRET: SECRET } as NodeJS.ProcessEnv)) === null, 'a 32+ character secret is accepted');
  assert(throws(() => assertAuthConfig({ AUTH_MODE: 'ldap' } as NodeJS.ProcessEnv)) !== null, 'unknown AUTH_MODE fails startup');

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
  await createLocalUser({ email: 'bob@enclave.mil', name: 'Bob', password: PASSWORD });
  const dup = await createLocalUser({ email: 'ann@enclave.mil', name: 'x', password: PASSWORD }).then(() => null, (e: Error) => e.name);
  assert(dup === 'LocalUserExistsError', 'emails are unique case-insensitively');

  console.log('\n--- Login ---');
  const ok = await login('ANN@enclave.mil', PASSWORD);
  assert(ok.status === 200 && typeof ok.body?.token === 'string', 'valid credentials return a token (email is case-insensitive)', ok.status);
  assert(ok.body?.user?.email === 'ann@enclave.mil' && ok.body?.user?.name === 'Ann Analyst' && !('passwordHash' in (ok.body?.user ?? {})), 'user profile returned, no hash');
  assert(ok.body?.tokenType === 'Bearer' && ok.body?.expiresIn === 8 * 3600, 'token metadata present');
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

  const bobToken = signLocalToken({ id: 'lu_bob_not_member', email: 'bob@enclave.mil', name: 'Bob' }).token;
  assert((await call('GET', '/controls', { token: bobToken, tenant: tenantId })).status === 403, 'a valid local user who is not a member gets 403');
  const add = await call('POST', `/tenants/${tenantId}/members`, { token: annToken, tenant: tenantId, body: { userId: 'lu_bob_not_member', email: 'bob@enclave.mil', role: 'ASSESSOR' } });
  assert(add.status === 201, 'the owner adds Bob as ASSESSOR');
  assert((await call('GET', '/controls', { token: bobToken, tenant: tenantId })).status === 200, 'Bob can now read');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', { token: bobToken, tenant: tenantId, body: { status: 'MET' } })).status === 403, 'but the read-only role holds for local users too (403)');

  console.log('\n--- Rejections ---');
  assert((await call('GET', '/controls', { tenant: tenantId })).status === 401, 'no token -> 401');
  assert((await call('GET', '/auth/me', { token: annToken.slice(0, -3) + 'abc' })).status === 401, 'tampered token -> 401');
  assert((await call('GET', '/auth/me', { token: forge({ alg: 'HS256' }, { ...goodClaims, sub: 'u_ann' }, 'a-different-secret-that-is-long-enough-xx') })).status === 401, 'token signed with another secret -> 401');
  assert((await call('GET', '/auth/me', { token: forge({ alg: 'none' }, goodClaims, null) })).status === 401, 'unsigned "alg none" token -> 401');
  const firebaseish = forge({ alg: 'RS256', typ: 'JWT' }, { iss: 'https://securetoken.google.com/grc-tool-507203', sub: 'x', email: 'x@y.z', exp: now + 600 }, null);
  const t0 = Date.now();
  assert((await call('GET', '/auth/me', { token: firebaseish })).status === 401, 'a Firebase-style token is NOT honoured in local mode');
  assert(Date.now() - t0 < 2000, 'and it is rejected instantly: no attempt to reach Google for certificates', Date.now() - t0);
  assert((await call('GET', '/auth/me', { token: forge({ alg: 'HS256' }, { ...goodClaims, exp: now - 10 }, SECRET) })).status === 401, 'expired local token -> 401');

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
  process.env.AUTH_MODE = 'firebase';
  assert((await register(hireToken, PASSWORD)).status === 404, 'outside local mode the endpoint does not exist (404)');
  process.env.AUTH_MODE = noAuthMode;

  console.log('\n--- Production hardening (NODE_ENV=production) ---');
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const mock = `h.${Buffer.from(JSON.stringify({ sub: 'u_mock', roles: { [tenantId]: 'TENANT_OWNER' } })).toString('base64')}.mock_pbc_signature`;
  assert((await call('GET', '/controls', { token: mock, tenant: tenantId })).status === 401, 'dev mock tokens are rejected in production, in local mode too');
  assert((await call('GET', '/controls', { token: annToken, tenant: tenantId })).status === 200, 'while real local tokens keep working');
  process.env.NODE_ENV = originalEnv;

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
