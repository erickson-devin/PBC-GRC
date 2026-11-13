import fs from 'fs';
import path from 'path';
import { cmmcNumberOf, guideObjectives } from '../src/data/cmmcGuide/guide';
import { cmmcCarryOver, getControlObjectives } from '../src/data/cmmcGuide/objectives';
import { CMMC_PARAMETER_PLACEMENT, cmmcGuideParameters, cmmcObjectiveParameterIds } from '../src/data/cmmcGuide/parameters';
import { NIST_800_171A_REGISTRY } from '../src/data/frameworks/assessmentObjectives';
import { parameterValue, resolveParameters } from '../src/data/frameworks/parameters';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';

/**
 * The nine CMMC organization-defined parameters on the requirement and guide objective they belong to (#286): the placement,
 * what the old carry-over attached where, the stored labels, the objectives the resolver gives, and that the frozen catalog side
 * (what the AI assist route accepts) is unchanged. Does not boot the server.
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ids = (controlId: string) => cmmcGuideParameters(controlId).map((p) => p.id);

const l2 = getFrameworkControls('CMMC_L2');
const l1 = getFrameworkControls('CMMC_L1');
const placements = Object.entries(CMMC_PARAMETER_PLACEMENT);

console.log('--- The inventory ---');
const registryIds = new Set<string>();
for (const [key, entry] of Object.entries(NIST_800_171A_REGISTRY)) {
  if (!/^3\.\d{1,2}\.\d{1,2}$/.test(key) && !/^[A-Z]{2}\.L1-b\./.test(key)) continue;
  for (const o of entry.objectives) for (const p of o.odpParameters ?? []) registryIds.add(p.id);
}
assert(same([...registryIds].sort(), Object.keys(CMMC_PARAMETER_PLACEMENT).sort()) && registryIds.size === 9, 'T1: the registry holds exactly the nine ODP ids that are placed', [...registryIds].sort());
assert(placements.every(([, p]) => p !== null), 'T1: no parameter is dropped');

console.log('--- The placements exist in the guide ---');
{
  const missing: string[] = [];
  for (const [id, p] of placements) {
    if (!p) continue;
    if (!guideObjectives(p.number, 'CMMC_L2').some((o) => o.letter === p.letter)) missing.push(`${id} L2`);
    const hasL1 = l1.some((c) => cmmcNumberOf(c.id) === p.number);
    if (hasL1 && !guideObjectives(p.number, 'CMMC_L1').some((o) => o.letter === p.letter)) missing.push(`${id} L1`);
  }
  assert(missing.length === 0, 'T2: every placement is an objective of the guide, for both levels where the number is a Level 1 number', missing);
}

console.log('--- What the carry-over attached before ---');
{
  const found: Record<string, string[]> = {};
  for (const id of Object.keys(CMMC_PARAMETER_PLACEMENT)) found[id] = [];
  for (const c of l2) {
    const number = cmmcNumberOf(c.id);
    if (!number) continue;
    for (const [letter, carried] of Object.entries(cmmcCarryOver(c.id, 'CMMC_L2'))) {
      for (const p of carried.def.odpParameters ?? []) (found[p.id] ??= []).push(`${number}[${letter}]`);
    }
  }
  const expected: Record<string, string[]> = {};
  for (const id of Object.keys(CMMC_PARAMETER_PLACEMENT)) expected[id] = [];
  expected.si_3_14_1_crit = ['3.1.1[e]'];
  expected.si_3_14_1_high = ['3.1.1[e]'];
  assert(same(found, expected), 'T3: only the two patch SLAs were carried, onto 3.1.1[e]; the other seven were orphaned', found);
}

console.log('--- The parameters of a control ---');
{
  const p8 = cmmcGuideParameters('AC.L2-3.1.8');
  assert(same(p8.map((p) => p.id).sort(), ['ac_3_1_8_attempts', 'ac_3_1_8_lockout', 'ac_3_1_8_window']), 'T4: 3.1.8 has its three parameters', p8.map((p) => p.id));
  assert(p8.every((p) => p.objectiveLetter === 'a' && p.source === 'OBJECTIVE' && p.kind === 'ASSIGNMENT'), 'T4: on objective [a], source OBJECTIVE');
  const def = (id: string) => p8.find((p) => p.id === id)?.defaultValue;
  assert(def('ac_3_1_8_attempts') === '3 attempts' && def('ac_3_1_8_lockout') === '30 minutes' && def('ac_3_1_8_window') === '15 minutes', 'T4: the defaults are the registry\'s');
  assert(['AC.L1-3.1.1', 'AC.L1-3.1.2', 'AC.L2-3.1.3', 'AC.L2-3.1.5'].every((id) => ids(id).length === 0), 'T5: the requirements the parameters were misplaced on show none');
  assert(same(ids('SI.L1-3.14.1'), ['si_3_14_1_crit', 'si_3_14_1_high']) && cmmcGuideParameters('SI.L1-3.14.1').every((p) => p.objectiveLetter === 'e'), 'T6: 3.14.1 has both patch SLAs on [e]', ids('SI.L1-3.14.1'));
  assert(same(ids('AC.L2-3.1.11'), ['ac_3_1_11_max_duration', 'ac_3_1_11_idle']) && cmmcGuideParameters('AC.L2-3.1.11').every((p) => p.objectiveLetter === 'a'), 'T6: 3.1.11 has both session limits on [a]', ids('AC.L2-3.1.11'));
  assert(same(ids('AU.L2-3.3.1'), ['au_3_3_1_retention']) && cmmcGuideParameters('AU.L2-3.3.1')[0].objectiveLetter === 'e', 'T6: 3.3.1 has the log retention on [e]', ids('AU.L2-3.3.1'));
  assert(same(ids('AC.L2-3.1.10'), ['ac_3_1_10_timeout']) && cmmcGuideParameters('AC.L2-3.1.10')[0].objectiveLetter === 'a', 'T6: 3.1.10 has the inactivity period on [a]', ids('AC.L2-3.1.10'));
  assert(same(ids('AC-2'), []) && same(ids('AC.L1-b.1.i'), []) && same(ids('3.1.8'), []), 'T6: a non-CMMC id, a FAR id and a bare number give none');
  const attempts = p8.find((p) => p.id === 'ac_3_1_8_attempts')!;
  assert(parameterValue(attempts, 'Parameter: Max Invalid Attempts = 5') === '5', 'T7: the label is kept, so a value recorded before is still read');
  const labels = placements.map(([id]) => cmmcGuideParameters(`XX.L2-${CMMC_PARAMETER_PLACEMENT[id]!.number}`).find((p) => p.id === id)?.label);
  assert(same(labels, ['Max Invalid Attempts', 'Lockout Duration', 'Observation Window', 'Inactivity Lock Period', 'Max Session Duration', 'Idle Timeout', 'Log Retention SLA', 'Critical Patch SLA', 'High Patch SLA']), 'T7: all nine labels are the registry\'s', labels);
}

console.log('--- The objectives of a control ---');
{
  const e = getControlObjectives('AC.L1-3.1.1', undefined, undefined, undefined, 'CMMC_L2').find((o) => o.letter === 'e')!;
  assert(e.odpParameters === undefined, 'T8: the patch SLAs are no longer on 3.1.1[e]');
  const bad: string[] = [];
  for (const [fw, list] of [['CMMC_L2', l2], ['CMMC_L1', l1]] as const) {
    for (const c of list) {
      for (const o of getControlObjectives(c.id, c.title, undefined, undefined, fw)) {
        const allowed = cmmcObjectiveParameterIds(c.id, o.letter);
        for (const p of o.odpParameters ?? []) if (!allowed.has(p.id)) bad.push(`${fw} ${o.id} ${p.id}`);
      }
    }
  }
  assert(bad.length === 0, 'T8: every objective parameter the resolver gives is placed on that objective', bad);
  const stored = getControlObjectives('AC.L1-3.1.1', undefined, undefined, { 'AC.L1-3.1.1[e]': { ...e, odpParameters: [{ id: 'si_3_14_1_crit', label: 'Critical Patch SLA', defaultValue: '7 days' }] } }, 'CMMC_L2').find((o) => o.letter === 'e')!;
  assert(stored.odpParameters === undefined, 'T8: a stale cached parameter is dropped too');
}

console.log('--- The frozen catalog side ---');
{
  const byId = (id: string) => [...l2, ...l1].find((c) => c.id === id)!;
  assert(same(resolveParameters(byId('AC.L1-3.1.1')).map((p) => p.id), ['ac_3_1_8_window', 'si_3_14_1_crit', 'si_3_14_1_high']), 'T9: the catalog still resolves AC.L1-3.1.1 as before', resolveParameters(byId('AC.L1-3.1.1')).map((p) => p.id));
  const si = resolveParameters(byId('SI.L1-3.14.1')).map((p) => p.id);
  const ac8 = resolveParameters(byId('AC.L2-3.1.8')).map((p) => p.id);
  assert(!si.some((id) => id.startsWith('si_')), 'T10: the server would not accept the patch SLAs for 3.14.1, so Suggest stays hidden there', si);
  assert(['ac_3_1_8_attempts', 'ac_3_1_8_lockout', 'ac_3_1_8_window'].every((id) => ac8.includes(id)), 'T10: the server accepts all three parameters for 3.1.8', ac8);
}

console.log('--- The panel ---');
{
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'matrix', 'OdpPanel.tsx'), 'utf8');
  assert(src.includes('cmmcGuideParameters(') && src.includes('serverIds.has(p.id)'), 'T11: OdpPanel uses the guide placement and hides Suggest for a parameter the server would not accept');
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
process.exit(passed === total ? 0 : 1);
