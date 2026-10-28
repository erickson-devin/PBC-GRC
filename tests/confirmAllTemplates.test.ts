import fs from 'fs';
import path from 'path';
import { planConfirmAll, objectiveTemplateSection, type ConfirmAllObjective } from '../src/data/confirmAllTemplates';

let passed = 0;
let total = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  total++;
  if (cond) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.log(`  ✗ FAIL: ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const mk = (over: Partial<ConfirmAllObjective>[] = [{}, {}]): ConfirmAllObjective[] => [
  { id: 'X-1[a]', letter: 'a', text: 'Text A', status: 'NOT_STARTED', prefilledTemplate: 'P1', implementationNarrative: '', ...over[0] },
  { id: 'X-1[b]', letter: 'b', text: 'Text B', status: 'NOT_STARTED', prefilledTemplate: 'P2', implementationNarrative: '', ...over[1] },
];

function main() {
  console.log('\n--- planConfirmAll ---');
  const expected = '[Objective A - Text A]:\nP1\n\n[Objective B - Text B]:\nP2';
  assert(objectiveTemplateSection(mk()[0]) === '[Objective A - Text A]:\nP1', 'section format');

  let p = planConfirmAll(mk(), '');
  assert(p.notes === expected && !p.notesReplaced && !p.needsConfirmation, 'empty notes: exact notes string, no confirmation', p);
  p = planConfirmAll(mk(), '  \n ');
  assert(!p.notesReplaced && !p.needsConfirmation, 'whitespace notes: no confirmation', p);
  p = planConfirmAll(mk(), 'my own notes');
  assert(p.notesReplaced && p.needsConfirmation, 'custom notes: notesReplaced and confirmation', p);
  p = planConfirmAll(mk(), expected);
  assert(!p.notesReplaced && !p.needsConfirmation, 'notes equal to the generated text: no confirmation', p);

  p = planConfirmAll(mk([{ implementationNarrative: 'custom' }, {}]), '');
  assert(JSON.stringify(p.narrativesReplaced) === JSON.stringify([{ id: 'X-1[a]', letter: 'a' }]) && p.needsConfirmation, 'custom narrative: listed and confirmation', p);
  p = planConfirmAll(mk([{ implementationNarrative: 'P1' }, {}]), '');
  assert(p.narrativesReplaced.length === 0 && !p.needsConfirmation, 'narrative equal to template: none', p);
  p = planConfirmAll(mk([{}, { prefilledTemplate: '', implementationNarrative: 'x' }]), '');
  assert(p.narrativesReplaced.length === 1 && p.narrativesReplaced[0].letter === 'b' && p.needsConfirmation, 'empty template with a narrative: listed', p);

  p = planConfirmAll(mk([{}, { status: 'NOT_APPLICABLE' }]), '');
  assert(JSON.stringify(p.statusChanged) === JSON.stringify([{ id: 'X-1[b]', letter: 'b' }]) && !p.needsConfirmation, 'N/A status alone: listed, no confirmation', p);
  p = planConfirmAll(mk([{ status: 'MET' }, { status: 'IN_PROGRESS' }]), '');
  assert(p.statusChanged.length === 1 && p.statusChanged[0].letter === 'b', 'MET is not a status change');
  p = planConfirmAll(mk([{ implementationNarrative: 'c', status: 'NOT_MET' }, {}]), 'n');
  assert([...p.narrativesReplaced, ...p.statusChanged].every((e) => Object.keys(e).sort().join() === 'id,letter'), 'list entries have only id and letter');

  console.log('\n--- static checks ---');
  const ctx = read('src/context/AssessmentContext.tsx');
  assert(ctx.includes('`[Objective ${obj.letter.toUpperCase()} - ${obj.text}]:\\n${narrative}`') && ctx.includes("narrativeSections.join('\\n\\n')"), 'AssessmentContext builds the sections with the same format and join');
  const comp = read('src/components/matrix/ObjectiveChecklist.tsx');
  assert(/import \{[^}]*planConfirmAll[^}]*\} from '..\/..\/data\/confirmAllTemplates'/.test(comp), 'ObjectiveChecklist imports planConfirmAll');
  assert(/import \{[^}]*DialogOverlay[^}]*DialogTitle[^}]*\} from/.test(comp) && comp.includes('role="alertdialog"'), 'ObjectiveChecklist uses DialogOverlay, DialogTitle and an alertdialog');
  const start = comp.indexOf('const handleBulkApplyAll');
  const body = comp.slice(start, comp.indexOf('const handleNarrativeChange'));
  assert(start > 0 && body.indexOf('needsConfirmation') >= 0 && body.indexOf('needsConfirmation') < body.indexOf('applyAll()'), 'handleBulkApplyAll checks needsConfirmation before applying');
  assert(!/console\./.test(comp) && !comp.includes('dangerouslySetInnerHTML'), 'ObjectiveChecklist has no console. and no dangerouslySetInnerHTML');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
