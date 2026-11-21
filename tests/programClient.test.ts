import fs from 'fs';
import path from 'path';
import { ApiClient, onProgramRequired } from '../src/services/apiClient';
import {
  archiveImpactLines,
  createsOrganizationDefault,
  nextOrganizationDefault,
  noProgramCopy,
  PROGRAM_SCOPED_TABS,
  programGate,
  shouldPromptFirstProgram,
} from '../src/data/programDefaultChoice';
import {
  activeProgramStorageKey,
  isCurrentResponse,
  parseProgramList,
  parseProgramMetrics,
  parseProgramResponse,
  pickActiveProgramId,
  programCacheSegment,
  programCreateBody,
  programScopeKey,
  shouldPersistAssessment,
  validateProgramInput,
} from '../src/data/programSync';
import { boundaryAssets, membershipDelta, membershipLabels, parseAssetMemberships, parseProgramAssets } from '../src/data/programAssets';
import { nistControlsWithPrivacy,programBaselineToCia, programFrameworkControls } from '../src/data/programScope';
import { describeOverlayChange, isOverlayConflict, menuLockReason, overlayBannerText, overlayLockReason, overlayLockText, overlayRemovals, overlayScopeNote, overlaySaveErrorMessage, programOverlayLabels, summarizeOverlayChange } from '../src/data/overlayScoping';
import type { OverlayLock, OverlayLockContext } from '../src/data/overlayScoping';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { StorageService } from '../src/services/storageService';
import { ASSESSMENT_KEY_PREFIX } from '../src/services/browserStorageScrub';
import type { AssessmentState } from '../src/types/cmmc';
import type { Tenant } from '../src/types/tenant';

/**
 * Multi-program client contract: the server's program list and metrics parsed, the active-program choice, the scope keys, the create-form
 * validation, the baseline and catalog helpers, and the x-program-id header on every scoped apiClient method (against a stubbed fetch).
 * Pure test: no server, no browser.
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

const noOverlays = { nonNetworkedOnly: false };

console.log('--- parseProgramList ---');
const p1 = parseProgramList({ programs: [{ id: 'p1', name: 'Default', framework: 'CMMC_L2', baseline: null, isDefault: true, archived: false }] });
assert(p1.length === 1 && p1[0].framework === 'CMMC_L2' && p1[0].isDefault === true && p1[0].archived === false, 'P1 one program parses with its framework, default flag and archived flag', p1);
const p2 = parseProgramList({ programs: [null, 5, { id: '' }, { id: 'p2', framework: 'FOO' }, { id: 'p3', framework: 'CMMC_L1' }] });
assert(p2.length === 1 && p2[0].id === 'p3' && p2[0].name === 'Untitled program', 'P2 unusable entries are dropped and a missing name falls back', p2);
let threw = false;
let empties: number[] = [];
try {
  empties = [parseProgramList(null).length, parseProgramList([]).length, parseProgramList('x').length, parseProgramList({ programs: 7 }).length];
} catch { threw = true; }
assert(!threw && empties.every((n) => n === 0), 'P3 null, [], a string and { programs: 7 } give [] without throwing', empties);
const p4 = parseProgramList({
  programs: [
    { id: 'a', framework: 'NIST_800_53_REV5', baseline: 'MODERATE' },
    { id: 'b', framework: 'NIST_800_53_REV5', baseline: 'high' },
    { id: 'c', framework: 'CMMC_L2', baseline: 'HIGH' },
    { id: 'd', framework: 'NIST_800_53_REV5', baseline: 'ultra' },
    { id: 'e', framework: 'NIST_800_53_REV5', baseline: 'privacy' },
  ],
});
assert(p4[0].baseline === 'MODERATE' && p4[1].baseline === 'HIGH', 'P4a NIST baselines are the upper-case union (any input case)', p4.map((p) => p.baseline));
assert(p4[2].baseline === null && p4[3].baseline === null && p4[4].baseline === null, 'P4b a CMMC baseline, an unknown one and privacy are null', p4.map((p) => p.baseline));
const p5 = parseProgramList({ programs: [{ id: 's', framework_id: 'CMMC_L2', is_default: true, system_boundary_summary: 'B' }] });
assert(p5.length === 1 && p5[0].framework === 'CMMC_L2' && p5[0].isDefault === true && p5[0].boundarySummary === 'B', 'P5 the snake_case spellings parse', p5);
const p6 = parseProgramList({
  programs: [{ id: 'x', name: ' Boundary ', description: 'd', frameworkId: 'NIST_800_53_REV5', baseline: 'LOW', systemBoundarySummary: 'S', isDefault: false, archivedAt: '2026-10-25T00:00:00.000Z' }],
});
assert(p6[0]?.framework === 'NIST_800_53_REV5' && p6[0].name === 'Boundary' && p6[0].boundarySummary === 'S' && p6[0].archived === true && p6[0].description === 'd', 'P6 the server camelCase fields (frameworkId, systemBoundarySummary, archivedAt) parse', p6);
const p7 = parseProgramList({ programs: [{ id: 'x', frameworkId: 'nist-800-53-r5', baseline: 'LOW' }] });
assert(p7[0]?.framework === 'NIST_800_53_REV5' && p7[0].baseline === 'LOW', 'P7 the nist-800-53-r5 alias is canonicalised', p7);

console.log('\n--- parseProgramMetrics ---');
const m1 = parseProgramMetrics({ documented: 112, total: 287, evidence: 5, openPoam: 3 });
assert(m1.documented === 112 && m1.total === 287 && m1.openPoam === 3 && m1.evidenceCount === 5, 'H9a the server `evidence` field maps to evidenceCount', m1);
const m2 = parseProgramMetrics({});
assert(m2.documented === null && m2.total === null && m2.openPoam === null && m2.evidenceCount === null, 'H9b an empty body is all null', m2);
const m3 = parseProgramMetrics({ documented: -1, total: 'x', evidence: NaN, openPoam: null });
assert(m3.documented === null && m3.total === null && m3.openPoam === null && m3.evidenceCount === null, 'H9c negative, non-numeric and NaN counts are null', m3);
assert(parseProgramMetrics(null).total === null, 'H9d a null body does not throw');

console.log('\n--- pickActiveProgramId ---');
const list = [
  { id: 'p1', isDefault: true, archived: false },
  { id: 'p2', isDefault: false, archived: false },
];
assert(pickActiveProgramId('p2', list) === 'p2', 'A1 a stored id that exists is kept');
assert(pickActiveProgramId('gone', list) === 'p1', 'A2 a stored id that is gone falls back to the organization default');
assert(pickActiveProgramId('p2', [list[0], { id: 'p2', isDefault: false, archived: true }]) === 'p1', 'A3 an archived stored id falls back to the organization default');
assert(pickActiveProgramId(null, [{ id: 'pA', isDefault: false, archived: true }, { id: 'pB', isDefault: false, archived: false }]) === 'pB', 'A4 without a default flag the first open program is used');
const mine = [
  { id: 'p1', isDefault: true, isMyDefault: false, archived: false },
  { id: 'p2', isDefault: false, isMyDefault: true, archived: false },
];
assert(pickActiveProgramId(null, mine) === 'p2', 'A7 the user\'s own default beats the organization default');
assert(pickActiveProgramId('p1', mine) === 'p1', 'A8 a stored open choice beats the user\'s own default');
assert(pickActiveProgramId(null, [mine[0], { ...mine[1], archived: true }]) === 'p1', 'A9 an archived own default falls back to the organization default');
const dated = [
  { id: 'new', isDefault: false, archived: false, createdAt: '2026-10-02T00:00:00.000Z' },
  { id: 'old', isDefault: false, archived: false, createdAt: '2026-10-01T00:00:00.000Z' },
  { id: 'undated', isDefault: false, archived: false },
];
assert(pickActiveProgramId(null, dated) === 'old', 'A10 with no default flag the oldest createdAt wins, a program without createdAt last');
assert(pickActiveProgramId(null, []) === null, 'A11 no programs and no stored id gives null');
assert(pickActiveProgramId('p1', []) === null, 'A5 no programs gives null');
assert(pickActiveProgramId('p1', [{ id: 'p1', isDefault: true, archived: true }]) === null, 'A6 only archived programs gives null');

console.log('\n--- scope keys ---');
assert(activeProgramStorageKey('t1') === 'pbc_active_program_t1', 'K1 the active-program storage key');
assert(programScopeKey('t1', 'p1') === 't1::p1' && programScopeKey('t1', null) === 't1', 'K4 programScopeKey is t::p, or t without a program');
assert(programCacheSegment({ isDefault: true, id: 'p1' } as { id: string }) === 'p1' && programCacheSegment({ id: 'p9' }) === 'p9' && programCacheSegment(null) === null, 'K5 every program uses its id as the cache segment (the default no longer shares the legacy key), none gives null');
const mp = parseProgramList({ programs: [{ id: 'a', framework: 'CMMC_L2', isMyDefault: true }, { id: 'b', framework: 'CMMC_L2', is_my_default: true }, { id: 'c', framework: 'CMMC_L2' }] });
assert(mp[0].isMyDefault === true && mp[1].isMyDefault === true && mp[2].isMyDefault === false, 'P9 isMyDefault / is_my_default parse, absent is false', mp);

console.log('\n--- programDefaultChoice ---');
const open1 = { id: 'o1', name: 'Alpha', archived: false, isDefault: true, createdAt: '2026-10-01T00:00:00.000Z' };
const open2 = { id: 'o2', name: 'Beta', archived: false, isDefault: false, createdAt: '2026-10-02T00:00:00.000Z' };
const open3 = { id: 'o3', name: 'Gamma', archived: false, isDefault: false, createdAt: '2026-10-03T00:00:00.000Z' };
const gone = { id: 'x', name: 'Old', archived: true, isDefault: false, createdAt: '2026-09-01T00:00:00.000Z' };
assert(programGate({ programsStatus: 'loading', programs: [], canManagePrograms: true }) === null && programGate({ programsStatus: 'error', programs: [], canManagePrograms: true }) === null, 'D1 no gate while the programs are not loaded');
assert(programGate({ programsStatus: 'ready', programs: [open1], canManagePrograms: true }) === null, 'D2 no gate with an open program');
assert(JSON.stringify(programGate({ programsStatus: 'ready', programs: [], canManagePrograms: true })) === '{"kind":"none","canCreate":true}' && JSON.stringify(programGate({ programsStatus: 'ready', programs: [gone], canManagePrograms: false })) === '{"kind":"all-archived","canCreate":false}', 'D3 the gate says none or all-archived, and whether the viewer can create');
const promptBase = { programsStatus: 'ready', programs: [], canManagePrograms: true, onboardingOpen: false, dismissed: false };
assert(shouldPromptFirstProgram(promptBase), 'D4 the first-program form opens for a manager with no program');
assert(!shouldPromptFirstProgram({ ...promptBase, canManagePrograms: false }) && !shouldPromptFirstProgram({ ...promptBase, onboardingOpen: true }) && !shouldPromptFirstProgram({ ...promptBase, dismissed: true }) && !shouldPromptFirstProgram({ ...promptBase, programsStatus: 'loading' }) && !shouldPromptFirstProgram({ ...promptBase, programs: [gone] }), 'D5 it stays closed for a reader, during onboarding, once dismissed, while loading, and when programs exist (archived ones too)');
assert(noProgramCopy({ kind: 'none', canCreate: true }).title === 'Create your first program' && noProgramCopy({ kind: 'none', canCreate: false }).title === 'No program yet' && noProgramCopy({ kind: 'all-archived', canCreate: true }).body.includes('Restore one on the Programs page') && noProgramCopy({ kind: 'all-archived', canCreate: false }).body.includes('Ask a Tenant Owner or Admin'), 'D6 the four no-program texts');
assert(nextOrganizationDefault([open1, open2, open3, gone], 'o1')?.id === 'o2' && nextOrganizationDefault([open1], 'o1') === null && nextOrganizationDefault([open1, gone], 'o1') === null, 'D7 the next organization default is the oldest other open program');
assert(createsOrganizationDefault([]) && createsOrganizationDefault([gone]) && !createsOrganizationDefault([open1, open2]), 'D8 a new program becomes the organization default only when no open program is');
const lines1 = archiveImpactLines(open1, [open1, open2, open3]);
assert(lines1.length === 1 && lines1[0].tone === 'info' && lines1[0].text === 'It is the organization default. Beta (the oldest remaining active program) becomes the organization default.', 'D9 archiving the organization default names its successor', lines1);
const lines2 = archiveImpactLines({ ...open2, isMyDefault: true }, [open1, open2]);
assert(lines2.length === 1 && lines2[0].text.startsWith('It is your default program.'), 'D10 archiving your own default says where you land instead', lines2);
const lines2b = archiveImpactLines({ ...open2, isMyDefault: true }, [{ ...open2, isMyDefault: true }]);
assert(lines2b.length === 1 && lines2b[0].tone === 'warn', 'D10b archiving your own default when it is the last active program only warns (there is no default left to land on)', lines2b);
const lines3 = archiveImpactLines(open1, [open1, gone]);
assert(lines3.some((l) => l.tone === 'warn' && l.text.startsWith('It is the only active program.')) && !lines3.some((l) => l.text.includes('becomes the organization default')), 'D11 archiving the last active program warns', lines3);
assert(archiveImpactLines(open3, [open1, open2, open3]).length === 0, 'D12 an ordinary program has no impact lines');
assert(['dashboard', 'matrix', 'controls', 'evidence', 'vault', 'ssp', 'sspimport', 'configresults', 'poam', 'export'].every((t) => PROGRAM_SCOPED_TABS.has(t)) && !PROGRAM_SCOPED_TABS.has('programs') && !PROGRAM_SCOPED_TABS.has('settings') && !PROGRAM_SCOPED_TABS.has('rbac'), 'D13 the program-scoped tabs');

console.log('\n--- validateProgramInput ---');
const ctx = { tenantFrameworks: ['CMMC_L2', 'NIST_800_53_REV5'], existing: [{ id: 'p1', name: 'Boundary A' }] };
assert(!validateProgramInput({ name: '', framework: 'CMMC_L2' }, ctx).valid && !!validateProgramInput({ name: '   ', framework: 'CMMC_L2' }, ctx).errors.name, 'V1 an empty or blank name is an error');
assert(!!validateProgramInput({ name: 'x'.repeat(256), framework: 'CMMC_L2' }, ctx).errors.name && !validateProgramInput({ name: 'x'.repeat(255), framework: 'CMMC_L2' }, ctx).errors.name, 'V2 a 256-character name is an error, 255 is fine');
assert(!!validateProgramInput({ name: 'N', framework: 'NIST_800_53_REV5', baseline: null }, ctx).errors.baseline, 'V3 NIST without a baseline is an error');
const v4 = validateProgramInput({ name: 'N', framework: 'CMMC_L2', baseline: 'MODERATE' }, ctx);
assert(v4.valid && v4.value.baseline === null, 'V4 CMMC_L2 with a baseline is valid and the baseline is stripped', v4);
assert(!!validateProgramInput({ name: 'N', framework: 'HIPAA_SECURITY' }, { ...ctx, tenantFrameworks: ['CMMC_L2'] }).errors.framework, 'V5 a framework the tenant has not enabled is an error');
assert(!!validateProgramInput({ name: 'N', framework: 'CMMC_L2', seed: 'clone' }, ctx).errors.seed && !!validateProgramInput({ name: 'N', framework: 'CMMC_L2', seed: 'clone', sourceProgramId: '  ' }, ctx).errors.seed, 'V6 a clone seed without a source program is an error');
assert(!!validateProgramInput({ name: 'boundary a', framework: 'CMMC_L2' }, ctx).errors.name, 'V7 a name equal to an existing one ignoring case is an error');
assert(!validateProgramInput({ name: 'boundary a', framework: 'CMMC_L2' }, { ...ctx, editingId: 'p1' }).errors.name, 'V7b renaming a program to its own name (other case) is allowed');
assert(!!validateProgramInput({ name: 'N', framework: 'NIST_800_53_REV5', baseline: 'privacy' }, ctx).errors.baseline && !!validateProgramInput({ name: 'N', framework: 'NIST_800_53_REV5', baseline: 'ultra' }, ctx).errors.baseline, 'V8 privacy and unknown baselines are not accepted for NIST');
const v9 = validateProgramInput({ name: '  Boundary B  ', framework: 'NIST_800_53_REV5', baseline: 'high', seed: 'clone', sourceProgramId: 'p1', description: 'd', boundarySummary: 'S' }, ctx);
assert(v9.valid && v9.value.name === 'Boundary B' && v9.value.baseline === 'HIGH' && v9.value.seed === 'clone' && v9.value.sourceProgramId === 'p1', 'V9 a valid input is trimmed and normalised', v9);
const body9 = programCreateBody(v9.value) as { frameworkId?: string; baseline?: string; seed?: { cloneFrom?: string }; systemBoundarySummary?: string };
assert(body9.frameworkId === 'NIST_800_53_REV5' && body9.baseline === 'HIGH' && body9.seed?.cloneFrom === 'p1' && body9.systemBoundarySummary === 'S', 'V10 the request body uses the server field names and { cloneFrom }', body9);
const bodyBlank = programCreateBody(validateProgramInput({ name: 'N', framework: 'CMMC_L2', baseline: 'LOW' }, ctx).value);
assert(!('seed' in bodyBlank) && !('baseline' in bodyBlank), 'V11 a blank CMMC program sends no seed and no baseline', bodyBlank);

console.log('\n--- baselines and catalogs ---');
for (const level of ['LOW', 'MODERATE', 'HIGH'] as const) {
  const cia = programBaselineToCia(level);
  assert(cia.confidentiality === level && cia.integrity === level && cia.availability === level && cia.isAllControlsApplied === false, `B1 ${level} gives the ${level} triad`, cia);
}
assert(programBaselineToCia(null).isAllControlsApplied === true, 'B1 a null baseline means all controls');
const nist = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'MODERATE' }, noOverlays);
assert(nist.length > 0 && nist.length === getFrameworkControls('NIST_800_53_REV5', 'MODERATE').length, 'B2 a NIST MODERATE program has the MODERATE catalog length', nist.length);
const nistLow = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: 'LOW' }, noOverlays).length;
const nistAll = programFrameworkControls({ framework: 'NIST_800_53_REV5', baseline: null }, noOverlays).length;
assert(nistLow < nist.length && nist.length <= nistAll && nistAll === getFrameworkControls('NIST_800_53_REV5').length, 'B2b LOW is smaller than MODERATE, a null baseline is the whole catalog', { nistLow, moderate: nist.length, nistAll });
for (const fw of ['CMMC_L1', 'CMMC_L2'] as const) {
  assert(programFrameworkControls({ framework: fw, baseline: null }, noOverlays).length === getFrameworkControls(fw).length, `B3 ${fw} control count is unchanged by the program helper`);
}
assert(programFrameworkControls({ framework: 'CMMC_L2', baseline: null }, { nonNetworkedOnly: true }).length === getFrameworkControls('CMMC_L2', 'ALL_CONTROLS', { nonNetworkedOnly: true }).length, 'B3b overlays pass through');

console.log('\n--- privacy baseline ---');
const NIST = 'NIST_800_53_REV5';
const catalog = getFrameworkControls(NIST);
const modIds = new Set(getFrameworkControls(NIST, 'MODERATE').map((c) => c.id));
const lowIds = new Set(getFrameworkControls(NIST, 'LOW').map((c) => c.id));
const highIds = new Set(getFrameworkControls(NIST, 'HIGH').map((c) => c.id));
const privIds = new Set(catalog.filter((c) => c.baselines?.privacy).map((c) => c.id));
const unionOf = (a: Set<string>) => new Set([...a, ...privIds]);
const privOnly = [...privIds].find((id) => !modIds.has(id));
const modPriv = programFrameworkControls({ framework: NIST, baseline: 'MODERATE', privacyBaseline: true }, noOverlays);
const modPrivIds = modPriv.map((c) => c.id);
assert(privIds.size > 0 && privOnly !== undefined, 'PB0 the catalog has privacy controls outside the Moderate baseline', privIds.size);
assert(modPriv.length === unionOf(modIds).size && new Set(modPrivIds).size === modPriv.length, 'PB1 MODERATE + privacy is the union, each control once', { got: modPriv.length, want: unionOf(modIds).size });
assert(privOnly !== undefined && modPrivIds.includes(privOnly), 'PB2 a privacy-only control is included', privOnly);
const catalogOrder = catalog.map((c) => c.id).filter((id) => unionOf(modIds).has(id));
assert(modPrivIds.join('|') === catalogOrder.join('|'), 'PB3 catalog order is preserved');
assert(programFrameworkControls({ framework: NIST, baseline: 'MODERATE', privacyBaseline: false }, noOverlays).length === modIds.size && programFrameworkControls({ framework: NIST, baseline: 'MODERATE' }, noOverlays).length === modIds.size, 'PB4 privacy false and the field absent leave the baseline unchanged', modIds.size);
assert(programFrameworkControls({ framework: 'CMMC_L2', baseline: null, privacyBaseline: true }, noOverlays).length === getFrameworkControls('CMMC_L2').length, 'PB5 CMMC_L2 ignores privacyBaseline');
const lowPriv = programFrameworkControls({ framework: NIST, baseline: 'LOW', privacyBaseline: true }, noOverlays);
assert(lowPriv.length === unionOf(lowIds).size && lowPriv.every((c) => c.baselines?.low || c.baselines?.privacy), 'PB6 LOW + privacy: every control is low or privacy', lowPriv.length);
assert(programFrameworkControls({ framework: NIST, baseline: 'HIGH', privacyBaseline: true }, noOverlays).length === unionOf(highIds).size, 'PB7 HIGH + privacy is the union');
const tiers: Array<['LOW_LOW_LOW' | 'MOD_MOD_MOD' | 'HIGH_HIGH_HIGH', 'LOW' | 'MODERATE' | 'HIGH']> = [['LOW_LOW_LOW', 'LOW'], ['MOD_MOD_MOD', 'MODERATE'], ['HIGH_HIGH_HIGH', 'HIGH']];
for (const [tier, level] of tiers) {
  const want = programFrameworkControls({ framework: NIST, baseline: level, privacyBaseline: true }, noOverlays).map((c) => c.id).join('|');
  assert(nistControlsWithPrivacy(tier, true).map((c) => c.id).join('|') === want && nistControlsWithPrivacy(level, true).map((c) => c.id).join('|') === want, `PB8 the server helper matches programFrameworkControls for ${tier}`);
  assert(nistControlsWithPrivacy(tier, false).length === getFrameworkControls(NIST, level).length, `PB8b the server helper without privacy is the plain ${tier} baseline`);
}
const noWireless = { nonNetworkedOnly: false, noWireless: true };
const wirelessCatalog = getFrameworkControls(NIST, 'ALL_CONTROLS', noWireless);
assert(programFrameworkControls({ framework: NIST, baseline: 'MODERATE', privacyBaseline: true }, noWireless).every((c) => wirelessCatalog.some((w) => w.id === c.id)), 'PB9 overlays that remove controls apply to the privacy part too');
const pbList = parseProgramList({
  programs: [
    { id: 'a', framework: NIST, baseline: 'LOW', privacyBaseline: true },
    { id: 'b', framework: 'CMMC_L2', privacyBaseline: true },
    { id: 'c', framework: NIST, baseline: 'HIGH', privacy_baseline: true },
    { id: 'd', framework: NIST, baseline: 'HIGH', privacyBaseline: 'true' },
  ],
});
assert(pbList.map((p) => p.privacyBaseline).join() === 'true,false,true,false', 'PB10 parseProgramList reads privacyBaseline (camel or snake), NIST only, true only for boolean true', pbList.map((p) => p.privacyBaseline));
const vPriv = validateProgramInput({ name: 'N', framework: NIST, baseline: 'MODERATE', privacyBaseline: true }, ctx);
const vPrivCmmc = validateProgramInput({ name: 'N', framework: 'CMMC_L2', privacyBaseline: true }, ctx);
assert(vPriv.valid && vPriv.value.privacyBaseline === true, 'PB11 NIST MODERATE with privacyBaseline keeps it', vPriv);
assert(vPrivCmmc.valid && vPrivCmmc.value.privacyBaseline === false && Object.keys(vPrivCmmc.errors).length === 0, 'PB12 CMMC_L2 silently drops privacyBaseline', vPrivCmmc);
assert((programCreateBody(vPriv.value) as { privacyBaseline?: boolean }).privacyBaseline === true && !('privacyBaseline' in programCreateBody(vPrivCmmc.value)) && !('privacyBaseline' in programCreateBody(validateProgramInput({ name: 'N', framework: NIST, baseline: 'LOW' }, ctx).value)), 'PB13 the create body has privacyBaseline only when set');

console.log('\n--- stale responses and saves ---');
assert(shouldPersistAssessment('t1::pA', 't1::pB') === false, 'S1 a state of one program is not saved under another');
assert(shouldPersistAssessment('t1::pA', 't1::pA') === true && shouldPersistAssessment(null, null) === false, 'S2 the same scope is saved; no scope is not');
assert(isCurrentResponse(3, 4) === false && isCurrentResponse(4, 4) === true, 'S3 only the latest request sequence is current');

console.log('\n--- per-program assessment caches ---');
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  keys() { return Array.from(this.map.keys()).sort(); }
}
const cacheStore = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: cacheStore, configurable: true, writable: true });
const MARK = 'CUI-MARK-P2';
const cacheState = (tenantId: string, programId?: string): AssessmentState => ({
  version: '2.0.0',
  tenantId,
  ...(programId ? { programId } : {}),
  sspMetadata: { tenantId } as AssessmentState['sspMetadata'],
  controls: { 'AC.L1-3.1.1': { id: 'AC.L1-3.1.1', tenantId, status: 'IMPLEMENTED', implementationNotes: MARK, responsibleRole: 'r', lastUpdated: 'x', tags: [] } as AssessmentState['controls'][string] },
  evidenceIndex: [],
  lastSaved: 'x',
});
const cacheTenant = { id: 't1', name: 't1', serverBacked: true, primaryFramework: 'CMMC_L1' } as unknown as Tenant;

assert(StorageService.getAssessmentKey('t1', null) === 'pbc_cmmc_assessment_v3_t1' && StorageService.getAssessmentKey('t1', undefined) === 'pbc_cmmc_assessment_v3_t1', 'K2 getAssessmentKey without a segment is the legacy key');
assert(StorageService.getAssessmentKey('t1', 'p9') === 'pbc_cmmc_assessment_v3_t1::p9' && StorageService.getAssessmentKey('t1', 'p9').startsWith(ASSESSMENT_KEY_PREFIX), 'K3 getAssessmentKey with a segment is <legacy key>::<segment>');
assert(StorageService.getTenantKey('t1') === StorageService.getAssessmentKey('t1', null), 'K3b getTenantKey is the default program key');

StorageService.saveAssessment('t1', cacheState('t1', 'pA'), { segment: 'pA' });
StorageService.saveAssessment('t1', cacheState('t1', 'pB'), { segment: 'pB' });
assert(cacheStore.getItem('pbc_cmmc_assessment_v3_t1') === null && cacheStore.getItem('pbc_cmmc_assessment_v3_t1::pA') !== null && cacheStore.getItem('pbc_cmmc_assessment_v3_t1::pB') !== null, 'K6 a program save lands only under its own key, never under the legacy one');
assert(!cacheStore.getItem('pbc_cmmc_assessment_v3_t1::pA')!.includes(MARK), 'K7 the program cache holds no implementation notes');
const loadedA = StorageService.loadAssessment(cacheTenant, 'CMMC_L1', 'pA');
const loadedB = StorageService.loadAssessment(cacheTenant, 'CMMC_L1', 'pB');
assert(loadedA.programId === 'pA' && loadedB.programId === 'pB', 'K8 each program loads from its own cache', { a: loadedA.programId, b: loadedB.programId });
const freshP = StorageService.loadAssessment(cacheTenant, 'NIST_800_53_REV5', 'pNew');
assert(cacheStore.getItem('pbc_cmmc_assessment_v3_t1::pNew') !== null && cacheStore.getItem('pbc_cmmc_assessment_v3_t1') === null && Object.keys(freshP.controls).length > 100, 'K9 a program with no cache starts blank for its own framework, under its own key');
StorageService.saveAssessment('t1', cacheState('t1'));
assert(cacheStore.getItem('pbc_cmmc_assessment_v3_t1') !== null, 'K10 a save without a segment keeps writing the legacy key');
cacheStore.setItem('pbc_active_program_t1', 'pA');
cacheStore.setItem('pbc_cmmc_assessment_v3_t10::pA', '{}');
cacheStore.setItem('pbc_cmmc_assessment_v3_t2', '{}');
const listed = StorageService.listProgramKeys('t1').sort();
assert(JSON.stringify(listed) === JSON.stringify(['pbc_active_program_t1', 'pbc_cmmc_assessment_v3_t1::pA', 'pbc_cmmc_assessment_v3_t1::pB', 'pbc_cmmc_assessment_v3_t1::pNew']), 'K11 listProgramKeys finds the tenant\'s program caches and its active-program key, not another tenant\'s', listed);
StorageService.clearTenant('t1');
assert(JSON.stringify(cacheStore.keys()) === JSON.stringify(['pbc_cmmc_assessment_v3_t10::pA', 'pbc_cmmc_assessment_v3_t2']), 'K12 clearTenant removes the legacy cache, every program cache and the active-program key, nothing of another tenant', cacheStore.keys());

console.log('\n--- apiClient headers, against a stubbed fetch ---');
type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: () => 'sess', setItem: () => undefined, removeItem: () => undefined },
  configurable: true,
  writable: true,
});
function stub(status: number, body: unknown) {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => new Blob(['x']) } as Response;
  }) as typeof fetch;
}
const headerOf = (c: Call, name: string): string | undefined => (c.init.headers as Record<string, string> | undefined)?.[name];

async function headers() {
  try {
    stub(200, { controls: [] });
    await ApiClient.getControls('t1', { framework: 'CMMC_L2' }, 'p1');
    assert(headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1', 'H1 getControls sends x-tenant-id and x-program-id');
    await ApiClient.getControls('t1', undefined, null);
    assert(headerOf(calls[1], 'x-program-id') === undefined && headerOf(calls[1], 'x-tenant-id') === 't1', 'H2 a null program sends no x-program-id');

    stub(200, { jobs: [] });
    await ApiClient.sspListJobs('t1', 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1', 'H3 sspListJobs sends x-program-id');

    stub(200, { items: [], upcoming: [] });
    await ApiClient.getVmPoam('t1', { status: 'all', limit: 5 }, 'p1');
    assert(
      calls[0].url.endsWith('/api/v1/tenants/t1/vm/poam?status=all&limit=5') && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1',
      'H3b getVmPoam reads GET /vm/poam with the query, x-tenant-id and x-program-id',
      calls[0].url,
    );
    await ApiClient.getVmPoam('t1', undefined, null);
    assert(headerOf(calls[1], 'x-program-id') === undefined && calls[1].url.endsWith('/vm/poam'), 'H3c getVmPoam with a null program sends no x-program-id and no query');

    stub(200, { item: { id: 'i1', status: 'IN_PROGRESS' }, changed: true });
    const edited = await ApiClient.updateVmPoamItem('t1', 'i1', { status: 'IN_PROGRESS' }, '2026-11-01T10:00:00.000Z', 'p1');
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert(
      calls[0].init.method === 'PATCH' && calls[0].url.endsWith('/api/v1/tenants/t1/vm/poam/i1') && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1' && sent.expectedUpdatedAt === '2026-11-01T10:00:00.000Z' && sent.status === 'IN_PROGRESS' && edited.changed === true && edited.item.id === 'i1',
      'H3d updateVmPoamItem sends PATCH /vm/poam/:id with the patch and expectedUpdatedAt, x-tenant-id and x-program-id',
      [calls[0].url, calls[0].init.method, sent],
    );
    await ApiClient.updateVmPoamItem('t1', 'i1', { owner: 'IT' }, '2026-11-01T10:00:00.000Z', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'H3e updateVmPoamItem with a null program sends no x-program-id');

    stub(200, { events: [] });
    const evs = await ApiClient.getVmPoamItemEvents('t1', 'i1', 'p1');
    assert(calls[0].url.endsWith('/vm/poam/i1/events') && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && Array.isArray(evs), 'H3f getVmPoamItemEvents reads GET /vm/poam/:id/events with x-program-id', calls[0].url);

    stub(200, { item: { id: 'i1' } });
    const one = await ApiClient.getVmPoamItem('t1', 'i1', 'p1');
    assert(calls[0].url.endsWith('/api/v1/tenants/t1/vm/poam/i1') && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && one.id === 'i1', 'H3g getVmPoamItem reads GET /vm/poam/:id with x-program-id', calls[0].url);

    stub(409, { error: 'x', code: 'stale_write' });
    let staleReason: unknown;
    try { await ApiClient.updateVmPoamItem('t1', 'i1', { owner: 'IT' }, '2026-11-01T10:00:00.000Z', 'p1'); } catch (e) { staleReason = (e as { reason?: unknown }).reason; }
    assert(staleReason === 'stale_write', 'H3h a refused edit carries the server code as the error reason', staleReason);

    // #304: the control POA&M fields
    stub(200, { entries: [] });
    const cpList = await ApiClient.listControlPoam('t1', 'p1');
    assert(calls[0].url === '/api/v1/control-poam' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1' && Array.isArray(cpList.entries), 'CP-H1 listControlPoam reads GET /control-poam with x-tenant-id and x-program-id', calls[0].url);
    await ApiClient.listControlPoam('t1', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'CP-H1b listControlPoam with a null program sends no x-program-id');
    stub(200, { entry: { controlId: 'AC.L1-3.1.1' }, changed: true });
    const cpSaved = await ApiClient.updateControlPoam('t1', 'AC.L2-3.1.1(a)', { owner: 'IT', milestones: [{ description: 'd', targetDate: '2027-01-01' }] }, null, 'p1');
    const cpSent = JSON.parse(String(calls[0].init.body));
    assert(
      calls[0].url === '/api/v1/control-poam/AC.L2-3.1.1(a)' && calls[0].init.method === 'PATCH' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1' &&
        cpSent.owner === 'IT' && cpSent.expectedUpdatedAt === null && cpSent.milestones.length === 1 && cpSaved.changed === true && cpSaved.entry?.controlId === 'AC.L1-3.1.1',
      'CP-H2 updateControlPoam sends PATCH /control-poam/:controlId with the patch and expectedUpdatedAt (null = no entry yet), x-tenant-id and x-program-id',
      [calls[0].url, calls[0].init.method, cpSent]
    );
    await ApiClient.updateControlPoam('t1', 'AC.L1-3.1.1', { plan: 'p' }, '2026-11-01T10:00:00.000Z', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined && JSON.parse(String(calls[1].init.body)).expectedUpdatedAt === '2026-11-01T10:00:00.000Z', 'CP-H2b updateControlPoam with a null program sends no x-program-id');
    stub(200, { entry: null, changed: false });
    const cpNone = await ApiClient.updateControlPoam('t1', 'AC.L1-3.1.1', { owner: '' }, null, 'p1');
    assert(cpNone.entry === null && cpNone.changed === false, 'CP-H2c a write that stored nothing returns entry null');
    stub(409, { error: 'x', code: 'stale_write' });
    let cpStale: unknown;
    try { await ApiClient.updateControlPoam('t1', 'AC.L1-3.1.1', { owner: 'IT' }, null, 'p1'); } catch (e) { cpStale = (e as { reason?: unknown }).reason; }
    assert(cpStale === 'stale_write', 'CP-H2d a refused control edit carries the server code as the error reason', cpStale);
    stub(200, { events: [] });
    const cpEvents = await ApiClient.getControlPoamEvents('t1', 'AC.L1-3.1.1', 'p1');
    assert(calls[0].url === '/api/v1/control-poam/AC.L1-3.1.1/events' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && Array.isArray(cpEvents), 'CP-H3 getControlPoamEvents reads GET /control-poam/:controlId/events with x-program-id', calls[0].url);
    await ApiClient.getControlPoamEvents('t1', 'AC.L1-3.1.1', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'CP-H3b getControlPoamEvents with a null program sends no x-program-id');

    stub(200, { programId: 'p2', isTarget: false, eligible: true, ineligibleReason: null, currentTargetId: 'p1', currentTargetExplicit: false, openPoamInCurrent: 2, overdueWithoutItem: 3, autocreateEnabled: true });
    const prev = await ApiClient.getVmTargetProgramPreview('t1', 'p2');
    assert(calls[0].url.endsWith('/api/v1/tenants/t1/programs/p2/vm-target/preview') && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && prev.overdueWithoutItem === 3, 'H3i getVmTargetProgramPreview reads GET /programs/:id/vm-target/preview', calls[0].url);
    stub(200, { program: { id: 'p2' }, previousId: 'p1', openPoamInPrevious: 2 });
    const set = await ApiClient.setVmTargetProgram('t1', 'p2');
    assert(calls[0].url.endsWith('/api/v1/tenants/t1/programs/p2/vm-target') && calls[0].init.method === 'PUT' && set.previousId === 'p1' && set.openPoamInPrevious === 2, 'H3j setVmTargetProgram sends PUT /programs/:id/vm-target and returns previousId and openPoamInPrevious', [calls[0].url, calls[0].init.method, set]);

    stub(200, { job: { id: 'j' } });
    const file = new File(['x'], 'ssp.docx');
    await ApiClient.sspUpload('t1', file, 'CMMC_L2', 'rules', undefined, 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'Content-Type') === undefined, 'H4 sspUpload sends x-program-id and no client Content-Type');
    await ApiClient.sspUpload('t1', file, 'CMMC_L2');
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'H4b sspUpload without a program sends no x-program-id');

    stub(200, { members: [] });
    await ApiClient.listMembers('t1');
    assert(headerOf(calls[0], 'x-program-id') === undefined && headerOf(calls[0], 'x-tenant-id') === 't1', 'H5 listMembers sends no x-program-id');
    stub(200, { members: [], dormantDays: 90 });
    const withPolicy = await ApiClient.listMembersWithPolicy('t1');
    stub(200, { members: [] });
    const plainMembers = await ApiClient.listMembers('t1');
    assert(withPolicy.dormantDays === 90 && Array.isArray(withPolicy.members) && Array.isArray(plainMembers), 'H5c listMembersWithPolicy reads dormantDays; listMembers still returns an array');
    stub(200, { restored: true, userId: 'u 1' });
    const restored = await ApiClient.restoreMember('t1', 'u 1', '123456');
    assert(calls[0].url === '/api/v1/tenants/t1/members/u%201/restore' && calls[0].init.method === 'POST' && calls[0].init.body === '{"code":"123456"}' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === undefined && restored.restored === true, 'H5d restoreMember sends POST /members/:userId/restore with only the code and x-tenant-id', [calls[0].url, calls[0].init.method, calls[0].init.body]);
    stub(409, { error: 'x', reason: 'not_dormant' });
    let restoreReason: unknown;
    try { await ApiClient.restoreMember('t1', 'u1', '123456'); } catch (e) { restoreReason = (e as { reason?: unknown }).reason; }
    assert(restoreReason === 'not_dormant', 'H5e a refused restore carries the server reason', restoreReason);
    stub(200, { assets: [] });
    await ApiClient.listAssets('t1');
    assert(headerOf(calls[0], 'x-program-id') === undefined, 'H6 listAssets sends no x-program-id');

    stub(200, { programs: [{ id: 'p1', framework: 'CMMC_L1', isDefault: true }] });
    const listed = await ApiClient.listPrograms('t1');
    assert(
      calls[0].url === '/api/v1/tenants/t1/programs' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === undefined && listed.length === 1,
      'H7 listPrograms is GET /api/v1/tenants/:id/programs with no x-program-id',
      calls[0].url
    );
    await ApiClient.listPrograms('t1', { includeArchived: true });
    assert(calls[1].url === '/api/v1/tenants/t1/programs?includeArchived=true', 'H7b includeArchived is a query parameter', calls[1].url);

    stub(200, { program: { id: 'p 1', framework: 'CMMC_L2', archivedAt: '2026-10-25T00:00:00.000Z' } });
    const archived = await ApiClient.archiveProgram('t1', 'p 1');
    assert(calls[0].url === '/api/v1/tenants/t1/programs/p%201/archive' && calls[0].init.method === 'POST' && archived?.archived === true, 'H8 archiveProgram posts to the encoded id', calls[0].url);
    await ApiClient.unarchiveProgram('t1', 'p1');
    assert(calls[1].url === '/api/v1/tenants/t1/programs/p1/unarchive' && calls[1].init.method === 'POST', 'H8b unarchiveProgram posts to /unarchive');
    stub(204, null);
    await ApiClient.deleteProgram('t1', 'p1');
    assert(calls[0].url === '/api/v1/tenants/t1/programs/p1' && calls[0].init.method === 'DELETE', 'H8c deleteProgram is DELETE on the id');
    stub(200, { program: { id: 'p1', framework: 'CMMC_L2', name: 'New' } });
    await ApiClient.updateProgram('t1', 'p1', { name: 'New', boundarySummary: 'S' });
    const putBody = JSON.parse(String(calls[0].init.body)) as Record<string, string>;
    assert(calls[0].init.method === 'PUT' && putBody.name === 'New' && putBody.systemBoundarySummary === 'S' && !('framework' in putBody) && !('baseline' in putBody), 'H8d updateProgram sends only the editable fields', putBody);

    // #230: the program carries the enclave stack profile
    const fullStack = { identityProvider: 'OKTA', edrSolution: 'SENTINELONE', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'JAMF', siemSolution: 'ELASTIC', odpParams: { A_1: '1' } };
    stub(200, { program: { id: 'p1', framework: 'CMMC_L2' } });
    await ApiClient.updateProgram('t1', 'p1', { stackProfile: fullStack as never });
    const stackPut = JSON.parse(String(calls[0].init.body)) as { stackProfile?: { identityProvider?: string } };
    assert(stackPut.stackProfile?.identityProvider === 'OKTA', 'C-H1 updateProgram sends the stackProfile', stackPut);
    await ApiClient.updateProgram('t1', 'p1', { name: 'New' });
    assert(!('stackProfile' in (JSON.parse(String(calls[1].init.body)) as Record<string, unknown>)), 'C-H1b an edit without stackProfile does not send it');
    await ApiClient.updateProgram('t1', 'p1', { stackProfile: null });
    assert((JSON.parse(String(calls[2].init.body)) as Record<string, unknown>).stackProfile === null, 'C-H1c a null stackProfile is sent (clears it)');

    stub(200, { ok: true });
    await ApiClient.setMyDefaultProgram('t1', 'p1');
    assert(calls[0].url === '/api/v1/me/default-program' && calls[0].init.method === 'PUT' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === undefined && calls[0].init.body === '{"programId":"p1"}', 'H11 setMyDefaultProgram is PUT /api/v1/me/default-program with x-tenant-id, no x-program-id', calls[0]);
    await ApiClient.setMyDefaultProgram('t1', null);
    assert(calls[1].init.body === '{"programId":null}', 'H11b clearing sends programId null', calls[1].init.body);
    await ApiClient.setOrganizationDefaultProgram('t1', 'p 1');
    assert(calls[2].url === '/api/v1/tenants/t1/programs/p%201/default' && calls[2].init.method === 'PUT' && headerOf(calls[2], 'x-tenant-id') === 't1' && headerOf(calls[2], 'x-program-id') === undefined && calls[2].init.body === '{}', 'H11c setOrganizationDefaultProgram is PUT .../programs/:id/default with an empty body', calls[2]);
    let requiredHeard = 0;
    const unsubscribe = onProgramRequired(() => { requiredHeard++; });
    stub(409, { code: 'program_required', error: 'x' });
    try { await ApiClient.getControls('t1', undefined, null); } catch { /* expected */ }
    stub(409, { code: 'program_archived', error: 'x' });
    try { await ApiClient.getControls('t1', undefined, null); } catch { /* expected */ }
    unsubscribe();
    stub(409, { code: 'program_required', error: 'x' });
    try { await ApiClient.getControls('t1', undefined, null); } catch { /* expected */ }
    assert(requiredHeard === 1, 'H12 a 409 program_required (and only that) notifies the listeners, until they unsubscribe', requiredHeard);

    stub(200, { metadata: null, updatedAt: null, updatedBy: null });
    const sspGot = await ApiClient.getSspMetadata('t1', 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1' && sspGot.metadata === null, 'H10 getSspMetadata is GET /api/v1/ssp-metadata with x-program-id', calls[0].url);
    await ApiClient.getSspMetadata('t1', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'H10b a null program sends no x-program-id');
    stub(200, { metadata: { systemName: 'S' }, updatedAt: '2026-10-31T00:00:00.000Z', updatedBy: 'u', changed: true });
    const sspPut = await ApiClient.putSspMetadata('t1', { systemName: 'S' }, null, 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"metadata":{"systemName":"S"},"expectedUpdatedAt":null}' && headerOf(calls[0], 'x-program-id') === 'p1' && sspPut.changed === true, 'H10c putSspMetadata is PUT with the metadata and expectedUpdatedAt (null on a first write)', calls[0].init.body);
    stub(409, { error: 'stale', code: 'stale_write' });
    let sspStale = '';
    try { await ApiClient.putSspMetadata('t1', { systemName: 'S' }, '2026-10-31T00:00:00.000Z'); } catch (err) { sspStale = String((err as { code?: unknown }).code ?? (err as Error).message); }
    assert(sspStale !== '' && !sspStale.includes('"systemName"'), 'H10d a stale write rejects without echoing the metadata', sspStale);

    // #238, #241, #242, #246: the SSP profile and the section reviews
    stub(200, { profile: null, updatedAt: null, updatedBy: null });
    const profGot = await ApiClient.getSspProfile('t1', 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata/profile' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1' && profGot.profile === null, 'SSP-H1 getSspProfile is GET /api/v1/ssp-metadata/profile with x-program-id', calls[0].url);
    stub(200, { profile: { systemIdentifier: 'SYS-1' }, updatedAt: '2026-10-31T00:00:00.000Z', updatedBy: 'u', changed: true });
    const profPut = await ApiClient.putSspProfile('t1', { systemIdentifier: 'SYS-1' }, null, 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata/profile' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"profile":{"systemIdentifier":"SYS-1"},"expectedUpdatedAt":null}' && headerOf(calls[0], 'x-program-id') === 'p1' && profPut.changed === true, 'SSP-H2 putSspProfile is PUT with the profile and expectedUpdatedAt (null on a first write)', calls[0].init.body);
    stub(200, { sections: [], history: [] });
    const revGot = await ApiClient.getSspReviews('t1', 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata/reviews' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && Array.isArray(revGot.sections), 'SSP-H3 getSspReviews is GET /api/v1/ssp-metadata/reviews with x-program-id', calls[0].url);
    stub(201, { review: { id: 'r1' }, section: { sectionId: 'roles' }, changed: true });
    await ApiClient.postSspReview('t1', 'roles', 'a'.repeat(64), 'p1');
    assert(calls[0].url === '/api/v1/ssp-metadata/reviews' && calls[0].init.method === 'POST' && calls[0].init.body === `{"sectionId":"roles","expectedDigest":"${'a'.repeat(64)}"}` && headerOf(calls[0], 'x-program-id') === 'p1', 'SSP-H4 postSspReview is POST with exactly the section id and the expected digest', calls[0].init.body);
    stub(409, { error: 'stale', code: 'stale_write' });
    let profStale = '';
    try { await ApiClient.putSspProfile('t1', { systemIdentifier: 'SYS-MARK' }, '2026-10-31T00:00:00.000Z'); } catch (err) { profStale = String((err as { code?: unknown }).code ?? (err as Error).message); }
    assert(profStale !== '' && !profStale.includes('MARK'), 'SSP-H2b a stale profile write rejects without echoing the profile', profStale);
    stub(409, { error: 'changed', code: 'section_changed' });
    let revStale = '';
    try { await ApiClient.postSspReview('t1', 'roles', 'b'.repeat(64)); } catch (err) { revStale = String((err as { code?: unknown }).code ?? (err as Error).message); }
    assert(revStale !== '' && !revStale.includes('bbbb'), 'SSP-H4b a changed section rejects without echoing the digest', revStale);
    // #239, #243, #248, #249: the Tools and Services register is tenant-wide (no x-program-id); the boundary, control links, data inventory and vendor documents are program-scoped
    const noProgram = (c: Call) => headerOf(c, 'x-program-id') === undefined && headerOf(c, 'x-tenant-id') === 't1';
    stub(200, { tools: [{ id: 'k1', name: 'Falcon' }], limit: 1000 });
    const invTools = await ApiClient.listInventoryTools('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools' && (calls[0].init.method ?? 'GET') === 'GET' && noProgram(calls[0]) && invTools.tools.length === 1 && invTools.limit === 1000, 'INV-H1 listInventoryTools is GET /tenants/:id/inventory/tools with x-tenant-id and no x-program-id', calls[0].url);
    stub(200, { tools: [{ id: 'k1', name: 'Falcon' }] });
    const invFallback = await ApiClient.listInventoryTools('t1');
    assert(invFallback.limit === 1000 && !('annualCostCents' in invFallback.tools[0]), 'INV-H1b a missing limit reads as the register limit, and a row without the cost key keeps it absent (not available, never zero)');
    stub(201, { tool: { id: 'k2', name: 'X' } });
    const invMade = await ApiClient.createInventoryTool('t1', { name: 'X', endUsers: 4 });
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools' && calls[0].init.method === 'POST' && calls[0].init.body === '{"name":"X","endUsers":4}' && noProgram(calls[0]) && invMade.id === 'k2', 'INV-H2 createInventoryTool is POST with exactly the input', calls[0].init.body);
    stub(200, { created: [{ id: 'k3' }], skipped: [{ index: 1, reason: 'duplicate_name' }] });
    const invBatch = await ApiClient.createInventoryToolsBatch('t1', [{ name: 'A', seedKey: 'survey:edrSolution' }, { name: 'a' }]);
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools/batch' && calls[0].init.method === 'POST' && calls[0].init.body === '{"items":[{"name":"A","seedKey":"survey:edrSolution"},{"name":"a"}]}' && invBatch.created.length === 1 && invBatch.skipped[0].reason === 'duplicate_name', 'INV-H3 createInventoryToolsBatch is POST /tools/batch with the items and returns created and skipped', calls[0].init.body);
    stub(200, { tool: { id: 'k 1' }, changed: true });
    const invUpd = await ApiClient.updateInventoryTool('t1', 'k 1', { mission: 'm' }, '2026-11-01T00:00:00.000Z');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools/k%201' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"mission":"m","expectedUpdatedAt":"2026-11-01T00:00:00.000Z"}' && noProgram(calls[0]) && invUpd.changed === true, 'INV-H4 updateInventoryTool is PUT with the fields and expectedUpdatedAt', calls[0].init.body);
    stub(200, { removed: 'k1' });
    await ApiClient.deleteInventoryTool('t1', 'k1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools/k1' && calls[0].init.method === 'DELETE' && noProgram(calls[0]), 'INV-H5 deleteInventoryTool is DELETE on the id');
    stub(200, { programs: 2, controlLinks: 5, cuiLinks: 1 });
    const invUsage = await ApiClient.getInventoryToolUsage('t1', 'k1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools/k1/usage' && invUsage.programs === 2 && invUsage.controlLinks === 5 && invUsage.cuiLinks === 1, 'INV-H6 getInventoryToolUsage is GET /tools/:id/usage');
    stub(200, { order: ['b', 'a'] });
    const invOrder = await ApiClient.setToolRecoveryOrder('t1', ['b', 'a'], ['a', 'b']);
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tools/recovery-order' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"order":["b","a"],"expectedOrder":["a","b"]}' && invOrder.join() === 'b,a', 'INV-H7 setToolRecoveryOrder is PUT with the order and the order it replaces', calls[0].init.body);
    stub(200, { memberships: [{ programId: 'p1', archived: false, declared: true, toolIds: ['k1'] }] });
    const invMembers = await ApiClient.listToolMemberships('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/tool-memberships' && noProgram(calls[0]) && invMembers[0].toolIds[0] === 'k1', 'INV-H8 listToolMemberships is GET /tool-memberships with no x-program-id');
    stub(200, { vendors: [{ id: 'v1' }], limit: 500 });
    const invVendors = await ApiClient.listInventoryVendors('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/vendors' && noProgram(calls[0]) && invVendors.vendors.length === 1 && invVendors.limit === 500, 'INV-H9 listInventoryVendors is GET /vendors');
    stub(201, { vendor: { id: 'v2' } });
    await ApiClient.createInventoryVendor('t1', { name: 'V', kind: 'CSP' });
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/vendors' && calls[0].init.method === 'POST' && calls[0].init.body === '{"name":"V","kind":"CSP"}', 'INV-H10 createInventoryVendor is POST with exactly the input', calls[0].init.body);
    stub(200, { vendor: { id: 'v2' }, changed: false });
    await ApiClient.updateInventoryVendor('t1', 'v2', { notes: 'n' }, '2026-11-01T00:00:00.000Z');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/vendors/v2' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"notes":"n","expectedUpdatedAt":"2026-11-01T00:00:00.000Z"}', 'INV-H11 updateInventoryVendor is PUT with the fields and expectedUpdatedAt', calls[0].init.body);
    stub(200, { removed: 'v2' });
    await ApiClient.deleteInventoryVendor('t1', 'v2');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/vendors/v2' && calls[0].init.method === 'DELETE', 'INV-H12 deleteInventoryVendor is DELETE on the id');
    stub(200, { events: [] });
    await ApiClient.listInventoryEvents('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/inventory/events' && calls[0].init.method === 'GET' && noProgram(calls[0]), 'INV-H13 listInventoryEvents is GET /events with no query unless given', calls[0].url);
    await ApiClient.listInventoryEvents('t1', { entityId: 'k1', limit: 20 });
    assert(calls[1].url === '/api/v1/tenants/t1/inventory/events?entityId=k1&limit=20', 'INV-H13b the entity and limit are query parameters', calls[1].url);
    stub(409, { error: 'This entry was changed by someone else after you loaded it.', code: 'stale_write', current: { updatedAt: 'x', updatedBy: 'SECRET-MARK' } });
    let invStale: { message: string; reason?: string; status: number } | null = null;
    try { await ApiClient.updateInventoryTool('t1', 'k1', { name: 'SECRET-MARK' }, '2026-11-01T00:00:00.000Z'); } catch (err) { invStale = err as { message: string; reason?: string; status: number }; }
    assert(invStale !== null && invStale.status === 409 && invStale.reason === 'stale_write' && !JSON.stringify({ m: invStale.message, r: invStale.reason, i: (invStale as { inUse?: unknown }).inUse }).includes('MARK'), 'INV-H14 a stale tool write rejects with the reason and without echoing the request or the other writer');

    stub(200, { programId: 'p1', declared: false, toolIds: [], controlLinks: [], vendorDocuments: [] });
    const pinv = await ApiClient.getProgramInventory('t1', 'p1');
    assert(calls[0].url === '/api/v1/program-inventory' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === 'p1' && pinv.declared === false, 'PINV-H1 getProgramInventory is GET /program-inventory with x-program-id', calls[0].url);
    await ApiClient.getProgramInventory('t1', null);
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'PINV-H1b a null program sends no x-program-id');
    stub(200, { programId: 'p1', declared: true, toolIds: ['k1'], added: 1, removed: 0, linksRemoved: 0, cuiLinksRemoved: 0 });
    const patched = await ApiClient.patchProgramTools('t1', { add: ['k1'], force: true }, 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/tools' && calls[0].init.method === 'PATCH' && calls[0].init.body === '{"add":["k1"],"force":true}' && headerOf(calls[0], 'x-program-id') === 'p1' && patched.added === 1 && patched.toolIds.join() === 'k1', 'PINV-H2 patchProgramTools is PATCH /program-inventory/tools with exactly the change and x-program-id', calls[0].init.body);
    stub(409, { error: 'The tool still has links.', code: 'tool_in_use', controlLinks: 2, cuiLinks: 1 });
    let inUseErr: { message: string; reason?: string; inUse?: { controlLinks: number; cuiLinks: number } } | null = null;
    try { await ApiClient.patchProgramTools('t1', { remove: ['SECRET-MARK'] }, 'p1'); } catch (err) { inUseErr = err as typeof inUseErr; }
    assert(inUseErr !== null && inUseErr.reason === 'tool_in_use' && JSON.stringify(inUseErr.inUse) === '{"controlLinks":2,"cuiLinks":1}' && !inUseErr.message.includes('MARK'), 'PINV-H2b a 409 tool_in_use carries the counts (numbers only) and does not echo the request', inUseErr);
    stub(200, { toolId: 'k1', controls: [{ controlId: 'AC.L2-3.1.1', evidenceSource: true }], changed: true });
    const putLinks = await ApiClient.putToolControls('t1', 'k1', [{ controlId: 'AC.L2-3.1.1', evidenceSource: true }], [], 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/tools/k1/controls' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"controls":[{"controlId":"AC.L2-3.1.1","evidenceSource":true}],"expectedControlIds":[]}' && headerOf(calls[0], 'x-program-id') === 'p1' && putLinks.changed === true && putLinks.controls.length === 1, 'PINV-H3 putToolControls is PUT with the links and the set it replaces', calls[0].init.body);
    stub(409, { error: 'The links were changed.', code: 'stale_write', currentControlIds: ['SECRET-MARK'] });
    let linkStale: { message: string; reason?: string } | null = null;
    try { await ApiClient.putToolControls('t1', 'k1', [], ['AC.L2-3.1.1']); } catch (err) { linkStale = err as typeof linkStale; }
    assert(linkStale !== null && linkStale.reason === 'stale_write' && !JSON.stringify(linkStale).includes('MARK'), 'PINV-H3b a stale link write rejects without echoing the other writer', linkStale);
    stub(200, { handlesFci: null, categories: [], updatedAt: null, updatedBy: null });
    const dataGot = await ApiClient.getDataInventory('t1', 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/data-inventory' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && dataGot.handlesFci === null && dataGot.updatedAt === null, 'PINV-H4 getDataInventory is GET /program-inventory/data-inventory with x-program-id', calls[0].url);
    stub(200, { handlesFci: true, categories: [], updatedAt: '2026-11-19T00:00:00.000Z', updatedBy: 'u', changed: true });
    const dataPut = await ApiClient.putDataInventory('t1', { handlesFci: true, categories: [{ categoryId: 'CTI', tools: [{ toolId: 'k1', stores: true, processes: false, transmits: false }] }] }, null, 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/data-inventory' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"handlesFci":true,"categories":[{"categoryId":"CTI","tools":[{"toolId":"k1","stores":true,"processes":false,"transmits":false}]}],"expectedUpdatedAt":null}' && headerOf(calls[0], 'x-program-id') === 'p1' && dataPut.changed === true && dataPut.updatedAt === '2026-11-19T00:00:00.000Z', 'PINV-H5 putDataInventory is PUT with the whole record and expectedUpdatedAt (null on a first write)', calls[0].init.body);
    stub(409, { error: 'The data inventory was saved by someone else after you loaded it.', code: 'stale_write', current: { updatedAt: 'x', updatedBy: 'SECRET-MARK' } });
    let dataStale: { message: string; reason?: string } | null = null;
    try { await ApiClient.putDataInventory('t1', { handlesFci: false, categories: [{ categoryId: 'NOPE-MARK', tools: [] }] }, '2026-11-19T00:00:00.000Z'); } catch (err) { dataStale = err as typeof dataStale; }
    assert(dataStale !== null && dataStale.reason === 'stale_write' && !JSON.stringify(dataStale).includes('MARK'), 'PINV-H5b a stale data inventory write rejects without echoing the record or the other writer', dataStale);
    stub(201, { document: { vendorId: 'v1', evidenceId: 'ev_1', docKind: 'CRM', linkedAt: 'x', linkedBy: null }, changed: true });
    const docLinked = await ApiClient.linkVendorDocument('t1', { vendorId: 'v1', evidenceId: 'ev_1', docKind: 'CRM' }, 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/vendor-documents' && calls[0].init.method === 'POST' && calls[0].init.body === '{"vendorId":"v1","evidenceId":"ev_1","docKind":"CRM"}' && headerOf(calls[0], 'x-program-id') === 'p1' && docLinked.changed === true && docLinked.document.docKind === 'CRM', 'PINV-H6 linkVendorDocument is POST with exactly the link and x-program-id', calls[0].init.body);
    stub(200, { removed: 'ev_1', vendorId: 'v1' });
    await ApiClient.unlinkVendorDocument('t1', 'v1', 'ev_1', 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/vendor-documents/v1/ev_1' && calls[0].init.method === 'DELETE' && headerOf(calls[0], 'x-program-id') === 'p1', 'PINV-H7 unlinkVendorDocument is DELETE /vendor-documents/:vendorId/:evidenceId with x-program-id', calls[0].url);
    stub(200, { events: [{ id: 'e1', action: 'controls_changed' }] });
    const pevents = await ApiClient.getProgramInventoryEvents('t1', 20, 'p1');
    assert(calls[0].url === '/api/v1/program-inventory/events?limit=20' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && pevents.length === 1, 'PINV-H8 getProgramInventoryEvents is GET /program-inventory/events with the limit and x-program-id', calls[0].url);
    await ApiClient.getProgramInventoryEvents('t1');
    assert(calls[1].url === '/api/v1/program-inventory/events' && headerOf(calls[1], 'x-program-id') === undefined, 'PINV-H8b no limit and no program: no query and no x-program-id');
    // Document register (#240): tenant-wide calls take no program; the program-documents calls are scoped
    stub(200, { documents: [], limit: 2000 });
    const docList = await ApiClient.listDocuments('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/documents' && (calls[0].init.method ?? 'GET') === 'GET' && headerOf(calls[0], 'x-program-id') === undefined && docList.limit === 2000, 'DOC-H1 listDocuments is GET /tenants/:id/documents with no x-program-id', calls[0].url);
    stub(201, { document: { id: 'd1', status: 'DRAFT' } });
    await ApiClient.createDocument('t1', { kind: 'POLICY', title: 'Access Control Policy', origin: 'GENERATED', seedKey: 'generated:CMMC_L2:AC' });
    assert(calls[0].url === '/api/v1/tenants/t1/documents' && calls[0].init.method === 'POST' && calls[0].init.body === '{"kind":"POLICY","title":"Access Control Policy","origin":"GENERATED","seedKey":"generated:CMMC_L2:AC"}', 'DOC-H2 createDocument is POST with exactly the input', calls[0].init.body);
    stub(200, { document: { id: 'd1' }, changed: true, approvalCleared: true });
    const docUpd = await ApiClient.updateDocument('t1', 'd1', { version: '1.1' }, '2026-11-20T00:00:00.000Z');
    assert(calls[0].url === '/api/v1/tenants/t1/documents/d1' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"version":"1.1","expectedUpdatedAt":"2026-11-20T00:00:00.000Z"}' && docUpd.approvalCleared === true, 'DOC-H3 updateDocument is PUT with the fields and the stamp, and reports a cleared approval', calls[0].init.body);
    stub(200, { document: { id: 'd1', status: 'APPROVED' } });
    await ApiClient.approveDocument('t1', 'd1', { version: '1.0', approvalDate: '2026-11-20', reviewBy: null, confirmReviewed: true }, 'stamp');
    assert(calls[0].url === '/api/v1/tenants/t1/documents/d1/approve' && calls[0].init.method === 'POST' && calls[0].init.body === '{"version":"1.0","approvalDate":"2026-11-20","reviewBy":null,"confirmReviewed":true,"expectedUpdatedAt":"stamp"}', 'DOC-H4 approveDocument is POST /approve with the approval and the stamp (no approver)', calls[0].init.body);
    stub(200, { document: { id: 'd1' }, changed: true });
    await ApiClient.setDocumentStatus('t1', 'd1', 'RETIRED', 'stamp');
    assert(calls[0].url === '/api/v1/tenants/t1/documents/d1/status' && calls[0].init.body === '{"status":"RETIRED","expectedUpdatedAt":"stamp"}', 'DOC-H5 setDocumentStatus is POST /status', calls[0].init.body);
    stub(200, { programs: 1, controlLinks: 2, attachments: 3, expectations: 4 });
    const docUse = await ApiClient.getDocumentUsage('t1', 'd1');
    assert(calls[0].url === '/api/v1/tenants/t1/documents/d1/usage' && docUse.attachments === 3 && docUse.expectations === 4, 'DOC-H6 getDocumentUsage is GET /usage with the four counts', calls[0].url);
    stub(200, { removed: 'd1' });
    await ApiClient.deleteDocument('t1', 'd1');
    assert(calls[0].url === '/api/v1/tenants/t1/documents/d1' && calls[0].init.method === 'DELETE' && headerOf(calls[0], 'x-program-id') === undefined, 'DOC-H7 deleteDocument is DELETE with no x-program-id', calls[0].url);
    stub(200, { programId: 'p1', declared: false, documentIds: [], controlLinks: [], attachments: [], expectations: [] });
    const progDocs = await ApiClient.getProgramDocuments('t1', 'p1');
    assert(calls[0].url === '/api/v1/program-documents' && headerOf(calls[0], 'x-program-id') === 'p1' && progDocs.declared === false && progDocs.attachments.length === 0, 'DOC-H8 getProgramDocuments is GET /program-documents with x-program-id', calls[0].url);
    stub(200, { documentId: 'd1', controlIds: ['AC.L2-3.1.1'], changed: true });
    const docCtl = await ApiClient.putDocumentControls('t1', 'd1', ['AC.L2-3.1.1'], [], 'p1');
    assert(calls[0].url === '/api/v1/program-documents/documents/d1/controls' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"controlIds":["AC.L2-3.1.1"],"expectedControlIds":[]}' && headerOf(calls[0], 'x-program-id') === 'p1' && docCtl.changed === true, 'DOC-H9 putDocumentControls is PUT with the ids and the set it replaces and x-program-id', calls[0].init.body);
    stub(409, { error: 'The links were changed.', code: 'stale_write', currentControlIds: ['SECRET-MARK'] });
    let docStale: { message: string; reason?: string } | null = null;
    try { await ApiClient.putDocumentControls('t1', 'd1', [], ['AC.L2-3.1.1']); } catch (err) { docStale = err as typeof docStale; }
    assert(docStale !== null && docStale.reason === 'stale_write' && !JSON.stringify(docStale).includes('MARK'), 'DOC-H9b a stale document link write rejects without echoing the other writer', docStale);
    stub(201, { attachment: { documentId: 'd1', evidenceId: 'ev_1', isPrimary: true, linkedAt: 'x', linkedBy: null }, changed: true });
    const docAtt = await ApiClient.linkDocumentAttachment('t1', 'd1', { evidenceId: 'ev_1', primary: true }, 'p1');
    assert(calls[0].url === '/api/v1/program-documents/documents/d1/attachments' && calls[0].init.method === 'POST' && calls[0].init.body === '{"evidenceId":"ev_1","primary":true}' && headerOf(calls[0], 'x-program-id') === 'p1' && docAtt.changed === true && docAtt.attachment?.isPrimary === true, 'DOC-H10 linkDocumentAttachment is POST with the evidence id and primary flag and x-program-id', calls[0].init.body);
    stub(409, { error: 'x', code: 'document_in_use', controlLinks: 2, attachments: 1, expectations: 3 });
    let docInUse: { message: string; reason?: string; inUse?: unknown } | null = null;
    try { await ApiClient.patchProgramDocuments('t1', { remove: ['SECRET-MARK'] }, 'p1'); } catch (err) { docInUse = err as typeof docInUse; }
    assert(docInUse !== null && docInUse.reason === 'document_in_use' && JSON.stringify(docInUse.inUse) === '{"controlLinks":2,"attachments":1,"expectations":3}' && !docInUse.message.includes('MARK'), 'DOC-H11 a 409 document_in_use carries the three counts (numbers only) and does not echo the request', docInUse);
    stub(409, { error: 'x', code: 'duplicate_seed', documentId: 'd7' });
    let docSeed: { reason?: string; documentId?: string } | null = null;
    try { await ApiClient.createDocument('t1', { kind: 'POLICY', title: 'T', origin: 'GENERATED', seedKey: 'generated:CMMC_L2:AC' }); } catch (err) { docSeed = err as typeof docSeed; }
    assert(docSeed !== null && docSeed.reason === 'duplicate_seed' && docSeed.documentId === 'd7', 'DOC-H12 a 409 duplicate_seed carries the existing document id', docSeed);
    stub(400, { error: 'x', code: 'invalid', field: 'title' });
    let docField: { reason?: string; field?: string } | null = null;
    try { await ApiClient.createDocument('t1', { title: 'SECRET-MARK' }); } catch (err) { docField = err as typeof docField; }
    assert(docField !== null && docField.reason === 'invalid' && docField.field === 'title' && !JSON.stringify(docField).includes('MARK'), 'DOC-H13 a 400 invalid carries the field name only', docField);
    stub(200, { expectedId: 'cmmc-l2-system-security-plan', documentIds: ['d1'], changed: true });
    await ApiClient.putDocumentExpectation('t1', 'cmmc-l2-system-security-plan', ['d1'], [], 'p1');
    assert(calls[0].url === '/api/v1/program-documents/expectations/cmmc-l2-system-security-plan' && calls[0].init.method === 'PUT' && calls[0].init.body === '{"documentIds":["d1"],"expectedDocumentIds":[]}' && headerOf(calls[0], 'x-program-id') === 'p1', 'DOC-H14 putDocumentExpectation is PUT with the ids and the set it replaces and x-program-id', calls[0].init.body);
    stub(200, { attachments: [] });
    await ApiClient.setDocumentAttachmentPrimary('t1', 'd1', 'ev_1', false, 'p1');
    assert(calls[0].url === '/api/v1/program-documents/documents/d1/attachments/ev_1' && calls[0].init.method === 'PATCH' && calls[0].init.body === '{"primary":false}' && headerOf(calls[0], 'x-program-id') === 'p1', 'DOC-H15 setDocumentAttachmentPrimary is PATCH with the flag and x-program-id', calls[0].init.body);
    stub(200, { removed: 'ev_1', documentId: 'd1' });
    await ApiClient.unlinkDocumentAttachment('t1', 'd1', 'ev_1', 'p1');
    assert(calls[0].url === '/api/v1/program-documents/documents/d1/attachments/ev_1' && calls[0].init.method === 'DELETE' && headerOf(calls[0], 'x-program-id') === 'p1', 'DOC-H16 unlinkDocumentAttachment is DELETE with x-program-id', calls[0].url);
    stub(200, { programId: 'p1', declared: true, documentIds: ['d1'], added: 1, removed: 0 });
    const docPatch = await ApiClient.patchProgramDocuments('t1', { add: ['d1'] }, 'p1');
    assert(calls[0].url === '/api/v1/program-documents/documents' && calls[0].init.method === 'PATCH' && calls[0].init.body === '{"add":["d1"]}' && docPatch.declared === true && docPatch.added === 1, 'DOC-H17 patchProgramDocuments is PATCH with the change', calls[0].init.body);

    stub(201, { program: { id: 'p9', framework: 'NIST_800_53_REV5', baseline: 'HIGH', name: 'N' } });
    const created = await ApiClient.createProgram('t1', { name: 'N', framework: 'NIST_800_53_REV5', baseline: 'HIGH', seed: 'clone', sourceProgramId: 'p1' });
    const postBody = JSON.parse(String(calls[0].init.body)) as { seed?: { cloneFrom?: string }; frameworkId?: string };
    assert(calls[0].init.method === 'POST' && postBody.frameworkId === 'NIST_800_53_REV5' && postBody.seed?.cloneFrom === 'p1' && created.id === 'p9', 'H8e createProgram posts the server body and parses the program', postBody);

    stub(200, { documented: 112, total: 287, evidence: 5, openPoam: 3 });
    const metrics = await ApiClient.getProgramMetrics('t1', 'p1');
    assert(calls[0].url === '/api/v1/tenants/t1/programs/p1/metrics' && metrics.evidenceCount === 5 && metrics.documented === 112, 'H9 getProgramMetrics reads the metrics endpoint');

    // Boundary asset membership (#26): named in the URL, so never an x-program-id
    stub(200, { programId: 'p1', declared: true, assetIds: ['a1'], added: 1, removed: 0 });
    const updated = await ApiClient.updateProgramAssets('t1', 'p1', { add: ['a1'] });
    assert(
      calls[0].url === '/api/v1/tenants/t1/programs/p1/assets' && calls[0].init.method === 'PATCH' && calls[0].init.body === '{"add":["a1"]}'
        && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'x-program-id') === undefined && updated.assetIds.join() === 'a1',
      'PA-C1 updateProgramAssets is a PATCH on /programs/:id/assets with the delta body, x-tenant-id and no x-program-id',
      { url: calls[0].url, body: calls[0].init.body }
    );
    stub(200, { programId: 'p1', declared: true, assetIds: ['a1', 5, null] });
    const got = await ApiClient.getProgramAssets('t1', 'p1');
    assert(
      calls[0].url === '/api/v1/tenants/t1/programs/p1/assets' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === undefined
        && got.assetIds.join() === 'a1' && got.declared === true && got.summary.total === 0,
      'PA-C2 getProgramAssets is a GET on the same URL and keeps only string ids',
      got
    );
    stub(200, { memberships: [{ programId: 'p1', archived: false, assetIds: ['a1'] }] });
    const mem = await ApiClient.listProgramAssetMemberships('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/programs/asset-memberships' && headerOf(calls[0], 'x-program-id') === undefined && mem.p1?.join() === 'a1', 'PA-C2b listProgramAssetMemberships reads asset-memberships', calls[0].url);

    stub(200, {});
    await ApiClient.uploadEvidenceFile('/api/v1/evidence/x', new Blob(['x']), 'text/plain', 't1', 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1', 'H10 uploadEvidenceFile sends x-program-id');

    stub(200, { evidence: [] });
    await ApiClient.getEvidence('t1', 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1', 'H11 getEvidence sends x-program-id');
    stub(200, { control: {} });
    await ApiClient.updateControl('t1', 'c1', { implementationNotes: 'n' }, 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1', 'H12 updateControl sends x-program-id');
    stub(200, {});
    await ApiClient.requestUploadUrl('t1', { controlId: 'c', fileName: 'f', fileSize: 1, mimeType: 'text/plain', fileHash: 'h' }, 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1', 'H13 requestUploadUrl sends x-program-id');

    stub(200, { job: { id: 'j' }, staged: [], staged1: {} });
    await ApiClient.sspCapabilities('t1', 'p1');
    await ApiClient.sspGetStaged('t1', 'j', 'p1');
    await ApiClient.sspGetJob('t1', 'j', 'p1');
    await ApiClient.sspReview('t1', 'j', 's', { reviewState: 'ACCEPTED' } as never, 'p1');
    await ApiClient.sspCommit('t1', 'j', 'p1');
    await ApiClient.sspCancel('t1', 'j', 'p1');
    await ApiClient.sspDelete('t1', 'j', 'p1');
    assert(calls.length === 7 && calls.every((c) => headerOf(c, 'x-program-id') === 'p1'), 'H14 every other ssp call sends x-program-id', calls.map((c) => c.url));
    const urlSpy = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:x';
    try {
      stub(200, {});
      await ApiClient.sspDownloadUrl('t1', 'j', 'p1');
      assert(headerOf(calls[0], 'x-program-id') === 'p1', 'H15 sspDownloadUrl sends x-program-id');
    } finally {
      URL.createObjectURL = urlSpy;
    }

    stub(200, { deleted: true, evidenceId: 'ev 1', removedIds: ['ev 1', 7, 'ev 1__inh_AC-2'], fileRemoved: true });
    const del = await ApiClient.deleteEvidence('t1', 'ev 1', 'p1');
    assert(
      calls[0].url === '/api/v1/evidence/ev%201' && calls[0].init.method === 'DELETE' && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1'
        && del.removedIds.length === 2 && del.removedIds[0] === 'ev 1' && del.fileRemoved === true,
      'H16 deleteEvidence is DELETE on the encoded id with both headers and returns the string removedIds',
      { url: calls[0].url, del }
    );
    stub(200, { deleted: true });
    const delBare = await ApiClient.deleteEvidence('t1', 'ev 1');
    assert(delBare.removedIds.length === 1 && delBare.removedIds[0] === 'ev 1' && delBare.fileRemoved === false && headerOf(calls[0], 'x-program-id') === undefined, 'H16a deleteEvidence defaults removedIds to the id and fileRemoved to false');
    stub(409, { error: 'This program is archived', reason: 'program_archived' });
    let delErr: { status?: number; message?: string } | null = null;
    try {
      await ApiClient.deleteEvidence('t1', 'ev1', 'p1');
    } catch (e) {
      delErr = e as { status?: number; message?: string };
    }
    assert(delErr?.status === 409 && delErr.message === 'This program is archived', 'H16b a 409 rejects with its status and the server message', delErr);
    // B2: the programs routes send { error, code }; the ApiError carries the code as its reason
    stub(400, { error: 'Unknown scoping key', code: 'invalid_scoping' });
    let scopeErr: { status?: number; reason?: string } | null = null;
    try {
      await ApiClient.updateProgram('t1', 'p1', { scoping: { noWireless: true } });
    } catch (e) {
      scopeErr = e as { status?: number; reason?: string };
    }
    assert(scopeErr?.status === 400 && scopeErr.reason === 'invalid_scoping', 'B2 an { error, code } 400 body gives an ApiError whose reason is the code', scopeErr);
    stub(200, { program: { id: 'p1', framework: 'NIST_800_53_REV5', baseline: 'MODERATE', name: 'N', scoping: { noWireless: true } } });
    await ApiClient.updateProgram('t1', 'p1', { scoping: { noWireless: true } });
    const scopeBody = JSON.parse(String(calls[0].init.body)) as { scoping?: Record<string, boolean>; name?: string };
    assert(calls[0].init.method === 'PUT' && scopeBody.scoping?.noWireless === true && !('name' in scopeBody), 'P5s updateProgram sends the scoping object', scopeBody);
    stub(200, { program: { id: 'p1', framework: 'NIST_800_53_REV5', baseline: 'MODERATE', name: 'N', scoping: { noMobileDevices: true } } });
    await ApiClient.updateProgram('t1', 'p1', { scoping: { noMobileDevices: true }, expectedScoping: { noWireless: true } });
    const expBody = JSON.parse(String(calls[0].init.body)) as { scoping?: Record<string, boolean>; expectedScoping?: Record<string, boolean> };
    assert(JSON.stringify(expBody.expectedScoping) === '{"noWireless":true}' && JSON.stringify(expBody.scoping) === '{"noMobileDevices":true}', 'P5s2 updateProgram sends expectedScoping exactly as given', expBody);
    stub(409, { error: 'The overlays of this program changed meanwhile', code: 'scoping_conflict' });
    let conflictErr: { status?: number; reason?: string } | null = null;
    try {
      await ApiClient.updateProgram('t1', 'p1', { scoping: { noMobileDevices: true }, expectedScoping: { noWireless: true } });
    } catch (e) {
      conflictErr = e as { status?: number; reason?: string };
    }
    assert(conflictErr?.status === 409 && conflictErr.reason === 'scoping_conflict' && isOverlayConflict(conflictErr), 'P5s3 a 409 scoping_conflict rejects with that reason, and isOverlayConflict recognises it', conflictErr);

    {
    // ---- experience (#251 to #254): program summary, SPRS goal, assignments, teams, responsibilities, global search
    const summaryBody = { programId: 'p1', generatedAt: '2026-11-20T00:00:00.000Z', people: { ownerLevelMembers: 1, primaryContactSet: true }, inventory: { supported: true }, documents: null, reviews: { reviewed: 0, total: 3 }, poam: { openCount: 0 } };
    stub(200, summaryBody);
    const sum = await ApiClient.getProgramSummary('t1', 'p1');
    assert(
      calls[0].url === '/api/v1/program-summary' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1' && sum.programId === 'p1' && sum.reviews.total === 3,
      'X1 getProgramSummary is GET /program-summary with both headers and returns the summary', { url: calls[0].url }
    );
    stub(200, summaryBody);
    await ApiClient.getProgramSummary('t1', null);
    assert(headerOf(calls[0], 'x-program-id') === undefined, 'X1a getProgramSummary without a program sends no x-program-id');
    stub(200, { nope: true });
    let sumBad: { status?: number } | null = null;
    try { await ApiClient.getProgramSummary('t1', 'p1'); } catch (e) { sumBad = e as { status?: number }; }
    assert(sumBad?.status === 502, 'X1b a summary without its parts is refused with 502', sumBad);

    stub(200, { program: { id: 'p1', framework: 'CMMC_L2', baseline: null, name: 'N', sprsGoal: 88 } });
    const goalSet = await ApiClient.updateProgram('t1', 'p1', { sprsGoal: 88 });
    const goalBody = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert(calls[0].init.method === 'PUT' && JSON.stringify(goalBody) === '{"sprsGoal":88}' && goalSet.sprsGoal === 88, 'X2 updateProgram sends exactly { sprsGoal } and the parsed program carries it', { goalBody, goal: goalSet.sprsGoal });
    stub(200, { program: { id: 'p1', framework: 'CMMC_L2', baseline: null, name: 'N', sprsGoal: null } });
    const goalCleared = await ApiClient.updateProgram('t1', 'p1', { sprsGoal: null });
    assert(JSON.stringify(JSON.parse(String(calls[0].init.body))) === '{"sprsGoal":null}' && goalCleared.sprsGoal === null, 'X2a a null goal is sent as null and parsed as null');
    stub(200, { program: { id: 'p1', framework: 'CMMC_L2', baseline: null, name: 'N', sprsGoal: 999 } });
    const goalWild = await ApiClient.updateProgram('t1', 'p1', { name: 'N' });
    assert(!('sprsGoal' in goalWild) && !('sprsGoal' in JSON.parse(String(calls[0].init.body))), 'X2b an out-of-range goal from the server is dropped, and an update without a goal sends none');
    stub(400, { error: 'The SPRS goal must be a whole number from -203 to 110', code: 'invalid_sprs_goal' });
    let goalErr: { status?: number; reason?: string } | null = null;
    try { await ApiClient.updateProgram('t1', 'p1', { sprsGoal: 5 }); } catch (e) { goalErr = e as { status?: number; reason?: string }; }
    assert(goalErr?.status === 400 && goalErr.reason === 'invalid_sprs_goal', 'X2c a 400 invalid_sprs_goal rejects with that reason', goalErr);

    stub(200, { assignments: [{ targetKind: 'control', targetId: 'AC.L1-3.1.1', duty: 'owner' }], limit: 25000 });
    const asg = await ApiClient.listAssignments('t1', 'p1');
    assert(calls[0].url === '/api/v1/assignments' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && asg.length === 1, 'X3 listAssignments is GET /assignments with the program header');
    const batch = [{ targetKind: 'control' as const, targetId: 'AC.L1-3.1.1', duty: 'owner' as const, assignee: { kind: 'user' as const, id: 'u1' }, expectedAssignee: null }];
    stub(200, { assignments: [], changed: 1 });
    const put = await ApiClient.putAssignments('t1', batch, 'p1');
    assert(
      calls[0].url === '/api/v1/assignments' && calls[0].init.method === 'PUT' && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'Content-Type') === 'application/json'
        && JSON.stringify(JSON.parse(String(calls[0].init.body))) === JSON.stringify({ items: batch }) && put.changed === 1,
      'X4 putAssignments is PUT /assignments with exactly { items } and returns the count', { url: calls[0].url }
    );
    stub(409, { error: 'changed', code: 'stale_write', index: 2, current: { kind: 'user', id: 'u9' } });
    let staleAsg: { status?: number; reason?: string; index?: number } | null = null;
    try { await ApiClient.putAssignments('t1', batch, 'p1'); } catch (e) { staleAsg = e as { status?: number; reason?: string; index?: number }; }
    assert(staleAsg?.status === 409 && staleAsg.reason === 'stale_write' && staleAsg.index === 2, 'X4a a 409 stale_write carries its reason and the index of the item', staleAsg);
    stub(400, { error: 'x', code: 'assignee_not_member', index: -3 });
    let badIdx: { index?: number } | null = null;
    try { await ApiClient.putAssignments('t1', batch, 'p1'); } catch (e) { badIdx = e as { index?: number }; }
    assert(badIdx !== null && badIdx.index === undefined, 'X4b a negative index is not kept');
    stub(200, { items: [{ targetKind: 'ssp_section', targetId: 'roles', duty: 'reviewer' }] });
    const mine = await ApiClient.listMyAssignments('t1', 'p1');
    assert(calls[0].url === '/api/v1/assignments/mine' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === 'p1' && mine.length === 1, 'X5 listMyAssignments is GET /assignments/mine');

    const team = { id: 'tm1', name: 'Blue', description: '', memberIds: [], createdAt: 'a', updatedAt: 'b', updatedBy: null };
    stub(200, { teams: [team], limit: 100 });
    const tl = await ApiClient.listTeams('t 1');
    assert(calls[0].url === '/api/v1/tenants/t%201/teams' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-tenant-id') === 't 1' && headerOf(calls[0], 'x-program-id') === undefined && tl.length === 1, 'X6 listTeams is GET on the encoded tenant path, tenant header, no program header');
    stub(201, { team });
    const created = await ApiClient.createTeam('t1', { name: 'Blue', description: 'd' });
    assert(calls[0].url === '/api/v1/tenants/t1/teams' && calls[0].init.method === 'POST' && JSON.stringify(JSON.parse(String(calls[0].init.body))) === '{"name":"Blue","description":"d"}' && created.id === 'tm1', 'X7 createTeam is POST with exactly { name, description }');
    stub(409, { error: 'A team with that name exists', code: 'duplicate_name' });
    let dup: { status?: number; reason?: string } | null = null;
    try { await ApiClient.createTeam('t1', { name: 'Blue' }); } catch (e) { dup = e as { status?: number; reason?: string }; }
    assert(dup?.status === 409 && dup.reason === 'duplicate_name', 'X7a a 409 duplicate_name rejects with that reason', dup);
    stub(200, { team, changed: true });
    const upd = await ApiClient.updateTeam('t1', 'tm/1', { name: 'Red', expectedUpdatedAt: 'b' });
    assert(calls[0].url === '/api/v1/tenants/t1/teams/tm%2F1' && calls[0].init.method === 'PUT' && JSON.stringify(JSON.parse(String(calls[0].init.body))) === '{"name":"Red","expectedUpdatedAt":"b"}' && upd.changed === true, 'X8 updateTeam is PUT on the encoded team id with exactly the changes and the stamp');
    stub(200, { team, added: 1, removed: 0 });
    const mem = await ApiClient.patchTeamMembers('t1', 'tm1', { add: ['u1'] });
    assert(calls[0].url === '/api/v1/tenants/t1/teams/tm1/members' && calls[0].init.method === 'PATCH' && JSON.stringify(JSON.parse(String(calls[0].init.body))) === '{"add":["u1"]}' && mem.added === 1, 'X9 patchTeamMembers is PATCH .../members with exactly { add }');
    stub(200, { programs: [{ programId: 'p1', assignments: 2 }] });
    const use = await ApiClient.getTeamUsage('t1', 'tm1');
    assert(calls[0].url === '/api/v1/tenants/t1/teams/tm1/usage' && calls[0].init.method === 'GET' && use[0].assignments === 2, 'X10 getTeamUsage is GET .../usage');
    stub(200, { removed: 'tm1', assignmentsRemoved: 3 });
    const gone = await ApiClient.deleteTeam('t1', 'tm1', true);
    assert(calls[0].url === '/api/v1/tenants/t1/teams/tm1?force=true' && calls[0].init.method === 'DELETE' && gone.assignmentsRemoved === 3, 'X11 deleteTeam with force is DELETE ?force=true');
    stub(200, { removed: 'tm1', assignmentsRemoved: 0 });
    await ApiClient.deleteTeam('t1', 'tm1');
    assert(calls[0].url === '/api/v1/tenants/t1/teams/tm1', 'X11a deleteTeam without force has no query');
    stub(409, { error: 'The team still has assignments', code: 'team_in_use', assignments: 4, programs: 2 });
    let inUse: { status?: number; reason?: string; teamUse?: { assignments: number; programs: number } } | null = null;
    try { await ApiClient.deleteTeam('t1', 'tm1'); } catch (e) { inUse = e as typeof inUse; }
    assert(inUse?.status === 409 && inUse.reason === 'team_in_use' && inUse.teamUse?.assignments === 4 && inUse.teamUse.programs === 2, 'X11b a 409 team_in_use carries the two counts', inUse);

    stub(200, { programs: [], truncated: false });
    await ApiClient.getResponsibilities('t1');
    assert(calls[0].url === '/api/v1/tenants/t1/responsibilities?view=me' && calls[0].init.method === 'GET' && headerOf(calls[0], 'x-program-id') === undefined, 'X12 getResponsibilities defaults to view=me, tenant-wide');
    stub(200, { programs: [], truncated: false });
    await ApiClient.getResponsibilities('t1', { view: 'team', teamId: 'tm 1', includeArchived: true });
    assert(calls[0].url === '/api/v1/tenants/t1/responsibilities?view=team&teamId=tm%201&includeArchived=true', 'X12a the team view sends the encoded team and includeArchived', calls[0].url);
    stub(200, { programs: [], truncated: false });
    await ApiClient.getResponsibilities('t1', { view: 'me', teamId: 'tm1' });
    assert(calls[0].url === '/api/v1/tenants/t1/responsibilities?view=me', 'X12b a team id is not sent with view=me');

    stub(200, { programId: 'p1', groups: [{ kind: 'control', results: [], truncated: false }] });
    const found = await ApiClient.searchProgram('t1', { q: 'access & more?', kinds: ['control'], perKind: 5 }, 'p1');
    assert(
      calls[0].url === '/api/v1/search' && calls[0].init.method === 'POST' && headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'Content-Type') === 'application/json'
        && JSON.stringify(JSON.parse(String(calls[0].init.body))) === '{"q":"access & more?","kinds":["control"],"perKind":5}' && found.groups.length === 1,
      'X13 searchProgram is POST /search with the query only in the body', { url: calls[0].url }
    );
    assert(!calls[0].url.includes('access') && !calls[0].url.includes('?') && (calls[0].init as { cache?: unknown }).cache === undefined, 'X13a the query is never in the URL');
    stub(429, { error: 'slow down' });
    let limited: { status?: number; message?: string } | null = null;
    try { await ApiClient.searchProgram('t1', { q: 'ab' }, 'p1'); } catch (e) { limited = e as { status?: number; message?: string }; }
    assert(limited?.status === 429 && limited.message === 'Too many requests. Please wait a moment and try again.', 'X13b a 429 rejects with the fixed message', limited);
    stub(400, { error: 'The search text must be 2 to 100 characters', code: 'invalid_query' });
    let badQ: { status?: number; reason?: string } | null = null;
    try { await ApiClient.searchProgram('t1', { q: 'a' }, 'p1'); } catch (e) { badQ = e as { status?: number; reason?: string }; }
    assert(badQ?.status === 400 && badQ.reason === 'invalid_query', 'X13c a 400 invalid_query rejects with that reason', badQ);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n--- Program scoping (#22) ---');
const NISTID = 'NIST_800_53_REV5';
const sc1 = parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'MODERATE', scoping: { noWireless: true, bogus: true } } });
assert(sc1 !== null && Object.keys(sc1.scoping).length === 0, 'P5g scoping with an unknown key is refused whole and shows as {}', sc1?.scoping);
const sc2 = parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'MODERATE', scoping: { noWireless: true } } });
assert(JSON.stringify(sc2?.scoping) === '{"noWireless":true}', 'P5h valid scoping parses', sc2?.scoping);
const sc3 = parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'MODERATE', privacy_baseline: true, scoping: { noPiiProcessing: true } } });
assert(sc3 !== null && Object.keys(sc3.scoping).length === 0, 'P5i noPiiProcessing on a privacy program shows as {}', sc3?.scoping);
const sc4 = parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'MODERATE' } });
assert(sc4 !== null && Object.keys(sc4.scoping).length === 0 && sc4.vmTarget === false, 'P5j no scoping gives {} and vmTarget defaults to false', sc4);
assert(parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'LOW', vm_target: true } })?.vmTarget === true && parseProgramResponse({ program: { id: 'p', frameworkId: NISTID, baseline: 'LOW', vmTarget: true } })?.vmTarget === true, 'P5k vm_target and vmTarget both read as vmTarget true');
const nistCtx = { tenantFrameworks: [NISTID, 'CMMC_L2'], existing: [] };
const sv1 = validateProgramInput({ name: 'x', framework: NISTID, baseline: 'MODERATE', scoping: { noWireless: true } }, nistCtx);
assert(sv1.valid && (programCreateBody(sv1.value).scoping as { noWireless?: boolean }).noWireless === true, 'P5l a NIST create body carries the scoping', programCreateBody(sv1.value));
const sv2 = validateProgramInput({ name: 'x', framework: NISTID, baseline: 'MODERATE', scoping: { noWireless: false, nonNetworkedOnly: false } }, nistCtx);
assert(sv2.valid && !('scoping' in programCreateBody(sv2.value)), 'P5m all-false scoping sends no scoping key', programCreateBody(sv2.value));
assert(!!validateProgramInput({ name: 'x', framework: 'CMMC_L2', scoping: { noWireless: true } }, nistCtx).errors.scoping, 'P5n a CMMC program with an overlay on is an error');
assert(!!validateProgramInput({ name: 'x', framework: NISTID, baseline: 'MODERATE', privacyBaseline: true, scoping: { noPiiProcessing: true } }, nistCtx).errors.scoping, 'P5o No PII on a privacy program is an error');

console.log('\n--- Overlay helpers (overlayScoping.ts) ---');
const lockCtx: OverlayLockContext = { serverBacked: true, programsStatus: 'ready', canManagePrograms: true, framework: NISTID, program: { framework: NISTID, privacyBaseline: false, archived: false } };
assert(menuLockReason({ ...lockCtx, programsStatus: 'loading' }) === 'loading' && menuLockReason({ ...lockCtx, programsStatus: 'idle' }) === 'loading', 'O1 loading and idle lock as loading');
assert(menuLockReason({ ...lockCtx, programsStatus: 'error' }) === 'unavailable' && menuLockReason({ ...lockCtx, program: null }) === 'unavailable', 'O2 error, or ready without a program, is unavailable');
assert(menuLockReason({ ...lockCtx, program: { framework: NISTID, privacyBaseline: false, archived: true } }) === 'archived', 'O3 an archived program is locked');
const cmmcProgram = { framework: 'CMMC_L2' as const, privacyBaseline: false, archived: false };
assert(menuLockReason({ ...lockCtx, program: cmmcProgram }) === 'not_nist' && menuLockReason({ ...lockCtx, program: cmmcProgram, canManagePrograms: false }) === 'not_nist', 'O4 a CMMC program is not_nist whatever the role');
assert(menuLockReason({ ...lockCtx, canManagePrograms: false }) === 'cannot_manage' && menuLockReason(lockCtx) === null, 'O5 NIST without the role is cannot_manage, with it null');
const privCtx: OverlayLockContext = { ...lockCtx, program: { framework: NISTID, privacyBaseline: true, archived: false } };
assert(overlayLockReason('noPiiProcessing', privCtx) === 'privacy' && overlayLockReason('noPiiProcessing', { ...privCtx, canManagePrograms: false }) === 'privacy' && overlayLockReason('noWireless', privCtx) === null, 'O6 No PII on a privacy program is privacy, the others stay open');
const browserCtx: OverlayLockContext = { serverBacked: false, programsStatus: 'unsupported', canManagePrograms: true, framework: NISTID, program: null };
assert(menuLockReason(browserCtx) === null && menuLockReason({ ...browserCtx, framework: 'CMMC_L1' }) === 'not_nist' && menuLockReason({ ...browserCtx, canManagePrograms: false }) === 'cannot_manage', 'O7 a browser-only tenant: NIST open, CMMC not_nist, no role cannot_manage');
const allLocks: OverlayLock[] = ['loading', 'unavailable', 'archived', 'not_nist', 'privacy', 'cannot_manage'];
assert(allLocks.every((l) => overlayLockText(l, NISTID).length > 0), 'O8a every lock has text');
assert(overlayLockText('not_nist', 'CMMC_L2').includes('N/A') && overlayLockText('not_nist', 'CMMC_L2').includes('assessment objectives') && !overlayScopeNote(true).includes('browser') && overlayScopeNote(false).includes('this browser'), 'O8 the CMMC text points to N/A objectives and the scope note names the browser only when browser-only');
const ovProg = { framework: NISTID, baseline: 'MODERATE' as const };
const sumOn = summarizeOverlayChange(ovProg, noOverlays, 'noWireless');
const wirelessOn = programFrameworkControls(ovProg, { nonNetworkedOnly: false, noWireless: true }).length;
assert(
  sumOn.turningOn === true && sumOn.before === programFrameworkControls(ovProg, noOverlays).length && sumOn.after === wirelessOn && sumOn.changedIds.includes('AC-18')
    && sumOn.changedIds.length === sumOn.before - sumOn.after && sumOn.sampleIds.length === Math.min(5, sumOn.changedIds.length) && sumOn.moreCount === sumOn.changedIds.length - sumOn.sampleIds.length,
  'O9 turning No Wireless on removes AC-18 and the counts add up', { before: sumOn.before, after: sumOn.after }
);
const sumOff = summarizeOverlayChange(ovProg, { nonNetworkedOnly: false, noWireless: true }, 'noWireless');
assert(sumOff.turningOn === false && sumOff.after > sumOff.before && sumOff.changedIds.includes('AC-18'), 'O10 turning it off returns AC-18', { before: sumOff.before, after: sumOff.after });
assert(
  describeOverlayChange({ turningOn: true, before: 10, after: 9, changedIds: ['A'] }) === '1 control leaves the scope of this program: it goes from 10 to 9 controls.'
    && describeOverlayChange({ turningOn: false, before: 8, after: 10, changedIds: ['A', 'B'] }) === '2 controls return to the scope of this program: it goes from 8 to 10 controls.'
    && describeOverlayChange({ turningOn: true, before: 5, after: 5, changedIds: [] }) === 'No control of this program depends on this overlay: it keeps 5 controls.',
  'O11 the change sentences'
);
assert(
  overlaySaveErrorMessage({ status: 409 }).includes('archived') && overlaySaveErrorMessage({ status: 400, reason: 'invalid_scoping' }).includes('did not accept') && overlaySaveErrorMessage({ status: 403 }).includes('role')
    && overlaySaveErrorMessage({ status: 0 }).includes('could not be reached') && overlaySaveErrorMessage({ code: 'overlay_locked' }).includes('right now') && !overlaySaveErrorMessage(new Error('secret-note')).includes('secret-note'),
  'O12 the save error texts, and the server text is never echoed'
);
assert(JSON.stringify(programOverlayLabels({ noWireless: true, nonNetworkedOnly: true })) === '["Air-gapped","No wireless"]' && programOverlayLabels({}).length === 0 && programOverlayLabels(undefined).length === 0, 'O13 programOverlayLabels lists the active ones in menu order');

console.log('\n--- Stale overlay save (#115) ---');
const conflictText = overlaySaveErrorMessage({ status: 409, reason: 'scoping_conflict' });
assert(conflictText.includes('Someone else changed') && conflictText.includes('Nothing was saved') && !conflictText.includes('archived'), 'P5g2 a scoping_conflict says someone else changed the overlays, not that the program was archived', conflictText);
assert(overlaySaveErrorMessage({ status: 409 }).includes('archived') && overlaySaveErrorMessage({ status: 409, reason: 'program_archived' }).includes('archived'), 'P5g3 a plain 409 and program_archived still say archived');
assert(isOverlayConflict({ reason: 'scoping_conflict' }) && isOverlayConflict({ code: 'scoping_conflict' }) && !isOverlayConflict({ status: 409 }) && !isOverlayConflict(null) && !isOverlayConflict({ reason: 'program_archived' }), 'P5g4 isOverlayConflict truth table');
const seenCur = { nonNetworkedOnly: false, noWireless: true, noMobileDevices: false, noPiiProcessing: false };
assert(JSON.stringify(summarizeOverlayChange(ovProg, seenCur, 'noMobileDevices').seen) === JSON.stringify(seenCur), 'P5h2 summarizeOverlayChange returns the overlays it was computed from as seen');

console.log('\n--- Matrix banner (#117) ---');
const bannerCur = { nonNetworkedOnly: true, noWireless: true, noMobileDevices: false, noPiiProcessing: false };
const bannerNone = { nonNetworkedOnly: false, noWireless: false, noMobileDevices: false, noPiiProcessing: false };
const bannerF = (o: typeof bannerCur) => programFrameworkControls(ovProg, o);
const rem = overlayRemovals(bannerF, bannerCur);
const remBefore = bannerF(bannerNone).length;
const wirelessAlone = remBefore - bannerF({ ...bannerNone, noWireless: true }).length;
assert(rem.overlays.map((o) => o.key).join() === 'nonNetworkedOnly,noWireless', 'OR1 the removals list the active overlays in menu order', rem.overlays.map((o) => o.key));
assert(bannerF(bannerNone).some((c) => c.id === 'AC-18') && rem.overlays[1].removed === wirelessAlone && wirelessAlone > 0, 'OR2 No Wireless alone removes the difference it makes (AC-18 is in scope without overlays)', [rem.overlays[1].removed, wirelessAlone]);
assert(rem.before === remBefore && rem.after === bannerF(bannerCur).length && rem.totalRemoved === rem.before - rem.after && rem.totalRemoved > 0, 'OR3 before, after and totalRemoved add up', rem);
const remNone = overlayRemovals(bannerF, bannerNone);
assert(remNone.overlays.length === 0 && remNone.totalRemoved === 0 && remNone.before === remNone.after, 'OR4 no active overlay: nothing listed, nothing removed');
const bt1 = overlayBannerText({ overlays: [{ removed: 3 }], before: 300, after: 297, totalRemoved: 3 }, null);
assert(bt1.heading === '1 operational overlay is active' && bt1.summary.includes('3 of 300 controls are out of scope') && bt1.summary.includes('assesses 297 controls') && bt1.overlap === null, 'OR5 one overlay: heading, summary, no overlap note', bt1);
assert(overlayBannerText({ overlays: [{ removed: 4 }, { removed: 3 }], before: 300, after: 295, totalRemoved: 5 }, null).overlap !== null, 'OR6 overlapping removals (4 + 3 > 5) add the overlap note');
const bt7 = overlayBannerText({ overlays: [{ removed: 4 }, { removed: 3 }], before: 300, after: 293, totalRemoved: 7 }, null);
assert(bt7.overlap === null && bt7.heading === '2 operational overlays are active', 'OR7 disjoint removals (4 + 3 = 7) add no overlap note', bt7);
assert(overlayBannerText({ overlays: [{ removed: 0 }, { removed: 0 }], before: 280, after: 280, totalRemoved: 0 }, null).summary.startsWith('No control of this program depends on them'), 'OR8 no removal at all says no control depends on them');
const lockOf = (lock: Parameters<typeof overlayBannerText>[1]) => overlayBannerText({ overlays: [{ removed: 1 }], before: 10, after: 9, totalRemoved: 1 }, lock).pointer;
assert(lockOf(null) === 'Change them from the Overlays menu in the header.' && lockOf('cannot_manage').includes('Only a Tenant Owner or Admin') && lockOf('archived').includes('archived and read-only') && lockOf('loading') === 'They are listed in the Overlays menu in the header.', 'OR9 the pointer follows the lock reason');

console.log('\n--- Boundary asset membership helpers (programAssets.ts) ---');
const pam = parseAssetMemberships({ memberships: [{ programId: 'p1', assetIds: ['a1'] }, { programId: '', assetIds: [] }, null] });
assert(JSON.stringify(pam) === '{"p1":["a1"]}' && JSON.stringify(parseAssetMemberships(null)) === '{}', 'PA-C3 parseAssetMemberships maps program id to ids, drops bad rows, null gives {}', pam);
const ba1 = { id: 'a1', cmmcAssetCategory: 'CUI_ASSET' as const };
const ba2 = { id: 'a2', cmmcAssetCategory: 'SECURITY_PROTECTION' as const };
assert(
  boundaryAssets([ba1, ba2], ['a1'], true).map((a) => a.id).join() === 'a1' && boundaryAssets([ba1, ba2], [], false).map((a) => a.id).join() === 'a1,a2' && boundaryAssets([ba1], ['zz'], true).length === 0,
  'PA-C4 boundaryAssets: the members when declared, the whole inventory when not, nothing when the member is gone'
);
const delta = membershipDelta(new Set(['a', 'b']), new Set(['b', 'c']));
assert(JSON.stringify(delta) === '{"add":["c"],"remove":["a"]}', 'PA-C5 membershipDelta gives the ids to add and to remove', delta);
const pas = parseProgramAssets({ programId: 'p1', assetIds: ['a1'], summary: { total: 3, inScope: 2, byCategory: { CUI_ASSET: 2, bogus: 9 } } });
assert(pas.declared === true && pas.summary.total === 3 && pas.summary.byCategory.CUI_ASSET === 2 && !('bogus' in pas.summary.byCategory) && !parseProgramAssets(null).declared, 'PA-C3b parseProgramAssets derives declared, keeps only known summary fields, and null is undeclared', pas);
const labels = membershipLabels(
  'a1',
  { p1: ['a1'], p2: ['a1'], p3: ['a2'] },
  [{ id: 'p2', name: 'Lab', archived: true, isDefault: false }, { id: 'p1', name: 'Main', archived: false, isDefault: true }, { id: 'p3', name: 'Other', archived: false, isDefault: false }]
);
assert(JSON.stringify(labels) === '[{"id":"p1","name":"Main","archived":false,"isDefault":true},{"id":"p2","name":"Lab","archived":true,"isDefault":false}]', 'PA-C5b membershipLabels lists the programs of an asset with their id, default first, archived flagged', labels);

async function main() {
  await headers();

  console.log('\n--- Static checks ---');
  const root = process.cwd();
  const api = fs.readFileSync(path.join(root, 'src/services/apiClient.ts'), 'utf8').replace(/\r\n/g, '\n');
  const scoped = ['getControls', 'updateControl', 'getEvidence', 'requestUploadUrl', 'uploadEvidenceFile', 'sspCapabilities', 'sspListJobs', 'sspUpload', 'sspGetStaged', 'sspGetJob', 'sspReview', 'sspCommit', 'sspCancel', 'sspDelete', 'sspDownloadUrl', 'getSspMetadata', 'putSspMetadata', 'getSspProfile', 'putSspProfile', 'getSspReviews', 'postSspReview', 'listControlPoam', 'updateControlPoam', 'getControlPoamEvents', 'getObjectives', 'putObjective', 'putObjectivesBulk', 'importObjectives', 'getObjectiveHistory', 'getCatalogUpdateChanges', 'getEvidenceFileBlob', 'verifyEvidenceIntegrity', 'deleteEvidence', 'getConfigSuggestions', 'getVmPoam', 'updateVmPoamItem', 'getVmPoamItemEvents', 'getVmPoamItem', 'getProgramObservedHosts', 'listProgramObservedSoftware', 'getProgramInventory', 'patchProgramTools', 'putToolControls', 'getDataInventory', 'putDataInventory', 'linkVendorDocument', 'unlinkVendorDocument', 'getProgramInventoryEvents', 'getProgramDocuments', 'patchProgramDocuments', 'putDocumentControls', 'linkDocumentAttachment', 'setDocumentAttachmentPrimary', 'unlinkDocumentAttachment', 'putDocumentExpectation', 'getProgramSummary', 'listAssignments', 'putAssignments', 'listMyAssignments', 'searchProgram', 'previewFrameworkCopy', 'commitFrameworkCopy', 'getFrameworkCopyRuns', 'getFrameworkCopySuggestions'];
  const methods: { name: string; params: string; body: string }[] = [];
  const re = /^ {2}(?:async )?(\w+)\(([\s\S]*?)\)\s*:\s*[A-Za-z]/gm;
  let m: RegExpExecArray | null;
  const starts: { name: string; params: string; at: number }[] = [];
  while ((m = re.exec(api))) starts.push({ name: m[1], params: m[2], at: m.index });
  starts.forEach((s, i) => methods.push({ name: s.name, params: s.params, body: api.slice(s.at, starts[i + 1]?.at ?? api.length) }));
  const byName = new Map(methods.map((x) => [x.name, x]));

  const missing = scoped.filter((n) => !/programId\?: string \| null\s*$/.test((byName.get(n)?.params ?? '').trim()));
  assert(missing.length === 0, 'T2a each scoped method ends with an optional programId?: string | null parameter', missing);
  const unused = scoped.filter((n) => (byName.get(n)?.body.match(/programId/g) ?? []).length < 2);
  assert(unused.length === 0, 'T2b each scoped method actually uses programId', unused);
  const tenantWide = methods.filter((x) => !scoped.includes(x.name) && !/program/i.test(x.name) && x.name !== 'getHeaders');
  const leaked = tenantWide.filter((x) => /programId/.test(x.params)).map((x) => x.name);
  assert(tenantWide.length > 20 && leaked.length === 0, 'T2c no tenant-wide method takes a programId', { leaked, checked: tenantWide.length });
  assert(/getHeaders\(tenantId: string, extraHeaders\?: HeadersInit, programId\?: string \| null\)/.test(api), 'T2d getHeaders accepts an optional programId');

  const hookSource = fs.readFileSync(path.join(root, 'src/hooks/useProgramAssets.ts'), 'utf8');
  assert(!/localStorage|sessionStorage|setItem|console\./.test(hookSource), 'PA-C6 useProgramAssets uses no browser storage and no console');
  assert(
    /options\?: \{ enabled\?: boolean \}/.test(hookSource) && /status: ProgramAssetsStatus/.test(hookSource) && /activeIds: ReadonlySet<string>/.test(hookSource) && /export function subscribeProgramAssets/.test(hookSource) && /add: \(ids: string\[\]\) => Promise<void>/.test(hookSource) && /unknown_assets/.test(hookSource) && /program_not_found/.test(hookSource) && /409/.test(hookSource) && /refreshPrograms\(tenantId\)/.test(hookSource),
    'PA-C8 useProgramAssets exposes status, enabled, a memoised ReadonlySet, add/remove that reject, a notifier, and reloads on a stale refusal'
  );
  assert(['listProgramAssetMemberships', 'getProgramAssets', 'updateProgramAssets'].every((n) => byName.has(n) && !scoped.includes(n) && !/programId\?/.test(byName.get(n)?.params ?? '')), 'PA-C7 the membership methods are in the apiClient and take the program id as a plain argument');

  const syncSource = fs.readFileSync(path.join(root, 'src/data/programSync.ts'), 'utf8');
  assert(!/\.setItem\(/.test(syncSource), 'T2e programSync.ts writes no browser storage');

  // The contexts (React, so not rendered here): the guards that keep one program's data out of another, read from the source
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  const tenantCtx = read('src/context/TenantContext.tsx');
  const assessCtx = read('src/context/AssessmentContext.tsx');
  assert(/shouldPersistAssessment\(stateScope, programScope\)/.test(assessCtx) && !/state\.tenantId === currentTenant\.id/.test(assessCtx), 'T6a the auto-save runs only when the state belongs to the scope on screen (no bare tenant-id check)');
  assert(/liveScopeKey === programScope/.test(assessCtx) && /programScopeKey\(prev\.tenantId, prev\.programId\) !== programScope\) return prev/.test(assessCtx), 'T6b live data is merged only for the scope on screen and only into a state of that scope');
  assert(/loadAssessment\(currentTenant, activeProgram\?\.framework \?\? 'CMMC_L1', cacheSegment\)/.test(assessCtx) && /\[currentTenant\.id, programScope\]/.test(assessCtx), 'T6c the cache is reloaded from the program\'s own key when the scope changes');
  const auditCalls = (assessCtx.match(/recordAuditEvent\(\{/g) ?? []).length;
  const auditMeta = (assessCtx.match(/recordAuditEvent\(\{\n\s+tenantId: currentTenant\.id,\n\s+metadata: auditMetadata,/g) ?? []).length;
  assert(auditCalls === 11 && auditMeta === auditCalls, 'T6d every recordAuditEvent in AssessmentContext carries metadata.programId', { auditCalls, auditMeta });
  // Evidence delete (#88) and the upload ledger entry (#87), read from the source
  const removeBody = assessCtx.slice(assessCtx.indexOf('const removeEvidence = useCallback'), assessCtx.indexOf('const resetAssessment = useCallback'));
  const iCatchReturn = removeBody.indexOf('return false;', removeBody.indexOf('catch (err)'));
  const iFirstSetState = removeBody.indexOf('setState(');
  assert(
    removeBody.includes('await deleteLiveEvidence(evidenceId, programId ?? null)') && removeBody.includes('The evidence could not be deleted on the server:') && iCatchReturn > 0 && iFirstSetState > iCatchReturn,
    'S1 removeEvidence deletes on the server first and returns from the catch before any local state change',
    { iCatchReturn, iFirstSetState }
  );
  assert(/programScopeKey\(prev\.tenantId, prev\.programId\) !== deleteScope \? prev :/.test(removeBody) && removeBody.includes('const deleteScope = programScope;'), 'S2 the local removal only touches the state of the scope the delete started in');
  assert(assessCtx.includes('targetEntity: newItem.id') && assessCtx.includes('describeNotesForLedger(file.name)') && !assessCtx.includes('targetEntity: file.name'), 'S3 the upload ledger entry names the evidence by id and a descriptor, not the file name');
  assert(tenantCtx.includes('ApiClient.deleteEvidence(currentTenant.id, evidenceId, program)'), 'S4 deleteLiveEvidence calls ApiClient.deleteEvidence with the program the delete started in');
  assert(/\| 'programs'/.test(assessCtx), 'T6e NavigationTab has the programs tab');
  assert(/isCurrentResponse\(seq, liveSeq\.current\)/.test(tenantCtx) && (tenantCtx.match(/isCurrentResponse\(seq, liveSeq\.current\)/g) ?? []).length >= 3, 'T6f refreshLiveData drops every response that is not the newest request');
  const switchBody = tenantCtx.slice(tenantCtx.indexOf('const switchProgram = useCallback'));
  const iPersist = switchBody.indexOf('localStorage.setItem(activeProgramStorageKey(');
  const iDrop = switchBody.indexOf('dropLiveData();');
  const iCommit = switchBody.indexOf('commitPrograms({ ...ps, activeId: programId })');
  assert(iPersist > 0 && iDrop > iPersist && iCommit > iDrop, 'T6g switchProgram persists the choice, then clears the live data (bumping the sequence), then commits the new program');
  assert(/liveSeq\.current\+\+;\s+setLiveControls\(null\);\s+setLiveEvidence\(null\);\s+setLiveObjectives\(null\);\s+setLiveSspMetadata\(null\);\s+setLiveScopeKey\(null\);/.test(tenantCtx), 'T6h dropLiveData bumps the request sequence and clears controls, evidence, objectives, SSP metadata and the scope key together');
  assert(!/liveControlsTenantId/.test(tenantCtx) && /liveScopeKey: string \| null/.test(tenantCtx), 'T6i TenantContext exposes liveScopeKey, not liveControlsTenantId');
  assert(!/ACTIVE_FRAMEWORK_KEY|ACTIVE_BASELINE_TIER_KEY|getItem\('pbc_active_cia_triad'\)|setItem\('pbc_active_cia_triad'/.test(tenantCtx), 'T6j the per-browser framework, baseline and CIA keys are no longer read or written');
  const legacy = tenantCtx.slice(tenantCtx.indexOf('const LEGACY_STORAGE_KEYS'), tenantCtx.indexOf('];', tenantCtx.indexOf('const LEGACY_STORAGE_KEYS')));
  assert(['pbc_active_framework_v1', 'pbc_active_baseline_tier_v1', 'pbc_active_cia_triad'].every((k) => legacy.includes(`'${k}'`)), 'T6k the per-browser framework, baseline and CIA keys are purged as legacy keys');
  assert(!/localStorage\.setItem\(ACTIVE_OVERLAY_FILTERS_KEY/.test(tenantCtx) && legacy.includes("'pbc_active_overlay_filters_v1'"), 'T6l the browser-wide overlay key is purged as a legacy key and no longer written');
  assert(/scopingToOverlays\(activeProgram\?\.scoping/.test(tenantCtx), 'P5a a server-backed tenant\'s overlays are derived from the active program');
  const toggleBody = tenantCtx.slice(tenantCtx.indexOf('const toggleOverlayFilter = useCallback'), tenantCtx.indexOf('const toggleNonNetworkedOverlay = useCallback'));
  assert(toggleBody.includes('updateProgram(program.id, { scoping:') && toggleBody.includes('overlayLockReason(') && toggleBody.includes("code: 'overlay_locked'"), 'P5b toggleOverlayFilter saves through updateProgram and rejects when the overlays are locked');
  const serverPart = toggleBody.slice(toggleBody.indexOf('const base = seen ?? scopingToOverlays'));
  assert(serverPart.length > 100 && serverPart.includes('expectedScoping: base') && serverPart.includes('isOverlayConflict(err)') && serverPart.includes('refreshPrograms('), 'P5i the server path sends the overlays it started from as expectedScoping and reloads the programs on a conflict', serverPart.length);
  assert(!/localStorage/.test(serverPart) && !/setActiveOverlayFilters/.test(tenantCtx), 'P5c nothing is written to browser storage for a server-backed tenant, and setActiveOverlayFilters is gone');
  // The key and the reader live in src/data/browserOverlays.ts since #131 (the handover engine reads them too); the context imports them
  const browserOverlaysSrc = read('src/data/browserOverlays.ts');
  assert(/export const overlayFiltersStorageKey = \(tenantId: string\) => `pbc_overlay_filters_\$\{tenantId\}`/.test(browserOverlaysSrc) && /import \{ overlayFiltersStorageKey, readBrowserOverlayFilters \} from '\.\.\/data\/browserOverlays'/.test(tenantCtx) && /removeItem\(overlayFiltersStorageKey\(tenantId\)\)/.test(tenantCtx), 'P5d a browser-only tenant keeps its overlays under pbc_overlay_filters_<tenantId>, removed by deleteTenant');
  assert(/toggleOverlayFilter: \(key: keyof OverlayFilters, seen\?: OverlayFilters\) => Promise<void>/.test(tenantCtx) && /toggleNonNetworkedOverlay: \(seen\?: OverlayFilters\) => Promise<void>/.test(tenantCtx), 'P5e the toggles return Promises');
  assert(/body\.scoping = updates\.scoping/.test(api), 'P5f updateProgram sends scoping');
  assert(/programsStatus: ProgramsStatus = !currentTenant\.serverBacked \? 'unsupported'/.test(tenantCtx), 'T6m a browser-only tenant has programs status unsupported');
  assert(/ciaTriad = useMemo<CiaTriadSelection>\(\(\) => programBaselineToCia\(activeProgram\?\.baseline\)/.test(tenantCtx) && /activeProgram\?\.framework \?\? currentTenant\.primaryFramework/.test(tenantCtx), 'T6n the framework and CIA triad are derived from the active program');
  assert(/StorageService\.listProgramKeys\(tenantId\)/.test(tenantCtx) && /listProgramKeys\(params\.tenantId\)/.test(read('src/data/storage/offboardingEngine.ts')), 'T6o deleteTenant and the offboarding purge remove the program caches');
  const stackBody = tenantCtx.slice(tenantCtx.indexOf('const updateStackProfile = useCallback'), tenantCtx.indexOf('const suspendTenant = useCallback'));
  assert(!/localStorage|saveAssessment/.test(stackBody) && /scopeNow\(currentTenant\.id\)/.test(stackBody) && /getFrameworkControls\(activeFramework/.test(stackBody), 'T6p updateStackProfile writes no browser storage and cascades only to the active program\'s framework controls');

  // #230: the enclave stack profile belongs to the program, falling back to the tenant's
  const stackRaw = { identityProvider: 'OKTA', edrSolution: 'SENTINELONE', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'JAMF', siemSolution: 'ELASTIC', odpParams: { A_1: '1' } };
  assert(parseProgramList({ programs: [{ id: 's1', framework: 'CMMC_L2', stackProfile: stackRaw }] })[0]?.stackProfile?.identityProvider === 'OKTA', 'C-P1 the parser reads stackProfile');
  assert(parseProgramList({ programs: [{ id: 's1', framework: 'CMMC_L2', stack_profile: stackRaw }] })[0]?.stackProfile?.identityProvider === 'OKTA', 'C-P2 the parser reads snake_case stack_profile');
  assert(parseProgramList({ programs: [{ id: 's1', framework: 'CMMC_L2', stackProfile: { ...stackRaw, identityProvider: 'NOPE' } }] })[0]?.stackProfile === null && parseProgramList({ programs: [{ id: 's1', framework: 'CMMC_L2' }] })[0]?.stackProfile === null, 'C-P3 an invalid or missing stackProfile parses to null');
  const stackFn = tenantCtx.slice(tenantCtx.indexOf('const updateStackProfile = useCallback'));
  const stackFnBody = stackFn.slice(0, stackFn.indexOf('useCallback', 40));
  assert(stackFnBody.includes('updateProgram(activeProgram.id, { stackProfile: profile })') && stackFnBody.includes('void updateTenant(currentTenant.id, { stackProfile: profile })'), 'C-T4 updateStackProfile saves to the active program, else to the tenant');
  assert(!/localStorage\.setItem\([^;]*JSON\.stringify\([^;]*programs/.test(tenantCtx), 'C-T5 the programs are never written to browser storage');

  // The objective status writer saves the rolled-up control status (otherwise the next live merge reverts it)
  const statusBody = assessCtx.slice(assessCtx.indexOf('const updateObjectiveStatus = useCallback'), assessCtx.indexOf('const updateObjectiveNarrative = useCallback'));
  assert(statusBody.includes('saveControl(controlId, { status: rolledStatus') && !statusBody.includes("previousState: 'STATUS_UPDATE'") && !statusBody.includes('updateLiveControl(') && (statusBody.match(/saveControl\(/g) ?? []).length === 1, 'T6r updateObjectiveStatus saves the rolled-up control status once, and records the real previous status in the ledger');
  assert(/\.then\(ok => \{\s+if \(ok\) void saveControl\(controlId, \{ status: rolledStatus/.test(statusBody.replace(/\r\n/g, '\n')), 'M292-4 the rolled-up control status is sent only after its objective was saved');
  const hook = read('src/hooks/useProgram.ts');
  assert(!/\.setItem\(/.test(hook) && /useTenant\(\)/.test(hook), 'T6q useProgram is a read-through of TenantContext and writes no storage');

  // The header switcher and the create / edit dialog (wave 4, P3), read from the source
  const formModal = read('src/components/programs/ProgramFormModal.tsx');
  const switcher = read('src/components/layout/ProgramSwitcher.tsx');
  const header = read('src/components/layout/Header.tsx');
  const profileMenu = read('src/components/auth/UserProfileDropdown.tsx');
  const overlaysMenu = read('src/components/layout/FrameworkSwitcher.tsx');
  assert(/import \{[^}]*DialogOverlay[^}]*\} from '..\/common\/DialogOverlay'/.test(formModal) && /<DialogOverlay[\s>]/.test(formModal) && /<DialogTitle[\s>]/.test(formModal), 'T4 ProgramFormModal.tsx renders through DialogOverlay and DialogTitle');
  assert(/validateProgramInput\(/.test(formModal) && /PROGRAM_FRAMEWORKS/.test(formModal) && /currentTenant\.enabledFrameworks/.test(formModal) && /maxLength=\{PROGRAM_TEXT_MAX\}/.test(formModal), 'T4b the dialog validates through validateProgramInput and offers only the tenant\'s enabled frameworks');
  assert(/isSaving \? undefined : close/.test(formModal) && /disabled=\{isSaving\}/.test(formModal), 'T4c the dialog cannot be dismissed while a request is in flight');
  assert(/canManagePrograms/.test(switcher) && /\{canManagePrograms && \(/.test(switcher) && /New Program/.test(switcher), 'T5 ProgramSwitcher.tsx shows "New Program" only when canManagePrograms');
  assert(/role="menuitemradio"/.test(switcher) && /aria-checked=\{selected\}/.test(switcher) && /useEscapeKey\(/.test(switcher) && /addEventListener\('mousedown'/.test(switcher) && /window\.location\.hash = 'programs'/.test(switcher) && /Default boundary/.test(switcher), 'T5b the switcher is a menuitemradio menu closing on Escape and outside mousedown, links to #programs and has the browser-only badge');
  assert(/<ProgramSwitcher\s*\/>/.test(header) && /<FrameworkSwitcher\s*\/>/.test(header) && header.indexOf('<TenantSwitcher') < header.indexOf('<ProgramSwitcher'), 'T5c Header renders the ProgramSwitcher after the TenantSwitcher (FrameworkSwitcher stays only as the overlays menu)');
  assert(!/setCiaImpact|toggleAllControlsApplied|setActiveFramework|CIA Triad/.test(overlaysMenu) && (overlaysMenu.match(/toggleOverlayFilter\('/g) ?? []).length === 4, 'T5d FrameworkSwitcher is the overlays menu: four overlay toggles, no framework menu, no CIA editor');
  assert(/Programs/.test(profileMenu) && !/Switch Organization/.test(profileMenu) && /window\.location\.hash = 'programs'/.test(profileMenu), 'T5e the profile menu has "Programs" (to #programs) and no "Switch Organization"');

  assert(/No program yet/.test(switcher) && /Org default/.test(switcher) && /p\.isMyDefault/.test(switcher) && /Organization default/.test(switcher), 'T5f the switcher has the no-program chip and the Org default / My default badges');
  assert(/isMyDefault \?\? raw\.is_my_default/.test(read('src/data/programSync.ts')), 'T5g the parser reads isMyDefault');
  const choiceSrc = read('src/data/programDefaultChoice.ts');
  assert(!/console\.|localStorage|sessionStorage/.test(choiceSrc), 'T6 programDefaultChoice.ts logs nothing and touches no storage');
  assert(/hasAssessmentCache\(currentTenant\.id, null\)/.test(assessCtx) && /activeProgram\?\.isDefault/.test(assessCtx) && /!StorageService\.hasAssessmentCache\(currentTenant\.id, cacheSegment\)/.test(assessCtx) && /blankAssessment\(currentTenant\)/.test(assessCtx), 'K13 the legacy cache is read once, only for the default program with no cache of its own; no program reads no cache');
  assert(!/segment: null|saveAssessment\([^)]*,\s*null\)/.test(assessCtx) && /segment: cacheSegment/.test(assessCtx), 'K14 the auto-save only ever writes the program\'s own key');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
