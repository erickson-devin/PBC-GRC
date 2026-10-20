import './testEnv';
import './localAuthEnv';
import { server } from '../server/index';
import { __resetMemoryLocalUsersForTests } from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests, createTenantWithOwner } from '../server/db';
import { __resetMemoryInvitationsForTests } from '../server/invitations';
import { __resetPlatformSetupForTests, isSetupRequired, removePlatformAdmin } from '../server/platformSetup';
import { __resetSetupThrottleForTests } from '../server/routes/setup';
import { __resetLoginThrottleForTests } from '../server/routes/auth';

/**
 * First-time setup wizard: the one public endpoint that creates an administrator. It must work exactly once and then
 * lock itself for good (also against a race), validate before writing, and leave nothing behind on a rejected attempt.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
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

async function call(method: string, path: string, opts: { token?: string; tenant?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

const payload = (over: Record<string, unknown> = {}) => ({
  companyName: 'Acme Defense LLC',
  adminName: 'Ada Admin',
  email: 'ada@acme-defense.mil',
  password: PASSWORD,
  invites: ['bob@acme-defense.mil', 'cy@acme-defense.mil'],
  ...over,
});
const status = async () => (await call('GET', '/setup/status')).body;
const reset = () => {
  __resetPlatformSetupForTests();
  __resetMemoryLocalUsersForTests();
  __resetMemoryTenantsForTests();
  __resetMemoryInvitationsForTests();
  __resetSetupThrottleForTests();
  __resetLoginThrottleForTests();
};

async function run() {
  reset();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  delete process.env.SETUP_TOKEN;

  console.log('--- A fresh installation ---');
  assert((await status()).setupRequired === true, 'status: setup is required when no administrator exists');
  assert((await status()).tokenRequired === false, 'status: no setup token is asked for unless SETUP_TOKEN is configured');

  console.log('\n--- Validation happens before anything is written ---');
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no company name', { companyName: '   ' }, /company/i],
    ['invalid email', { email: 'not-an-email' }, /email/i],
    ['short password', { password: 'short' }, /at least/i],
    ['password equal to the email', { email: 'twelve@acme.mil', password: 'twelve@acme.mil' }, /same as the email/i],
    ['an invalid teammate address', { invites: ['bob@acme-defense.mil', 'nope'] }, /not a valid email/i],
    ['too many invites', { invites: Array.from({ length: 51 }, (_, i) => `u${i}@acme.mil`) }, /at most 50/i],
    ['the MSP admin role for teammates', { inviteRole: 'MSP_ADMIN' }, /role/i],
    ['a non-array invite list', { invites: 'bob@acme.mil' }, /at most|invite/i],
  ];
  for (const [name, over, re] of bad) {
    const r = await call('POST', '/setup', { body: payload(over) });
    assert(r.status === 400 && re.test(r.body?.error ?? ''), `rejected (400): ${name}`, r);
  }
  assert((await status()).setupRequired === true, 'rejected attempts leave setup open: no account, no lock');
  assert((await call('POST', '/auth/login', { body: { email: 'ada@acme-defense.mil', password: PASSWORD } })).status === 401, 'and no account was created by them');

  console.log('\n--- Completing setup ---');
  const done = await call('POST', '/setup', { body: payload({ email: 'ADA@Acme-Defense.mil' }) });
  assert(done.status === 201, 'setup succeeds (201)', done);
  const b = done.body ?? {};
  assert(typeof b.token === 'string' && b.user?.email === 'ada@acme-defense.mil' && b.user?.name === 'Ada Admin', 'it signs the administrator in (email normalised)');
  assert(typeof b.tenant?.id === 'string' && b.tenant?.name === 'Acme Defense LLC', 'it provisions the primary tenant');
  assert(Array.isArray(b.invites) && b.invites.length === 2 && b.invites.every((i: any) => /^inv_/.test(i.token) && i.role === 'ASSESSOR'), 'it stages one-time invitation tokens for each teammate', b.invites);
  assert(!JSON.stringify(b).includes(PASSWORD), 'the password is never echoed back');

  const me = await call('GET', '/me', { token: b.token });
  assert(me.status === 200 && me.body?.isPlatformAdmin === true, '/me: the new user is a platform administrator (stored, not configured)', me.body);
  const tenants = await call('GET', '/tenants', { token: b.token });
  const mine = (tenants.body?.tenants ?? []).find((t: any) => t.id === b.tenant.id);
  assert(Boolean(mine) && mine.role === 'TENANT_OWNER', 'the administrator owns the primary tenant', tenants.body);
  assert(mine?.primaryFramework === 'CMMC_L1' && mine?.enabledFrameworks?.length === 1, 'the tenant starts on the default program (CMMC Level 1)');
  const login = await call('POST', '/auth/login', { body: { email: 'ada@acme-defense.mil', password: PASSWORD } });
  assert(login.status === 200 && typeof login.body?.token === 'string', 'the local account works with the normal login endpoint');
  const admins = await call('GET', '/platform/admins', { token: b.token });
  assert(admins.status === 200 && admins.body?.admins?.some((a: any) => a.email === 'ada@acme-defense.mil'), 'the administrator console lists them', admins.body);

  const listed = await call('GET', `/tenants/${b.tenant.id}/invites`, { token: b.token, tenant: b.tenant.id });
  assert(listed.status === 200 && listed.body?.totalCount === 2 && listed.body.invitations.every((i: any) => i.status === 'PENDING'), 'the invitations are PENDING in the tenant');
  const bobToken = b.invites.find((i: any) => i.email === 'bob@acme-defense.mil').token;
  const bob = await call('POST', '/auth/register-with-invite', { body: { token: bobToken, password: PASSWORD, name: 'Bob' } });
  assert(bob.status === 201 && bob.body?.tenantId === b.tenant.id && bob.body?.role === 'ASSESSOR', 'a staged invitation can be redeemed by the teammate', bob.body);
  const bobMe = await call('GET', '/me', { token: bob.body?.token });
  assert(bobMe.body?.isPlatformAdmin === false, 'an invited teammate is NOT a platform administrator');

  console.log('\n--- Locked down for good ---');
  __resetSetupThrottleForTests(); // the validation cases above used up this address's allowance
  assert((await status()).setupRequired === false, 'status: setup is no longer required');
  const again = await call('POST', '/setup', { body: payload({ companyName: 'Hostile Takeover Inc', email: 'evil@attacker.test' }) });
  assert(again.status === 409 && again.body?.code === 'setup_complete', 'a second setup attempt is refused (409 setup_complete)', again);
  assert((await call('POST', '/auth/login', { body: { email: 'evil@attacker.test', password: PASSWORD } })).status === 401, 'and the attacker account was not created');
  assert((await call('POST', '/setup', { body: {} })).status === 409, 'the refusal does not depend on the payload (an empty body also gets 409)');
  assert(((await call('GET', '/tenants', { token: login.body.token })).body?.tenants ?? []).length === 1, 'and no second tenant appeared');
  await removePlatformAdmin(b.user.id);
  assert((await isSetupRequired()) === false && (await status()).setupRequired === false, 'even if the administrator record is removed, the lock stays: setup does not reopen');
  assert((await call('POST', '/setup', { body: payload({ email: 'evil2@attacker.test' }) })).status === 409, 'and setup is still refused');

  console.log('\n--- Two simultaneous attempts on a fresh install: exactly one wins ---');
  reset();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => call('POST', '/setup', { body: payload({ email: `racer${i}@acme.mil`, companyName: `Racer ${i}`, invites: [] }) }))
  );
  const wins = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  assert(wins.length === 1 && refused.length === 5, 'exactly one of six concurrent setups succeeds, the rest get 409', results.map((r) => r.status));
  const winnerEmail = wins[0]?.body?.user?.email as string;
  const adminList = await call('GET', '/platform/admins', { token: wins[0]?.body?.token });
  assert(adminList.body?.admins?.length === 1 && adminList.body.admins[0].email === winnerEmail, 'and there is exactly one platform administrator');
  let strays = 0;
  for (let i = 0; i < 6; i++) {
    const email = `racer${i}@acme.mil`;
    const r = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
    if (r.status === 200 && email !== winnerEmail) strays++;
  }
  assert(strays === 0, 'the losing attempts left no account behind');

  console.log('\n--- A configured administrator means setup is not needed ---');
  reset();
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@acme.mil';
  assert((await status()).setupRequired === false, 'PLATFORM_ADMIN_EMAILS set: the wizard is closed');
  assert((await call('POST', '/setup', { body: payload() })).status === 409, 'and cannot be used to add another administrator');
  delete process.env.PLATFORM_ADMIN_EMAILS;

  console.log('\n--- Optional SETUP_TOKEN ---');
  reset();
  process.env.SETUP_TOKEN = 'let-me-in-0123456789';
  assert((await status()).tokenRequired === true, 'status tells the browser to ask for the token');
  const noTok = await call('POST', '/setup', { body: payload() });
  assert(noTok.status === 403 && noTok.body?.code === 'invalid_setup_token', 'no token: refused (403)');
  const wrongTok = await call('POST', '/setup', { body: payload({ setupToken: 'guess' }) });
  assert(wrongTok.status === 403, 'wrong token: refused (403)');
  assert((await status()).setupRequired === true, 'a refused attempt leaves setup open for the real operator');
  const okTok = await call('POST', '/setup', { body: payload({ setupToken: 'let-me-in-0123456789', invites: [] }) });
  assert(okTok.status === 201, 'the right token completes setup', okTok);
  assert((await status()).tokenRequired === false, 'and once locked the token is no longer mentioned');
  delete process.env.SETUP_TOKEN;

  console.log('\n--- AUTH_MODE unset (local accounts are the default) ---');
  reset();
  delete process.env.AUTH_MODE;
  assert((await status()).setupRequired === true, 'with AUTH_MODE unset a fresh install still needs setup');
  process.env.AUTH_MODE = 'local';

  console.log('\n--- An existing install: a tenant but no administrator ---');
  reset();
  assert((await status()).setupRequired === true, 'no administrator and no tenant: setup is required');
  await createTenantWithOwner(
    { id: 'tenant-legacy-0001', name: 'Legacy Org', systemName: 'Legacy Enclave', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: 'u_legacy', email: 'owner@legacy.mil', name: 'Owner' }
  );
  assert((await status()).setupRequired === false, 'once any tenant exists the wizard is closed, so it cannot be used to claim the install');
  const legacy = await call('POST', '/setup', { body: payload() });
  assert(legacy.status === 409 && legacy.body?.code === 'setup_complete', 'and POST /setup is refused (409 setup_complete)', legacy);

  console.log('\n--- Throttle ---');
  reset();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call('POST', '/setup', { body: payload({ email: 'bad' }) })).status;
  assert(last === 429, 'repeated attempts from one address are throttled (429)', last);
}

run()
  .catch((e) => {
    console.error('TEST CRASHED:', e);
    total++;
  })
  .finally(() => {
    server.closeAllConnections();
    server.close();
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    process.exit(passed === total ? 0 : 1);
  });
