/**
 * Phase 5.6: implementation notes (possible CUI) never sit in the browser cache of server-backed tenants.
 * Pure test: no server, a fake Storage, the real scrub, ledger redaction and storageService.
 */

import fs from 'fs';
import path from 'path';
import {
  ASSESSMENT_KEY_PREFIX,
  LEGACY_ASSESSMENT_KEY_PREFIX,
  LEDGER_KEY_PREFIX,
  FLEET_KEY_PREFIX,
  stripFailingAssetsForCache,
  stripImplementationNotesForCache,
  stripObjectiveNarrativesForCache,
  stripEvidenceIndexForCache,
  stripTenantRegistryForCache,
  planLocalAssetCleanup,
  scrubAssessmentJson,
  computeNotesStatus,
  runBrowserStorageScrub,
} from '../src/services/browserStorageScrub';
import { StorageService } from '../src/services/storageService';
import { redactLedgerNotesExcerpts, recordAuditEvent, verifyAuditChain, loadLedger, describeNotesForLedger, describeAddressForLedger } from '../src/data/audit/auditLogger';
import { ingestAccretionDiscoveryPayload } from '../src/data/telemetry/assetRegistry';
import { ingestScapScanReport, generateSimulatedScanReport } from '../src/data/telemetry/scapIngestEngine';
import {
  ingestScanReportToAsset,
  getEnclaveFleet,
  saveEnclaveFleet,
  aggregateAssetTelemetry,
  remediateAssetRule,
  clearEnclaveFleet,
  fleetStorageMode,
} from '../src/data/telemetry/assetTelemetryEngine';
import type { AssessmentState } from '../src/types/cmmc';
import type { AuditLogEntry } from '../src/types/audit';
import type { Tenant } from '../src/types/tenant';

let passed = 0;
let total = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  total++;
  if (cond) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.log(`  ✗ FAIL: ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

class MemoryStorage {
  private map = new Map<string, string>();
  setCalls: string[] = [];
  throwOnGet: string | null = null;
  get length() { return this.map.size; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string) {
    if (this.throwOnGet === k) throw new Error('boom');
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) { this.setCalls.push(k); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const MARKER = 'CUI-MARKER-91';

// storageService and the ledger use the global localStorage / window.localStorage
const globalStore = new MemoryStorage();
(globalThis as any).localStorage = globalStore;
(globalThis as any).window = { localStorage: globalStore };

function makeState(tenantId: string, notes: string): AssessmentState {
  return {
    version: '2.0.0',
    tenantId,
    sspMetadata: { tenantId, systemName: 's', organizationName: 'o', cageCode: '', samStatus: 'NOT_REGISTERED', systemOwner: '', authorName: '', assessmentDate: '2026-01-01', systemBoundaryScope: '', systemEnvironment: '', cloudServiceProviders: '', version: '1.0.0', lastUpdated: '2026-01-01' } as any,
    controls: {
      'AC.L1-3.1.1': { id: 'AC.L1-3.1.1', tenantId, status: 'IMPLEMENTED', implementationNotes: notes, responsibleRole: 'r', lastUpdated: 'x', tags: [] } as any,
      'AC.L1-3.1.2': { id: 'AC.L1-3.1.2', tenantId, status: 'NOT_STARTED', implementationNotes: notes, responsibleRole: 'r', lastUpdated: 'x', tags: [] } as any,
    },
    evidenceIndex: [],
    lastSaved: 'x',
  };
}

function makeTenant(id: string, serverBacked: boolean): Tenant {
  return { id, name: id, serverBacked, primaryFramework: 'CMMC_L1' } as unknown as Tenant;
}

async function main() {
  console.log('\n--- Cache helpers ---');

  // S1
  const src = makeState('t1', `notes ${MARKER}`);
  const stripped = stripImplementationNotesForCache(src);
  assert(
    Object.values(stripped.controls).every((c) => !('implementationNotes' in c)) && src.controls['AC.L1-3.1.1'].implementationNotes === `notes ${MARKER}`,
    'S1 strip removes notes from every control and never mutates its input'
  );

  // S2 / S3 / S4
  const sTenant = makeTenant('srv-a', true);
  const bTenant = makeTenant('brw-a', false);
  globalStore.clear();
  StorageService.saveAssessment('srv-a', makeState('srv-a', `notes ${MARKER}`));
  assert(!globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'srv-a')!.includes(MARKER), 'S2 saveAssessment strips notes from the stored JSON');
  StorageService.saveAssessment('brw-a', makeState('brw-a', `notes ${MARKER}`), { keepNotes: true });
  assert(globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'brw-a')!.includes(MARKER), 'S3 keepNotes keeps the notes');
  const loadedSrv = StorageService.loadAssessment(sTenant);
  assert(Object.values(loadedSrv.controls).filter((c) => c.id.startsWith('AC.L1')).every((c) => c.implementationNotes === ''), 'S4a loadAssessment gives server-backed tenants empty notes');
  // even a legacy cache that still holds notes must not surface them for a server-backed tenant
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 'srv-a', JSON.stringify(makeState('srv-a', `legacy ${MARKER}`)));
  const loadedLegacy = StorageService.loadAssessment(sTenant);
  assert(loadedLegacy.controls['AC.L1-3.1.1'].implementationNotes === '', 'S4b a legacy cached note is not surfaced for a server-backed tenant');
  const loadedBrw = StorageService.loadAssessment(bTenant);
  assert(loadedBrw.controls['AC.L1-3.1.1'].implementationNotes === `notes ${MARKER}`, 'S4c loadAssessment keeps notes for a browser-only tenant');

  console.log('\n--- scrubAssessmentJson ---');
  // S5
  const rawWith = JSON.stringify(makeState('t', `x ${MARKER}`));
  const sc = scrubAssessmentJson(rawWith);
  assert(sc.changed && sc.strippedControls === 2 && sc.json !== null && !sc.json.includes(MARKER), 'S5a scrub changes JSON that holds notes');
  const again = scrubAssessmentJson(sc.json!);
  assert(!again.changed && again.json === sc.json && again.strippedControls === 0, 'S5b scrub is idempotent and returns the same string when unchanged');

  // S6
  let threw = false;
  const bad: string[] = ['', 'not json', 'null', '[]', '"x"', '{}', '{"controls":5}', '{"controls":{"a":null,"b":3}}'];
  const outs: ReturnType<typeof scrubAssessmentJson>[] = [];
  try { for (const b of bad) outs.push(scrubAssessmentJson(b)); } catch { threw = true; }
  assert(!threw && outs.slice(0, 7).every((o) => o.malformed === true && o.json === null && !o.changed), 'S6a malformed inputs never throw and are flagged malformed');
  assert(outs[7].changed === false && outs[7].json === bad[7], 'S6b controls that are not objects are left as they are');

  console.log('\n--- runBrowserStorageScrub ---');
  // S7
  const st = new MemoryStorage();
  st.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'srv2', serverBacked: true }, { id: 'brw1' }]));
  st.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(makeState('srv1', `a ${MARKER}`)));
  st.setItem(ASSESSMENT_KEY_PREFIX + 'srv2', JSON.stringify(makeState('srv2', `b ${MARKER}`)));
  st.setItem(LEGACY_ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(makeState('srv1', `c ${MARKER}`)));
  st.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', JSON.stringify(makeState('brw1', `d ${MARKER}`)));
  st.setItem('pbc_unrelated', `unrelated ${MARKER}`);
  st.setCalls.length = 0;
  const logs: string[] = [];
  const r1 = await runBrowserStorageScrub(st, (m) => logs.push(m));
  assert(r1.scrubbed === 3 && r1.keptBrowserOnly === 1 && r1.malformed === 0 && r1.failed === 0 && !r1.registryUnreadable, 'S7a first run: scrubbed 3, keptBrowserOnly 1', r1);
  assert(st.setCalls.length === 3, 'S7b exactly three writes', st.setCalls);
  assert(st.getItem('pbc_unrelated') === `unrelated ${MARKER}`, 'S7c an unrelated key is untouched');
  assert(
    ![ASSESSMENT_KEY_PREFIX + 'srv1', ASSESSMENT_KEY_PREFIX + 'srv2', LEGACY_ASSESSMENT_KEY_PREFIX + 'srv1'].some((k) => st.getItem(k)!.includes(MARKER)) &&
      st.getItem(ASSESSMENT_KEY_PREFIX + 'brw1')!.includes(MARKER),
    'S7d no marker left for server-backed keys; the browser-only key keeps its notes'
  );
  // S8
  st.setCalls.length = 0;
  const r2 = await runBrowserStorageScrub(st, () => undefined);
  assert(r2.scrubbed === 0 && st.setCalls.length === 0 && r2.keptBrowserOnly === 1, 'S8 second run is a no-op (no writes)', r2);

  // S9
  const st2 = new MemoryStorage();
  st2.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }]));
  st2.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', 'not json {');
  st2.setItem(ASSESSMENT_KEY_PREFIX + 'srv9', JSON.stringify(makeState('srv9', `z ${MARKER}`)));
  const r3 = await runBrowserStorageScrub(st2, () => undefined);
  assert(r3.malformed === 1 && r3.scrubbed === 1 && st2.getItem(ASSESSMENT_KEY_PREFIX + 'srv1') === 'not json {', 'S9a a malformed value is counted and left, no throw', r3);
  const st3 = new MemoryStorage();
  st3.setItem('pbc_live_tenants_v4', 'garbage');
  st3.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(makeState('srv1', `z ${MARKER}`)));
  st3.setCalls.length = 0;
  const r4 = await runBrowserStorageScrub(st3, () => undefined);
  assert(r4.registryUnreadable && r4.scrubbed === 0 && st3.setCalls.length === 0 && st3.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!.includes(MARKER), 'S9b an unreadable registry scrubs no assessment key', r4);
  const st3b = new MemoryStorage();
  st3b.setItem('pbc_live_tenants_v4', 'garbage');
  st3b.setItem('pbc_tenants_registry_v3', JSON.stringify([{ id: 'srv1', serverBacked: true }]));
  st3b.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(makeState('srv1', `z ${MARKER}`)));
  const r4b = await runBrowserStorageScrub(st3b, () => undefined);
  assert(!r4b.registryUnreadable && r4b.scrubbed === 1, 'S9c the v3 registry is used when v4 is unreadable', r4b);

  // S10
  const st4 = new MemoryStorage();
  st4.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }]));
  st4.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(makeState('srv1', `z ${MARKER}`)));
  st4.throwOnGet = ASSESSMENT_KEY_PREFIX + 'srv1';
  let threw2 = false;
  let r5: Awaited<ReturnType<typeof runBrowserStorageScrub>> | undefined;
  try { r5 = await runBrowserStorageScrub(st4, () => undefined); } catch { threw2 = true; }
  assert(!threw2 && !!r5 && r5.failed >= 1, 'S10 a throwing getItem is counted as failed, never thrown', r5);

  // S11
  const st5 = new MemoryStorage();
  st5.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'secret-tenant-id-77', serverBacked: true }]));
  st5.setItem(ASSESSMENT_KEY_PREFIX + 'secret-tenant-id-77', JSON.stringify(makeState('secret-tenant-id-77', `z ${MARKER}`)));
  const logs2: string[] = [];
  await runBrowserStorageScrub(st5, (m) => logs2.push(m));
  assert(logs2.length === 1 && !logs2[0].includes('secret-tenant-id-77') && !logs2[0].includes(MARKER) && /scrubbed 1/.test(logs2[0]), 'S11a one log line with counts only', logs2);
  const logs3: string[] = [];
  await runBrowserStorageScrub(st5, (m) => logs3.push(m));
  assert(logs3.length === 0, 'S11b nothing changed means no log line', logs3);

  // S14: a program cache of a server-backed tenant is scrubbed like the tenant cache; a browser-only tenant's is kept
  const st8 = new MemoryStorage();
  st8.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'brw1' }]));
  st8.setItem(ASSESSMENT_KEY_PREFIX + 'srv1::p2', JSON.stringify(makeState('srv1', `z ${MARKER}`)));
  st8.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', JSON.stringify(makeState('brw1', `z ${MARKER}`)));
  const r8 = await runBrowserStorageScrub(st8, () => undefined);
  assert(r8.scrubbed === 1 && r8.keptBrowserOnly === 1, 'S14a the program cache of a server-backed tenant is scrubbed, the browser-only tenant is kept', r8);
  assert(!st8.getItem(ASSESSMENT_KEY_PREFIX + 'srv1::p2')!.includes(MARKER) && st8.getItem(ASSESSMENT_KEY_PREFIX + 'brw1')!.includes(MARKER), 'S14b srv1::p2 holds no marker, brw1 keeps it');

  // S15: a program save goes to the program's key, strips the notes, and leaves the legacy key alone
  globalStore.clear();
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 't1', 'legacy-untouched');
  StorageService.saveAssessment('t1', makeState('t1', MARKER), { segment: 'p2' });
  const p2Raw = globalStore.getItem(ASSESSMENT_KEY_PREFIX + 't1::p2');
  assert(p2Raw !== null && !p2Raw.includes(MARKER), 'S15a saveAssessment with a segment writes <key>::p2 without the notes');
  assert(globalStore.getItem(ASSESSMENT_KEY_PREFIX + 't1') === 'legacy-untouched', 'S15b the legacy key is untouched by a program save');

  console.log('\n--- Objective narratives ---');
  const NARR = 'CUI-NARRATIVE-123';
  const withObjectives = (tenantId: string, migratedAt?: string, pending?: string[]): AssessmentState => ({
    ...makeState(tenantId, ''),
    objectives: {
      'obj-1': { objectiveId: 'obj-1', status: 'MET', implementationNarrative: `n1 ${NARR}`, linkedEvidenceIds: ['ev-1'], updatedBy: 'a@x.com', lastUpdated: '2026-01-02' } as any,
      'obj-2': { objectiveId: 'obj-2', status: 'NOT_MET', implementationNarrative: `n2 ${NARR}`, linkedEvidenceIds: [], updatedBy: 'b@x.com', lastUpdated: '2026-01-03' } as any,
    },
    ...(migratedAt ? { objectivesMigratedAt: migratedAt } : {}),
    ...(pending ? { objectivesPendingReview: pending } : {}),
  });
  const reg = JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'brw1' }]);

  // O1 (a): no marker keeps the narratives, in the scrub and in saveAssessment
  const so1 = new MemoryStorage();
  so1.setItem('pbc_live_tenants_v4', reg);
  so1.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(withObjectives('srv1')));
  const ro1 = await runBrowserStorageScrub(so1, () => undefined);
  assert(ro1.narrativesRemoved === 0 && so1.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!.includes(NARR), 'O1a start-up scrub keeps narratives when objectivesMigratedAt is not set', ro1);
  globalStore.clear();
  StorageService.saveAssessment('srv1', withObjectives('srv1'));
  assert(globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!.includes(NARR), 'O1b saveAssessment keeps narratives when objectivesMigratedAt is not set');
  const unmarked = withObjectives('srv1');
  assert(stripObjectiveNarrativesForCache(unmarked) === unmarked, 'O1c the strip helper returns the same state without the marker');

  // O2 (b): marker removes narratives, keeps the other fields
  const so2 = new MemoryStorage();
  so2.setItem('pbc_live_tenants_v4', reg);
  so2.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(withObjectives('srv1', '2026-02-01T00:00:00Z')));
  const ro2 = await runBrowserStorageScrub(so2, () => undefined);
  const stored2 = JSON.parse(so2.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!) as AssessmentState;
  const o2 = stored2.objectives!['obj-1'] as any;
  assert(ro2.narrativesRemoved === 2 && ro2.scrubbed === 1 && !JSON.stringify(stored2).includes(NARR), 'O2a the marker makes the start-up scrub remove every narrative (counted)', ro2);
  assert(o2.status === 'MET' && o2.linkedEvidenceIds[0] === 'ev-1' && o2.updatedBy === 'a@x.com' && o2.lastUpdated === '2026-01-02' && !('implementationNarrative' in o2) && stored2.objectivesMigratedAt === '2026-02-01T00:00:00Z', 'O2b status, linkedEvidenceIds, updatedBy, lastUpdated and the marker are kept');
  const pure = withObjectives('srv1', '2026-02-01T00:00:00Z');
  const pureOut = stripObjectiveNarrativesForCache(pure);
  assert(!JSON.stringify(pureOut).includes(NARR) && (pure.objectives!['obj-1'] as any).implementationNarrative === `n1 ${NARR}`, 'O2c the strip helper removes narratives and never mutates its input');

  // O3 (c): a pending-review id keeps its narrative
  const so3 = new MemoryStorage();
  so3.setItem('pbc_live_tenants_v4', reg);
  so3.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(withObjectives('srv1', '2026-02-01T00:00:00Z', ['obj-2'])));
  const ro3 = await runBrowserStorageScrub(so3, () => undefined);
  const stored3 = JSON.parse(so3.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!) as AssessmentState;
  assert(ro3.narrativesRemoved === 1 && !('implementationNarrative' in (stored3.objectives!['obj-1'] as any)) && (stored3.objectives!['obj-2'] as any).implementationNarrative === `n2 ${NARR}`, 'O3a the scrub keeps the narrative of a pending-review id', ro3);
  const pend = stripObjectiveNarrativesForCache(withObjectives('srv1', '2026-02-01T00:00:00Z', ['obj-2']));
  assert((pend.objectives!['obj-2'] as any).implementationNarrative === `n2 ${NARR}` && !('implementationNarrative' in (pend.objectives!['obj-1'] as any)), 'O3b the strip helper keeps the narrative of a pending-review id');

  // O4 (d): a browser-only tenant is never stripped
  const so4 = new MemoryStorage();
  so4.setItem('pbc_live_tenants_v4', reg);
  const brwRaw = JSON.stringify(withObjectives('brw1', '2026-02-01T00:00:00Z'));
  so4.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', brwRaw);
  so4.setCalls.length = 0;
  const ro4 = await runBrowserStorageScrub(so4, () => undefined);
  assert(ro4.keptBrowserOnly === 1 && ro4.narrativesRemoved === 0 && so4.setCalls.length === 0 && so4.getItem(ASSESSMENT_KEY_PREFIX + 'brw1') === brwRaw, 'O4 a browser-only tenant with the marker is untouched', ro4);

  // O5 (e): idempotent
  so2.setCalls.length = 0;
  const ro5 = await runBrowserStorageScrub(so2, () => undefined);
  assert(ro5.scrubbed === 0 && ro5.narrativesRemoved === 0 && so2.setCalls.length === 0, 'O5a a second scrub run changes nothing', ro5);
  assert(JSON.stringify(stripObjectiveNarrativesForCache(pureOut)) === JSON.stringify(pureOut), 'O5b the strip helper is idempotent');

  // O6 (f): saveAssessment of a server-backed tenant with the marker stores no narrative text
  globalStore.clear();
  StorageService.saveAssessment('srv1', withObjectives('srv1', '2026-02-01T00:00:00Z'));
  const savedRaw = globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!;
  const savedObj = (JSON.parse(savedRaw) as AssessmentState).objectives!['obj-1'] as any;
  assert(!savedRaw.includes(NARR) && !savedRaw.includes('implementationNarrative') && savedObj.status === 'MET' && savedObj.linkedEvidenceIds[0] === 'ev-1', 'O6 saveAssessment with the marker stores no narrative but keeps the other objective fields');

  console.log('\n--- Static checks ---');
  const root = process.cwd();
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const ssSource = fs.readFileSync(path.join(root, 'src/services/storageService.ts'), 'utf8');
  const setItems = ssSource.match(/localStorage\.setItem\(/g) || [];
  const saveBody = ssSource.slice(ssSource.indexOf('saveAssessment('));
  const callIdx = saveBody.indexOf('localStorage.setItem(');
  assert(setItems.length === 1 && saveBody.slice(0, callIdx).includes('stripImplementationNotesForCache('), 'S12 storageService has exactly one localStorage.setItem and the strip helper runs before it');

  const writers = walk(path.join(root, 'src'))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /\.setItem\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f).replace(/\\/g, '/'))
    .sort();
  const allowed = [
    'src/context/AuthContext.tsx',
    'src/context/TenantContext.tsx',
    'src/data/audit/auditLogger.ts',
    'src/data/storage/offboardingEngine.ts',
    'src/data/storage/retentionPolicy.ts',
    'src/data/telemetry/assetRegistry.ts',
    'src/data/telemetry/assetTelemetryEngine.ts',
    'src/services/browserStorageScrub.ts',
    'src/services/failedMoves.ts',
    'src/services/legacySessionScrub.ts', // writes the stored user records back with the legacy session JWT removed (#43)
    'src/services/storageService.ts',
  ].sort();
  assert(JSON.stringify(writers) === JSON.stringify(allowed), 'S13 the set of src files that write browser storage equals the reviewed allow-list', writers);

  console.log('\n--- Evidence index (server tenants never cache it) ---');
  const EVMARK = 'CUI-FILE-55';
  const withEvidence = (tenantId: string): AssessmentState => ({
    ...makeState(tenantId, ''),
    evidenceIndex: [
      { id: 'ev-1', tenantId, fileName: `a-${EVMARK}.pdf` } as any,
      { id: 'ev-2', tenantId, fileName: `b-${EVMARK}.pdf` } as any,
    ],
  });
  globalStore.clear();
  StorageService.saveAssessment('srv1', withEvidence('srv1'));
  const e1Raw = globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!;
  assert((JSON.parse(e1Raw) as AssessmentState).evidenceIndex.length === 0 && !e1Raw.includes(EVMARK), 'E1 saveAssessment for a server tenant stores no evidence index');
  globalStore.clear();
  StorageService.saveAssessment('brw1', withEvidence('brw1'), { keepNotes: true });
  const e2Raw = globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'brw1')!;
  assert((JSON.parse(e2Raw) as AssessmentState).evidenceIndex.length === 2 && e2Raw.includes(EVMARK), 'E2 keepNotes keeps the evidence index');
  const evSrc = withEvidence('srv1');
  assert(stripEvidenceIndexForCache(evSrc).evidenceIndex.length === 0 && evSrc.evidenceIndex.length === 2, 'E2b the strip helper never mutates its input');
  globalStore.clear();
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(withEvidence('srv1')));
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', JSON.stringify(withEvidence('brw1')));
  assert(StorageService.loadAssessment(makeTenant('srv1', true)).evidenceIndex.length === 0, 'E3a loadAssessment blanks a cached evidence index for a server tenant');
  assert(StorageService.loadAssessment(makeTenant('brw1', false)).evidenceIndex.length === 2, 'E3b loadAssessment keeps it for a browser-only tenant');

  const stE = new MemoryStorage();
  stE.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'brw1' }]));
  stE.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(withEvidence('srv1')));
  const brwEvRaw = JSON.stringify(withEvidence('brw1'));
  stE.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', brwEvRaw);
  const logsE: string[] = [];
  const rE4 = await runBrowserStorageScrub(stE, (m) => logsE.push(m));
  assert(
    rE4.evidenceItemsCleared === 2 && rE4.keptBrowserOnly === 1 && (JSON.parse(stE.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!) as AssessmentState).evidenceIndex.length === 0 && stE.getItem(ASSESSMENT_KEY_PREFIX + 'brw1') === brwEvRaw,
    'E4 start-up scrub clears the server tenant evidence index and leaves the browser-only one',
    rE4
  );
  stE.setCalls.length = 0;
  const rE5 = await runBrowserStorageScrub(stE, () => undefined);
  assert(rE5.evidenceItemsCleared === 0 && stE.setCalls.length === 0, 'E5 a second run writes nothing', rE5);
  assert(logsE.length === 1 && !logsE[0].includes('srv1') && !logsE[0].includes(EVMARK), 'E6 the log line holds no tenant id and no file name', logsE);

  const stE7 = new MemoryStorage();
  stE7.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }]));
  stE7.setItem(ASSESSMENT_KEY_PREFIX + 'srv1::prog2', JSON.stringify(withEvidence('srv1')));
  stE7.setItem(ASSESSMENT_KEY_PREFIX + 'orphan9', JSON.stringify(withEvidence('orphan9')));
  const rE7 = await runBrowserStorageScrub(stE7, () => undefined);
  assert(
    rE7.evidenceItemsCleared === 2 &&
      (JSON.parse(stE7.getItem(ASSESSMENT_KEY_PREFIX + 'srv1::prog2')!) as AssessmentState).evidenceIndex.length === 0 &&
      (JSON.parse(stE7.getItem(ASSESSMENT_KEY_PREFIX + 'orphan9')!) as AssessmentState).evidenceIndex.length === 2,
    'E7 a server program cache loses its evidence index; an unregistered id (failed-move leftover) keeps it',
    rE7
  );

  console.log('\n--- Asset cache and discovery keys ---');
  const NOTE7 = 'CUI-NOTE-7';
  const realAssets = JSON.stringify([{ id: 'a-1', hostName: 'WS-01', macAddress: '', notes: NOTE7 }]);
  const demoOnly = JSON.stringify([{ id: 'asset-ws-01-srv2' }, { id: 'asset-srv-02-srv2' }]);
  const stA = new MemoryStorage();
  stA.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'srv2', serverBacked: true }, { id: 'srv3', serverBacked: true }, { id: 'brw1' }]));
  stA.setItem('pbc_enclave_assets_v1_srv1', '[]');
  stA.setItem('pbc_enclave_assets_v1_srv2', demoOnly);
  stA.setItem('pbc_enclave_assets_v1_srv3', realAssets);
  stA.setItem('pbc_enclave_assets_v1_brw1', realAssets);
  stA.setItem('pbc_enclave_assets_v1_orphan9', realAssets);
  const logsA: string[] = [];
  const rA1 = await runBrowserStorageScrub(stA, (m) => logsA.push(m));
  assert(
    rA1.assetListsRemoved === 2 && rA1.assetListsKept === 1 && stA.getItem('pbc_enclave_assets_v1_srv1') === null && stA.getItem('pbc_enclave_assets_v1_srv2') === null &&
      stA.getItem('pbc_enclave_assets_v1_srv3') === realAssets && stA.getItem('pbc_enclave_assets_v1_brw1') === realAssets && stA.getItem('pbc_enclave_assets_v1_orphan9') === realAssets,
    'A1 empty and demo-only lists of server tenants go; real lists, browser-only and unregistered lists stay',
    rA1
  );
  const rA2 = await runBrowserStorageScrub(stA, () => undefined);
  assert(rA2.assetListsRemoved === 0 && rA2.accretionKeysRemoved === 0, 'A2 a second run removes nothing', rA2);
  const stA3 = new MemoryStorage();
  stA3.setItem('pbc_live_tenants_v4', 'garbage');
  stA3.setItem('pbc_enclave_assets_v1_srv1', '[]');
  const rA3 = await runBrowserStorageScrub(stA3, () => undefined);
  assert(rA3.registryUnreadable && rA3.assetListsRemoved === 0 && stA3.getItem('pbc_enclave_assets_v1_srv1') === '[]', 'A3 an unreadable registry removes no asset list', rA3);
  const stA4 = new MemoryStorage();
  stA4.setItem('pbc_live_tenants_v4', 'garbage');
  stA4.setItem('pbc_accretion_cfg_v1_srv1', '{"secret":"x"}');
  stA4.setItem('pbc_accretion_cfg_v1_brw1', '{"secret":"y"}');
  stA4.setItem('pbc_unrelated', 'keep');
  const rA4 = await runBrowserStorageScrub(stA4, () => undefined);
  assert(rA4.accretionKeysRemoved === 2 && stA4.getItem('pbc_accretion_cfg_v1_srv1') === null && stA4.getItem('pbc_accretion_cfg_v1_brw1') === null && stA4.getItem('pbc_unrelated') === 'keep', 'A4 discovery settings keys are removed even with an unreadable registry', rA4);
  const rA4b = await runBrowserStorageScrub(stA4, () => undefined);
  assert(rA4b.accretionKeysRemoved === 0, 'A4b a second run removes nothing', rA4b);
  assert(logsA.length === 1 && !/srv\d|brw1|orphan9/.test(logsA[0]) && !logsA[0].includes(NOTE7), 'A5 the log line holds no tenant id and no note', logsA);

  console.log('\n--- planLocalAssetCleanup ---');
  const mkAsset = (id: string, hostName: string, macAddress = ''): any => ({ id, hostName, macAddress });
  assert(planLocalAssetCleanup([mkAsset('a', '  WS-01 ')], [mkAsset('s', 'ws-01')], 't1').removable, 'P1 host names match trimmed and case-insensitive');
  assert(planLocalAssetCleanup([mkAsset('a', 'x', 'AA:BB:CC:00:11:22')], [mkAsset('s', 'y', 'aa-bb-cc-00-11-22')], 't1').removable, 'P2 MACs match across formats');
  const p3 = planLocalAssetCleanup([mkAsset('a', 'A'), mkAsset('b', 'B')], [mkAsset('s', 'A')], 't1');
  assert(!p3.removable && p3.unmatched === 1, 'P3 [A,B] against [A] is not removable, 1 unmatched', p3);
  const p4 = planLocalAssetCleanup([], [], 't1');
  assert(p4.removable && p4.unmatched === 0, 'P4 an empty local list is removable', p4);
  assert(planLocalAssetCleanup([mkAsset('asset-ws-01-t1', 'D')], [], 't1').removable, 'P5 a demo-only list is removable against an empty server list');
  const p6 = planLocalAssetCleanup([mkAsset('a', 'A', '00:00:00:00:00:00')], [mkAsset('s', 'B', '00:00:00:00:00:00')], 't1');
  assert(!p6.removable && p6.unmatched === 1, 'P6 all-zero MACs never match', p6);

  const readSrc = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  assert(readSrc('src/context/AssessmentContext.tsx').includes('useLocalAssetScrub()'), 'P7 AssessmentContext mounts useLocalAssetScrub()');
  const hookSrc = readSrc('src/hooks/useLocalAssetScrub.ts');
  assert(hookSrc.includes('serverBacked') && hookSrc.includes('planLocalAssetCleanup(') && hookSrc.includes('clearLocalEnclaveAssets('), 'P8 the hook is gated on serverBacked, plans, and clears the list');

  console.log('\n--- Tenant registry text ---');
  const regInput = [
    { id: 's1', serverBacked: true, name: 'Acme', cageCode: 'CAGE1', samStatus: 'ACTIVE', systemName: 'SYS-MARK', systemOwner: 'OWNER-MARK', industry: 'IND-MARK', systemBoundaryScope: 'B', domain: 'acme.test', isConfigured: true, primaryFramework: 'CMMC_L1' },
    { id: 'b1', systemName: 'SYS-MARK' },
  ];
  const regBefore = JSON.stringify(regInput);
  const regOut = stripTenantRegistryForCache(regInput as any[]);
  assert(
    regOut[0].systemName === '' && regOut[0].systemOwner === '' && regOut[0].industry === '' && regOut[0].name === 'Acme' && regOut[0].cageCode === 'CAGE1' && regOut[0].samStatus === 'ACTIVE' &&
      regOut[0].systemBoundaryScope === 'B' && regOut[0].domain === 'acme.test' && regOut[0].isConfigured === true && regOut[0].primaryFramework === 'CMMC_L1' && regOut[1].systemName === 'SYS-MARK',
    'R1 a server entry loses its three text fields only; a browser-only entry is untouched'
  );
  assert(JSON.stringify(regInput) === regBefore, 'R1b the input is not mutated');
  assert(JSON.stringify(stripTenantRegistryForCache(regOut)) === JSON.stringify(regOut), 'R2 stripping is idempotent');
  const stR = new MemoryStorage();
  stR.setItem('pbc_live_tenants_v4', regBefore);
  stR.setItem(ASSESSMENT_KEY_PREFIX + 's1', JSON.stringify(makeState('s1', `n ${MARKER}`)));
  const rR3 = await runBrowserStorageScrub(stR, () => undefined);
  const storedReg = JSON.parse(stR.getItem('pbc_live_tenants_v4')!);
  assert(rR3.registryEntriesStripped === 1 && storedReg[0].systemName === '' && storedReg[0].name === 'Acme' && storedReg[1].systemName === 'SYS-MARK', 'R3 the start-up scrub writes the stripped registry', rR3);
  assert(rR3.scrubbed === 1 && !stR.getItem(ASSESSMENT_KEY_PREFIX + 's1')!.includes(MARKER), 'R4 the same run still scrubs a server assessment notes', rR3);
  stR.setCalls.length = 0;
  const rR3b = await runBrowserStorageScrub(stR, () => undefined);
  assert(rR3b.registryEntriesStripped === 0 && stR.setCalls.length === 0, 'R3b a second run does not write the registry', rR3b);
  const tcLine = readSrc('src/context/TenantContext.tsx').split(/\r?\n/).find((l) => l.includes('localStorage.setItem(LIVE_TENANTS_STORAGE_KEY')) || '';
  assert(tcLine.includes('stripTenantRegistryForCache('), 'R5 TenantContext writes the stripped registry', tcLine);

  console.log('\n--- computeNotesStatus ---');
  const base = { serverBacked: true, liveControlsTenantId: null as string | null, tenantId: 't', syncError: null as string | null, hasToken: true };
  assert(computeNotesStatus({ ...base, serverBacked: false }) === 'browser', 'N1 not server-backed is browser');
  assert(computeNotesStatus({ ...base, liveControlsTenantId: 't' }) === 'loaded', 'N2 controls loaded for this tenant is loaded');
  assert(computeNotesStatus({ ...base, liveControlsTenantId: 'other' }) === 'loading', 'N3 controls of another tenant, no error, is loading');
  assert(computeNotesStatus({ ...base, syncError: 'offline' }) === 'unavailable', 'N4 a sync error is unavailable');
  assert(computeNotesStatus({ ...base, hasToken: false }) === 'unavailable', 'N5 no token is unavailable');
  assert(computeNotesStatus({ ...base, liveControlsTenantId: 't1::pA', tenantId: 't1::pB' }) === 'loading', 'N6 controls loaded for program A are not loaded for program B of the same tenant');
  assert(computeNotesStatus({ ...base, liveControlsTenantId: 't1::pB', tenantId: 't1::pB' }) === 'loaded', 'N7 controls loaded for the program on screen are loaded');

  console.log('\n--- Ledger redaction ---');
  const hex64 = 'a'.repeat(64);
  const mk = async (tid: string): Promise<AuditLogEntry[]> => {
    globalStore.clear();
    await recordAuditEvent({ tenantId: tid, actorEmail: 'a@x.com', actionType: 'CONTROL_STATUS_UPDATED', targetEntity: 'c1', previousState: 'NOT_STARTED', newState: 'IMPLEMENTED' });
    await recordAuditEvent({ tenantId: tid, actorEmail: 'a@x.com', actionType: 'CONTROL_NOTES_UPDATED', targetEntity: 'c1', previousState: '', newState: `Our MFA policy ${MARKER}` });
    await recordAuditEvent({ tenantId: tid, actorEmail: 'a@x.com', actionType: 'CONTROL_NOTES_UPDATED', targetEntity: 'c1', previousState: `sha256:${hex64} (12 chars)`, newState: '(12 chars)' });
    await recordAuditEvent({ tenantId: tid, actorEmail: 'a@x.com', actionType: 'CONTROL_STATUS_UPDATED', targetEntity: 'c2', previousState: 'NOT_STARTED', newState: 'PARTIAL' });
    return [...loadLedger(tid)];
  };
  const chain = await mk('L1');
  const okBefore = (await verifyAuditChain(chain)).isValid;
  const oldHead = chain[chain.length - 1].sha256Hash;
  const before = JSON.stringify(chain);
  const red = await redactLedgerNotesExcerpts(chain);
  assert(okBefore && red.redacted === 1 && JSON.stringify(chain) === before, 'L1 an excerpt is redacted (1 field) and the input is not mutated', red.redacted);
  assert(!JSON.stringify(red.entries[1]).includes(MARKER) && !JSON.stringify(red.entries).includes('MFA policy'), 'L2 the redacted entry holds no excerpt');
  assert(red.entries[2].previousState === `sha256:${hex64} (12 chars)` && red.entries[2].newState === '(12 chars)', 'L3 digest-and-length and length-only descriptors are kept');
  assert(red.entries[0].newState === 'IMPLEMENTED' && red.entries[3].previousState === 'NOT_STARTED' && red.entries[0].sha256Hash === chain[0].sha256Hash, 'L4 other action types and entries before the first redaction are untouched');
  const v = await verifyAuditChain(red.entries);
  const lastEntry = red.entries[red.entries.length - 1];
  assert(v.isValid === true && red.entries.length === 5, 'L5 the chain verifies after re-chaining and has 5 entries', v);
  assert(lastEntry.actionType === ('LEDGER_REDACTED' as any) && lastEntry.previousState === oldHead && lastEntry.actorEmail === 'system' && lastEntry.targetEntity === 'audit-ledger' && /redacted 1 notes excerpt/.test(String(lastEntry.newState)), 'L6 the last entry is LEDGER_REDACTED carrying the old head hash');
  const red2 = await redactLedgerNotesExcerpts(red.entries);
  assert(red2.redacted === 0 && red2.entries === red.entries && JSON.stringify(red2.entries) === JSON.stringify(red.entries), 'L7 redacting twice is a no-op');
  const noOp = await redactLedgerNotesExcerpts([chain[0], chain[3]]);
  assert(noOp.redacted === 0, 'L8 only CONTROL_NOTES_UPDATED entries are inspected');

  // malformed ledger JSON in storage
  const st6 = new MemoryStorage();
  st6.setItem(LEDGER_KEY_PREFIX + 'bad', '{{{ not json');
  st6.setItem(LEDGER_KEY_PREFIX + 'notarray', '{"a":1}');
  st6.setItem('pbc_live_tenants_v4', '[]');
  st6.setCalls.length = 0;
  let threw3 = false;
  let r6: Awaited<ReturnType<typeof runBrowserStorageScrub>> | undefined;
  try { r6 = await runBrowserStorageScrub(st6, () => undefined); } catch { threw3 = true; }
  assert(!threw3 && !!r6 && r6.malformed === 2 && st6.getItem(LEDGER_KEY_PREFIX + 'bad') === '{{{ not json' && st6.setCalls.length === 0, 'L9 malformed ledger JSON is counted, left unchanged, never thrown', r6);

  // storage scenario with a ledger holding an excerpt (registry unreadable: ledgers are still redacted)
  const st7 = new MemoryStorage();
  const withExcerpt = await mk('L2');
  st7.setItem(LEDGER_KEY_PREFIX + 'L1', JSON.stringify(withExcerpt));
  assert(JSON.stringify(withExcerpt).includes(MARKER), 'L10a the fixture ledger holds the marker');
  const r7 = await runBrowserStorageScrub(st7, () => undefined);
  const storedLedger = JSON.parse(st7.getItem(LEDGER_KEY_PREFIX + 'L1')!) as AuditLogEntry[];
  assert(r7.ledgersRedacted === 1 && r7.ledgerEntriesRedacted === 1 && r7.registryUnreadable && !st7.getItem(LEDGER_KEY_PREFIX + 'L1')!.includes(MARKER), 'L10b the stored ledger is redacted and holds no marker', r7);
  assert((await verifyAuditChain(storedLedger)).isValid, 'L10c the stored ledger verifies');
  const st7Again = await runBrowserStorageScrub(st7, () => undefined);
  assert(st7Again.ledgersRedacted === 0 && st7.setCalls.length === 2, 'L10d a second run leaves the ledger alone', st7Again);

  console.log('\n--- Identifier redaction ---');
  const IP = '10.91.0.1';
  const MAC = '00:91:00:00:00:01';
  const HOST = 'HOST-MARK-91';
  const mkIdent = async (tid: string): Promise<AuditLogEntry[]> => {
    globalStore.clear();
    const base = { tenantId: tid, actorEmail: 'a@x.com' };
    await recordAuditEvent({ ...base, actionType: 'CONTROL_STATUS_UPDATED', targetEntity: 'c1', previousState: 'NOT_STARTED', newState: 'IMPLEMENTED' });
    await recordAuditEvent({ ...base, actionType: 'EVIDENCE_UPLOADED', targetEntity: `${MARKER} plan.pdf`, newState: { controlId: 'AC.L1-3.1.1', sha256: hex64, sizeBytes: 5 } });
    await recordAuditEvent({ ...base, actionType: 'TELEMETRY_INGESTED', targetEntity: 'EnclaveAsset:a1', newState: { hostName: HOST, ipAddress: IP, macAddress: MAC, discoveryStatus: 'UNCONFIRMED_DISCOVERY' } });
    await recordAuditEvent({ ...base, actionType: 'EVIDENCE_UPLOADED', targetEntity: 'SCAP Scan: scan_1_abc', newState: { scanId: 'scan_1_abc', hostName: HOST, targetIp: IP, passedCount: 3 } });
    await recordAuditEvent({ ...base, actionType: 'EVIDENCE_UPLOADED', targetEntity: 'ev_1760000000000_ab12c', newState: { controlId: 'c1', sha256: hex64, sizeBytes: 1, fileName: `sha256:${hex64} (12 chars)` } });
    await recordAuditEvent({ ...base, actionType: 'TELEMETRY_INGESTED', targetEntity: 'EnclaveAsset:a2', newState: { hostName: '(7 chars)', ipAddress: '', macAddress: `sha256:${hex64} (17 chars)` } });
    return [...loadLedger(tid)];
  };
  const idChain = await mkIdent('L3');
  const idBefore = JSON.stringify(idChain);
  const idHead = idChain[idChain.length - 1].sha256Hash;
  const idRed = await redactLedgerNotesExcerpts(idChain);
  assert(idRed.redacted === 6 && idRed.identifiers === 6 && idRed.notes === 0 && JSON.stringify(idChain) === idBefore, 'I1 six identifiers are redacted, no notes, input untouched', idRed.redacted);
  const idOut = JSON.stringify(idRed.entries);
  assert(![MARKER, 'plan.pdf', HOST, IP, MAC].some((s) => idOut.includes(s)), 'I2 no file name, host name, IP or MAC is left in the ledger');
  assert(idRed.entries[1].targetEntity === await describeNotesForLedger(`${MARKER} plan.pdf`), 'I3 an evidence target holding a file name becomes its descriptor');
  const s2 = idRed.entries[2].newState as any;
  assert(s2.hostName === await describeNotesForLedger(HOST) && s2.ipAddress === await describeAddressForLedger(IP) && s2.ipAddress === `(${IP.length} chars)` && s2.macAddress === `(${MAC.length} chars)` && s2.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && idRed.entries[2].targetEntity === 'EnclaveAsset:a1', 'I4 asset host name gets a digest descriptor, IP and MAC length only, rest unchanged', s2);
  const s3 = idRed.entries[3].newState as any;
  assert(idRed.entries[3].targetEntity === 'SCAP Scan: scan_1_abc' && s3.scanId === 'scan_1_abc' && s3.passedCount === 3 && s3.hostName === await describeNotesForLedger(HOST) && s3.targetIp === `(${IP.length} chars)`, 'I5 SCAP entry keeps target, scan id and counts; host and IP are descriptors', s3);
  assert(idRed.entries[0].sha256Hash === idChain[0].sha256Hash && JSON.stringify(idRed.entries[4].newState) === JSON.stringify(idChain[4].newState) && JSON.stringify(idRed.entries[5].newState) === JSON.stringify(idChain[5].newState), 'I6 entry 0 keeps its hash; entries holding descriptors, evidence ids and empty values are not changed');
  const idLast = idRed.entries[idRed.entries.length - 1];
  assert((await verifyAuditChain(idRed.entries)).isValid && idRed.entries.length === 7 && idLast.actionType === ('LEDGER_REDACTED' as any) && idLast.previousState === idHead && /0 notes excerpt\(s\), 6 identifier\(s\)/.test(String(idLast.newState)), 'I7 the chain verifies, 7 entries, LEDGER_REDACTED counts notes and identifiers', idLast.newState);
  const idRed2 = await redactLedgerNotesExcerpts(idRed.entries);
  assert(idRed2.redacted === 0 && idRed2.entries === idRed.entries, 'I8 redacting twice is a no-op (same array)');

  // browser-only tenant: still redacted by the start-up scrub
  const stI = new MemoryStorage();
  stI.setItem(LEDGER_KEY_PREFIX + 'L3', JSON.stringify(idChain));
  stI.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'L3', serverBacked: false }]));
  stI.setCalls.length = 0;
  const rI = await runBrowserStorageScrub(stI, () => undefined);
  const storedI = stI.getItem(LEDGER_KEY_PREFIX + 'L3')!;
  assert(rI.ledgersRedacted === 1 && rI.ledgerEntriesRedacted === 6 && !storedI.includes(HOST) && (await verifyAuditChain(JSON.parse(storedI))).isValid, 'I9 a browser-only ledger is redacted by the scrub and verifies', rI);
  stI.setCalls.length = 0;
  const rI2 = await runBrowserStorageScrub(stI, () => undefined);
  assert(rI2.ledgersRedacted === 0 && stI.setCalls.length === 0, 'I9b a second run writes nothing', rI2);

  // writers record descriptors
  globalStore.clear();
  await ingestAccretionDiscoveryPayload('W1', [{ agentId: 's1', hostName: 'HOST-MARK-W1', ipAddress: '10.77.0.1', macAddress: '00:77:00:00:00:01', osFingerprint: 'Linux', discoveredPorts: [22], connectionType: 'ETHERNET' }]);
  const w1 = loadLedger('W1');
  const w1Last = w1[w1.length - 1];
  const w1s = w1Last?.newState as any;
  assert(w1Last?.actionType === 'TELEMETRY_INGESTED' && w1s.hostName === await describeNotesForLedger('HOST-MARK-W1') && w1s.ipAddress === '(9 chars)' && w1s.macAddress === '(17 chars)' && !['HOST-MARK-W1', '10.77.0.1', '00:77:00:00:00:01'].some((s) => JSON.stringify(w1).includes(s)), 'I10 the discovery writer records descriptors only', w1s);
  const rep = generateSimulatedScanReport('W2', 'HOST-MARK-W2', '10.78.0.1');
  const scap = await ingestScapScanReport(rep, () => undefined, () => undefined, 'W2');
  const w2 = loadLedger('W2');
  const w2Last = w2[w2.length - 1];
  const w2s = w2Last.newState as any;
  assert(w2Last.targetEntity.startsWith('SCAP Scan: ') && w2s.hostName === await describeNotesForLedger('HOST-MARK-W2') && w2s.targetIp === '(9 chars)' && !['HOST-MARK-W2', '10.78.0.1'].some((s) => JSON.stringify(w2).includes(s)) && scap.auditHash === w2Last.sha256Hash && (await verifyAuditChain(w2)).isValid, 'I11 the SCAP writer records descriptors only and its audit hash matches the ledger', w2s);

  // compare-and-set: another tab appends while the scrub is hashing
  const fix12 = await mkIdent('L4');
  const fix12Json = JSON.stringify(fix12);
  await recordAuditEvent({ tenantId: 'L4', actorEmail: 'a@x.com', actionType: 'TELEMETRY_INGESTED', targetEntity: 'EnclaveAsset:a3', newState: { hostName: HOST, ipAddress: IP, macAddress: MAC } });
  const ext12 = [...loadLedger('L4')];
  const ext12Json = JSON.stringify(ext12);
  class RacingStorage extends MemoryStorage {
    reads = 0;
    getItem(k: string) {
      if (k !== LEDGER_KEY_PREFIX + 'L4') return super.getItem(k);
      this.reads++;
      return this.reads === 1 ? fix12Json : ext12Json;
    }
  }
  const stRace = new RacingStorage();
  stRace.setItem(LEDGER_KEY_PREFIX + 'L4', fix12Json);
  stRace.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'L4', serverBacked: false }]));
  const rRace = await runBrowserStorageScrub(stRace, () => undefined);
  const storedRace = MemoryStorage.prototype.getItem.call(stRace, LEDGER_KEY_PREFIX + 'L4')!;
  const raceEntries = JSON.parse(storedRace) as AuditLogEntry[];
  assert(rRace.failed === 0 && raceEntries.some((e) => e.id === ext12[ext12.length - 1].id) && !storedRace.includes(HOST) && !storedRace.includes(IP) && (await verifyAuditChain(raceEntries)).isValid, 'I12 an entry appended during the scrub is kept, redacted and the chain verifies', rRace);

  console.log('\n--- Fleet scan data (server tenants never keep it in browser storage) ---');
  globalStore.clear();
  const flRep = generateSimulatedScanReport('srvF', 'HOST-MARK-FL', '10.79.0.1');
  flRep.results[0].status = 'FAIL';
  await ingestScanReportToAsset(flRep, 'srvF', 'memory');
  assert(
    globalStore.getItem(FLEET_KEY_PREFIX + 'srvF') === null &&
      !Array.from({ length: globalStore.length }, (_, i) => globalStore.getItem(globalStore.key(i)!)!).some((v) => v.includes('HOST-MARK-FL')) &&
      getEnclaveFleet('srvF', 'memory').length === 1,
    'FL1 a memory-mode ingest writes nothing to browser storage and the fleet is readable in memory'
  );
  await ingestScanReportToAsset(flRep, 'brwF', 'browser');
  const flBrwCache = globalStore.getItem(FLEET_KEY_PREFIX + 'brwF');
  assert(flBrwCache !== null && JSON.parse(flBrwCache).length === 1, 'FL2 a browser-mode ingest keeps the fleet in browser storage');
  const flAgg = await aggregateAssetTelemetry('srvF', 'memory');
  assert(flAgg.totalAssets === getEnclaveFleet('srvF', 'memory').length && flAgg.totalAssets === 1, 'FL3 the boundary rollup reads the memory fleet');
  const flOne = [{ assetId: 'a1', hostName: 'HOST-MARK-FL', ipAddress: '10.79.0.2', ruleResults: [] }] as any;
  globalStore.setItem(FLEET_KEY_PREFIX + 'srvG', JSON.stringify(flOne));
  saveEnclaveFleet([], 'srvG', 'memory');
  assert(globalStore.getItem(FLEET_KEY_PREFIX + 'srvG') === null, 'FL4 a memory-mode save removes a leftover browser copy');
  globalStore.setItem(FLEET_KEY_PREFIX + 'srvH', JSON.stringify(flOne));
  assert(getEnclaveFleet('srvH', 'memory').length === 0, 'FL5 a memory-mode read never reads a leftover browser copy');
  const flFleet = getEnclaveFleet('srvF', 'memory');
  await remediateAssetRule('srvF', flFleet[0].assetId, flRep.results[0].ruleId, 'memory');
  const flAfter = getEnclaveFleet('srvF', 'memory');
  assert(
    flAfter[0].ruleResults.find((r) => r.ruleId === flRep.results[0].ruleId)?.status === 'PASS' && globalStore.getItem(FLEET_KEY_PREFIX + 'srvF') === null,
    'FL6 remediation updates the memory fleet and still writes nothing to browser storage'
  );
  await ingestScanReportToAsset(flRep, 'srvD');
  assert(globalStore.getItem(FLEET_KEY_PREFIX + 'srvD') === null, 'FL7 the default mode is memory');
  assert(fleetStorageMode({ serverBacked: true }) === 'memory' && fleetStorageMode({}) === 'browser', 'FL8 fleetStorageMode maps server-backed to memory');
  clearEnclaveFleet('srvF');
  clearEnclaveFleet('brwF');
  assert(getEnclaveFleet('srvF', 'memory').length === 0 && globalStore.getItem(FLEET_KEY_PREFIX + 'brwF') === null, 'FL9 clearEnclaveFleet clears the memory and the browser copy');

  const stF = new MemoryStorage();
  stF.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }, { id: 'brw1' }]));
  for (const id of ['srv1', 'brw1', 'orphan9']) stF.setItem(FLEET_KEY_PREFIX + id, JSON.stringify(flOne));
  const fsLogs: string[] = [];
  const fs1 = await runBrowserStorageScrub(stF, (m) => fsLogs.push(m));
  assert(
    fs1.fleetCachesRemoved === 1 && stF.getItem(FLEET_KEY_PREFIX + 'srv1') === null &&
      stF.getItem(FLEET_KEY_PREFIX + 'brw1') === JSON.stringify(flOne) && stF.getItem(FLEET_KEY_PREFIX + 'orphan9') === JSON.stringify(flOne),
    'FS1 the scrub removes only a registered server tenant\'s fleet key', fs1
  );
  stF.setCalls.length = 0;
  const fs2 = await runBrowserStorageScrub(stF, () => undefined);
  assert(fs2.fleetCachesRemoved === 0 && stF.setCalls.length === 0, 'FS2 a second run removes nothing and writes nothing', fs2);
  const stF3 = new MemoryStorage();
  stF3.setItem('pbc_live_tenants_v4', 'garbage');
  stF3.setItem(FLEET_KEY_PREFIX + 'srv1', JSON.stringify(flOne));
  const fs3 = await runBrowserStorageScrub(stF3, () => undefined);
  assert(fs3.registryUnreadable && stF3.getItem(FLEET_KEY_PREFIX + 'srv1') === JSON.stringify(flOne), 'FS3 an unreadable registry leaves the fleet key alone', fs3);
  assert(fsLogs.length > 0 && fsLogs.every((l) => !l.includes('srv1') && !l.includes('HOST-MARK-FL')), 'FS4 the scrub log line carries counts only', fsLogs);

  console.log('\n--- failingAssets (host names, IPs) never cached for server tenants ---');
  const faState = makeState('srv1', '');
  for (const c of Object.values(faState.controls)) (c as any).failingAssets = [{ hostName: 'HOST-MARK-FA', ipAddress: '10.80.0.1' }];
  globalStore.clear();
  StorageService.saveAssessment('srv1', faState);
  const faRaw = globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!;
  assert(!faRaw.includes('HOST-MARK-FA') && !faRaw.includes('10.80.0.1') && Object.values(JSON.parse(faRaw).controls).every((c: any) => c.failingAssets === undefined), 'FA1 saveAssessment strips failingAssets');
  StorageService.saveAssessment('brw1', faState, { keepNotes: true });
  assert(globalStore.getItem(ASSESSMENT_KEY_PREFIX + 'brw1')!.includes('HOST-MARK-FA'), 'FA2 keepNotes keeps failingAssets for a browser-only tenant');
  globalStore.clear();
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(faState));
  globalStore.setItem(ASSESSMENT_KEY_PREFIX + 'brw1', JSON.stringify(faState));
  const faSrv = StorageService.loadAssessment(makeTenant('srv1', true));
  const faBrw = StorageService.loadAssessment(makeTenant('brw1', false));
  assert(
    Object.values(faSrv.controls).every((c) => c.failingAssets === undefined) && Object.keys(faState.controls).every((id) => Array.isArray(faBrw.controls[id].failingAssets) && faBrw.controls[id].failingAssets!.length === 1),
    'FA3 loadAssessment drops failingAssets for a server tenant and keeps them for a browser-only one'
  );
  const stFA = new MemoryStorage();
  stFA.setItem('pbc_live_tenants_v4', JSON.stringify([{ id: 'srv1', serverBacked: true }]));
  // no notes in the fixture, so only the failing-asset lists can make the scrub rewrite a key
  const faNoNotes = stripImplementationNotesForCache(faState);
  stFA.setItem(ASSESSMENT_KEY_PREFIX + 'srv1', JSON.stringify(faNoNotes));
  stFA.setItem(ASSESSMENT_KEY_PREFIX + 'orphan9', JSON.stringify(faNoNotes));
  const fa4 = await runBrowserStorageScrub(stFA, () => undefined);
  assert(
    fa4.failingAssetListsCleared === Object.keys(faState.controls).length && stFA.getItem(ASSESSMENT_KEY_PREFIX + 'orphan9') === JSON.stringify(faNoNotes) &&
      !stFA.getItem(ASSESSMENT_KEY_PREFIX + 'srv1')!.includes('HOST-MARK-FA'),
    'FA4 the scrub clears failingAssets for a registered server tenant only', fa4
  );
  const faBefore = JSON.stringify(faState);
  const faOut = stripFailingAssetsForCache(faState);
  assert(Object.values(faOut.controls).every((c) => c.failingAssets === undefined) && JSON.stringify(faState) === faBefore, 'FA5 stripFailingAssetsForCache never mutates its input');

  const readSrcN = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
  assert(
    ['src/context/AssessmentContext.tsx', 'src/components/telemetry/AssetComplianceTable.tsx', 'src/components/telemetry/PhotonScanConsole.tsx', 'src/components/telemetry/AssetRemediationDrawer.tsx']
      .every((p) => readSrcN(p).includes('fleetStorageMode(currentTenant)')),
    'FSrc1 every fleet caller passes fleetStorageMode(currentTenant)'
  );
  assert(!readSrcN('src/data/telemetry/assetTelemetryEngine.ts').split('\n').some((l) => /console\.\w+\(.*\berr\b/.test(l)), 'FSrc2 the fleet engine logs no error objects');
  assert(readSrcN('src/data/storage/offboardingEngine.ts').includes('FLEET_KEY_PREFIX'), 'FSrc3 offboarding purges the fleet key');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
