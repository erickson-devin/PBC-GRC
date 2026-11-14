import fs from 'fs';
import path from 'path';
import {
  VM_POAM_CONTROL_TITLE, VM_POAM_COPY, vmPoamEntries, vmPoamExportFor, vmWeaknessIds, isOpenVmPoamStatus, groupVmPoamByAsset, filterVmPoamRows,
  vmPackagesView, daysRemainingText, isoDate, vmRulesText, vmPoamNotices, vmItemsEmptyText, vmResultsText, poamTabLabel, poamTabAriaLabel,
  poamHeaderText, poamExportNote, poamEmptyState, applyVmPoamRowUpdate, vmGroupCountText, vmPastTargetDate, vmClosedCount, vmClosedToggleText,
  type VmPoamLoad, type VmPoamExport,
} from '../src/data/reports/vmPoamView';
import { compilePOAM, compileReportDocument, generatePOAMEntries } from '../src/data/reports/documentCompilers';
import { generatePrintableHtml, generatePoamCsv, generateMachineReadablePackage } from '../src/data/reports/reportExporters';
import { getFrameworkControls } from '../src/data/frameworks';
import { CMMC_LEVEL_2_CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import { cmmcDisplayId, cmmcGuideId } from '../src/data/cmmcGuide/displayId';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import type { ReportMetadata } from '../src/types/report';
import type { ControlState, AssessmentState } from '../src/types/cmmc';
import type { VmPoamResponse, VmPoamRow, VmSeverity, VmPoamStatus } from '../src/types/vm';

/**
 * #274 (WP-2): the vulnerability side of the POA&M screen as pure functions, and the POA&M document, CSV and JSON package built from it.
 * Pure test: no server, no browser.
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
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function row(id: string, o: {
  status?: VmPoamStatus; severity?: VmSeverity; kev?: boolean; asset?: { id: string; name: string } | null; vulnId?: string;
  weakness?: string; sched?: string | null; pkgs?: string[]; pkgCount?: number; noFinding?: boolean; owner?: string; mitigation?: string;
} = {}): VmPoamRow {
  const pkgs = (o.pkgs ?? ['openssl']).map((name) => ({ name, version: '1.0', fixedVersion: null }));
  return {
    id,
    status: o.status ?? 'OPEN',
    controlId: 'RA.L2-3.11.3',
    weakness: o.weakness ?? `Weakness of ${id}`,
    scheduledCompletion: o.sched ?? null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    findingFirstSeenAt: '2026-01-01T00:00:00Z',
    createdBy: 'system:vm-worker',
    owner: o.owner ?? '',
    mitigation: o.mitigation ?? '',
    updatedBy: null,
    statusChangedBy: null,
    statusChangedAt: null,
    autoComplete: true,
    finding: o.noFinding ? null : {
      id: `f-${id}`,
      vulnId: o.vulnId ?? `CVE-2024-${id}`,
      severity: o.severity ?? 'HIGH',
      status: 'OPEN',
      kev: o.kev ?? false,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-02T00:00:00Z',
      slaDueAt: '2026-02-01T00:00:00Z',
      resolvedAt: null,
      affectedPackages: pkgs,
      affectedPackageCount: o.pkgCount ?? pkgs.length,
      asset: o.asset === undefined ? { id: 'a-1', name: 'host-1' } : o.asset,
    },
  };
}

function response(items: VmPoamRow[], o: Partial<{
  openItemsTotal: number; itemsTotal: number; autocreate: boolean; target: string | null; isTarget: boolean; overdue: number;
  sla: { CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number };
}> = {}): VmPoamResponse {
  return {
    tenantId: 't', programId: 'p', generatedAt: '2026-01-10T00:00:00Z',
    rules: {
      controlId: 'RA.L2-3.11.3',
      autocreateEnabled: o.autocreate ?? true,
      vmTargetProgramId: o.target === undefined ? 'p' : o.target,
      isVmTarget: o.isTarget ?? true,
      slaDays: o.sla ?? { CRITICAL: 30, HIGH: 60, MEDIUM: 90, LOW: 180 },
    },
    items, itemsTotal: o.itemsTotal ?? items.length, openItemsTotal: o.openItemsTotal ?? items.filter((r) => isOpenVmPoamStatus(r.status)).length,
    overdueWithoutItemCount: o.overdue ?? 0, upcoming: [], upcomingTotal: 0,
  };
}

const meta: ReportMetadata = {
  systemName: 'Sys', organizationName: 'Org', cageCode: 'X', samStatus: 'ACTIVE', systemOwner: 'Owner', primaryAssessor: 'Assessor',
  boundaryDescription: 'b', systemEnvironment: 'e', operationalStatus: 'Operational', cloudServiceProviders: 'c',
  classificationLevel: 'UNCLASSIFIED // CUI', assessmentDate: '2026-09-15', version: '1', framework: 'CMMC_L2',
};
const l2 = getFrameworkControls('CMMC_L2');
const states: Record<string, ControlState> = {};
l2.slice(0, 4).forEach((c, i) => {
  states[c.id] = { id: c.id, status: i === 0 ? 'NOT_MET' : 'IN_PROGRESS', implementationNotes: '', responsibleRole: 'Role', lastUpdated: '2026-09-14T10:00:00Z', tags: [] };
});

const rows3: VmPoamRow[] = [
  row('1001', { severity: 'CRITICAL', asset: { id: 'b', name: 'host-b' }, kev: true, sched: '2026-12-01' }),
  row('1002', { status: 'IN_PROGRESS', severity: 'LOW', asset: { id: 'a', name: 'host-a' }, pkgs: ['pkg01', 'pkg02', 'pkg03'] }),
  row('1003', { status: 'COMPLETED' }),
];
const ready: VmPoamExport = { status: 'ready', entries: vmPoamEntries(rows3, 'CMMC_L2'), openItemsTotal: 2 };
const unavailable: VmPoamExport = { status: 'unavailable' };

console.log('\n--- VP1-VP3 vmPoamEntries ---');
{
  const e = vmPoamEntries(rows3, 'CMMC_L2');
  assert(e.length === 2 && e[0].weaknessId === 'POAM-VM-001' && e[1].weaknessId === 'POAM-VM-002', 'VP1 two open rows, ids in input order', e.map((x) => x.weaknessId));
  assert(e.every((x) => x.controlId === 'RA.L2-3.11.3' && x.controlDisplayId === cmmcDisplayId('RA.L2-3.11.3', 'CMMC_L2')), 'VP1 stored control id and display id');
  assert(e[0].weaknessDescription === rows3[0].weakness, 'VP1 description is the row weakness');
  assert(e[0].scheduledCompletionDate === '2026-12-01' && e[1].scheduledCompletionDate === NOT_RECORDED, 'VP1 date is the recorded one, else NOT_RECORDED (never the deadline)');
  assert(e.every((x) => x.requiredResources === NOT_RECORDED && x.responsibleRole === NOT_RECORDED && Array.isArray(x.milestones) && x.milestones.length === 0), 'VP1 resources, role and milestones (no owner recorded)');
  const defaultPlan = 'Remediate or mitigate the vulnerability, then confirm that a later scan no longer reports it.';
  const own = vmPoamEntries([row('1101', { owner: '  IT Lead ', mitigation: ' Patch ' }), row('1102', { owner: '   ', mitigation: '  ' })], 'CMMC_L2');
  assert(own[0].responsibleRole === 'IT Lead' && own[0].remediationPlan === 'Patch', 'VP1 owner and mitigation, trimmed', own[0]);
  assert(own[1].responsibleRole === NOT_RECORDED && own[1].remediationPlan === defaultPlan && own[1].requiredResources === NOT_RECORDED && own[1].milestones.length === 0, 'VP1 blank owner and mitigation fall back', own[1]);
  assert(e.every((x) => x.remediationPlan === defaultPlan), 'VP1 default remediation sentence when no mitigation');
  assert(e[0].status === 'OPEN' && e[1].status === 'IN_PROGRESS', 'VP1 statuses');
  assert(same([...vmWeaknessIds(rows3).values()], ['POAM-VM-001', 'POAM-VM-002']) && !vmWeaknessIds(rows3).has('1003'), 'VP1 vmWeaknessIds skips closed rows');
  const l1 = vmPoamEntries(rows3, 'CMMC_L1');
  assert(l1[0].controlTitle.includes(cmmcGuideId('SI.L2-3.14.1', 'CMMC_L1')) && l1[0].controlTitle.startsWith('Vulnerability remediation (no Level 1 practice; related: '), 'VP2 L1 title names the computed related practice', l1[0].controlTitle);
  assert(l1[0].controlId === 'RA.L2-3.11.3', 'VP2 L1 stored control id is unchanged');
  assert(VM_POAM_CONTROL_TITLE === CMMC_LEVEL_2_CONTROLS.find((c) => c.id === 'RA.L2-3.11.3')!.title, 'VP3 control title equals the catalog title');
}

console.log('\n--- VP4-VP10 documents and exports ---');
{
  const base = compilePOAM(meta, l2, states);
  const withVm = compilePOAM(meta, l2, states, undefined, ready);
  assert(same(withVm.poamEntries, base.poamEntries), 'VP4 control entries identical with and without vulnerability rows');
  assert(!(withVm.poamEntries ?? []).some((x) => x.weaknessId.startsWith('POAM-VM-')), 'VP4 no VM id in poamEntries');
  assert(same(withVm.vmPoamEntries, ready.entries), 'VP4 vmPoamEntries carried on the document');
  assert(same(base.poamEntries, generatePOAMEntries(l2, states, undefined, 'CMMC_L2')), 'VP4 generatePOAMEntries untouched');
  assert(base.vmPoamEntries === undefined && !('vmPoamEntries' in base), 'VP4 no key without vulnerability data');

  const sec = withVm.sections.find((s) => s.id === 'poam-sec-2b-vulnerabilities');
  const rowsOf = (s: typeof sec) => (s?.table?.rows ?? []) as (string | number)[][];
  assert(!!sec && rowsOf(sec).length === 2 && rowsOf(sec)[0][0] === 'POAM-VM-001', 'VP5 ready section has 2 rows');
  const sum1 = rowsOf(withVm.sections[0]);
  assert(same(sum1[sum1.length - 1], [VM_POAM_COPY.summaryLabel, 2, 'Listed in section 2b']), 'VP5 summary row (ready)', sum1[sum1.length - 1]);
  const none = compilePOAM(meta, l2, states, undefined, { status: 'ready', entries: [], openItemsTotal: 0 });
  const noneSec = none.sections.find((s) => s.id === 'poam-sec-2b-vulnerabilities');
  assert(noneSec?.content === VM_POAM_COPY.docNone && !noneSec?.table, 'VP5 ready with none: docNone, no table');
  assert(none.vmPoamEntries !== undefined && none.vmPoamEntries.length === 0, 'VP5 ready with none: empty vmPoamEntries');
  const un = compilePOAM(meta, l2, states, undefined, unavailable);
  const unSec = un.sections.find((s) => s.id === 'poam-sec-2b-vulnerabilities');
  const unSum = rowsOf(un.sections[0]);
  assert(unSec?.content === VM_POAM_COPY.docUnavailable && !unSec?.table, 'VP5 unavailable: docUnavailable');
  assert(unSum[unSum.length - 1][1] === 'Not loaded', 'VP5 unavailable: summary value Not loaded');
  assert(un.vmPoamEntries === undefined, 'VP5 unavailable: no vmPoamEntries');
  assert(same(base.sections.map((s) => s.id), ['poam-sec-1-summary', 'poam-sec-2-matrix', 'poam-sec-3-milestones', 'poam-sec-4-governance']) && rowsOf(base.sections[0]).length === 5, 'VP5 undefined: original sections and 5 summary rows');
  assert(same(withVm.sections.map((s) => s.id), ['poam-sec-1-summary', 'poam-sec-2-matrix', 'poam-sec-2b-vulnerabilities', 'poam-sec-3-milestones', 'poam-sec-4-governance']), 'VP5 2b sits after section 2');

  const many = Array.from({ length: 1000 }, (_, i) => row(String(2000 + i)));
  const capped = compilePOAM(meta, l2, states, undefined, { status: 'ready', entries: vmPoamEntries(many, 'CMMC_L2'), openItemsTotal: 1500 });
  assert((capped.sections.find((s) => s.id === 'poam-sec-2b-vulnerabilities')?.summary ?? '').includes(VM_POAM_COPY.docCap(1000, 1500)), 'VP6 cap sentence');
  assert(!(withVm.sections.find((s) => s.id === 'poam-sec-2b-vulnerabilities')?.summary ?? '').includes('first'), 'VP6 no cap sentence when complete');

  const viaRouter = compileReportDocument('POAM', meta, l2, states, [], undefined, undefined, { vmPoam: ready });
  assert(same(viaRouter.vmPoamEntries, ready.entries), 'VP7 compileReportDocument POAM carries vmPoamEntries');
  const ssp = compileReportDocument('NIST_SP_800_18_SSP', meta, l2, states, [], undefined, undefined, { vmPoam: ready });
  assert(ssp.vmPoamEntries === undefined, 'VP7 other document types do not');
  assert(same(compileReportDocument('POAM', meta, l2, states).sections.map((s) => s.id), base.sections.map((s) => s.id)), 'VP7 router without extras unchanged');

  const html = generatePrintableHtml(withVm);
  assert(html.includes('POAM-VM-001'), 'VP8 HTML lists the vulnerability row');
  const xssEntries = vmPoamEntries([row('3001', { weakness: '<b>x</b>' })], 'CMMC_L2');
  const xssHtml = generatePrintableHtml(compilePOAM(meta, l2, states, undefined, { status: 'ready', entries: xssEntries, openItemsTotal: 1 }));
  assert(xssHtml.includes('&lt;b&gt;x&lt;/b&gt;') && !xssHtml.includes('<b>x</b>'), 'VP8 weakness text is escaped in HTML');

  const csv = generatePoamCsv([...(withVm.poamEntries ?? []), ...(withVm.vmPoamEntries ?? [])]);
  const lines = csv.split('\r\n').filter((l) => l.length > 0);
  assert(lines.length === (withVm.poamEntries ?? []).length + 2 + 1, 'VP9 CSV has controls + vm + header lines', lines.length);
  assert(lines[lines.length - 1].includes('POAM-VM-002') && lines[lines.length - 2].includes('POAM-VM-001'), 'VP9 vulnerability rows come last');
  assert(!generatePoamCsv(withVm.poamEntries ?? []).includes('POAM-VM-'), 'VP9 controls-only CSV has none');

  const state = { version: '2.0.0', tenantId: 't', controls: {}, evidenceIndex: [], lastSaved: '2026-01-01T00:00:00Z' } as unknown as AssessmentState;
  void (async () => {
    const pkgVm = await generateMachineReadablePackage(withVm, state);
    const pkgNone = await generateMachineReadablePackage(base, state);
    const pkgEmpty = await generateMachineReadablePackage(none, state);
    assert(same(pkgVm.vmPoamEntries, ready.entries), 'VP10 JSON package carries vmPoamEntries');
    assert(!('vmPoamEntries' in pkgNone) && !('vmPoamEntries' in pkgEmpty), 'VP10 key absent without vulnerability rows');
    finish();
  })();
}

console.log('\n--- CSV formula guard on attacker-influenced names ---');
for (const lead of ['=', '+', '-', '@']) {
  const e = vmPoamEntries([row('4001', { weakness: `${lead}cmd|' /c calc'!A1 on host` })], 'CMMC_L2');
  const line = generatePoamCsv(e).split('\r\n')[1];
  assert(line.includes(`"'${lead}cmd`) && !line.includes(`,"${lead}cmd`), `CSV escapes a weakness (asset or package name) starting with ${lead}`, line);
  const user = vmPoamEntries([row('4002', { owner: `${lead}owner`, mitigation: `${lead}mitigation` })], 'CMMC_L2');
  const userLine = generatePoamCsv(user).split('\r\n')[1];
  assert(userLine.includes(`"'${lead}owner"`) && !userLine.includes(`,"${lead}owner`), `CSV escapes an owner starting with ${lead}`, userLine);
  assert(userLine.includes(`"'${lead}mitigation"`) && !userLine.includes(`,"${lead}mitigation`), `CSV escapes a mitigation starting with ${lead}`, userLine);
}

console.log('\n--- VP11-VP15 grouping, search, text ---');
{
  const rows = [
    row('5001', { severity: 'LOW', asset: { id: 'a', name: 'host-a' }, vulnId: 'CVE-2024-1001' }),
    row('5002', { severity: 'CRITICAL', asset: { id: 'b', name: 'host-b' }, kev: true }),
    row('5003', { severity: 'HIGH', noFinding: true }),
    row('5004', { severity: 'MEDIUM', asset: { id: 'a', name: 'host-a' }, kev: true }),
    row('5005', { severity: 'LOW', asset: null }),
  ];
  const g = groupVmPoamByAsset(rows);
  assert(same(g.map((x) => x.assetName), ['host-b', 'host-a', VM_POAM_COPY.orphanAsset]), 'VP11 order: severity, then orphan last', g.map((x) => x.assetName));
  assert(g[2].assetName === 'Asset no longer recorded' && g[2].items.length === 2, 'VP11 orphan group holds findingless and assetless rows');
  const ga = g.find((x) => x.key === 'a')!;
  assert(ga.worstSeverity === 'MEDIUM' && ga.kevCount === 1 && g[0].kevCount === 1, 'VP11 worst severity and KEV count');
  assert(same(ga.items.map((r) => r.id), ['5001', '5004']), 'VP11 item order preserved');
  assert(filterVmPoamRows(rows, 'cve-2024-1001').length === 1, 'VP12 CVE id, any case');
  assert(filterVmPoamRows(rows, 'HOST-B').length === 1, 'VP12 asset name');
  const pk = [row('6001', { pkgs: ['pkg01', 'pkg02', 'pkg03'] }), row('6002')];
  assert(filterVmPoamRows(pk, 'pkg03').length === 1, 'VP12 package name');
  assert(filterVmPoamRows(pk, '   ').length === 2 && filterVmPoamRows(pk, 'zzzz').length === 0, 'VP12 empty query returns all, no match returns none');
  assert(filterVmPoamRows(pk, 'weakness of 6002')[0]?.id === '6002', 'VP12 weakness text');
  const before = JSON.stringify(rows);
  groupVmPoamByAsset(rows); filterVmPoamRows(rows, 'host');
  assert(JSON.stringify(rows) === before, 'VP12 inputs unchanged');
  const v = vmPackagesView({ affectedPackages: Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, version: '1', fixedVersion: null })), affectedPackageCount: 12 }, 3);
  assert(v.shown.length === 3 && v.more === 9, 'VP13 packages: 3 shown, 9 more', v);
  assert(daysRemainingText(-1) === 'Past deadline' && daysRemainingText(0) === 'Due within a day' && daysRemainingText(1) === '1 day left' && daysRemainingText(5) === '5 days left', 'VP14 days remaining');
  assert(isoDate('2026-03-04T10:00:00Z') === '2026-03-04' && isoDate(null) === 'None', 'isoDate');
  const rules = response([]).rules;
  const exact = 'A vulnerability becomes a POA&M item under RA.L2-3.11.3 when it is still open after its remediation deadline. The deadline counts from when the vulnerability was first seen: Critical 30 days, High 60 days, Medium 90 days, Low 180 days. Unknown severity uses the Medium deadline, and a known exploited vulnerability (KEV) never gets longer than the Critical deadline. Items are added when the next scan is processed after the deadline. An item is completed automatically when a later scan confirms the fix: the scanner that reported the vulnerability scans the host again and no longer lists it, and no other active scanner still reports it. A host that is not scanned completes nothing. If the vulnerability comes back it gets a new item; the completed one stays in the history. An item a person reopened is not completed automatically. This also applies to items in a program that was the target earlier, unless it is archived.';
  assert(vmRulesText(rules, 'CMMC_L2') === exact.replace('RA.L2-3.11.3', cmmcDisplayId('RA.L2-3.11.3', 'CMMC_L2')), 'VP15 rules text');
  assert(vmRulesText({ ...rules, slaDays: { ...rules.slaDays, CRITICAL: 1 } }, 'CMMC_L2').includes('Critical 1 day,'), 'VP15 singular day');
}

console.log('\n--- VP16 notices ---');
{
  const ids = (d: VmPoamResponse, fw = 'CMMC_L2', name: string | null = null) => vmPoamNotices(d, { framework: fw, targetProgramName: name }).map((n) => n.id);
  assert(same(ids(response([], { target: null, isTarget: false })), ['no_target']), 'VP16 no target');
  const nt = vmPoamNotices(response([row('7001')], { target: 'other', isTarget: false }), { framework: 'CMMC_L2', targetProgramName: 'Prog B' });
  assert(nt.length === 1 && nt[0].id === 'not_target' && nt[0].text.includes('Prog B') && nt[0].text.includes('created while this program was the target'), 'VP16 not the target, with items');
  assert(vmPoamNotices(response([], { target: 'other', isTarget: false }), { framework: 'CMMC_L2', targetProgramName: null })[0].text.includes('another program'), 'VP16 not the target, no name');
  assert(same(ids(response([], { autocreate: false })), ['autocreate_off']), 'VP16 autocreate off');
  const o1 = vmPoamNotices(response([], { overdue: 1 }), { framework: 'CMMC_L2', targetProgramName: null })[0];
  assert(o1.id === 'overdue_without_item' && o1.text === '1 open vulnerability is past its deadline without a POA&M item yet. Items are added when the next scan is processed.', 'VP16 overdue 1', o1.text);
  const o3 = vmPoamNotices(response([], { overdue: 3 }), { framework: 'CMMC_L2', targetProgramName: null })[0];
  assert(o3.text.startsWith('3 open vulnerabilities are past their deadline'), 'VP16 overdue 3');
  const o3off = vmPoamNotices(response([], { overdue: 3, autocreate: false }), { framework: 'CMMC_L2', targetProgramName: null }).find((n) => n.id === 'overdue_without_item')!;
  assert(o3off.text === '3 open vulnerabilities are past their deadline without a POA&M item.', 'VP16 overdue with autocreate off', o3off.text);
  const l1n = vmPoamNotices(response([row('7002')]), { framework: 'CMMC_L1', targetProgramName: null });
  assert(same(l1n.map((n) => n.id), ['level1']) && l1n[0].text.includes(cmmcGuideId('SI.L2-3.14.1', 'CMMC_L1')), 'VP16 level 1');
  assert(same(ids(response([row('7003')], { openItemsTotal: 5 })), ['cap']) && vmPoamNotices(response([row('7003')], { openItemsTotal: 5 }), { framework: 'CMMC_L2', targetProgramName: null })[0].text === 'Showing the first 1 of 5 open items. The exports list the same 1.', 'VP16 cap');
  assert(same(ids(response([row('7004')])), []), 'VP16 healthy target has no notices');
  assert(vmItemsEmptyText(response([])) === 'No vulnerability POA&M items are open, and no open vulnerability is past its deadline.', 'empty text, healthy target');
  assert(vmItemsEmptyText(response([], { overdue: 2 })) === 'No vulnerability POA&M items are open in this program.' && vmItemsEmptyText(response([], { isTarget: false })) === 'No vulnerability POA&M items are open in this program.', 'empty text otherwise');
  assert(vmResultsText(1, 1) === 'Showing 1 vulnerability item.' && vmResultsText(4, 4) === 'Showing all 4 vulnerability items.' && vmResultsText(2, 4) === 'Showing 2 of 4 vulnerability items.', 'results text');
}

console.log('\n--- VP17-VP19 empty state, labels, export state ---');
{
  const r0 = (o: Parameters<typeof response>[1] = {}): VmPoamLoad => ({ status: 'ready', data: response([], o) });
  const rN: VmPoamLoad = { status: 'ready', data: response([row('8001'), row('8002'), row('8003'), row('8004')]) };
  const err: VmPoamLoad = { status: 'error' };
  const uns: VmPoamLoad = { status: 'unsupported' };
  assert(poamEmptyState(3, rN) === null, 'VP17 null with control entries');
  const cases: [string, ReturnType<typeof poamEmptyState>, string, string][] = [
    ['ready none', poamEmptyState(0, r0()), 'clear', 'No open POA&M entries'],
    ['unsupported', poamEmptyState(0, uns), 'clear', 'No open POA&M entries'],
    ['ready open', poamEmptyState(0, rN), 'partial', 'No control entries'],
    ['ready overdue', poamEmptyState(0, r0({ overdue: 2 })), 'partial', 'No control entries'],
    ['error', poamEmptyState(0, err), 'partial', 'No control entries'],
  ];
  for (const [n, s, tone, title] of cases) assert(!!s && s.tone === tone && s.title === title, `VP17 ${n}`, s);
  assert(poamEmptyState(0, r0())!.body === 'Every control in this program is recorded as Met, and no vulnerability POA&M items are open.', 'VP17 clear body');
  assert(poamEmptyState(0, err)!.body.endsWith('so this is not the full POA&M.'), 'VP17 partial body');
  const all = [poamEmptyState(0, r0()), poamEmptyState(0, uns), poamEmptyState(0, rN), poamEmptyState(0, r0({ overdue: 2 })), poamEmptyState(0, err), poamEmptyState(0, { status: 'loading' })]
    .map((s) => `${s!.title} ${s!.body}`).join(' ');
  assert(!all.includes('Zero') && !all.includes('100%'), 'VP17 no Zero or 100% wording');
  assert(poamTabLabel(110, rN) === 'POA&M Table (114)' && poamTabLabel(110, err) === 'POA&M Table (110)' && poamTabLabel(110, uns) === 'POA&M Table (110)', 'VP18 tab label');
  assert(poamTabAriaLabel(110, rN) === 'POA&M Table: 110 control entries, 4 open vulnerability items', 'VP18 aria ready');
  assert(poamTabAriaLabel(1, { status: 'ready', data: response([row('8005')]) }) === 'POA&M Table: 1 control entry, 1 open vulnerability item', 'VP18 aria singular');
  assert(poamTabAriaLabel(110, uns) === 'POA&M Table: 110 control entries', 'VP18 aria unsupported');
  assert(poamTabAriaLabel(110, err) === 'POA&M Table: 110 control entries, vulnerability items not loaded', 'VP18 aria error');
  assert(poamHeaderText(110, rN) === '110 control entries and 4 open vulnerability items.' && poamHeaderText(110, uns) === '110 control entries.', 'header text');
  assert(poamHeaderText(1, { status: 'loading' }) === '1 control entry. Vulnerability items are loading.' && poamHeaderText(110, err) === '110 control entries. Vulnerability items are not loaded.', 'header text, loading and error');
  assert(poamExportNote(rN) === poamExportNote(uns) && poamExportNote(err).includes('not in the exports right now'), 'export note');
  assert(vmPoamExportFor(uns, 'CMMC_L2') === undefined && vmPoamExportFor({ status: 'idle' }, 'CMMC_L2') === undefined, 'VP19 unsupported and idle give undefined');
  assert(same(vmPoamExportFor(err, 'CMMC_L2'), { status: 'unavailable' }) && same(vmPoamExportFor({ status: 'loading' }, 'CMMC_L2'), { status: 'unavailable' }) && same(vmPoamExportFor({ status: 'no_program' }, 'CMMC_L2'), { status: 'unavailable' }), 'VP19 loading, error, no_program are unavailable');
  const ex = vmPoamExportFor(rN, 'CMMC_L2');
  assert(ex?.status === 'ready' && ex.entries.length === 4 && ex.openItemsTotal === 4, 'VP19 ready gives entries');
}

console.log('\n--- VE1-VE8 edits and closed items (#297, #295) ---');
{
  const ctx = { framework: 'CMMC_L2', targetProgramName: null };
  const data = response([row('9001'), row('9002', { asset: { id: 'b', name: 'host-b' } })]);
  const before = JSON.stringify(data);
  const toProgress = applyVmPoamRowUpdate(data, row('9001', { status: 'IN_PROGRESS' }), false);
  assert(toProgress.items[0].status === 'IN_PROGRESS' && toProgress.items.length === 2 && toProgress.openItemsTotal === 2 && toProgress.itemsTotal === 2, 'VE1 open to in progress: replaced in place, totals unchanged');
  const hiddenDone = applyVmPoamRowUpdate(data, row('9001', { status: 'COMPLETED' }), false);
  assert(hiddenDone.items.length === 1 && hiddenDone.items[0].id === '9002' && hiddenDone.openItemsTotal === 1 && hiddenDone.itemsTotal === 2, 'VE1 completed with closed hidden: removed, one open fewer');
  const shownDone = applyVmPoamRowUpdate(data, row('9001', { status: 'COMPLETED' }), true);
  assert(shownDone.items.length === 2 && shownDone.items[0].status === 'COMPLETED' && shownDone.openItemsTotal === 1, 'VE1 completed with closed shown: kept, one open fewer');
  const reopened = applyVmPoamRowUpdate(shownDone, row('9001', { status: 'OPEN' }), true);
  assert(reopened.openItemsTotal === 2, 'VE1 reopened: one open more');
  assert(applyVmPoamRowUpdate(data, row('0000'), false) === data, 'VE1 unknown id: the same reference');
  assert(JSON.stringify(data) === before, 'VE1 the input is not mutated');

  const g = groupVmPoamByAsset([
    row('9101', { status: 'COMPLETED', severity: 'CRITICAL', asset: { id: 'c', name: 'host-c' } }),
    row('9102', { severity: 'LOW', asset: { id: 'o', name: 'host-o' } }),
    row('9103', { severity: 'HIGH', asset: { id: 'm', name: 'host-m' } }),
    row('9104', { status: 'RISK_ACCEPTED', severity: 'CRITICAL', asset: { id: 'm', name: 'host-m' } }),
    row('9105', { status: 'IN_PROGRESS', severity: 'MEDIUM', asset: { id: 'm', name: 'host-m' } }),
  ]);
  assert(g[g.length - 1].key === 'c' && g[0].openCount > 0, 'VE2 a group with only a closed item sorts after the groups with open items', g.map((x) => x.key));
  const mixedGroup = g.find((x) => x.key === 'm')!;
  assert(mixedGroup.worstSeverity === 'HIGH' && mixedGroup.openCount === 2 && g.find((x) => x.key === 'c')!.worstSeverity === 'CRITICAL', 'VE2 severity ignores closed rows while one is open, and uses them when none is');
  assert(vmGroupCountText(mixedGroup) === '2 open, 1 closed' && vmGroupCountText(g.find((x) => x.key === 'c')!) === '1 closed' && vmGroupCountText({ items: [row('1'), row('2'), row('3')], openCount: 3 }) === '3 items', 'VE2 group count texts');

  const shownBoth = response([row('9201'), row('9202', { status: 'COMPLETED' })], { openItemsTotal: 1 });
  assert(!vmPoamNotices(shownBoth, { ...ctx, includeClosed: true }).some((n) => n.id === 'cap'), 'VE3 closed rows shown next to the open ones: no cap notice');
  const capped = response([row('9203'), row('9204', { status: 'COMPLETED' })], { openItemsTotal: 5, itemsTotal: 6 });
  const capText = vmPoamNotices(capped, { ...ctx, includeClosed: true }).find((n) => n.id === 'cap')?.text ?? '';
  assert(capText.includes('1 of 5') && capText.includes('The exports list the same 1.'), 'VE3 cap notice names the open rows shown', capText);

  const manyClosed = response([row('9301', { status: 'COMPLETED' }), row('9302', { status: 'RISK_ACCEPTED' })], { openItemsTotal: 0, itemsTotal: 7 });
  assert(vmPoamNotices(manyClosed, { ...ctx, includeClosed: true }).find((n) => n.id === 'closed_cap')?.text === 'Showing the first 2 of 7 completed or risk-accepted items.', 'VE4 closed cap notice');
  assert(!vmPoamNotices(manyClosed, ctx).some((n) => n.id === 'closed_cap'), 'VE4 no closed cap notice while closed items are hidden');
  assert(vmClosedCount(manyClosed) === 7 && vmClosedToggleText(7) === 'Show completed and risk-accepted items (7)', 'VE4 closed count and toggle text');

  const closedThree = response([], { itemsTotal: 3 });
  assert(vmItemsEmptyText(closedThree).endsWith('3 completed or risk-accepted items are hidden.'), 'VE5 empty text, closed hidden');
  assert(vmItemsEmptyText(response([], { itemsTotal: 1 }), { includeClosed: true }).endsWith('The completed or risk-accepted item is listed below.'), 'VE5 empty text, one closed item shown');
  assert(vmItemsEmptyText(response([])) === 'No vulnerability POA&M items are open, and no open vulnerability is past its deadline.', 'VE5 no closed items: the text is unchanged');

  const noTarget = vmPoamNotices(response([], { target: null, isTarget: false, autocreate: false }), ctx);
  const notTarget = vmPoamNotices(response([], { target: 'q', isTarget: false, autocreate: false }), ctx);
  assert(noTarget.find((n) => n.id === 'no_target')?.action === 'open_programs' && notTarget.find((n) => n.id === 'not_target')?.action === 'open_programs', 'VE6 no_target and not_target link to Programs');
  assert(noTarget.find((n) => n.id === 'autocreate_off')?.action === undefined, 'VE6 autocreate_off has no action');

  assert(filterVmPoamRows([row('9401', { owner: 'IT Lead' }), row('9402')], 'it lead').length === 1, 'VE7 search finds an owner');
  assert(VM_POAM_COPY.searchPlaceholder.includes('owner'), 'VE7 the placeholder names the owner');

  assert(vmPastTargetDate(row('9501', { sched: '2026-01-05' }), '2026-01-10T00:00:00Z') === true, 'VE8 open item past its target date');
  assert(vmPastTargetDate(row('9502', { sched: '2026-01-05', status: 'COMPLETED' }), '2026-01-10T00:00:00Z') === false, 'VE8 a completed item is never past');
  assert(vmPastTargetDate(row('9503'), '2026-01-10T00:00:00Z') === false && vmPastTargetDate(row('9504', { sched: '2026-01-10' }), '2026-01-10T00:00:00Z') === false, 'VE8 no date, or today, is not past');
}

console.log('\n--- VP20 source pins ---');
for (const f of ['src/data/reports/poamView.ts', 'src/data/reports/vmPoamView.ts']) {
  const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  assert(!/console\./.test(src) && !/localStorage|sessionStorage|addDaysToDate/.test(src), `VP20 ${f}: no console, browser storage or addDaysToDate`);
}
{
  const src = fs.readFileSync(path.join(process.cwd(), 'src/data/reports/vmPoamView.ts'), 'utf8');
  assert(!/documentCompilers/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'vmPoamView does not import documentCompilers');
}

function finish() {
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}
