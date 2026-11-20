import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MEMBERSHIP_TEXT, MEMBER_PROFILE_ERROR_TEXT, SOON_DAYS, accessEndedText, accessEndedToShow, addDaysUtc, draftProblem, expiredSummaryText, expiryPreviewText,
  expiryView, filterByUsPerson, hasMembershipFacts, maxExpiryDate, memberEditView, memberExpiryBannerText, memberIsExpired, memberProfileErrorMessage,
  memberProfileRefreshesTeam, mergeAccessEnded, ownerPromotionExpiryNote, patchSummaryText, primaryContactHelp, profileDraftFrom, profilePatchFrom,
  profileSavedText, showMembershipDetails, teamEmptyText, usPersonCounts, usPersonFilterLabel, usPersonRecordedText, type MemberProfileDraft,
} from '../src/data/membershipView';
import { formatLocalDateTime, formatUtcDate, formatUtcDateTime } from '../src/utils/utcDates';
import { checkNewExpiry } from '../src/utils/memberProfile';
import { buildTeam, parseServerMembers } from '../src/data/teamSync';
import { parseExpiredTenants, parseServerTenants } from '../src/data/tenantSync';
import { ApiClient, onMembershipExpired } from '../src/services/apiClient';
import { computeSspCompleteness } from '../src/data/ssp/sspCompleteness';
import { SspRolesSection } from '../src/components/ssp/SspRolesSection';
import type { SspProfile } from '../src/types/sspProfile';
import type { TeamMember } from '../src/types/tenant';

/**
 * Member access details (#258, #259): the pure view logic, the parsing of the new server fields, the ApiClient calls against a stubbed
 * fetch, and source checks on the screens that show them. No server, no browser.
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
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const NOW = Date.parse('2026-11-19T12:00:00Z');

console.log('--- U1 utcDates ---');
assert(formatUtcDate('2026-12-31') === '31 Dec 2026', 'U1 a date reads day, month name, year');
assert(formatUtcDate('2026-02-30') === '2026-02-30', 'U1 a day that does not exist comes back unchanged');
assert(formatUtcDateTime('2026-11-20T14:05:00.000Z') === '20 Nov 2026, 14:05 UTC', 'U1 an instant reads in UTC');
assert(formatUtcDateTime('x') === 'x', 'U1 an unparsable instant comes back unchanged');
assert(formatLocalDateTime(0, () => 'L') === 'L', 'U1 the local format is injectable');

console.log('--- E1-E8 expiryView ---');
const none = expiryView(null, NOW);
assert(none.state === 'none' && none.chip === null && none.text === 'No end date' && none.daysLeft === null, 'E1 no end date', none);
assert(expiryView(undefined, NOW).state === 'none', 'E1b undefined is no end date');
const today = expiryView('2026-11-19', NOW);
assert(today.state === 'soon' && today.chip === 'Access ends today (23:59 UTC)' && today.daysLeft === 0, 'E2 the last day is today', today);
assert(expiryView('2026-11-20', NOW).chip === 'Access ends tomorrow (23:59 UTC)', 'E3 tomorrow');
const d14 = expiryView('2026-12-03', NOW);
assert(d14.state === 'soon' && d14.chip === 'Access ends in 14 days (3 Dec 2026, 23:59 UTC)' && SOON_DAYS === 14, 'E4 14 days is still soon', d14);
const d15 = expiryView('2026-12-04', NOW);
assert(d15.state === 'active' && d15.chip === 'Access ends 4 Dec 2026 (23:59 UTC)', 'E5 15 days is active', d15);
const past = expiryView('2026-11-18', NOW);
assert(past.state === 'expired' && past.chip === 'Access expired 18 Nov 2026' && past.text === 'Access ended at 23:59 UTC on 18 Nov 2026.', 'E6 a past date is expired', past);
assert(expiryView('2026-11-19', Date.parse('2026-11-19T23:59:59.999Z')).state === 'soon', 'E7 one millisecond before midnight UTC is still soon');
assert(expiryView('2026-11-19', Date.parse('2026-11-20T00:00:00.000Z')).state === 'expired', 'E7b at midnight UTC it is expired');
const bad = expiryView('2026-02-30', NOW);
assert(bad.state === 'expired' && bad.chip === 'Access expired', 'E8 a malformed date fails closed', bad);
assert(expiryView('2026-12-31', Date.parse('2026-12-20T00:00:00Z')).state === 'soon', 'E8b 11 days ahead is soon');

console.log('--- C1-C3 counts and filter ---');
const mk = (id: string, over: Partial<TeamMember> = {}): TeamMember => ({ id, userId: id, tenantId: 't', email: `${id}@x.test`, name: id, role: 'VIEWER', status: 'ACTIVE', ...over });
const four: TeamMember[] = [
  mk('a', { accessExpiresOn: null, usPerson: 'US_PERSON' }),
  mk('b', { accessExpiresOn: null, usPerson: 'OTHER' }),
  mk('c', { accessExpiresOn: null, usPerson: null }),
  mk('p', { status: 'PENDING_INVITE' }),
];
const counts = usPersonCounts(four);
assert(JSON.stringify(counts) === JSON.stringify({ all: 3, usPerson: 1, other: 1, notRecorded: 1 }), 'C1 counts count rows with facts only', counts);
const notRec = filterByUsPerson(four, 'NOT_RECORDED');
assert(notRec.length === 1 && notRec[0].id === 'c' && filterByUsPerson(four, 'all').length === 4, 'C2 the filter keeps the right rows; all keeps the pending one', notRec);
assert(filterByUsPerson(four, 'US_PERSON').map((m) => m.id).join() === 'a' && filterByUsPerson(four, 'OTHER').map((m) => m.id).join() === 'b', 'C2b US person and other');
assert(usPersonFilterLabel('OTHER', counts) === 'Other (1)' && usPersonFilterLabel('all', counts) === 'All (3)' && usPersonFilterLabel('US_PERSON', counts) === 'US person (1)' && usPersonFilterLabel('NOT_RECORDED', counts) === 'Not recorded (1)', 'C3 filter labels carry the counts');
assert(showMembershipDetails(true, false, four) === false && showMembershipDetails(false, true, four) === false && showMembershipDetails(true, true, []) === false && showMembershipDetails(true, true, four) === true, 'C3b the details need a write role, a server organization and facts');
assert(teamEmptyText('all') === MEMBERSHIP_TEXT.searchEmpty && teamEmptyText('OTHER') === MEMBERSHIP_TEXT.filterEmpty && hasMembershipFacts(four[3]) === false, 'C3c empty text');

console.log('--- V1-V9 memberEditView ---');
const ev = (actor: Parameters<typeof memberEditView>[0]['actor'], memberRole: Parameters<typeof memberEditView>[0]['memberRole'], over: Partial<Parameters<typeof memberEditView>[0]> = {}) =>
  memberEditView({ actor, memberRole, isSelf: false, isPending: false, serverBacked: true, hasFacts: true, ...over });
const v1 = ev('MSP_ADMIN', 'VIEWER');
assert(v1.canEdit && v1.expiry === 'edit' && v1.affiliation && v1.usPerson === 'edit' && v1.primaryContact, 'V1 an MSP Admin edits everything on a Viewer', v1);
const v2 = ev('TENANT_ADMIN', 'VIEWER');
assert(v2.canEdit && v2.expiry === 'edit' && v2.affiliation && v2.usPerson === 'hidden' && !v2.primaryContact, 'V2 an Admin edits expiry and affiliation only', v2);
assert(!ev('TENANT_ADMIN', 'TENANT_OWNER').canEdit && !ev('TENANT_ADMIN', 'TENANT_ADMIN', { isSelf: true }).canEdit, 'V3 an Admin cannot open an Owner or their own row');
const v4 = ev('TENANT_OWNER', 'TENANT_OWNER', { isSelf: true });
assert(v4.expiry === 'owner_never' && v4.usPerson === 'self' && v4.primaryContact && v4.affiliation, 'V4 an Owner on their own row', v4);
assert(!ev('TENANT_OWNER', 'MSP_ADMIN').canEdit, 'V5 an Owner cannot open an MSP Admin');
const v6 = ev('TENANT_OWNER', 'TENANT_OWNER');
assert(v6.expiry === 'owner_never' && v6.usPerson === 'edit', 'V6 an Owner on another Owner', v6);
assert(!ev('VIEWER', 'VIEWER').canEdit && !ev('ASSESSOR', 'VIEWER').canEdit && !ev(null, 'VIEWER').canEdit, 'V7 read-only roles see nothing');
assert(!ev('MSP_ADMIN', 'VIEWER', { isPending: true }).canEdit && !ev('MSP_ADMIN', 'VIEWER', { serverBacked: false }).canEdit && !ev('MSP_ADMIN', 'VIEWER', { hasFacts: false }).canEdit, 'V8 pending, browser-only and no-facts rows are not editable');
const v9 = ev('MSP_ADMIN', 'ASSESSOR', { isSelf: true });
assert(v9.expiry === 'self' && v9.usPerson === 'self', 'V9 your own row: no expiry, no US-person', v9);

console.log('--- P1-P4 patches ---');
const dated = mk('d', { accessExpiresOn: '2026-12-31', affiliation: 'EMPLOYEE', usPerson: null });
const viewEdit = ev('MSP_ADMIN', 'VIEWER');
const base = profileDraftFrom(dated);
assert(JSON.stringify(profilePatchFrom(dated, base, viewEdit)) === '{}', 'P1 an unchanged draft is an empty patch');
assert(JSON.stringify(profilePatchFrom(dated, { ...base, hasExpiry: false }, viewEdit)) === JSON.stringify({ accessExpiresOn: null }), 'P2 removing the date sends null');
assert(!('usPerson' in profilePatchFrom(dated, { ...base, usPerson: 'OTHER' }, ev('TENANT_ADMIN', 'VIEWER'))), 'P3 an Admin patch leaves the US-person key out');
const multi = profilePatchFrom(dated, { ...base, affiliation: '', usPerson: 'US_PERSON', primaryContact: true }, viewEdit);
assert(JSON.stringify(multi) === JSON.stringify({ affiliation: null, usPerson: 'US_PERSON', primaryContact: true }), 'P3b several fields', multi);
const emptyDate: MemberProfileDraft = { ...profileDraftFrom(mk('n', { accessExpiresOn: null })), hasExpiry: true, expiresOn: '' };
assert(draftProblem(mk('n', { accessExpiresOn: null }), emptyDate, viewEdit, NOW) === MEMBERSHIP_TEXT.missingDate, 'P4 a missing date is a problem');
assert(draftProblem(mk('n', { accessExpiresOn: null }), { ...emptyDate, expiresOn: '2026-11-18' }, viewEdit, NOW) === MEMBERSHIP_TEXT.dateInPast, 'P4b a past date is a problem');
assert(draftProblem(mk('n', { accessExpiresOn: null }), { ...emptyDate, expiresOn: addDaysUtc(maxExpiryDate(NOW), 1) }, viewEdit, NOW) === MEMBERSHIP_TEXT.dateTooFar, 'P4c too far is a problem');
const expiredMember = mk('x', { accessExpiresOn: '2026-11-18', membershipExpired: true });
assert(draftProblem(expiredMember, profileDraftFrom(expiredMember), viewEdit, NOW) === null, 'P4d an unchanged past date on an expired member is not checked');
assert(checkNewExpiry(maxExpiryDate(NOW), NOW) === null && checkNewExpiry(addDaysUtc(maxExpiryDate(NOW), 1), NOW) === 'expiry_too_far', 'P4e the latest date is the latest the server accepts');
assert(addDaysUtc('2026-12-31', 1) === '2027-01-01' && memberIsExpired(expiredMember, NOW) && !memberIsExpired(mk('y'), NOW), 'P4f date arithmetic and expired rows');

console.log('--- S1-S3 text helpers ---');
assert(patchSummaryText({ accessExpiresOn: '2026-12-31', primaryContact: true }) === 'Saving will end access at 23:59 UTC on 31 Dec 2026, make them the primary contact.', 'S1 the summary names each change');
assert(patchSummaryText({}) === 'No changes yet.', 'S1b no changes');
assert(patchSummaryText({ accessExpiresOn: null, affiliation: 'ESP', usPerson: null, primaryContact: false }) === 'Saving will remove the access end date, set the affiliation to External service provider, clear the US-person status, remove them as the primary contact.', 'S1c every kind of change');
const withBob = [mk('amy'), mk('bob', { primaryContact: true })];
assert(primaryContactHelp(withBob, 'amy', true) === 'This replaces bob@x.test as the primary contact.', 'S2 ticking the box names who is replaced');
assert(primaryContactHelp(withBob, 'bob', true) === MEMBERSHIP_TEXT.primaryContactHelp && primaryContactHelp(withBob, 'amy', false) === MEMBERSHIP_TEXT.primaryContactHelp, 'S2b otherwise the plain help');
assert(ownerPromotionExpiryNote('TENANT_OWNER', '2026-12-31') === ' Their access end date (31 Dec 2026, 23:59 UTC) will be removed, because MSP Admins and Tenant Owners never have one.', 'S3 the promotion note');
assert(ownerPromotionExpiryNote('TENANT_ADMIN', '2026-12-31') === null && ownerPromotionExpiryNote('MSP_ADMIN', null) === null, 'S3b no note without an owner role and a date');
assert(usPersonRecordedText('2026-11-19T10:00:00.000Z') === 'Last recorded on 19 Nov 2026 (UTC).' && usPersonRecordedText(null) === null && usPersonRecordedText('x') === null, 'S3c the recorded date');
assert(profileSavedText('a@x.test') === 'Access details saved for a@x.test.', 'S3d saved text');

console.log('--- B1-B3 member texts ---');
assert(expiryPreviewText('2026-12-31', (d) => d.toISOString()) === 'Access ends at 23:59 UTC on 31 Dec 2026 (2026-12-31T23:59:00.000Z your time).', 'B1 the preview gives UTC and local time');
assert(expiryPreviewText('', () => 'x') === '' && expiryPreviewText('2026-02-30', () => 'x') === '', 'B1b no preview until the date is real');
assert(memberExpiryBannerText('Acme', '2026-11-26', NOW, () => 'LOCAL') === 'Your access to Acme ends in 7 days, at 23:59 UTC on 26 Nov 2026 (LOCAL your time). Ask the organization\'s owner to extend it if you still need it.', 'B2 the banner for 7 days');
assert(memberExpiryBannerText('Acme', '2027-01-01', NOW) === null && memberExpiryBannerText('Acme', null, NOW) === null && memberExpiryBannerText('Acme', '2026-11-01', NOW) === null, 'B2b no banner when far, none, or already ended');
assert((memberExpiryBannerText('Acme', '2026-11-19', NOW, () => 'L') ?? '').includes('ends today at 23:59 UTC') && (memberExpiryBannerText('Acme', '2026-11-20', NOW, () => 'L') ?? '').includes('ends tomorrow at 23:59 UTC'), 'B2c today and tomorrow');
assert(accessEndedText('Acme', '2026-11-18') === 'Your access to Acme ended on 18 Nov 2026 (UTC). Ask the organization\'s owner to extend it.', 'B3 the ended text with a date');
assert(accessEndedText('Acme', null) === 'Your access to Acme has ended. Ask the organization\'s owner to extend it.', 'B3b the ended text without a date');
const t1 = [{ id: 't1', name: 'One', expiredOn: null }];
assert(accessEndedToShow(t1, ['t1'], 2, []).length === 1 && accessEndedToShow(t1, [], 2, []).length === 0 && accessEndedToShow(t1, [], 0, []).length === 1 && accessEndedToShow(t1, ['t1'], 0, ['t1']).length === 0, 'B3c which ended notices show');
const merged = mergeAccessEnded([{ id: 'a', name: 'A', expiredOn: null }, { id: 'b', name: 'B', expiredOn: null }], [{ id: 'a', name: 'A2', expiredOn: '2026-11-18' }, { id: 'c', name: 'C', expiredOn: null }]);
assert(merged.map((e) => e.id).join() === 'a,b,c' && merged[0].name === 'A2', 'B3d merging dedupes by id, the newer wins, the order is kept', merged);

console.log('--- R1 errors ---');
const reasons = ['owner_cannot_expire', 'expiry_in_past', 'expiry_too_far', 'self', 'owner_required', 'role_not_grantable', 'primary_contact_conflict', 'member_not_found', 'invalid_request', 'membership_expired'] as const;
assert(reasons.every((r) => memberProfileErrorMessage({ reason: r, status: 400, message: 'SERVER TEXT' }) === MEMBER_PROFILE_ERROR_TEXT[r]), 'R1 every server reason maps to its text, never the server text');
assert(memberProfileErrorMessage({ status: 404 }) === MEMBER_PROFILE_ERROR_TEXT.member_not_found && memberProfileErrorMessage({ status: 400 }) === MEMBER_PROFILE_ERROR_TEXT.invalid_request && memberProfileErrorMessage({ status: 0 }) === MEMBER_PROFILE_ERROR_TEXT.unreachable, 'R1b status fallbacks 404, 400, 0');
assert(memberProfileErrorMessage({ status: 401 }) === MEMBER_PROFILE_ERROR_TEXT.session && memberProfileErrorMessage({ status: 403 }) === MEMBER_PROFILE_ERROR_TEXT.forbidden && memberProfileErrorMessage({ status: 500 }) === MEMBER_PROFILE_ERROR_TEXT.failed && memberProfileErrorMessage(new Error('x')) === MEMBER_PROFILE_ERROR_TEXT.failed, 'R1c status fallbacks 401, 403, 500, unknown');
assert(Object.values(MEMBER_PROFILE_ERROR_TEXT).every((t) => !t.includes('_') && !/Tenant Owner or MSP Admin/i.test(t)), 'R1d no raw codes and no old wording');
assert(memberProfileRefreshesTeam({ reason: 'primary_contact_conflict' }) && memberProfileRefreshesTeam({ reason: 'member_not_found' }) && memberProfileRefreshesTeam({ status: 404 }) && !memberProfileRefreshesTeam({ reason: 'self', status: 403 }), 'R1e which errors reload the team');

console.log('--- X1 summary ---');
assert(expiredSummaryText(0) === null && (expiredSummaryText(1) ?? '').startsWith('1 member can no longer') && (expiredSummaryText(2) ?? '').startsWith('2 members can no longer'), 'X1 the expired summary for 0, 1 and 2');

console.log('--- D1-D4 parsing ---');
const members = parseServerMembers({
  members: [
    { userId: 'u1', email: 'a@x.test', name: 'A', tenantId: 't', role: 'VIEWER', createdAt: 'c', primaryContact: true, membership: { accessExpiresOn: '2026-12-31', expired: true, affiliation: 'ESP', usPerson: 'US_PERSON', usPersonRecordedAt: '2026-11-19T10:00:00.000Z' } },
    { userId: 'u2', email: 'b@x.test', name: 'B', tenantId: 't', role: 'VIEWER', createdAt: 'c', membership: { accessExpiresOn: null, expired: 'yes', affiliation: 'BOGUS', usPerson: 'BOGUS', usPersonRecordedAt: null } },
    { userId: 'u3', email: 'c@x.test', name: 'C', tenantId: 't', role: 'VIEWER', createdAt: 'c' },
  ],
});
assert(members[0].primaryContact === true && members[0].membership?.affiliation === 'ESP' && members[0].membership?.expired === true, 'D1 the new member fields are read', members[0]);
assert(members[1].membership?.affiliation === null && members[1].membership?.usPerson === null && members[1].membership?.expired === false && members[1].primaryContact === undefined, 'D1b unknown values become null; expired is true only for true', members[1]);
assert(members[2].membership === undefined && members[2].primaryContact === undefined, 'D1c read-only callers get no membership');
const team = buildTeam('t', members, []);
assert(team[0].primaryContact === true && team[0].accessExpiresOn === '2026-12-31' && team[0].membershipExpired === true && team[0].usPerson === 'US_PERSON', 'D2 buildTeam carries the facts', team[0]);
assert(team[1].primaryContact === undefined && team[1].affiliation === null && team[1].accessExpiresOn === null, 'D2b a member without a primary flag has none; null affiliation stays null', team[1]);
assert(!('accessExpiresOn' in team[2]) && !('primaryContact' in team[2]), 'D2c no facts, no keys', team[2]);
assert(parseServerTenants({ tenants: [{ id: 't1', role: 'VIEWER', accessExpiresOn: '2026-12-31' }] })[0].accessExpiresOn === '2026-12-31', 'D3 a tenant carries its access end date');
assert(!('accessExpiresOn' in parseServerTenants({ tenants: [{ id: 't1', role: 'VIEWER', accessExpiresOn: 'soon' }] })[0]) && !('accessExpiresOn' in parseServerTenants({ tenants: [{ id: 't1', role: 'VIEWER', accessExpiresOn: null }] })[0]), 'D3b a bad or null value leaves the key out');
const exp = parseExpiredTenants({ expiredTenants: [{ id: 't9', name: 'Nine', expiredOn: '2026-11-18' }, { id: '' }, { id: 't8', expiredOn: 'x' }] });
assert(exp.length === 2 && exp[0].expiredOn === '2026-11-18' && exp[1].name === 't8' && exp[1].expiredOn === null && parseExpiredTenants(null).length === 0, 'D4 expired tenants are parsed defensively', exp);

console.log('--- A1-A3 ApiClient, against a stubbed fetch ---');
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
const realFetch = globalThis.fetch;
let lastCall: { url: string; init: RequestInit } | null = null;
function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastCall = { url: String(url), init };
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
  }) as typeof fetch;
}
const headerOf = (name: string): string | undefined => (lastCall?.init.headers as Record<string, string> | undefined)?.[name];

(async () => {
  try {
    stub(200, { tenants: [] });
    let r = await ApiClient.listMyTenantsResult();
    assert(JSON.stringify(r) === JSON.stringify({ kind: 'ok', tenants: [] }), 'A1 an empty list has no expiredTenants key', r);
    stub(200, { tenants: [], expiredTenants: [{ id: 't9', name: 'Nine', expiredOn: '2026-11-18' }] });
    r = await ApiClient.listMyTenantsResult();
    assert(r.kind === 'ok' && r.expiredTenants?.[0].id === 't9', 'A1b expired tenants come through when there are some', r);

    stub(200, { tenantId: 't1', userId: 'u 1', changed: ['affiliation', 7] });
    const res = await ApiClient.updateMemberProfile('t1', 'u 1', { affiliation: 'ESP' });
    assert(lastCall?.url.endsWith('/api/v1/tenants/t1/members/u%201') === true && lastCall?.init.method === 'PATCH' && headerOf('x-tenant-id') === 't1' && headerOf('x-program-id') === undefined && lastCall?.init.body === '{"affiliation":"ESP"}', 'A2 updateMemberProfile sends a PATCH for this member in this tenant', lastCall);
    assert(res.changed.join() === 'affiliation', 'A2b it returns the changed field names', res);

    const seen: Array<{ tenantId: string | null; expiredOn: string | null }> = [];
    const off = onMembershipExpired((e) => seen.push(e));
    stub(403, { reason: 'membership_expired', expiredOn: '2026-12-31' });
    try { await ApiClient.updateMemberProfile('t1', 'u1', { affiliation: null }); } catch { /* expected */ }
    assert(seen.length === 1 && seen[0].tenantId === 't1' && seen[0].expiredOn === '2026-12-31', 'A3 a 403 membership_expired fires the listener once with the tenant', seen);
    stub(403, { reason: 'other' });
    try { await ApiClient.updateMemberProfile('t1', 'u1', { affiliation: null }); } catch { /* expected */ }
    assert(seen.length === 1, 'A3b another 403 does not fire it');
    off();
    stub(403, { reason: 'membership_expired', expiredOn: '2026-12-31' });
    try { await ApiClient.updateMemberProfile('t1', 'u1', { affiliation: null }); } catch { /* expected */ }
    assert(seen.length === 1, 'A3c after unsubscribing nothing fires');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('--- SR1 the SSP roles picker ---');
  const rolesMembers: TeamMember[] = [mk('amy', { name: 'Amy', email: 'amy@x.test', userId: 'u-amy', primaryContact: true, role: 'TENANT_ADMIN' }), mk('zed', { name: 'Zed', email: 'zed@x.test', userId: 'u-zed' })];
  const html = renderToStaticMarkup(React.createElement(SspRolesSection, {
    profile: null as SspProfile | null, legacySystemOwner: '', section: computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null }).sections[1], canEdit: true, profileEditable: true, onProfileChange: () => undefined,
    members: rolesMembers, teamLoaded: true, teamError: null, serverBacked: true, framework: 'CMMC_L2',
  }));
  assert(html.includes('(amy@x.test) · Primary contact') && !html.includes('(zed@x.test) · Primary contact'), 'SR1 the primary contact is marked in the role member picker');

  console.log('--- SRC source checks ---');
  const modal = read('src/components/settings/TeamSettingsModal.tsx');
  const view = read('src/data/membershipView.ts');
  const ctx = read('src/context/TenantContext.tsx');
  const app = read('src/App.tsx');
  const notices = read('src/components/layout/MembershipNotices.tsx');
  assert(
    ['showMembershipDetails(canManageTenant, !isBrowserOnlyTenant, members)', 'usPersonCounts(members)', 'filterByUsPerson(', 'MEMBERSHIP_TEXT.usPersonFilterLegend', 'memberEditView(', 'type="date"', 'MEMBERSHIP_TEXT.expiredBadge', '<ErrorNotice message={editError} />', 'updateMemberProfile(currentTenant.id, editTarget.id, patch)', 'ownerPromotionExpiryNote('].every((s) => modal.includes(s)),
    'SRC1 the team screen has the filter, the editor, the expired badge and the promotion note',
  );
  assert(modal.indexOf('{showMembership && (') < modal.indexOf('usPersonFilterLegend') && !/console\.|localStorage|alert\(|dangerouslySetInnerHTML/.test(modal), 'SRC1b the filter sits in the showMembership block; nothing is logged, stored or alerted');
  assert(view.includes('UTC') && !/from '\.\.\/(services|context)|from 'react/.test(view), 'SRC2 the view module says UTC and imports no services, contexts or React');
  const reset = ctx.slice(ctx.indexOf('const resetForSignOut'));
  assert(ctx.includes('onMembershipExpired(') && reset.slice(0, 1500).includes('setAccessEnded([])') && reset.slice(0, 1500).includes('setMyAccessExpiry({})'), 'SRC3 the context listens for ended access and clears it on sign-out');
  assert(app.indexOf('<Header />') >= 0 && app.indexOf('<Header />') < app.indexOf('<MembershipNotices />'), 'SRC4 the notices follow the header');
  assert(notices.includes('role="alert"') && notices.includes('aria-label="Access end date"') && !/localStorage|sessionStorage|console\.|dangerouslySetInnerHTML|alert\(/.test(notices), 'SRC5 the notices are an alert and a labelled region and store nothing');
  assert(!/localStorage|sessionStorage/.test(read('src/data/teamSync.ts')) && !/accessExpiresOn/.test(read('src/types/tenant.ts').slice(0, read('src/types/tenant.ts').indexOf('export interface TeamMember'))), 'SRC6 the end date is on the team member only, not on the stored tenant');

  console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
  if (passed !== total) process.exitCode = 1;
})();
