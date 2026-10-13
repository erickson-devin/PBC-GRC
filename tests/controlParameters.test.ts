import {
  attachParameters,
  containsVagueWording,
  findVagueWording,
  isParameterOpen,
  parameterValue,
  parseParameterTags,
  replaceSentence,
  replaceTag,
  resolveParameters,
  setParameterValue,
} from '../src/data/frameworks/parameters';
import { getFrameworkControls } from '../src/data/frameworks';
import type { ControlParameter, FrameworkControlDefinition } from '../src/types/framework';

/** Organization-defined parameters: tag parsing, the objective-ODP bridge, values in the narrative, and vague wording. */
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

console.log('--- Tags in control text ---');
const AC2 = 'Review accounts for compliance with account management requirements [Assignment: organization-defined frequency]; disable accounts within [Assignment: organization-defined time period] when they are inactive.';
const p = parseParameterTags(AC2, 'AC-2');
assert(p.length === 2 && p.every((x) => x.kind === 'ASSIGNMENT' && x.source === 'STATEMENT'), 'two Assignment tags are found');
assert(p[0].prompt === 'organization-defined frequency' && p[0].label === 'frequency' && p[1].label === 'time period', 'each has its prompt, and a short label without "organization-defined"', p.map((x) => x.label));
assert(p.every((x) => AC2.slice(x.start!, x.end!) === x.raw) && p[0].id === 'AC-2#1' && p[1].id === 'AC-2#2', 'positions slice exactly the tag, and ids are numbered in order');
const sel = parseParameterTags('Prevent reuse: [Selection (one or more): change password; [Assignment: organization-defined action]; notify the system owner].', 'IA-5');
assert(sel.length === 1 && sel[0].kind === 'SELECTION' && sel[0].selectionMode === 'ONE_OR_MORE', 'a Selection (one or more) is one parameter, even with a nested tag');
assert(JSON.stringify(sel[0].choices) === JSON.stringify(['change password', '[Assignment: organization-defined action]', 'notify the system owner']), 'its choices are split on ";" but not inside the nested Assignment', sel[0].choices);
const one = parseParameterTags('[Selection: block; allow] and [selection (one): a; b] and [ASSIGNMENT: organization-defined roles]', 'X');
assert(one.length === 3 && one[0].selectionMode === 'ONE' && one[1].selectionMode === 'ONE' && one[2].kind === 'ASSIGNMENT', 'plain Selection and "(one)" mean pick one; keywords are case-insensitive');
assert(parseParameterTags('An [Assignment: unclosed tag and no end', 'X').length === 0 && parseParameterTags('[Assignment:   ]', 'X').length === 0 && parseParameterTags('[Assignment no colon]', 'X').length === 0, 'unclosed, empty or malformed tags are ignored, not guessed at');
assert(parseParameterTags('See [1] and [Note: ordinary brackets].', 'X').length === 0, 'ordinary brackets are not parameters');
assert(parseParameterTags('', 'X').length === 0 && parseParameterTags('no tags here at all', 'X').length === 0, 'text without tags yields none');

console.log('\n--- Catalog schema ---');
const def: FrameworkControlDefinition = { ...getFrameworkControls('NIST_800_53_REV5').find((c) => c.id === 'AC-2')!, statement: AC2 };
assert(resolveParameters(def).filter((x) => x.source === 'STATEMENT').length === 2, 'a control that supplies its statement gets its parameters extracted');
const attached = attachParameters([{ ...def }, { ...getFrameworkControls('CMMC_L1')[0] }]);
assert(attached[0].parameters?.length === 2 && attached[1].parameters === undefined, 'attachParameters fills them in for controls with a statement and leaves the rest alone');
assert(resolveParameters(getFrameworkControls('CMMC_L1')[0]).every((x) => x.source === 'OBJECTIVE') , 'the catalogs shipped today carry no tagged statements: only the objective-level ODPs are found for them');

console.log('\n--- The platform\'s own objective ODPs, in the same structure ---');
const l2 = getFrameworkControls('CMMC_L2').find((c) => c.id.endsWith('-3.1.8'))!;
const reg = resolveParameters(l2);
assert(reg.length >= 2 && reg.every((x) => x.source === 'OBJECTIVE' && x.kind === 'ASSIGNMENT' && x.defaultValue), 'AC 3.1.8 (unsuccessful logon attempts) exposes its registry ODPs as structured parameters with their baseline values', reg.map((x) => `${x.label}=${x.defaultValue}`));
assert(new Set(reg.map((x) => x.id)).size === reg.length, 'with unique ids');
const withODPs = getFrameworkControls('CMMC_L2').filter((c) => resolveParameters(c).length > 0).length;
assert(withODPs >= 5, 'several controls of the catalog already have parameters to show', withODPs);

console.log('\n--- Values are kept in the narrative ---');
const param: ControlParameter = { id: 'x', kind: 'ASSIGNMENT', label: 'Observation Window', prompt: 'Observation Window', source: 'OBJECTIVE' };
assert(isParameterOpen(param, 'We lock accounts.') && parameterValue(param, 'We lock accounts.') === undefined, 'with no value recorded a parameter is open');
const set1 = setParameterValue('We lock accounts.', param, '  15   minutes ');
assert(set1 === 'We lock accounts.\nParameter: Observation Window = 15 minutes' && parameterValue(param, set1) === '15 minutes' && !isParameterOpen(param, set1), 'a value is recorded as one "Parameter: label = value" line (whitespace tidied)');
const set2 = setParameterValue(set1, param, '30 minutes');
assert(set2 === 'We lock accounts.\nParameter: Observation Window = 30 minutes' && (set2.match(/Parameter:/g) ?? []).length === 1, 'changing it replaces the line instead of adding another');
assert(setParameterValue(set2, param, '') === 'We lock accounts.' && setParameterValue('', param, '5 minutes') === 'Parameter: Observation Window = 5 minutes', 'an empty value removes the line; an empty narrative just gets the line');
assert(parameterValue({ ...param, label: 'Max (invalid) attempts+' }, 'Parameter: Max (invalid) attempts+ = 3') === '3', 'labels with regular-expression characters are matched literally');
const tagParam = parseParameterTags('Reviewed [Assignment: organization-defined frequency] by IT.', 'N', 'NOTES')[0];
const filled = replaceTag('Reviewed [Assignment: organization-defined frequency] by IT.', tagParam, 'every 90 days');
assert(filled === 'Reviewed every 90 days by IT.' && isParameterOpen(tagParam, 'Reviewed [Assignment: organization-defined frequency] by IT.'), 'a tag inside the narrative is replaced by its value; while it is there it is open');
assert(replaceTag('Edited meanwhile [Assignment: organization-defined frequency] by IT.', tagParam, 'every 90 days') === 'Edited meanwhile [Assignment: organization-defined frequency] by IT.', 'if the text moved since the tag was found nothing is replaced (no wrong overwrite)');

console.log('\n--- Vague wording ---');
const VAGUE = 'Accounts are reviewed periodically. MFA is required for all users. Logs are checked as needed and patched promptly.';
const spans = findVagueWording(VAGUE);
assert(spans.length === 2 && spans[0].terms.join() === 'periodically' && spans[1].terms.join() === 'as needed,promptly', 'sentences with vague wording are found, with their terms', spans);
assert(spans.every((s) => VAGUE.slice(s.start, s.end) === s.sentence), 'and their exact positions');
for (const ok of ['Accounts are reviewed quarterly.', 'Accounts are reviewed every 90 days.', 'Patches are applied within 14 days.', 'MFA is required for all users.', 'The IT lead reviews logs weekly.']) {
  assert(!containsVagueWording(ok), `explicit wording is not flagged: "${ok}"`);
}
for (const bad of ['Reviewed on a regular basis.', 'Done from time to time.', 'Updated in a timely manner.', 'Value is TBD.', 'Reviewed [Assignment: organization-defined frequency].', 'Checked REGULARLY.']) {
  assert(containsVagueWording(bad), `vague wording is flagged: "${bad}"`);
}
assert(findVagueWording('Parameter: Review frequency = periodically').length === 0, 'a recorded "Parameter:" line is not prose to rewrite');
assert(findVagueWording('Line one is fine.\nLine two is reviewed periodically\nLine three is fine.').map((s) => s.sentence).join() === 'Line two is reviewed periodically', 'a line break ends a sentence');
assert(!containsVagueWording('A non-timely fix') && !containsVagueWording('regularly-scheduled scans every week'), 'a vague word inside a hyphenated compound is not flagged on its own');
const rewritten = replaceSentence(VAGUE, spans[0], 'Accounts are reviewed every 90 days.');
assert(rewritten.startsWith('Accounts are reviewed every 90 days. MFA is required') && rewritten.includes('as needed and patched promptly'), 'a sentence is replaced in place, the rest untouched');
assert(replaceSentence('Moved text. ' + VAGUE, spans[0], 'X.') === 'Moved text. ' + VAGUE, 'if the text changed since, nothing is replaced');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
