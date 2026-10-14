import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFrameworkControls } from '../src/data/frameworks';
import { SspStatementEditor, hasStatementItems } from '../src/components/matrix/SspStatementEditor';
import { setItemNote } from '../src/data/frameworks/narrativeItems';

/** The SSP authoring view, rendered on the server (no browser): its structure for AC-2, the saved answers, read-only mode. */
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
const render = (notes: string, canEdit = true, control = ac2) =>
  renderToStaticMarkup(React.createElement(SspStatementEditor, { control, notes, canEdit, tenantId: 't1', onNotesChange: () => undefined }));

assert(hasStatementItems(ac2) && !hasStatementItems(all.find((c) => c.id === 'AC-2(1)')!) && !hasStatementItems(getFrameworkControls('CMMC_L2')[0]), 'the item view is for itemized 800-53 controls only; enhancements and CMMC controls keep the single field');

const html = render('');
assert(html.includes('Control text') && html.includes('Manage information system accounts') && html.includes('Implementation details'), 'the control text, then the implementation details');
assert((html.match(/How is item [a-l]\. met\?/g) ?? []).length === 12 && html.includes('0 of 12 items documented'), 'one field per lettered item, a to l');
assert(html.indexOf('Define and document the types of accounts') < html.indexOf('Assign account managers') && html.indexOf('Assign account managers') < html.indexOf('Align account management processes'), 'the items are in statement order with their official text');
assert(html.includes('[Assignment: organization-defined prerequisites and criteria]') && html.includes('<mark'), 'the [Assignment: ...] blanks are shown in the text, marked');
assert(html.includes('Authorized users of the system') && html.includes('Group and role membership'), 'nested lines (d.1, d.2, d.3) are part of their item');
assert((html.match(/Suggest Parameter Wording/g) ?? []).length === 10 && (html.match(/aria-label="Value for /g) ?? []).length === 10, 'each of the ten parameters has its row and the AI helper button, next to its item');
const cIndex = html.indexOf('Require <mark');
assert(cIndex > 0 && html.indexOf('prerequisites and criteria', cIndex) > 0 && html.indexOf('How is item c. met?') > html.indexOf('Value for prerequisites and criteria'), 'the parameter of item c sits between its text and its field');

const filled = setItemNote(setItemNote('', 'b', 'IT assigns two account managers.', 'abcdefghijkl'.split('')), 'g', 'Entra sign-in logs are reviewed.', 'abcdefghijkl'.split(''));
const html2 = render(filled);
assert(html2.includes('2 of 12 items documented') && html2.includes('IT assigns two account managers.') && html2.includes('Entra sign-in logs are reviewed.') && (html2.match(/Documented/g) ?? []).length >= 2, 'saved answers appear in their items and are counted');
assert((render('Parameter: prerequisites and criteria = a signed request').match(/>Set</g) ?? []).length >= 1 && render('Parameter: prerequisites and criteria = a signed request').includes('a signed request'), 'a recorded parameter value is shown in its row');
const ro = render(filled, false);
assert(!ro.includes('Suggest Parameter Wording') && (ro.match(/disabled=""/g) ?? []).length >= 13, 'read-only: no AI button, every field disabled');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
