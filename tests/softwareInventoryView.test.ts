import fs from 'fs';
import path from 'path';
import {
  APPROVAL_LABELS,
  approvalChoice,
  approvedFromChoice,
  assetOptions,
  filterSoftware,
  hostNameMap,
  installedOnLabel,
  softwareCountCaption,
  softwareEmptyMessage,
  softwareErrorMessage,
  softwareExportLine,
  validateSoftwareName,
} from '../src/data/softwareInventoryView';
import { parseServerSoftwareItems } from '../src/data/telemetry/softwareItems';
import type { SoftwareItem } from '../src/types/software';

/**
 * Software Inventory panel and dialog (issue #229, phase 1b): the pure view logic, the response parser and source
 * invariants (no console, no browser storage, no program id on tenant-wide calls). No server, no browser.
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

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const item = (over: Partial<SoftwareItem> & { name: string }): SoftwareItem => ({
  id: over.id ?? `id-${over.name}`,
  tenantId: 't1',
  version: '',
  vendor: '',
  approved: null,
  assetId: null,
  notes: '',
  createdAt: '',
  updatedAt: '',
  ...over,
});

function main() {
  console.log('\n🧪 Software inventory view\n');

  // SW1
  assert(approvalChoice(true) === 'APPROVED' && approvalChoice(false) === 'NOT_APPROVED' && approvalChoice(null) === 'NOT_REVIEWED', 'SW1 approvalChoice');
  assert(([true, false, null] as Array<boolean | null>).every((a) => approvedFromChoice(approvalChoice(a)) === a), 'SW1 round trip');
  assert(APPROVAL_LABELS.NOT_REVIEWED === 'Not reviewed', 'SW1 labels');

  // SW2-SW5
  const hosts = hostNameMap([{ id: 'a1', hostName: 'WS-01' }, { id: 'a2', hostName: '  ' }]);
  assert(installedOnLabel(null, hosts, false) === 'Tenant-wide', 'SW2 tenant-wide');
  assert(installedOnLabel('a1', hosts, true) === 'Loading…', 'SW3 loading');
  assert(installedOnLabel('zz', hosts, false) === 'Asset not in the inventory', 'SW4 unknown asset');
  assert(installedOnLabel('a2', hosts, false) === 'Unnamed asset' && installedOnLabel('a1', hosts, false) === 'WS-01', 'SW5 blank and named host');

  // SW6-SW8
  const items = [
    item({ name: 'Google Chrome', version: '120', vendor: 'Google', approved: true }),
    item({ name: 'Notepad Plus', assetId: 'a1', approved: false, notes: 'legacy' }),
    item({ name: 'Mystery Tool', approved: null }),
  ];
  assert(filterSoftware(items, { query: '  CHROME ', approval: 'ALL' }, hosts).map((i) => i.name).join() === 'Google Chrome', 'SW6 trimmed case-insensitive query');
  assert(filterSoftware(items, { query: 'ws-01', approval: 'ALL' }, hosts).map((i) => i.name).join() === 'Notepad Plus', 'SW7 query matches the host name');
  assert(filterSoftware(items, { query: '', approval: 'NOT_REVIEWED' }, hosts).map((i) => i.name).join() === 'Mystery Tool', 'SW8 not reviewed filter');
  assert(filterSoftware(items, { query: '', approval: 'APPROVED' }, hosts).length === 1 && filterSoftware(items, { query: '', approval: 'NOT_APPROVED' }, hosts).length === 1, 'SW8 approved / not approved filters');

  // SW9
  const sorted = filterSoftware(['b', 'A', 'a10', 'a9'].map((name) => item({ name })), { query: '', approval: 'ALL' }, hosts).map((i) => i.name);
  assert(sorted.join() === 'A,a9,a10,b', 'SW9 sort by name, numeric and case-insensitive', sorted);
  const byVersion = filterSoftware([item({ name: 'x', version: '10' }), item({ name: 'x', version: '9' })], { query: '', approval: 'ALL' }, hosts).map((i) => i.version);
  assert(byVersion.join() === '9,10', 'SW9 then by version', byVersion);

  // SW10
  const opts = assetOptions([
    { id: '2', hostName: 'zeta', ipAddress: '10.0.0.2' },
    { id: '1', hostName: 'alpha', ipAddress: '10.0.0.1' },
    { id: '3', hostName: '', ipAddress: '10.0.0.3' },
  ]);
  assert(opts.map((o) => o.id).join() === '3,1,2', 'SW10 asset options sorted by host name', opts);
  assert(opts[0].label === 'Unnamed asset (10.0.0.3)' && opts[1].label === 'alpha (10.0.0.1)', 'SW10 labels', opts);

  // SW11
  assert(softwareEmptyMessage({ total: 0, shown: 0, canEdit: true }) === 'No software recorded yet. Add the applications in your assessment boundary, tenant-wide or per asset, and record whether each is approved.', 'SW11 empty, can edit');
  assert(softwareEmptyMessage({ total: 0, shown: 0, canEdit: false }) === 'No software recorded yet. A Tenant Owner or MSP Admin can add entries.', 'SW11 empty, read-only');
  assert(softwareEmptyMessage({ total: 4, shown: 0, canEdit: true }) === 'No software entries match your search and filter.', 'SW11 no match');

  // SW12
  assert(validateSoftwareName('') === 'Enter the software name.' && validateSoftwareName('   ') === 'Enter the software name.' && validateSoftwareName('x') === null, 'SW12 name validation');

  // SW13
  const msg = (e: unknown, a: 'save' | 'delete' = 'save') => softwareErrorMessage(e, a);
  assert(msg({ reason: 'invalid' }) === 'The server did not accept this entry. Check that the name is filled in and no field is too long. Nothing was saved.', 'SW13 invalid');
  assert(msg({ reason: 'asset_not_found' }) === 'That asset is not in this tenant. Choose another asset or Tenant-wide. Nothing was saved.', 'SW13 asset_not_found');
  assert(msg({ reason: 'not_found' }) === 'This software entry was removed meanwhile. The list has been refreshed.', 'SW13 not_found');
  assert(msg({ reason: 'limit' }) === 'This organization already has 5,000 software entries, the most it can hold. Remove entries you no longer need, then try again.', 'SW13 limit');
  assert(msg({ status: 403 }) === 'Only a Tenant Owner or MSP Admin can change the software inventory. Nothing was saved.', 'SW13 403');
  assert(msg({ status: 0 }) === 'The server could not be reached. Nothing was saved; try again.', 'SW13 unreachable');
  assert(msg({ status: 500 }) === 'The software entry could not be saved. Try again.' && msg(new Error('Acme Corp secret'), 'delete') === 'The software entry could not be removed. Try again.', 'SW13 fallbacks');
  assert(!msg(new Error('Acme Corp secret')).includes('Acme'), 'SW13 never echoes the error text');
  assert(msg(null) === 'The software entry could not be saved. Try again.', 'SW13 null error');

  // SW14
  assert(softwareCountCaption(1, 1) === '1 entry' && softwareCountCaption(12, 12) === '12 entries' && softwareCountCaption(3, 12) === '3 of 12 entries', 'SW14 count caption');

  // SW15
  assert(softwareExportLine({ supported: false, loading: false, error: false, count: 0 }) === "Software: this organization is stored only in this browser, so no software entries exist; the document lists each asset's operating system.", 'SW15 not supported');
  assert(softwareExportLine({ supported: true, loading: false, error: true, count: 0 }) === 'Software: the software inventory could not be loaded, so this document lists no software entries.', 'SW15 error');
  assert(softwareExportLine({ supported: true, loading: true, error: false, count: 0 }) === 'Software: loading the software inventory…', 'SW15 loading');
  assert(softwareExportLine({ supported: true, loading: false, error: false, count: 3 }) === 'Software: 3 entries.' && softwareExportLine({ supported: true, loading: false, error: false, count: 1 }) === 'Software: 1 entry.', 'SW15 counts');

  // SW16
  const parsed = parseServerSoftwareItems([{ id: 's', name: 'n' }, { name: 'x' }, null]);
  assert(parsed.length === 1 && parsed[0].id === 's' && parsed[0].version === '' && parsed[0].assetId === null && parsed[0].approved === null, 'SW16 keeps valid entries, defaults the rest', parsed);
  assert(parseServerSoftwareItems([{ id: 's', name: 'n', approved: 'yes', assetId: 7 }])[0].approved === null, 'SW16 non-boolean approved is null');
  assert(parseServerSoftwareItems([{ id: 's', name: 'n', approved: false, assetId: 'a1' }])[0].approved === false, 'SW16 boolean approved kept');
  assert(parseServerSoftwareItems([{ id: 's', name: 'n', assetId: 7 }])[0].assetId === null && parseServerSoftwareItems('nope').length === 0, 'SW16 non-string assetId is null; non-array is empty');

  // SW17
  const panel = read('src/components/telemetry/SoftwareInventoryPanel.tsx');
  const dialog = read('src/components/telemetry/SoftwareItemDialog.tsx');
  const hook = read('src/hooks/useSoftwareItems.ts');
  const service = read('src/services/softwareService.ts');
  for (const [label, text] of [['panel', panel], ['dialog', dialog], ['hook', hook], ['service', service]] as const) {
    assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML/.test(text), `SW17 ${label} has no console, browser storage or raw HTML`);
  }
  assert(dialog.includes('max-h-[85vh]') && dialog.includes('<ErrorNotice'), 'SW17 dialog is height-capped and uses ErrorNotice');
  assert(panel.indexOf('{canEdit && ') !== -1 && panel.indexOf('{canEdit && ') < panel.indexOf('Add Software'), 'SW17 Add Software is gated by canEdit');
  const api = read('src/services/apiClient.ts');
  for (const name of ['listSoftwareItems', 'createSoftwareItem', 'updateSoftwareItem', 'deleteSoftwareItem']) {
    const m = api.match(new RegExp(`async ${name}\\(([^)]*)\\)`));
    assert(Boolean(m) && !/programId/.test(m![1]), `SW17 ApiClient.${name} takes no programId`);
  }
  assert(read('src/App.tsx').includes('<SoftwareInventoryPanel />'), 'SW17 App renders the panel');
  const modal = read('src/components/reports/ArtifactExportModal.tsx');
  assert(modal.includes('data-testid="software-inventory-scope"') && modal.includes('useSoftwareItems('), 'SW17 Export Center shows the software scope and loads the items');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main();
