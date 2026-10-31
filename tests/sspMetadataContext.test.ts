import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-text pins for the SSP metadata wiring of the contexts and screens (#84). The behaviour itself is covered by
 * sspMetadata.test.ts (server) and sspMetadataSync.test.ts (pure logic); these tests keep the wiring from drifting:
 * where the server copy is loaded and cleared, what the editing action may touch, and that no value reaches a log.
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

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
/** The text between two anchors (empty when either is missing). */
const between = (text: string, from: string, to: string): string => {
  const a = text.indexOf(from);
  if (a < 0) return '';
  const b = text.indexOf(to, a + from.length);
  return b < 0 ? '' : text.slice(a, b);
};

const tenantCtx = read('src/context/TenantContext.tsx');
const assessCtx = read('src/context/AssessmentContext.tsx');
const syncSrc = read('src/data/sspMetadataSync.ts');
const dash = read('src/components/admin/SuperAdminDashboard.tsx');
const builder = read('src/components/ssp/SSPBuilder.tsx');
const modal = read('src/components/reports/ArtifactExportModal.tsx');

console.log('\n🧩 SSP metadata context wiring (#84)');

// C1 / C2: loaded with the controls for the same scope, cleared wherever the other live data is
const promiseAll = between(tenantCtx, 'objectivesList, sspMetadataRecord] = await Promise.all([', ']);');
assert(promiseAll.includes('ApiClient.getSspMetadata(targetTenantId, programId)'), 'C1: refreshLiveData loads the program\'s SSP metadata with its controls');
const nullCleared = count(tenantCtx, 'setLiveSspMetadata(null)');
assert(nullCleared === count(tenantCtx, 'setLiveControls(null)') && nullCleared >= 3, 'C2: the SSP metadata is cleared wherever the live controls are', { nullCleared, controls: count(tenantCtx, 'setLiveControls(null)') });
assert(tenantCtx.indexOf('setLiveSspMetadata(sspMetadataRecord)') > tenantCtx.indexOf('setLiveObjectives(objectivesMap)') && tenantCtx.includes('setLiveScopeKey(scope)'), 'C2b: it is set next to the objectives, before the scope key is published');
assert(tenantCtx.includes('liveSspMetadata,') && tenantCtx.includes('updateLiveSspMetadata,') && count(tenantCtx, '    updateLiveSspMetadata,') === 2, 'C2c: the tenant context exposes the record and its writer');
const liveWriter = between(tenantCtx, 'const updateLiveSspMetadata = useCallback(', 'const updateLiveObjectivesBulk');
assert(liveWriter.includes('ApiClient.putSspMetadata(currentTenant.id, metadata, expectedUpdatedAt, program)') && liveWriter.includes('scopeNow(currentTenant.id) === scope'), 'C2d: the writer sends the caller\'s stamp and shows the answer only while its scope is on screen');

// C3: the editing action never writes the browser, and is gated
const updateBody = between(assessCtx, 'const updateSSPMetadata = useCallback(', '// Action: Upload Evidence');
assert(updateBody.length > 0 && !/localStorage|saveAssessment|sessionStorage/.test(updateBody), 'C3: updateSSPMetadata writes no browser storage itself');
assert(updateBody.includes('canEdit') && updateBody.includes('sspMetadataEditable'), 'C3b: updateSSPMetadata checks the role and the editable gate');
assert(updateBody.includes('sspDraftsRef.current.push(') && updateBody.includes('pickSspFields(next)'), 'C3c: an edit is queued for the server through the debounced save');

// C4: import keeps the marker
assert(assessCtx.includes('imported.sspMetadataMigratedAt = stateRef.current.sspMetadataMigratedAt'), 'C4: an imported file never replaces this browser\'s SSP marker');

// C5: no console line in the sync module or the SSP blocks, and no value in a notice
assert(!/console\./.test(syncSrc), 'C5: sspMetadataSync.ts logs nothing');
const sspBlock = between(assessCtx, 'SSP metadata held by the server (#84)', '// Action: Upload Evidence');
assert(sspBlock.length > 0 && !/console\./.test(sspBlock), 'C5b: the SSP block of the assessment context logs nothing');
const consoleLines = tenantCtx.split('\n').filter((l) => /console\./.test(l) && /stack profile|boundary text/.test(l));
assert(consoleLines.length >= 2 && consoleLines.every((l) => !/cachedBoundary|boundaryToSend|profileToSend|\.stackProfile|systemBoundaryScope/.test(l)), 'C5c: the tenant context logs only a fixed text and the error message for the two registry fields', consoleLines);

// C6: "Move to server" carries the two registry-held fields
const migrate = between(tenantCtx, 'const migrateTenantToServer = useCallback(', '"Move to server": the user-facing action');
assert(migrate.includes('target.stackProfile') && migrate.includes('target.systemBoundaryScope'), 'C6: migrateTenantToServer moves the stack profile and the boundary text');
assert(migrate.includes('ApiClient.updateProgram(created.id') && migrate.includes('boundarySummary: boundaryToSend'), 'C6b: the boundary text becomes the new default program\'s boundary summary');

// C7: the handover reads each program's SSP metadata
assert(dash.includes('getSspMetadata: (t, p) => ApiClient.getSspMetadata(t, p)'), 'C7: the dashboard binds the handover to the server\'s SSP metadata');

// C8: the pure module writes no storage
assert(!/setItem|localStorage|sessionStorage|indexedDB/.test(syncSrc), 'C8: sspMetadataSync.ts writes no browser storage');

// C9: the screen
assert(builder.includes('sspMetadataEditable') && count(builder, 'disabled={!canEdit || !sspMetadataEditable}') === 11, 'C9: all eleven SSP inputs are disabled until the server copy is editable', count(builder, 'disabled={!canEdit || !sspMetadataEditable}'));
assert(builder.includes('Keep the server&apos;s') && builder.includes('Use this browser&apos;s'), 'C9b: the conflict notice offers the two choices');
assert(builder.includes('SSP_METADATA_NEED_OWNER_MESSAGE') && builder.includes('sspMetadataConflict.fields.join'), 'C9c: the needs-owner notice is fixed text and the conflict names fields only');
assert(builder.includes('Loading the server copy…') && builder.includes('Saved to the server'), 'C9d: the status line says loading and saved');

// Reconcile effect and save wiring
const effect = between(assessCtx, 'if (!currentTenant.serverBacked || !liveSspMetadata ||', 'const resolveSspMetadataConflict');
assert(effect.includes('liveScopeKey !== programScope') && effect.includes('stateScope !== programScope'), 'C10: the reconcile only runs for the scope on screen');
assert(effect.includes('programScopeKey(prev.tenantId, prev.programId) !== programScope') && effect.includes('sspDraftsRef.current.has(sspKey)'), 'C10b: a merge keeps a pending draft, a busy save and a stale scope\'s text on screen');
assert(effect.includes('sspMigratingScope.current === programScope'), 'C10c: one upload at a time per scope');
assert(assessCtx.includes("registerBeforeLock('ssp-metadata'") && assessCtx.includes('useUnsavedTextProvider(() => {\n    const s = stateRef.current;\n    const live = liveSspMetadataRef.current;'), 'C11: typed SSP details are sent before the idle lock and reported to the unsaved-text rescue');
assert(assessCtx.includes('isStaleWriteError(err)') && assessCtx.includes('SSP_METADATA_STALE_MESSAGE') && sspBlock.includes('createStampedSaveChain()'), 'C12: saves are stamped, and a stale answer shows the fixed notice');

// Export modal
const modalSave = between(modal, 'const handleSaveMetadata = useCallback(', '// Dynamic Live Document Compilation');
assert(modalSave.includes('!sspMetadataEditable') && modalSave.indexOf('!sspMetadataEditable') < modalSave.indexOf('updateSSPMetadata({'), 'C13: the export form refuses to save (and says so) while the details are not editable');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
process.exitCode = passed === total ? 0 : 1;
