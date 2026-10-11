import './testEnv';
// The browser ApiClient resolves its base URL from VITE_API_URL at import time; point it at the test server first.
process.env.VITE_API_URL = 'http://127.0.0.1:8080';

import { server } from '../server/index';
import {
  buildTeam,
  mergeServerInvitations,
  parseServerInvitations,
  parseServerMembers,
  pendingMemberId,
  persistableInvitations,
  toTenantInvitation,
  ServerInvitation,
} from '../src/data/teamSync';
import type { Tenant, TenantInvitation } from '../src/types/tenant';

/**
 * Client side of server-backed invitations and teams: the pure mapping the TenantContext uses, and a contract test that
 * drives the real ApiClient methods against the real server (create / list / resend / extend / edit / revoke / preview /
 * accept / member role / remove) including the error messages the UI shows.
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

const srvInv = (over: Partial<ServerInvitation> & { id: string }): ServerInvitation => ({
  tenantId: 't1',
  email: 'a@b.mil',
  role: 'ASSESSOR',
  createdBy: 'Owner (o@b.mil)',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-15T00:00:00.000Z',
  acceptedAt: null,
  acceptedByUserId: null,
  revokedAt: null,
  status: 'PENDING',
  ...over,
});
const tenant = { name: 'Acme', systemName: 'Sys', cageCode: '1ABC2', licenseTier: 'DEFENSE_PRO' } as Pick<Tenant, 'name' | 'systemName' | 'cageCode' | 'licenseTier'>;

function pureTests() {
  console.log('--- parseServerInvitations / parseServerMembers ---');
  const parsed = parseServerInvitations({
    invitations: [
      srvInv({ id: 'i1' }),
      { ...srvInv({ id: 'i2' }), role: 'ADMIN' }, // unknown role: dropped
      { ...srvInv({ id: 'i3' }), status: 'WEIRD' }, // unknown status: dropped
      { tenantId: 't1', role: 'VIEWER', status: 'PENDING' }, // no id
      null,
      'x',
    ],
  });
  assert(parsed.length === 1 && parsed[0].id === 'i1', 'malformed invitations, unknown roles and statuses are dropped', parsed.map((p) => p.id));
  assert(parseServerInvitations(null).length === 0 && parseServerInvitations({}).length === 0, 'non-list payloads parse to empty');
  const members = parseServerMembers({ members: [{ userId: 'u1', email: 'e', name: 'N', tenantId: 't1', role: 'VIEWER', createdAt: 'c' }, { userId: 'u2', role: 'GOD' }, { role: 'VIEWER' }] });
  assert(members.length === 1 && members[0].userId === 'u1', 'members without a user id or with an unknown role are dropped');

  console.log('\n--- toTenantInvitation ---');
  const ui = toTenantInvitation(srvInv({ id: 'i1', role: 'TENANT_OWNER' }), tenant, 'inv_secret');
  assert(ui.serverBacked === true && ui.token === 'inv_secret' && ui.tenantName === 'Acme' && ui.invitedBy === 'Owner (o@b.mil)', 'maps a server invitation, with the token only when one is supplied');
  assert(ui.type === 'TENANT_ONBOARDING', 'an owner invitation is the onboarding hand-over');
  assert(toTenantInvitation(srvInv({ id: 'i2', role: 'VIEWER' }), tenant).type === 'STAFF_INVITE' && toTenantInvitation(srvInv({ id: 'i2' }), tenant).token === '', 'other roles are staff invites; a listed invitation has NO token');
  assert(toTenantInvitation(srvInv({ id: 'i3', status: 'ACCEPTED', acceptedAt: '2026-01-02T00:00:00.000Z', acceptedByUserId: 'u9' }), undefined).acceptedByUserId === 'u9', 'accepted-by details carry over (and a missing tenant falls back to its id)');

  console.log('\n--- buildTeam ---');
  const team = buildTeam(
    't1',
    [{ userId: 'u1', email: 'owner@b.mil', name: 'Olivia', tenantId: 't1', role: 'TENANT_OWNER', createdAt: '2026-01-01T00:00:00.000Z' }],
    [srvInv({ id: 'p1', email: 'new.hire@b.mil' }), srvInv({ id: 'a1', status: 'ACCEPTED' }), srvInv({ id: 'r1', status: 'REVOKED' }), srvInv({ id: 'e1', status: 'EXPIRED' })],
    { p1: 'inv_known' }
  );
  assert(team.length === 2 && team[0].status === 'ACTIVE' && team[1].status === 'PENDING_INVITE', 'active members first, then ONLY pending invitations (accepted / revoked / expired are not rows)', team.map((t) => t.id));
  assert(team[0].id === 'u1' && team[0].userId === 'u1', 'an active row is keyed by user id');
  assert(team[1].id === pendingMemberId('p1') && team[1].invitationId === 'p1' && team[1].name === 'New Hire', 'a pending row is keyed by invitation id with a readable name');
  assert(team[1].invitationToken === 'inv_known', 'the token shows only for a link created in this session');
  assert(buildTeam('t1', [], [srvInv({ id: 'p2' })]).at(0)?.invitationToken === undefined, 'otherwise a pending row has no token (use Resend)');

  console.log('\n--- mergeServerInvitations / persistence ---');
  const legacy: TenantInvitation = { ...toTenantInvitation(srvInv({ id: 'L1', tenantId: 't1' }), tenant, 'legacy-token'), serverBacked: false };
  const otherTenant = toTenantInvitation(srvInv({ id: 'O1', tenantId: 't2' }), tenant);
  const staleServer = toTenantInvitation(srvInv({ id: 'S1', tenantId: 't1' }), tenant);
  const merged = mergeServerInvitations([legacy, otherTenant, staleServer], 't1', [toTenantInvitation(srvInv({ id: 'N1', tenantId: 't1' }), tenant)]);
  assert(merged.map((i) => i.id).sort().join() === 'L1,N1,O1', "replaces ONLY this tenant's server-backed invitations; legacy and other tenants' are kept", merged.map((i) => i.id));
  assert(mergeServerInvitations([staleServer], 't1', []).length === 0, 'a revoked/removed invitation disappears when the server stops listing it');
  const toStore = persistableInvitations([legacy, otherTenant, staleServer]);
  assert(toStore.length === 1 && toStore[0].id === 'L1', 'localStorage never receives server-issued invitations (and so never a token)', toStore.map((i) => i.id));
}

// ------------------------------------------------------------------------------------------------ contract

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string, email = `${sub}@test.mil`) => jwt({ sub, email, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
const rejection = async (p: Promise<unknown>) =>
  p.then(() => null, (e: { status: number; message: string }) => ({ status: e.status, message: e.message }));

async function contractTests() {
  console.log('\n--- Contract: ApiClient against the real server ---');
  const { ApiClient } = await import('../src/services/apiClient');

  const owner = person('u_ts_owner');
  const created = await (await fetch(`${BASE}/tenants`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'TeamSync Org' }) })).json() as { tenant: { id: string } };
  const t = created.tenant.id;

  const issued = await ApiClient.createInvite(t, { email: 'Hire@Example.mil', role: 'ASSESSOR' }, owner);
  assert(issued.invitation.status === 'PENDING' && issued.invitation.email === 'hire@example.mil' && /^inv_/.test(issued.token), 'createInvite returns a parsed invitation and the one-time token');
  assert(!('token' in issued.invitation), 'the parsed invitation has no token field');

  const listed = await ApiClient.listInvites(t, owner);
  assert(listed.length === 1 && listed[0].id === issued.invitation.id, 'listInvites parses the list');
  const teamBefore = buildTeam(t, await ApiClient.listMembers(t, owner), listed, { [issued.invitation.id]: issued.token });
  assert(teamBefore.length === 2 && teamBefore[0].role === 'TENANT_OWNER' && teamBefore[1].invitationId === issued.invitation.id, 'members + invitations build the team list (owner + one pending row)', teamBefore.map((r) => [r.id, r.status]));

  const preview = await ApiClient.previewInvite(issued.token);
  assert(preview?.tenantName === 'TeamSync Org' && preview.role === 'ASSESSOR' && preview.status === 'PENDING', 'previewInvite works with the token alone');
  assert((await ApiClient.previewInvite('inv_' + 'q'.repeat(43))) === null, 'an unknown token previews as null (not an error)');

  const edited = await ApiClient.updateInvite(t, issued.invitation.id, { role: 'VIEWER' }, owner);
  assert(edited.role === 'VIEWER', 'updateInvite changes the role');
  const extended = await ApiClient.extendInvite(t, issued.invitation.id, 7, owner);
  assert(new Date(extended.expiresAt).getTime() > new Date(issued.invitation.expiresAt).getTime(), 'extendInvite pushes the expiry out');
  const resent = await ApiClient.resendInvite(t, issued.invitation.id, undefined, owner);
  assert(resent.token !== issued.token && (await ApiClient.previewInvite(issued.token)) === null, 'resendInvite returns a NEW token and kills the old one');

  const wrong = await rejection(ApiClient.acceptInvite(resent.token, person('u_ts_mallory', 'mallory@example.mil')));
  assert(wrong?.status === 403 && /different email/i.test(wrong.message), 'accepting with the wrong email -> 403 with a clear message', wrong);
  const hire = person('u_ts_hire', 'hire@example.mil');
  const accepted = await ApiClient.acceptInvite(resent.token, hire);
  assert(accepted.tenantId === t && accepted.role === 'VIEWER' && accepted.previousRole === null, 'acceptInvite adds the invitee with the (edited) role');
  const again = await rejection(ApiClient.acceptInvite(resent.token, hire));
  assert(again?.status === 409 && /already been used/i.test(again.message), 'a second accept -> 409 "already used"', again);
  const noSession = await rejection(ApiClient.acceptInvite(resent.token, undefined));
  assert(noSession?.status === 401, 'no session -> 401 before any request');
  const garbage = await rejection(ApiClient.acceptInvite('not-a-token', hire));
  assert(garbage?.status === 404, 'a malformed token -> 404');

  const after = buildTeam(t, await ApiClient.listMembers(t, owner), await ApiClient.listInvites(t, owner));
  assert(after.length === 2 && after.every((r) => r.status === 'ACTIVE') && after.some((r) => r.userId === 'u_ts_hire'), 'the team now shows the new member as ACTIVE and no pending row');

  // revoke: 410 for the invitee
  const second = await ApiClient.createInvite(t, { email: 'later@example.mil', role: 'VIEWER' }, owner);
  await ApiClient.revokeInvite(t, second.invitation.id, owner);
  const revoked = await rejection(ApiClient.acceptInvite(second.token, person('u_ts_later', 'later@example.mil')));
  assert(revoked?.status === 410 && /revoked/i.test(revoked.message), 'a revoked invitation -> 410 with a readable message (410 is mapped)', revoked);

  // members: role change and removal through the client
  await ApiClient.setMemberRole(t, { userId: 'u_ts_hire', email: 'hire@example.mil', name: 'Hire', role: 'ASSESSOR' }, owner);
  assert((await ApiClient.listMembers(t, owner)).find((m) => m.userId === 'u_ts_hire')?.role === 'ASSESSOR', 'setMemberRole changes a role');
  const denied = await rejection(ApiClient.removeMember(t, 'u_ts_owner', hire));
  assert(denied?.status === 403, 'a non-admin cannot remove members (403)', denied);
  await ApiClient.removeMember(t, 'u_ts_hire', owner);
  assert(!(await ApiClient.listMembers(t, owner)).some((m) => m.userId === 'u_ts_hire'), 'removeMember removes them');
  const forbidden = await rejection(ApiClient.listInvites(t, hire));
  assert(forbidden?.status === 403, 'a removed user can no longer list invitations (403)', forbidden);
}

async function run() {
  pureTests();
  await new Promise((r) => setTimeout(r, 500));
  await contractTests();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
