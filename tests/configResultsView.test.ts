import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_RESULTS_COPY, EXPORTER_XCCDF_COMMAND, applyBlock, applyConfirmText, applyResultMessage, archivedMessage, assetLabel, boundaryCaption,
  countSummary, failingAssetNames, groupResultCounts, noSuggestionsMessage, outsideNote, ruleSummary, shownCaption, sortScanRows,
  sortSuggestions, splitByProgramControls, statusLabel, suggestionLabel, suggestionStatus, unmappedNote, unsupportedMessage,
} from '../src/data/telemetry/configResultsView';
import type { ControlDecisionOutcome } from '../src/data/telemetry/configResultsView';
import type { VmConfigScan, VmConfigSuggestion, VmConfigSuggestionValue } from '../src/types/vm';

/**
 * Configuration results screen (#103): the pure helpers and copy of ConfigurationResultsView, plus source checks that the simulated
 * scan engine is gone, that Apply is only ever a person's confirmed click, and that nothing is stored or logged. No server.
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
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p: string): boolean => fs.existsSync(path.join(root, p));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const sug = (controlId: string, suggestion: VmConfigSuggestionValue): VmConfigSuggestion => ({
  controlId,
  suggestion,
  assets: { inScope: 1, evaluated: 1, failing: 0, passing: 1, error: 0, unconfirmed: 0 },
  rules: { mapped: 1, failing: 0 },
  failingAssetIds: [],
  latestScanAt: null,
});
const scanOf = (id: string, assetId: string, benchmarkTitle: string, scannedAt = '2026-10-01T00:00:00.000Z'): VmConfigScan => ({
  id, tenantId: 't', runId: 'r', sourceId: 's', assetId, benchmarkId: 'b', benchmarkVersion: '', benchmarkTitle, profileId: '', profileTitle: '',
  scannerName: 'x', scannerVersion: '', startedAt: null, scannedAt, receivedAt: scannedAt, sourceSha256: null,
  resultCounts: { pass: 0, fail: 0, error: 0, unknown: 0, notapplicable: 0, notchecked: 0, notselected: 0, informational: 0, fixed: 0 },
});

function main() {
  console.log('\n--- helpers (V5) ---');
  assert(statusLabel('NOT_MET') === 'NOT MET' && statusLabel('IN_PROGRESS') === 'IN PROGRESS' && statusLabel('MET') === 'MET' && statusLabel('NOT_STARTED') === 'NOT STARTED', 'V5a statusLabel');
  assert(suggestionLabel('MET') === 'Suggests MET' && suggestionLabel('NOT_MET') === 'Suggests NOT MET' && suggestionLabel('REVIEW') === 'Needs review', 'V5b suggestionLabel');
  assert(suggestionStatus('MET') === 'MET' && suggestionStatus('NOT_MET') === 'NOT_MET' && suggestionStatus('REVIEW') === null, 'V5c suggestionStatus');
  const ok = { canEdit: true, archived: false, controlsLoaded: true };
  assert(
    applyBlock({ suggestion: 'REVIEW', currentStatus: 'NOT_STARTED', ...ok }) === 'review' &&
      applyBlock({ suggestion: 'NOT_MET', currentStatus: 'NOT_MET', ...ok }) === 'matches' &&
      applyBlock({ suggestion: 'NOT_MET', currentStatus: 'MET', ...ok, canEdit: false }) === 'read_only' &&
      applyBlock({ suggestion: 'NOT_MET', currentStatus: 'MET', ...ok, archived: true }) === 'archived' &&
      applyBlock({ suggestion: 'NOT_MET', currentStatus: 'MET', ...ok, controlsLoaded: false }) === 'not_loaded' &&
      applyBlock({ suggestion: 'MET', currentStatus: 'IN_PROGRESS', ...ok }) === null &&
      applyBlock({ suggestion: 'REVIEW', currentStatus: 'MET', canEdit: false, archived: true, controlsLoaded: false }) === 'review',
    'V5d applyBlock, in order'
  );
  assert(
    countSummary({ inScope: 4, evaluated: 3, failing: 1, passing: 2, error: 0, unconfirmed: 1 }) === '1 failing, 2 passing, 0 with errors; 3 of 4 in-scope assets evaluated; 1 unclassified asset included' &&
      countSummary({ inScope: 1, evaluated: 1, failing: 0, passing: 1, error: 0, unconfirmed: 0 }) === '0 failing, 1 passing, 0 with errors; 1 of 1 in-scope asset evaluated' &&
      countSummary({ inScope: 4, evaluated: 3, failing: 1, passing: 2, error: 0, unconfirmed: 2 }).endsWith('; 2 unclassified assets included'),
    'V5e countSummary'
  );
  assert(ruleSummary({ mapped: 2, failing: 1 }) === '1 of 2 mapped rules failing' && ruleSummary({ mapped: 1, failing: 0 }) === '0 of 1 mapped rule failing', 'V5f ruleSummary');
  assert(
    same(groupResultCounts({ pass: 5, fixed: 1, fail: 2, error: 1, unknown: 1, notapplicable: 3, notchecked: 1, notselected: 0, informational: 2 }), { pass: 6, fail: 2, error: 2, other: 6 }) &&
      same(groupResultCounts({}), { pass: 0, fail: 0, error: 0, other: 0 }),
    'V5g groupResultCounts'
  );
  const names = new Map([['a1', 'WS-01']]);
  assert(assetLabel('a1', names) === 'WS-01' && assetLabel('zz', names) === 'Unknown asset', 'V5h assetLabel');
  const nm = new Map([['a', 'A'], ['c', 'C']]);
  const many = failingAssetNames(['1', '2', '3', '4', '5', '6', '7'], new Map(), 5);
  assert(same(failingAssetNames(['a', 'b', 'c'], nm), { shown: ['A', 'Unknown asset', 'C'], more: 0 }) && many.shown.length === 5 && many.more === 2, 'V5i failingAssetNames');
  const unsorted = [sug('AC.L2-3.1.10', 'MET'), sug('AC.L1-3.1.1', 'REVIEW'), sug('IA.L2-3.5.7', 'NOT_MET'), sug('AC.L2-3.1.2', 'MET')];
  const before = JSON.stringify(unsorted);
  assert(same(sortSuggestions(unsorted).map((s) => s.controlId), ['IA.L2-3.5.7', 'AC.L1-3.1.1', 'AC.L2-3.1.2', 'AC.L2-3.1.10']) && JSON.stringify(unsorted) === before, 'V5j sortSuggestions orders and never mutates');
  const rows = [scanOf('s1', 'b', 'RHEL 9'), scanOf('s2', 'a', 'Windows 11'), scanOf('s3', 'a', 'RHEL 9')];
  assert(same(sortScanRows(rows, new Map([['a', 'host-2'], ['b', 'host-10']])).map((s) => s.id), ['s3', 's2', 's1']), 'V5k sortScanRows');
  assert(
    boundaryCaption({ declared: true, inScope: 3, evaluated: 2 }, 'Lab') === 'Lab boundary: 2 of 3 in-scope assets have configuration results.' &&
      boundaryCaption({ declared: false, inScope: 1, evaluated: 0 }, 'Lab') === 'Lab has not declared its assets, so suggestions use the whole inventory: 0 of 1 in-scope asset has configuration results.',
    'V5l boundaryCaption'
  );
  assert(
    unsupportedMessage('SOC 2 Type II') === 'Configuration rules are not mapped to SOC 2 Type II controls, so this program gets no suggestions. Suggestions are available for CMMC Level 1, CMMC Level 2 and NIST SP 800-53 programs. The scan results above are still shown.',
    'V5m unsupportedMessage'
  );
  assert(
    unmappedNote(0) === '' &&
      unmappedNote(1) === '1 rule in the latest scans is not mapped to a control yet and does not count toward any suggestion.' &&
      unmappedNote(3) === '3 rules in the latest scans are not mapped to a control yet and do not count toward any suggestion.',
    'V5n unmappedNote'
  );
  assert(
    applyConfirmText('AC.L1-3.1.1', 'IN_PROGRESS', 'NOT_MET') === 'Record AC.L1-3.1.1 as NOT MET? It is IN PROGRESS now. This is your decision: it is saved under your name in the control history. The scan result is only a suggestion.',
    'V5o applyConfirmText'
  );
  const msg = (o: ControlDecisionOutcome) => applyResultMessage(o, 'AC.L1-3.1.1', 'MET');
  assert(
    msg('saved') === 'AC.L1-3.1.1 recorded as MET.' &&
      msg('stale') === 'Someone else changed AC.L1-3.1.1 after this page loaded it, so nothing was saved. Reload to see the current status, then decide again.' &&
      msg('archived') === 'AC.L1-3.1.1 was not saved: this program is archived and its controls are read-only.' &&
      msg('unreachable') === 'The server could not be reached, so AC.L1-3.1.1 was not saved.' &&
      msg('failed') === 'AC.L1-3.1.1 was not saved. Try again, or set the status in the control matrix.' &&
      msg('read_only') === 'AC.L1-3.1.1 was not saved: only a Tenant Owner or MSP Admin can record a control status.' &&
      msg('not_loaded') === 'AC.L1-3.1.1 was not saved: the controls are not loaded from the server yet.',
    'V5p applyResultMessage, all seven outcomes'
  );
  assert(shownCaption(500, 812, 'scans') === 'Showing 500 of 812 scans.' && shownCaption(3, 3, 'scans') === '', 'V5q shownCaption');
  assert(archivedMessage('Lab') === 'Lab is archived: its controls are read-only, so no suggestion can be applied.', 'V5r archivedMessage');
  assert(noSuggestionsMessage() === 'None of the latest results map to a control of this program, so there are no suggestions.', 'V5s noSuggestionsMessage');
  const sp = splitByProgramControls([sug('A', 'MET'), sug('B', 'MET')], new Set(['A']));
  assert(sp.shown.length === 1 && sp.shown[0].controlId === 'A' && sp.outside === 1 && outsideNote(0) === '' && outsideNote(1).startsWith('1 suggestion is for controls outside'), 'V5t splitByProgramControls and outsideNote');
  assert(
    CONFIG_RESULTS_COPY.browserOnly.startsWith('Configuration results need a server-backed organization.') &&
      CONFIG_RESULTS_COPY.noResults === 'No configuration scan results have been received yet.' &&
      CONFIG_RESULTS_COPY.notApplied === 'Suggestion, not applied' &&
      EXPORTER_XCCDF_COMMAND === 'pbc-vm-exporter --source xccdf --input <file>',
    'V5u the fixed copy'
  );
  const helperSrc = read('src/data/telemetry/configResultsView.ts');
  const nonTypeImports = helperSrc.split('\n').filter((l) => /^import /.test(l) && !/^import type /.test(l));
  assert(nonTypeImports.length === 0 && !/react|console\.|localStorage|sessionStorage|fetch\(/.test(helperSrc.replace(/\/\*[\s\S]*?\*\//, '')), 'V5v the helper module is pure: type imports only, no react, console, storage or fetch');

  console.log('\n--- source checks ---');
  const view = read('src/components/telemetry/ConfigurationResultsView.tsx');
  const forbidden = ['Math.random', 'generateSimulatedScanReport', 'ingestScapScanReport', 'updateControlStatus(', 'setTimeout(', 'console.', 'localStorage', 'sessionStorage'].filter((s) => view.includes(s));
  const applyStart = view.indexOf('const confirmApply = async');
  const applyEnd = view.indexOf('\n  };\n', applyStart);
  const applySlice = view.slice(applyStart, applyEnd);
  const callCount = view.split('decideControlStatus(').length - 1;
  assert(
    forbidden.length === 0 && callCount === 1 && applyStart >= 0 && applySlice.includes('decideControlStatus(') &&
      !exists('src/components/telemetry/PhotonScanConsole.tsx') && !exists('src/components/telemetry/AssetComplianceTable.tsx') && !exists('src/components/telemetry/AssetRemediationDrawer.tsx'),
    'V1 the view has no simulation, no console or storage; decideControlStatus is called once, inside the confirmed click; the old console files are gone',
    { forbidden, callCount }
  );
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const importers = walk('src').filter((f) => read(f).includes('scapIngestEngine'));
  assert(importers.length === 0 && !exists('src/data/telemetry/scapIngestEngine.ts'), 'V2 nothing under src mentions scapIngestEngine and the file is gone', importers);
  const engine = read('src/data/telemetry/assetTelemetryEngine.ts');
  const ctx = read('src/context/AssessmentContext.tsx');
  assert(
    !['status: rollup.status', 'applyBoundaryTelemetryToControls', 'remediateAssetRule', 'Math.random'].some((s) => engine.includes(s)) &&
      !ctx.includes('aggregateAssetTelemetry') && !ctx.includes('refreshBoundaryTelemetry'),
    'V3 the fleet engine writes no control status, fakes no remediation and the context no longer rolls up the fleet'
  );
  assert(!view.includes('dangerouslySetInnerHTML') && !view.includes('innerHTML'), 'V4 the view never injects HTML: exporter strings are text nodes');
  assert(
    view.includes('ApiClient.getConfigSuggestions(tenantId, programId)') && view.includes('}, [tenantId, programId, serverBacked, loadSuggestions]);') &&
      view.includes('ApiClient.listConfigScans(tenantId, {') && view.includes('}, [tenantId, serverBacked, loadScans]);'),
    'V6 scans are tenant-wide and suggestions follow the active program'
  );
  const app = read('src/App.tsx');
  const sidebar = read('src/components/layout/Sidebar.tsx');
  assert(
    app.includes("{activeTab === 'configresults' && <ConfigurationResultsView />}") &&
      sidebar.includes("id: 'configresults'") && sidebar.includes("label: 'Configuration Results'") && sidebar.includes("label: 'Scanner Console'") && !sidebar.includes('Technical Baselines & STIGs') &&
      ctx.includes("| 'configresults'"),
    'V7 the screen is mounted, in the sidebar, and the external link is "Scanner Console"'
  );
  const decideStart = ctx.indexOf('const decideControlStatus = useCallback');
  const decideSlice = ctx.slice(decideStart, ctx.indexOf('// Leaving the program or the page', decideStart));
  const saveStart = ctx.indexOf('const saveControl = useCallback');
  const saveSlice = ctx.slice(saveStart, ctx.indexOf('// Action: Update Control Status with RBAC Check', saveStart));
  assert(
    decideStart >= 0 && decideSlice.includes('checkStale: true') && decideSlice.includes('quiet: true') && decideSlice.includes('recordAuditEvent(') && decideSlice.includes("'CONTROL_STATUS_UPDATED'") &&
      !decideSlice.includes('alert(') && !decideSlice.includes('updateLiveControl(') && saveSlice.includes('opts?.checkStale') && saveSlice.includes("return 'stale'"),
    'V8 Apply goes through the human save path with the control stamp, quietly, and writes one ledger entry'
  );
  const card = read('src/components/dashboard/ControlCard.tsx');
  assert(
    !card.includes('of 4 Endpoints') && !card.includes('AssetRemediationDrawer') && !card.includes('failingAssets') &&
      !read('src/components/matrix/ControlCard.tsx').includes('AssetRemediationDrawer') && !read('src/components/matrix/index.ts').includes('AssetRemediationDrawer'),
    'V9 the control card shows no invented endpoint count or remediation drawer'
  );
  const inventory = read('src/components/telemetry/AssetInventoryManager.tsx');
  assert(!inventory.includes('onTriggerScan') && !inventory.includes('Run automated Photon SCAP Scan') && !inventory.includes('<Play'), 'V10 the inventory has no no-op Scan button');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main();
