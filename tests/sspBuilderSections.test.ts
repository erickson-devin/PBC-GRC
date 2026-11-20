import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFrameworkControls } from '../src/data/frameworks';
import { computeSspCompleteness, type SspCompletenessInput } from '../src/data/ssp/sspCompleteness';
import type { SspSectionId } from '../src/data/ssp/sspSections';
import {
  MAINTENANCE_QUESTIONS,
  SSP_BUILDER_TEXT,
  addCustomRole,
  advisoryLabel,
  applySuggestion,
  builderSaveState,
  categorizationSuggestionView,
  completenessSummary,
  editRoleRow,
  emptyMaintenance,
  exceptionsRequired,
  exportGapTarget,
  fieldFlags,
  formatReviewTime,
  isBlankRole,
  maintenanceControlLinks,
  missingItemsLine,
  missingLabel,
  navEntriesView,
  overallLine,
  pickableMembers,
  profileSaveErrorText,
  removeRoleRow,
  reviewChipView,
  reviewErrorText,
  reviewHistoryRows,
  reviewLatestLine,
  roleRowError,
  roleRowsView,
  rolesForSave,
  selectMember,
  setMaintenanceAnswer,
  setMaintenanceExceptions,
  signOffDisabledReason,
} from '../src/data/ssp/sspBuilderView';
import { SspSectionNav } from '../src/components/ssp/SspSectionNav';
import { SspSectionReview } from '../src/components/ssp/SspSectionReview';
import { SspIdentificationSection } from '../src/components/ssp/SspIdentificationSection';
import { SspRolesSection } from '../src/components/ssp/SspRolesSection';
import { SspMaintenanceSection } from '../src/components/ssp/SspMaintenanceSection';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import type { SSPMetadata } from '../src/types/cmmc';
import type { TeamMember } from '../src/types/tenant';
import type { SspProfile, SspRoleEntry, SspSectionReview as ReviewRow, SspSectionReviewState } from '../src/types/sspProfile';

/**
 * #238 / #241 / #242 / #246: the SSP builder's section screens. The pure view module (labels, status lines, role and maintenance edits) is
 * tested directly; the components are rendered on the server (no browser); a few source pins keep the wiring from drifting.
 * Pure test: no server, no browser, no timers.
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

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const noop = () => undefined;

const emptyInput = (framework: string): SspCompletenessInput => ({ framework, metadata: {}, profile: null });
const l2Empty = computeSspCompleteness(emptyInput('CMMC_L2'));
const filledMeta = {
  systemName: 'S', organizationName: 'O', authorName: 'A', systemBoundaryScope: 'B', systemOwner: 'Jane',
};
const MODERATE = { confidentialityImpact: 'MODERATE', integrityImpact: 'MODERATE', availabilityImpact: 'MODERATE' } as const;
const fullProfile: SspProfile = {
  systemIdentifier: 'ID-1',
  ...MODERATE,
  roles: [
    { id: 'a', roleKey: 'system_owner', name: 'Jane', email: '' },
    { id: 'b', roleKey: 'isso_ciso', name: 'Joe', email: '' },
    { id: 'c', roleKey: 'ir_reporting_primary', name: 'Ira', email: '' },
  ],
  maintenance: { hardwareMaintainedByOrg: true, hardwareOwnedByOrg: true, softwareMaintainedByOrg: true, softwareOwnedByOrg: true, exceptions: '' },
};
const l2Complete = computeSspCompleteness({ framework: 'CMMC_L2', metadata: filledMeta, profile: fullProfile });

const review = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  id: 'r1', sectionId: 'identification', contentSha256: 'a'.repeat(64), reviewerUserId: 'u1', reviewerName: 'Ann', reviewerRole: 'TENANT_OWNER', createdAt: '2026-11-19T14:05:00Z', ...over,
});

console.log('\n🧩 SSP builder sections (#238, #241, #242, #246)');

// ---------------------------------------------------------------- pure view
console.log('--- Labels and chips ---');
assert(missingLabel(1) === '1 required item missing' && missingLabel(3) === '3 required items missing', 'V1 missingLabel is singular and plural');
assert(advisoryLabel(0) === null && advisoryLabel(1) === '1 optional item missing' && advisoryLabel(2) === '2 optional items missing', 'V1b advisoryLabel is null at zero');
assert(formatReviewTime('2026-11-19T14:05:31.000Z') === '2026-11-19 14:05 UTC' && formatReviewTime('x') === 'an unknown time', 'V2 review times are UTC to the minute, and an unreadable one says so');
const chipReviewed = reviewChipView('reviewed', review(), false);
assert(
  reviewChipView('unavailable', null, false) === null &&
    reviewChipView('reviewed', review(), true) === null &&
    reviewChipView('not_reviewed', null, false)?.text === 'Not reviewed' &&
    chipReviewed?.tone === 'emerald' && chipReviewed.text === 'Reviewed 2026-11-19' &&
    reviewChipView('changed_since_review', review(), false)?.tone === 'amber',
  'V3 the review chip by status; nothing while loading or unavailable'
);
const navCmmc = navEntriesView(l2Empty, { supported: true, status: 'ready', sections: {} });
assert(
  navCmmc.map((e) => e.id).join() === 'identification,roles,environment,maintenance' &&
    navCmmc.every((e, i) => e.missingText === (l2Empty.sections[i].requiredMissing ? missingLabel(l2Empty.sections[i].requiredMissing) : null)),
  'V4 the nav entries follow the section order and carry the required count text'
);
assert(navCmmc.every((e) => e.review?.text === 'Not reviewed') && navEntriesView(l2Empty, { supported: false, status: 'ready', sections: {} }).every((e) => e.review === null), 'V4b a browser-only organization shows no review chip');
const changedState: Partial<Record<SspSectionId, SspSectionReviewState>> = {
  roles: { sectionId: 'roles', currentDigest: 'b'.repeat(64), latest: review({ sectionId: 'roles' }), reviewed: false },
};
assert(navEntriesView(l2Empty, { supported: true, status: 'ready', sections: changedState })[1].review?.text === 'Changed since review', 'V4c a section whose digest moved shows changed since review');
assert(completenessSummary(l2Complete) === 'Every required item is recorded.' && completenessSummary(l2Empty).endsWith(' across the SSP.'), 'V4d the summary line');
assert(
  missingItemsLine(l2Complete.sections[0]) === null &&
    (missingItemsLine(l2Empty.sections[0]) ?? '').startsWith('Required and not recorded: System name') &&
    fieldFlags(l2Empty.sections[0], 'systemName').required && fieldFlags(l2Empty.sections[0], 'systemName').missing &&
    !fieldFlags(l2Empty.sections[0], 'cageCode').required && !fieldFlags(l2Empty.sections[0], 'nope').missing && !fieldFlags(undefined, 'systemName').required,
  'V4e the missing-items line and the per-field flags'
);

console.log('--- Review lines and errors ---');
assert(
  reviewLatestLine('reviewed', review()) === 'Reviewed by Ann (Tenant Owner) on 2026-11-19 14:05 UTC.' &&
    reviewLatestLine('changed_since_review', review()) === 'Changed since Ann reviewed it on 2026-11-19 14:05 UTC. Check the section and mark it reviewed again.' &&
    reviewLatestLine('not_reviewed', null) === SSP_BUILDER_TEXT.notReviewed && reviewLatestLine('unavailable', null) === null,
  'V5 the latest review line'
);
const hist = [
  review({ id: 'h1', sectionId: 'identification', contentSha256: 'b'.repeat(64), createdAt: '2026-11-19T15:00:00Z' }),
  review({ id: 'h2', sectionId: 'roles' }),
  review({ id: 'h3', sectionId: 'identification', contentSha256: 'a'.repeat(64) }),
];
const histRows = reviewHistoryRows(hist, 'identification', 'b'.repeat(64));
assert(
  histRows.length === 2 && histRows[0].id === 'h1' && histRows[0].version === 'this version' && histRows[1].version === 'an earlier version' && !/[0-9a-f]{64}/.test(JSON.stringify(histRows)),
  'V6 the history keeps its section and order, and never carries a digest'
);
const errTexts = [
  reviewErrorText({ status: 409, reason: 'section_changed', message: 'MARK' }),
  reviewErrorText({ status: 409, reason: 'program_archived', message: 'MARK' }),
  reviewErrorText({ status: 403, message: 'MARK' }),
  reviewErrorText({ status: 403, reason: 'reviewer_unknown', message: 'MARK' }),
  reviewErrorText({ status: 400, reason: 'invalid_section', message: 'MARK' }),
  reviewErrorText(new Error('MARK')),
];
assert(
  errTexts[0] === SSP_BUILDER_TEXT.sectionChanged && errTexts[1].includes('archived') && errTexts[2] === SSP_BUILDER_TEXT.reviewReadOnly &&
    errTexts[3].includes('could not be matched') && errTexts[4].includes('Reload the page') && errTexts[5].includes('Check the connection') &&
    errTexts.every((t) => !t.includes('MARK')),
  'V7 sign-off errors map to fixed text and never echo a message'
);
const clear = { savePending: false, reviewsStatus: 'ready' as const, profileStatus: 'ready', metadataEditable: true, canSignOff: true, signing: false };
assert(
  signOffDisabledReason({ ...clear, savePending: true }) === 'Wait until the changes are saved.' &&
    signOffDisabledReason({ ...clear, profileStatus: 'stale' }) === 'Reload the server copy first.' &&
    signOffDisabledReason({ ...clear, reviewsStatus: 'loading' }) === 'Wait until the sign-offs have loaded.' &&
    signOffDisabledReason({ ...clear, metadataEditable: false }) === 'Wait until the section has loaded.' &&
    signOffDisabledReason(clear) === null,
  'V8 the sign-off button says why it is disabled'
);
assert(
  profileSaveErrorText('archived').includes('archived') && profileSaveErrorText('forbidden').includes('Tenant Owner') &&
    profileSaveErrorText('invalid').includes('refused') && profileSaveErrorText('failed').includes('not saved'),
  'V8b every profile save error has fixed text'
);
const save = { serverBacked: true, metadataStatus: 'ready' as const, needsOwner: false, conflict: false, profileStatus: 'ready', profileSaving: false };
assert(
  builderSaveState({ ...save, serverBacked: false }) === 'browser' &&
    builderSaveState({ ...save, profileSaving: true }) === 'saving' &&
    builderSaveState({ ...save, profileStatus: 'loading' }) === 'loading' &&
    builderSaveState({ ...save, metadataStatus: 'loading' }) === 'loading' &&
    builderSaveState({ ...save, metadataStatus: 'loading', needsOwner: true }) === 'idle' &&
    builderSaveState({ ...save, metadataStatus: 'saved' }) === 'saved' &&
    builderSaveState(save) === 'idle',
  'V9 the save state line'
);

console.log('--- Categorization ---');
const sugL2 = categorizationSuggestionView({ framework: 'CMMC_L2', baseline: null, profile: null });
assert(sugL2 !== null && sugL2.text.includes('Moderate / Moderate / Moderate'), 'V10 CMMC Level 2 is offered Moderate across the board');
assert(categorizationSuggestionView({ framework: 'CMMC_L2', baseline: null, profile: { integrityImpact: 'LOW' } }) === null, 'V10b any impact set hides the suggestion');
assert(['CMMC_L1', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'].every((f) => categorizationSuggestionView({ framework: f, baseline: null, profile: null }) === null), 'V10c no suggestion for Level 1, SOC 2 or HIPAA');
assert(
  categorizationSuggestionView({ framework: 'NIST_800_53_REV5', baseline: 'HIGH', profile: null })?.text.includes('High / High / High') === true &&
    categorizationSuggestionView({ framework: 'NIST_800_53_REV5', baseline: null, profile: null }) === null,
  'V10d NIST SP 800-53 is offered its baseline, and nothing without one'
);
const applied = applySuggestion({ systemIdentifier: 'X' }, sugL2!);
assert(applied.systemIdentifier === 'X' && applied.confidentialityImpact === 'MODERATE' && applied.integrityImpact === 'MODERATE' && applied.availabilityImpact === 'MODERATE', 'V10e applying a suggestion sets the three impacts and keeps the rest');
assert(overallLine(null).includes('not set') && overallLine({ ...MODERATE, availabilityImpact: 'HIGH' }).includes('High (the highest of the three)'), 'V10f the overall line is the high-water mark');

console.log('--- Roles ---');
const members: TeamMember[] = [
  { id: 'm1', tenantId: 't', email: 'zed@x.test', name: 'Zed', role: 'VIEWER', status: 'ACTIVE', userId: 'u-zed' },
  { id: 'm2', tenantId: 't', email: 'amy@x.test', name: 'Amy', role: 'TENANT_ADMIN', status: 'ACTIVE', userId: 'u-amy' },
  { id: 'm3', tenantId: 't', email: 'pen@x.test', name: 'Pen', role: 'VIEWER', status: 'PENDING_INVITE', userId: 'u-pen' },
  { id: 'm4', tenantId: 't', email: 'off@x.test', name: 'Off', role: 'VIEWER', status: 'ACTIVE', userId: 'u-off', accountDisabled: true },
  { id: 'm5', tenantId: 't', email: 'nou@x.test', name: 'Nou', role: 'VIEWER', status: 'ACTIVE' },
];
const pickable = pickableMembers(members);
assert(pickable.map((m) => m.userId).join() === 'u-amy,u-zed', 'V11 only active, enabled members with a user id can be picked, by name');
const rolesStatus = l2Empty.sections[1];
const emptyViews = roleRowsView({ rows: [], rolesStatus, teamLoaded: true, members, legacy: false, framework: 'CMMC_L2' });
assert(emptyViews.length === 8 && emptyViews.every((v) => v.placeholder), 'V12 an empty profile shows the eight fixed roles');
assert(emptyViews.filter((v) => v.showCertificate).length === 2 && roleRowsView({ rows: [], rolesStatus, teamLoaded: true, members, legacy: false, framework: 'SOC_2_TYPE_II' }).every((v) => !v.showCertificate), 'V12b the DIBNet certificate is on the two reporting roles for CMMC, and absent for SOC 2');
assert(emptyViews.filter((v) => v.required).map((v) => v.row.roleKey).join() === 'system_owner,isso_ciso,ir_reporting_primary', 'V12c system owner, ISSO and primary reporting are required for CMMC Level 2');
const goneRow: SspRoleEntry = { id: 'x', roleKey: 'ir_lead', name: 'Gone', email: '', memberUserId: 'u-gone' };
assert(
  roleRowsView({ rows: [goneRow], rolesStatus, teamLoaded: true, members, legacy: false, framework: 'CMMC_L2' }).find((v) => v.row.id === 'x')?.memberGone === true &&
    roleRowsView({ rows: [goneRow], rolesStatus, teamLoaded: false, members: [], legacy: false, framework: 'CMMC_L2' }).find((v) => v.row.id === 'x')?.memberGone === false,
  'V12d a member is gone only once the team list has loaded'
);
const legacyViews = roleRowsView({ rows: [{ id: 'legacy-system-owner', roleKey: 'system_owner', name: 'Jane', email: '' }], rolesStatus, teamLoaded: true, members, legacy: true, framework: 'CMMC_L2' });
assert(legacyViews.find((v) => v.row.roleKey === 'system_owner')?.legacy === true && legacyViews.filter((v) => v.legacy).length === 1, 'V12e the legacy owner is marked on the system owner row only');
const edited = editRoleRow([], { rowId: 'system_owner', roleKey: 'system_owner' }, { name: 'Jane' });
assert(edited.length === 1 && edited[0].id === 'system_owner' && edited[0].name === 'Jane', 'V13 editing an empty fixed role appends its row');
const two = editRoleRow(edited, { rowId: 'isso_ciso', roleKey: 'isso_ciso' }, { name: 'Joe' });
assert(editRoleRow(two, { rowId: 'system_owner', roleKey: 'system_owner' }, { email: 'j@x.test' }).map((r) => r.id).join() === 'system_owner,isso_ciso', 'V13b editing keeps the order');
const c1 = addCustomRole([]);
const c2 = addCustomRole(c1.rows);
assert(c1.id === 'custom-1' && c2.id === 'custom-2' && c2.rows.length === 2 && removeRoleRow(c2.rows, 'custom-1').map((r) => r.id).join() === 'custom-2', 'V13c custom roles are numbered and removable');
assert(rolesForSave([...two, ...c1.rows]).length === 2 && isBlankRole(c1.rows[0]) && !isBlankRole({ ...c1.rows[0], certificateOnFile: true }), 'V13d blank rows are not sent');
const selected = selectMember(two, two[0], 'u-amy', pickable);
assert(selected[0].memberUserId === 'u-amy' && selected[0].name === 'Amy' && selected[0].email === 'amy@x.test', 'V13e picking a member copies the name and email');
const unlinked = selectMember(selected, selected[0], '', pickable);
assert(unlinked[0].memberUserId === null && unlinked[0].name === 'Amy' && unlinked[0].email === 'amy@x.test', 'V13f "not a team member" keeps the name and email');
const bad = roleRowError({ id: 'a', roleKey: 'system_owner', name: 'J', email: 'x-MARK' });
assert(bad?.field === 'email' && !bad.text.includes('MARK'), 'V14 a refused email names the field, not the value', bad);
assert(roleRowError({ id: 'c', roleKey: 'custom', customTitle: '', name: 'J', email: '' })?.field === 'customTitle' && roleRowError({ id: 'a', roleKey: 'system_owner', name: 'J', email: 'j@x.test' }) === null, 'V14b a custom role needs a title; a valid row has no error');

console.log('--- Maintenance and links ---');
assert(MAINTENANCE_QUESTIONS.length === 4 && !exceptionsRequired(undefined) && !exceptionsRequired(emptyMaintenance()) && exceptionsRequired({ ...emptyMaintenance(), softwareOwnedByOrg: false }), 'V15 the exceptions are required when an answer is No');
const answered = setMaintenanceAnswer(null, 'hardwareOwnedByOrg', 'no');
assert(
  answered.maintenance?.hardwareOwnedByOrg === false && answered.maintenance.hardwareMaintainedByOrg === null &&
    setMaintenanceAnswer(answered, 'hardwareOwnedByOrg', 'unset').maintenance?.hardwareOwnedByOrg === null &&
    setMaintenanceExceptions(answered, 'text').maintenance?.exceptions === 'text',
  'V15b answers and exceptions update the maintenance block only'
);
const l2Links = maintenanceControlLinks(getFrameworkControls('CMMC_L2'), (id) => id);
assert(l2Links.length > 0 && l2Links.length === getFrameworkControls('CMMC_L2').filter((c) => String(c.domain) === 'MA').length && maintenanceControlLinks(getFrameworkControls('CMMC_L1'), (id) => id).length === 0, 'V16 the MA control links exist for CMMC Level 2 and not for Level 1');
assert(
  exportGapTarget({ field: 'systemOwner' }).kind === 'ssp' &&
    JSON.stringify(exportGapTarget({ field: 'role:isso_ciso', sspSection: 'roles' })) === '{"kind":"ssp","section":"roles"}' &&
    JSON.stringify(exportGapTarget({ field: 'systemName' })) === '{"kind":"field","field":"systemName"}',
  'V17 an export gap opens the builder for the profile items and the owner, and a field otherwise'
);

// ---------------------------------------------------------------- rendering
console.log('--- Rendering ---');
const meta: SSPMetadata = {
  systemName: 'Sys', organizationName: 'Org', cageCode: '', samStatus: 'ACTIVE', systemOwner: '', authorName: '', assessmentDate: '2026-11-19',
  systemBoundaryScope: '', systemEnvironment: '', cloudServiceProviders: '', version: '1.0.0', serviceCommitments: '',
};
const navHtml = renderToStaticMarkup(React.createElement(SspSectionNav, { entries: navCmmc, activeId: 'roles', onSelect: noop, summary: completenessSummary(l2Empty) }));
const navOk = l2Empty.sections.every((s) => s.requiredMissing === 0 || (navHtml.includes(`>${s.requiredMissing}<`) && navHtml.includes(missingLabel(s.requiredMissing))));
assert(navOk && count(navHtml, 'aria-current="true"') === 1 && count(navHtml, '<button') === 4, 'R1 the nav shows each required count with its accessible text, one current section, four buttons');
const doneNav = renderToStaticMarkup(React.createElement(SspSectionNav, { entries: navEntriesView(l2Complete, { supported: false, status: 'ready', sections: {} }), activeId: 'identification', onSelect: noop, summary: '' }));
assert(doneNav.includes('Complete') && !doneNav.includes('required item'), 'R1b a complete section reads Complete');

const identProps = (over: Record<string, unknown> = {}) => ({
  meta, canEdit: true, sspMetadataEditable: true, updateSSPMetadata: noop, profile: null as SspProfile | null, profileEditable: true, onProfileChange: noop,
  section: l2Empty.sections[0], framework: 'CMMC_L2', baseline: null, ...over,
});
const identHtml = (over?: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SspIdentificationSection, identProps(over)));
assert(identHtml().includes('Apply suggestion') && identHtml().includes('Suggestion'), 'R2 a CMMC Level 2 program with no categorization is offered the suggestion');
assert(!identHtml({ profile: { ...MODERATE } }).includes('Apply suggestion') && !identHtml({ canEdit: false }).includes('Apply suggestion'), 'R2b no suggestion once set, and no Apply button without write access');
assert(count(identHtml(), '<option value="" selected="">Not set</option>') === 3, 'R2c the selects start on Not set: a suggestion is not a value');

const reviewProps = (over: Record<string, unknown> = {}) => ({
  sectionId: 'identification' as SspSectionId, supported: true, status: 'ready' as const,
  state: { sectionId: 'identification', currentDigest: 'b'.repeat(64), latest: review(), reviewed: true } as SspSectionReviewState,
  history: [review()], canEdit: true, disabledReason: null, signing: false, error: null, notice: null, onSignOff: noop, onRetry: noop, ...over,
});
const revHtml = (over?: Record<string, unknown>) => renderToStaticMarkup(React.createElement(SspSectionReview, reviewProps(over)));
const rh = revHtml();
assert(rh.includes('Ann') && rh.includes('2026-11-19 14:05 UTC') && !rh.includes('aaaaaaaa') && !rh.includes('bbbbbbbb') && rh.includes('Mark section reviewed'), 'R3 the review block names who and when and never shows a digest');
assert(revHtml({ supported: false }).includes('Sign-off needs a server-backed organization') && !revHtml({ supported: false }).includes('Mark section reviewed'), 'R3b a browser-only organization cannot sign off');
const roRev = revHtml({ canEdit: false });
assert(!roRev.includes('Mark section reviewed') && roRev.includes(SSP_BUILDER_TEXT.reviewReadOnly) && roRev.includes('History (1)'), 'R3c read-only: no button, the reason, and the history stays visible');
assert(revHtml({ error: 'The sign-off failed.' }).includes('role="alert"') && revHtml({ disabledReason: 'Wait until the changes are saved.' }).includes('disabled=""'), 'R3d an error is an alert and a disabled button gives its reason');

const rolesHtml = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(React.createElement(SspRolesSection, {
    profile: null as SspProfile | null, legacySystemOwner: 'Jane', section: l2Empty.sections[1], canEdit: true, profileEditable: true, onProfileChange: noop,
    members, teamLoaded: true, teamError: null, serverBacked: true, framework: 'CMMC_L2', ...over,
  }));
const rr = rolesHtml();
assert(rr.includes('From the previous System owner field') && rr.includes('value="Jane"') && count(rr, '>Required<') >= 3, 'R4 the legacy owner is prefilled with its note and the required roles are marked');
assert(count(rr, 'DIBNet') === 2, 'R4b the DIBNet certificate appears on the two reporting roles');
assert(
  rolesHtml({ profile: { roles: [{ id: 'q', roleKey: 'ir_lead', name: 'Gone', email: '', memberUserId: 'u-gone' }] } }).includes('no longer on the team') &&
    !rolesHtml({ serverBacked: false }).includes('Team member') && rolesHtml({ canEdit: false }).includes('disabled=""') && !rolesHtml({ canEdit: false }).includes('Add custom role'),
  'R4c a departed member is flagged, a browser-only organization has no picker, and read-only has no Add button'
);

const maintHtml = (profile: SspProfile | null, maControls: Array<{ id: string; displayId: string; title: string }>) =>
  renderToStaticMarkup(React.createElement(SspMaintenanceSection, {
    profile, canEdit: true, profileEditable: true, onProfileChange: noop, section: undefined, maControls, onOpenControl: noop,
  }));
const mh = maintHtml({ maintenance: { ...emptyMaintenance(), hardwareOwnedByOrg: false } }, []);
assert(mh.includes('(required)') && mh.includes('aria-required="true"') && !mh.includes('Related maintenance'), 'R5 a No answer makes the exceptions required; no MA controls, no links');
assert(maintHtml(null, l2Links).includes('Related maintenance (MA) controls') && count(maintHtml(null, l2Links), 'type="radio"') === 12, 'R5b the MA control links show with the twelve radios');

// ---------------------------------------------------------------- source pins
console.log('--- Source pins ---');
const identSrc = read('src/components/ssp/SspIdentificationSection.tsx');
const applyAt = identSrc.indexOf('applySuggestion(');
const clickAt = identSrc.indexOf('onClick={() => {');
const btnAt = identSrc.indexOf('Apply suggestion\n');
assert(count(identSrc, 'applySuggestion(') === 1 && clickAt >= 0 && clickAt < applyAt && applyAt < btnAt, 'S1 the suggested values are saved only inside the Apply button handler');
const builderSrc = read('src/components/ssp/SSPBuilder.tsx');
assert(builderSrc.includes('clearSspFocusSection()') && builderSrc.includes('sectionHeadingRef.current?.focus()') && !builderSrc.includes('updateSSPMetadata({ systemOwner:'), 'S2 the builder consumes the focus request, focuses the heading, and never writes the owner');
const reviewSrc = read('src/components/ssp/SspSectionReview.tsx');
assert(!reviewSrc.includes('{state?.currentDigest') && !reviewSrc.includes('contentSha256}') && !reviewSrc.includes('currentDigest}'), 'S3 the review block never interpolates a digest');
const viewSrc = read('src/data/ssp/sspBuilderView.ts');
const newFiles = ['SspSectionNav', 'SspSectionReview', 'SspIdentificationSection', 'SspRolesSection', 'SspEnvironmentSection', 'SspMaintenanceSection'].map((n) => read(`src/components/ssp/${n}.tsx`));
assert([...newFiles, viewSrc].every((t) => !/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(t)), 'S4 the new files log nothing, touch no browser storage and use no raw HTML');
assert(!/\bfrom '\.\.\/\.\.\/(services|context)\//.test(viewSrc) && !viewSrc.includes("from 'react'"), 'S5 the view module is pure: no services, no contexts, no React');
assert(NOT_RECORDED === 'Not recorded', 'S6 the shared not-recorded text is the one the outputs print');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
