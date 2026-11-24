import fs from 'fs';
import path from 'path';
import {
  CONTROL_READ_ONLY_NOTE,
  assessmentMethodBanner,
  metWithOpenParametersWarning,
  parameterCounts,
  parameterLinkLabel,
  parameterSummaryText,
  poamPointerText,
} from '../src/data/controlDialogView';
import { cmmcGuideParameters } from '../src/data/cmmcGuide/parameters';
import { setParameterValue } from '../src/data/frameworks/parameters';
import { statusDisplayLabel } from '../src/data/statusLabels';

/**
 * Control dialog (#325, #326): the parameter summary and warning, the POA&M pointer, the read-only note and the assessment-method
 * banner per framework. Pure test: no server, no browser.
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

console.log('--- Parameter counts and summary ---');
const zero = parameterCounts([], '');
assert(zero.total === 0 && zero.set === 0 && zero.open === 0 && parameterSummaryText(zero, true) === null, 'P1 no parameters: zero counts and no summary');

const ps = cmmcGuideParameters('AC.L2-3.1.8');
assert(ps.length >= 2, `P2 3.1.8 has at least two parameters (found: ${ps.length})`);
const openCounts = parameterCounts(ps, '');
assert(openCounts.total === ps.length && openCounts.open === ps.length && openCounts.set === 0, 'P2 all are open with empty notes', openCounts);
const notes1 = setParameterValue('', ps[0], 'every 90 days');
const oneSet = parameterCounts(ps, notes1);
assert(oneSet.set === 1 && oneSet.open === ps.length - 1, 'P2 setting one value counts it as set', oneSet);
assert(parameterSummaryText(oneSet, true) === `${ps.length} parameters, 1 set.`, 'P2 the summary says how many are set', parameterSummaryText(oneSet, true));

const allSet = { total: 3, set: 3, open: 0 };
const noneSet = { total: 3, set: 0, open: 3 };
const single = { total: 1, set: 0, open: 1 };
assert(parameterSummaryText(allSet, true)?.endsWith('all set.') === true && parameterLinkLabel(allSet).startsWith('See'), 'P3 all set: "all set." and a See link');
assert(parameterSummaryText(noneSet, true)?.endsWith('none set yet.') === true && parameterLinkLabel(noneSet) === 'Set them on the SSP tab', 'P3 none set: "none set yet." and a Set link');
assert(parameterSummaryText(single, true) === '1 parameter, not set yet.' && parameterLinkLabel(single) === 'Set it on the SSP tab', 'P3 a single open parameter is worded in the singular');
assert(parameterSummaryText({ total: 1, set: 1, open: 0 }, true) === '1 parameter, set.' && parameterLinkLabel({ total: 1, set: 1, open: 0 }) === 'See it on the SSP tab', 'P3 a single set parameter');
assert(parameterSummaryText(noneSet, false) === '3 parameters (values not loaded yet).' && parameterSummaryText(single, false) === '1 parameter (value not loaded yet).', 'P3 not loaded: says the values are not loaded yet');

console.log('--- Met with open parameters ---');
assert(metWithOpenParametersWarning('MET', { total: 3, set: 1, open: 2 })?.includes('2 of 3 parameters are still open') === true, 'P4 Met with open parameters warns');
assert(metWithOpenParametersWarning('MET', { total: 1, set: 0, open: 1 })?.includes('1 of 1 parameter is still open') === true, 'P4 singular wording');
assert(metWithOpenParametersWarning('NOT_MET', { total: 3, set: 1, open: 2 }) === null, 'P4 Not met has no warning');
assert(metWithOpenParametersWarning('MET', { total: 3, set: 3, open: 0 }) === null, 'P4 Met with nothing open has no warning');

console.log('--- POA&M pointer ---');
assert(poamPointerText('NOT_MET', true) === `This control is ${statusDisplayLabel('NOT_MET')}, so it is on the POA&M.`, 'Q1 Not met points at the POA&M');
assert(poamPointerText('IN_PROGRESS', true) !== null, 'Q2 In progress points at the POA&M');
assert(poamPointerText('MET', true) === null && poamPointerText('NOT_STARTED', true) === null, 'Q2 Met and Not started have no pointer');
assert(poamPointerText('NOT_MET', false)?.endsWith('allows no open POA&M items at assessment.') === true, 'Q3 a framework with no open POA&M items says so');

console.log('--- Read-only note ---');
assert(!CONTROL_READ_ONLY_NOTE.includes('—') && !CONTROL_READ_ONLY_NOTE.includes('–'), 'R1 the read-only note has no em dash');

console.log('--- Assessment method banner ---');
const b1 = assessmentMethodBanner('CMMC_L1', 'CMMC_L1');
assert(b1.title.startsWith('Self-assessment') && !`${b1.title} ${b1.body}`.includes('C3PAO') && !`${b1.title} ${b1.body}`.includes('Level 2'), 'B1 Level 1 is a self-assessment: no C3PAO, no Level 2');
const b2 = assessmentMethodBanner(undefined, 'CMMC_L2');
assert(b2.body.includes('Assessment Guide Level 2') && b2.body.includes('verified as Met or Not applicable'), 'B2 Level 2 keeps the Level 2 guide sentence');
const b3 = assessmentMethodBanner('NIST_800_53_REV5', 'NIST_800_53_REV5');
assert(b3.body.includes('800-53A') && !`${b3.title} ${b3.body}`.includes('C3PAO'), 'B3 800-53 cites 800-53A and not C3PAO');
const b4 = assessmentMethodBanner('NIST_800_171_R3', 'NIST_800_171_R3');
assert(b4.body.includes('Rev. 3') && !`${b4.title} ${b4.body}`.includes('CMMC'), 'B4 800-171 Rev. 3 has no CMMC wording');
const b5 = assessmentMethodBanner(undefined, 'SOC_2_TYPE_II');
assert(b5.body.startsWith('Each determination statement of the control') && !`${b5.title} ${b5.body}`.includes('CMMC'), 'B5 any other framework gets the generic wording');
assert(assessmentMethodBanner('CMMC_L2', 'CMMC_L1').title.startsWith('Self-assessment'), 'B6 a CMMC program decides the wording, not the control record');

console.log('--- Source pins (InspectDocumentModal) ---');
const modal = read('src/components/matrix/InspectDocumentModal.tsx');
assert(modal.includes('parameterSummaryText(paramCounts, notesEditable)'), 'S1 the summary follows whether the notes are loaded');
assert(modal.includes('metWithOpenParametersWarning(storedStatus, paramCounts)'), 'S2 the warning reads the recorded status');
assert(modal.includes("requestFocus('poam_control', control.id, 'poam')"), 'S3 the POA&M button asks for the control row');
assert(/\{!canEdit && \([\s\S]*?CONTROL_READ_ONLY_NOTE/.test(modal), 'S4 a read-only role sees the note');
assert(modal.includes('aria-label="Previous control"') && modal.includes('aria-label="Next control"') && modal.includes('aria-label="Close"'), 'S5 the header buttons have names');
assert(modal.includes('assessmentMethodBanner('), 'S6 the banner follows the program framework');
assert(!modal.includes('storagePathLabel') && modal.includes('useStorageConfig(currentTenant)'), 'S7 the host storage path is not shown, the storage config is still read');
assert(!modal.includes('C3PAO'), 'S8 the dialog has no C3PAO wording');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
