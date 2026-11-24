import fs from 'fs';
import path from 'path';
import { planConfirmAll, objectiveTemplateSection, confirmAllResultMessage, confirmAllTitle, confirmAllConfirmLabel, confirmAllIntro, type ConfirmAllObjective } from '../src/data/confirmAllTemplates';
import { notApplicableReasonDraft, notApplicableReasonError } from '../src/data/objectiveNotApplicable';
import { hasWrittenTemplate, getControlObjectives, cmmcCascadeSource } from '../src/data/cmmcGuide/objectives';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';

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
  assert(JSON.stringify(p.statusChanged) === JSON.stringify([{ id: 'X-1[a]', letter: 'a' }]) && !p.needsConfirmation, 'a not-started objective moves to In progress (listed); N/A is kept; a status change alone needs no confirmation', p);
  p = planConfirmAll(mk([{ status: 'MET' }, { status: 'IN_PROGRESS' }]), '');
  assert(p.statusChanged.length === 0, 'MET and IN_PROGRESS are not a status change (a template never marks MET)', p);
  p = planConfirmAll(mk([{ status: 'NOT_MET' }, {}]), '');
  assert(JSON.stringify(p.statusChanged.map((e) => e.letter)) === JSON.stringify(['a', 'b']), 'NOT_MET and NOT_STARTED both move to In progress', p);
  p = planConfirmAll(mk([{ implementationNarrative: 'c', status: 'NOT_MET' }, {}]), 'n');
  assert([...p.narrativesReplaced, ...p.statusChanged].every((e) => Object.keys(e).sort().join() === 'id,letter'), 'list entries have only id and letter');

  p = planConfirmAll(mk(), 'my own notes', undefined, false);
  assert(p.notes === '' && !p.notesReplaced && !p.needsConfirmation && p.filled.length === 2, 'writesNotes false: the notes are not written, replaced or asked about', p);

  console.log('\n--- dialog texts ---');
  const two = planConfirmAll(mk(), '');
  const ask = planConfirmAll(mk(), 'my own notes');
  assert(confirmAllTitle(two) === 'Fill 2 objectives with starter text?' && confirmAllTitle(ask) === 'Replace with the starter templates?', 'titles', [confirmAllTitle(two), confirmAllTitle(ask)]);
  assert(confirmAllTitle(planConfirmAll([mk()[0]], '')) === 'Fill 1 objective with starter text?', 'title with one objective');
  assert(confirmAllConfirmLabel(two) === 'Fill objectives' && confirmAllConfirmLabel(ask) === 'Replace', 'confirm labels');
  assert(confirmAllIntro(2) === 'This fills 2 objectives with starter text. Starter text is a draft: sample wording that may name products your organization does not use. Edit each one to describe your environment, then mark each one Met.', 'intro (2)', confirmAllIntro(2));
  assert(confirmAllIntro(1) === 'This fills 1 objective with starter text. Starter text is a draft: sample wording that may name products your organization does not use. Edit it to describe your environment, then mark it Met.', 'intro (1)', confirmAllIntro(1));

  console.log('\n--- Not applicable reason ---');
  assert(notApplicableReasonDraft({ implementationNarrative: 'T', prefilledTemplate: 'T' }) === '', 'a narrative equal to the template is not a draft reason');
  assert(notApplicableReasonDraft({ implementationNarrative: 'Mine', prefilledTemplate: 'T' }) === 'Mine', 'the saved narrative seeds the reason');
  assert(notApplicableReasonDraft({ implementationNarrative: 'Mine', prefilledTemplate: 'T' }, 'Typed') === 'Typed', 'the typed draft wins');
  assert(notApplicableReasonDraft({ implementationNarrative: 'Old', prefilledTemplate: 'T' }, 'Old starter', ['Old starter']) === '', 'an older starter text is not a draft reason');
  assert(notApplicableReasonError('  ', ['T']) === 'Write a short reason before marking the objective Not applicable.', 'a blank reason is refused');
  assert(notApplicableReasonError('T', ['T']) === 'The starter template is not a reason. Write why this objective does not apply.', 'the starter text is refused');
  assert(notApplicableReasonError('No Wi-Fi', ['T']) === null, 'a written reason is accepted');

  console.log('\n--- written templates only (#282) ---');
  const onlyA = (o: ConfirmAllObjective) => o.letter === 'a';
  p = planConfirmAll(mk(), '', onlyA);
  assert(JSON.stringify(p.filled) === JSON.stringify([{ id: 'X-1[a]', letter: 'a' }]) && JSON.stringify(p.skipped) === JSON.stringify([{ id: 'X-1[b]', letter: 'b' }]) && p.notes === '[Objective A - Text A]:\nP1' && !p.needsConfirmation, 'only the objective with a template is filled; the other is skipped', p);
  p = planConfirmAll(mk([{}, { implementationNarrative: 'custom' }]), '', onlyA);
  assert(p.narrativesReplaced.length === 0 && !p.needsConfirmation, 'a skipped objective\'s own narrative is never overwritten', p);
  p = planConfirmAll(mk([{}, { status: 'IN_PROGRESS' }]), '', onlyA);
  assert(JSON.stringify(p.statusChanged.map((e) => e.letter)) === JSON.stringify(['a']), 'a skipped objective is never listed as a status change', p);
  p = planConfirmAll(mk([{ status: 'MET' }, {}]), '', onlyA);
  assert(p.statusChanged.length === 0 && p.filled.length === 1, 'a filled MET objective keeps MET (no status change)', p);
  p = planConfirmAll(mk(), 'my notes', () => false);
  assert(p.filled.length === 0 && p.notes === '' && !p.notesReplaced && !p.needsConfirmation, 'no template at all: nothing is filled and the notes are not touched', p);
  p = planConfirmAll(mk(), '');
  assert(p.filled.length === 2 && p.skipped.length === 0, 'the default fills every objective');

  console.log('\n--- confirmAllResultMessage ---');
  assert(confirmAllResultMessage(2, 4) === 'Starter templates written to 2 of 6 objectives. Review each one, then mark it Met. 4 objectives have no template and were left unchanged.', 'message (2, 4)', confirmAllResultMessage(2, 4));
  assert(confirmAllResultMessage(6, 0) === 'Starter templates written to 6 of 6 objectives. Review each one, then mark it Met.', 'message (6, 0)', confirmAllResultMessage(6, 0));
  assert(confirmAllResultMessage(1, 1) === 'Starter templates written to 1 of 2 objectives. Review each one, then mark it Met. 1 objective has no template and was left unchanged.', 'message (1, 1)', confirmAllResultMessage(1, 1));
  assert(confirmAllResultMessage(1, 0) === 'Starter templates written to 1 of 1 objective. Review it, then mark it Met.', 'message (1, 0)', confirmAllResultMessage(1, 0));
  assert(confirmAllResultMessage(0, 3) === 'No starter template was written: none of the 3 objectives has one.', 'message (0, 3)', confirmAllResultMessage(0, 3));

  console.log('\n--- hasWrittenTemplate ---');
  assert(hasWrittenTemplate('AC.L2-3.1.7', 'c', 'CMMC_L2') === true, 'AC.L2-3.1.7[c] has a written template');
  assert(hasWrittenTemplate('AC.L2-3.1.7', 'a', 'CMMC_L2') === false, 'AC.L2-3.1.7[a] has none');
  assert(hasWrittenTemplate('AC.L2-3.1.8', 'a', 'CMMC_L2') === false, 'AC.L2-3.1.8[a] has none');
  assert(hasWrittenTemplate('AC.L1-3.1.1', 'a', 'CMMC_L1') === true, 'AC.L1-3.1.1[a] has a written template');
  assert(hasWrittenTemplate('AC-2', 'a', 'NIST_800_53') === true, 'a non-CMMC objective is unchanged: true');
  {
    const GENERIC = 'The enclave implementation satisfies requirement ';
    let total = 0;
    let withTemplate = 0;
    let mismatches = 0;
    let cascadeLeak = 0;
    for (const c of getFrameworkControls('CMMC_L2')) {
      for (const o of getControlObjectives(c.id, c.title, undefined, undefined, 'CMMC_L2')) {
        total++;
        const has = hasWrittenTemplate(c.id, o.letter, 'CMMC_L2');
        if (has !== (o.prefilledTemplate.trim() !== '' && !o.prefilledTemplate.startsWith(GENERIC))) mismatches++;
        if (cmmcCascadeSource(c.id, o.letter, 'CMMC_L2') === null && has) cascadeLeak++;
        if (has) withTemplate++;
      }
    }
    console.log(`  Level 2 objectives: ${total}, with a written template: ${withTemplate}, without: ${total - withTemplate}`);
    assert(mismatches === 0, 'hasWrittenTemplate agrees with the objective text for every Level 2 objective', mismatches);
    assert(cascadeLeak === 0, 'an objective with no cascade source never has a written template', cascadeLeak);
    assert(total - withTemplate > 0, 'some Level 2 objectives have only the generic wording');
  }

  console.log('\n--- static checks ---');
  const ctx = read('src/context/AssessmentContext.tsx');
  assert(ctx.includes('`[Objective ${obj.letter.toUpperCase()} - ${obj.text}]:\\n${narrative}`') && ctx.includes("narrativeSections.join('\\n\\n')"), 'AssessmentContext builds the sections with the same format and join');
  const comp = read('src/components/matrix/ObjectiveChecklist.tsx');
  assert(/import \{[^}]*planConfirmAll[^}]*\} from '..\/..\/data\/confirmAllTemplates'/.test(comp), 'ObjectiveChecklist imports planConfirmAll');
  assert(/import \{[^}]*DialogOverlay[^}]*DialogTitle[^}]*\} from/.test(comp) && comp.includes('role="alertdialog"'), 'ObjectiveChecklist uses DialogOverlay, DialogTitle and an alertdialog');
  const start = comp.indexOf('const handleBulkApplyAll');
  const body = comp.slice(start, comp.indexOf('const handleConfirmReplace'));
  assert(start > 0 && body.includes('setPendingPlan(plan)') && !body.includes('applyAll(') && !body.includes('applyAllObjectiveTemplatesForControl'), 'handleBulkApplyAll always asks first: it sets the pending plan and never applies directly');
  assert(/import \{ hasWrittenTemplate[^}]*\} from '..\/..\/data\/cmmcGuide\/objectives'/.test(comp) && comp.includes("planConfirmAll(objectives, state.controls[controlId]?.implementationNotes ?? '', hasTemplate, !objectiveNarrativesInSsp(controlId, activeFramework))"), 'the checklist passes the written-template check and whether the notes are written to the plan');
  const statusStart = comp.indexOf('const handleStatusClick');
  const statusBody = comp.slice(statusStart, comp.indexOf('const handleConfirmNotApplicable'));
  assert(statusStart > 0 && statusBody.includes("'NOT_APPLICABLE'") && statusBody.indexOf("'NOT_APPLICABLE'") < statusBody.indexOf('updateObjectiveStatus('), 'handleStatusClick opens the reason dialog for Not applicable before it saves anything');
  assert(comp.includes('notApplicableReasonError(') && comp.includes('Mark Not applicable') && comp.includes('Why does objective ['), 'the checklist asks for a Not applicable reason');
  const prefilledStart = ctx.indexOf('const applyObjectivePrefilledNarrative');
  const prefilledCtx = ctx.slice(prefilledStart, ctx.indexOf('const applyAllObjectiveTemplatesForControl'));
  assert(prefilledStart > 0 && prefilledCtx.includes('objectiveNarrativesInSsp(controlId, activeFramework)'), 'applyObjectivePrefilledNarrative leaves the notes alone where the SSP prints the narratives');
  const statusCtxStart = ctx.indexOf('const updateObjectiveStatus');
  const statusCtx = ctx.slice(statusCtxStart, ctx.indexOf('const updateObjectiveNarrative'));
  assert(statusCtxStart > 0 && statusCtx.includes('checkStale: true'), 'updateObjectiveStatus sends a reason as a stale-checked narrative save');
  assert(['Best-Practice', 'Industry', 'FedRAMP Mod / Azure Gov / STIG', 'Quick-Adopt', 'Baseline Template', 'Confirm All'].every((t) => !comp.includes(t)), 'the checklist claims no best-practice provenance');
  assert(comp.includes('No starter template exists for this objective.') && comp.includes('{objHasTemplate ? (') && /objHasTemplate && !isTemplateOpen && !hasConfirmedNarrative/.test(comp), 'an objective without a template shows a note instead of the template card and the adopt link');
  assert(comp.includes('confirmAllResultMessage(bulkResult.filled, bulkResult.skipped)') && comp.includes('<div role="status" aria-live="polite">'), 'the result of the bulk apply is announced in a live region');
  const prefilledHandler = comp.slice(comp.indexOf('const handleApplyPrefilled'), comp.indexOf('const applyAll'));
  assert(prefilledHandler.includes('hasTemplate(obj)'), 'the single-objective handler refuses an objective without a template');
  assert(!comp.includes("'MET' as ObjectiveStatus") && comp.includes("'IN_PROGRESS' as ObjectiveStatus"), 'the checklist never reports an objective as MET after a template (In progress)');
  assert(!/console\./.test(comp) && !comp.includes('dangerouslySetInnerHTML'), 'ObjectiveChecklist has no console. and no dangerouslySetInnerHTML');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
