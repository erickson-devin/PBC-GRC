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
