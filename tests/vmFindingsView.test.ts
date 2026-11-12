import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VmFinding } from '../src/types/vm';
import {
  FINDINGS_COPY,
  affectedPackagesView,
  filterFindings,
  findingsCapNotice,
  findingsCaption,
  findingsEmptyMessage,
  fixText,
  moreText,
  packageLabel,
  parseVmFindings,
  severityCounts,
  sortFindings,
} from '../src/data/telemetry/vmFindingsView';
import { VmFindingsList } from '../src/components/telemetry/VmFindingsList';

/**
 * Vulnerability findings list (read-only, in the per-asset scanner data dialog): the parser, the order, the filters, the captions
 * and the list's states and wiring. Pure test: no server, no browser.
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

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const finding = (over: Partial<VmFinding> = {}): VmFinding => ({
  id: 'f1', tenantId: 't1', assetId: 'a1', vulnId: 'CVE-2024-0001', status: 'OPEN', severity: 'HIGH',
  firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z', resolvedAt: null, resolvedRunId: null, slaDueAt: null,
  packageName: 'openssl', packageVersion: '3.0.1', fixedVersion: '3.0.2',
  affectedPackages: [{ name: 'openssl', version: '3.0.1', fixedVersion: '3.0.2' }], affectedPackageCount: 1,
  justification: null, decidedBy: null, decidedByUserId: null, decidedAt: null,
  ...over,
});

const pkgs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `pkg${i}`, version: '1.0', fixedVersion: null }));

console.log('\n--- Parser ---');
{
  const p = parseVmFindings({ tenantId: 't1', totalCount: 2, findings: [finding(), finding({ id: 'f2', vulnId: 'CVE-2024-0002', severity: 'LOW' })] });
  assert(p.findings.length === 2 && p.totalCount === 2 && p.findings[0].vulnId === 'CVE-2024-0001' && p.findings[0].affectedPackages[0].fixedVersion === '3.0.2', 'PF1 a well-formed body parses');
}
{
  const p = parseVmFindings({ findings: [null, 'x', 5, { vulnId: 'CVE-1', status: 'OPEN' }, { id: 'a', status: 'OPEN' }, { id: 'b', vulnId: 'CVE-2', status: 'WEIRD' }, finding()] });
  assert(p.findings.length === 1 && p.findings[0].id === 'f1', 'PF2 drops a non-object item, a missing id or vulnId, and an unknown status', p.findings.map((f) => f.id));
}
{
  const p = parseVmFindings({ findings: [{ ...finding(), severity: 'SEVERE' }, { ...finding({ id: 'f2' }), severity: undefined }] });
  assert(p.findings.length === 2 && p.findings.every((f) => f.severity === 'UNKNOWN'), 'PF3 an unknown severity becomes UNKNOWN');
}
{
  const bad = [parseVmFindings(null), parseVmFindings('x'), parseVmFindings([]), parseVmFindings({}), parseVmFindings({ findings: 'no' })];
  assert(bad.every((b) => b.findings.length === 0 && b.totalCount === 0), 'PF4 a body that is not an object, or has no findings array, gives [] and totalCount 0');
}
{
  const p = parseVmFindings({ findings: [{ ...finding(), affectedPackages: [{ name: '' }, null, 'x', { name: 'zlib', version: '1', fixedVersion: 7 }, { name: 'curl' }], affectedPackageCount: undefined }] });
  const f = p.findings[0];
  assert(f.affectedPackages.length === 2 && f.affectedPackages[0].fixedVersion === null && f.affectedPackages[1].version === '' && f.affectedPackageCount === 2 && p.totalCount === 1, 'PF5 a malformed package is dropped and the count falls back to the list length', f.affectedPackages);
}

console.log('\n--- Sort ---');
{
  const list = [
    finding({ id: '1', severity: 'LOW' }), finding({ id: '2', severity: 'UNKNOWN' }), finding({ id: '3', severity: 'MEDIUM' }),
    finding({ id: '4', severity: 'HIGH' }), finding({ id: '5', severity: 'CRITICAL' }),
  ];
  assert(sortFindings(list).map((f) => f.id).join('') === '54321', 'SO1 order CRITICAL, HIGH, MEDIUM, UNKNOWN, LOW');
}
{
  const s = sortFindings([finding({ id: 'old', lastSeenAt: '2026-10-01T00:00:00Z' }), finding({ id: 'new', lastSeenAt: '2026-11-05T00:00:00Z' })]);
  assert(s[0].id === 'new', 'SO2 same severity puts the newest lastSeen first');
}
{
  const s = sortFindings([finding({ id: 'bad', lastSeenAt: 'nope' }), finding({ id: 'ok', lastSeenAt: '2026-01-01T00:00:00Z' })]);
  assert(s[0].id === 'ok' && s[1].id === 'bad', 'SO3 an unreadable lastSeen goes last');
}
{
  const s = sortFindings([finding({ id: 'b', vulnId: 'CVE-2024-0009' }), finding({ id: 'a', vulnId: 'CVE-2024-0003' })]);
  assert(s[0].id === 'a', 'SO4 a tie sorts by vulnId A to Z');
}
{
  const input = [finding({ id: 'l', severity: 'LOW' }), finding({ id: 'c', severity: 'CRITICAL' })];
  const out = sortFindings(input);
  assert(input[0].id === 'l' && input[1].id === 'c' && out !== input && out[0].id === 'c', 'SO5 the input array is unchanged');
}

console.log('\n--- Packages ---');
{
  const v = affectedPackagesView(finding({ affectedPackages: pkgs(5), affectedPackageCount: 5 }));
  assert(v.shown.length === 3 && v.more === 2, 'PK1 5 packages give 3 shown and more 2', v);
}
{
  const v = affectedPackagesView(finding({ affectedPackages: pkgs(50), affectedPackageCount: 120 }));
  assert(v.shown.length === 3 && v.more === 117, 'PK2 count 120 with 50 stored gives more 117', v);
}
{
  const v = affectedPackagesView(finding({ affectedPackages: [], affectedPackageCount: 0, packageName: 'bash', packageVersion: '5.1', fixedVersion: null }));
  assert(v.shown.length === 1 && v.shown[0].name === 'bash' && v.shown[0].version === '5.1' && v.more === 0, 'PK3 an empty list falls back to packageName', v);
}
{
  const v = affectedPackagesView(finding({ affectedPackages: [], affectedPackageCount: 0, packageName: '' }));
  assert(v.shown.length === 0 && v.more === 0, 'PK4 no package at all gives shown []', v);
}
assert(
  packageLabel({ name: 'openssl', version: '' }) === 'openssl' && packageLabel({ name: 'openssl', version: '3.0' }) === 'openssl 3.0'
    && fixText({ fixedVersion: '3.0.2' }) === 'fixed in 3.0.2' && fixText({ fixedVersion: null }) === 'no fix reported' && moreText(1) === 'and 1 more',
  'PK5 package label, fix text and more text',
);

console.log('\n--- Filter ---');
const mixed = [
  finding({ id: 'a', vulnId: 'CVE-2024-1111', severity: 'CRITICAL', packageName: 'openssl', affectedPackages: [{ name: 'openssl', version: '1', fixedVersion: null }] }),
  finding({ id: 'b', vulnId: 'CVE-2023-2222', severity: 'LOW', packageName: 'zlib', affectedPackages: [{ name: 'zlib', version: '1', fixedVersion: null }, { name: 'libcurl', version: '2', fixedVersion: null }] }),
  finding({ id: 'c', vulnId: 'CVE-2024-3333', severity: 'LOW', packageName: 'bash', affectedPackages: [] }),
];
assert(filterFindings(mixed, '', 'ALL').length === 3 && filterFindings(mixed, '   ', 'ALL').length === 3, 'FI1 a blank or whitespace query keeps all');
assert(filterFindings(mixed, 'cve-2024', 'ALL').map((f) => f.id).join('') === 'ac', 'FI2 cve-2024 matches CVE-2024-...');
assert(filterFindings(mixed, 'LIBCURL', 'ALL').map((f) => f.id).join('') === 'b' && filterFindings(mixed, 'bash', 'ALL').map((f) => f.id).join('') === 'c', 'FI3 matches a package name');
assert(filterFindings(mixed, '', 'LOW').map((f) => f.id).join('') === 'bc' && filterFindings(mixed, '', 'HIGH').length === 0, 'FI4 the severity filter');
assert(filterFindings(mixed, 'cve-2024', 'LOW').map((f) => f.id).join('') === 'c', 'FI5 query and severity combined');

console.log('\n--- Counts and captions ---');
{
  const c = severityCounts(mixed);
  assert(c.CRITICAL === 1 && c.LOW === 2 && c.HIGH === 0 && c.MEDIUM === 0 && c.UNKNOWN === 0, 'CO1 severityCounts', c);
}
assert(findingsCaption(96, 96) === 'Showing 96 findings', 'CA1 caption, all shown');
assert(findingsCaption(1, 1) === 'Showing 1 finding', 'CA2 caption, singular');
assert(findingsCaption(3, 96) === 'Showing 3 of 96 findings', 'CA3 caption, filtered');
assert(findingsCapNotice(999) === null && (findingsCapNotice(1000) ?? '').includes('1000'), 'CN1 the cap notice appears only at the fetch limit');
assert(findingsEmptyMessage({ statusFilter: 'OPEN', scannerReported: false }) === FINDINGS_COPY.noScanner && findingsEmptyMessage({ statusFilter: 'ALL', scannerReported: false }) === FINDINGS_COPY.noScanner, 'EM1 no scanner reported, Open or All');
assert(findingsEmptyMessage({ statusFilter: 'OPEN', scannerReported: true }) === FINDINGS_COPY.noOpen && findingsEmptyMessage({ statusFilter: 'OPEN', scannerReported: null }) === FINDINGS_COPY.noOpen, 'EM2 Open, scanner reported or unknown');
assert(findingsEmptyMessage({ statusFilter: 'ALL', scannerReported: true }) === FINDINGS_COPY.noneAll && findingsEmptyMessage({ statusFilter: 'ALL', scannerReported: null }) === FINDINGS_COPY.noneAll, 'EM3 All, scanner reported or unknown');
assert(findingsEmptyMessage({ statusFilter: 'RISK_ACCEPTED', scannerReported: false }) === 'No risk accepted findings for this asset.' && findingsEmptyMessage({ statusFilter: 'FALSE_POSITIVE', scannerReported: true }) === 'No false positive findings for this asset.', 'EM4 any other status names it');

console.log('\n--- Render ---');
const noop = () => {};
const render = (over: Partial<React.ComponentProps<typeof VmFindingsList>> = {}): string =>
  renderToStaticMarkup(React.createElement(VmFindingsList, { status: 'ready', findings: [], statusFilter: 'OPEN', onStatusFilterChange: noop, onRetry: noop, scannerReported: true, ...over }));
assert(render({ status: 'loading' }).includes(FINDINGS_COPY.loading) && render({ status: 'idle' }).includes(FINDINGS_COPY.loading) && render({ status: 'loading' }).includes('aria-busy="true"'), 'RL1 loading copy');
{
  const html = render({ status: 'error' });
  assert(html.includes('role="alert"') && html.includes('>Retry<') && html.includes(FINDINGS_COPY.loadError), 'RL2 error has role="alert" and a Retry button');
}
assert(render({ scannerReported: false }).includes(FINDINGS_COPY.noScanner) && render({ scannerReported: true }).includes(FINDINGS_COPY.noOpen) && render().includes('All statuses'), 'RL3 the empty states, with the Status select still present');
{
  const html = render({ findings: [finding({ severity: 'CRITICAL', affectedPackages: pkgs(5), affectedPackageCount: 5, id: 'x1' })] });
  assert(
    html.includes('CVE-2024-0001') && html.includes('Critical') && html.includes('no fix reported') && html.includes('and 2 more') && html.includes('scope="row"') && html.includes(FINDINGS_COPY.caption) && html.includes('Showing 1 finding'),
    'RL4 a populated list shows the id, severity, fix text, more text, row header, caption and count',
  );
  assert(!html.includes('<a ') && !html.includes('href='), 'RL4b no links in the list');
}
{
  const many = Array.from({ length: 150 }, (_, i) => finding({ id: `f${i}`, vulnId: `CVE-2024-${String(i).padStart(4, '0')}` }));
  const html = render({ findings: many });
  const body = html.slice(html.indexOf('<tbody'));
  assert((body.match(/<tr/g) ?? []).length === 100 && html.includes('Show 50 more'), 'RL5 150 findings render 100 body rows and Show 50 more');
}
{
  const html = render({ findings: [finding({ vulnId: '<img src=x>', affectedPackages: [{ name: '<img src=y>', version: '1', fixedVersion: null }] })] });
  assert(html.includes('&lt;img') && !html.includes('<img src='), 'RL6 markup in a vulnerability id or package name is escaped');
}
{
  const html = render({ findings: [finding({ justification: 'secret reason', decidedBy: 'someone@example.com' })] });
  assert(!html.includes('secret reason') && !html.includes('someone@example.com'), 'RL7 justification and decider are never shown');
}

console.log('\n--- Source checks ---');
const dialog = read('src/components/telemetry/AssetScannerDataDialog.tsx');
const hook = read('src/hooks/useVmFindings.ts');
const list = read('src/components/telemetry/VmFindingsList.tsx');
const view = read('src/data/telemetry/vmFindingsView.ts');
const client = read('src/services/apiClient.ts');
assert(dialog.includes('<VmFindingsList') && dialog.includes('useVmFindings(') && dialog.includes('max-h-[90vh]') && dialog.includes('Scanner data: {asset.hostName}'), 'SC1 the dialog shows the list and keeps its scroll and title');
assert(hook.includes('seq.current !== mine') && !/err\.message|errorMessage/.test(hook), 'SC2 the hook ignores stale answers and never reads an error message');
assert([hook, list, view].every((s) => !/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|http/.test(s)), 'SC3 no console, storage, raw HTML or URL in the new source files');
{
  const start = client.indexOf('async listVmFindings(tenantId: string, options?:');
  const end = client.indexOf('\n  },', start);
  const body = start >= 0 ? client.slice(start, end) : '';
  assert(start >= 0 && body.includes("'GET'") && body.includes('/vm/findings') && !body.includes('programId'), 'SC4 listVmFindings is a tenant-wide GET with no programId');
}
assert(!list.includes('ApiClient') && !hook.includes('programId'), 'SC5 the list does not import ApiClient');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
