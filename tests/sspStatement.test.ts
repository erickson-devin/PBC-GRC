import fs from 'node:fs';
import path from 'node:path';
import { cmmcNumberOf, guideObjectives } from '../src/data/cmmcGuide/guide';
import { cmmcGuideLetter } from '../src/data/cmmcGuide/displayId';
import { getControlObjectives, hasWrittenTemplate } from '../src/data/cmmcGuide/objectives';
import { composeImplementationStatement, objectiveNarrativePrints } from '../src/data/cmmcGuide/sspStatement';
import type { ObjectiveAnswer } from '../src/data/cmmcGuide/sspStatement';
import type { ObjectiveStatus } from '../src/types/assessment';

/**
 * #293: the SSP statement is the control notes followed by the objective narratives. The pure composer only: letters and the
 * starter text are computed from the guide data, never hard-coded. Does not boot the server.
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

const L2 = 'CMMC_L2';
const L1 = 'CMMC_L1';
const ID = 'AC.L1-3.1.1';
const L = guideObjectives(cmmcNumberOf(ID)!, L2).map((g) => g.letter);
const [a, b, c] = L;
assert(L.length >= 3, 'setup: the control has at least three guide objectives', L);
const ans = (letter: string, status: ObjectiveStatus, narrative: string | null, id = ID): Record<string, ObjectiveAnswer> => ({
  [`${id}[${letter}]`]: { status, implementationNarrative: narrative },
});
const compose = (notes: string | null | undefined, o: Record<string, ObjectiveAnswer> | undefined, id = ID, fw = L2) =>
  composeImplementationStatement(id, notes, o, fw);

console.log('--- Composition ---');
assert(compose('Policy X.', {}).text === 'Policy X.', 'P1: notes only');
const two = { ...ans(a, 'MET', 'A'), ...ans(c, 'MET', 'C') };
const p2 = compose('', two);
assert(p2.text === `[${a}] A\n\n[${c}] C` && p2.objectiveLetters.join() === `${a},${c}`, 'P2: narratives only, in guide order', p2);
assert(compose('Policy X.', two).text === `Policy X.\n\n[${a}] A\n\n[${c}] C`, 'P3: notes then narratives');
assert(compose('Policy X.', ans(a, 'MET', '')).text === 'Policy X.' && compose('N', ans(a, 'MET', null)).text === 'N', 'P4: an empty narrative is skipped');
assert(compose('', ans(b, 'NOT_MET', 'Plan')).text === `[${b}] (Not met) Plan`, 'P5: Not met prints with its prefix');
assert(compose('', ans(b, 'IN_PROGRESS', 'Plan')).text === `[${b}] (In progress) Plan`, 'P6: In progress prints with its prefix');
assert(compose('', ans(b, 'NOT_APPLICABLE', 'Plan')).text === `[${b}] (Not applicable) Plan`, 'P7: Not applicable prints with its prefix');
assert(compose('', ans(b, 'NOT_STARTED', 'Plan')).text === `[${b}] (Not started) Plan`, 'P7b: Not started prints with its prefix');

const written = L.find((l) => hasWrittenTemplate(ID, l, L2));
const starter = written ? getControlObjectives(ID, undefined, undefined, undefined, L2).find((o) => o.letter === written)!.prefilledTemplate : '';
assert(!!written && starter.trim() !== '', 'setup: the control has a letter with a written starter template', written);
if (written) {
  assert(compose('', ans(written, 'IN_PROGRESS', starter)).text === '', 'P8: unedited starter text is skipped while the objective is not Met');
  assert(compose('', ans(written, 'MET', starter)).text === `[${written}] ${starter.trim()}`, 'P8b: the same text prints once the objective is Met');
  assert(compose('', ans(written, 'IN_PROGRESS', `${starter} Edited.`)).text.includes('(In progress)'), 'P8c: edited starter text prints');
}

assert(compose('We do A in full.', ans(a, 'MET', 'A in')).text === 'We do A in full.', 'P9: a narrative already in the notes is skipped');

const nist = compose('AC-2 notes', ans('a', 'MET', 'Narrative'), 'AC-2', 'NIST_800_53_REV5');
assert(nist.text === 'AC-2 notes' && nist.objectiveLetters.length === 0, 'P10: another framework prints its notes unchanged');
assert(compose(ID, ans(a, 'MET', 'x'), ID, 'SOC_2_TYPE_II').text === ID, 'P10b: SOC 2 prints its notes unchanged');

assert(compose('  \n', undefined).text === '  \n' && compose(null, undefined).text === '' && compose(undefined, undefined).text === '', 'P11: no objectives gives the notes byte for byte');
assert(compose('Kept  \n', {}).text === 'Kept  \n', 'P11b: no printed narrative gives the notes byte for byte');

const PE_IDS = ['PE.L1-3.10.3', 'PE.L1-3.10.4', 'PE.L1-3.10.5'];
let pe: { id: string; letter: string; label: string } | undefined;
for (const id of PE_IDS) {
  for (const g of guideObjectives(cmmcNumberOf(id)!, L1)) {
    const label = cmmcGuideLetter(id, g.letter, L1);
    if (!pe && label !== g.letter) pe = { id, letter: g.letter, label };
  }
}
assert(!!pe, 'setup: a Level 1 PE control is re-lettered', pe);
if (pe) assert(compose('', ans(pe.letter, 'MET', 'Door', pe.id), pe.id, L1).text === `[${pe.label}] Door`, 'P12: a Level 1 program prints the guide letter');

assert(compose('', ans('z', 'MET', 'Gone')).text === '', 'P13: a letter that is not in the guide is not printed');
assert(compose('', ans(a, 'MET', '  x  ')).text === `[${a}] x`, 'P14: the narrative is trimmed');
assert(compose('Notes  \n\n', ans(a, 'MET', 'x')).text === `Notes\n\n[${a}] x`, 'P14b: trailing whitespace of the notes is trimmed before the join');

console.log('--- objectiveNarrativePrints ---');
const o = (status: ObjectiveStatus, implementationNarrative: string, prefilledTemplate = 'T') => ({ status, implementationNarrative, prefilledTemplate });
assert(
  objectiveNarrativePrints(o('MET', 'T'), '') && !objectiveNarrativePrints(o('NOT_MET', 'T'), '') && objectiveNarrativePrints(o('NOT_MET', 'U'), '') &&
    !objectiveNarrativePrints(o('MET', '  '), '') && !objectiveNarrativePrints(o('MET', 'U'), 'has U inside'),
  'P14c: the print test used by the screen badge and the composer'
);

console.log('--- Source ---');
const src = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'cmmcGuide', 'sspStatement.ts'), 'utf8');
assert(!/console\./.test(src) && !/localStorage|sessionStorage/.test(src) && !/from 'react'|document\./.test(src), 'P15: the module has no console, browser storage, React or DOM use');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
