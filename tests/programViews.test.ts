import fs from 'fs';
import path from 'path';

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
assert(/getControls\(tenant\.id, \{ framework: tenant\.primaryFramework \}, null\)/.test(admin), 'SuperAdminDashboard.tsx exports the default program (null)');
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
assert(/activeProgram\?\.privacyBaseline/.test(switcher) && /disabled=\{Boolean\(o\.disabledReason\)\}/.test(switcher), 'FrameworkSwitcher.tsx disables the No PII overlay for a privacy program');
assert(/activeProgram\?\.privacyBaseline && storedOverlayFilters\.noPiiProcessing/.test(read('src/context/TenantContext.tsx')), 'TenantContext.tsx does not apply No PII processing to a privacy program');
assert(/value="PRIVACY"/.test(matrix) && /baselines\[selectedBaselineFilter\.toLowerCase\(\)/.test(matrix) && /\+ Privacy/.test(matrix), 'AssessmentMatrix.tsx has the Privacy filter and label');
assert(/coverage\?\.privacy/.test(ssp), 'SspImportView.tsx marks an import that covered the privacy baseline');

console.log('--- no stale scope identifiers ---');
for (const rel of FILES) assert(!read(rel).includes('liveControlsTenantId'), `${path.basename(rel)} does not reference liveControlsTenantId`);

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
