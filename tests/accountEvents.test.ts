import './testEnv';
import './localAuthEnv';
import fs from 'fs';
import util from 'util';
import { server } from '../server/index';
import { base32Decode, generateTotp } from '../server/auth/totp';
import { __resetMemoryLocalUsersForTests, createLocalUser } from '../server/auth/localUsers';
import { __resetMemoryTenantsForTests, createTenantWithOwner, upsertTenantMember } from '../server/db';
import { __resetMemoryInvitationsForTests, createInvitation } from '../server/invitations';
import { __resetPlatformSetupForTests, addPlatformAdmin } from '../server/platformSetup';
import { __resetLoginThrottleForTests, __resetMfaStateForTests, __setMfaClockForTests } from '../server/routes/auth';
import { __resetSessionsForTests } from '../server/auth/sessionStore';
import { __resetMfaRequirementCacheForTests } from '../server/auth/mfaEnforcement';
import {
  AccountEventDetailsError,
  __resetAccountEventsForTests,
  __setAccountEventClockForTests,
  getAccountEventRetention,
  listAccountEvents,
  pruneAccountEvents,
  recordAccountEvent,
  sanitizeAccountEventDetails,
} from '../server/auth/accountEvents';
import { sessionCookieFrom } from './sessionCookieJar';

/**
 * Account event log (issue #40), end to end through the real server: who did what to which account, in a closed list of
 * actions, with ids and codes only (never an email, a name or an address). Compares action sequences, never totals.
 * The append-only trigger and the retention DELETE are PostgreSQL features, proven live by `npm run db:verify-rls`.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const PW = 'correct horse battery staple';
const NEWPW = 'a brand new long passphrase';
const TEMPPW = 'temporary hand-out passphrase';
const T = Math.floor(Date.now() / 30000) * 30000 + 1000;
const STEP = 30000;
const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

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
  recovery: string[];
  k: number;
}
const setMode = (mode: string) => {
  process.env.MFA_REQUIRED = mode;
};
const setClock = (ms: number | null) => __setMfaClockForTests(ms === null ? null : () => ms);
const fresh = (a: Acct): string => {
  a.k += 1;
  setClock(T + a.k * STEP);
  return generateTotp(a.secret!, T + a.k * STEP);
};
const login = (email: string, password = PW) => call('POST', '/auth/login', { body: { email, password } });
async function mk(name: string): Promise<Acct> {
  const email = `${name}@events.mil`;
  const u = await createLocalUser({ email, name: `Name ${name}`, password: PW });
  return { email, name: `Name ${name}`, id: u.id, secret: null, recovery: [], k: 0 };
}
/** Start + confirm with an enrol-stage token (or a session). */
async function enrolWith(a: Acct, auth: { mfaToken?: string; token?: string }) {
  const body = auth.mfaToken ? { mfaToken: auth.mfaToken } : undefined;
  const start = await call('POST', '/auth/mfa/enrol/start', { token: auth.token, body });
  a.secret = start.body?.secret ? base32Decode(start.body.secret) : null;
  a.k = 0;
  setClock(T);
  const confirm = await call('POST', '/auth/mfa/enrol/confirm', { token: auth.token, body: { ...(body ?? {}), code: a.secret ? generateTotp(a.secret, T) : '000000' } });
  a.recovery = confirm.body?.recoveryCodes ?? [];
  return confirm;
}
/** Enrols through the account's own session in mode off. */
async function enrol(a: Acct): Promise<void> {
  setMode('off');
  const token: string = (await login(a.email)).body?.token;
  await enrolWith(a, { token });
}
async function signIn(a: Acct): Promise<string> {
  const step1 = await login(a.email);
  if (step1.body?.mfa !== 'verify') return step1.body?.token as string;
  const step2 = await call('POST', '/auth/mfa/verify', { body: { mfaToken: step1.body.mfaToken, code: fresh(a) } });
  return step2.body?.token as string;
}

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
  setMode('off');
  setClock(T);

  const captured: string[] = [];
  const grab = (...args: unknown[]) => void captured.push(util.format(...args));

  // Fixtures: a platform administrator holding a second factor (account management is a step-up), a tenant with an owner.
  const adm = await mk('admin40');
  await addPlatformAdmin({ userId: adm.id, email: adm.email });
  await enrol(adm);
  const owner = await mk('owner40');
  await createTenantWithOwner(
    { id: 'tenant-ev-40', name: 'Org 40', systemName: 'Enclave 40', systemOwner: 'Owner', enabledFrameworks: ['CMMC_L1'], primaryFramework: 'CMMC_L1' },
    { userId: owner.id, email: owner.email, name: owner.name }
  );
  const accounts: Acct[] = [adm, owner];
  const adminTok = await signIn(adm);
  const ownerTok = (await login(owner.email)).body?.token as string;
  const events = async (limit = 200) => ((await call('GET', `/platform/account-events?limit=${limit}`, { token: adminTok })).body?.events ?? []) as Array<Record<string, any>>;
  const forTarget = async (id: string) => (await events()).filter((e) => e.targetUserId === id);
  const adminAct = (path: string, body: Record<string, unknown> = {}) => call('POST', path, { token: adminTok, body: { ...body, code: fresh(adm) } });

  console.log.call(console, '--- E40-1 to E40-8: the trail of real actions ---');
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  try {
    // E40-1 a self password change
    const self = await mk('self40');
    accounts.push(self);
    const selfTok = (await login(self.email)).body?.token as string;
    const changed = await call('POST', '/auth/password', { token: selfTok, body: { currentPassword: PW, newPassword: NEWPW } });
    const e1 = (await forTarget(self.id))[0];
    assert(changed.status === 200 && e1?.action === 'password_changed' && e1.actorKind === 'user' && e1.actorUserId === self.id && e1.targetUserId === self.id, 'E40-1: a self password change -> password_changed, actor = target = the account (kind user)', [changed.status, e1]);

    // E40-2 admin reset-password
    const t = await mk('target40');
    accounts.push(t);
    const reset = await adminAct(`/platform/users/${t.id}/reset-password`, { newPassword: TEMPPW });
    const e2 = (await forTarget(t.id))[0];
    assert(reset.status === 200 && e2?.action === 'password_reset' && e2.actorKind === 'admin' && e2.actorUserId === adm.id && e2.targetUserId === t.id && e2.details?.mustChangePassword === true, 'E40-2: an administrator reset -> password_reset, actor = the administrator, target = the account, details.mustChangePassword true', [reset.status, e2]);

    // E40-3 reset-mfa, disable, enable
    const r3 = [
      (await adminAct(`/platform/users/${t.id}/reset-mfa`)).status,
      (await adminAct(`/platform/users/${t.id}/disable`)).status,
      (await adminAct(`/platform/users/${t.id}/enable`)).status,
    ];
    const seq3 = (await forTarget(t.id)).slice(0, 3).map((e) => e.action);
    assert(r3.every((s) => s === 200) && JSON.stringify(seq3) === JSON.stringify(['account_enabled', 'account_disabled', 'mfa_reset']), 'E40-3: reset-mfa, disable, enable -> mfa_reset, account_disabled, account_enabled in that order (newest first in the list)', [r3, seq3]);

    // E40-4 enrolment via a session, and via the pending token
    const viaSession = await mk('enrolsess40');
    accounts.push(viaSession);
    const tokS = (await login(viaSession.email)).body?.token as string;
    await enrolWith(viaSession, { token: tokS });
    const e4a = (await forTarget(viaSession.id))[0];
    assert(e4a?.action === 'mfa_enrolled' && e4a.details?.via === 'session' && e4a.actorUserId === viaSession.id, 'E40-4: enrolling through a session -> mfa_enrolled {via: session}', e4a);
    const viaPending = await mk('enrolpend40');
    accounts.push(viaPending);
    setMode('all');
    const lp = await login(viaPending.email);
    await enrolWith(viaPending, { mfaToken: lp.body?.mfaToken });
    setMode('off');
    const e4b = (await forTarget(viaPending.id))[0];
    assert(lp.body?.mfa === 'enrol' && e4b?.action === 'mfa_enrolled' && e4b.details?.via === 'sign_in', 'E40-4: enrolling with the sign-in token -> mfa_enrolled {via: sign_in}', [lp.body?.mfa, e4b]);

    // E40-5 recovery code regeneration (the enrolled account signs in with its code)
    const tokR = await signIn(viaSession);
    const regen = await call('POST', '/auth/mfa/recovery-codes', { token: tokR, body: { code: fresh(viaSession) } });
    const e5 = (await forTarget(viaSession.id))[0];
    assert(regen.status === 200 && e5?.action === 'recovery_codes_regenerated' && e5.actorUserId === viaSession.id, 'E40-5: regenerating the recovery codes -> recovery_codes_regenerated', [regen.status, e5]);

    // E40-6 a wrong step-up code
    const victim = await mk('victim40');
    accounts.push(victim);
    adm.k += 100;
    const bad = await call('POST', `/platform/users/${victim.id}/disable`, { token: adminTok, body: { code: generateTotp(adm.secret!, T + (adm.k + 100) * STEP) } });
    adm.k -= 100;
    const e6 = (await forTarget(adm.id))[0];
    const victimLogin = await login(victim.email);
    assert(bad.status === 403 && e6?.action === 'step_up_failed' && e6.details?.attempted === 'disable' && e6.actorUserId === adm.id && e6.targetUserId === adm.id && victimLogin.status === 200, 'E40-6: a wrong step-up code on a disable -> step_up_failed {attempted: disable}, actor = target = the administrator; the target stays enabled', [bad.status, e6, victimLogin.status]);

    // E40-7 membership changes
    const member = await mk('member40');
    accounts.push(member);
    await upsertTenantMember('tenant-ev-40', { userId: member.id, email: member.email, name: member.name, role: 'ASSESSOR' });
    const promote = await call('POST', '/tenants/tenant-ev-40/members', { token: ownerTok, tenant: 'tenant-ev-40', body: { userId: member.id, email: member.email, role: 'TENANT_OWNER' } });
    const e7a = (await forTarget(member.id))[0];
    assert(promote.status === 200 && e7a?.action === 'role_changed' && e7a.tenantId === 'tenant-ev-40' && e7a.details?.previousRole === 'ASSESSOR' && e7a.details?.newRole === 'TENANT_OWNER' && e7a.details?.via === 'member_update' && e7a.actorUserId === owner.id, 'E40-7: ASSESSOR -> TENANT_OWNER by a member update -> role_changed with the tenant and {previousRole, newRole, via: member_update}', [promote.status, e7a]);
    const invitee = await mk('invitee40');
    accounts.push(invitee);
    const invTok = (await login(invitee.email)).body?.token as string;
    const inv = await createInvitation('tenant-ev-40', { email: invitee.email, role: 'ASSESSOR', createdBy: owner.email, createdByUserId: owner.id, expiresInDays: 14 });
    const accepted = await call('POST', '/invites/accept', { token: invTok, body: { token: inv.token } });
    const e7b = (await forTarget(invitee.id))[0];
    assert(accepted.status === 200 && e7b?.action === 'role_changed' && e7b.details?.via === 'invitation' && e7b.details?.newRole === 'ASSESSOR' && e7b.tenantId === 'tenant-ev-40', 'E40-7: accepting an invitation -> role_changed {via: invitation}', [accepted.status, e7b]);
    const creator = await mk('creator40');
    accounts.push(creator);
    const crTok = (await login(creator.email)).body?.token as string;
    const created = await call('POST', '/tenants', { token: crTok, body: { name: 'Creator Org 40' } });
    const e7c = (await forTarget(creator.id))[0];
    assert(created.status === 201 && e7c?.action === 'role_changed' && e7c.details?.via === 'tenant_created' && e7c.details?.newRole === 'TENANT_OWNER' && e7c.tenantId === created.body?.tenant?.id, 'E40-7: creating a tenant -> role_changed {via: tenant_created}', [created.status, e7c]);
    const removed = await call('DELETE', `/tenants/tenant-ev-40/members/${invitee.id}`, { token: ownerTok, tenant: 'tenant-ev-40' });
    const e7d = (await forTarget(invitee.id))[0];
    assert(removed.status === 200 && e7d?.action === 'member_removed' && e7d.details?.previousRole === 'ASSESSOR' && e7d.tenantId === 'tenant-ev-40', 'E40-7: removing a member -> member_removed {previousRole}', [removed.status, e7d]);

    // E40-8 sign-out
    const so = await mk('signout40');
    accounts.push(so);
    const soTok = (await login(so.email)).body?.token as string;
    const lo = await call('POST', '/auth/logout', { token: soTok });
    const e8 = (await forTarget(so.id))[0];
    assert(lo.status === 204 && e8?.action === 'signed_out' && e8.actorUserId === so.id, 'E40-8: signing out -> signed_out', [lo.status, e8]);
  } finally {
    console.log = out.log;
    console.warn = out.warn;
    console.error = out.error;
  }

  console.log('\n--- E40-9: GET /api/v1/platform/account-events ---');
  const plain = await call('GET', '/platform/account-events', { token: ownerTok });
  assert(plain.status === 403 && plain.body?.error === 'Forbidden: only a platform administrator can read account events', 'E40-9: a non-administrator -> 403', [plain.status, plain.body]);
  const page1 = await call('GET', '/platform/account-events?limit=2', { token: adminTok });
  const ev1 = (page1.body?.events ?? []) as Array<Record<string, any>>;
  assert(page1.status === 200 && ev1.length === 2 && page1.body?.nextBefore === ev1[1].id, 'E40-9: limit=2 -> 2 events and nextBefore = the last id', [page1.status, ev1.length, page1.body?.nextBefore]);
  const page2 = await call('GET', `/platform/account-events?limit=2&before=${page1.body?.nextBefore}`, { token: adminTok });
  const ev2 = (page2.body?.events ?? []) as Array<Record<string, any>>;
  assert(ev2.length === 2 && ev2.every((e) => Number(e.id) < Number(ev1[1].id)), 'E40-9: before=<nextBefore> returns older events', ev2.map((e) => e.id));
  const bad9 = [
    await call('GET', '/platform/account-events?limit=0', { token: adminTok }),
    await call('GET', '/platform/account-events?limit=201', { token: adminTok }),
    await call('GET', '/platform/account-events?before=abc', { token: adminTok }),
  ];
  assert(bad9.every((r) => r.status === 400 && r.body?.reason === 'invalid_request'), 'E40-9: limit=0, limit=201 and before=abc -> 400 invalid_request', bad9.map((r) => [r.status, r.body]));

  console.log('\n--- E40-10: no email, name or address anywhere ---');
  const all = await call('GET', '/platform/account-events?limit=200', { token: adminTok });
  const stored = await listAccountEvents({ limit: 200 });
  const needles = accounts.flatMap((a) => [a.email, a.name]);
  const hay = all.text + JSON.stringify(stored);
  assert(all.status === 200 && (all.body?.events ?? []).length > 10 && needles.every((n) => !hay.includes(n)) && !stored.some((e) => JSON.stringify(e.details).includes('@')), 'E40-10: the list response and every stored details object hold no test email, no account name and no "@"', needles.filter((n) => hay.includes(n)));

  console.log('\n--- E40-11: details sanitising ---');
  const thrown = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  const sameObject = { reason: 'mfa_required', mustChangePassword: true };
  assert(
    thrown(() => sanitizeAccountEventDetails({ note: 'x' })) instanceof AccountEventDetailsError &&
      thrown(() => sanitizeAccountEventDetails({ reason: 'a@b.mil' })) instanceof AccountEventDetailsError &&
      (thrown(() => sanitizeAccountEventDetails({ reason: 'a@b.mil' })) as Error).message === 'Account event details accept ids and codes only' &&
      JSON.stringify(sanitizeAccountEventDetails(sameObject)) === JSON.stringify(sameObject),
    'E40-11: an unknown key and an address are refused with the fixed message; an allowed object passes unchanged'
  );
  let refusedAction = false;
  try {
    await recordAccountEvent({ actorKind: 'system', targetUserId: 'lu_x', action: 'made_up' as never });
  } catch {
    refusedAction = true;
  }
  assert(refusedAction, 'E40-11: an action outside the closed list is refused');

  console.log('\n--- E40-12: retention ---');
  const warnings: string[] = [];
  const d0 = getAccountEventRetention({} as NodeJS.ProcessEnv);
  const dz = getAccountEventRetention({ ACCOUNT_EVENT_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv);
  const dx = getAccountEventRetention({ ACCOUNT_EVENT_RETENTION_DAYS: 'x' } as NodeJS.ProcessEnv);
  if (dx.warning) warnings.push(dx.warning);
  assert(d0.days === 1095 && d0.source === 'default' && dz.days === 0 && dx.days === 0 && dx.source === 'invalid' && warnings.length === 1, 'E40-12: unset -> 1095 (default), "0" -> keep forever, "x" -> keep everything with a warning', [d0, dz, dx]);
  __resetAccountEventsForTests();
  const now = Date.now();
  for (const at of [now - 3 * 86_400_000, now - 2 * 3_600_000, now]) {
    __setAccountEventClockForTests(() => at);
    await recordAccountEvent({ actorKind: 'system', targetUserId: 'lu_retention', action: 'session_revoked', details: { reason: 'idle' } });
  }
  __setAccountEventClockForTests(null);
  const dry = await pruneAccountEvents({ now: new Date(now), days: 1, dryRun: true });
  const pruned = await pruneAccountEvents({ now: new Date(now), days: 1 });
  const left = await listAccountEvents({ limit: 10 });
  assert(dry.deleted === 1 && pruned.deleted === 1 && left.length === 2, 'E40-12: events at now-3 days, now-2 hours and now with days 1: the dry run counts 1, the sweep deletes 1, 2 remain', [dry, pruned, left.length]);

  console.log('\n--- E40-13: source checks ---');
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const pu = read('../server/routes/platformUsers.ts');
  const cliSrc = read('../scripts/resetLocalUserMfa.ts');
  const indexSrc = read('../server/index.ts');
  const logLines = pu.split('\n').filter((l) => l.includes('console.'));
  assert(logLines.length > 0 && logLines.every((l) => !l.includes('.email}')), 'E40-13: no console line of platformUsers.ts interpolates an email', logLines.filter((l) => l.includes('.email}')));
  assert(cliSrc.includes('recordAccountEvent(') === false && cliSrc.includes("actorKind: 'cli'") && cliSrc.includes("action: 'mfa_reset'"), 'E40-13: the CLI reset records an mfa_reset event with actor kind cli (through resetLocalUserMfa)');
  assert(indexSrc.includes('startAccountRetention(') && indexSrc.includes('stopAccountRetention('), 'E40-13: server/index.ts starts and stops the account retention scheduler');

  console.log('\n--- E40-14: the log ---');
  assert(captured.length > 0 && captured.every((l) => needles.every((n) => !l.includes(n))), 'E40-14: no log line written during E40-1 to E40-8 holds an email or an account name', captured.filter((l) => needles.some((n) => l.includes(n))));

  setClock(null);
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  void NEWPW;
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
