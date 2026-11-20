import fs from 'node:fs';
import path from 'node:path';
import { cmmcNumberOf, guideObjectives } from '../src/data/cmmcGuide/guide';
import {
  checkControlStatusWrite,
  controlStatusAfterObjectiveWrite,
  lowerRefusedMet,
  metRefusalMessage,
  refusedMetControls,
} from '../src/data/cmmcGuide/controlStatusGuard';
import type { ControlStatusRefusal } from '../src/data/cmmcGuide/controlStatusGuard';
import type { ObjectiveStatus } from '../src/types/assessment';
import type { ControlStatus } from '../src/types/cmmc';

/**
 * #292: a control cannot be Met while its objectives are not all Met or Not applicable. The pure rule only: the expectations are
 * computed from the guide data (letters, counts), never hard-coded. Does not boot the server.
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
const lettersOf = (controlId: string, fw: string) => guideObjectives(cmmcNumberOf(controlId)!, fw).map((g) => g.letter);
const answers = (controlId: string, fw: string, status: ObjectiveStatus, only?: string[]): Record<string, ObjectiveStatus> => {
  const out: Record<string, ObjectiveStatus> = {};
  for (const l of lettersOf(controlId, fw)) if (!only || only.includes(l)) out[`${controlId}[${l}]`] = status;
  return out;
};

const L = lettersOf(ID, L2);
const n = L.length;
assert(n >= 3, 'setup: the control has at least three guide objectives', n);

console.log('--- The rule ---');
const g1 = checkControlStatusWrite(ID, 'MET', {}, L2);
assert(!g1.allowed && g1.total === n && g1.open === n && g1.rolledUp === 'NOT_STARTED', 'G1: Met with no objective answers is refused (strict)', g1);

const g2 = checkControlStatusWrite(ID, 'MET', answers(ID, L2, 'MET', L.slice(0, 2)), L2);
assert(!g2.allowed && g2.open === n - 2 && g2.total === n && g2.rolledUp === 'IN_PROGRESS', 'G2: two of n Met is refused, open = n - 2', g2);

assert(checkControlStatusWrite(ID, 'MET', answers(ID, L2, 'MET'), L2).allowed, 'G3: every objective Met is allowed');

const withNa = { ...answers(ID, L2, 'MET'), [`${ID}[${L[0]}]`]: 'NOT_APPLICABLE' as ObjectiveStatus };
assert(checkControlStatusWrite(ID, 'MET', withNa, L2).allowed, 'G4: Met and Not applicable objectives are allowed');

const g5 = checkControlStatusWrite(ID, 'MET', { ...answers(ID, L2, 'MET'), [`${ID}[${L[0]}]`]: 'NOT_MET' }, L2);
assert(!g5.allowed && g5.open === 1 && g5.rolledUp === 'NOT_MET', 'G5: one Not met objective is refused, rolled up Not met', g5);

const downward: ControlStatus[] = ['NOT_MET', 'IN_PROGRESS', 'NOT_STARTED'];
assert(downward.every((s) => checkControlStatusWrite(ID, s, {}, L2).allowed), 'G6: a status other than Met is always allowed');

assert(
  checkControlStatusWrite('AC-2', 'MET', {}, 'NIST_800_53_REV5').allowed && checkControlStatusWrite(ID, 'MET', {}, 'SOC_2_TYPE_II').allowed,
  'G7: NIST 800-53 and SOC 2 keep their manual status'
);

const PE = 'PE.L1-3.10.1';
const peLetters = lettersOf(PE, L1);
assert(peLetters.length > 0 && checkControlStatusWrite(PE, 'MET', answers(PE, L1, 'MET'), L1).allowed, 'G8: a Level 1 control with every guide objective Met is allowed', peLetters);

const stale = { ...answers(ID, L2, 'MET'), [`${ID}[z]`]: 'NOT_MET' as ObjectiveStatus };
assert(checkControlStatusWrite(ID, 'MET', stale, L2).allowed, 'G9: a stored letter that is not in the guide is ignored');

console.log('--- The message ---');
const msg = metRefusalMessage(g2 as ControlStatusRefusal);
const guideText = guideObjectives(cmmcNumberOf(ID)!, L2).map((g) => g.text);
assert(msg.includes(String(n - 2)) && msg.includes(String(n)) && guideText.every((t) => !msg.includes(t)), 'G10: the message has the counts and no objective text', msg);

console.log('--- The state helpers ---');
const ID2 = 'AC.L1-3.1.2';
const ID3 = 'AC.L2-3.1.5';
const objectives: Record<string, { status: ObjectiveStatus }> = {
  ...Object.fromEntries(Object.entries(answers(ID, L2, 'MET')).map(([k, v]) => [k, { status: v }])),
  ...Object.fromEntries(Object.entries(answers(ID2, L2, 'MET', lettersOf(ID2, L2).slice(0, 1))).map(([k, v]) => [k, { status: v }])),
};
const controls: Record<string, { status: ControlStatus; notes?: string }> = {
  [ID]: { status: 'MET' },
  [ID2]: { status: 'MET', notes: 'kept' },
  [ID3]: { status: 'MET' },
  'AC.L2-3.1.20': { status: 'IN_PROGRESS' },
};
const refused = refusedMetControls(controls, objectives, L2);
const refusedIds = refused.map((r) => r.controlId).sort();
const expectIds = [ID2, ID3].sort();
const want2 = lettersOf(ID2, L2).length > 1 ? 'IN_PROGRESS' : 'MET';
assert(JSON.stringify(refusedIds) === JSON.stringify(expectIds) && refused.find((r) => r.controlId === ID3)?.rolledUp === 'NOT_STARTED', 'G11: lists exactly the Met controls that fail the rule', refused);
assert(want2 === 'IN_PROGRESS' && refused.find((r) => r.controlId === ID2)?.rolledUp === 'IN_PROGRESS', 'G11b: a partly answered control rolls up to In progress');

const input = { controls, objectives };
const before = JSON.stringify(input);
const lowered = lowerRefusedMet(input, L2);
assert(JSON.stringify(input) === before, 'G12: lowerRefusedMet leaves its input unchanged');
assert(
  [...lowered.lowered].sort().join() === expectIds.join() &&
    lowered.state.controls[ID].status === 'MET' &&
    lowered.state.controls[ID2].status === 'IN_PROGRESS' &&
    (lowered.state.controls[ID2] as { notes?: string }).notes === 'kept' &&
    lowered.state.controls[ID3].status === 'NOT_STARTED' &&
    lowered.state.controls['AC.L2-3.1.20'].status === 'IN_PROGRESS',
  'G12b: refused controls take their rolled-up status, the rest is kept',
  lowered.state.controls
);
const other = lowerRefusedMet({ controls: { 'AC-2': { status: 'MET' as ControlStatus } }, objectives: {} }, 'NIST_800_53_REV5');
assert(other.lowered.length === 0 && other.state.controls['AC-2'].status === 'MET', 'G12c: a non-CMMC framework is left alone');

console.log('--- After an objective write (#307) ---');
const after = (controlId: string, current: ControlStatus, statuses: Record<string, ObjectiveStatus>, fw: string) => controlStatusAfterObjectiveWrite(controlId, current, statuses, fw);
const oneNotMet = { ...answers(ID, L2, 'MET'), [`${ID}[${L[0]}]`]: 'NOT_MET' as ObjectiveStatus };
const partial = answers(ID, L2, 'MET', L.slice(0, 2));
const partialRule = checkControlStatusWrite(ID, 'MET', partial, L2);
const oneRule = checkControlStatusWrite(ID, 'MET', oneNotMet, L2);
assert(after(ID, 'MET', answers(ID, L2, 'MET'), L2) === 'MET', 'W1: a Met control with every objective Met stays Met');
assert(!oneRule.allowed && after(ID, 'MET', oneNotMet, L2) === oneRule.rolledUp && oneRule.rolledUp !== 'MET', 'W2: one Not met objective lowers a Met control to the rolled-up status', oneRule);
assert(!partialRule.allowed && after(ID, 'MET', partial, L2) === partialRule.rolledUp, 'W3: partly Met objectives lower it to what checkControlStatusWrite says they roll up to', partialRule);
assert(after(ID, 'IN_PROGRESS', oneNotMet, L2) === 'IN_PROGRESS' && after(ID, 'NOT_MET', answers(ID, L2, 'MET'), L2) === 'NOT_MET' && after(ID, 'NOT_STARTED', answers(ID, L2, 'MET'), L2) === 'NOT_STARTED', 'W4: it never raises, and never changes a control that is not Met');
assert(after('AC-2', 'MET', {}, 'NIST_800_53_REV5') === 'MET' && after(ID, 'MET', {}, 'SOC_2_TYPE_II') === 'MET', 'W5: a NIST 800-53 and a SOC 2 control stay Met');
const metAndNa = { ...answers(ID, L2, 'MET'), [`${ID}[${L[0]}]`]: 'NOT_APPLICABLE' as ObjectiveStatus };
assert(after(ID, 'MET', metAndNa, L2) === 'MET', 'W6: Met and Not applicable objectives keep the control Met');

console.log('--- Source ---');
const src = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'cmmcGuide', 'controlStatusGuard.ts'), 'utf8');
assert(!/console\./.test(src) && !/localStorage|sessionStorage/.test(src) && !/from 'react'|document\./.test(src), 'G13: the module has no console, browser storage, React or DOM use');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
