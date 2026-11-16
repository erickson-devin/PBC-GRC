import { guideObjectives } from '../src/data/cmmcGuide/guide';
import { cmmcDisplayId } from '../src/data/cmmcGuide/displayId';
import { metRefusalMessage } from '../src/data/cmmcGuide/controlStatusGuard';
import { controlHeaderView, importResultMessage, metMismatchesInView, metMismatchNoticeCopy, movedLoweredNote } from '../src/data/cmmcGuide/controlStatusView';
import { matrixEmptyFilterMessage, matrixSearchPlaceholder } from '../src/data/matrixView';
import type { ObjectiveStatus } from '../src/types/assessment';

/**
 * #292 / #294: the control header, the Met-mismatch notice, the import and move wording and the matrix words. The pure helpers only;
 * it does not boot the server.
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
const letters = guideObjectives('3.1.1', L2).map((g) => g.letter);
const n = letters.length;
const objs = (statuses: ObjectiveStatus[]) => letters.map((l, i) => ({ id: `${ID}[${l}]`, status: statuses[i] ?? ('NOT_STARTED' as ObjectiveStatus) }));
const allMet = objs(letters.map(() => 'MET' as ObjectiveStatus));

console.log('--- Control header ---');
let h = controlHeaderView({ controlId: ID, framework: L2, stored: 'NOT_STARTED', objectives: [] });
assert(h.metRefusal === metRefusalMessage({ allowed: false, reason: 'objectives_not_met', open: n, total: n, rolledUp: 'NOT_STARTED' }) && h.note === null, 'H1: no answers: Met is refused, no note', h);
h = controlHeaderView({ controlId: ID, framework: L2, stored: 'MET', objectives: objs(['MET', 'MET']) });
assert(
  h.note?.tone === 'warn' && h.note.fixTo === 'IN_PROGRESS' &&
    h.note.text === `Recorded as Met, but ${n - 2} of ${n} objectives are not Met or Not applicable. They add up to In progress.`,
  'H2: stored Met with two letters Met: warn, fix to In progress',
  h.note
);
h = controlHeaderView({ controlId: ID, framework: L2, stored: 'MET', objectives: allMet });
assert(h.metRefusal === null && h.note === null, 'H3: all Met, stored Met: nothing to say');
h = controlHeaderView({ controlId: ID, framework: L2, stored: 'NOT_MET', objectives: allMet });
assert(h.metRefusal === null && h.note?.tone === 'info' && h.note.fixTo === null && h.note.text === 'Recorded as Not met. The objectives add up to Met.', 'H4: all Met, stored Not met: info', h.note);
const nist = [{ id: 'AC-2[a]', status: 'NOT_STARTED' as ObjectiveStatus }];
h = controlHeaderView({ controlId: 'AC-2', framework: 'NIST_800_53', stored: 'MET', objectives: nist });
assert(h.metRefusal === null && h.note?.tone === 'info' && h.note.text === 'Recorded as Met. The objectives add up to Not started.', 'H5: NIST is never refused, info note', h);
h = controlHeaderView({ controlId: 'AC-2', framework: 'NIST_800_53', stored: 'MET', objectives: [] });
assert(h.metRefusal === null && h.note === null, 'H6: no objectives (NIST): nothing to say');
const cui = controlHeaderView({
  controlId: ID, framework: L2, stored: 'MET',
  objectives: letters.map((l) => ({ id: `${ID}[${l}]`, status: 'IN_PROGRESS' as ObjectiveStatus, implementationNarrative: 'CUI-MARK' })),
});
assert(!JSON.stringify(cui).includes('CUI-MARK'), 'H7: a narrative never appears in the output');

console.log('--- Notice copy ---');
const w = { canEdit: true };
const r = { canEdit: false };
const ex = 'They count as Met in the scores, the Met count and the SSP until their status matches their objectives. Nothing was changed automatically.';
const c0 = metMismatchNoticeCopy(0, w);
const c1 = metMismatchNoticeCopy(1, w);
const c3 = metMismatchNoticeCopy(3, r);
assert(c0.heading === 'Met controls with open objectives.' && c0.count === 'None left: every control recorded as Met now has its objectives Met or Not applicable.', 'N1a: zero');
assert(c1.count === '1 control is recorded as Met, but not every objective is Met or Not applicable.' && c1.explain === ex && c1.action === 'Open each one to answer its objectives, or set it to the status its objectives add up to.', 'N1b: one, write role');
assert(c3.count === '3 controls are recorded as Met, but not every objective is Met or Not applicable.' && c3.action === 'A Tenant Owner or MSP Admin can update them.', 'N1c: three, read-only role');
const list = [{ controlId: 'A', total: 2, open: 1, rolledUp: 'IN_PROGRESS' as const }, { controlId: 'B', total: 3, open: 3, rolledUp: 'NOT_STARTED' as const }];
const kept = metMismatchesInView(list, new Set(['B']));
assert(kept.length === 1 && kept[0].controlId === 'B' && list.length === 2, 'N2: ids outside the baseline are dropped, the input is untouched');

console.log('--- Import and move ---');
assert(importResultMessage('Acme', 0) === 'Assessment data successfully imported for Acme!', 'I1: no lowering keeps the current text');
assert(
  importResultMessage('Acme', 1) === "Assessment data imported for Acme. 1 control was marked Met in the file without every objective Met or Not applicable, so it was imported at its objectives' status." &&
    importResultMessage('Acme', 2) === "Assessment data imported for Acme. 2 controls were marked Met in the file without every objective Met or Not applicable, so they were imported at their objectives' status.",
  'I2: the singular and plural wordings'
);
assert(
  movedLoweredNote(0) === '' && movedLoweredNote(-1) === '' &&
    movedLoweredNote(1) === " Note: 1 control was Met without every objective Met or Not applicable and was moved at its objectives' status." &&
    movedLoweredNote(2) === " Note: 2 controls were Met without every objective Met or Not applicable and were moved at their objectives' status.",
  'I3: movedLoweredNote'
);

console.log('--- Matrix words ---');
const p2 = matrixSearchPlaceholder('CMMC L2', 'AC.L1-3.1.1', L2);
assert(p2.includes('AC.L2-3.1.1') && !p2.includes('AC.L1-3.1.1'), 'M1: a Level 2 program shows the Level 2 id', p2);
assert(matrixSearchPlaceholder('CMMC L1', 'AC.L1-3.1.1', 'CMMC_L1').includes(cmmcDisplayId('AC.L1-3.1.1', 'CMMC_L1')), 'M2: a Level 1 program shows its own id');
assert(matrixSearchPlaceholder('NIST', undefined, 'NIST_800_53').includes('AC-2'), 'M3: no control falls back to AC-2');
assert(
  matrixEmptyFilterMessage({ catalog: true, metMismatch: true }) === 'The filters "Met with open objectives" and "Changed by the objective update" are on. Clear them or the other filters to see more controls.' &&
    matrixEmptyFilterMessage({ catalog: true, metMismatch: false }) === 'The filter "Changed by the objective update" is on. Clear it or the other filters to see more controls.' &&
    matrixEmptyFilterMessage({ catalog: false, metMismatch: true }) === 'The filter "Met with open objectives" is on. Clear it or the other filters to see more controls.' &&
    matrixEmptyFilterMessage({ catalog: false, metMismatch: false }) === 'Try clearing your search query or switching family and status filters.',
  'M4: the four empty-filter messages'
);

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
