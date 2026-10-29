/**
 * #92: assets that did not reach the server when a browser-only tenant was moved. Pure test: no server, a fake Storage,
 * the real failed-move record, asset push and unmatched-asset helpers.
 */

import fs from 'fs';
import path from 'path';
import {
  FAILED_MOVES_KEY, readFailedMoves, recordFailedMove, failedMovesFor, setFailedMoveAssets, type FailedMoveRecord,
  FAILED_CONTROL_MOVES_KEY, FAILED_MOVE_NOTES_KEY_PREFIX, readFailedControlMoves, failedControlMovesFor, recordFailedControlMove,
  readPendingControlAnswers, settleFailedControls, pruneOrphanControlNotes, type FailedControlMoveRecord, type PendingControlAnswer,
} from '../src/services/failedMoves';
import { retryPendingControls, type ControlRetryDeps } from '../src/services/controlMove';
import { toAssetInput, pushAssetsToServer } from '../src/services/assetMove';
import { unmatchedLocalAssets, planLocalAssetCleanup, type ScrubStorage } from '../src/services/browserStorageScrub';

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

class MemoryStorage implements ScrubStorage {
  private map = new Map<string, string>();
  throwOnSet = false;
  get length() { return this.map.size; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) {
    if (this.throwOnSet) throw new Error('quota');
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
}

const root = process.cwd();
const readSrc = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const mkAsset = (id: string, hostName: string, macAddress = ''): any => ({ id, hostName, macAddress });
const rec = (over: Partial<FailedMoveRecord> = {}): FailedMoveRecord =>
  ({ fromTenantId: 'old1', toTenantId: 'new1', at: '2026-10-28T00:00:00.000Z', assetsFailed: 3, ...over });

async function main() {
  console.log('\n--- Failed-move record ---');
  const s = new MemoryStorage();
  assert(readFailedMoves(s).length === 0, 'F1 empty storage reads as []');

  recordFailedMove(s, rec());
  const f2 = readFailedMoves(s);
  assert(f2.length === 1 && JSON.stringify(f2[0]) === JSON.stringify(rec()), 'F2 a recorded move reads back exactly', f2);
  assert(
    JSON.stringify(Object.keys(JSON.parse(s.getItem(FAILED_MOVES_KEY)!)[0]).sort()) === JSON.stringify(['assetsFailed', 'at', 'fromTenantId', 'toTenantId']),
    'F2 only ids, timestamp and count are stored'
  );

  recordFailedMove(s, rec({ assetsFailed: 2 }));
  const f3 = readFailedMoves(s);
  assert(f3.length === 1 && f3[0].assetsFailed === 2, 'F3 recording the same old tenant again replaces the entry', f3);

  const bad = new MemoryStorage();
  bad.setItem(FAILED_MOVES_KEY, 'not json');
  assert(readFailedMoves(bad).length === 0, 'F4 unparseable storage reads as []');
  bad.setItem(FAILED_MOVES_KEY, '[{"fromTenantId":1}]');
  assert(readFailedMoves(bad).length === 0, 'F4 non-string ids are dropped');
  bad.setItem(FAILED_MOVES_KEY, JSON.stringify([rec(), rec({ fromTenantId: 'old2', assetsFailed: -1 }), rec({ fromTenantId: 'old3', assetsFailed: NaN })]));
  const f4 = readFailedMoves(bad);
  assert(f4.length === 1 && f4[0].fromTenantId === 'old1', 'F4 negative and NaN counts are dropped', f4);

  assert(failedMovesFor(s, 'new1').length === 1, 'F5 failedMovesFor the new tenant finds the record');
  assert(failedMovesFor(s, 'zzz').length === 0, 'F5 failedMovesFor another tenant is empty');

  setFailedMoveAssets(s, 'old1', 1);
  assert(readFailedMoves(s)[0].assetsFailed === 1, 'F6 setFailedMoveAssets updates the count');
  setFailedMoveAssets(s, 'old1', 0);
  assert(readFailedMoves(s).length === 0 && s.getItem(FAILED_MOVES_KEY) === null, 'F6 setting 0 removes the entry and the key');

  const thrower = new MemoryStorage();
  thrower.throwOnSet = true;
  let threw = false;
  try { recordFailedMove(thrower, rec()); setFailedMoveAssets(thrower, 'old1', 0); } catch { threw = true; }
  assert(!threw, 'F7 a storage that throws never makes recordFailedMove throw');

  const leak = new MemoryStorage();
  recordFailedMove(leak, { ...rec(), hostName: 'ws-secret' } as unknown as FailedMoveRecord);
  assert(!(leak.getItem(FAILED_MOVES_KEY) ?? '').includes('ws-secret'), 'F8 extra fields are never stored');

  console.log('\n--- Unmatched local assets ---');
  const local = [mkAsset('a', 'WS-01'), mkAsset('b', 'WS-02'), mkAsset('asset-ws-01-old1', 'D')];
  const server = [mkAsset('s', 'ws-01')];
  const u1 = unmatchedLocalAssets(local, server, 'old1');
  assert(JSON.stringify(u1.map(x => x.id)) === JSON.stringify(['b']), 'U1 only the asset without a server match is returned', u1.map(x => x.id));
  const plan = planLocalAssetCleanup(local, server, 'old1');
  assert(!plan.removable && plan.unmatched === 1, 'U1 planLocalAssetCleanup agrees', plan);

  console.log('\n--- Asset push ---');
  const t1 = toAssetInput({ id: 'x', tenantId: 't', isManuallyAdded: true, hostName: 'h', owner: undefined } as any) as unknown as Record<string, unknown>;
  assert(!('id' in t1) && !('tenantId' in t1) && !('isManuallyAdded' in t1) && t1.owner === '' && t1.hostName === 'h', 'T1 toAssetInput drops ids and defaults the owner', t1);

  const three = [mkAsset('1', 'a'), mkAsset('2', 'b'), mkAsset('3', 'c')];
  const p1 = await pushAssetsToServer({ bulk: async () => ({ created: [{}, {}], skipped: [{}] }), single: async () => ({}) }, 't', three);
  assert(p1.moved === 2 && p1.failed === 1, 'P1 bulk counts created and skipped', p1);

  let singles = 0;
  const p2 = await pushAssetsToServer({
    bulk: async () => { throw new Error('bad row'); },
    single: async () => { singles++; if (singles === 2) throw new Error('bad'); return {}; },
  }, 't', three);
  assert(p2.moved === 2 && p2.failed === 1 && singles === 3, 'P2 a rejected bulk falls back to one request per asset', { p2, singles });

  const chunks: number[] = [];
  const many = Array.from({ length: 1001 }, (_, i) => mkAsset(String(i), `h${i}`));
  await pushAssetsToServer({ bulk: async (_t, inputs) => { chunks.push(inputs.length); return { created: inputs, skipped: [] }; }, single: async () => ({}) }, 't', many);
  assert(chunks.length === Math.ceil(1001 / 500) && JSON.stringify(chunks) === JSON.stringify([500, 500, 1]), 'P3 1001 assets go in chunks of 500', chunks);

  let calls = 0;
  const p4 = await pushAssetsToServer({ bulk: async () => { calls++; return { created: [], skipped: [] }; }, single: async () => { calls++; return {}; } }, 't', []);
  assert(calls === 0 && p4.moved === 0 && p4.failed === 0, 'P4 an empty list makes no request', p4);

  console.log('\n--- Failed control answers (#113) ---');
  const ans = (n: number): PendingControlAnswer => ({ status: 'MET', implementationNotes: `CUI-N${n}`, responsibleRole: 'r', updatedBy: 'u' });
  const crec: FailedControlMoveRecord = { fromTenantId: 'old1', toTenantId: 'new1', at: '2026-10-28T00:00:00.000Z', controlIds: ['c1', 'c2'] };
  const cs = new MemoryStorage();
  assert(recordFailedControlMove(cs, crec, { c1: ans(1), c2: ans(2) }) === true, 'FC1 recording returns true');
  const fc1 = readFailedControlMoves(cs);
  assert(fc1.length === 1 && JSON.stringify(Object.keys(fc1[0]).sort()) === JSON.stringify(['at', 'controlIds', 'fromTenantId', 'toTenantId']), 'FC1 the record holds only ids and a timestamp', fc1);
  assert(!(cs.getItem(FAILED_CONTROL_MOVES_KEY) ?? '').includes('CUI-N1'), 'FC1 the record never contains notes');
  const fc2 = readPendingControlAnswers(cs, 'old1');
  assert(fc2.c1?.implementationNotes === 'CUI-N1' && JSON.stringify(Object.keys(fc2.c1).sort()) === JSON.stringify(['implementationNotes', 'responsibleRole', 'status', 'updatedBy']), 'FC2 the answers read back with a whitelisted shape', fc2);

  const cs3 = new MemoryStorage();
  recordFailedControlMove(cs3, crec, { c1: { ...ans(1), hostName: 'HOST-LEAK' } as unknown as PendingControlAnswer, c2: ans(2), c9: ans(9) });
  const fc3 = readPendingControlAnswers(cs3, 'old1');
  const fc3Raw = (cs3.getItem(FAILED_CONTROL_MOVES_KEY) ?? '') + (cs3.getItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'old1') ?? '');
  assert(!('c9' in fc3) && !fc3Raw.includes('HOST-LEAK') && !fc3Raw.includes('CUI-N9'), 'FC3 ids outside the record and extra fields are never stored', fc3);

  settleFailedControls(cs, 'old1', ['c1']);
  const fc4a = readFailedControlMoves(cs);
  assert(fc4a.length === 1 && JSON.stringify(fc4a[0].controlIds) === JSON.stringify(['c2']) && JSON.stringify(Object.keys(readPendingControlAnswers(cs, 'old1'))) === JSON.stringify(['c2']), 'FC4 settling one id leaves the other', fc4a);
  settleFailedControls(cs, 'old1', ['c2']);
  assert(cs.getItem(FAILED_CONTROL_MOVES_KEY) === null && cs.getItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'old1') === null, 'FC4 settling the last id removes both keys');

  const cbad = new MemoryStorage();
  cbad.setItem(FAILED_CONTROL_MOVES_KEY, 'not json');
  cbad.setItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'old1', 'not json');
  assert(readFailedControlMoves(cbad).length === 0 && Object.keys(readPendingControlAnswers(cbad, 'old1')).length === 0, 'FC5 malformed storage reads as [] and {}');

  const cthrow = new MemoryStorage();
  cthrow.throwOnSet = true;
  let cthrew = false;
  let cres = true;
  try { cres = recordFailedControlMove(cthrow, crec, { c1: ans(1), c2: ans(2) }); settleFailedControls(cthrow, 'old1', ['c1']); pruneOrphanControlNotes(cthrow); } catch { cthrew = true; }
  assert(!cthrew && cres === false, 'FC6 a storage that throws returns false and never throws');

  const cs7 = new MemoryStorage();
  recordFailedMove(cs7, rec());
  recordFailedControlMove(cs7, crec, { c1: ans(1), c2: ans(2) });
  setFailedMoveAssets(cs7, 'old1', 0);
  assert(readFailedMoves(cs7).length === 0 && readFailedControlMoves(cs7).length === 1, 'FC7 clearing the asset record keeps the control record');

  const cs8 = new MemoryStorage();
  recordFailedControlMove(cs8, crec, { c1: ans(1), c2: ans(2) });
  cs8.setItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'ghost', '{}');
  pruneOrphanControlNotes(cs8);
  assert(cs8.getItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'ghost') === null && cs8.getItem(FAILED_MOVE_NOTES_KEY_PREFIX + 'old1') !== null, 'FC8 an answer map with no record is removed, one with a record is kept');

  assert(failedControlMovesFor(cs8, 'new1').length === 1 && failedControlMovesFor(cs8, 'zzz').length === 0, 'FC9 failedControlMovesFor matches the new tenant only');

  console.log('\n--- Control retry (#113) ---');
  const mkDeps = (server: any[], push?: (id: string, a: PendingControlAnswer) => Promise<any>) => {
    const st = { pushes: 0, gets: 0 };
    const deps: ControlRetryDeps = {
      getServerControls: async () => { st.gets++; return server; },
      pushControl: async (id, a) => { st.pushes++; return push ? push(id, a) : { id, status: a.status, implementationNotes: a.implementationNotes }; },
    };
    return { deps, st };
  };
  const one = { c1: { status: 'MET', implementationNotes: 'CUI-N1', responsibleRole: 'r' } };
  const fresh = [{ id: 'c1', status: 'NOT_STARTED', implementationNotes: '' }];
  const r1 = mkDeps(fresh);
  const o1 = await retryPendingControls(r1.deps, one);
  assert(JSON.stringify(o1.confirmed) === '["c1"]' && r1.st.pushes === 1 && o1.sent === 1, 'RT1 an answer the server lacks is pushed and confirmed', o1);
  const r2 = mkDeps(fresh, async id => ({ id, status: 'MET', implementationNotes: 'changed' }));
  const o2 = await retryPendingControls(r2.deps, one);
  assert(JSON.stringify(o2.failed) === '["c1"]' && o2.confirmed.length === 0, 'RT2 a push the server did not store as sent is failed', o2);
  const r3 = mkDeps(fresh, async () => { throw new Error('down'); });
  const o3 = await retryPendingControls(r3.deps, one);
  assert(JSON.stringify(o3.failed) === '["c1"]', 'RT3 a rejected push is failed', o3);
  const r4 = mkDeps([{ id: 'c1', status: 'NOT_STARTED', implementationNotes: 'other' }]);
  const o4 = await retryPendingControls(r4.deps, one);
  assert(JSON.stringify(o4.conflicts) === '["c1"]' && r4.st.pushes === 0, 'RT4 different server notes are a conflict and nothing is sent', o4);
  const r5 = mkDeps([{ id: 'c1', status: 'MET', implementationNotes: 'CUI-N1' }]);
  const o5 = await retryPendingControls(r5.deps, one);
  assert(JSON.stringify(o5.confirmed) === '["c1"]' && r5.st.pushes === 0, 'RT5 the server already holds the answer: confirmed without sending', o5);
  const r6 = { pushes: 0 };
  let rt6 = false;
  try {
    await retryPendingControls({ getServerControls: async () => { throw new Error('down'); }, pushControl: async (id) => { r6.pushes++; return { id } as any; } }, one);
  } catch { rt6 = true; }
  assert(rt6 && r6.pushes === 0, 'RT6 an unreachable server rejects and nothing is sent');
  const r7 = mkDeps([{ id: 'c1', status: 'MET', implementationNotes: '' }]);
  const o7 = await retryPendingControls(r7.deps, { c1: { status: 'NOT_MET', implementationNotes: '', responsibleRole: 'r' } });
  assert(JSON.stringify(o7.conflicts) === '["c1"]' && r7.st.pushes === 0, 'RT7 a different non-default server status is a conflict', o7);
  const r8 = mkDeps(fresh);
  const o8 = await retryPendingControls(r8.deps, {});
  assert(r8.st.gets === 0 && r8.st.pushes === 0 && o8.sent === 0, 'RT8 no answers makes no call', o8);

  console.log('\n--- Source checks ---');
  const manager = readSrc('src/components/telemetry/AssetInventoryManager.tsx');
  assert(manager.includes('{canEdit && <FailedMoveAssetsNotice />}'), 'C1 the inventory mounts the notice for editors only');
  const notice = readSrc('src/components/telemetry/FailedMoveAssetsNotice.tsx');
  assert(notice.includes('Retry moving') && notice.includes('role="region"') && notice.includes('aria-live="polite"'), 'C2 the notice is a labelled region with a live status and a retry button');
  const hook = readSrc('src/hooks/useFailedMoveAssets.ts');
  assert(
    hook.includes('serverBacked') && hook.includes('unmatchedLocalAssets(') && hook.includes('clearLocalEnclaveAssets(') && hook.includes('pushAssetsToServer(') && hook.includes('notifyAssetsChanged('),
    'C3 the hook is gated on serverBacked, matches, pushes, clears and notifies'
  );
  const leaks: string[] = [];
  for (const rel of ['src/services/failedMoves.ts', 'src/services/assetMove.ts', 'src/hooks/useFailedMoveAssets.ts', 'src/components/telemetry/FailedMoveAssetsNotice.tsx', 'src/services/controlMove.ts', 'src/hooks/useFailedMoveControls.ts', 'src/components/dashboard/FailedMoveControlsNotice.tsx', 'src/components/dashboard/ConfirmKeepServerAnswersDialog.tsx']) {
    for (const line of readSrc(rel).split('\n')) {
      if (/console\./.test(line) && /hostName|ipAddress|macAddress|notes|implementationNotes/.test(line)) leaks.push(`${rel}: ${line.trim()}`);
    }
  }
  assert(leaks.length === 0, 'C4 no console line names a host, address, MAC or notes', leaks);
  const matrix = readSrc('src/components/dashboard/AssessmentMatrix.tsx');
  assert(matrix.includes('{canEdit && <FailedMoveControlsNotice />}'), 'C5 the control matrix mounts the notice for editors only');
  const cNotice = readSrc('src/components/dashboard/FailedMoveControlsNotice.tsx');
  assert(cNotice.includes('Retry moving') && cNotice.includes('role="region"') && cNotice.includes('aria-live="polite"'), 'C6 the control notice is a labelled region with a live status and a retry button');
  const cHook = readSrc('src/hooks/useFailedMoveControls.ts');
  assert(
    cHook.includes('serverBacked') && cHook.includes('retryPendingControls(') && cHook.includes('settleFailedControls(') && cHook.includes('ApiClient.updateControl(') && cHook.includes('refreshLiveData('),
    'C7 the control hook is gated on serverBacked, retries, settles, pushes and reloads'
  );
  const keepDlg = readSrc('src/components/dashboard/ConfirmKeepServerAnswersDialog.tsx');
  assert(
    keepDlg.includes('role="alertdialog"') && keepDlg.includes('onClose={handleCancel}') && keepDlg.includes('autoFocus') && keepDlg.split('if (busyRef.current) return;').length === 3
      && !keepDlg.includes('console.') && !keepDlg.includes('dangerouslySetInnerHTML'),
    'C8 the keep-server dialog is an alertdialog with a busy guard in both handlers, autofocus on Cancel, no console and no raw HTML'
  );
  assert(cNotice.includes('Keep the server&apos;s version') && cNotice.includes('ConfirmKeepServerAnswersDialog') && cHook.includes('conflictIds'), 'C9 the keep-server action is offered only from the conflicts a retry found');

  console.log('\n--- Migration wiring (move to server) ---');
  const tenantSrc = readSrc('src/context/TenantContext.tsx');
  const migStart = tenantSrc.indexOf('const migrateTenantToServer = useCallback');
  const migEnd = tenantSrc.indexOf('const migrateLocalTenantToServer = useCallback');
  const mig = migStart >= 0 && migEnd > migStart ? tenantSrc.slice(migStart, migEnd) : '';
  assert(mig.length > 0 && mig.includes('pushAssetsToServer(') && !mig.includes('const toInput = (a: EnclaveAsset)'), 'MG1 the migration pushes assets through the shared helper, not an inline copy');
  assert(/if \(assetsFailed > 0\)[\s\S]{0,300}recordFailedMove\(/.test(mig) || /else \{[\s\S]{0,400}recordFailedMove\(/.test(mig), 'MG2 a failed asset push records the failed move');
  assert(
    mig.indexOf('moveLocalEvidenceCopy(') >= 0 && mig.indexOf('moveLocalEvidenceCopy(') < mig.indexOf('importObjectives(') && mig.includes('objectivesToUpload(remapEvidenceLinks('),
    'MG3 evidence is uploaded before the objectives, and the links are remapped before they are sent'
  );
  assert(
    mig.includes('ApiClient.requestUploadUrl(created.id') && mig.includes('ApiClient.uploadEvidenceFile(') && mig.includes('ApiClient.verifyEvidenceIntegrity(created.id'),
    'MG4 evidence goes to the new tenant: upload-url, PUT and verify'
  );
  assert(
    mig.includes('evidenceFailed') && tenantSrc.split('\n').some(l => l.includes('migrateLocalTenantToServer:') && l.includes('evidenceFailed: number')),
    'MG5 the migration reports evidenceFailed, and the context type carries it'
  );
  assert(!mig.includes('console.'), 'MG6 the migration writes nothing to the console');
  const legacyNotice = readSrc('src/components/common/LegacyTenantNotice.tsx');
  assert(
    legacyNotice.includes('evidenceFailed') && legacyNotice.includes('retry from the asset inventory') && legacyNotice.includes('Only in this browser') && !legacyNotice.includes('please add them again'),
    'MG7 the notice warns about failed evidence and points to the retry'
  );
  assert(mig.indexOf('recordFailedControlMove(') >= 0 && mig.indexOf('recordFailedControlMove(') < mig.indexOf('StorageService.migrateAssessment('), 'MG9 the failed control answers are recorded before the old cache is stripped and removed');
  assert(/legacyControls\.filter\(\(_, i\) => pushed\[i\]\.status === 'rejected'\)/.test(mig), 'MG10 the failed controls are identified by position in the push results');
  assert(mig.includes('clearEnclaveFleet(target.id)'), 'MG11 the old tenant\'s scan results are cleared from this browser');
  assert(legacyNotice.includes('retry from the control matrix'), 'MG12 the notice points to the control matrix retry');
  const pkg = JSON.parse(readSrc('package.json')).scripts as Record<string, string>;
  assert(
    pkg['test:all'].includes('tests/localEvidenceCopies.test.ts') && pkg['test:all'].includes('tests/failedMoves.test.ts') && !!pkg['test:local-evidence'] && !!pkg['test:failed-moves'],
    'MG8 both new suites are in test:all and have their own scripts'
  );

  console.log(`\n==============================================`);
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
