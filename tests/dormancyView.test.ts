import fs from 'node:fs';
import path from 'node:path';
import {
  DORMANCY_TEXT, NEVER_SIGNED_IN, RESTORE_ERROR_TEXT, blockedMemberRows, canRestoreMember, disabledDetail, dormancyPolicyText, formatDateTime, formatLastSignIn,
  isDormancyBlocked, memberAccountBadge, memberSignInText, parseDisabledReason, parseDormantDays, restoreCodeReady, restoreErrorMessage, restoreRefreshesTeam,
  restoreSuccessText, showLastSignInColumn, teamDormancyPolicyText, type DormancyMember,
} from '../src/data/dormancyView';

/**
 * Dormant accounts (#257): the pure helpers and copy shared by the admin console and the team screen, plus source checks on the restore dialog
 * (the code is cleared, nothing is logged or stored) and on how the team context loads the period. No server.
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

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const ISO = '2026-04-02T10:20:30.000Z';
const member = (over: Partial<DormancyMember>): DormancyMember => ({ id: 'u1', userId: 'u1', email: 'a@x.test', role: 'VIEWER', status: 'ACTIVE', lastLoginAt: ISO, accountDisabled: true, disabledReason: 'dormant', disabledAt: ISO, ...over });

function main() {
  console.log('--- D1 / D2 parsing ---');
  assert(parseDormantDays(90) === 90 && parseDormantDays(0) === 0 && parseDormantDays(-1) === null && parseDormantDays(1.5) === null && parseDormantDays('90') === null && parseDormantDays(undefined) === null, 'D1 the period is a non-negative integer, else null');
  assert(parseDisabledReason('dormant') === 'dormant' && parseDisabledReason('admin') === 'admin' && parseDisabledReason('x') === null && parseDisabledReason(null) === null, 'D2 the disabled reason is admin, dormant or null');

  console.log('\n--- D3 formatting ---');
  assert(formatLastSignIn(null) === NEVER_SIGNED_IN && formatLastSignIn(undefined) === 'Never signed in' && formatLastSignIn('bad') === 'bad' && formatLastSignIn(ISO) === new Date(ISO).toLocaleString(), 'D3 last sign-in: never, an unreadable value as is, else local time');
  assert(formatDateTime(null) === 'Not recorded' && formatDateTime(ISO) === new Date(ISO).toLocaleString(), 'D3 a date: not recorded, else local time');

  console.log('\n--- D4 policy text ---');
  assert(dormancyPolicyText(null) === null, 'D4 no period reported, no policy line');
  assert(dormancyPolicyText(0) === 'Inactive accounts are not disabled automatically on this installation (ACCOUNT_DORMANT_DAYS is 0).', 'D4 a period of 0 says automatic disabling is off');
  assert(dormancyPolicyText(90) === 'Accounts with no sign-in for 90 days are disabled automatically (ACCOUNT_DORMANT_DAYS). Restore one with its Restore button.' && (dormancyPolicyText(1) ?? '').includes('1 day are'), 'D4 the period in days, singular for 1');
  assert(teamDormancyPolicyText(null) === 'These accounts were blocked automatically because nobody signed in to them for a long time.' && teamDormancyPolicyText(0) === 'Automatic blocking for inactivity is now turned off, but these accounts were blocked before.' && teamDormancyPolicyText(90) === 'Accounts with no sign-in for 90 days are blocked automatically.', 'D4 the team screen texts');

  console.log('\n--- D5 disabled detail ---');
  assert(disabledDetail('dormant', null) === 'Disabled for inactivity' && (disabledDetail('admin', ISO) ?? '').startsWith('Disabled by an administrator on ') && disabledDetail(null, null) === null, 'D5 who disabled the account and when');
  assert(disabledDetail('dormant', ISO) === `Disabled for inactivity on ${new Date(ISO).toLocaleString()}` && disabledDetail(null, ISO) === `Disabled on ${new Date(ISO).toLocaleString()}` && disabledDetail('admin', null) === 'Disabled by an administrator', 'D5 the other combinations');

  console.log('\n--- D6 blocked for inactivity ---');
  assert(isDormancyBlocked(member({})) && !isDormancyBlocked(member({ disabledReason: 'admin' })) && !isDormancyBlocked(member({ status: 'PENDING_INVITE' })) && !isDormancyBlocked(member({ accountDisabled: false })) && !isDormancyBlocked(member({ accountDisabled: undefined })), 'D6 only an active, disabled, dormant member is blocked');

  console.log('\n--- D7 who may restore ---');
  assert(canRestoreMember('TENANT_OWNER', 'ASSESSOR', false), 'D7 an Owner restores an Assessor');
  assert(!canRestoreMember('TENANT_OWNER', 'MSP_ADMIN', false), 'D7 an Owner does not restore an MSP Admin');
  assert(canRestoreMember('MSP_ADMIN', 'MSP_ADMIN', false), 'D7 an MSP Admin restores an MSP Admin');
  assert(!canRestoreMember('TENANT_ADMIN', 'VIEWER', false), 'D7 a Tenant Admin does not restore');
  assert(!canRestoreMember('TENANT_OWNER', 'VIEWER', true), 'D7 nobody restores themselves');
  assert(!canRestoreMember('VIEWER', 'VIEWER', false) && !canRestoreMember(null, 'VIEWER', false) && !canRestoreMember(undefined, 'VIEWER', false), 'D7 a Viewer or no role does not restore');

  console.log('\n--- D8 blocked rows ---');
  const rows = blockedMemberRows([
    member({ id: 'm2', userId: undefined, email: 'zed@x.test', role: 'ASSESSOR' }),
    member({ id: 'm1', userId: 'user-1', email: 'amy@x.test', role: 'MSP_ADMIN' }),
    member({ id: 'm3', email: 'ok@x.test', accountDisabled: false }),
    member({ id: 'm4', email: 'adm@x.test', disabledReason: 'admin' }),
  ], 'TENANT_OWNER', 'me@x.test');
  assert(same(rows.map((r) => r.email), ['amy@x.test', 'zed@x.test']), 'D8 only blocked members, sorted by email', rows);
  assert(rows[0].userId === 'user-1' && rows[1].userId === 'm2', 'D8 the user id falls back to the row id');
  assert(rows[0].canRestore === false && rows[0].note === DORMANCY_TEXT.mspRestores && rows[1].canRestore === true && rows[1].note === null, 'D8 an Owner cannot restore an MSP Admin (the note says who can) but can restore an Assessor');
  const adminRows = blockedMemberRows([member({ email: 'a@x.test', role: 'VIEWER' }), member({ id: 'u2', userId: 'u2', email: 'b@x.test', role: 'ASSESSOR' })], 'TENANT_ADMIN', 'me@x.test');
  assert(adminRows.length === 2 && adminRows.every((r) => !r.canRestore && r.note === DORMANCY_TEXT.ownerRestores), 'D8 a Tenant Admin sees the rows but restores none, and is told an Owner can');
  assert(blockedMemberRows([member({ email: 'ME@x.test', role: 'VIEWER' })], 'TENANT_OWNER', 'me@x.test')[0].canRestore === false, 'D8 the caller cannot restore their own row (email compared without case)');
  assert(rows[0].lastSignIn === new Date(ISO).toLocaleString() && rows[0].blockedOn === new Date(ISO).toLocaleString(), 'D8 the dates are formatted');

  console.log('\n--- D9 team table cells ---');
  assert(memberSignInText(member({ status: 'PENDING_INVITE' })) === 'Not joined yet' && memberSignInText(member({ lastLoginAt: undefined })) === 'Not available' && memberSignInText(member({ lastLoginAt: null })) === 'Never signed in' && memberSignInText(member({})) === new Date(ISO).toLocaleString(), 'D9 the last sign-in cell');
  assert(same(memberAccountBadge(member({})), { label: 'Blocked: inactive', tone: 'amber' }) && same(memberAccountBadge(member({ disabledReason: 'admin' })), { label: 'Disabled', tone: 'rose' }) && memberAccountBadge(member({ status: 'PENDING_INVITE' })) === null && memberAccountBadge(member({ accountDisabled: false })) === null, 'D9 the status badge');
  assert(showLastSignInColumn(true, true) && !showLastSignInColumn(false, true) && !showLastSignInColumn(true, false), 'D9 the column needs a write role and a server-backed tenant');

  console.log('\n--- D10 code and success text ---');
  assert(restoreCodeReady('123456') && !restoreCodeReady('12345') && !restoreCodeReady('12345a') && !restoreCodeReady('1234567'), 'D10 the code is exactly six digits');
  assert(restoreSuccessText('a@b') === 'a@b can sign in again.', 'D10 the success text');

  console.log('\n--- D11 restore errors ---');
  const reasons = ['code_required', 'invalid_request', 'invalid_code', 'owner_required', 'role_not_grantable', 'not_dormant', 'mfa_not_enrolled'] as const;
  assert(reasons.every((r) => restoreErrorMessage({ reason: r, status: 400, message: 'SERVER TEXT' }) === RESTORE_ERROR_TEXT[r]), 'D11 each server reason maps to its own text, never the server message');
  assert(restoreErrorMessage({ status: 404 }) === RESTORE_ERROR_TEXT.not_found && restoreErrorMessage({ status: 429 }) === RESTORE_ERROR_TEXT.locked && restoreErrorMessage({ status: 0 }) === RESTORE_ERROR_TEXT.unreachable && restoreErrorMessage({ status: 401 }) === RESTORE_ERROR_TEXT.session && restoreErrorMessage({ status: 403 }) === RESTORE_ERROR_TEXT.owner_required, 'D11 a status without a reason maps to its text');
  assert(restoreErrorMessage({ status: 500 }) === RESTORE_ERROR_TEXT.failed && restoreErrorMessage(null) === RESTORE_ERROR_TEXT.failed && restoreErrorMessage({ reason: 'unreachable', status: 500 }) === RESTORE_ERROR_TEXT.failed, 'D11 anything else is the generic text');
  assert(Object.values(RESTORE_ERROR_TEXT).every((t) => !t.includes('_')), 'D11 no text shows a code');
  assert(RESTORE_ERROR_TEXT.mfa_not_enrolled.includes('two-step verification') && RESTORE_ERROR_TEXT.mfa_not_enrolled.includes('platform administrator'), 'D11 a missing two-step setup names the way out');
  assert(restoreRefreshesTeam({ reason: 'not_dormant' }) && restoreRefreshesTeam({ status: 404 }) && !restoreRefreshesTeam({ reason: 'invalid_code' }) && !restoreRefreshesTeam(null), 'D11 the team reloads when the member is gone or already restored');

  console.log('\n--- D12 team screen source ---');
  const modal = read('src/components/settings/TeamSettingsModal.tsx');
  assert(['restoreDormantMember(currentTenant.id, target.userId, restoreCode)', 'id="team-restore-code"', 'autoComplete="one-time-code"', 'z-[60]', 'max-h-[94vh]', 'showLastSignInColumn(canManageTenant, !isBrowserOnlyTenant)', 'hidden md:table-cell', 'DORMANCY_TEXT.sectionTitle'].every((s) => modal.includes(s)), 'D12 the team screen has the section, the column and the code dialog');
  assert(occurrences(modal, "setRestoreCode('')") >= 3, 'D12 the code is cleared on open, on close and after every attempt');
  assert(!/console\./.test(modal) && !/localStorage/.test(modal) && !modal.includes('alert('), 'D12 the team screen neither logs, stores nor alerts');

  console.log('\n--- D13 team context source ---');
  const ctx = read('src/context/TenantContext.tsx');
  const sliceStart = ctx.indexOf('const restoreDormantMember = useCallback');
  const restoreSlice = ctx.slice(sliceStart, ctx.indexOf('}, [refreshTeam]);', sliceStart));
  assert(ctx.includes('ApiClient.listMembersWithPolicy(tenantId)') && ctx.includes('setTeamDormantDays({})'), 'D13 the team load reads the period and sign-out clears it');
  assert(sliceStart > 0 && restoreSlice.includes('ApiClient.restoreMember(tenantId, userId, code)') && restoreSlice.includes('await refreshTeam(tenantId)'), 'D13 restoring a member reloads the team');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main();
