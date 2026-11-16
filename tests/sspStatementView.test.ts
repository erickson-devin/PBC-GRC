import { cmmcNumberOf, guideObjectives } from '../src/data/cmmcGuide/guide';
import { getControlObjectives, hasWrittenTemplate } from '../src/data/cmmcGuide/objectives';
import { objectiveNarrativePrints } from '../src/data/cmmcGuide/sspStatement';
import { hasSspStatement, objectiveNarrativesInSsp, objectiveSspBadge, sspPreviewCaption, sspStatementLabel } from '../src/data/cmmcGuide/sspStatementView';
import type { ObjectiveStatus } from '../src/types/assessment';

/**
 * #293 / #294: the badge beside an objective narrative, the statement label and the SSP preview caption. The pure helpers only; it
 * does not boot the server.
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

const ID = 'AC.L1-3.1.1';
const L2 = 'CMMC_L2';
const letters = guideObjectives(cmmcNumberOf(ID)!, L2).map((g) => g.letter);
const o = (status: ObjectiveStatus, implementationNarrative: string, prefilledTemplate = 'T') => ({ status, implementationNarrative, prefilledTemplate });

console.log('--- Badge ---');
assert(objectiveNarrativesInSsp(ID, L2) && !objectiveNarrativesInSsp('AC-2', L2) && !objectiveNarrativesInSsp(ID, 'NIST_800_53'), 'B0: only CMMC controls add objective narratives');
assert(objectiveSspBadge('AC-2', 'NIST_800_53', o('MET', 'text'), '') === null && objectiveSspBadge(ID, 'NIST_800_53', o('MET', 'text'), '') === null, 'B1: non-CMMC has no badge');
assert(objectiveSspBadge(ID, L2, o('MET', '   '), '') === null, 'B2: a blank narrative has no badge');
assert(objectiveSspBadge(ID, L2, o('MET', 'Edited'), '')?.text === 'Prints in the SSP', 'B3: Met with edited text prints');
const ip = objectiveSspBadge(ID, L2, o('IN_PROGRESS', 'Edited'), '');
assert(ip?.kind === 'prints' && ip.text === 'Prints in the SSP as In progress', 'B4: In progress with edited text prints with its status', ip);
const written = letters.find((l) => hasWrittenTemplate(ID, l, L2));
const starter = written ? getControlObjectives(ID, undefined, undefined, undefined, L2).find((x) => x.letter === written)!.prefilledTemplate : '';
assert(!!written && starter.trim() !== '', 'setup: the control has a written starter template');
const sb = objectiveSspBadge(ID, L2, o('IN_PROGRESS', starter, starter), '');
assert(sb?.kind === 'starter' && sb.text === 'Starter text: prints once Met', 'B5a: unedited starter text that is not Met', sb);
assert(objectiveSspBadge(ID, L2, o('MET', starter, starter), '')?.kind === 'prints', 'B5b: the same starter text once Met prints');
const dup = objectiveSspBadge(ID, L2, o('MET', 'Covered here'), 'The notes say: Covered here, in full.');
assert(dup?.kind === 'duplicate' && dup.text === 'Already in the control statement', 'B6: text contained in the notes is a duplicate', dup);
const statuses: ObjectiveStatus[] = ['MET', 'NOT_MET', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_APPLICABLE'];
const narratives = ['', '  ', 'Mine', 'T', 'Covered'];
const notesList = ['', 'Covered by the notes'];
let agree = true;
let combos = 0;
for (const s of statuses) {
  for (const nar of narratives) {
    for (const notes of notesList) {
      const row = o(s, nar);
      const prints = objectiveSspBadge(ID, L2, row, notes)?.kind === 'prints';
      if (prints !== objectiveNarrativePrints(row, notes)) agree = false;
      combos++;
    }
  }
}
assert(agree && combos >= 50, 'B7: kind prints exactly when objectiveNarrativePrints is true', combos);

console.log('--- Captions and labels ---');
assert(
  sspPreviewCaption('AC-2', 'NIST_800_53', []) === 'This framework prints the implementation statement only. Objective narratives are not added.',
  'C1: non-CMMC caption'
);
assert(
  sspPreviewCaption(ID, L2, []) === 'No objective narrative prints yet. A narrative prints once written; starter text prints once its objective is Met.',
  'C2: no letters'
);
assert(sspPreviewCaption(ID, L2, ['a']) === 'Includes the narrative of objective [a].', 'C3: one letter');
assert(sspPreviewCaption(ID, L2, ['a', 'c']) === 'Includes the narratives of objectives [a], [c].', 'C4: several letters');
const cm = sspStatementLabel(ID, L2);
assert(
  cm.label === 'Control statement (optional)' &&
    cm.help === 'Printed first in the SSP for this control. Each objective narrative that prints follows it, labelled with its letter.',
  'S1: CMMC label'
);
const ot = sspStatementLabel('AC-2', 'NIST_800_53');
assert(ot.label === 'Implementation statement' && ot.help === "Printed in the SSP as this control's implementation statement.", 'S2: other frameworks label');

console.log('--- hasSspStatement ---');
assert(!hasSspStatement(ID, '  \n ', {}, L2) && !hasSspStatement(ID, null, undefined, L2), 'E1a: whitespace-only notes and no narratives: nothing prints');
assert(hasSspStatement(ID, '', { [`${ID}[${letters[0]}]`]: { status: 'MET', implementationNarrative: 'Done' } }, L2), 'E1b: one Met narrative prints');
assert(hasSspStatement(ID, 'Notes', undefined, L2) && !hasSspStatement(ID, '', { [`${ID}[${letters[0]}]`]: { status: 'MET', implementationNarrative: 'Done' } }, 'NIST_800_53'), 'E1c: notes print; other frameworks ignore narratives');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
