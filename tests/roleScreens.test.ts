import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TenantRole } from '../src/types/tenant';
import { TENANT_ROLES, ROLE_LABELS, rolesGrantableBy } from '../src/utils/roles';
import {
  ROLE_SHORT_LABELS, ROLE_DESCRIPTIONS, ROLE_OPTION_HINTS, ROLE_TEXT, MEMBER_ROLE_ORDER, INVITE_ROLE_ORDER,
  roleLabel, roleShortLabel, roleSummaryLine, roleOptionLabel, inviteRoleOptions, defaultInviteRole, requiresTwoStep,
  inviteTwoStepNote, teamRowView, teamIntroNote, matrixRoles, roleChangeNeedsConfirm, roleChangeConfirmText,
  teamActionErrorMessage, inviteErrorMessage,
} from '../src/data/roleView';
import { RoleBadge } from '../src/components/common/RoleBadge';

/**
 * The Admin role screens: the pure role view (descriptions, invite options, team rows, refusal messages) and the role badge.
 * Pure: it does not boot the server.
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const OWNER: TenantRole = 'TENANT_OWNER';
const ADMIN: TenantRole = 'TENANT_ADMIN';
const MSP: TenantRole = 'MSP_ADMIN';
const ASSESSOR: TenantRole = 'ASSESSOR';
const VIEWER: TenantRole = 'VIEWER';

console.log('--- R1/R2 labels ---');
for (const r of TENANT_ROLES) assert(roleLabel(r) === ROLE_LABELS[r], `R1: roleLabel(${r}) is the ROLE_LABELS value`);
assert(roleLabel(ADMIN) === 'Admin', 'R1: TENANT_ADMIN reads "Admin"');
assert(roleLabel('ADMIN') === 'Unknown role' && roleLabel(undefined) === 'Unknown role', 'R1: an unknown role reads "Unknown role"');
assert(
  same(TENANT_ROLES.map((r) => roleShortLabel(r)), ['Owner', 'Admin', 'MSP Admin', 'Assessor', 'Viewer']),
  'R2: short labels in TENANT_ROLES order'
);
assert(roleShortLabel('X') === 'Unknown', 'R2: an unknown role reads "Unknown"');

console.log('--- R3 descriptions ---');
assert(
  same(Object.keys(ROLE_DESCRIPTIONS).sort(), [...TENANT_ROLES].sort()) &&
    same(Object.keys(ROLE_SHORT_LABELS).sort(), [...TENANT_ROLES].sort()) &&
    same(Object.keys(ROLE_OPTION_HINTS).sort(), [...TENANT_ROLES].sort()),
  'R3: descriptions, short labels and hints cover exactly TENANT_ROLES'
);
const allText = JSON.stringify([ROLE_DESCRIPTIONS, ROLE_OPTION_HINTS, ROLE_TEXT]);
assert(!allText.includes('—'), 'R3: no em dash in any role text');
assert(!/\b(edit|upload)\b/i.test(ROLE_DESCRIPTIONS.ASSESSOR.can), 'R3: the Assessor description does not claim edit or upload');
assert(!/\b(edit|upload)\b/i.test(ROLE_DESCRIPTIONS.VIEWER.can), 'R3: the Viewer description does not claim edit or upload');
assert((ROLE_DESCRIPTIONS.TENANT_ADMIN.cannot ?? '').includes('delete programs'), 'R3: an Admin cannot delete programs');
assert((ROLE_DESCRIPTIONS.TENANT_ADMIN.cannot ?? '').includes('Owners or Admins'), 'R3: an Admin cannot manage Owners or Admins');
assert((ROLE_DESCRIPTIONS.VIEWER.cannot ?? '').includes('SSP imports'), 'R3: a Viewer cannot see SSP imports');
assert(ROLE_DESCRIPTIONS.ASSESSOR.can.includes('SSP imports'), 'R3: an Assessor reviews SSP imports');
assert(
  roleSummaryLine(VIEWER) === `${ROLE_DESCRIPTIONS.VIEWER.can} ${ROLE_DESCRIPTIONS.VIEWER.cannot}` &&
    roleSummaryLine(OWNER) === ROLE_DESCRIPTIONS.TENANT_OWNER.can,
  'R3: the summary line joins can and cannot, and is just can when nothing is excluded'
);

console.log('--- R4/R5 invite options ---');
assert(same(inviteRoleOptions(rolesGrantableBy(OWNER)), ['TENANT_ADMIN', 'ASSESSOR', 'VIEWER', 'TENANT_OWNER']), 'R4: an Owner can invite Admin, Assessor, Viewer, Owner');
assert(same(inviteRoleOptions(rolesGrantableBy(ADMIN)), ['ASSESSOR', 'VIEWER']), 'R4: an Admin can invite Assessor and Viewer');
assert(same(inviteRoleOptions(rolesGrantableBy(MSP)), inviteRoleOptions(rolesGrantableBy(OWNER))), 'R4: an MSP Admin gets the same options as an Owner (never MSP Admin)');
assert(same(inviteRoleOptions(rolesGrantableBy(VIEWER)), []) && same(inviteRoleOptions(rolesGrantableBy(ASSESSOR)), []), 'R4: Assessors and Viewers cannot invite');
assert(same(inviteRoleOptions(rolesGrantableBy(null)), []), 'R4: no role, no options');
for (const actor of [OWNER, ADMIN, MSP, ASSESSOR, VIEWER, null, undefined]) {
  const expected = INVITE_ROLE_ORDER.filter((r) => rolesGrantableBy(actor).includes(r));
  const grantableMinusMsp = rolesGrantableBy(actor).filter((r) => r !== 'MSP_ADMIN');
  assert(
    same(inviteRoleOptions(rolesGrantableBy(actor)), expected) &&
      same([...inviteRoleOptions(rolesGrantableBy(actor))].sort(), [...grantableMinusMsp].sort()),
    `R4: drift guard, the invite options for ${String(actor)} are rolesGrantableBy minus MSP Admin`
  );
}
assert(
  same([...INVITE_ROLE_ORDER].sort(), TENANT_ROLES.filter((r) => r !== 'MSP_ADMIN').sort()) &&
    same([...MEMBER_ROLE_ORDER].sort(), [...TENANT_ROLES].sort()),
  'R4: the display orders cover the roles with no gap or duplicate'
);
assert(defaultInviteRole(inviteRoleOptions(rolesGrantableBy(OWNER))) === 'TENANT_ADMIN', 'R5: the default for an Owner is Admin');
assert(defaultInviteRole(inviteRoleOptions(rolesGrantableBy(ADMIN))) === 'VIEWER', 'R5: the default for an Admin is Viewer');
assert(defaultInviteRole([]) === null, 'R5: no options, no default');
assert(defaultInviteRole(['ASSESSOR']) === 'ASSESSOR', 'R5: a single option is the default');

console.log('--- R6/R7 two-step verification ---');
const twoStep: Array<[TenantRole, string | null, boolean]> = [
  [ADMIN, 'privileged', true], [OWNER, 'privileged', true], [ASSESSOR, 'privileged', false], [VIEWER, 'all', true],
  [OWNER, 'off', false], [OWNER, null, false], [OWNER, '', false],
];
for (const [role, mode, want] of twoStep) {
  assert(requiresTwoStep(role, mode) === want, `R6: ${role} with mode ${JSON.stringify(mode)} is ${want}`);
}
assert(
  inviteTwoStepNote(ADMIN, 'privileged') === 'Admin accounts must use two-step verification on this installation. They are asked to set it up before they can continue.',
  'R7: the privileged note names the Admin role'
);
assert(
  inviteTwoStepNote(VIEWER, 'all') === 'Everyone on this installation must use two-step verification. They are asked to set it up before they can continue.',
  'R7: the "all" note covers everyone'
);
assert(inviteTwoStepNote(ASSESSOR, 'privileged') === null && inviteTwoStepNote(OWNER, 'off') === null, 'R7: no note for a read role in privileged mode or when off');
assert(inviteTwoStepNote(OWNER, null) === null && inviteTwoStepNote(OWNER, '') === null, 'R7: no note when the mode is unknown');

console.log('--- R8 team rows ---');
const row = (actor: TenantRole | null, memberRole: TenantRole, o: { self?: boolean; pending?: boolean; inv?: boolean; manage?: boolean } = {}) =>
  teamRowView({
    actor, canManageTenant: o.manage ?? (actor === OWNER || actor === ADMIN || actor === MSP), isSelf: o.self ?? false,
    isPending: o.pending ?? false, memberRole, hasInvitation: o.inv ?? false,
  });
{
  const r = row(ADMIN, OWNER);
  assert(r.control === 'badge' && r.note === 'Managed by a Tenant Owner' && !r.remove && !r.inviteActions && r.options.length === 0, 'R8: an Admin sees an Owner row as a badge with the Owner note');
}
{
  const r = row(ADMIN, ADMIN);
  assert(r.control === 'badge' && r.note === ROLE_TEXT.managedByOwner && !r.remove, 'R8: an Admin sees another Admin row as a badge with the Owner note');
}
{
  const r = row(ADMIN, ASSESSOR);
  assert(r.control === 'select' && same(r.options, ['ASSESSOR', 'VIEWER']) && r.remove && r.note === null, 'R8: an Admin can change and remove an Assessor, to Assessor or Viewer only');
}
{
  const r = row(ADMIN, VIEWER, { pending: true, inv: true });
  assert(r.control === 'badge' && r.inviteActions && !r.remove, 'R8: an Admin gets invite actions on a pending Viewer');
}
{
  const r = row(ADMIN, OWNER, { pending: true, inv: true });
  assert(!r.inviteActions && r.note === ROLE_TEXT.managedByOwner, 'R8: an Admin gets no invite actions on a pending Owner, and sees why');
}
{
  const r = row(ADMIN, MSP);
  assert(r.control === 'badge' && r.note === 'Managed by an MSP Admin', 'R8: an Admin sees an MSP row with the MSP note');
}
{
  const r = row(OWNER, ADMIN);
  assert(r.control === 'select' && same(r.options, ['TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER']) && r.remove, 'R8: an Owner can set an Admin to any non-MSP role and remove them');
}
{
  const r = row(OWNER, MSP);
  assert(r.control === 'badge' && r.note === ROLE_TEXT.managedByMsp && !r.remove, 'R8: an Owner sees an MSP row as a badge with the MSP note');
}
{
  const r = row(OWNER, OWNER, { self: true });
  assert(r.control === 'badge' && r.note === null && !r.remove && !r.inviteActions, 'R8: an Owner sees their own row as a badge with no note');
}
{
  const r = row(MSP, OWNER);
  assert(r.control === 'select' && same(r.options, [...MEMBER_ROLE_ORDER]) && r.remove, 'R8: an MSP Admin gets all 5 roles in MEMBER_ROLE_ORDER');
}
{
  const r = row(VIEWER, OWNER, { manage: false });
  assert(r.control === 'badge' && !r.remove && !r.inviteActions && r.note === null && r.options.length === 0, 'R8: a Viewer gets nothing and no note');
}
{
  const r = row(OWNER, VIEWER, { pending: true, inv: false });
  assert(!r.inviteActions && !r.remove, 'R8: a pending row with no invitation offers no invite actions');
}

console.log('--- R9/R10 intro and matrix ---');
assert(teamIntroNote(ADMIN, true) === ROLE_TEXT.adminIntro, 'R9: an Admin gets the Admin intro');
assert(teamIntroNote(VIEWER, false) === ROLE_TEXT.readOnlyIntro, 'R9: a Viewer gets the read-only intro');
assert(teamIntroNote(OWNER, true) === null && teamIntroNote(MSP, true) === null, 'R9: Owner and MSP Admin get no intro');
assert(same(matrixRoles(OWNER, [OWNER, VIEWER]), ['TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER']), 'R10: the matrix has the four customer roles');
assert(same(matrixRoles(MSP, []), ['MSP_ADMIN', 'TENANT_OWNER', 'TENANT_ADMIN', 'ASSESSOR', 'VIEWER']), 'R10: an MSP Admin sees MSP first');
assert(matrixRoles(VIEWER, [MSP])[0] === 'MSP_ADMIN', 'R10: an MSP member puts MSP first for everyone');

console.log('--- R11/R12 refusal messages ---');
assert(teamActionErrorMessage({ status: 403, reason: 'role_not_grantable' }, ADMIN, 'member', 'fb') === ROLE_TEXT.adminLimit, 'R11: role_not_grantable for an Admin is the Admin limit');
assert(teamActionErrorMessage({ status: 403, reason: 'role_not_grantable' }, OWNER, 'member', 'fb') === ROLE_TEXT.notGrantable, 'R11: role_not_grantable for an Owner is the generic one');
assert(teamActionErrorMessage({ status: 403, reason: 'owner_required' }, ADMIN, 'member', 'fb') === ROLE_TEXT.ownerRequired, 'R11: owner_required');
assert(teamActionErrorMessage({ status: 409, message: 'x' }, OWNER, 'member', 'fb') === ROLE_TEXT.lastOwner, 'R11: a bare 409 on a member route is the last Owner');
assert(teamActionErrorMessage({ status: 409, reason: 'last_owner' }, OWNER, 'invite', 'fb') === ROLE_TEXT.lastOwner, 'R11: last_owner by code');
assert(teamActionErrorMessage({ status: 409, reason: 'not_pending', message: 'srv' }, OWNER, 'invite', 'fb') === 'srv', 'R11: another invitation 409 keeps the server message');
assert(teamActionErrorMessage({ status: 409, message: 'srv' }, OWNER, 'invite', 'fb') === 'srv', 'R11: a bare 409 on an invitation route is not the last Owner');
assert(teamActionErrorMessage(new Error(''), OWNER, 'member', 'fb') === 'fb', 'R11: an empty message falls back');
assert(teamActionErrorMessage(null, OWNER, 'member', 'fb') === 'fb' && teamActionErrorMessage(undefined, OWNER, 'invite', 'fb') === 'fb', 'R11: a null or undefined error falls back');
assert(inviteErrorMessage({ status: 403, reason: 'role_not_grantable' }, ADMIN, VIEWER, 'fb') === ROLE_TEXT.pendingInviteLocked, 'R12: a refusal for a grantable role means a locked pending invitation');
assert(inviteErrorMessage({ status: 403, reason: 'role_not_grantable' }, ADMIN, OWNER, 'fb') === ROLE_TEXT.adminLimit, 'R12: a refusal for an Owner invite is the Admin limit');
{
  const m = 'Platform administrators cannot be invited to a tenant. Ask the operator.';
  assert(inviteErrorMessage({ status: 403, reason: 'platform_admin_email', message: m }, OWNER, VIEWER, 'fb') === m, 'R12: another refusal keeps the server message');
}

console.log('--- R13/R14 option labels and confirmations ---');
assert(roleOptionLabel('ASSESSOR') === 'Assessor: read-only, also reviews SSP imports', 'R13: the Assessor option is read-only');
assert(TENANT_ROLES.every((r) => !roleOptionLabel(r).includes('can work on controls')), 'R13: no option claims the old "can work on controls"');
assert(
  roleChangeNeedsConfirm(ASSESSOR, OWNER) && roleChangeNeedsConfirm(OWNER, ADMIN) && !roleChangeNeedsConfirm(ASSESSOR, VIEWER) &&
    !roleChangeNeedsConfirm(ADMIN, VIEWER) && roleChangeNeedsConfirm(VIEWER, MSP),
  'R14: only changes into or out of Owner or MSP Admin need a confirmation'
);
assert(
  roleChangeConfirmText('a@x.mil', OWNER, ADMIN) === 'Change a@x.mil from Tenant Owner to Admin? They will no longer control who has access.',
  'R14: demoting an Owner says they lose control of access'
);
assert(roleChangeConfirmText('a@x.mil', ASSESSOR, OWNER) === `Make a@x.mil a Tenant Owner? ${ROLE_TEXT.ownerCaution}`, 'R14: promoting to Owner repeats the caution');
assert(roleChangeConfirmText('a@x.mil', ADMIN, VIEWER) === 'Change a@x.mil from Admin to Viewer?', 'R14: a plain change names both roles');

console.log('--- R15 RoleBadge ---');
for (const r of TENANT_ROLES) {
  const html = renderToStaticMarkup(React.createElement(RoleBadge, { role: r }));
  assert(html.includes(ROLE_LABELS[r]) && html.includes('aria-hidden="true"') && !html.includes(r), `R15: the ${r} badge shows its label, hides the icon from readers and never the raw id`);
}
assert(!renderToStaticMarkup(React.createElement(RoleBadge, { role: ADMIN })).includes('TENANT_ADMIN'), 'R15: the Admin badge reads "Admin", not TENANT_ADMIN');

// --- Source pins on the screens and the wording drift guard: appended by WP4-E, after the screens are built. ---
const readSrc = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const invite = readSrc('src/components/settings/InviteStaffModal.tsx');
const team = readSrc('src/components/settings/TeamSettingsModal.tsx');
const programsPage = readSrc('src/components/programs/ProgramsPage.tsx');
const acceptPage = readSrc('src/pages/AcceptInvitePage.tsx');
const setupPage = readSrc('src/pages/SetupPage.tsx');
const profile = readSrc('src/components/auth/UserProfileDropdown.tsx');
const sidebar = readSrc('src/components/layout/Sidebar.tsx');
const superAdmin = readSrc('src/components/admin/SuperAdminDashboard.tsx');
const editInvite = readSrc('src/components/admin/EditInvitationModal.tsx');

console.log('--- S1 invite dialog ---');
assert(invite.includes('inviteRoleOptions(grantableRoles)') && invite.includes('defaultInviteRole(options)'), 'S1: the options come from the roles the caller may grant, the default from defaultInviteRole');
assert(invite.includes('roleLabel(createdResult.invitation.role)'), 'S1: the success state shows the role label, not the raw id');
assert(invite.includes('role="radiogroup"') && invite.includes('role="radio"') && invite.includes('onKeyDown={radioGroupKeyDown}') && invite.includes('aria-checked={selected}'), 'S1: the roles are a radiogroup with arrow-key handling');
assert(invite.includes('htmlFor={`${uid}-email`}') && invite.includes('id={`${uid}-email`}') && invite.includes('aria-labelledby={`${uid}-role-label`}'), 'S1: the email label and the role group are tied to their inputs');
assert(invite.includes('z-[60]') && !invite.includes('z-50'), 'S1: the invite dialog stacks above the team dialog (z-[60])');
assert(invite.includes('inviteErrorMessage(err, currentRole, role,') && invite.includes('<ErrorNotice message={submitError}'), 'S1: a refusal is shown through the mapped error message');
assert(invite.includes('ROLE_TEXT.ownerCaution') && invite.includes('inviteTwoStepNote(role, mfaMode)'), 'S1: the Owner caution and the two-step note are shown');
assert(!invite.includes('Can edit all 17 CMMC practices') && !/Assessor[^\n]*(can edit|upload)/i.test(invite) && !invite.includes("useState<'ASSESSOR' | 'VIEWER'>"), 'S1: no claim that an Assessor can edit or upload, no two-role state');
assert(!/console\./.test(invite), 'S1: the invite dialog logs nothing');

console.log('--- S2 team screen ---');
assert(team.includes('teamRowView(') && team.includes('<RoleBadge role={member.role}') && !team.includes('getRoleBadge'), 'S2: rows come from teamRowView and show the shared RoleBadge');
assert(team.includes('{row.note && <span') && team.includes('row.inviteActions') && team.includes('row.remove'), 'S2: the reason line is rendered as text and the actions follow the row view');
assert(
  team.includes('aria-label={`Resend the invitation to ${member.email}`}') && team.includes('aria-label={`Revoke the invitation for ${member.email}`}') && team.includes('aria-label={`Remove ${member.email}`}'),
  'S2: resend, revoke and remove have accessible names'
);
assert(team.includes('aria-label={`Role of ${member.name || member.email}`}'), 'S2: the role select has an accessible name');
assert(team.includes('roleChangeNeedsConfirm(member.role, next)') && team.includes('roleChangeConfirmText(') && team.includes('role="alertdialog"') && team.includes('aria-labelledby={`${uid}-pending`}'), 'S2: a role change into or out of Owner asks for a confirmation that is named by its text');
assert(team.includes('teamActionErrorMessage(err, currentRole, op,') && team.includes('<ErrorNotice message={actionError || teamError}'), 'S2: a refusal is shown through the mapped error message');
assert(team.includes('const canEditScope = isSuperAdmin') && team.includes('ROLE_TEXT.scopePlatformOnly') && team.includes('<ErrorNotice message={scopeError} />') && !team.includes('isOwnerOrAdmin'), 'S2: the framework scope controls are gated on the platform admin');
assert(team.includes('matrixRoles(currentRole, members.map(m => m.role))') && team.includes('ROLE_DESCRIPTIONS[r].can') && team.includes('aria-expanded={showRoleInfo}'), 'S2: the role matrix is built from matrixRoles and ROLE_DESCRIPTIONS');
assert(!team.includes('Can edit all 17 CMMC') && !team.includes('Only TENANT_OWNER or Super Admins') && !team.includes('<option value="TENANT_OWNER">'), 'S2: none of the old role claims remain');
assert(team.includes('copyText(') && team.includes('htmlFor="team-invite-link-fallback"') && !/console\./.test(team), 'S2: the invitation-link copy fallback is kept and nothing is logged');

console.log('--- S3 programs page ---');
assert(programsPage.includes('canDeletePrograms && !program.vmTarget'), 'S3: Delete is shown only to a role that may delete a program');
assert(programsPage.includes('owner_required: ROLE_TEXT.programDeleteRefused'), 'S3: an owner_required refusal is mapped to a readable message');
assert(programsPage.includes('archivedOpen && canManagePrograms && !canDeletePrograms') && programsPage.includes('ROLE_TEXT.archivedDeleteOwnerOnly'), 'S3: an Admin sees the owner-only note on the archived list');
assert(programsPage.includes('ROLE_TEXT.programsReadOnly'), 'S3: a read-only role sees the read-only text');

console.log('--- S4 accept page ---');
assert(acceptPage.includes('roleLabel(invitation.role)') && acceptPage.includes('roleSummaryLine(invitation.role)') && !acceptPage.includes("'TENANT_OWNER' ? 'TENANT_OWNER'"), 'S4: the page shows the role label and its summary, not the raw id');
assert(acceptPage.includes('inviteTwoStepNote(invitation.role, invitation.mfaMode)') && acceptPage.includes('canRoleWrite(invitation.role) ? ROLE_TEXT.acceptTwoStep : null'), 'S4: the two-step note is exact when the server reports its mode, else the generic sentence for a write role');
assert(ROLE_TEXT.acceptTwoStep.includes('two-step verification for Owners and Admins'), 'S4: the generic sentence names Owners and Admins');

console.log('--- S5 setup page ---');
assert(setupPage.includes('INVITE_ROLE_ORDER.map(') && setupPage.includes('roleOptionLabel(value)') && setupPage.includes("useState<InviteRole>('TENANT_ADMIN')"), 'S5: the roles come from INVITE_ROLE_ORDER and the default is Admin');
assert(setupPage.includes('aria-describedby={`${ids.role}-hint`}') && setupPage.includes('roleSummaryLine(inviteRole)') && !setupPage.includes('can work on controls and evidence'), 'S5: the selected role is described and nobody is said to work on controls');

console.log('--- S6 role display ---');
assert(profile.includes('{isSuperAdmin && (') && profile.indexOf('{isSuperAdmin && (', profile.indexOf('Quick RBAC Role Simulation')) < profile.indexOf('SIMULATED_ROLES.map'), 'S6: the simulate-role control is only for the platform admin');
assert(profile.includes('SIMULATED_ROLES.map') && profile.includes('aria-pressed={currentRole === role}') && profile.includes('<RoleBadge role={currentRole}'), 'S6: the simulator buttons say which one is on, the role line is a RoleBadge');
assert(sidebar.includes('roleShortLabel(currentRole)') && !sidebar.includes('function getRoleLabel'), 'S6: the sidebar badge uses the short label');
assert(superAdmin.includes('<RoleBadge role={inv.role}'), 'S6: the admin console shows invitation roles as RoleBadge');
assert(editInvite.includes('role="radiogroup"') && editInvite.includes('onKeyDown={radioGroupKeyDown}') && editInvite.includes('MEMBER_ROLE_ORDER.filter(') && !editInvite.includes('Evaluate controls & upload evidence'), 'S6: the edit-invitation dialog has a role radiogroup without the false claim');
assert(editInvite.includes("teamActionErrorMessage(err, null, 'invite',"), 'S6: the edit-invitation dialog maps refusals');

console.log('--- S7 wording drift guard ---');
// Phrasings that say only an owner or MSP admin may write (an Admin may now too). Case-insensitive.
const OLD_WRITE_WORDING =
  /Tenant Owner (or|\/|and) MSP Admin|owners? (or|\/|and) (an? )?MSP admin(istrator)?s?|only a tenant owner can resolve|TENANT_OWNER (\/|and|or) MSP_ADMIN|owner \/ MSP( only)?\b/i;
// The old lowercase "Ask a tenant owner" is case-sensitive on purpose: the new "Ask a Tenant Owner or Admin" must not match
const OLD_ASK_OWNER = /Ask a tenant owner/;
// Lines that are genuinely about owner-level actions (delete a program, manage Owners and Admins), which are Tenant Owner / MSP Admin only
const OWNER_LEVEL_ALLOWED: Array<{ file: string; line: RegExp; why: string }> = [
  { file: 'src/context/TenantContext.tsx', line: /isOwnerLevel|what an Admin|Who may delete a program/, why: 'isOwnerLevel / canDeletePrograms: only Tenant Owner and MSP Admin' },
  { file: 'src/components/programs/ProgramsPage.tsx', line: /delete is Owner-level only/, why: 'deleting a program is owner-level' },
];
const srcFiles: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (rel === 'src/data/frameworks' || rel === 'src/data/stigs') continue;
      walk(rel);
    } else if (/\.tsx?$/.test(entry.name)) srcFiles.push(rel);
  }
};
walk('src');
const driftHits: string[] = [];
for (const rel of srcFiles) {
  readSrc(rel).split('\n').forEach((text, i) => {
    if (!OLD_WRITE_WORDING.test(text) && !OLD_ASK_OWNER.test(text)) return;
    if (OWNER_LEVEL_ALLOWED.some((a) => a.file === rel && a.line.test(text))) return;
    driftHits.push(`${rel}:${i + 1}`);
  });
}
assert(srcFiles.length > 100, 'S7: the guard scans the source tree', srcFiles.length);
assert(driftHits.length === 0, 'no screen says "Tenant Owner or MSP Admin": the writers are a Tenant Owner or Admin', driftHits);

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
