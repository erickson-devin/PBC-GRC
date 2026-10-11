import './testEnv';
import { server } from '../server/index';
import { __expireInvitationForTests, hashInviteToken } from '../server/invitations';
import { inviteRateLimiter } from '../server/routes/invites';

/**
 * Server-side invitations: create / list / revoke / resend / extend / edit (owners), preview and accept (invitee),
 * single-use token consumption, email binding, expiry, role rules, and member removal.
 * Runs against the in-memory store, which mirrors the PostgreSQL behaviour; the redemption RLS policies are checked in
 * dbSchema.test.ts and, against a live database, by `npm run db:verify-rls`.
 */
const BASE = 'http://127.0.0.1:8080/api/v1';

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

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
/** Claims name only an unrelated tenant, so all tenant access comes from tenant_users (memberships). */
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });

type Json = Record<string, any>;
async function call(method: string, path: string, token: string | null, tenant?: string, body?: unknown) {
  if (path.startsWith('/invites')) inviteRateLimiter.reset(); // the limiter is tested on its own below
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}
const preview = (token: string) => call('POST', '/invites/preview', null, undefined, { token });
const accept = (userToken: string | null, token: string) => call('POST', '/invites/accept', userToken, undefined, { token });
const myTenants = async (t: string) => ((await call('GET', '/tenants', t)).body?.tenants ?? []) as Json[];

function shutdown(code: number) {
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

async function run() {
  await new Promise((r) => setTimeout(r, 500));

  const owner = person('u_inv_owner');
  const tenantId = (await call('POST', '/tenants', owner, undefined, { name: 'Invite Org' })).body?.tenant?.id as string;
  const otherOwner = person('u_inv_other');
  const otherTenant = (await call('POST', '/tenants', otherOwner, undefined, { name: 'Other Org' })).body?.tenant?.id as string;

  const inv = (token: string | null, body: unknown, tenant = tenantId) => call('POST', `/tenants/${tenant}/invites`, token, tenant, body);
  const list = async (token = owner, tenant = tenantId) => ((await call('GET', `/tenants/${tenant}/invites`, token, tenant)).body?.invitations ?? []) as Json[];

  console.log('--- Creating invitations ---');
  const alice = person('u_inv_alice', 'Alice@Example.mil');
  const created = await inv(owner, { email: 'Alice@Example.mil', role: 'ASSESSOR' });
  assert(created.status === 201, 'the owner creates an invitation (201)', created);
  const aliceToken = created.body?.token as string;
  const aliceInvite = created.body?.invitation as Json;
  assert(/^inv_[A-Za-z0-9_-]{40,}$/.test(aliceToken), 'a 256-bit random token is returned once', aliceToken);
  assert(aliceInvite.status === 'PENDING' && aliceInvite.role === 'ASSESSOR' && aliceInvite.email === 'alice@example.mil', 'invitation is PENDING with a normalised email');
  const days = (new Date(aliceInvite.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert(days > 13.9 && days <= 14.01, 'expires in 14 days by default', days);
  assert(!JSON.stringify(created.body?.invitation).includes(aliceToken) && !('token' in aliceInvite) && !('tokenHash' in aliceInvite), 'the invitation object itself carries neither the token nor its hash');
  const listed = await list();
  assert(listed.length === 1 && !/inv_[A-Za-z0-9_-]{40,}/.test(JSON.stringify(listed)) && !JSON.stringify(listed).includes(hashInviteToken(aliceToken)), 'listing never exposes tokens or hashes');

  console.log('\n--- Who may invite ---');
  await call('POST', `/tenants/${tenantId}/members`, owner, tenantId, { userId: 'u_inv_assessor', email: 'as@test.mil', role: 'ASSESSOR' });
  await call('POST', `/tenants/${tenantId}/members`, owner, tenantId, { userId: 'u_inv_viewer', email: 'vi@test.mil', role: 'VIEWER' });
  const assessor = person('u_inv_assessor');
  const viewer = person('u_inv_viewer');
  assert((await inv(assessor, { email: 'x@test.mil', role: 'VIEWER' })).status === 403, 'an ASSESSOR cannot invite (403)');
  assert((await inv(viewer, { email: 'x@test.mil', role: 'VIEWER' })).status === 403, 'a VIEWER cannot invite (403)');
  assert((await call('GET', `/tenants/${tenantId}/invites`, assessor, tenantId)).status === 403, 'an ASSESSOR cannot list invitations (403)');
  assert((await call('GET', `/tenants/${tenantId}/invites`, viewer, tenantId)).status === 403, 'a VIEWER cannot list invitations (403)');
  assert((await inv(otherOwner, { email: 'x@test.mil', role: 'VIEWER' })).status === 403, "another tenant's owner cannot invite into this tenant (403)");
  assert((await call('POST', `/tenants/${tenantId}/invites`, otherOwner, otherTenant, { email: 'x@test.mil', role: 'VIEWER' })).status === 403, 'even with their own x-tenant-id the URL must match the active tenant (403)');
  assert((await inv(null, { email: 'x@test.mil', role: 'VIEWER' })).status === 401, 'no session => 401');
  assert((await inv(owner, { email: 'x@test.mil', role: 'MSP_ADMIN' })).status === 403, 'a TENANT_OWNER cannot invite an MSP_ADMIN (403)');
  const msp = jwt({ sub: 'u_inv_msp', email: 'msp@test.mil', roles: { [tenantId]: 'MSP_ADMIN' } });
  assert((await inv(msp, { email: 'msp2@test.mil', role: 'MSP_ADMIN' })).status === 201, 'an MSP_ADMIN can invite an MSP_ADMIN (201)');

  console.log('\n--- Validation ---');
  assert((await inv(owner, { email: 'not-an-email', role: 'VIEWER' })).status === 400, 'bad email -> 400');
  assert((await inv(owner, { email: 'a@b.mil', role: 'ADMIN' })).status === 400, 'unknown role -> 400');
  assert((await inv(owner, { email: 'a@b.mil', role: 'VIEWER', expiresInDays: 0 })).status === 400, 'expiresInDays below 1 -> 400');
  assert((await inv(owner, { email: 'a@b.mil', role: 'VIEWER', expiresInDays: 365 })).status === 400, 'expiresInDays above 30 -> 400');
  assert((await inv(owner, {})).status === 400, 'empty body -> 400');
  const short = await inv(owner, { email: 'short@test.mil', role: 'VIEWER', expiresInDays: 2 });
  assert(short.status === 201 && (new Date(short.body?.invitation.expiresAt).getTime() - Date.now()) / 86_400_000 < 2.01, 'a custom lifetime is honoured');

  console.log('\n--- Preview (public, token only) ---');
  const pv = await preview(aliceToken);
  assert(pv.status === 200 && pv.body?.invitation?.tenantName === 'Invite Org' && pv.body?.invitation?.role === 'ASSESSOR' && pv.body?.invitation?.status === 'PENDING', 'the accept page can show organisation and role without signing in', pv.body);
  assert((await preview('inv_' + 'x'.repeat(43))).status === 404, 'an unknown token -> 404');
  assert((await preview('garbage')).status === 404 && (await call('POST', '/invites/preview', null, undefined, {})).status === 404, 'a malformed or missing token -> 404 (same answer as unknown)');
  assert(JSON.stringify(pv.body).includes(hashInviteToken(aliceToken)) === false, 'preview does not reveal the stored hash');

  console.log('\n--- Accepting ---');
  assert((await accept(null, aliceToken)).status === 401, 'accepting requires a signed-in user (401)');
  const wrongPerson = await accept(person('u_inv_mallory', 'mallory@example.mil'), aliceToken);
  assert(wrongPerson.status === 403 && wrongPerson.body?.reason === 'email_mismatch', 'a different email cannot use the link, even with the token (403)', wrongPerson.body);
  assert((await list()).find((i) => i.id === aliceInvite.id)?.status === 'PENDING', 'and the failed attempt did not consume the invitation');
  assert((await myTenants(person('u_inv_mallory', 'mallory@example.mil'))).filter((t) => t.id === tenantId).length === 0, 'nor give Mallory any access');
  assert((await call('GET', '/controls', person('u_inv_mallory', 'mallory@example.mil'), tenantId)).status === 403, 'tenant access stays denied (403)');

  const ok = await accept(alice, aliceToken);
  assert(ok.status === 200 && ok.body?.tenantId === tenantId && ok.body?.role === 'ASSESSOR', 'the invited email accepts (200) and gets the invited role', ok.body);
  const aliceTenants = await myTenants(alice);
  assert(aliceTenants.some((t) => t.id === tenantId && t.role === 'ASSESSOR' && t.source === 'membership'), 'the tenant now appears in her tenant list, as ASSESSOR');
  assert((await call('GET', '/controls', alice, tenantId)).status === 200, 'she can read the tenant');
  assert((await call('PUT', '/controls/AC.L1-3.1.1', alice, tenantId, { status: 'MET', implementationNotes: 'x' })).status === 403, 'but ASSESSOR stays read-only');
  const members = (await call('GET', `/tenants/${tenantId}/members`, owner, tenantId)).body?.members as Json[];
  assert(members.some((m) => m.userId === 'u_inv_alice' && m.role === 'ASSESSOR' && m.email === 'alice@example.mil'), 'she is a member (tenant_users row inserted)');

  const reuse = await accept(alice, aliceToken);
  assert(reuse.status === 409 && reuse.body?.reason === 'used', 'the token is single-use: a second accept -> 409', reuse.body);
  const stolen = await accept(person('u_inv_thief', 'alice@example.mil'), aliceToken);
  assert(stolen.status === 409, 'a used token is dead for everyone, even an account with the same email', stolen.status);
  const after = (await list()).find((i) => i.id === aliceInvite.id)!;
  assert(after.status === 'ACCEPTED' && after.acceptedByUserId === 'u_inv_alice' && Boolean(after.acceptedAt), 'the invitation is marked ACCEPTED with who and when');
  assert((await preview(aliceToken)).body?.invitation?.status === 'ACCEPTED', 'and the preview says so');

  console.log('\n--- Single use under concurrency ---');
  const raceInvite = await inv(owner, { email: 'race@example.mil', role: 'VIEWER' });
  const racer = person('u_inv_racer', 'race@example.mil');
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => accept(racer, raceInvite.body?.token)));
  const wins = results.filter((r) => r.status === 200).length;
  assert(wins === 1 && results.filter((r) => r.status === 409).length === 4, 'five simultaneous accepts: exactly one succeeds, four get 409', results.map((r) => r.status));

  console.log('\n--- Roles are never lowered, only raised ---');
  await call('POST', `/tenants/${tenantId}/members`, owner, tenantId, { userId: 'u_inv_coowner', email: 'co@example.mil', role: 'TENANT_OWNER' });
  const coowner = person('u_inv_coowner', 'co@example.mil');
  const lower = await inv(owner, { email: 'co@example.mil', role: 'VIEWER' });
  const lowerAccept = await accept(coowner, lower.body?.token);
  assert(lowerAccept.status === 200 && lowerAccept.body?.role === 'TENANT_OWNER' && lowerAccept.body?.previousRole === 'TENANT_OWNER', 'accepting a VIEWER invitation does not demote an existing TENANT_OWNER', lowerAccept.body);
  assert(((await myTenants(coowner)).find((t) => t.id === tenantId))?.role === 'TENANT_OWNER', 'their role is unchanged');
  const upgrade = await inv(owner, { email: 'vi@example.mil', role: 'ASSESSOR' });
  await call('POST', `/tenants/${tenantId}/members`, owner, tenantId, { userId: 'u_inv_vi2', email: 'vi@example.mil', role: 'VIEWER' });
  const up = await accept(person('u_inv_vi2', 'vi@example.mil'), upgrade.body?.token);
  assert(up.body?.role === 'ASSESSOR' && up.body?.previousRole === 'VIEWER', 'but a higher invited role upgrades an existing member (VIEWER -> ASSESSOR)', up.body);

  console.log('\n--- Revoke ---');
  const toRevoke = await inv(owner, { email: 'revoked@example.mil', role: 'VIEWER' });
  assert((await call('DELETE', `/tenants/${tenantId}/invites/${toRevoke.body?.invitation.id}`, assessor, tenantId)).status === 403, 'an ASSESSOR cannot revoke (403)');
  const revoked = await call('DELETE', `/tenants/${tenantId}/invites/${toRevoke.body?.invitation.id}`, owner, tenantId);
  assert(revoked.status === 200 && revoked.body?.invitation?.status === 'REVOKED', 'the owner revokes (200)');
  const revokedAccept = await accept(person('u_inv_rev', 'revoked@example.mil'), toRevoke.body?.token);
  assert(revokedAccept.status === 410 && revokedAccept.body?.reason === 'revoked', 'a revoked token cannot be accepted (410)', revokedAccept.body);
  assert((await preview(toRevoke.body?.token)).body?.invitation?.status === 'REVOKED', 'the preview shows REVOKED');
  assert((await call('DELETE', `/tenants/${tenantId}/invites/${aliceInvite.id}`, owner, tenantId)).status === 409, 'an accepted invitation cannot be revoked (409): remove the member instead');
  assert((await call('DELETE', `/tenants/${tenantId}/invites/does-not-exist`, owner, tenantId)).status === 404, 'an unknown invitation -> 404');
  const foreign = await inv(otherOwner, { email: 'f@example.mil', role: 'VIEWER' }, otherTenant);
  assert((await call('DELETE', `/tenants/${otherTenant}/invites/${aliceInvite.id}`, otherOwner, otherTenant)).status === 404, "an invitation id from another tenant is not found (isolation)");
  assert((await list(otherOwner, otherTenant)).length === 1 && (await list()).every((i) => i.tenantId === tenantId), 'invitation lists are per tenant');
  void foreign;

  console.log('\n--- Duplicate invites: only the newest link works ---');
  const first = await inv(owner, { email: 'dup@example.mil', role: 'VIEWER' });
  const second = await inv(owner, { email: 'DUP@example.mil', role: 'ASSESSOR' });
  const dupUser = person('u_inv_dup', 'dup@example.mil');
  assert((await accept(dupUser, first.body?.token)).status === 410, 'the earlier invitation for the same email was revoked (410)');
  assert((await accept(dupUser, second.body?.token)).body?.role === 'ASSESSOR', 'the newest works');

  console.log('\n--- Expiry, extend and resend ---');
  const exp = await inv(owner, { email: 'late@example.mil', role: 'VIEWER' });
  const late = person('u_inv_late', 'late@example.mil');
  __expireInvitationForTests(exp.body?.invitation.id);
  assert((await list()).find((i) => i.id === exp.body?.invitation.id)?.status === 'EXPIRED', 'an invitation past its expiry is EXPIRED');
  const expiredAccept = await accept(late, exp.body?.token);
  assert(expiredAccept.status === 410 && expiredAccept.body?.reason === 'expired', 'an expired token cannot be accepted (410)', expiredAccept.body);
  assert((await preview(exp.body?.token)).body?.invitation?.status === 'EXPIRED', 'the preview shows EXPIRED');
  const extended = await call('POST', `/tenants/${tenantId}/invites/${exp.body?.invitation.id}/extend`, owner, tenantId, { days: 7 });
  assert(extended.status === 200 && extended.body?.invitation?.status === 'PENDING', 'extending revives it, with the SAME link', extended.body);
  const extDays = (new Date(extended.body?.invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
  assert(extDays > 6.9 && extDays < 7.1, 'counted from now when it had already expired', extDays);
  assert((await call('POST', `/tenants/${tenantId}/invites/${exp.body?.invitation.id}/extend`, owner, tenantId, { days: 0 })).status === 400, 'extend validates days (400)');
  assert((await accept(late, exp.body?.token)).status === 200, 'the original link now works');

  const rot = await inv(owner, { email: 'rotate@example.mil', role: 'VIEWER' });
  const rotated = await call('POST', `/tenants/${tenantId}/invites/${rot.body?.invitation.id}/resend`, owner, tenantId, {});
  assert(rotated.status === 200 && rotated.body?.token && rotated.body?.token !== rot.body?.token, 'resend issues a NEW token', rotated.status);
  assert((await preview(rot.body?.token)).status === 404, 'the old link stops working at once');
  assert((await accept(person('u_inv_rot', 'rotate@example.mil'), rotated.body?.token)).status === 200, 'the new link works');
  assert((await call('POST', `/tenants/${tenantId}/invites/${rot.body?.invitation.id}/resend`, owner, tenantId, {})).status === 409, 'an accepted invitation cannot be resent (409)');
  assert((await call('POST', `/tenants/${tenantId}/invites/${rot.body?.invitation.id}/resend`, assessor, tenantId, {})).status === 403, 'an ASSESSOR cannot resend (403)');

  console.log('\n--- Editing a pending invitation ---');
  const ed = await inv(owner, { email: 'edit@example.mil', role: 'VIEWER' });
  const patched = await call('PATCH', `/tenants/${tenantId}/invites/${ed.body?.invitation.id}`, owner, tenantId, { role: 'ASSESSOR', email: 'edited@example.mil' });
  assert(patched.status === 200 && patched.body?.invitation?.role === 'ASSESSOR' && patched.body?.invitation?.email === 'edited@example.mil', 'role and email can be edited before use');
  assert((await accept(person('u_inv_ed_old', 'edit@example.mil'), ed.body?.token)).status === 403, 'the OLD email can no longer use it (403)');
  assert((await accept(person('u_inv_ed', 'edited@example.mil'), ed.body?.token)).body?.role === 'ASSESSOR', 'the new email gets the edited role');
  assert((await call('PATCH', `/tenants/${tenantId}/invites/${ed.body?.invitation.id}`, owner, tenantId, { role: 'VIEWER' })).status === 409, 'an accepted invitation cannot be edited (409)');
  assert((await call('PATCH', `/tenants/${tenantId}/invites/${ed.body?.invitation.id}`, owner, tenantId, {})).status === 400, 'an empty edit -> 400');
  const mspInvite = await inv(msp, { email: 'mspinv@example.mil', role: 'MSP_ADMIN' });
  assert((await call('PATCH', `/tenants/${tenantId}/invites/${mspInvite.body?.invitation.id}`, owner, tenantId, { role: 'VIEWER' })).status === 403, "a TENANT_OWNER cannot edit an MSP_ADMIN's invitation (403)");
  assert((await call('DELETE', `/tenants/${tenantId}/invites/${mspInvite.body?.invitation.id}`, owner, tenantId)).status === 403, 'nor revoke it (403)');

  console.log('\n--- Removing members ---');
  const memberList = async () => ((await call('GET', `/tenants/${tenantId}/members`, owner, tenantId)).body?.members ?? []) as Json[];
  const del = (token: string, userId: string) => call('DELETE', `/tenants/${tenantId}/members/${userId}`, token, tenantId);
  assert((await del(assessor, 'u_inv_viewer')).status === 403, 'an ASSESSOR cannot remove members (403)');
  assert((await del(owner, 'u_inv_owner')).status === 403, 'you cannot remove yourself (403)');
  assert((await del(owner, 'u_nobody')).status === 404, 'removing a non-member -> 404');
  await call('POST', `/tenants/${tenantId}/members`, msp, tenantId, { userId: 'u_inv_mspmember', email: 'mm@test.mil', role: 'MSP_ADMIN' });
  assert((await del(owner, 'u_inv_mspmember')).status === 403, 'a TENANT_OWNER cannot remove an MSP_ADMIN (403)');
  const removed = await del(owner, 'u_inv_viewer');
  assert(removed.status === 200 && removed.body?.previousRole === 'VIEWER', 'the owner removes a member (200)');
  assert(!(await memberList()).some((m) => m.userId === 'u_inv_viewer'), 'they are gone from the member list');
  assert((await call('GET', '/controls', viewer, tenantId)).status === 403, 'and have lost access at once (403)');
  assert(!(await myTenants(viewer)).some((t) => t.id === tenantId), 'and the tenant disappears from their list');
  assert((await del(coowner, 'u_inv_owner')).status === 200, 'with two owners, one can remove the other');
  const lonely = await call('DELETE', `/tenants/${tenantId}/members/u_inv_coowner`, msp, tenantId);
  assert(lonely.status === 409 && /last tenant owner/i.test(lonely.body?.error), 'the LAST tenant owner cannot be removed (409)', lonely);

  console.log('\n--- Rate limiting (unauthenticated endpoints) ---');
  inviteRateLimiter.reset();
  let last = 0;
  for (let i = 0; i < 32; i++) {
    const r = await fetch(`${BASE}/invites/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'inv_' + 'y'.repeat(43) }) });
    last = r.status;
  }
  assert(last === 429, 'more than 30 attempts a minute from one address -> 429');
  inviteRateLimiter.reset();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  shutdown(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  shutdown(1);
});
