import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFrameworkControls } from '../src/data/frameworks';
import { generatePOAMEntries } from '../src/data/reports/documentCompilers';
import { POAM_COPY } from '../src/data/reports/poamView';
import { VM_POAM_COPY, poamEmptyState, vmPoamNotices, type VmPoamLoad } from '../src/data/reports/vmPoamView';
import { PoamControlsSection } from '../src/components/reports/PoamControlsSection';
import { PoamVulnerabilitiesSection } from '../src/components/reports/PoamVulnerabilitiesSection';
import type { ControlState } from '../src/types/cmmc';
import type { VmPoamResponse, VmPoamRow, VmSeverity } from '../src/types/vm';

/**
 * #278 / #274 (WP-3): the POA&M screen's two sections rendered on the server (no browser), and source pins on the wiring.
 * Pure test: no server boots. Markup text is HTML-escaped by React, so expected texts go through esc().
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
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const read = (p: string): string => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

const l2 = getFrameworkControls('CMMC_L2');
const state = (id: string, status: ControlState['status']): ControlState => ({
  id, status, implementationNotes: '', responsibleRole: '', lastUpdated: '2026-01-01', tags: [],
});
const entriesFor = (pick: (c: (typeof l2)[number]) => ControlState['status']) => {
  const states: Record<string, ControlState> = {};
  for (const c of l2) states[c.id] = state(c.id, pick(c));
  return generatePOAMEntries(l2, states, undefined, 'CMMC_L2');
};
const loading: VmPoamLoad = { status: 'loading' };

function row(id: string, o: { severity?: VmSeverity; kev?: boolean; asset?: { id: string; name: string } } = {}): VmPoamRow {
  return {
    id, status: 'OPEN', controlId: 'RA.L2-3.11.3', weakness: `Weakness of ${id}`, scheduledCompletion: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', findingFirstSeenAt: '2026-01-01T00:00:00Z',
    finding: {
      id: `f-${id}`, vulnId: `CVE-2024-${id}`, severity: o.severity ?? 'HIGH', status: 'OPEN', kev: o.kev ?? false,
      firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-02T00:00:00Z', slaDueAt: '2026-02-01T00:00:00Z', resolvedAt: null,
      affectedPackages: [{ name: 'openssl', version: '1.0', fixedVersion: null }], affectedPackageCount: 1,
      asset: o.asset ?? { id: 'a-1', name: 'host-1' },
    },
  };
}
function response(items: VmPoamRow[], o: Partial<{ openItemsTotal: number; target: string | null; isTarget: boolean; upcomingTotal: number; overdue: number }> = {}): VmPoamResponse {
  const upcomingTotal = o.upcomingTotal ?? 0;
  return {
    tenantId: 't', programId: 'p', generatedAt: '2026-01-10T00:00:00Z',
    rules: {
      controlId: 'RA.L2-3.11.3', autocreateEnabled: true, vmTargetProgramId: o.target === undefined ? 'p' : o.target,
      isVmTarget: o.isTarget ?? true, slaDays: { CRITICAL: 30, HIGH: 60, MEDIUM: 90, LOW: 180 },
    },
    items, itemsTotal: items.length, openItemsTotal: o.openItemsTotal ?? items.length, overdueWithoutItemCount: o.overdue ?? 0,
    upcoming: Array.from({ length: upcomingTotal }, (_, i) => ({
      findingId: `u${i}`, vulnId: `CVE-2025-${i}`, severity: 'MEDIUM' as VmSeverity, kev: false, firstSeenAt: '2026-01-05T00:00:00Z',
      slaDueAt: '2026-03-01T00:00:00Z', daysRemaining: 5, assetId: 'a-1', assetName: 'host-1',
      affectedPackages: [], affectedPackageCount: 0,
    })),
    upcomingTotal,
  };
}

const controlsHtml = (entries: ReturnType<typeof entriesFor>, vmLoad: VmPoamLoad, onOpenControl?: (id: string) => void) =>
  renderToStaticMarkup(React.createElement(PoamControlsSection, { entries, framework: 'CMMC_L2', controls: l2, vmLoad, onOpenControl }));
const vulnHtml = (load: VmPoamLoad, targetProgramName: string | null = null) =>
  renderToStaticMarkup(React.createElement(PoamVulnerabilitiesSection, { load, onRetry: () => undefined, framework: 'CMMC_L2', targetProgramName }));

console.log('--- W1 controls section: chips, live region, label ---');
{
  const iaId = l2.find((c) => c.domain === 'IA')!.id;
  const mixed = entriesFor((c) => (c.id === iaId ? 'NOT_MET' : c.domain === 'AC' ? 'NOT_STARTED' : 'MET'));
  const html = controlsHtml(mixed, loading);
  const chips = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => ({ on: m[1], text: m[2].replace(/<[^>]+>/g, '') }));
  assert(chips.length === 3, 'W1 three status chips', chips);
  assert(chips.find((c) => c.text.startsWith('Not met'))?.on === 'true', 'W1 Not met chip is pressed');
  assert(chips.find((c) => c.text.startsWith('Not started'))?.on === 'false', 'W1 Not started chip is not pressed by default');
  assert(/role="status"/.test(html) && html.includes('aria-live="polite"'), 'W1 a polite status region');
  assert(html.includes('hidden by the status filter'), 'W1 the live text names what the status filter hides');
  const label = html.match(/<label for="([^"]+)"/);
  assert(!!label && html.includes(`<input id="${label[1]}"`), 'W1 the search label points at the input id', label?.[1]);
}

console.log('--- W2 groups ---');
{
  const many = controlsHtml(entriesFor(() => 'NOT_MET'), loading);
  const toggles = [...many.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g)];
  assert(toggles.length >= 4 && toggles.every((m) => m[1] === 'false' && m[0].includes('aria-controls=')), 'W2 many families: every group is collapsed with aria-controls', toggles.length);
  assert(!many.includes('<table'), 'W2 many families: no table is rendered while collapsed');
  const iaId = l2.find((c) => c.domain === 'IA')!.id;
  const acId = l2.find((c) => c.domain === 'AC')!.id;
  const two = controlsHtml(entriesFor((c) => (c.id === iaId || c.id === acId ? 'NOT_MET' : 'MET')), loading);
  assert(two.includes('<caption class="sr-only">'), 'W2 two families: table caption');
  assert(two.includes('scope="col"') && two.includes('scope="row"') && two.includes('role="region"'), 'W2 two families: th scope and a labelled region');
  assert(two.includes('aria-expanded="true"'), 'W2 two families start expanded');
}

console.log('--- W3 all Not started ---');
{
  const html = controlsHtml(entriesFor(() => 'NOT_STARTED'), loading);
  assert(!html.includes('hidden by the status filter'), 'W3 nothing is hidden by the status filter');
  const pressed = [...html.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1]);
  assert(pressed.length === 3 && pressed.every((p) => p === 'true'), 'W3 all three chips are pressed', pressed);
}

console.log('--- W4 cross reference, B3 control button ---');
{
  const ra = l2.find((c) => c.id === 'RA.L2-3.11.3')!;
  const entries = entriesFor((c) => (c.id === ra.id ? 'NOT_MET' : 'MET'));
  const html = controlsHtml(entries, { status: 'ready', data: response([row('1'), row('2')], { openItemsTotal: 4 }) });
  assert(html.includes(esc(POAM_COPY.crossRef(4))), 'W4 the 3.11.3 row points at the 4 vulnerability items');
  assert(!controlsHtml(entries, loading).includes('listed under Vulnerabilities.</p>'), 'W4 no cross reference while the items are not loaded');
  const plain = controlsHtml(entries, loading);
  const linked = controlsHtml(entries, loading, () => undefined);
  assert(!plain.includes('hover:underline') && linked.includes('hover:underline'), 'B3 the control id is a button only when onOpenControl is given');
}

console.log('--- W5 empty states never claim a clean POA&M when they cannot know ---');
{
  const none = entriesFor(() => 'MET');
  assert(none.length === 0, 'W5 fixture: no control entries');
  for (const [name, load] of [['error', { status: 'error' }], ['loading', loading], ['no_program', { status: 'no_program' }]] as [string, VmPoamLoad][]) {
    const html = controlsHtml(none, load);
    const partial = poamEmptyState(0, load)!;
    assert(partial.tone === 'partial' && html.includes(esc(partial.body)), `W5 ${name}: the partial text is shown`);
    assert(!html.includes('Zero Open') && !html.includes('100%') && !html.includes('No open POA&amp;M entries'), `W5 ${name}: no all-clear wording`);
  }
  const open = controlsHtml(none, { status: 'ready', data: response([row('1')]) });
  assert(!open.includes('No open POA&amp;M entries') && open.includes('Open vulnerability items are listed under Vulnerabilities.'), 'W5 open vulnerability items: not an all-clear');
  const clean = controlsHtml(none, { status: 'ready', data: response([]) });
  assert(clean.includes('No open POA&amp;M entries'), 'W5 ready and clean: the all-clear');
  const noControls = renderToStaticMarkup(React.createElement(PoamControlsSection, { entries: [], framework: 'CMMC_L2', controls: [], vmLoad: { status: 'ready', data: response([]) } }));
  assert(noControls.includes(esc(POAM_COPY.noControls)) && !noControls.includes('No open POA&amp;M entries'), 'W5 no controls loaded: says so, no all-clear');
}

console.log('--- W6-W10 vulnerabilities section ---');
{
  const err = vulnHtml({ status: 'error' });
  assert(err.includes('role="alert"') && err.includes(esc(VM_POAM_COPY.loadError)) && err.includes('Retry'), 'W6 error: alert, message and Retry');
  assert(!err.includes('No vulnerability POA&amp;M items are open'), 'W6 error: never claims there are no items');
  const unsupported = vulnHtml({ status: 'unsupported' });
  assert(unsupported.includes(esc(VM_POAM_COPY.browserOnly)) && !unsupported.includes('<table'), 'W7 browser-only organization: note, no table');
  const two = vulnHtml({ status: 'ready', data: response([row('1001', { severity: 'CRITICAL', kev: true }), row('1002')]) });
  assert(two.includes('POAM-VM-001') && two.includes('POAM-VM-002'), 'W8 weakness ids');
  assert(two.includes('Critical') && two.includes('KEV') && two.includes('scope="row"'), 'W8 severity text, KEV badge and row headers');
  assert(two.includes('Most severe: '), 'W8 the group badge names what it is for screen readers');
  const target = vulnHtml({ status: 'ready', data: response([row('1')], { upcomingTotal: 3 }) });
  assert(target.includes('Coming due: 3 open vulnerabilities') && /aria-expanded="false"/.test(target), 'W9 target: the coming due list is there and collapsed');
  const otherData = response([row('1')], { upcomingTotal: 3, isTarget: false, target: 'q' });
  const other = vulnHtml({ status: 'ready', data: otherData }, 'Prog B');
  const notTarget = vmPoamNotices(otherData, { framework: 'CMMC_L2', targetProgramName: 'Prog B' }).find((n) => n.id === 'not_target')!;
  assert(!other.includes('Coming due') && other.includes(esc(notTarget.text)), 'W9 not the target: no coming due list, the not_target notice');
  const load = vulnHtml(loading);
  assert(/role="status"[^>]*>(?:(?!<\/p>).)*Loading the vulnerability POA&amp;M items/s.test(load), 'W10 loading text inside a status region');
  const empty = vulnHtml({ status: 'ready', data: response([]) });
  assert(empty.includes('No vulnerability POA&amp;M items are open') && !empty.includes('<table'), 'W10 ready with no items says so');
}

console.log('--- S1-S4 source pins ---');
{
  const app = read('src/App.tsx').split('\n');
  const poamLine = app.find((l) => l.includes("activeTab === 'poam' && <ArtifactExportModal")) ?? '';
  const exportLine = app.find((l) => l.includes("activeTab === 'export' && <ArtifactExportModal")) ?? '';
  assert(poamLine.includes('initialDocType="POAM" initialTab="poam" embedded'), 'S1 the POA&M entry opens on the table');
  assert(exportLine.length > 0 && !exportLine.includes('initialTab'), 'S1 Export Audit Package keeps opening on Live Preview');
  const modal = read('src/components/reports/ArtifactExportModal.tsx');
  assert(modal.includes("(propInitialTab ?? 'preview')") && modal.includes('<PoamWorkspace') && modal.includes("key={activeProgram?.id ?? 'no-program'}") && modal.includes('{ vmPoam: vmPoamExport }'), 'S2 the modal wiring');
  assert(!modal.includes('Zero Open Deficiencies') && !modal.includes('console.') && !modal.includes('localStorage'), 'S2 no old all-clear text, no console, no localStorage');
  const files = [
    'src/hooks/useVmPoam.ts', 'src/components/reports/PoamWorkspace.tsx', 'src/components/reports/PoamControlsSection.tsx',
    'src/components/reports/PoamVulnerabilitiesSection.tsx', 'src/components/reports/PoamGroupPanel.tsx',
    'src/data/reports/poamView.ts', 'src/data/reports/vmPoamView.ts',
  ];
  for (const f of files) {
    const src = read(f);
    assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML/.test(src), `S3 ${f} has no console, browser storage or raw HTML`);
  }
  const hook = read('src/hooks/useVmPoam.ts');
  assert(hook.includes('ApiClient.getVmPoam(') && hook.includes('request !== latest.current') && hook.includes('[tenantId, programId, supported, enabled]'), 'S4 the hook calls the API, drops stale answers and depends on tenant, program, support and enabled');
  const ws = read('src/components/reports/PoamWorkspace.tsx');
  assert(ws.includes('onOpenControl={setSelectedControlId}'), 'B3 the workspace opens a control through setSelectedControlId');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);