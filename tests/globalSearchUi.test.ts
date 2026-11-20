import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND_LABELS,
  fieldLabel,
  flattenOptions,
  groupCountText,
  nextActive,
  searchAnnouncement,
  searchErrorMessage,
  shortcutHint,
  splitHighlight,
} from '../src/data/search/searchUiView';
import { SearchResultsList } from '../src/components/search/GlobalSearch';
import { SEARCH_KINDS, type SearchResponse, type SearchResult } from '../src/types/search';

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

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const result = (kind: SearchResult['kind'], id: string, over: Partial<SearchResult> = {}): SearchResult => ({
  kind,
  id,
  title: `Title ${id}`,
  subtitle: '',
  field: 'title',
  snippet: null,
  nav: { screen: 'control', controlId: id },
  ...over,
});

console.log('--- GU1 group count text ---');
assert(groupCountText(8, 43, true) === 'Showing 8 of 43', 'GU1: a known total');
assert(groupCountText(8, null, true) === 'Showing 8, more match', 'GU1: cut off without a total');
assert(groupCountText(3, null, false) === '3', 'GU1: the plain count');

console.log('--- GU2 options and keys ---');
const groups: SearchResponse['groups'] = [
  { kind: 'control', results: [result('control', 'c1'), result('control', 'c2')], truncated: true },
  { kind: 'evidence', results: [result('evidence', 'e1')], truncated: false },
];
const flat = flattenOptions(groups, 'p');
assert(flat.length === 4, 'GU2: two results, "show more" and one result', flat.length);
assert(flat[2].result === null && flat[2].id === 'p-control-more' && flat[0].id === 'p-control-0' && flat[3].id === 'p-evidence-0', 'GU2: option ids');
assert(flattenOptions([{ kind: 'asset', results: [], truncated: false }], 'p').length === 0, 'GU2: an empty group has no option');
assert(nextActive('ArrowDown', 3, flat) === 0, 'GU2: Down wraps to the first');
assert(nextActive('ArrowDown', -1, flat) === 0, 'GU2: Down from nothing goes to the first');
assert(nextActive('ArrowUp', 0, flat) === 3, 'GU2: Up wraps to the last');
assert(nextActive('ArrowUp', -1, flat) === 3, 'GU2: Up from nothing goes to the last');
assert(nextActive('ArrowUp', 3, flat) === 2, 'GU2: Up moves back one');
assert(nextActive('PageDown', 0, flat) === 3, 'GU2: Page Down goes to the first option of the next group');
assert(nextActive('PageDown', 3, flat) === 3, 'GU2: Page Down stays in the last group');
assert(nextActive('PageUp', 3, flat) === 0, 'GU2: Page Up from the first of a group goes to the previous group');
assert(nextActive('PageUp', 1, flat) === 0, 'GU2: Page Up goes to the first of the current group');
assert(nextActive('Home', 2, flat) === 2, 'GU2: another key leaves the option alone');
assert(nextActive('ArrowDown', 0, []) === -1 && nextActive('PageUp', 0, []) === -1, 'GU2: no options gives -1');

console.log('--- GU3 highlight ---');
const hl = splitHighlight('Access Control', 'cont');
assert(hl !== null && hl.before === 'Access ' && hl.match === 'Cont' && hl.after === 'rol', 'GU3: the match keeps the text case');
assert(splitHighlight('Access Control', 'zzz') === null, 'GU3: no match gives null');

console.log('--- GU4 announcement ---');
const base = { tooShort: false, loading: false, error: false, count: 0, groups: 0 };
assert(searchAnnouncement({ ...base, tooShort: true }) === 'Type at least 2 characters to search.', 'GU4: too short');
assert(searchAnnouncement({ ...base, loading: true, count: 5 }) === '' && searchAnnouncement({ ...base, error: true }) === '', 'GU4: loading and error are silent');
assert(searchAnnouncement(base) === 'No matches in this program.', 'GU4: no matches');
assert(searchAnnouncement({ ...base, count: 5, groups: 2 }) === '5 results in 2 groups.' && searchAnnouncement({ ...base, count: 1, groups: 1 }) === '1 result in 1 group.', 'GU4: counts');
assert(!JSON.stringify(searchAnnouncement({ ...base, count: 2, groups: 1, ...({ q: 'MARK' } as object) })).includes('MARK'), 'GU4: never the query');

console.log('--- GU5 error text ---');
assert(searchErrorMessage({ status: 429 }) === 'Too many searches. Wait a moment and try again.', 'GU5: 429');
assert(searchErrorMessage({ status: 400 }) === 'Use 2 to 100 characters, without control characters.', 'GU5: 400');
assert(searchErrorMessage('too_many') === searchErrorMessage({ status: 429 }) && searchErrorMessage('invalid') === searchErrorMessage({ status: 400 }), 'GU5: the hook codes give the same texts');
const other = searchErrorMessage(new Error('MARK'));
assert(other === 'Search failed. Check the connection and try again.' && !other.includes('MARK'), 'GU5: any other error is fixed text, never echoed');

console.log('--- GU6 shortcut hint, labels ---');
assert(shortcutHint('MacIntel') === '⌘K' && shortcutHint('Win32') === 'Ctrl K', 'GU6: the hint by platform');
assert(SEARCH_KINDS.every((k) => typeof KIND_LABELS[k] === 'string' && KIND_LABELS[k].length > 0), 'GU6: every kind has a label');
assert(fieldLabel('file name') === 'File name' && fieldLabel('no such field') === 'Match' && fieldLabel('__proto__') === 'Match', 'GU6: field labels fall back to "Match"');

console.log('--- GU7 results list ---');
const listGroups: SearchResponse['groups'] = [
  {
    kind: 'control',
    results: [
      result('control', 'c1', { title: 'Access Control', subtitle: 'AC.L2-3.1.1', snippet: { before: 'See ', match: '<b>x</b>', after: ' here' }, field: 'notes' }),
      result('control', 'c2', { inProgram: false }),
    ],
    truncated: true,
  },
  { kind: 'evidence', results: [result('evidence', 'e1')], truncated: false },
];
const listFlat = flattenOptions(listGroups, 'p');
const html = renderToStaticMarkup(
  React.createElement(SearchResultsList, { groups: listGroups, flat: listFlat, active: 1, q: 'access', idPrefix: 'p', onHover: () => {}, onPick: () => {} })
);
assert(html.includes('role="listbox"'), 'GU7: a listbox');
assert((html.match(/role="option"/g) ?? []).length === 4, 'GU7: three results and one "Show more" are options');
assert((html.match(/aria-selected="true"/g) ?? []).length === 1, 'GU7: exactly one selected option');
assert(html.includes('aria-activedescendant') === false && html.includes('id="p-control-1"'), 'GU7: option ids match flattenOptions');
assert((html.match(/role="group"/g) ?? []).length === 2, 'GU7: a group per kind');
assert(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'), 'GU7: a snippet is plain text, never HTML');
assert(/<mark[^>]*>&lt;b&gt;x&lt;\/b&gt;<\/mark>/.test(html), 'GU7: the snippet match is inside <mark>');
assert(html.includes('<mark') && /<mark[^>]*>Access<\/mark>/.test(html), 'GU7: the title match is marked');
assert(html.includes('Not in this program') && html.includes('Show more controls'), 'GU7: the program note and the "Show more" row');
assert(html.includes('Showing 2, more match'), 'GU7: the cut-off group says more match');

console.log('--- GU8 source: GlobalSearch ---');
const gs = read('src/components/search/GlobalSearch.tsx');
for (const needle of ['role="combobox"', 'aria-activedescendant', 'autoComplete="off"', 'aria-keyshortcuts=', 'max-h-[', "'[data-dialog-overlay]'", 'isSearchShortcut(', 'searchNavPlan(']) {
  assert(gs.includes(needle), `GU8: GlobalSearch contains ${needle}`);
}
for (const bad of ['<form', 'localStorage', 'sessionStorage', 'caches.', 'console.', 'recordAuditEvent', 'pushState', 'replaceState', '?q=', 'dangerouslySetInnerHTML', 'javascript:', 'alert(']) {
  assert(!gs.includes(bad), `GU8: GlobalSearch has no ${bad}`);
}
for (const rel of ['src/data/search/searchUiView.ts', 'src/hooks/usePendingFocus.ts']) {
  const s = read(rel);
  assert(!/localStorage|sessionStorage|console\.|dangerouslySetInnerHTML/.test(s), `GU8: ${rel} has no storage, console or raw HTML`);
}
assert(!/from 'react|from '\.\.\/(services|context)/.test(read('src/data/search/searchUiView.ts')), 'GU8: searchUiView is pure (no react, service or context import)');

console.log('--- GU9 source: Header, context, consumers ---');
const header = read('src/components/layout/Header.tsx');
const iFw = header.indexOf('<FrameworkSwitcher />');
const iGs = header.indexOf('<GlobalSearch />');
const iUp = header.indexOf('<UserProfileDropdown />');
assert(iFw >= 0 && iFw < iGs && iGs < iUp, 'GU9: the header mounts GlobalSearch after the switchers and before the profile menu');
assert(header.includes("hidden xl:inline\">What's new") && header.includes('xl:px-2.5 xl:py-1.5') && !header.includes('lg:px-2.5'), "GU9: What's new shows its text from xl, as the search button does");
const ctx = read('src/context/AssessmentContext.tsx');
assert(ctx.includes('requestFocus:') && ctx.includes('pendingFocus:') && ctx.includes('clearPendingFocus:'), 'GU9: the context carries the pending focus request');
assert(ctx.includes('setPendingFocus(null)'), 'GU9: a program or organization switch drops a pending focus');
assert(read('src/components/telemetry/AssetInventoryManager.tsx').includes("usePendingFocus('asset'") && read('src/components/telemetry/AssetInventoryManager.tsx').includes('data-asset-id={asset.id}'), 'GU9: asset rows take the focus');
assert(read('src/components/reports/PoamControlsSection.tsx').includes("usePendingFocus('poam_control'"), 'GU9: POA&M control entries open from a result');
assert(read('src/components/reports/PoamVulnerabilitiesSection.tsx').includes("usePendingFocus('poam_vm'"), 'GU9: vulnerability items open from a result');
assert(read('src/components/inventory/ToolRegisterPanel.tsx').includes("usePendingFocus('tool'") && read('src/components/inventory/ToolRegisterPanel.tsx').includes('data-tool-id={t.id}'), 'GU9: tool rows take the focus');
assert(read('src/components/inventory/VendorRegisterPanel.tsx').includes("usePendingFocus('vendor'") && read('src/components/inventory/VendorRegisterPanel.tsx').includes('data-vendor-id={v.id}'), 'GU9: vendor rows take the focus');
for (const rel of ['src/components/telemetry/AssetInventoryManager.tsx', 'src/components/reports/PoamControlsSection.tsx', 'src/components/reports/PoamVulnerabilitiesSection.tsx', 'src/components/inventory/ToolRegisterPanel.tsx', 'src/components/inventory/VendorRegisterPanel.tsx']) {
  assert(read(rel).includes('PENDING_FOCUS_MISSED'), `GU9: ${rel.split('/').pop()} says so when the item is not listed`);
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
