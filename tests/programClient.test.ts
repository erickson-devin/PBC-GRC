import fs from 'fs';
import path from 'path';
import { ApiClient } from '../src/services/apiClient';
import {
  activeProgramStorageKey,
  isCurrentResponse,
  parseProgramList,
  parseProgramMetrics,
  pickActiveProgramId,
  programCacheSegment,
  programCreateBody,
  programScopeKey,
  shouldPersistAssessment,
  validateProgramInput,
} from '../src/data/programSync';
import { nistControlsWithPrivacy, programBaselineToCia, programFrameworkControls } from '../src/data/programScope';
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
assert(pickActiveProgramId('gone', list) === 'p1', 'A2 a stored id that is gone falls back to the default');
assert(pickActiveProgramId('p2', [list[0], { id: 'p2', isDefault: false, archived: true }]) === 'p1', 'A3 an archived stored id falls back to the default');
assert(pickActiveProgramId(null, [{ id: 'pA', isDefault: false, archived: true }, { id: 'pB', isDefault: false, archived: false }]) === 'pB', 'A4 without a default flag the first open program is used');
assert(pickActiveProgramId('p1', []) === null, 'A5 no programs gives null');
assert(pickActiveProgramId('p1', [{ id: 'p1', isDefault: true, archived: true }]) === null, 'A6 only archived programs gives null');

console.log('\n--- scope keys ---');
assert(activeProgramStorageKey('t1') === 'pbc_active_program_t1', 'K1 the active-program storage key');
assert(programScopeKey('t1', 'p1') === 't1::p1' && programScopeKey('t1', null) === 't1', 'K4 programScopeKey is t::p, or t without a program');
assert(programCacheSegment({ isDefault: true, id: 'p1' }) === null && programCacheSegment({ isDefault: false, id: 'p9' }) === 'p9' && programCacheSegment(null) === null, 'K5 the default program has no cache segment, any other uses its id');

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

    stub(200, { job: { id: 'j' } });
    const file = new File(['x'], 'ssp.docx');
    await ApiClient.sspUpload('t1', file, 'CMMC_L2', 'rules', undefined, 'p1');
    assert(headerOf(calls[0], 'x-program-id') === 'p1' && headerOf(calls[0], 'x-tenant-id') === 't1' && headerOf(calls[0], 'Content-Type') === undefined, 'H4 sspUpload sends x-program-id and no client Content-Type');
    await ApiClient.sspUpload('t1', file, 'CMMC_L2');
    assert(headerOf(calls[1], 'x-program-id') === undefined, 'H4b sspUpload without a program sends no x-program-id');

    stub(200, { members: [] });
    await ApiClient.listMembers('t1');
    assert(headerOf(calls[0], 'x-program-id') === undefined && headerOf(calls[0], 'x-tenant-id') === 't1', 'H5 listMembers sends no x-program-id');
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
    stub(201, { program: { id: 'p9', framework: 'NIST_800_53_REV5', baseline: 'HIGH', name: 'N' } });
    const created = await ApiClient.createProgram('t1', { name: 'N', framework: 'NIST_800_53_REV5', baseline: 'HIGH', seed: 'clone', sourceProgramId: 'p1' });
    const postBody = JSON.parse(String(calls[0].init.body)) as { seed?: { cloneFrom?: string }; frameworkId?: string };
    assert(calls[0].init.method === 'POST' && postBody.frameworkId === 'NIST_800_53_REV5' && postBody.seed?.cloneFrom === 'p1' && created.id === 'p9', 'H8e createProgram posts the server body and parses the program', postBody);

    stub(200, { documented: 112, total: 287, evidence: 5, openPoam: 3 });
    const metrics = await ApiClient.getProgramMetrics('t1', 'p1');
    assert(calls[0].url === '/api/v1/tenants/t1/programs/p1/metrics' && metrics.evidenceCount === 5 && metrics.documented === 112, 'H9 getProgramMetrics reads the metrics endpoint');

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
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  await headers();

  console.log('\n--- Static checks ---');
  const root = process.cwd();
  const api = fs.readFileSync(path.join(root, 'src/services/apiClient.ts'), 'utf8').replace(/\r\n/g, '\n');
  const scoped = ['getControls', 'updateControl', 'getEvidence', 'requestUploadUrl', 'uploadEvidenceFile', 'sspCapabilities', 'sspListJobs', 'sspUpload', 'sspGetStaged', 'sspGetJob', 'sspReview', 'sspCommit', 'sspCancel', 'sspDelete', 'sspDownloadUrl', 'getObjectives', 'putObjective', 'putObjectivesBulk', 'importObjectives', 'getObjectiveHistory', 'getEvidenceFileBlob', 'verifyEvidenceIntegrity', 'deleteEvidence'];
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
  assert(auditCalls === 9 && auditMeta === auditCalls, 'T6d every recordAuditEvent in AssessmentContext carries metadata.programId', { auditCalls, auditMeta });
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
  assert(/liveSeq\.current\+\+;\s+setLiveControls\(null\);\s+setLiveEvidence\(null\);\s+setLiveObjectives\(null\);\s+setLiveScopeKey\(null\);/.test(tenantCtx), 'T6h dropLiveData bumps the request sequence and clears controls, evidence, objectives and the scope key together');
  assert(!/liveControlsTenantId/.test(tenantCtx) && /liveScopeKey: string \| null/.test(tenantCtx), 'T6i TenantContext exposes liveScopeKey, not liveControlsTenantId');
  assert(!/ACTIVE_FRAMEWORK_KEY|ACTIVE_BASELINE_TIER_KEY|getItem\('pbc_active_cia_triad'\)|setItem\('pbc_active_cia_triad'/.test(tenantCtx), 'T6j the per-browser framework, baseline and CIA keys are no longer read or written');
  const legacy = tenantCtx.slice(tenantCtx.indexOf('const LEGACY_STORAGE_KEYS'), tenantCtx.indexOf('];', tenantCtx.indexOf('const LEGACY_STORAGE_KEYS')));
  assert(['pbc_active_framework_v1', 'pbc_active_baseline_tier_v1', 'pbc_active_cia_triad'].every((k) => legacy.includes(`'${k}'`)), 'T6k the per-browser framework, baseline and CIA keys are purged as legacy keys');
  assert(/pbc_active_overlay_filters_v1/.test(tenantCtx) && !/pbc_active_overlay_filters_v1/.test(legacy), 'T6l overlays stay per browser (not purged)');
  assert(/programsStatus: ProgramsStatus = !currentTenant\.serverBacked \? 'unsupported'/.test(tenantCtx), 'T6m a browser-only tenant has programs status unsupported');
  assert(/ciaTriad = useMemo<CiaTriadSelection>\(\(\) => programBaselineToCia\(activeProgram\?\.baseline\)/.test(tenantCtx) && /activeProgram\?\.framework \?\? currentTenant\.primaryFramework/.test(tenantCtx), 'T6n the framework and CIA triad are derived from the active program');
  assert(/StorageService\.listProgramKeys\(tenantId\)/.test(tenantCtx) && /listProgramKeys\(params\.tenantId\)/.test(read('src/data/storage/offboardingEngine.ts')), 'T6o deleteTenant and the offboarding purge remove the program caches');
  const stackBody = tenantCtx.slice(tenantCtx.indexOf('const updateStackProfile = useCallback'), tenantCtx.indexOf('const suspendTenant = useCallback'));
  assert(!/localStorage|saveAssessment/.test(stackBody) && /scopeNow\(currentTenant\.id\)/.test(stackBody) && /getFrameworkControls\(activeFramework/.test(stackBody), 'T6p updateStackProfile writes no browser storage and cascades only to the active program\'s framework controls');

  // The objective status writer saves the rolled-up control status (otherwise the next live merge reverts it)
  const statusBody = assessCtx.slice(assessCtx.indexOf('const updateObjectiveStatus = useCallback'), assessCtx.indexOf('const updateObjectiveNarrative = useCallback'));
  assert(statusBody.includes('saveControl(controlId, { status: rolledStatus') && !statusBody.includes("previousState: 'STATUS_UPDATE'") && !statusBody.includes('updateLiveControl(') && (statusBody.match(/saveControl\(/g) ?? []).length === 1, 'T6r updateObjectiveStatus saves the rolled-up control status once, and records the real previous status in the ledger');
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

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
