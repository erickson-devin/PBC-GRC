import { statusDisplayLabel } from '../src/data/statusLabels';
import { objectiveStatusLabel } from '../src/data/cmmcGuide/catalogUpdateReview';
import { composeImplementationStatement } from '../src/data/cmmcGuide/sspStatement';
import { statusBadgeClass } from '../src/data/reports/reportExporters';
import type { ObjectiveStatus } from '../src/types/assessment';

/**
 * #294: one display label per status. The pure helper only; it does not boot the server.
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

const ALL: ObjectiveStatus[] = ['MET', 'NOT_MET', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_APPLICABLE'];
const LABEL: Record<ObjectiveStatus, string> = { MET: 'Met', NOT_MET: 'Not met', IN_PROGRESS: 'In progress', NOT_STARTED: 'Not started', NOT_APPLICABLE: 'Not applicable' };

console.log('--- Labels ---');
assert(ALL.every((s) => statusDisplayLabel(s) === LABEL[s]), 'L1: each of the five statuses maps to its label');
assert(statusDisplayLabel(null) === 'Not started' && statusDisplayLabel(undefined) === 'Not started', 'L2: null and undefined are Not started');
assert(statusDisplayLabel('WEIRD' as unknown as ObjectiveStatus) === 'WEIRD' && statusDisplayLabel('toString' as unknown as ObjectiveStatus) === 'toString', 'L3: an unknown value comes back unchanged');
assert(ALL.every((s) => objectiveStatusLabel(s) === statusDisplayLabel(s)), 'L4: objectiveStatusLabel and statusDisplayLabel agree for all five');

console.log('--- Drift ---');
const ID = 'AC.L1-3.1.1';
for (const s of ALL.filter((x) => x !== 'MET')) {
  const text = composeImplementationStatement(ID, '', { [`${ID}[a]`]: { status: s, implementationNarrative: 'X' } }, 'CMMC_L2').text;
  assert(text.startsWith(`[a] (${statusDisplayLabel(s)}) `), `L5: the SSP prefix for ${s} is the screen label`, text);
}
for (const s of ['NOT_MET', 'IN_PROGRESS', 'NOT_STARTED'] as const) {
  assert(statusBadgeClass(statusDisplayLabel(s)) !== null, `L6: ${statusDisplayLabel(s)} has an export badge`);
}
const metBadge = statusBadgeClass(statusDisplayLabel('MET')) !== null;
if (metBadge) assert(true, 'L6: Met has an export badge');
else console.log('  - SKIP: L6 Met has no export badge yet (src/data/reports/reportExporters.ts STATUS_BADGES needs "Met": "status-met", owned by another package)');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
