import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { server } from '../server/index';
import { base32Decode, generateTotp } from '../server/auth/totp';
import { LocalAuthConfigError, assertAuthConfig, authStartupWarnings, getAccountDormantDays } from '../server/auth/localAuth';
import {
  __resetMemoryLocalUsersForTests,
  __setLocalUserTimesForTests,
  createLocalUser,
  findLocalUserById,
  setLocalUserDisabled,
} from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests, createTenantWithOwner, upsertTenantMember } from '../server/db';
import { __resetMemoryInvitationsForTests } from '../server/invitations';
import { __resetPlatformSetupForTests, addPlatformAdmin, removePlatformAdmin } from '../server/platformSetup';
import { __resetLoginThrottleForTests, __resetMfaStateForTests, __setMfaClockForTests } from '../server/routes/auth';
import { __resetSessionsForTests } from '../server/auth/sessionStore';
import { __resetMfaRequirementCacheForTests } from '../server/auth/mfaEnforcement';
import { __resetAccountEventsForTests, listAccountEvents } from '../server/auth/accountEvents';
import { disableDormantAccounts, isDormant } from '../server/auth/accountDormancy';
import { sessionCookieFrom } from './sessionCookieJar';

/**
 * Dormant accounts (IA.L2-3.5.6, issue #257), end to end through the real server: the setting, the dormancy test, the daily sweep, the
 * sign-in path, the last-administrator guard, the restore paths (platform administrator and Tenant Owner), what the lists show and
 * what the logs hold. Time is moved with explicit now / days arguments and a memory-mode test hook: no timers, no sleeps.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const PW = 'correct horse battery staple';
const T = Math.floor(Date.now() / 30000) * 30000 + 1000;
const STEP = 30000;
const DAY = 86_400_000;
const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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

async function call(method: string, path: string, opts: { token?: string; tenant?: string; body?: unknown } = {}) {
  __resetLoginThrottleForTests();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
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
  name: string;
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
const login = (email: string, password = PW) => call('POST', '/auth/login', { body: { email, password } });
async function mk(name: string): Promise<Acct> {
  const email = `${name}@dorm.mil`;
  const u = await createLocalUser({ email, name: `Name ${name}`, password: PW });
  return { email, name: `Name ${name}`, id: u.id, secret: null, k: 0 };
}
/** Enrols a second factor through the account's own session (MFA_REQUIRED=off keeps the sign-in single step). */
async function enrol(a: Acct): Promise<void> {
  const token: string = (await login(a.email)).body?.token;
  const start = await call('POST', '/auth/mfa/enrol/start', { token });
  a.secret = start.body?.secret ? base32Decode(start.body.secret) : null;
  a.k = 0;
  setClock(T);
  await call('POST', '/auth/mfa/enrol/confirm', { token, body: { code: a.secret ? generateTotp(a.secret, T) : '000000' } });
}
async function signIn(a: Acct): Promise<string> {
  const step1 = await login(a.email);
  if (step1.body?.mfa !== 'verify') return step1.body?.token as string;
  const step2 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: step1.body.mfaToken, code: fresh(a) } });
  return step2.body?.token as string;
}
const ago = (days: number) => new Date(Date.now() - days * DAY);
/** Moves an account's last sign-in, creation and restore times to `days` ago (`never` = it never signed in). */
const age = (a: Acct, days: number, never = false) => __setLocalUserTimesForTests(a.id, { lastLoginAt: never ? null : ago(days), createdAt: ago(days), dormancyResetAt: ago(days) });
const newest = async (a: Acct) => (await listAccountEvents({ targetUserId: a.id, limit: 1 }))[0];

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
  process.env.MFA_REQUIRED = 'off';
  delete process.env.PLATFORM_ADMIN_EMAILS;
  delete process.env.ACCOUNT_DORMANT_DAYS;
  setClock(T);

  console.log('--- D1: the setting ---');
  const throws = (value: string) => {
    try {
      getAccountDormantDays({ ACCOUNT_DORMANT_DAYS: value } as NodeJS.ProcessEnv);
      return false;
    } catch (e) {
      return e instanceof LocalAuthConfigError;
    }
  };
  assert(
    getAccountDormantDays({} as NodeJS.ProcessEnv) === 90 && getAccountDormantDays({ ACCOUNT_DORMANT_DAYS: '0' } as NodeJS.ProcessEnv) === 0 &&
      getAccountDormantDays({ ACCOUNT_DORMANT_DAYS: ' 30 ' } as NodeJS.ProcessEnv) === 30 && getAccountDormantDays({ ACCOUNT_DORMANT_DAYS: '3650' } as NodeJS.ProcessEnv) === 3650 &&
      getAccountDormantDays({ ACCOUNT_DORMANT_DAYS: '   ' } as NodeJS.ProcessEnv) === 90,
    'D1: unset or blank -> 90, "0" -> 0, " 30 " -> 30, "3650" -> 3650'
  );
  assert(['x', '-1', '3651', '1.5'].every(throws), 'D1: "x", "-1", "3651" and "1.5" are refused with a LocalAuthConfigError', ['x', '-1', '3651', '1.5'].filter((v) => !throws(v)));
  let startupRefused = false;
  try {
    assertAuthConfig({ ...process.env, ACCOUNT_DORMANT_DAYS: 'x' });
  } catch (e) {
    startupRefused = e instanceof LocalAuthConfigError;
  }
  assert(startupRefused, 'D1: assertAuthConfig refuses a bad ACCOUNT_DORMANT_DAYS (the server does not start)');
  const prodWarn = authStartupWarnings({ ...process.env, NODE_ENV: 'production', ACCOUNT_DORMANT_DAYS: '0' }).filter((w) => w.includes('3.5.6'));
  const testWarn = authStartupWarnings({ ...process.env, NODE_ENV: 'test', ACCOUNT_DORMANT_DAYS: '0' }).filter((w) => w.includes('3.5.6'));
  const defaultWarn = authStartupWarnings({ ...process.env, NODE_ENV: 'production', ACCOUNT_DORMANT_DAYS: '' }).filter((w) => w.includes('3.5.6'));
  assert(prodWarn.length === 1 && prodWarn[0].includes('ACCOUNT_DORMANT_DAYS=0') && testWarn.length === 0 && defaultWarn.length === 0, 'D1: 0 in production warns (names 3.5.6); no warning under NODE_ENV=test or with the default', [prodWarn, testWarn, defaultWarn]);

  console.log('\n--- D2: the dormancy test ---');
  const now = new Date('2026-06-01T12:00:00Z');
  const at = (days: number) => new Date(now.getTime() - days * DAY);
  assert(isDormant({ lastLoginAt: at(91), createdAt: at(300), dormancyResetAt: at(300) }, now, 90), 'D2: last sign-in 91 days ago -> dormant');
  assert(!isDormant({ lastLoginAt: at(89), createdAt: at(300), dormancyResetAt: at(300) }, now, 90), 'D2: last sign-in 89 days ago -> not dormant');
  assert(isDormant({ lastLoginAt: null, createdAt: at(91), dormancyResetAt: at(91) }, now, 90), 'D2: never signed in, created and reset 91 days ago -> dormant');
  assert(!isDormant({ lastLoginAt: null, createdAt: at(91), dormancyResetAt: at(10) }, now, 90), 'D2: never signed in but restored 10 days ago -> not dormant');
  assert(!isDormant({ lastLoginAt: at(900), createdAt: at(900), dormancyResetAt: at(900) }, now, 0), 'D2: days 0 -> never dormant');

  // Fixtures: a platform administrator holding a second factor (every restore is a step-up) and a tenant with an enrolled owner.
  const adm = await mk('admin57');
  await addPlatformAdmin({ userId: adm.id, email: adm.email });
  await enrol(adm);
  const owner = await mk('owner57');
  await createTenantWithOwner(
    { id: 'tenant-dorm-57', name: 'Org 57', systemName: 'Enclave 57', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: owner.id, email: owner.email, name: owner.name }
  );
  await enrol(owner);
  const TENANT = 'tenant-dorm-57';
  const accounts: Acct[] = [adm, owner];
  const byEmail = (email: string): Acct => accounts.find((a) => a.email === email)!;
  const adminTok = await signIn(adm);
  const ownerTok = await signIn(owner);
  const adminAct = (path: string) => call('POST', path, { token: adminTok, body: { code: fresh(adm) } });

  const captured: string[] = [];
  const grab = (...args: unknown[]) => void captured.push(util.format(...args));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    // ------------------------------------------------------------------------------------------------ D3 to D4
    const old = await mk('old57');
    const fr = await mk('fresh57');
    const never = await mk('never57');
    const newbie = await mk('newbie57');
    const adminOff = await mk('adminoff57');
    accounts.push(old, fr, never, newbie, adminOff);
    age(adm, 1);
    age(old, 100);
    age(fr, 10);
    age(never, 100, true);
    await setLocalUserDisabled(adminOff.id, true);
    age(adminOff, 100);
    const run1 = await disableDormantAccounts({ days: 90 });
    const [oldU, frU, neverU, newU, offU] = await Promise.all([old, fr, never, newbie, adminOff].map((a) => findLocalUserById(a.id)));
    const admU = await findLocalUserById(adm.id);
    out.log('  (sweep result: ' + JSON.stringify(run1) + ')');
    assert(run1.skipped === false && run1.disabled === 2 && run1.errors === 0 && oldU?.disabled === true && neverU?.disabled === true && oldU.disabledReason === 'dormant' && neverU.disabledReason === 'dormant' && oldU.disabledAt !== null, 'D3: the sweep disables the account last seen 100 days ago and the one that never signed in (reason dormant, time recorded)', [run1, oldU?.disabledReason, neverU?.disabledReason]);
    assert(frU?.disabled === false && newU?.disabled === false && admU?.disabled === false, 'D3: an account seen 10 days ago, a new account and the administrator stay enabled');
    assert(offU?.disabled === true && offU.disabledReason === 'admin', 'D3: an administrator-disabled account keeps the reason admin');
    const run2 = await disableDormantAccounts({ days: 90 });
    assert(run2.disabled === 0 && run2.keptLastAdmin === 0, 'D3: a second sweep disables nothing more', run2);

    const e4 = await newest(old);
    assert(e4?.action === 'account_disabled' && e4.actorKind === 'system' && e4.actorUserId === null && e4.details.reason === 'dormant' && e4.details.via === 'sweep' && Object.keys(e4.details).length === 2, 'D4: the event is account_disabled, actor kind system with no actor id, details { reason: dormant, via: sweep }', e4);

    // ------------------------------------------------------------------------------------------------ D5
    const mf = await mk('factor57');
    accounts.push(mf);
    await enrol(mf);
    const beforeMf = await findLocalUserById(mf.id);
    const versionBefore = beforeMf!.tokenVersion; // the memory store hands out the live record: copy the number
    age(mf, 100);
    const run5 = await disableDormantAccounts({ days: 90 });
    const afterMf = await findLocalUserById(mf.id);
    assert(run5.disabled === 1 && afterMf?.disabled === true && afterMf?.totpConfirmedAt !== null && afterMf.recoveryCodeHashes.length > 0 && afterMf.tokenVersion === versionBefore + 1, 'D5: a dormancy disable keeps the second factor and bumps the token version by one', [run5, versionBefore, afterMf?.tokenVersion]);

    // ------------------------------------------------------------------------------------------------ D6
    const s6 = await mk('session57');
    accounts.push(s6);
    const s6Tok = (await login(s6.email)).body?.token as string;
    const meBefore = await call('GET', '/auth/me', { token: s6Tok });
    age(s6, 100);
    const run6 = await disableDormantAccounts({ days: 90 });
    const meAfter = await call('GET', '/auth/me', { token: s6Tok });
    assert(meBefore.status === 200 && run6.disabled === 1 && meAfter.status === 401, 'D6: a session open before the sweep is refused afterwards (401)', [meBefore.status, run6.disabled, meAfter.status]);

    // ------------------------------------------------------------------------------------------------ D7
    const lg = await mk('signin57');
    const wrongRef = await mk('wrongref57');
    const lw = await mk('wrongpw57');
    accounts.push(lg, wrongRef, lw);
    age(lg, 100);
    const generic = await login(wrongRef.email, 'not the right passphrase at all');
    const dormantTry = await login(lg.email);
    const lgU = await findLocalUserById(lg.id);
    const e7 = await newest(lg);
    assert(dormantTry.status === 401 && generic.status === 401 && dormantTry.text === generic.text && !dormantTry.text.includes('inactiv') && !dormantTry.text.includes('dormant'), 'D7: the right password on a dormant account answers 401 with exactly the body of a wrong password', [dormantTry.text, generic.text]);
    assert(lgU?.disabled === true && lgU.disabledReason === 'dormant' && e7?.action === 'account_disabled' && e7.details.via === 'sign_in' && e7.details.reason === 'dormant' && e7.actorKind === 'system', 'D7: that sign-in disabled the account with an account_disabled event (via sign_in)', [lgU?.disabledReason, e7]);
    age(lw, 100);
    const wrongTry = await login(lw.email, 'not the right passphrase at all');
    const lwU = await findLocalUserById(lw.id);
    assert(wrongTry.status === 401 && lwU?.disabled === false && lwU.failedAttempts === 1, 'D7: a wrong password on a dormant account writes nothing but the failed attempt (still enabled, failedAttempts 1)', [wrongTry.status, lwU?.disabled, lwU?.failedAttempts]);
    age(lw, 0);

    // ------------------------------------------------------------------------------------------------ D8
    await removePlatformAdmin(adm.id); // the administrator fixture would otherwise count as another enabled administrator
    const a1 = await mk('adminone57');
    const a2 = await mk('admintwo57');
    accounts.push(a1, a2);
    await addPlatformAdmin({ userId: a1.id, email: a1.email });
    await addPlatformAdmin({ userId: a2.id, email: a2.email });
    age(a1, 100);
    age(a2, 100);
    const r8a = await disableDormantAccounts({ days: 90 });
    const states8a = await Promise.all([a1, a2].map(async (a) => (await findLocalUserById(a.id))?.disabled));
    assert(r8a.disabled === 1 && r8a.keptLastAdmin === 1 && states8a.filter(Boolean).length === 1, 'D8: two stored administrators both dormant -> exactly one disabled, the other kept (keptLastAdmin 1)', [r8a, states8a]);
    for (const a of [a1, a2]) {
      const u = await findLocalUserById(a.id);
      if (u?.disabled) await setLocalUserDisabled(a.id, false);
      age(a, 0);
    }
    age(a1, 100);
    age(a2, 1);
    const r8b = await disableDormantAccounts({ days: 90 });
    const u1 = await findLocalUserById(a1.id);
    const u2 = await findLocalUserById(a2.id);
    assert(r8b.disabled === 1 && r8b.keptLastAdmin === 0 && u1?.disabled === true && u2?.disabled === false, 'D8: one dormant administrator and one active one -> the dormant one is disabled, nothing kept', [r8b, u1?.disabled, u2?.disabled]);
    await setLocalUserDisabled(a1.id, false);
    await removePlatformAdmin(a1.id);
    await removePlatformAdmin(a2.id);
    age(a1, 0);
    age(a2, 0);
    const c1 = await mk('configured57');
    accounts.push(c1);
    process.env.PLATFORM_ADMIN_EMAILS = c1.email;
    age(c1, 100);
    let r8c;
    try {
      r8c = await disableDormantAccounts({ days: 90 });
    } finally {
      delete process.env.PLATFORM_ADMIN_EMAILS;
    }
    const c1U = await findLocalUserById(c1.id);
    assert(r8c.disabled === 0 && r8c.keptLastAdmin === 1 && c1U?.disabled === false, 'D8: a sole configured administrator is kept', [r8c, c1U?.disabled]);
    age(c1, 0);
    await addPlatformAdmin({ userId: adm.id, email: adm.email });

    // ------------------------------------------------------------------------------------------------ D9
    const pr = await mk('platrestore57');
    accounts.push(pr);
    age(pr, 100);
    const r9 = await disableDormantAccounts({ days: 90 });
    const restored9 = await adminAct(`/platform/users/${pr.id}/enable`);
    const e9 = await newest(pr);
    const again9 = await disableDormantAccounts({ days: 90 });
    const login9 = await login(pr.email);
    assert(r9.disabled === 1 && restored9.status === 200 && restored9.body?.user?.disabled === false && restored9.body?.user?.disabledReason === null, 'D9: a platform administrator enables the dormant account (200, reason cleared)', [r9, restored9.status, restored9.body]);
    assert(e9?.action === 'account_enabled' && e9.actorKind === 'admin' && e9.details.reason === 'dormant', 'D9: the event is account_enabled with details.reason dormant', e9);
    assert(again9.disabled === 0 && login9.status === 200, 'D9: an immediate sweep does not disable it again and it can sign in', [again9, login9.status]);

    // ------------------------------------------------------------------------------------------------ D10
    const m1 = await mk('assessor57');
    const m3 = await mk('assessor357');
    const m2 = await mk('admindisabled57');
    const ta = await mk('tenantadmin57');
    const vw = await mk('viewer57');
    const msp = await mk('msp57');
    const outsider = await mk('outsider57');
    accounts.push(m1, m3, m2, ta, vw, msp, outsider);
    for (const [a, role] of [[m1, 'ASSESSOR'], [m3, 'ASSESSOR'], [m2, 'ASSESSOR'], [ta, 'TENANT_ADMIN'], [vw, 'VIEWER'], [msp, 'MSP_ADMIN']] as const) {
      await upsertTenantMember(TENANT, { userId: a.id, email: a.email, name: a.name, role });
    }
    await setLocalUserDisabled(m2.id, true);
    for (const a of [m1, m3, msp, outsider]) age(a, 100);
    const r10 = await disableDormantAccounts({ days: 90 });
    assert(r10.disabled === 4, 'D10 setup: four accounts are dormant-disabled (two assessors, an MSP Admin and a non-member)', r10);
    age(m2, 100);
    const taTok = await signIn(ta);
    const vwTok = await signIn(vw);
    const restore = (who: Acct, token: string, body: Record<string, unknown> | undefined) => call('POST', `/tenants/${TENANT}/members/${who.id}/restore`, { token, tenant: TENANT, body });
    const asTa = await restore(m3, taTok, { code: '123456' });
    assert(asTa.status === 403 && asTa.body?.code === 'owner_required', 'D10: a Tenant Admin is refused (403 owner_required)', [asTa.status, asTa.body]);
    const asVw = await restore(m3, vwTok, { code: '123456' });
    assert(asVw.status === 403, 'D10: a Viewer is refused (403)', asVw.status);
    const notDormant = await restore(m2, ownerTok, { code: fresh(owner) });
    assert(notDormant.status === 409 && notDormant.body?.reason === 'not_dormant' && (await findLocalUserById(m2.id))?.disabledReason === 'admin', 'D10: an administrator-disabled member -> 409 not_dormant, still disabled', [notDormant.status, notDormant.body]);
    const nonMember = await restore(outsider, ownerTok, { code: fresh(owner) });
    assert(nonMember.status === 404, 'D10: an account that is not a member of the tenant -> 404', [nonMember.status, nonMember.body]);
    const asMsp = await restore(msp, ownerTok, { code: fresh(owner) });
    assert(asMsp.status === 403 && asMsp.body?.code === 'role_not_grantable' && (await findLocalUserById(msp.id))?.disabled === true, 'D10: a dormant MSP Admin cannot be restored by an Owner (403 role_not_grantable)', [asMsp.status, asMsp.body]);
    const self = await restore(owner, ownerTok, { code: fresh(owner) });
    assert(self.status === 403, 'D10: an Owner cannot restore their own account (403)', self.status);
    const badUser = await restore({ id: 'a b' } as Acct, ownerTok, { code: fresh(owner) });
    assert(badUser.status === 400, 'D10: a userId outside the pattern -> 400', badUser.status);
    const noCode = await restore(m3, ownerTok, {});
    assert(noCode.status === 400 && noCode.body?.reason === 'code_required' && (await findLocalUserById(m3.id))?.disabled === true, 'D10: no code -> 400 code_required, still disabled', [noCode.status, noCode.body]);
    owner.k += 1;
    const wrong = await restore(m3, ownerTok, { code: generateTotp(owner.secret!, T + (owner.k + 100) * STEP) });
    assert(wrong.status === 403 && wrong.body?.reason === 'invalid_code' && (await findLocalUserById(m3.id))?.disabled === true, 'D10: a wrong code -> 403 invalid_code, still disabled', [wrong.status, wrong.body]);
    const ok = await restore(m1, ownerTok, { code: fresh(owner) });
    const e10 = await newest(m1);
    const m1U = await findLocalUserById(m1.id);
    assert(ok.status === 200 && ok.body?.restored === true && ok.body?.userId === m1.id && ok.body?.account?.disabled === false && ok.body?.account?.disabledReason === null && m1U?.disabled === false, 'D10: the Owner restores a dormant Assessor (200 { restored, userId, account })', [ok.status, ok.body]);
    assert(e10?.action === 'account_enabled' && e10.actorKind === 'user' && e10.actorUserId === owner.id && e10.tenantId === TENANT && e10.details.reason === 'dormant' && e10.details.via === 'member_update', 'D10: the event names the Owner, the tenant and { reason: dormant, via: member_update }', e10);
    assert((await login(m1.email)).status === 200, 'D10: the restored member can sign in');
  } finally {
    console.log = out.log;
    console.warn = out.warn;
    console.error = out.error;
  }

  // ------------------------------------------------------------------------------------------------ D11
  console.log('\n--- D11: the members list ---');
  const ownerList = await call('GET', `/tenants/${TENANT}/members`, { token: ownerTok, tenant: TENANT });
  const members = (ownerList.body?.members ?? []) as Array<Record<string, any>>;
  const mspMember = members.find((m) => m.email === 'msp57@dorm.mil');
  assert(
    ownerList.status === 200 && members.length >= 6 && ownerList.body?.dormantDays === 90 &&
      members.every((m) => m.account && (m.account.lastLoginAt === null || !Number.isNaN(Date.parse(m.account.lastLoginAt))) && typeof m.account.disabled === 'boolean'),
    'D11: as an Owner every member carries account.lastLoginAt (ISO or null) and the list names dormantDays 90',
    [ownerList.status, ownerList.body?.dormantDays, members.map((m) => m.account)]
  );
  assert(mspMember?.account?.disabled === true && mspMember.account.disabledReason === 'dormant' && !Number.isNaN(Date.parse(mspMember.account.disabledAt)), 'D11: the dormant member shows disabledReason dormant and a disabledAt time', mspMember?.account);
  const viewerList = await call('GET', `/tenants/${TENANT}/members`, { token: await signIn(byEmail('viewer57@dorm.mil')), tenant: TENANT });
  const viewerMembers = (viewerList.body?.members ?? []) as Array<Record<string, any>>;
  assert(viewerList.status === 200 && viewerMembers.length >= 6 && viewerMembers.every((m) => m.account === null), 'D11: as a Viewer every member has account null', [viewerList.status, viewerMembers.map((m) => m.account)]);

  // ------------------------------------------------------------------------------------------------ D12
  console.log('\n--- D12: GET /platform/users ---');
  const users = await call('GET', '/platform/users', { token: adminTok });
  const list = (users.body?.users ?? []) as Array<Record<string, any>>;
  const dormantRow = list.find((u) => u.email === 'msp57@dorm.mil');
  const enabledRow = list.find((u) => u.email === 'fresh57@dorm.mil');
  const adminRow = list.find((u) => u.email === 'adminoff57@dorm.mil');
  assert(users.status === 200 && users.body?.dormantDays === 90 && list.every((u) => 'disabledReason' in u && 'disabledAt' in u), 'D12: the list names dormantDays and every account has disabledReason and disabledAt', [users.status, users.body?.dormantDays]);
  assert(dormantRow?.disabledReason === 'dormant' && !Number.isNaN(Date.parse(dormantRow.disabledAt)) && enabledRow?.disabledReason === null && enabledRow.disabledAt === null && adminRow?.disabledReason === 'admin', 'D12: dormant -> "dormant" with a time, enabled -> null, administrator-disabled -> "admin"', [dormantRow, enabledRow, adminRow]);

  // ------------------------------------------------------------------------------------------------ D13
  console.log('\n--- D13: switched off ---');
  const off = await disableDormantAccounts({ days: 0 });
  assert(off.skipped === true && off.disabled === 0, 'D13: days 0 -> the sweep is skipped', off);
  const o13 = await mk('off57');
  accounts.push(o13);
  age(o13, 400);
  process.env.ACCOUNT_DORMANT_DAYS = '0';
  let login13;
  try {
    login13 = await login(o13.email);
  } finally {
    delete process.env.ACCOUNT_DORMANT_DAYS;
  }
  assert(login13.status === 200 && (await findLocalUserById(o13.id))?.disabled === false, 'D13: with ACCOUNT_DORMANT_DAYS=0 an account idle for 400 days signs in', login13.status);

  // ------------------------------------------------------------------------------------------------ D14, D15
  console.log('\n--- D14: the log ---');
  const needles = accounts.flatMap((a) => [a.email, a.name]);
  const leaked = captured.filter((l) => needles.some((n) => l.includes(n)) || l.includes('@dorm.mil'));
  assert(captured.length > 0 && captured.some((l) => l.includes('[Dormancy]')) && leaked.length === 0, 'D14: no log line written during D3 to D10 holds a test email or an account name', leaked);
  assert(captured.some((l) => l.includes('kept the last platform administrator enabled (account ')), 'D14: the kept administrator is logged by account reference');

  console.log('\n--- D15: source checks ---');
  const svc = read('../server/middleware/serviceTokenMiddleware.ts');
  assert(!/localUsers|accountDormancy/.test(svc), 'D15: the service token middleware imports neither localUsers nor accountDormancy (a push token never depends on an account)');
  assert(read('../server/accountRetention.ts').includes('disableDormantAccounts('), 'D15: the daily sweep calls disableDormantAccounts(');
  assert(read('../server/index.ts').includes('describeAccountDormancy('), 'D15: the startup log calls describeAccountDormancy(');

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
