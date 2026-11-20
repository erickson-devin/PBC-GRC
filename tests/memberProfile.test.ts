import './testEnv';
import { server } from '../server/index';
import { __setMembershipClockForTests, upsertTenantMember } from '../server/db';
import { listAccountEvents } from '../server/auth/accountEvents';
import { utcToday } from '../src/utils/memberProfile';
import { firstProgram } from './programFixture';

/**
 * Membership profile (issues #258, #259), end to end through the real server on the in-memory store: an access expiry date that is refused
 * per request and left out of GET /tenants, affiliation, the optional US person flag recorded by an owner, one primary contact per tenant,
 * who may change what, and the account events that record it. The clock hook moves "now" without a timer. The PostgreSQL parts (the unique
 * index, the DATE round trip) are proven live by `npm run db:verify-rls`.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';
const T = 'tenant_member_profile';
const DAY = 86_400_000;

const out = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
const serverLines: string[] = [];
const keep = (fn: (...a: unknown[]) => void) => (...a: unknown[]) => {
  const line = a.map(String).join(' ');
  if (!/^\s+[✓✗]/.test(line)) serverLines.push(line);
  fn(...a);
};
console.log = keep(out.log);
console.warn = keep(out.warn);
console.error = keep(out.error);

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

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify({ email: 'caller@test.mil', ...claims })).toString('base64')}.mock_pbc_signature`;
const caller = (sub: string, role: string) => jwt({ sub, roles: { [T]: role } });
// A member token that claims only another tenant: access to T can only come from tenant_users.
const asMember = (sub: string) => jwt({ sub, roles: { tenant_elsewhere: 'VIEWER' } });

async function call(method: string, path: string, token: string, tenant: string | null, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

const owner = caller('u_owner', 'TENANT_OWNER');
const admin = caller('u_adm', 'TENANT_ADMIN');
const viewer = caller('u_view', 'VIEWER');
const members = `/tenants/${T}/members`;
const patch = (token: string, userId: string, body: unknown) => call('PATCH', `${members}/${userId}`, token, T, body);
const add = (userId: string, role: string) => call('POST', members, owner, T, { userId, email: `${userId}@example.mil`, name: userId, role });
const listed = async (token = owner) => (await call('GET', members, token, T)).body?.members as any[];
const memberOf = async (id: string, token = owner) => (await listed(token)).find((m) => m.userId === id);

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));
  await firstProgram(T);
  const today = utcToday(Date.now());
  const plus = (days: number) => utcToday(Date.now() + days * DAY);
  // The acting members need rows, since the routes read the target role (and a self edit) from tenant_users.
  for (const [id, role] of [['u_owner', 'TENANT_OWNER'], ['u_owner2', 'TENANT_OWNER'], ['u_adm', 'TENANT_ADMIN'], ['u_view', 'VIEWER']] as const) {
    await upsertTenantMember(T, { userId: id, email: `${id}@example.mil`, name: id, role });
  }
  await add('u_alice', 'ASSESSOR');
  await add('u_bob', 'ASSESSOR');
  await add('u_carl', 'ASSESSOR');

  try {
    console.log('--- Expiry: set, enforce, clear ---');
    const p1 = await patch(owner, 'u_alice', { accessExpiresOn: today });
    const aliceRow = await memberOf('u_alice');
    assert(p1.status === 200 && p1.body?.changed?.join() === 'access_expiry' && aliceRow?.membership?.accessExpiresOn === today && aliceRow?.membership?.expired === false, 'P1: an owner sets an expiry of today; it is listed and not yet expired', [p1, aliceRow?.membership]);
    assert((await call('GET', '/controls', asMember('u_alice'), T)).status === 200, 'P2: the member can still work on the expiry day');
    const mine = await call('GET', '/tenants', asMember('u_alice'), null);
    assert(mine.body?.tenants?.some((t: any) => t.id === T && t.accessExpiresOn === today) && Array.isArray(mine.body?.expiredTenants) && mine.body.expiredTenants.length === 0, 'P2: GET /tenants lists it with the member\'s own accessExpiresOn', mine.body);

    __setMembershipClockForTests(() => Date.now() + 2 * DAY);
    const expired = await call('GET', '/controls', asMember('u_alice'), T);
    assert(expired.status === 403 && expired.body?.reason === 'membership_expired' && expired.body?.expiredOn === today && /ended on/.test(expired.body?.error), 'P3: after the day the request is refused: 403 membership_expired with expiredOn', expired);
    const mineLater = await call('GET', '/tenants', asMember('u_alice'), null);
    assert(!mineLater.body?.tenants?.some((t: any) => t.id === T) && mineLater.body?.expiredTenants?.[0]?.id === T && mineLater.body?.expiredTenants?.[0]?.expiredOn === today, 'P4: GET /tenants leaves it out and lists it under expiredTenants', mineLater.body);
    const ownerSees = await memberOf('u_alice');
    assert(ownerSees?.membership?.expired === true, 'P5: the owner still sees the expired member, flagged expired');
    const cleared = await patch(owner, 'u_alice', { accessExpiresOn: null });
    assert(cleared.status === 200 && cleared.body?.membership?.accessExpiresOn === null && (await call('GET', '/controls', asMember('u_alice'), T)).status === 200, 'P5: clearing the expiry restores access at once');
    __setMembershipClockForTests(null);

    console.log('\n--- Owner-level members never expire ---');
    const p6 = await patch(owner, 'u_owner2', { accessExpiresOn: today });
    assert(p6.status === 409 && p6.body?.code === 'owner_cannot_expire', 'P6: an expiry on an owner is 409 owner_cannot_expire', p6);
    await patch(owner, 'u_carl', { accessExpiresOn: plus(30) });
    const promote = await add('u_carl', 'TENANT_OWNER');
    const carl = await memberOf('u_carl');
    assert(promote.status === 200 && promote.body?.accessExpiryCleared === true && carl?.membership?.accessExpiresOn === null && !('profile' in (promote.body?.member ?? {})), 'P7: promoting to Owner clears the expiry and says so', [promote.body, carl?.membership]);

    console.log('\n--- Validation ---');
    const past = await patch(owner, 'u_alice', { accessExpiresOn: plus(-1) });
    const bad = await patch(owner, 'u_alice', { accessExpiresOn: '2026-02-30' });
    const far = await patch(owner, 'u_alice', { accessExpiresOn: plus(3654) });
    assert(past.status === 400 && past.body?.code === 'expiry_in_past' && bad.status === 400 && bad.body?.code === 'invalid_request' && bad.body?.field === 'accessExpiresOn' && far.status === 400 && far.body?.code === 'expiry_too_far', 'P8: yesterday, an impossible date and a date over ten years ahead are 400 with their codes', [past.body, bad.body, far.body]);
    const empty = await patch(owner, 'u_alice', {});
    const unknown = await patch(owner, 'u_alice', { foo: 1 });
    const ghost = await patch(owner, 'u_nobody', { affiliation: 'ESP' });
    assert(empty.status === 400 && unknown.status === 400 && ghost.status === 404 && ghost.body?.code === 'member_not_found', 'P16: an empty body and an unknown key are 400; an unknown member is 404 member_not_found', [empty.status, unknown.status, ghost]);
    const badTypes = await Promise.all([{ affiliation: 'BOSS' }, { usPerson: 'YES' }, { primaryContact: 'yes' }, { accessExpiresOn: 5 }].map((b) => patch(owner, 'u_alice', b)));
    assert(badTypes.every((r) => r.status === 400 && r.body?.code === 'invalid_request' && typeof r.body?.field === 'string'), 'P16: a wrong type or value for any field is 400 invalid_request naming the field', badTypes.map((r) => r.body));

    console.log('\n--- Who may change what ---');
    const selfExpiry = await patch(owner, 'u_owner', { accessExpiresOn: today });
    const selfUs = await patch(owner, 'u_owner', { usPerson: 'US_PERSON' });
    assert(selfExpiry.status === 403 && selfExpiry.body?.code === 'self' && selfUs.status === 403 && selfUs.body?.code === 'self', 'P9: nobody sets their own expiry or US person flag (403 self)', [selfExpiry, selfUs]);
    const selfContact = await patch(owner, 'u_owner', { primaryContact: true });
    assert(selfContact.status === 200 && selfContact.body?.primaryContact === true, 'P9: an owner may name themselves the primary contact', selfContact);
    await patch(owner, 'u_owner', { primaryContact: false });
    const p10 = await patch(admin, 'u_view', { accessExpiresOn: today, affiliation: 'CONTRACTOR' });
    assert(p10.status === 200 && p10.body?.changed?.join() === 'access_expiry,affiliation', 'P10: an Admin sets expiry and affiliation of a Viewer', p10);
    const p11 = await patch(admin, 'u_owner2', { affiliation: 'EMPLOYEE' });
    assert(p11.status === 403 && p11.body?.code === 'role_not_grantable', 'P11: an Admin cannot change an Owner (403 role_not_grantable)', p11);
    const p12a = await patch(admin, 'u_bob', { usPerson: 'OTHER' });
    const p12b = await patch(admin, 'u_bob', { primaryContact: true });
    assert(p12a.status === 403 && p12a.body?.code === 'owner_required' && p12b.status === 403 && p12b.body?.code === 'owner_required', 'P12: the US person flag and the primary contact are owner-level (403 owner_required)', [p12a, p12b]);
    assert((await patch(viewer, 'u_bob', { affiliation: 'ESP' })).status === 403, 'P17: a Viewer cannot change anything (403)');
    assert((await patch(caller('u_x', 'ASSESSOR'), 'u_bob', { affiliation: 'ESP' })).status === 403, 'P17: an Assessor cannot either (403)');
    assert((await call('PATCH', `/tenants/other_tenant/members/u_bob`, owner, T, { affiliation: 'ESP' })).status === 403, 'the tenant in the URL must be the active tenant (403)');

    console.log('\n--- US person flag and visibility ---');
    const p13 = await patch(owner, 'u_alice', { usPerson: 'US_PERSON' });
    const seenByAdmin = await memberOf('u_alice', admin);
    const seenByViewer = await memberOf('u_alice', viewer);
    const seenByAssessor = await memberOf('u_alice', caller('u_assessor', 'ASSESSOR'));
    assert(p13.status === 200 && seenByAdmin?.membership?.usPerson === 'US_PERSON' && typeof seenByAdmin?.membership?.usPersonRecordedAt === 'string', 'P13: an owner records it; the write roles see it with the time it was recorded', [p13.status, seenByAdmin?.membership]);
    assert(seenByViewer?.membership === null && seenByAssessor?.membership === null && typeof seenByViewer?.primaryContact === 'boolean', 'P13: the read roles get membership null and only the primaryContact boolean', [seenByViewer, seenByAssessor]);
    assert(!JSON.stringify(seenByViewer).includes('US_PERSON') && !('profile' in seenByViewer) && !('profile' in (seenByAdmin ?? {})), 'P13: the profile object never reaches a response');
    const recorded = await memberOf('u_alice');
    assert(!JSON.stringify(recorded).includes('usPersonRecordedBy') && recorded?.membership?.usPerson === 'US_PERSON', 'who recorded it is not exposed');
    const cleared13 = await patch(owner, 'u_alice', { usPerson: null });
    assert(cleared13.status === 200 && (await memberOf('u_alice'))?.membership?.usPerson === null, 'the flag can be cleared back to not recorded');

    console.log('\n--- One primary contact per organization ---');
    await patch(owner, 'u_alice', { primaryContact: true });
    const p14 = await patch(owner, 'u_bob', { primaryContact: true });
    const flagged = (await listed()).filter((m) => m.primaryContact === true).map((m) => m.userId);
    assert(p14.status === 200 && flagged.join() === 'u_bob', 'P14: naming a second contact moves the flag: exactly one member, the new one', flagged);
    assert((await memberOf('u_alice', viewer))?.primaryContact === false && (await memberOf('u_bob', viewer))?.primaryContact === true, 'P14: a Viewer sees who the primary contact is');

    console.log('\n--- A role change keeps the profile; removal and re-adding resets it ---');
    await patch(owner, 'u_bob', { affiliation: 'ESP', accessExpiresOn: plus(60) });
    const demote = await add('u_bob', 'VIEWER');
    const bobAfter = await memberOf('u_bob');
    assert(demote.status === 200 && bobAfter?.membership?.affiliation === 'ESP' && bobAfter?.membership?.accessExpiresOn === plus(60) && bobAfter?.primaryContact === true, 'P19: changing the role keeps affiliation, expiry and the primary contact flag (memory upsert does not rebuild them)', bobAfter);
    assert((await call('DELETE', `${members}/u_bob`, owner, T)).status === 200, 'removing the member works');
    await add('u_bob', 'ASSESSOR');
    const bobBack = await memberOf('u_bob');
    assert(bobBack?.membership?.accessExpiresOn === null && bobBack?.membership?.affiliation === null && bobBack?.primaryContact === false, 'P18: a removed and re-added member starts with a blank profile', bobBack);

    console.log('\n--- Account events and logs ---');
    const events = await listAccountEvents({ action: 'membership_updated', limit: 200 });
    const exp = events.find((e) => e.details.field === 'access_expiry' && e.targetUserId === 'u_alice' && e.details.newValue === today);
    const usEvents = events.filter((e) => e.details.field === 'us_person');
    assert(!!exp && exp.details.previousValue === 'none' && exp.actorUserId === 'u_owner' && exp.tenantId === T && exp.details.via === 'member_update', 'P15: the expiry change is recorded with the old and new date', exp);
    assert(usEvents.length === 2 && usEvents.every((e) => !('previousValue' in e.details) && !('newValue' in e.details)), 'P15: the US person events record the field only, never a value', usEvents.map((e) => e.details));
    const promoted = events.find((e) => e.targetUserId === 'u_carl' && e.details.reason === 'owner_level_role');
    assert(promoted?.details.newValue === 'none' && promoted.details.previousValue === plus(30), 'P7: the expiry cleared by a promotion is recorded', promoted?.details);
    assert(events.every((e) => !JSON.stringify(e).includes('@')), 'P15: no event detail holds an address');
    assert(serverLines.every((l) => !l.includes('@example.mil') && !l.includes('US_PERSON') && !l.includes('CONTRACTOR')), 'no server log line holds an email address, a US person value or an affiliation', serverLines.filter((l) => l.includes('@example.mil') || l.includes('US_PERSON')));
    assert(serverLines.some((l) => l.includes('membership of user u_alice in tenant') && l.includes('expired')), 'the refusal is logged with ids only');

    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    shutdown(passed === total ? 0 : 1);
  } finally {
    __setMembershipClockForTests(null);
  }
}

run().catch((err) => {
  out.error('Test run crashed:', err);
  shutdown(1);
});
