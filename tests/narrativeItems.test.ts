import { getFrameworkControls } from '../src/data/frameworks';
import { parameterValue, resolveParameters, setParameterValue } from '../src/data/frameworks/parameters';
import { parametersOfItem, parseItemNotes, serializeItemNotes, setItemNote, setItemParameterValue, setOverviewNote, statementItems } from '../src/data/frameworks/narrativeItems';

/** The SSP authoring view: a control's statement as lettered items, and each item's answer kept in the one narrative. */
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

const all = getFrameworkControls('NIST_800_53_REV5');
const ac2 = all.find((c) => c.id === 'AC-2')!;

console.log('--- The items of a statement ---');
const it = statementItems(ac2.statement)!;
assert(it.items.map((i) => i.label).join('') === 'abcdefghijkl' && it.intro === '', 'AC-2 has twelve items, a to l, and no introduction');
assert(it.items[0].text.startsWith('a. Define and document the types of accounts') && it.items[3].text.includes('\n  1. Authorized users of the system;') && it.items[3].text.includes('3. Access authorizations'), 'an item keeps its nested lines (d. has 1., 2., 3.)');
assert(it.items.every((i) => ac2.statement!.slice(i.start, i.end).trimEnd() === i.text), 'positions point back into the statement');
assert(statementItems(all.find((c) => c.id === 'AC-2(1)')!.statement) === null && statementItems(undefined) === null && statementItems('a. only one item here;') === null, 'a one-sentence statement (an enhancement), no statement, or a single item is answered as a whole');
const itemized = all.filter((c) => statementItems(c.statement));
assert(itemized.length > 150 && all.filter((c) => c.controlKind === 'ENHANCEMENT' && statementItems(c.statement)).length >= 1, 'many controls are itemized, base controls and enhancements', itemized.length);
const withParams = (c: typeof ac2) => {
  const items = statementItems(c.statement)!.items;
  const params = resolveParameters(c);
  const inItems = items.reduce((n, i) => n + parametersOfItem(i, params).length, 0);
  return { inItems, total: params.filter((p) => p.source === 'STATEMENT').length };
};
assert(itemized.every((c) => { const r = withParams(c); return r.inItems <= r.total; }), 'no parameter is claimed by two items');
const ac2p = withParams(ac2);
assert(ac2p.total === 10 && ac2p.inItems === 10, 'every one of the ten parameters of AC-2 belongs to exactly one item', ac2p);
const params = resolveParameters(ac2);
const counts = it.items.map((i) => parametersOfItem(i, params).length).join('');
assert(counts === '001111041100' && parametersOfItem(it.items[2], params)[0].prompt === 'organization-defined prerequisites and criteria', 'c. holds "prerequisites and criteria"; h. holds the personnel and three time periods', counts);

console.log('\n--- Answers in the narrative ---');
const empty = parseItemNotes('');
assert(empty.general === '' && empty.order.length === 0, 'an empty narrative has nothing');
const legacy = 'We manage accounts in Entra ID.\nParameter: frequency = every 90 days';
assert(parseItemNotes(legacy).general === legacy && serializeItemNotes(parseItemNotes(legacy), ['a', 'b']) === legacy, 'an ordinary narrative is the overview; nothing is lost or reformatted');
const one = setItemNote(legacy, 'b', 'IT assigns two account managers.', ['a', 'b', 'c']);
assert(one === `${legacy}\n\nStatement b:\nIT assigns two account managers.`, 'an answer is added as a "Statement b:" block after the overview', one);
const two = setItemNote(one, 'a', 'Types are listed in the Access Control Policy.', ['a', 'b', 'c']);
assert(two.indexOf('Statement a:') < two.indexOf('Statement b:') && parseItemNotes(two).items.a === 'Types are listed in the Access Control Policy.' && parseItemNotes(two).general === legacy, 'blocks are in statement order whichever is written first');
const cases = ['', 'x', 'Statement a:\nfoo', 'overview\n\nStatement a:\nfoo\n\nStatement c:\nbar baz ', 'Statement a:\nline1\nline2\n\nline3\n\nStatement b:\nz', 'Statement a:\ntrailing\n\n\nStatement b:\nz'];
assert(cases.every((n) => serializeItemNotes(parseItemNotes(n), ['a', 'b', 'c']) === n), 'parsing and joining again gives back the same text (so typing is never reformatted)', cases.filter((n) => serializeItemNotes(parseItemNotes(n), ['a', 'b', 'c']) !== n));
let typed = '';
for (const ch of 'Quarterly review ') typed = setItemNote(typed, 'a', parseItemNotes(typed).items.a === undefined ? ch : parseItemNotes(typed).items.a + ch, ['a']);
assert(parseItemNotes(typed).items.a === 'Quarterly review ', 'typing a trailing space keeps it (the field does not eat what is typed)');
assert(setItemNote(two, 'b', '', ['a', 'b']) === serializeItemNotes({ general: legacy, items: { a: 'Types are listed in the Access Control Policy.' }, order: ['a'] }, ['a']), 'clearing an answer removes its block');
assert(setOverviewNote(two, 'New overview.', ['a', 'b']).startsWith('New overview.\n\nStatement a:') && parseItemNotes(setOverviewNote(two, '', ['a', 'b'])).general === '', 'the overview is replaced without touching the answers');
assert(parseItemNotes('Statement z:\nunknown item').order.join() === 'z' && serializeItemNotes(parseItemNotes('Statement z:\nunknown item'), ['a']) === 'Statement z:\nunknown item', 'a block for a label the statement does not have is kept');

console.log('\n--- Parameter values with items ---');
const prereq = params.find((p) => p.prompt === 'organization-defined prerequisites and criteria')!;
const order = it.items.map((i) => i.label);
const base = setItemNote('', 'c', 'Group owners approve membership.', order);
const placed = setItemParameterValue(base, 'c', prereq, 'a signed access request and a need-to-know justification', order);
assert(placed === `${base.replace('Group owners approve membership.', 'Group owners approve membership.\nParameter: prerequisites and criteria = a signed access request and a need-to-know justification')}` && parseItemNotes(placed).items.c.includes('Parameter: prerequisites and criteria'), 'a new value goes into the answer of its item', placed);
assert(parameterValue(prereq, placed) === 'a signed access request and a need-to-know justification', 'and is read back like any parameter value');
const changed = setItemParameterValue(placed, 'c', prereq, 'a manager-approved ticket', order);
assert((changed.match(/Parameter:/g) ?? []).length === 1 && parameterValue(prereq, changed) === 'a manager-approved ticket', 'changing it replaces the line in place');
const fromQuick = setParameterValue('Overview text.', prereq, 'x');
assert(setItemParameterValue(fromQuick, 'c', prereq, 'y', order) === 'Overview text.\nParameter: prerequisites and criteria = y', 'a line written elsewhere (the quick editor) is changed where it is, never duplicated');
assert(!setItemParameterValue(placed, 'c', prereq, '', order).includes('Parameter:'), 'an empty value removes the line');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
