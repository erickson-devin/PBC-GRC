import {
  SPRS_FIVE_POINT_REQUIREMENTS,
  SPRS_THREE_POINT_REQUIREMENTS,
  SPRS_MAX_SCORE,
  SPRS_MIN_SCORE,
  SPRS_TOTAL_POSSIBLE_DEDUCTION,
  calculateSprsScore,
  extractNistRequirementId,
  formatSprsScore,
  generateSprsAssessmentSummary,
  getSprsPointDeduction,
  isSspComplete,
} from '../src/data/reports/sprsCompiler';
import { CMMC_LEVEL_2_CONTROLS as CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import type { ControlState, ControlStatus } from '../src/types/cmmc';
import type { ReportMetadata } from '../src/types/report';

/**
 * NIST SP 800-171 DoD Assessment Methodology v1.2.1 (Annex A):
 * score = 110 - sum(value of each requirement not implemented); 3.12.4 (SSP) is "NA" and gates scoring.
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

const SSP = {
  systemName: 'Test Enclave',
  organizationName: 'Test Org',
  systemOwner: 'Owner',
  systemBoundaryScope: 'All CUI systems',
};
const sspId = CONTROLS.find((c) => extractNistRequirementId(c.id) === '3.12.4')!.id;

const states = (defaultStatus: ControlStatus, overrides: Record<string, ControlStatus> = {}): Record<string, ControlState> =>
  Object.fromEntries(
    CONTROLS.map((c) => [
      c.id,
      {
        id: c.id,
        status: overrides[c.id] ?? defaultStatus,
        implementationNotes: '',
        responsibleRole: 'ISSO',
        lastUpdated: '2026-01-01',
        tags: [],
      } as ControlState,
    ])
  );
const idOf = (nist: string) => CONTROLS.find((c) => extractNistRequirementId(c.id) === nist)!.id;

console.log('--- Annex A weight table ---');
let c5 = 0, c3 = 0, c1 = 0, c0 = 0, sum = 0;
for (const c of CONTROLS) {
  const w = getSprsPointDeduction(c.id);
  sum += w;
  if (w === 5) c5++; else if (w === 3) c3++; else if (w === 1) c1++; else c0++;
}
assert(CONTROLS.length === 110, 'catalog has 110 requirements');
assert(c5 === 44 && c3 === 14 && c1 === 51 && c0 === 1, `44 x 5pt, 14 x 3pt, 51 x 1pt, 1 x NA (found ${c5}/${c3}/${c1}/${c0})`);
assert(sum === 313 && sum === SPRS_TOTAL_POSSIBLE_DEDUCTION, 'weights total 313');
assert(SPRS_MAX_SCORE - sum === SPRS_MIN_SCORE, '110 - 313 = -203 by arithmetic, no special case needed');
assert(SPRS_FIVE_POINT_REQUIREMENTS.size === 44 && SPRS_THREE_POINT_REQUIREMENTS.size === 14, 'weight sets have the published sizes');
assert(getSprsPointDeduction('3.12.4') === 0 && getSprsPointDeduction(sspId) === 0, '3.12.4 (SSP) has no point value');
for (const [req, w] of [['3.1.1', 5], ['3.5.3', 5], ['3.13.11', 5], ['3.4.8', 5], ['3.1.14', 1], ['3.3.2', 3], ['3.1.5', 3], ['3.12.2', 3]] as const) {
  assert(getSprsPointDeduction(req) === w, `${req} carries ${w} point(s)`);
}

console.log('\n--- Score arithmetic ---');
assert(calculateSprsScore(CONTROLS, states('MET'), SSP).score === 110, 'all met = +110');
assert(calculateSprsScore(CONTROLS, states('NOT_MET', { [sspId]: 'MET' }), SSP).score === -203, 'all weighted requirements unmet = exactly -203');
const oneMet = calculateSprsScore(CONTROLS, states('NOT_MET', { [sspId]: 'MET', [idOf('3.1.3')]: 'MET' }), SSP);
assert(oneMet.score === -202, 'meeting one 1-point requirement adds exactly 1 (no discontinuity at the floor)', oneMet.score);
const fiveMet = calculateSprsScore(CONTROLS, states('NOT_MET', { [sspId]: 'MET', [idOf('3.1.1')]: 'MET' }), SSP);
assert(fiveMet.score === -198, 'meeting one 5-point requirement adds exactly 5', fiveMet.score);
assert(calculateSprsScore(CONTROLS, states('MET', { [idOf('3.1.1')]: 'NOT_MET' }), SSP).score === 105, 'one unmet 5-point requirement = 105');
assert(calculateSprsScore(CONTROLS, states('MET', { [idOf('3.1.5')]: 'NOT_MET' }), SSP).score === 107, 'one unmet 3-point requirement = 107');
assert(calculateSprsScore(CONTROLS, states('MET', { [idOf('3.1.3')]: 'NOT_MET' }), SSP).score === 109, 'one unmet 1-point requirement = 109');
const mixed = calculateSprsScore(
  CONTROLS,
  states('MET', { [idOf('3.1.1')]: 'NOT_MET', [idOf('3.1.5')]: 'IN_PROGRESS', [idOf('3.1.3')]: 'NOT_STARTED' }),
  SSP
);
assert(mixed.score === 101 && mixed.totalDeductions === 9, 'IN_PROGRESS and NOT_STARTED are unimplemented: 110 - (5+3+1) = 101');
assert(
  mixed.deductionsByWeight.fivePoint.length === 1 &&
    mixed.deductionsByWeight.threePoint.length === 1 &&
    mixed.deductionsByWeight.onePoint.length === 1,
  'deductions are bucketed by weight'
);

// Meeting requirements one at a time (lightest first) never lowers the score and stays inside -203..110.
let previous = -Infinity;
let monotone = true;
let inRange = true;
const order = CONTROLS.filter((c) => c.id !== sspId).sort((a, b) => getSprsPointDeduction(a.id) - getSprsPointDeduction(b.id));
const running: Record<string, ControlStatus> = {};
CONTROLS.forEach((c) => (running[c.id] = c.id === sspId ? 'MET' : 'NOT_MET'));
for (let i = -1; i < order.length; i++) {
  if (i >= 0) running[order[i].id] = 'MET';
  const score = calculateSprsScore(CONTROLS, states('NOT_MET', running), SSP).score as number;
  if (score < previous) monotone = false;
  if (score < SPRS_MIN_SCORE || score > SPRS_MAX_SCORE) inRange = false;
  previous = score;
}
assert(monotone, 'meeting more requirements never lowers the score');
assert(inRange && previous === 110, 'score stays within -203..110 and ends at 110');

console.log('\n--- SSP gate (requirement 3.12.4) ---');
const allMet = states('MET');
const noSspControl = calculateSprsScore(CONTROLS, states('MET', { [sspId]: 'NOT_MET' }), SSP);
assert(noSspControl.score === null && noSspControl.scoreStatus === 'NOT_SCORED', '3.12.4 not MET => Not Scored');
assert(Boolean(noSspControl.notScoredReason), 'a reason is reported when not scored');
assert(noSspControl.metCount === 109, 'counts are still reported when not scored');
assert(calculateSprsScore(CONTROLS, states('MET', { [sspId]: 'IN_PROGRESS' }), SSP).score === null, 'SSP in progress => Not Scored');
assert(calculateSprsScore(CONTROLS, states('NOT_STARTED'), SSP).score === null, 'nothing started => Not Scored (never a number)');
assert(calculateSprsScore(CONTROLS, allMet, null).score === null, 'no SSP metadata at all => Not Scored');
assert(calculateSprsScore(CONTROLS, allMet, undefined).score === null, 'undefined SSP metadata => Not Scored');
for (const field of ['systemName', 'organizationName', 'systemOwner', 'systemBoundaryScope'] as const) {
  assert(calculateSprsScore(CONTROLS, allMet, { ...SSP, [field]: '   ' }).score === null, `blank ${field} => Not Scored`);
}
assert(!isSspComplete(CONTROLS.filter((c) => c.id !== sspId), allMet, SSP), 'catalog without 3.12.4 => SSP not complete');
assert(isSspComplete(CONTROLS, allMet, SSP), 'complete SSP => gate open');
assert(calculateSprsScore(CONTROLS, allMet, SSP).scoreStatus === 'SCORED', 'complete SSP => SCORED');
assert(formatSprsScore({ score: null }) === 'Not Scored', 'formats null as "Not Scored"');
assert(
  formatSprsScore({ score: 105 }) === '+105' && formatSprsScore({ score: -12 }) === '-12' && formatSprsScore({ score: 0 }) === '0',
  'formats scored values'
);

console.log('\n--- SPRS submission summary ---');
const meta = {
  systemName: 'Test Enclave',
  organizationName: 'Test Org',
  systemOwner: 'Owner',
  boundaryDescription: 'All CUI systems',
  cageCode: '1ABC2',
  assessmentDate: '2026-01-01',
  primaryAssessor: 'A',
  samStatus: 'ACTIVE',
} as unknown as ReportMetadata;
const gated = generateSprsAssessmentSummary(CONTROLS, states('MET', { [sspId]: 'NOT_MET' }), meta) as { sprsMetrics: Record<string, unknown> };
assert(
  gated.sprsMetrics.activeSprsScore === 'NOT SCORED' && gated.sprsMetrics.scoreStatus === 'NOT_SCORED',
  'summary reports NOT SCORED without an SSP'
);
const scored = generateSprsAssessmentSummary(CONTROLS, allMet, meta) as { sprsMetrics: Record<string, unknown> };
assert(
  scored.sprsMetrics.activeSprsScore === 110 && scored.sprsMetrics.compliancePosture === 'Full NIST SP 800-171 Compliance',
  'summary reports 110 with a complete SSP'
);

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
