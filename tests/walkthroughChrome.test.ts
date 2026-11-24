import fs from 'fs';
import path from 'path';
import { frameworkHasBaselines } from '../src/data/frameworkCapabilities';
import { chromeProgramState, noProgramChromeLabel } from '../src/data/noProgramChromeView';

/**
 * Walkthrough findings (#325, #326, #327): baselines only where a framework has them, reference-only mappings, the neutral header and
 * sidebar before the first program, the sign-in page copy, the notice settings link and the dashboard storage line.
 * Pure test: reads source files, no server, no browser.
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

console.log('--- F: baselines only where they exist ---');
assert(frameworkHasBaselines('NIST_800_53_REV5') && frameworkHasBaselines('nist-800-53-r5'), 'F1 NIST SP 800-53 Rev. 5 has baselines, under its id and its alias');
assert(['CMMC_L1', 'CMMC_L2', 'NIST_800_171_R3', 'SOC_2_TYPE_II', 'HIPAA_SECURITY', 'bogus'].every((fw) => !frameworkHasBaselines(fw)), 'F1 the other frameworks and an unknown id have none');
const matrix = read('src/components/dashboard/AssessmentMatrix.tsx');
assert(matrix.includes('frameworkHasBaselines(activeFramework) && (') && matrix.includes('Reference mappings'), 'F2 the matrix offers the baseline filter only with baselines and names the mapping column "Reference mappings"');
const card = read('src/components/dashboard/ControlCard.tsx');
assert(card.includes('control.baselineImpact && frameworkHasBaselines(activeFramework)') && card.includes('Reference only:') && !card.includes('Equivalencies:'), 'F3 the card shows the baseline badge only with baselines and labels the mappings "Reference only:"');

console.log('--- C: neutral header and sidebar before the first program ---');
const gateNone = { kind: 'none' as const, canCreate: true };
const gateArchived = { kind: 'all-archived' as const, canCreate: false };
assert(chromeProgramState({ serverBacked: false, hasActiveProgram: false, gate: null }) === 'program', 'C1 browser-only mode shows the program numbers');
assert(chromeProgramState({ serverBacked: true, hasActiveProgram: true, gate: null }) === 'program', 'C2 a server tenant with an active program shows the numbers');
assert(chromeProgramState({ serverBacked: true, hasActiveProgram: false, gate: null }) === 'loading', 'C3 no program and no gate yet is loading');
assert(chromeProgramState({ serverBacked: true, hasActiveProgram: false, gate: gateNone }) === 'none', 'C4 a tenant without programs is none');
assert(chromeProgramState({ serverBacked: true, hasActiveProgram: false, gate: gateArchived }) === 'all-archived', 'C5 only archived programs is all-archived');
const labels = [noProgramChromeLabel('none'), noProgramChromeLabel('all-archived'), noProgramChromeLabel('loading')];
assert(labels[0] === 'No program yet' && labels[1] === 'No open program' && labels[2] === 'Loading programs…', 'C6 the labels read exactly', labels);
assert(labels.every((l) => !l.includes('—') && !l.includes('Compliant')), 'C6 no label has an em dash or claims compliance', labels);
const header = read('src/components/layout/Header.tsx');
const sidebar = read('src/components/layout/Sidebar.tsx');
assert(header.includes('chromeProgramState(') && header.includes('noProgramChromeLabel(chrome)') && sidebar.includes('chromeProgramState(') && sidebar.includes('noProgramChromeLabel(chrome)'), 'C7 the header and the sidebar use the chrome state and its label');

console.log('--- L: sign-in page ---');
assert(!read('src/components/auth/LoginPage.tsx').includes('CMMC') && !read('src/components/auth/ProtectedRoute.tsx').includes('CMMC'), 'L1 the sign-in page and the protected route do not name CMMC');

console.log('--- T: notice settings, D: dashboard ---');
const notice = read('src/components/admin/SystemUseNoticeSection.tsx');
assert(notice.includes('<AccountSettingsModal') && notice.includes('Open Account Settings'), 'T1 the notice settings link opens the account settings');
assert(!read('src/components/dashboard/ComplianceOverview.tsx').includes('storagePathLabel'), 'D1 the dashboard does not print the storage path');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
