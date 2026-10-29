import fs from 'fs';
import path from 'path';
import { overlayLockReason } from '../src/data/overlayScoping';
import { matchesBoundaryFilter, planBoundaryChange, rowChangeNeedsConfirm, describeBoundaryChange, boundaryEditBlock, boundaryErrorMessage, summaryCaption, emptyTableMessage, exportBoundaryLine } from '../src/data/boundaryView';
import { emptyScopeSummary } from '../src/data/telemetry/assetScope';

/**
 * Multi-program wave 4 (P5): static checks that the views follow the active program (SSP import re-keyed and pinned, labels,
 * boundary text, audit filter, export headers, onboarding). Pure test: reads source files, no server, no browser.
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

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const FILES = [
  'src/components/sspImport/SspImportView.tsx',
  'src/components/matrix/ImportAnalysisPanel.tsx',
  'src/components/matrix/InspectDocumentModal.tsx',
  'src/components/dashboard/ControlCard.tsx',
  'src/components/dashboard/AssessmentMatrix.tsx',
  'src/components/settings/EnclaveSettings.tsx',
  'src/views/PolicyLibraryView.tsx',
  'src/components/audit/AuditTrailViewer.tsx',
  'src/components/reports/ArtifactExportModal.tsx',
  'src/components/ssp/SSPBuilder.tsx',
  'src/components/admin/SuperAdminDashboard.tsx',
  'src/components/onboarding/OnboardingModal.tsx',
];

console.log('--- labels and settings ---');
const enclave = read('src/components/settings/EnclaveSettings.tsx');
assert(enclave.includes('Licensed Frameworks'), 'EnclaveSettings.tsx labels the tenant frameworks "Licensed Frameworks"');
assert(!enclave.includes('Assessment Program'), 'EnclaveSettings.tsx no longer says "Assessment Program"');
assert(/activeProgram\.boundarySummary/.test(enclave) && /updateProgram\(activeProgram\.id, \{ boundarySummary/.test(enclave), 'EnclaveSettings.tsx reads and edits the active program boundary summary');
assert(/canManagePrograms/.test(enclave), 'EnclaveSettings.tsx gates the boundary edit on canManagePrograms');

console.log('--- SSP import ---');
const ssp = read('src/components/sspImport/SspImportView.tsx');
assert(/\}, \[tenantId, programId, canView\]\);/.test(ssp), 'SspImportView.tsx load effect deps include programId');
assert(/useCallback\(async \(\) => \{[\s\S]*?\[tenantId, programId\]\)/.test(ssp), 'SspImportView.tsx loaders depend on programId');
assert(/setDrafts\(\{\}\)/.test(ssp) && /setSelectedJobId\(null\)/.test(ssp) && /setDetail\(null\)/.test(ssp), 'SspImportView.tsx resets drafts, detail and the selected job on a switch');
assert(/scopeRef/.test(ssp) && /scopeRef\.current !== scope\) return;\n\s*void loadJobs/.test(ssp), 'SspImportView.tsx polling ignores a stale scope');
assert(/disabled=\{pinnedFramework !== null\}/.test(ssp) && /pinnedFramework \?\? framework/.test(ssp), 'SspImportView.tsx pins the framework select to the program framework');
assert(/ApiClient\.sspUpload\(tenantId, file, effectiveFramework,/.test(ssp) && /effectiveBaseline : undefined, programId\)/.test(ssp), 'SspImportView.tsx still sends the framework field (and the program baseline) on upload');
assert(/pinnedBaseline/.test(ssp) && /isSspBaseline\(activeProgram\?\.baseline\)/.test(ssp), 'SspImportView.tsx maps the program baseline to the SSP baseline');
const sspCalls = ssp.split('\n').filter((l) => /ApiClient\.ssp\w+\(/.test(l) && !l.includes('ApiClient.sspReview('));
assert(sspCalls.length >= 8 && sspCalls.every((l) => l.includes('programId')), 'every SspImportView.tsx ApiClient.ssp* call (but the review) passes programId');
assert(/\}, programId\);\n\s*setDetail\(\(d\)/.test(ssp), 'the SspImportView.tsx review call passes programId');
const panel = read('src/components/matrix/ImportAnalysisPanel.tsx');
assert(/\}, \[controlId, tenantId, programId\]\);/.test(panel), 'ImportAnalysisPanel.tsx effect key includes the program');

console.log('--- matrix, inspector, cards ---');
const inspect = read('src/components/matrix/InspectDocumentModal.tsx');
assert(/handleNavigateToMapped/.test(inspect) && /setActiveFramework\(targetFramework\)/.test(inspect), 'InspectDocumentModal.tsx jumps through setActiveFramework');
assert(/No program uses this framework/.test(inspect), 'InspectDocumentModal.tsx explains a jump with no matching program');
assert(/programId=\{activeProgram\?\.id \?\? null\}/.test(inspect), 'InspectDocumentModal.tsx hands the program to ImportAnalysisPanel');
const matrix = read('src/components/dashboard/AssessmentMatrix.tsx');
assert(/activeProgram/.test(matrix) && /programLabel/.test(matrix), 'AssessmentMatrix.tsx shows the active program');
assert(/activeOverlayFilters\.nonNetworkedOnly/.test(matrix) && /Reset Overlay/.test(matrix), 'AssessmentMatrix.tsx keeps the overlay banner');

console.log('--- audit, export, SSP, onboarding ---');
const audit = read('src/components/audit/AuditTrailViewer.tsx');
assert(/metadata\??\.programId/.test(audit), 'AuditTrailViewer.tsx filters on metadata.programId');
assert(audit.includes('Tenant / legacy'), 'AuditTrailViewer.tsx lists entries without a program as "Tenant / legacy"');
const exportModal = read('src/components/reports/ArtifactExportModal.tsx');
assert(/activeProgram\?\.id/.test(exportModal) && /\[activeFramework, activeProgram\?\.id, exportModalInitialDocType/.test(exportModal), 'ArtifactExportModal.tsx re-syncs on the active program');
assert(/activeProgram\?\.boundarySummary/.test(exportModal) && /activeProgram\.name/.test(exportModal), 'ArtifactExportModal.tsx uses the program boundary summary and name');
const builder = read('src/components/ssp/SSPBuilder.tsx');
assert(/activeProgram\?\.boundarySummary/.test(builder) && /activeProgram\.name/.test(builder), 'SSPBuilder.tsx uses the program boundary summary and name');
const admin = read('src/components/admin/SuperAdminDashboard.tsx');
assert(/getControls: \(t, p\) => ApiClient\.getControls\(t, undefined, p\)/.test(admin) && /buildProgramHandover\(tenant, selection/.test(admin), 'SuperAdminDashboard.tsx exports each chosen program with its own framework (#27)');
const onboarding = read('src/components/onboarding/OnboardingModal.tsx');
assert(/updateProgram\(defaultProgram\.id, \{ boundarySummary/.test(onboarding) && /p\.isDefault/.test(onboarding), 'OnboardingModal.tsx writes the boundary to the default program');

console.log('--- privacy baseline (#20) ---');
const programForm = read('src/components/programs/ProgramFormModal.tsx');
assert(/privacyBaseline/.test(programForm) && /type="checkbox"/.test(programForm) && /SP 800-53B privacy baseline/.test(programForm), 'ProgramFormModal.tsx has the privacy baseline checkbox');
assert(/Privacy baseline: \{program\.privacyBaseline \? 'Yes' : 'No'\}/.test(programForm), 'ProgramFormModal.tsx shows the privacy baseline read-only on an edit');
assert(/\+ Privacy/.test(read('src/components/layout/ProgramSwitcher.tsx')), 'ProgramSwitcher.tsx chip appends " + Privacy"');
assert(/\+ Privacy/.test(read('src/components/programs/ProgramsPage.tsx')), 'ProgramsPage.tsx baseline chip appends " + Privacy"');
assert(/programFrameworkControls\(/.test(read('src/context/AssessmentContext.tsx')) && /privacyBaseline: activeProgram\.privacyBaseline/.test(read('src/context/AssessmentContext.tsx')), 'AssessmentContext.tsx resolves the NIST program controls with the privacy baseline');
const switcher = read('src/components/layout/FrameworkSwitcher.tsx');
assert(/overlayLockReason\(/.test(switcher) && /aria-disabled=\{locked \|\| undefined\}/.test(switcher) && /o\.disabledReason \? reasonId/.test(switcher), 'FrameworkSwitcher.tsx gives each locked overlay a reason through aria-describedby');
{
  const privacyProgram = { framework: 'NIST_800_53_REV5', privacyBaseline: true, archived: false };
  const lockCtx = { serverBacked: true, programsStatus: 'ready' as const, canManagePrograms: true, framework: 'NIST_800_53_REV5', program: privacyProgram };
  assert(overlayLockReason('noPiiProcessing', lockCtx) === 'privacy', 'overlayScoping.ts locks No PII processing on a privacy program');
  assert(overlayLockReason('noWireless', lockCtx) === null, 'overlayScoping.ts leaves the other overlays open on a privacy program');
}
assert(/value="PRIVACY"/.test(matrix) && /baselines\[selectedBaselineFilter\.toLowerCase\(\)/.test(matrix) && /\+ Privacy/.test(matrix), 'AssessmentMatrix.tsx has the Privacy filter and label');
assert(/coverage\?\.privacy/.test(ssp), 'SspImportView.tsx marks an import that covered the privacy baseline');

console.log('--- overlays are a program setting (#22) ---');
assert(/\{!isEdit && isNist && \(/.test(programForm) && /OVERLAY_KEYS\.map\(/.test(programForm) && /Operational overlays \(optional\)/.test(programForm), 'ProgramFormModal.tsx offers the overlays at creation, for NIST only');
assert(/key === 'noPiiProcessing' && privacyBaseline/.test(programForm) && /setScoping\(\{ nonNetworkedOnly: false \}\)/.test(programForm), 'ProgramFormModal.tsx locks No PII on the privacy baseline and clears the overlays on a framework change');
assert(
  /setScoping\(privacyBaseline \? \{ \.\.\.next, noPiiProcessing: false \} : next\)/.test(programForm) && /onChange=\{\(e\) => chooseSource\(e\.target\.value\)\}/.test(programForm) && /source\.framework !== 'NIST_800_53_REV5'/.test(programForm),
  'ProgramFormModal.tsx prefills a NIST clone source\'s overlays (visible and changeable; the server does not copy them)'
);
assert(programForm.includes('Overlays: {programOverlayLabels(program.scoping)'), 'ProgramFormModal.tsx shows the overlays read-only on an edit');
assert(/programOverlayLabels\(program\.scoping\)/.test(read('src/components/programs/ProgramsPage.tsx')), 'ProgramsPage.tsx shows an overlays chip on each program card');
assert(/resetLock === null \?/.test(matrix) && /<ConfirmOverlayChangeDialog/.test(matrix) && !/onClick=\{toggleNonNetworkedOverlay\}/.test(matrix), 'AssessmentMatrix.tsx gates and confirms Reset Overlay');
assert(switcher.includes('<ConfirmOverlayChangeDialog') && switcher.includes('menuLockReason(') && switcher.includes('aria-disabled={locked || undefined}') && switcher.includes('aria-describedby={describedBy}')
  && !switcher.includes('Saved in this browser;') && !switcher.includes('kept in this browser') && !/\sdisabled=\{/.test(switcher), 'FrameworkSwitcher.tsx confirms a change and uses aria-disabled with described reasons');
assert(/if \(pendingRef\.current\) return;/.test(switcher) && switcher.indexOf('<ConfirmOverlayChangeDialog') > switcher.indexOf('{isOpen && ('), 'FrameworkSwitcher.tsx survives clicks in the portalled dialog');
const overlayDialog = read('src/components/programs/ConfirmOverlayChangeDialog.tsx');
assert(overlayDialog.includes('role="alertdialog"') && overlayDialog.includes('z-[60]') && overlayDialog.includes('max-h-[90vh]') && overlayDialog.includes('autoFocus')
  && overlayDialog.includes('<ErrorNotice') && overlayDialog.includes('overlaySaveErrorMessage(err)') && !overlayDialog.includes('console.'), 'ConfirmOverlayChangeDialog.tsx follows the alertdialog pattern');

console.log('--- boundary membership (#26) ---');
const sh = [{ id: 'a1', hostName: 'H1' }, { id: 'a2', hostName: 'H2' }, { id: 'a3', hostName: 'H3' }];
assert(
  matchesBoundaryFilter('a', 'ALL', new Set()) && matchesBoundaryFilter('a', 'IN', new Set(['a'])) && !matchesBoundaryFilter('b', 'IN', new Set(['a'])) && matchesBoundaryFilter('b', 'NOT_IN', new Set(['a'])),
  'BV1 matchesBoundaryFilter'
);
const bvAdd = planBoundaryChange(sh, new Set(['a1']), 'add', 10);
const bvRemove = planBoundaryChange(sh, new Set(['a1']), 'remove', 10);
assert(bvAdd.ids.join() === 'a2,a3' && bvAdd.membersBefore === 1 && bvAdd.membersAfter === 3 && bvRemove.ids.join() === 'a1' && bvRemove.membersAfter === 0, 'BV2 planBoundaryChange skips members on add and non-members on remove', { bvAdd, bvRemove });
const seven = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, hostName: `N${i}` }));
const bvMany = planBoundaryChange([...seven, seven[0]], new Set(), 'add', 10);
assert(bvMany.ids.length === 7 && bvMany.sampleNames.length === 5 && bvMany.moreCount === 2, 'BV3 planBoundaryChange dedupes and samples 5 names', bvMany);
assert(rowChangeNeedsConfirm('add', 0) && !rowChangeNeedsConfirm('add', 2) && rowChangeNeedsConfirm('remove', 1) && !rowChangeNeedsConfirm('remove', 3), 'BV4 a row change confirms only on the first add or the last remove');
const first = describeBoundaryChange({ direction: 'add', ids: ['a', 'b'], sampleNames: [], moreCount: 0, membersBefore: 0, membersAfter: 2, inventoryTotal: 40 }, 'Lab');
const last = describeBoundaryChange({ direction: 'remove', ids: ['a'], sampleNames: [], moreCount: 0, membersBefore: 1, membersAfter: 0, inventoryTotal: 40 }, 'Lab');
assert(first.includes('whole inventory (40 registered assets)') && first.includes('declares 2 assets') && last.includes('falls back to the whole inventory'), 'BV5 describeBoundaryChange names the fallback', { first, last });
const ctx = { supported: true, canEdit: true, hasActiveProgram: true, archived: false, status: 'ready' as const };
assert(
  boundaryEditBlock({ ...ctx, canEdit: false, status: 'loading' }) === 'viewer' && boundaryEditBlock({ ...ctx, archived: true }) === 'archived' && boundaryEditBlock({ ...ctx, status: 'error' }) === 'error'
    && boundaryEditBlock({ ...ctx, hasActiveProgram: false }) === 'loading' && boundaryEditBlock({ ...ctx, supported: false }) === 'unsupported' && boundaryEditBlock(ctx) === null,
  'BV6 boundaryEditBlock'
);
const e1 = boundaryErrorMessage({ reason: 'program_archived' });
const e2 = boundaryErrorMessage({ status: 409 });
const e3 = boundaryErrorMessage({ reason: 'unknown_assets' });
const e4 = boundaryErrorMessage({ status: 403 });
const e5 = boundaryErrorMessage(new Error('MEMBER-HOST-1'));
assert(e1.includes('archived') && e2.includes('archived') && e3.includes('Nothing was saved') && e4.includes('Tenant Owner') && !e5.includes('MEMBER-HOST-1'), 'BV7 boundaryErrorMessage is fixed copy and never echoes server text', { e1, e2, e3, e4, e5 });
assert(
  summaryCaption({ filter: 'IN', programName: 'Lab', declared: true, members: 3, inventoryTotal: 9 }).endsWith('3 declared assets.')
    && summaryCaption({ filter: 'IN', programName: 'Lab', declared: false, members: 0, inventoryTotal: 9 }).includes('whole inventory (no assets declared)')
    && summaryCaption({ filter: 'ALL', programName: 'Lab', declared: true, members: 3, inventoryTotal: 1 }).endsWith('1 registered asset.'),
  'BV8 summaryCaption'
);
assert(
  emptyTableMessage({ assetCount: 0, filter: 'ALL', programName: 'Lab', declared: false }).startsWith('No assets registered yet.')
    && emptyTableMessage({ assetCount: 3, filter: 'IN', programName: 'Lab', declared: false }).includes('has not declared any assets yet')
    && emptyTableMessage({ assetCount: 3, filter: 'IN', programName: 'Lab', declared: true }).startsWith('No assets in Lab match')
    && emptyTableMessage({ assetCount: 3, filter: 'NOT_IN', programName: 'Lab', declared: true }).startsWith('No asset outside')
    && emptyTableMessage({ assetCount: 3, filter: 'ALL', programName: 'Lab', declared: true }) === 'No enclave assets match your active filters.',
  'BV9 emptyTableMessage'
);
const bvBoundary = { ...emptyScopeSummary(), total: 2, inScope: 1 };
const bvInventory = { ...emptyScopeSummary(), total: 5 };
const bvLine = { assetsLoading: false, assetsError: false, status: 'ready' as const, programName: 'Lab', declared: true, boundary: bvBoundary, inventory: bvInventory };
assert(
  exportBoundaryLine(bvLine) === 'Asset boundary: Lab declares 2 of 5 assets (1 asset in CMMC scope). This document states only those.'
    && exportBoundaryLine({ ...bvLine, declared: false }).includes('has not declared its assets')
    && exportBoundaryLine({ ...bvLine, status: 'unsupported' }).startsWith('Asset boundary: the whole asset inventory')
    && exportBoundaryLine({ ...bvLine, status: 'error' }).includes('states no asset counts')
    && exportBoundaryLine({ ...bvLine, assetsLoading: true }).includes('loading'),
  'BV10 exportBoundaryLine'
);
const invMgr = read('src/components/telemetry/AssetInventoryManager.tsx');
const boundaryDialog = read('src/components/telemetry/ConfirmBoundaryChangeDialog.tsx');
const sspModal = read('src/components/reports/ArtifactExportModal.tsx');
assert(invMgr.includes('useProgramAssets') && invMgr.includes('>Programs</th>') && invMgr.includes('showBoundary ? 8 : 7') && (invMgr.match(/colSpan=\{columnCount\}/g) ?? []).length === 2 && !invMgr.includes('colSpan={7}'), 'UV1 the inventory has a Programs column and spans it');
assert(/disabled=\{boundaryBlock !== null \|\| !canEdit \|\| Boolean\(activeProgram\?\.archived\)\}/.test(invMgr) && invMgr.includes('aria-describedby={boundaryBlock ? boundaryReasonId : undefined}'), 'UV2 the row checkbox is disabled for viewers and archived programs and names its reason');
assert(!invMgr.includes('console.') && !boundaryDialog.includes('console.') && !read('src/data/boundaryView.ts').includes('console.'), 'UV3 the inventory, the dialog and the helper log nothing');
assert(sspModal.includes('boundaryAssets(inventory') && sspModal.includes('collectFipsModules(boundaryList)') && sspModal.includes('summarizeScope(boundaryList)') && !sspModal.includes('collectFipsModules(inventory)'), 'UV4 the SSP export and FIPS list follow the boundary');
assert(invMgr.includes('has not declared its assets: its SSP boundary uses the whole inventory.'), 'UV5 the inventory says when a program has declared nothing');
assert(boundaryDialog.includes('role="alertdialog"') && boundaryDialog.includes('max-h-[90vh]') && boundaryDialog.includes('z-[60]') && boundaryDialog.includes('autoFocus') && boundaryDialog.includes('busyRef') && boundaryDialog.includes('<ErrorNotice') && boundaryDialog.includes('boundaryErrorMessage(err)'), 'UV6 ConfirmBoundaryChangeDialog follows the alertdialog pattern');
assert(invMgr.includes('<ConfirmBoundaryChangeDialog') && invMgr.includes('planBoundaryChange(') && invMgr.includes('Add shown to boundary') && invMgr.includes('Remove shown from boundary') && invMgr.includes('rowChangeNeedsConfirm('), 'UV7 the inventory offers bulk and row changes with confirmation');
assert(invMgr.includes("const showBoundary = programsStatus !== 'unsupported';") && invMgr.includes('{canEdit && <FailedMoveAssetsNotice />}'), 'UV8 browser-only tenants have no boundary column and the failed-move notice is untouched');
assert(sspModal.includes('exportBoundaryLine(') && sspModal.includes('data-testid="ssp-boundary-scope"') && sspModal.includes('useProgramAssets({ enabled: isOpen })'), 'UV9 the SSP preview states which assets the document covers');

console.log('--- no stale scope identifiers ---');
for (const rel of FILES) assert(!read(rel).includes('liveControlsTenantId'), `${path.basename(rel)} does not reference liveControlsTenantId`);

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
