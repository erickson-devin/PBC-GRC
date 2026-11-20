import {
  POAM_MILESTONES_MAX, POAM_MILESTONE_DESCRIPTION_MAX, canonicalMilestones, milestoneCounts, newMilestoneId, normalizeStoredMilestones, parseMilestonesInput,
  resolveMilestones, sameMilestones, toPOAMMilestones,
} from '../src/data/poamMilestones';
import type { PoamMilestone } from '../src/types/poamMilestone';

/**
 * #304: the milestone list of a POA&M entry, one parser shared by the vulnerability items and the control entries. Pure test: no server, no browser.
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

const one = (over: Record<string, unknown> = {}) => ({ description: 'Patch the host', targetDate: '2027-01-01', ...over });
const ok = (raw: unknown) => parseMilestonesInput(raw).ok;

console.log('--- parseMilestonesInput ---');
assert(POAM_MILESTONES_MAX === 20 && POAM_MILESTONE_DESCRIPTION_MAX === 500, 'M-P01 at most 20 milestones of at most 500 characters');
assert(ok(Array.from({ length: 20 }, () => one())) && !ok(Array.from({ length: 21 }, () => one())), 'M-P02 20 milestones are accepted, 21 refused');
assert(ok([]) && !ok(null) && !ok({}) && !ok('x') && !ok([null]) && !ok([[]]) && !ok([5]), 'M-P03 an empty list is accepted; a non-array and a non-object entry are refused');
assert(!ok([one({ description: 'two\nlines' })]) && !ok([one({ description: 'tab\there' })]) && !ok([one({ description: 'a\u0000b' })]), 'M-P04 a description with a line break or control character is refused');
assert(!ok([one({ description: '' })]) && !ok([one({ description: '   ' })]) && !ok([one({ description: 5 })]) && !ok([{ targetDate: '2027-01-01' }]), 'M-P05 an empty, blank, non-string or missing description is refused');
assert(ok([one({ description: 'x'.repeat(500) })]) && !ok([one({ description: 'x'.repeat(501) })]), 'M-P06 500 description characters are accepted, 501 refused');
assert(!ok([one({ targetDate: '2027-02-30' })]) && !ok([one({ targetDate: '' })]) && !ok([one({ targetDate: undefined })]) && !ok([one({ targetDate: '2100-01-01' })]), 'M-P07 a missing or invalid target date is refused');
assert(!ok([one({ completed: 'yes' })]) && !ok([one({ completed: 1 })]) && ok([one({ completed: true })]) && ok([one({ completed: false })]), 'M-P08 completed must be a boolean when present');
assert(!ok([one({ extra: 1 })]) && !ok([one({ id: 5 })]) && !ok([one({ id: 'a b' })]) && !ok([one({ id: '' })]) && ok([one({ id: null })]) && ok([one({ id: 'ms-aaaaaaaaaaaa' })]), 'M-P09 an unknown key or a malformed id is refused; a null or well-formed id is accepted');
{
  const r = parseMilestonesInput([one({ description: '  padded  ' })]);
  assert(r.ok && r.milestones[0].description === 'padded' && r.milestones[0].completed === false && !('id' in r.milestones[0]), 'M-P10 the description is trimmed; completed defaults to false; no id stays absent', r);
}

console.log('\n--- resolveMilestones ---');
const stored: PoamMilestone[] = [
  { id: 'ms-aaaaaaaaaaaa', description: 'first', targetDate: '2027-01-01', completed: false },
  { id: 'ms-bbbbbbbbbbbb', description: 'second', targetDate: '2027-02-01', completed: true },
];
let n = 0;
const gen = () => `ms-new${++n}`;
{
  const r = resolveMilestones(stored, [{ id: 'ms-bbbbbbbbbbbb', description: 'second', targetDate: '2027-02-01', completed: true }, { description: 'third', targetDate: '2027-03-01' }], gen);
  assert(r.ok && r.milestones.length === 2 && r.milestones[0].id === 'ms-bbbbbbbbbbbb' && r.milestones[1].id === 'ms-new1' && r.milestones[1].completed === false, 'M-R01 a kept id stays, a new milestone gets a generated id, the order is the request order, the omitted one is gone', r);
}
assert(!resolveMilestones(stored, [{ id: 'ms-zzzzzzzzzzzz', description: 'x', targetDate: '2027-01-01' }], gen).ok, 'M-R02 an unknown id is refused');
assert(!resolveMilestones(stored, [{ id: 'ms-aaaaaaaaaaaa', description: 'x', targetDate: '2027-01-01' }, { id: 'ms-aaaaaaaaaaaa', description: 'y', targetDate: '2027-01-01' }], gen).ok, 'M-R03 an id used twice in one request is refused');
assert(!resolveMilestones([], [{ id: 'ms-aaaaaaaaaaaa', description: 'x', targetDate: '2027-01-01' }], gen).ok, 'M-R04 an id on an entry that holds no milestones is refused');
assert(!resolveMilestones(stored, [{ description: 'x', targetDate: '2027-01-01' }], () => 'ms-aaaaaaaaaaaa').ok, 'M-R05 a generated id that collides with a stored one is refused');
{
  const r = resolveMilestones(stored, [], gen);
  assert(r.ok && r.milestones.length === 0, 'M-R06 an empty request clears the list', r);
}

console.log('\n--- Printing, digest, comparison ---');
{
  const p = toPOAMMilestones(stored);
  assert(p.length === 2 && p[0].id === 'M1' && p[1].id === 'M2' && p[0].completed === false && p[1].completed === true && p[1].description === 'second' && p[1].targetDate === '2027-02-01', 'M-D01 the ids print as M1, M2 in list order, with the completed flag', p);
  assert(toPOAMMilestones(undefined).length === 0 && toPOAMMilestones([]).length === 0, 'M-D02 no milestones print as an empty list');
  const m = milestoneCounts(stored);
  assert(m.count === 2 && m.completed === 1 && milestoneCounts([]).count === 0, 'M-D03 the counts are the total and the completed milestones', m);
  const swapped = [stored[1], stored[0]];
  assert(sameMilestones(stored, stored.map((x) => ({ ...x }))) && !sameMilestones(stored, swapped) && !sameMilestones(stored, [stored[0]]), 'M-D04 two lists are the same only with the same content in the same order');
  assert(canonicalMilestones(stored) === canonicalMilestones(stored.map((x) => ({ completed: x.completed, targetDate: x.targetDate, description: x.description, id: x.id }))), 'M-D05 the canonical form does not depend on key order');
  assert(!/^\[\{"description"/.test(canonicalMilestones(stored)) && canonicalMilestones([]) === '[]', 'M-D06 the canonical form has a fixed key order (id first) and an empty list is []');
}

console.log('\n--- Stored values, ids ---');
{
  const raw = [{ id: 'a', description: 'd', targetDate: '2027-01-01', completed: true }, { id: 5 }, null, 'x', { id: 'b', description: 'e', targetDate: '2027-02-01' }];
  const read = normalizeStoredMilestones(raw);
  assert(read.length === 2 && read[0].completed === true && read[1].completed === false, 'M-S01 a stored list keeps the well-formed entries and reads a missing completed as false', read);
  assert(normalizeStoredMilestones(null).length === 0 && normalizeStoredMilestones({}).length === 0 && normalizeStoredMilestones(undefined).length === 0, 'M-S02 a stored value that is not an array reads as empty');
  const ids = new Set(Array.from({ length: 200 }, () => newMilestoneId()));
  assert(ids.size === 200 && [...ids].every((id) => /^ms-[0-9a-f]{12}$/.test(id)), 'M-S03 generated ids are "ms-" and 12 hex characters, and differ');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
