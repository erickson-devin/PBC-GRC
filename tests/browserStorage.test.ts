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
  stripImplementationNotesForCache,
  stripObjectiveNarrativesForCache,
  scrubAssessmentJson,
  computeNotesStatus,
  runBrowserStorageScrub,
} from '../src/services/browserStorageScrub';
import { StorageService } from '../src/services/storageService';
import { redactLedgerNotesExcerpts, recordAuditEvent, verifyAuditChain, loadLedger } from '../src/data/audit/auditLogger';
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
    'src/services/storageService.ts',
  ].sort();
  assert(JSON.stringify(writers) === JSON.stringify(allowed), 'S13 the set of src files that write browser storage equals the reviewed allow-list', writers);

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

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
