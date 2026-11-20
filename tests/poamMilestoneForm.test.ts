import {
  MILESTONE_COPY, milestoneDateError, milestoneDescriptionError, milestoneDrafts, milestoneErrors, milestoneLabel, milestoneListInvalid,
  milestoneProgressText, milestonesChanged, milestonesPatch, moveMilestone, newMilestoneDraft, nextNewMilestoneNumber, pendingMilestoneWarning,
  printedMilestoneLine, rebaseMilestones, type MilestoneDraft,
} from '../src/data/reports/poamMilestoneForm';
import type { PoamMilestone } from '../src/types/poamMilestone';

/**
 * #304: the milestone list of a POA&M entry as an editable form (drafts, patch, errors, reorder, warnings, merge). Pure test: no server, no browser.
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
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const ms = (id: string, o: Partial<PoamMilestone> = {}): PoamMilestone => ({ id, description: `Task ${id}`, targetDate: '2027-01-01', completed: false, ...o });
const stored = [ms('a'), ms('b'), ms('c')];

console.log('--- M1 drafts and patch ---');
{
  const d = milestoneDrafts(stored);
  assert(d.length === 3 && d[0].key === 'a' && d[0].id === 'a', 'M1 a stored list becomes rows keyed by id');
  assert(milestoneDrafts(undefined).length === 0, 'M1 no list gives no rows');
  assert(!milestonesChanged(stored, d), 'M1 untouched rows are no change');
  assert(milestonesChanged(stored, moveMilestone(d, 0, 1)), 'M1 a reorder is a change');
  assert(milestonesChanged(stored, d.map((x, i) => (i === 1 ? { ...x, completed: true } : x))), 'M1 completing one is a change');
  assert(!milestonesChanged(stored, d.map((x, i) => (i === 1 ? { ...x, description: `  ${x.description}  ` } : x))), 'M1 whitespace around a description is no change');
  const added = [...d, newMilestoneDraft(1)];
  assert(milestonesChanged(stored, added) && !milestonesChanged(stored, added.slice(0, 3)), 'M1 adding then removing a row is no change');
  const patch = milestonesPatch([{ key: 'a', id: 'a', description: ' Task a ', targetDate: '2027-01-01', completed: true }, { ...newMilestoneDraft(1), description: 'New', targetDate: '2027-02-01' }]);
  assert(same(patch, [{ id: 'a', description: 'Task a', targetDate: '2027-01-01', completed: true }, { description: 'New', targetDate: '2027-02-01', completed: false }]), 'M1 the patch strips key, keeps id for stored rows and omits it for new rows', patch);
  assert(nextNewMilestoneNumber([]) === 1 && nextNewMilestoneNumber([newMilestoneDraft(1), newMilestoneDraft(4)]) === 5, 'M1 new rows get a free number');
}

console.log('--- M2 errors ---');
{
  const ok: MilestoneDraft = { ...newMilestoneDraft(1), description: 'Fine', targetDate: '2027-01-01' };
  assert(Object.keys(milestoneErrors([ok])).length === 0 && !milestoneListInvalid([ok]), 'M2 a valid row has no error');
  const e = milestoneErrors([ok, { ...ok, key: 'x', description: 'a\nb' }, { ...ok, key: 'y', description: '   ' }, { ...ok, key: 'z', targetDate: '2100-01-01' }, { ...ok, key: 'w', targetDate: '' }]);
  assert(e[1]?.description === milestoneDescriptionError(1) && e[2]?.description === milestoneDescriptionError(2), 'M2 a newline or an empty description is an error on that row', e);
  assert(e[3]?.targetDate === milestoneDateError(3) && e[4]?.targetDate === milestoneDateError(4), 'M2 a date out of range or empty is an error on that row', e);
  assert(milestoneDescriptionError(1) === 'M2: describe it in 1 to 500 characters on one line.' && milestoneDateError(1) === 'M2: a real date from 2000-01-01 to 2099-12-31.', 'M2 the texts name the row by number');
  assert(milestoneErrors([{ ...ok, description: 'x'.repeat(501) }])[0]?.description !== undefined, 'M2 a description over 500 is an error');
  const many = Array.from({ length: 21 }, (_, i) => ({ ...ok, key: `k${i}` }));
  assert(milestoneListInvalid(many) && !milestoneListInvalid(many.slice(0, 20)), 'M2 21 rows are refused, 20 are fine');
  const secret = JSON.stringify(milestoneErrors([{ ...ok, description: 'SECRET\nline' }]));
  assert(!secret.includes('SECRET'), 'M2 an error never echoes the description');
}

console.log('--- M3 reorder ---');
{
  const d = milestoneDrafts(stored);
  assert(same(moveMilestone(d, 1, -1).map((x) => x.key), ['b', 'a', 'c']) && same(moveMilestone(d, 1, 1).map((x) => x.key), ['a', 'c', 'b']), 'M3 move up and down');
  assert(same(moveMilestone(d, 0, -1).map((x) => x.key), ['a', 'b', 'c']) && same(moveMilestone(d, 2, 1).map((x) => x.key), ['a', 'b', 'c']), 'M3 the top item moved up and the bottom item moved down keep their place');
  assert(moveMilestone(d, 1, -1) !== d && d[0].key === 'a', 'M3 the input list is not changed');
  assert(milestoneLabel(0) === 'M1' && milestoneLabel(19) === 'M20', 'M3 labels are M1..Mn in list order');
}

console.log('--- M4 warnings and text ---');
{
  const d = milestoneDrafts([ms('a', { completed: true }), ms('b'), ms('c')]);
  assert(pendingMilestoneWarning(d, 'COMPLETED') === '2 milestones are not marked completed. You can still complete the item; the export prints them as Pending.', 'M4 completing with 2 pending gives the plural warning');
  assert(pendingMilestoneWarning([d[1]], 'COMPLETED')?.startsWith('1 milestone is not marked completed') === true, 'M4 one pending gives the singular warning');
  assert(pendingMilestoneWarning(d, 'IN_PROGRESS') === null && pendingMilestoneWarning([d[0]], 'COMPLETED') === null && pendingMilestoneWarning([], 'COMPLETED') === null, 'M4 no warning for another status, all completed, or none');
  assert(milestoneProgressText([]) === null && milestoneProgressText(undefined) === null, 'M4 no progress text without milestones');
  assert(milestoneProgressText([{ completed: true }, { completed: false }]) === '1 of 2 milestones completed' && milestoneProgressText([{ completed: false }]) === '0 of 1 milestone completed', 'M4 progress text');
  assert(printedMilestoneLine(ms('a', { completed: true }), 0) === 'M1. Task a, 2027-01-01, Completed' && printedMilestoneLine(ms('b'), 1) === 'M2. Task b, 2027-01-01, Pending', 'M4 the read-only line');
  assert(MILESTONE_COPY.hint === 'Printed as M1, M2 and so on, in this order. At most 20.', 'M4 the hint');
}

console.log('--- M5 rebase ---');
{
  const d = milestoneDrafts(stored);
  const server = [ms('a'), ms('b'), ms('c'), ms('d')];
  const untouched = rebaseMilestones(stored, server, d);
  assert(untouched.drafts.length === 4 && !untouched.conflict, 'M5 untouched: the server list, no conflict');
  const mine = d.map((x, i) => (i === 0 ? { ...x, completed: true } : x));
  const touched = rebaseMilestones(stored, server, mine);
  assert(touched.drafts.length === 3 && touched.drafts[0].completed && touched.conflict, 'M5 touched on both sides to different lists: mine stay, conflict');
  const removed = rebaseMilestones(stored, [ms('a'), ms('c')], mine);
  assert(removed.drafts[1].id === undefined && removed.drafts[1].key.startsWith('new-') && removed.drafts[0].id === 'a', 'M5 a row whose milestone the server removed becomes a new row');
  const sameBoth = rebaseMilestones(stored, [ms('a', { completed: true }), ms('b'), ms('c')], mine);
  assert(!sameBoth.conflict, 'M5 both sides making the same change is no conflict');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
