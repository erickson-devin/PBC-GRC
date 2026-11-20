/**
 * #238 / #241 / #242 / #246: the pure foundation of the SSP completeness batch. Profile validation, the section registry and its canonical
 * text (the server hashes it), the categorization suggestion, the System Owner mirror, the completeness registry and the review chip.
 * Pure test: no server, no browser.
 */
import fs from 'fs';
import path from 'path';
import {
  MAINTENANCE_DOMAIN,
  SSP_DIGEST_VERSION,
  SSP_ROLE_LABELS,
  SSP_SECTIONS,
  SSP_SIGNABLE_SECTION_IDS,
  effectiveSspRoles,
  formatRoleHolder,
  isCuiProgram,
  overallImpact,
  sectionCanonical,
  suggestedCategorization,
  systemOwnerMirror,
} from '../src/data/ssp/sspSections';
import {
  computeSspCompleteness,
  isBlank,
  resolveSspCompletenessInput,
  sectionReviewStatus,
  sspCompletenessFromReport,
  type SspCompletenessInput,
} from '../src/data/ssp/sspCompleteness';
import { SSP_PROFILE_MAX_BYTES, validateSspProfile, type SspProfile, type SspRoleEntry } from '../src/types/sspProfile';
import type { SspMetadataFields } from '../src/types/sspMetadata';

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

const role = (over: Partial<SspRoleEntry> & Pick<SspRoleEntry, 'roleKey'>, id = 'r1'): SspRoleEntry => ({ id, name: 'Jane Doe', email: 'jane@x.test', ...over });
const fullProfile = (): SspProfile => ({
  systemIdentifier: 'SYS-001',
  confidentialityImpact: 'MODERATE',
  integrityImpact: 'MODERATE',
  availabilityImpact: 'LOW',
  roles: [
    role({ roleKey: 'system_owner' }, 'a'),
    role({ roleKey: 'isso_ciso', name: 'Ira', email: 'ira@x.test' }, 'b'),
    role({ roleKey: 'ir_reporting_primary', certificateOnFile: true }, 'c'),
    role({ roleKey: 'custom', customTitle: 'Privacy officer', name: 'Pat', email: '' }, 'd'),
  ],
  maintenance: {
    hardwareMaintainedByOrg: true,
    hardwareOwnedByOrg: true,
    softwareMaintainedByOrg: true,
    softwareOwnedByOrg: false,
    exceptions: 'Leased printers',
  },
});
const fullMeta = (): SspMetadataFields => ({
  systemName: 'Enclave',
  organizationName: 'Acme',
  cageCode: '1ABC2',
  samStatus: 'ACTIVE',
  systemOwner: 'Jane Doe (jane@x.test)',
  authorName: 'Author',
  assessmentDate: '2026-11-01',
  systemBoundaryScope: 'Boundary text',
  systemEnvironment: 'Env text',
  cloudServiceProviders: 'CSP text',
  version: '1.0.0',
  serviceCommitments: 'Commitments',
});

console.log('\n--- Profile validation ---');
const v1 = validateSspProfile(fullProfile());
assert(v1.ok, 'V1 a full valid profile is ok', v1);
const v2 = validateSspProfile({ foo: 1 });
assert(!v2.ok && v2.error === 'Unknown profile field', 'V2 an unknown key is rejected', v2);
const v3 = validateSspProfile({ confidentialityImpact: 'EXTREME-MARK' });
assert(!v3.ok && v3.error.includes('confidentialityImpact') && !v3.error.includes('MARK'), 'V3 a bad impact names the field and not the value', v3);
const v4 = validateSspProfile({ roles: [role({ roleKey: 'system_owner', email: 'x-MARK' })] });
assert(!v4.ok && v4.error.includes('roles[0].email') && !v4.error.includes('MARK'), 'V4 a bad email names the path and not the value', v4);
const v5 = validateSspProfile({ roles: Array.from({ length: 41 }, (_, i) => role({ roleKey: 'ir_lead' }, `r${i}`)) });
assert(!v5.ok, 'V5 41 roles fail', v5);
assert(validateSspProfile({ roles: Array.from({ length: 40 }, (_, i) => role({ roleKey: 'ir_lead' }, `r${i}`)) }).ok, 'V5b 40 roles are ok');
const v6 = validateSspProfile({ roles: [role({ roleKey: 'custom' })] });
assert(!v6.ok && v6.error.includes('roles[0].customTitle'), 'V6 a custom role without a title fails', v6);
const v7 = validateSspProfile({ maintenance: { hardwareOwnedByOrg: 'yes' } });
assert(!v7.ok && v7.error.includes('hardwareOwnedByOrg') && !v7.error.includes('yes'), 'V7 a non-boolean answer fails', v7);
// V8: the per-field caps keep a profile that passes them far below the byte cap, so the cap cannot be reached through valid fields
const maxed = validateSspProfile({
  systemIdentifier: 'S'.repeat(128),
  maintenance: { exceptions: '€'.repeat(20000) },
  roles: Array.from({ length: 40 }, (_, i) => role({ roleKey: 'custom', customTitle: 'T'.repeat(128), name: 'N'.repeat(128), email: `${'a'.repeat(64)}@${'b'.repeat(50)}.test`, memberUserId: 'u'.repeat(128) }, `r${i}`)),
});
assert(maxed.ok && new TextEncoder().encode(JSON.stringify(maxed.value)).length < SSP_PROFILE_MAX_BYTES, 'V8 the largest profile the field caps allow stays under the byte cap', maxed.ok ? undefined : maxed);
const v9 = validateSspProfile({ roles: [role({ roleKey: 'system_owner', name: 'N'.repeat(129) })] });
assert(!v9.ok && v9.error.includes('roles[0].name'), 'V9 a 129-character name fails', v9);
assert(!validateSspProfile(null).ok && !validateSspProfile([]).ok, 'V10 a non-object profile fails');
assert(!validateSspProfile({ roles: [role({ roleKey: 'system_owner', certificateOnFile: true })] }).ok, 'V11 a certificate flag is only for incident-reporting roles');
assert(!validateSspProfile({ roles: [role({ roleKey: 'system_owner', id: 'bad id' })] }).ok, 'V12 a role id with a space fails');
assert(!validateSspProfile({ roles: [role({ roleKey: 'system_owner', memberUserId: 'bad id' })] }).ok, 'V13 a member id with a space fails');
const vEmpty = validateSspProfile({ maintenance: {} });
assert(vEmpty.ok && vEmpty.value.maintenance?.hardwareOwnedByOrg === null && vEmpty.value.maintenance?.exceptions === '', 'V14 missing maintenance answers read as null');

console.log('\n--- Registry and canonical text ---');
assert(SSP_SECTIONS.map((s) => s.id).join() === 'identification,roles,system_details,data_inventory,environment,maintenance', 'E1 sections in display order (1.3 and 1.4 join after the roles)');
assert(SSP_SECTIONS.map((s) => s.number).join() === '1.1,1.2,1.3,1.4,2.1,2.3', 'E2 section numbers follow the template');
assert(SSP_SIGNABLE_SECTION_IDS.join() === 'identification,roles,environment,maintenance' && SSP_SECTIONS.filter((s) => !s.signable).map((s) => s.id).join() === 'system_details,data_inventory', 'E3 four of the six sections are signable: 1.3 and 1.4 are derived from the register and never signed');
assert(SSP_DIGEST_VERSION === 'ssp-section-v1' && MAINTENANCE_DOMAIN === 'MA', 'E4 the digest version and the maintenance domain are pinned');
assert(Object.keys(SSP_ROLE_LABELS).length === 9, 'E5 every role key has a label');

const X = { metadata: fullMeta(), profile: fullProfile() };
assert(sectionCanonical('identification', X) === sectionCanonical('identification', { ...X, metadata: { ...X.metadata, assessmentDate: '2030-01-01' } }), 'D1 assessmentDate is not part of identification');
const renamed = { ...X, metadata: { ...X.metadata, systemName: 'Other' } };
assert(sectionCanonical('identification', X) !== sectionCanonical('identification', renamed), 'D2 systemName changes identification');
assert(sectionCanonical('environment', X) === sectionCanonical('environment', renamed), 'D2b systemName leaves environment unchanged');
const crlf = { ...X, metadata: { ...X.metadata, systemBoundaryScope: 'a\r\nb  ' } };
const lf = { ...X, metadata: { ...X.metadata, systemBoundaryScope: 'a\nb' } };
assert(sectionCanonical('environment', crlf) === sectionCanonical('environment', lf), 'D3 CRLF versus LF and trailing spaces give the same text');
const shuffled: SspProfile = {};
const src = fullProfile() as unknown as Record<string, unknown>;
for (const k of Object.keys(src).reverse()) (shuffled as Record<string, unknown>)[k] = src[k];
assert(['identification', 'roles', 'maintenance'].every((id) => sectionCanonical(id as 'roles', X) === sectionCanonical(id as 'roles', { ...X, profile: shuffled })), 'D4 shuffled profile key order gives the same text');
assert(sectionCanonical('system_details', X) === '[]' && sectionCanonical('data_inventory', X) === '[]', 'D4b the derived sections 1.3 and 1.4 have no saved fields to hash');
const ownerChanged = { ...X, metadata: { ...X.metadata, systemOwner: 'Someone Else' } };
assert(sectionCanonical('roles', X) === sectionCanonical('roles', ownerChanged), 'D5 with a system_owner row the legacy systemOwner is ignored');
const noRow = { metadata: fullMeta(), profile: { roles: [role({ roleKey: 'isso_ciso' })] } as SspProfile };
assert(sectionCanonical('roles', noRow) !== sectionCanonical('roles', { ...noRow, metadata: { ...noRow.metadata, systemOwner: 'Someone Else' } }), 'D5b without a system_owner row it counts');
const reordered = { ...X, profile: { ...X.profile, roles: [...(X.profile.roles ?? [])].reverse() } };
assert(sectionCanonical('roles', X) !== sectionCanonical('roles', reordered), 'D6 reordering role rows changes the text');
assert(sectionCanonical('roles', X) === sectionCanonical('roles', { ...X, profile: { ...X.profile, roles: X.profile.roles?.map((r, i) => ({ ...r, id: `z${i}` })) } }), 'D7 a role row id is not part of the text');
assert(sectionCanonical('maintenance', X) !== sectionCanonical('maintenance', { ...X, profile: { ...X.profile, maintenance: { ...X.profile.maintenance!, exceptions: 'Other' } } }), 'D8 the exceptions are part of maintenance');
assert(sectionCanonical('identification', { metadata: {}, profile: null }) === sectionCanonical('identification', { metadata: { systemName: '  ' }, profile: {} }), 'D9 missing and blank values agree');

console.log('\n--- Categorization ---');
const mod = { confidentiality: 'MODERATE', integrity: 'MODERATE', availability: 'MODERATE' };
assert(JSON.stringify(suggestedCategorization({ framework: 'CMMC_L2' })) === JSON.stringify(mod), 'S1 CMMC_L2 suggests Moderate across the board');
assert(['CMMC_L1', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'].every((f) => suggestedCategorization({ framework: f }) === null), 'S2 CMMC_L1, SOC 2 and HIPAA suggest nothing');
const hi = suggestedCategorization({ framework: 'NIST_800_53_REV5', baseline: 'HIGH' });
assert(!!hi && hi.confidentiality === 'HIGH' && hi.integrity === 'HIGH' && hi.availability === 'HIGH', 'S3 NIST with baseline HIGH suggests HIGH');
assert(suggestedCategorization({ framework: 'NIST_800_53_REV5', baseline: null }) === null, 'S3b NIST without a baseline suggests nothing');
assert(isCuiProgram('CMMC_L2') && !isCuiProgram('CMMC_L1') && !isCuiProgram(null), 'S4 only CMMC_L2 is a CUI program');
const emptyL2: SspCompletenessInput = { framework: 'CMMC_L2', metadata: {}, profile: null };
const l2 = computeSspCompleteness(emptyL2);
assert(['confidentialityImpact', 'integrityImpact', 'availabilityImpact'].every((id) => l2.sections[0].items.find((i) => i.id === id)?.missing), 'S5 the C/I/A items are missing with no profile even though one is suggested');
assert(overallImpact(fullProfile()) === 'MODERATE' && overallImpact({ ...fullProfile(), availabilityImpact: 'HIGH' }) === 'HIGH', 'S6 the overall impact is the high-water mark');
assert(overallImpact({ ...fullProfile(), integrityImpact: null }) === null && overallImpact(null) === null, 'S7 the overall impact is null while any is unset');

console.log('\n--- Mirror and roles ---');
const ownerProfile: SspProfile = { roles: [{ id: 'a', roleKey: 'system_owner', name: 'Jane Doe', email: 'jane@x.test' }] };
assert(systemOwnerMirror(ownerProfile, '') === 'Jane Doe (jane@x.test)', 'M1 the mirror is "Name (email)"');
assert(systemOwnerMirror(ownerProfile, 'Jane Doe (jane@x.test)') === null, 'M1b no write when the field already holds it');
assert(systemOwnerMirror({ roles: [role({ roleKey: 'isso_ciso' })] }, '') === null && systemOwnerMirror(null, '') === null, 'M1c no row, no write');
assert(systemOwnerMirror({ roles: [{ id: 'a', roleKey: 'system_owner', name: '  ', email: 'jane@x.test' }] }, '') === null, 'M1d a blank name, no write');
assert(systemOwnerMirror({ roles: [{ id: 'a', roleKey: 'system_owner', name: 'Jane', email: '' }] }) === 'Jane', 'M1e no email gives the name alone');
assert(formatRoleHolder({ name: 'Jane', email: '' }) === 'Jane' && formatRoleHolder({ name: ' ', email: 'a@b.test' }) === '', 'M1f formatRoleHolder');
const legacy = effectiveSspRoles(null, 'Jane');
assert(legacy.length === 1 && legacy[0].roleKey === 'system_owner' && legacy[0].name === 'Jane', 'M2 a legacy owner is one synthesized system_owner row', legacy);
assert(effectiveSspRoles(ownerProfile, 'Jane').length === 1 && effectiveSspRoles(ownerProfile, 'Jane')[0].name === 'Jane Doe', 'M2b a stored system_owner row wins over the legacy value');
assert(effectiveSspRoles(null, '  ').length === 0 && effectiveSspRoles(null).length === 0, 'M2c a blank legacy owner adds nothing');

console.log('\n--- Completeness ---');
const order = ['identification', 'roles', 'system_details', 'data_inventory', 'environment', 'maintenance'].join();
for (const framework of ['CMMC_L2', 'CMMC_L1', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY']) {
  const c = computeSspCompleteness({ framework, metadata: {}, profile: null });
  const perSection = c.sections.every((s) => s.requiredMissing === s.items.filter((i) => i.severity === 'required').length && s.requiredMissing === s.requiredTotal);
  assert(perSection, `C1 ${framework} empty: every required item is missing, per section`, c.sections.map((s) => [s.sectionId, s.requiredMissing]));
  assert(c.requiredMissing === c.sections.reduce((n, s) => n + s.requiredMissing, 0) && c.sections.map((s) => s.sectionId).join() === order && !c.complete, `C1 ${framework} empty: total and section order`);
}
const filled = computeSspCompleteness({ framework: 'CMMC_L2', metadata: fullMeta(), profile: fullProfile() });
assert(filled.complete && filled.requiredMissing === 0, 'C2 a fully filled CMMC_L2 input is complete', filled.sections.map((s) => [s.sectionId, s.items.filter((i) => i.missing).map((i) => i.id)]));
const maintenanceOf = (m: SspProfile['maintenance']) => computeSspCompleteness({ framework: 'CMMC_L2', metadata: fullMeta(), profile: { ...fullProfile(), maintenance: m } }).sections.find((s) => s.sectionId === 'maintenance')!;
const allYes = { hardwareMaintainedByOrg: true, hardwareOwnedByOrg: true, softwareMaintainedByOrg: true, softwareOwnedByOrg: true, exceptions: '' };
assert(maintenanceOf({ ...allYes, hardwareOwnedByOrg: false, exceptions: '' }).requiredMissing === 1, 'C3 an answer of No with no exceptions is one missing item');
assert(maintenanceOf({ ...allYes, hardwareOwnedByOrg: false, exceptions: 'x' }).requiredMissing === 0, 'C3b with exceptions there is none');
assert(maintenanceOf(allYes).requiredMissing === 0 && !maintenanceOf(allYes).items.some((i) => i.id === 'maintenance:exceptions'), 'C3c all Yes asks for no exceptions');
const roleItem = (c: ReturnType<typeof computeSspCompleteness>, key: string) => c.sections[1].items.find((i) => i.id === `role:${key}`)!;
assert(!roleItem(computeSspCompleteness({ framework: 'CMMC_L2', metadata: { systemOwner: 'Jane' }, profile: null }), 'system_owner').missing, 'C4 a legacy systemOwner fills the System Owner role');
assert(roleItem(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: { roles: [role({ roleKey: 'system_owner', name: '  ' })] } }), 'system_owner').missing, 'C5 a System Owner row with a blank name is missing');
assert(roleItem(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null }), 'ir_reporting_primary').severity === 'required' && roleItem(computeSspCompleteness({ framework: 'SOC_2_TYPE_II', metadata: {}, profile: null }), 'ir_reporting_primary').severity === 'advisory', 'C6 incident reporting, primary is required for CMMC_L2 and advisory for SOC 2');
const boundary = (c: ReturnType<typeof computeSspCompleteness>) => c.sections.find((s) => s.sectionId === 'environment')!.items.find((i) => i.id === 'systemBoundaryScope')!;
assert(boundary(computeSspCompleteness({ framework: 'CMMC_L2', metadata: { systemBoundaryScope: ' ' }, profile: null })).missing && !boundary(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, boundaryFallback: 'X' })).missing, 'C7 a blank boundary is missing unless a fallback stands in');
const resolved = resolveSspCompletenessInput({
  meta: { systemName: '' },
  tenant: { systemName: 'T', name: 'Tenant', cageCode: '', samStatus: 'ACTIVE', systemOwner: '', systemBoundaryScope: 'Tenant boundary' },
  program: { boundarySummary: '', framework: 'CMMC_L2' },
  framework: 'CMMC_L2',
  profile: null,
});
const resolvedC = computeSspCompleteness(resolved);
assert(!resolvedC.sections[0].items.find((i) => i.id === 'systemName')!.missing && resolved.metadata.systemName === 'T', 'C8 a blank systemName falls back to the tenant');
assert(!resolvedC.sections[0].items.find((i) => i.id === 'organizationName')!.missing && !resolvedC.sections[0].items.find((i) => i.id === 'samStatus')!.missing, 'C8b organization and SAM status fall back too');
assert(resolved.boundaryFallback === 'Tenant boundary' && resolveSspCompletenessInput({ meta: {}, tenant: { systemName: '', name: '', cageCode: '', samStatus: 'PENDING', systemOwner: '' }, program: { boundarySummary: 'Program boundary', framework: 'CMMC_L2' }, framework: 'CMMC_L2', profile: null }).boundaryFallback === 'Program boundary', 'C8c the program boundary comes before the tenant boundary');
const fromReport = sspCompletenessFromReport({ framework: 'CMMC_L2', systemName: 'S', organizationName: 'O', primaryAssessor: 'A', boundaryDescription: 'B', systemOwner: 'Jane' }, null);
const fromReportC = computeSspCompleteness(fromReport);
assert(fromReport.framework === 'CMMC_L2' && ['systemName', 'organizationName', 'authorName', 'systemBoundaryScope', 'role:system_owner'].every((id) => !fromReportC.sections.flatMap((s) => s.items).find((i) => i.id === id)!.missing), 'C9 a report form maps onto the same items');
// the items with a reportField classify like exportReadiness's SSP lists
const reportItems = l2.sections.flatMap((s) => s.items).filter((i) => i.reportField);
const required = reportItems.filter((i) => i.severity === 'required').map((i) => i.reportField).sort().join();
const advisory = reportItems.filter((i) => i.severity === 'advisory').map((i) => i.reportField).sort().join();
assert(required === ['systemName', 'organizationName', 'systemOwner', 'primaryAssessor', 'boundaryDescription'].sort().join() && advisory === ['cageCode', 'samStatus'].sort().join(), 'C10 the reportField items match the SSP export lists', { required, advisory });
assert(isBlank(undefined) && isBlank('  ') && isBlank(3) && !isBlank(' a '), 'C11 isBlank');
const envItems = (c: ReturnType<typeof computeSspCompleteness>) => c.sections.find((s) => s.sectionId === 'environment')!.items;
assert(envItems(computeSspCompleteness({ framework: 'SOC_2_TYPE_II', metadata: {}, profile: null })).some((i) => i.id === 'serviceCommitments') && !envItems(l2).some((i) => i.id === 'serviceCommitments'), 'C12 service commitments are listed for SOC 2 only');
assert(computeSspCompleteness({ framework: 'HIPAA_SECURITY', metadata: {}, profile: null }).sections[0].items.find((i) => i.id === 'systemIdentifier')?.severity === 'advisory', 'C13 the identifier is advisory for HIPAA');

console.log('\n--- Review status ---');
const review = { id: 'x', sectionId: 'roles', contentSha256: 'a'.repeat(64), reviewerUserId: 'u', reviewerName: 'N', reviewerRole: 'TENANT_OWNER', createdAt: '2026-11-01T00:00:00.000Z' };
assert(sectionReviewStatus(null, false) === 'unavailable' && sectionReviewStatus({ sectionId: 'roles', currentDigest: 'd', latest: review, reviewed: true }, false) === 'unavailable', 'R1 unsupported is unavailable');
assert(sectionReviewStatus({ sectionId: 'roles', currentDigest: 'd', latest: null, reviewed: false }, true) === 'not_reviewed' && sectionReviewStatus(undefined, true) === 'not_reviewed', 'R1b no review is not_reviewed');
assert(sectionReviewStatus({ sectionId: 'roles', currentDigest: 'd', latest: review, reviewed: true }, true) === 'reviewed', 'R1c a current review is reviewed');
assert(sectionReviewStatus({ sectionId: 'roles', currentDigest: 'd', latest: review, reviewed: false }, true) === 'changed_since_review', 'R1d a stale review is changed_since_review');

console.log('\n--- Source ---');
for (const file of ['src/types/sspProfile.ts', 'src/data/ssp/sspSections.ts', 'src/data/ssp/sspCompleteness.ts']) {
  const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  assert(!/console\.|localStorage|sessionStorage|\.setItem\(|fetch\(|node:crypto|subtle/.test(source), `X1 ${file} has no console, storage, network or crypto call`);
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
