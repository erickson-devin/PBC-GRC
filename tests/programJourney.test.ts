import fs from 'fs';
import path from 'path';
import { computeJourney, firstIncompleteSspSection, journeyProgress, sspControlGate, type JourneyInput } from '../src/data/journey/programJourney';
import { computeSspCompleteness } from '../src/data/ssp/sspCompleteness';
import { getExportGaps, exportFormDefaults } from '../src/data/reports/exportReadiness';
import type { ProgramSummary } from '../src/types/programSummary';

/**
 * #251: the program journey. Six steps, each defined once on top of the existing rules: the SSP completeness registry, the inventory items, the
 * expected-documents counts and the export gaps. Pure: every expected value is computed in the test from the same rules.
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

const summary = (over: Partial<ProgramSummary> = {}): ProgramSummary => ({
  programId: 'p1',
  generatedAt: '2027-01-01T00:00:00.000Z',
  people: { ownerLevelMembers: 1, primaryContactSet: true },
  inventory: { supported: true, tools: [], handlesFci: null, categories: [] },
  documents: { supported: true, approvedCount: 0, overdueCount: 0, expected: { present: 2, total: 5 }, recommendedPresent: 1, recommendedTotal: 3 },
  reviews: { reviewed: 1, total: 4 },
  poam: { openCount: 0, datedCount: 0, undatedCount: 0, latestDate: null, latestSource: null, overdueCount: 0 },
  ...over,
});

const input = (framework: string, over: Partial<JourneyInput> = {}): JourneyInput => ({
  framework,
  serverBacked: true,
  members: { ownerLevel: 1 },
  summary: summary(),
  ssp: computeSspCompleteness({ framework, metadata: {}, profile: null }),
  assess: { total: 110, met: 0, inProgress: 0, notMet: 0, objectives: null },
  exportGaps: [],
  sprsGate: null,
  ...over,
});

const step = (steps: ReturnType<typeof computeJourney>, id: string) => steps.find((s) => s.id === id)!;

console.log('\n--- J0: six steps in order ---');
{
  const steps = computeJourney(input('CMMC_L2'));
  assert(steps.map((s) => s.id).join(',') === 'people,tools,documents,assess,ssp,export', 'J0 the six steps, in order');
  assert(steps.every((s) => s.label !== '' && s.figureText !== ''), 'J0 every step has a label and a figure text');
}

console.log('\n--- J1: SSP step and People roles check come from the completeness registry ---');
{
  const ssp = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null });
  const steps = computeJourney(input('CMMC_L2', { ssp }));
  const s = step(steps, 'ssp');
  const totalRequired = ssp.sections.reduce((n, x) => n + x.requiredTotal, 0);
  assert(s.total === totalRequired && totalRequired > 0, 'J1 SSP total is the sum of the sections required totals', { total: s.total });
  assert(s.done === totalRequired - ssp.requiredMissing, 'J1 SSP done is total minus the required missing');
  assert(s.state === 'not_started', 'J1 an empty SSP is not started', s.state);
  const roles = ssp.sections.find((x) => x.sectionId === 'roles')!;
  const c = step(steps, 'people').checks.find((x) => x.count !== undefined && x.id.includes('roles'));
  assert(!!c && c.count!.done === roles.requiredTotal - roles.requiredMissing && c.count!.total === roles.requiredTotal, 'J1 People roles check carries the roles section figures', c);
  assert(s.checks.some((x) => x.id === 'reviews' && x.severity === 'advisory' && x.count?.done === 1 && x.count.total === 4), 'J1 the sign-off check is advisory');
  assert(s.state !== 'complete' && s.target.sspSection === 'identification', 'J1 the SSP target opens the first incomplete section');
}

console.log('\n--- J2: SOC 2 ---');
{
  const steps = computeJourney(input('SOC_2_TYPE_II', { summary: summary({ documents: null }) }));
  assert(step(steps, 'documents').state === 'not_applicable', 'J2 documents are not applicable without a catalog');
  assert(step(steps, 'documents').reason !== undefined && step(steps, 'documents').total === 0, 'J2 a not-applicable step shows a reason and no figure');
  assert(step(steps, 'tools').optional === true, 'J2 tools are optional (every item advisory)');
  const l2 = computeJourney(input('CMMC_L2'));
  assert(step(l2, 'tools').optional === false, 'J2 tools are not optional for CMMC Level 2');
}

console.log('\n--- J3: a browser-only organization ---');
{
  const steps = computeJourney(input('CMMC_L2', { serverBacked: false, summary: null }));
  assert(step(steps, 'tools').state === 'unavailable' && step(steps, 'documents').state === 'unavailable', 'J3 tools and documents are unavailable');
  assert(step(steps, 'tools').figureText === step(steps, 'tools').reason, 'J3 an unavailable step shows its reason instead of a figure');
  assert(!step(steps, 'ssp').checks.some((c) => c.id === 'reviews'), 'J3 the SSP step has no sign-off check');
  assert(!step(steps, 'people').checks.some((c) => c.id === 'primary_contact'), 'J3 the People step has no primary-contact check');
  const p = journeyProgress(steps);
  assert(p.applicable === 4, 'J3 progress leaves the unavailable steps out', p);
  const unset = computeJourney(input('CMMC_L2', { summary: summary({ people: { ownerLevelMembers: 1, primaryContactSet: null } }) }));
  assert(!step(unset, 'people').checks.some((c) => c.id === 'primary_contact'), 'J3 a field that is not available adds no primary-contact check');
}

console.log('\n--- J4: Assess ---');
{
  const a = (assess: JourneyInput['assess']) => step(computeJourney(input('CMMC_L2', { assess })), 'assess');
  const done = a({ total: 110, met: 100, notMet: 10, inProgress: 0, objectives: null });
  assert(done.state === 'complete' && done.done === 110 && done.figureText.includes('100 Met'), 'J4 every control decided is complete, Met shown beside it', done.figureText);
  assert(a({ total: 110, met: 0, notMet: 0, inProgress: 0, objectives: null }).state === 'not_started', 'J4 nothing decided or in progress is not started');
  assert(a({ total: 110, met: 0, notMet: 0, inProgress: 1, objectives: null }).state === 'in_progress', 'J4 one in progress is in progress');
  assert(a({ total: 110, met: 109, notMet: 0, inProgress: 0, objectives: null }).state === 'in_progress', 'J4 one control undecided is in progress');
  const withObj = a({ total: 10, met: 10, notMet: 0, inProgress: 0, objectives: { answered: 3, total: 9 } });
  assert(withObj.checks.some((c) => c.id === 'objectives' && c.count?.done === 3 && c.count.total === 9 && c.severity === 'advisory'), 'J4 objectives answered is an advisory check while known');
  assert(!a({ total: 10, met: 10, notMet: 0, inProgress: 0, objectives: null }).checks.some((c) => c.id === 'objectives'), 'J4 no objectives check while they are not ready');
}

console.log('\n--- J5: Export ---');
{
  const gaps = getExportGaps('NIST_SP_800_18_SSP', {}, { profile: null, framework: 'CMMC_L2' });
  const blocking = gaps.filter((g) => !g.advisory).length;
  const s = step(computeJourney(input('CMMC_L2', { exportGaps: gaps })), 'export');
  assert(blocking > 0 && s.done === blocking && s.state === 'in_progress', 'J5 the export figure is the blocking gaps', { blocking, state: s.state });
  const ready = step(computeJourney(input('CMMC_L2', { exportGaps: [], sprsGate: [] })), 'export');
  assert(ready.state === 'complete' && ready.done === 0, 'J5 no gaps and an open gate is complete');
  const gated = step(computeJourney(input('CMMC_L2', { exportGaps: [], sprsGate: ['Requirement 3.12.4 (System Security Plan) is not marked MET'] })), 'export');
  assert(gated.state !== 'complete' && gated.done === 1, 'J5 an SSP requirement gap keeps the export from complete');
  const dup = step(computeJourney(input('CMMC_L2', { exportGaps: [], sprsGate: ['System name is empty in the SSP'] })), 'export');
  assert(dup.state === 'complete', 'J5 an identity field gap is an export gap already and is not counted twice');
  assert(sspControlGate(null).length === 0 && sspControlGate(['System name is empty in the SSP', 'x']).length === 1, 'J5 sspControlGate keeps the requirement entry only');
  const advisoryOnly = step(computeJourney(input('CMMC_L2', { exportGaps: [{ field: 'cageCode', label: 'CAGE code', advisory: true }] })), 'export');
  assert(advisoryOnly.state === 'complete', 'J5 an advisory gap does not block');
}

console.log('\n--- J6: first incomplete section ---');
{
  assert(firstIncompleteSspSection(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null })) === 'identification', 'J6 an empty SSP starts at identification');
  const none = { sections: [], requiredMissing: 0, advisoryMissing: 0, complete: true };
  assert(firstIncompleteSspSection(none) === null, 'J6 nothing missing gives null');
}

console.log('\n--- J7: the export form prefill ---');
{
  const d = exportFormDefaults({
    meta: {},
    tenant: { name: 'Org', systemName: 'S', cageCode: '', samStatus: '', systemOwner: '', systemBoundaryScope: 'T' },
    program: { boundarySummary: 'P' },
    framework: 'CMMC_L2',
  });
  assert(d.boundaryDescription === 'P' && d.organizationName === 'Org' && d.systemName === 'S', 'J7 program boundary, tenant organization and system name', d);
  const t = exportFormDefaults({ meta: { systemBoundaryScope: 'M' }, tenant: { name: 'Org', systemName: '', cageCode: '', samStatus: '', systemOwner: '', systemBoundaryScope: 'T' }, program: null, framework: 'CMMC_L2' });
  assert(t.boundaryDescription === 'M', 'J7 the saved value wins');
  const u = exportFormDefaults({ meta: {}, tenant: { name: 'Org', systemName: '', cageCode: '', samStatus: '', systemOwner: '', systemBoundaryScope: 'T' }, program: { boundarySummary: '' }, framework: 'CMMC_L2' });
  assert(u.boundaryDescription === 'T' && u.framework === 'CMMC_L2', 'J7 an empty program summary falls back to the tenant');
}

console.log('\n--- J8: the journey defines no rule of its own ---');
{
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'journey', 'programJourney.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert(!src.includes("'role:") && !src.includes("'maintenance:") && !src.includes("'inventory:") && !src.includes("'tool:") && !src.includes("'documents:"), 'J8 no completeness item id literal');
  assert(!/\b(localStorage|sessionStorage|console\.|fetch\(|Date\.now|new Date)/.test(src), 'J8 no storage, console, network or clock');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
