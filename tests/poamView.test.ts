import { getFrameworkControls, FRAMEWORK_REGISTRY } from '../src/data/frameworks';
import { generatePOAMEntries } from '../src/data/reports/documentCompilers';
import { cmmcDisplayId } from '../src/data/cmmcGuide/displayId';
import type { ControlState } from '../src/types/cmmc';
import type { POAMEntry } from '../src/types/report';
import {
  poamStatusKey, poamStatusCounts, defaultPoamStatuses, poamQueryTerms, matchesPoamQuery, filterPoamEntries, groupPoamByFamily,
  initialExpanded, groupOpen, poamResultsText, showMoreText, POAM_STATUS_ORDER, POAM_STATUS_LABEL, POAM_GROUP_PAGE, POAM_GROUPS_OPEN_MAX,
  POAM_COPY, type PoamStatusKey,
} from '../src/data/reports/poamView';

/**
 * #278: the POA&M screen's controls view helper (status filter, search, family groups, result text). Pure test: no server,
 * no browser. Weakness ids must come from the full generated list and never be regenerated on a subset.
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

const state = (id: string, status: ControlState['status'], extra: Partial<ControlState> = {}): ControlState => ({
  id, status, implementationNotes: '', responsibleRole: '', lastUpdated: '2026-01-01', tags: [], ...extra,
});
const set = (...k: PoamStatusKey[]) => new Set<PoamStatusKey>(k);
const entry = (id: string, status: POAMEntry['status']): POAMEntry => ({
  weaknessId: id, controlId: id, controlTitle: id, weaknessDescription: id, scheduledCompletionDate: 'x', requiredResources: 'x',
  responsibleRole: 'x', remediationPlan: 'x', status,
});

const l2 = getFrameworkControls('CMMC_L2');
const states: Record<string, ControlState> = {};
for (const c of l2) states[c.id] = state(c.id, c.domain === 'AC' ? 'NOT_STARTED' : 'MET');
const iaControl = l2.find((c) => c.domain === 'IA')!;
states[iaControl.id] = state(iaControl.id, 'NOT_MET', { responsibleRole: 'Zebra Owner' });
const all = generatePOAMEntries(l2, states, undefined, 'CMMC_L2');

console.log('--- PV1 poamStatusKey ---');
assert(poamStatusKey('NOT_MET') === 'NOT_MET', 'PV1 NOT_MET');
assert(poamStatusKey('IN_PROGRESS') === 'IN_PROGRESS', 'PV1 IN_PROGRESS');
assert(poamStatusKey('NOT_STARTED') === 'NOT_STARTED', 'PV1 NOT_STARTED');
assert(poamStatusKey('OPEN') === 'NOT_MET', 'PV1 OPEN counts as Not met');
assert(poamStatusKey('DELAYED') === 'NOT_MET', 'PV1 DELAYED counts as Not met');
assert(poamStatusKey('MET') === 'NOT_MET', 'PV1 a defensive MET counts as Not met');
const mixedCounts = poamStatusCounts([entry('a', 'NOT_MET'), entry('b', 'OPEN'), entry('c', 'IN_PROGRESS'), entry('d', 'NOT_STARTED')]);
assert(mixedCounts.NOT_MET === 2 && mixedCounts.IN_PROGRESS === 1 && mixedCounts.NOT_STARTED === 1, 'PV1 poamStatusCounts counts the full list', mixedCounts);

console.log('--- PV2 defaultPoamStatuses ---');
const dMixed = defaultPoamStatuses([entry('a', 'NOT_MET'), entry('b', 'NOT_STARTED')]);
assert(dMixed.size === 2 && dMixed.has('NOT_MET') && dMixed.has('IN_PROGRESS') && !dMixed.has('NOT_STARTED'), 'PV2 mixed hides Not started');
const dOnlyProgress = defaultPoamStatuses([entry('a', 'IN_PROGRESS'), entry('b', 'NOT_STARTED')]);
assert(dOnlyProgress.size === 2 && !dOnlyProgress.has('NOT_STARTED'), 'PV2 In progress alone is enough to hide Not started');
assert(defaultPoamStatuses([entry('a', 'NOT_STARTED'), entry('b', 'NOT_STARTED')]).size === 3, 'PV2 all Not started shows all three statuses');
assert(defaultPoamStatuses([]).size === 3, 'PV2 an empty list shows all three statuses');

console.log('--- PV3 weakness ids are reused ---');
const notMet = filterPoamEntries(all, set('NOT_MET'), '');
assert(notMet.length === 1 && all.includes(notMet[0]), 'PV3 the result is the very same object as in the full list');
const orig = all.find((e) => e.controlId === iaControl.id)!;
assert(notMet[0].weaknessId === orig.weaknessId, 'PV3 the weakness id is the one generated for the full list', notMet[0].weaknessId);
assert(all.indexOf(orig) > 0 && !notMet[0].weaknessId.endsWith('-001'), 'PV3 the first result is not renumbered to 001');
const notStarted = filterPoamEntries(all, set('NOT_STARTED'), '');
assert(notStarted.every((e, i) => e === all.filter((x) => poamStatusKey(x.status) === 'NOT_STARTED')[i]), 'PV3 the input order is kept');

console.log('--- PV4 search ---');
const acSample = all.find((e) => e.controlId.startsWith('AC.'))!;
const byId = filterPoamEntries(all, set(...POAM_STATUS_ORDER), acSample.controlId.toUpperCase());
assert(byId.some((e) => e === acSample), 'PV4 a control id matches whatever the case');
const idLower = filterPoamEntries(all, set(...POAM_STATUS_ORDER), acSample.controlId.toLowerCase());
assert(idLower.length === byId.length, 'PV4 case does not change the result');
const word = acSample.controlTitle.split(/\s+/).find((w) => w.length > 3) ?? acSample.controlTitle;
const twoTerm = filterPoamEntries(all, set(...POAM_STATUS_ORDER), `${word}   ${acSample.controlId}`);
assert(twoTerm.some((e) => e === acSample) && twoTerm.every((e) => matchesPoamQuery(e, poamQueryTerms(`${word} ${acSample.controlId}`))), 'PV4 several terms must all match, whatever the spacing');
assert(filterPoamEntries(all, set(...POAM_STATUS_ORDER), 'zzzz-nothing-matches-this').length === 0, 'PV4 no match gives an empty list');
assert(filterPoamEntries(all, set(...POAM_STATUS_ORDER), '   ').length === all.length, 'PV4 a blank query returns everything');
assert(poamQueryTerms('  Foo   BAR ').join('|') === 'foo|bar' && poamQueryTerms('   ').length === 0, 'PV4 the terms are trimmed, lower-cased and split');
const descOnly = [{ ...entry('X-1', 'NOT_MET'), weaknessDescription: 'Quarantined unicorn firmware' }, entry('X-2', 'NOT_MET')];
assert(filterPoamEntries(descOnly, set('NOT_MET'), 'UNICORN').length === 1, 'PV4 a word found only in the weakness description matches');
assert(filterPoamEntries(all, set(...POAM_STATUS_ORDER), 'zebra owner').length === 1, 'PV4 the responsible role is searched');
assert(filterPoamEntries(all, set(...POAM_STATUS_ORDER), orig.weaknessId.toLowerCase()).some((e) => e === orig), 'PV4 the weakness id is searched');

console.log('--- PV5 CMMC Level 1 display ids ---');
const l1 = getFrameworkControls('CMMC_L1');
const l1States: Record<string, ControlState> = {};
for (const c of l1) l1States[c.id] = state(c.id, 'NOT_MET');
const l1Entries = generatePOAMEntries(l1, l1States, undefined, 'CMMC_L1');
const l1Target = l1Entries[0];
const display = cmmcDisplayId(l1Target.controlId, 'CMMC_L1');
const l1Hit = filterPoamEntries(l1Entries, set('NOT_MET'), display);
assert(l1Hit.some((e) => e === l1Target), 'PV5 the guide display id matches a Level 1 entry', display);
assert(l1Entries.every((e) => e.controlDisplayId !== undefined), 'PV5 every Level 1 entry carries its display id');

console.log('--- PV6 groupPoamByFamily ---');
const domains = FRAMEWORK_REGISTRY.CMMC_L2.domains;
const everything = generatePOAMEntries(l2, Object.fromEntries(l2.map((c) => [c.id, state(c.id, 'NOT_STARTED')])), undefined, 'CMMC_L2');
const groups = groupPoamByFamily(everything, everything, l2, domains);
const present = Object.keys(domains).filter((k) => l2.some((c) => c.domain === k));
assert(groups.map((g) => g.code).join(',') === present.join(','), 'PV6 the groups follow the framework domain order', groups.map((g) => g.code));
assert(groups.every((g) => g.total === everything.filter((e) => l2.find((c) => c.id === e.controlId)!.domain === g.code).length && g.entries.length === g.total), 'PV6 total counts the family in the full list');
assert(groups.every((g) => g.name === domains[g.code].name), 'PV6 the name is the domain name');
const mixedGroups = groupPoamByFamily(notMet, all, l2, domains);
assert(mixedGroups.length === 1 && mixedGroups[0].code === 'IA', 'PV6 a family with every entry filtered out is absent', mixedGroups.map((g) => g.code));
const acTotal = all.filter((e) => l2.find((c) => c.id === e.controlId)!.domain === 'AC').length;
const afterQuery = groupPoamByFamily(acSample ? [acSample] : [], all, l2, domains);
assert(afterQuery.length === 1 && afterQuery[0].entries.length === 1 && afterQuery[0].total === acTotal, 'PV6 total stays the full-list count when few entries are visible', afterQuery[0]);
const stray = entry('STRAY-1', 'NOT_MET');
const withStray = groupPoamByFamily([stray, ...notMet, acSample], [stray, ...all], l2, domains);
assert(withStray[withStray.length - 1].code === 'OTHER' && withStray[withStray.length - 1].name === 'Other' && withStray[withStray.length - 1].entries[0] === stray, 'PV6 an entry whose control is unknown lands in OTHER, last');
assert(withStray.length === 3 && withStray[withStray.length - 1].total === 1, 'PV6 the other groups keep their order before OTHER', withStray.map((g) => g.code));

console.log('--- PV7 poamResultsText ---');
const mk = (n: number, s: POAMEntry['status']) => Array.from({ length: n }, (_, i) => entry(`${s}-${i}`, s));
assert(poamResultsText([], [], set('NOT_MET'), '') === 'No control entries.', 'PV7 no entries');
assert(poamResultsText(mk(7, 'NOT_MET'), mk(7, 'NOT_MET'), set(...POAM_STATUS_ORDER), '') === 'Showing all 7 control entries.', 'PV7 nothing hidden');
assert(poamResultsText(mk(1, 'NOT_MET'), mk(1, 'NOT_MET'), set(...POAM_STATUS_ORDER), '') === 'Showing 1 control entry.', 'PV7 one entry, singular');
const a1 = [...mk(5, 'NOT_MET'), ...mk(25, 'NOT_STARTED')];
assert(poamResultsText(a1, mk(5, 'NOT_MET'), set('NOT_MET', 'IN_PROGRESS'), '') === 'Showing 5 of 30 control entries. 25 not started entries are hidden by the status filter.', 'PV7 25 Not started hidden', poamResultsText(a1, mk(5, 'NOT_MET'), set('NOT_MET', 'IN_PROGRESS'), ''));
const a2 = [...mk(5, 'NOT_MET'), ...mk(1, 'NOT_STARTED')];
assert(poamResultsText(a2, mk(5, 'NOT_MET'), set('NOT_MET', 'IN_PROGRESS'), '') === 'Showing 5 of 6 control entries. 1 not started entry is hidden by the status filter.', 'PV7 one hidden, singular');
const a3 = [...mk(5, 'NOT_MET'), ...mk(25, 'NOT_STARTED'), ...mk(3, 'IN_PROGRESS')];
assert(poamResultsText(a3, mk(5, 'NOT_MET'), set('NOT_MET'), '') === 'Showing 5 of 33 control entries. 28 entries are hidden by the status filter (25 not started, 3 in progress).', 'PV7 two statuses hidden', poamResultsText(a3, mk(5, 'NOT_MET'), set('NOT_MET'), ''));
const a4 = [...mk(5, 'NOT_MET'), ...mk(25, 'NOT_STARTED')];
assert(poamResultsText(a4, mk(2, 'NOT_MET'), set('NOT_MET', 'IN_PROGRESS'), 'abc') === 'Showing 2 of 30 control entries. 25 not started entries are hidden by the status filter. 3 do not match the search.', 'PV7 status and search both hide entries', poamResultsText(a4, mk(2, 'NOT_MET'), set('NOT_MET', 'IN_PROGRESS'), 'abc'));
assert(poamResultsText(mk(5, 'NOT_MET'), mk(4, 'NOT_MET'), set(...POAM_STATUS_ORDER), 'abc') === 'Showing 4 of 5 control entries. 1 does not match the search.', 'PV7 the search-only remainder, singular');
assert(poamResultsText(mk(5, 'NOT_MET'), mk(2, 'NOT_MET'), set(...POAM_STATUS_ORDER), 'abc') === 'Showing 2 of 5 control entries. 3 do not match the search.', 'PV7 the search-only remainder, plural');

console.log('--- PV8 initialExpanded ---');
const ie2 = initialExpanded(['A', 'B']);
assert(ie2.size === 2 && ie2.has('A') && ie2.has('B'), 'PV8 two groups start expanded');
assert(initialExpanded(['A', 'B', 'C']).size === 3 && initialExpanded(['A', 'B', 'C', 'D']).size === 0, 'PV8 three open, four collapsed');
assert(initialExpanded(['A', 'B', 'C', 'D'], 4).size === 4 && POAM_GROUPS_OPEN_MAX === 3 && POAM_GROUP_PAGE === 25, 'PV8 the limit is a parameter, defaults are 3 and 25');

console.log('--- PV9 groupOpen ---');
const sc = new Set(['A']);
assert(groupOpen('A', { searching: true, expanded: null, searchCollapsed: sc, initial: new Set() }) === false, 'PV9 searching: a collapsed group stays closed');
assert(groupOpen('B', { searching: true, expanded: null, searchCollapsed: sc, initial: new Set() }) === true, 'PV9 searching: every other group is open');
assert(groupOpen('A', { searching: false, expanded: null, searchCollapsed: new Set(), initial: new Set(['A']) }) === true, 'PV9 not searching, no choice yet: the initial set decides');
assert(groupOpen('A', { searching: false, expanded: new Set(['B']), searchCollapsed: new Set(), initial: new Set(['A']) }) === false, 'PV9 not searching, the user choice wins over the initial set');
assert(groupOpen('B', { searching: false, expanded: new Set(['B']), searchCollapsed: new Set(), initial: new Set(['A']) }) === true, 'PV9 not searching, an expanded group is open');

console.log('--- PV10 showMoreText ---');
assert(showMoreText(40, 25) === 'Show 25 more (40 not shown)', 'PV10 more than a page remains');
assert(showMoreText(10, 25) === 'Show the remaining 10', 'PV10 less than a page remains');
assert(showMoreText(25, 25) === 'Show the remaining 25', 'PV10 exactly a page remains');

console.log('--- PV11 inputs are not mutated ---');
const snapshot = JSON.stringify({ all, states, domains });
const statuses = set('NOT_MET', 'IN_PROGRESS');
const vis = filterPoamEntries(all, statuses, 'access');
groupPoamByFamily(vis, all, l2, domains);
poamResultsText(all, vis, statuses, 'access');
defaultPoamStatuses(all);
poamStatusCounts(all);
assert(JSON.stringify({ all, states, domains }) === snapshot && statuses.size === 2, 'PV11 the entries, controls and domains are unchanged');

console.log('--- labels and copy ---');
assert(POAM_STATUS_LABEL.NOT_STARTED === 'Not started' && POAM_STATUS_ORDER.join() === 'NOT_MET,IN_PROGRESS,NOT_STARTED', 'status labels and order');
assert(POAM_COPY.groupCount(3, 3) === '3 entries' && POAM_COPY.groupCount(1, 1) === '1 entry' && POAM_COPY.groupCount(2, 9) === '2 of 9 shown', 'group count text');
assert(POAM_COPY.crossRef(1) === '1 vulnerability item for this requirement is listed under Vulnerabilities.' && POAM_COPY.crossRef(4) === '4 vulnerability items for this requirement are listed under Vulnerabilities.', 'cross-reference text');
assert(POAM_COPY.groupCaption('AC', 'Access Control') === 'AC Access Control: control POA&M entries', 'group caption');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
