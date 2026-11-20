import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COPY_ENTRY_TEXT,
  DEFAULT_INCLUDE,
  SUGGESTION_BLOCK_TEXT,
  changeTypeLabel,
  chipSuggestion,
  chipText,
  confirmButtonLabel,
  confirmLines,
  copyEntryState,
  copyErrorView,
  copyTotals,
  eligibleSources,
  filterPreviewRows,
  formatCopyBytes,
  includeValid,
  isR3ControlId,
  itemHasSomethingToCopy,
  lastRunLine,
  relationLabel,
  rev2CounterpartsView,
  rowsShownText,
  suggestionConfirmText,
  suggestionIndex,
  suggestionReasonText,
  suggestionSetBlock,
  summaryHeadline,
  summaryRows,
  type CopyInclude,
} from '../src/data/frameworkCopy/copyView';
import { CopyPreviewTable, CopySummaryView } from '../src/components/frameworkCopy/CopyPreviewTable';
import type { FrameworkCopyItem, FrameworkCopyRun, FrameworkCopySummary, R3StatusSuggestion } from '../src/types/frameworkCopy';

/** The "Copy from Rev. 2" screens (#255): the pure view model (states, filters, totals, fixed copy, error map, suggestions) and source checks on the screens. No server. */
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
const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const item = (target: string, over: Partial<FrameworkCopyItem> = {}, sourceId = 'AC.L1-3.1.1'): FrameworkCopyItem => ({
  targetControlId: target,
  sources: [{ controlId: sourceId, relation: 'SAME' }],
  notes: { count: 0, chars: 0 },
  objectives: { count: 0, chars: 0 },
  evidence: { count: 0, bytes: 0, unavailable: 0 },
  tools: 0,
  documents: 0,
  alreadyCopied: 0,
  changedSinceCopy: 0,
  ops: [],
  ...over,
});
const off: CopyInclude = { notes: false, objectives: false, evidence: false, tools: false, documents: false };

console.log('--- V1 copyEntryState ---');
{
  const ok = { framework: 'NIST_800_171_R3', serverBacked: true, hasProgram: true, archived: false, canEdit: true, notesEditable: true };
  assert(copyEntryState({ ...ok, framework: 'CMMC_L2' }) === 'hidden', 'V1a: a CMMC program has no entry');
  assert(copyEntryState({ ...ok, serverBacked: false }) === 'browser_only', 'V1b: a browser-only organization');
  assert(copyEntryState({ ...ok, hasProgram: false }) === 'hidden', 'V1c: no program on a server-backed organization');
  assert(copyEntryState({ ...ok, archived: true, canEdit: false }) === 'archived', 'V1d: archived comes before read-only');
  assert(copyEntryState({ ...ok, canEdit: false }) === 'read_only', 'V1e: read-only');
  assert(copyEntryState({ ...ok, notesEditable: false }) === 'not_loaded', 'V1f: controls not loaded');
  assert(copyEntryState(ok) === 'ready', 'V1g: ready');
  assert(/Copy from Rev\. 2 needs an organization stored on the server\./.test(COPY_ENTRY_TEXT.browserOnly), 'V1h: the browser-only line');
}

console.log('--- V2 eligibleSources ---');
{
  const p = (id: string, name: string, framework: string, archived = false) => ({ id, name, framework: framework as never, archived });
  const programs = [p('t', 'Target', 'NIST_800_171_R3'), p('B', 'B', 'CMMC_L2'), p('A', 'A', 'CMMC_L2', true), p('C', 'C', 'CMMC_L1'), p('D', 'D', 'NIST_800_53_REV5')];
  const r = eligibleSources(programs, 't', ['CMMC_L2', 'CMMC_L1', 'NIST_800_171_R3']);
  assert(r.map((x) => x.id).join() === 'B,A,C', 'V2a: Level 2 first, open before archived, then Level 1; never the target or other frameworks');
  assert(r.map((x) => x.label).join('|') === 'B (CMMC Level 2)|A (CMMC Level 2, archived)|C (CMMC Level 1)', 'V2b: the labels', r);
  assert(eligibleSources(programs, 't', ['CMMC_L2']).map((x) => x.id).join() === 'B,A', 'V2c: a framework that is not enabled is dropped');
}

console.log('--- V3 include and items ---');
{
  assert(includeValid(off) === false && includeValid({ ...off, tools: true }) === true, 'V3a: includeValid');
  assert(itemHasSomethingToCopy(item('03.01.01', { notes: { count: 1, chars: 5 } }), { ...DEFAULT_INCLUDE, notes: false }) === false, 'V3b: notes off');
  assert(itemHasSomethingToCopy(item('03.01.01', { evidence: { count: 2, bytes: 10, unavailable: 0 } }), DEFAULT_INCLUDE) === true, 'V3c: evidence on');
  assert(itemHasSomethingToCopy(item('03.01.01', { alreadyCopied: 3 }), DEFAULT_INCLUDE) === false, 'V3d: already copied alone is nothing');
  assert(itemHasSomethingToCopy(item('03.01.01', { evidence: { count: 0, bytes: 0, unavailable: 2 } }), DEFAULT_INCLUDE) === false, 'V3e: unavailable alone is nothing');
}

console.log('--- V4 filterPreviewRows and totals ---');
{
  const rows = [
    item('03.10.01', { notes: { count: 1, chars: 4 } }, 'PE.L1-3.10.1'),
    item('03.02.01', { tools: 1 }, 'AT.L2-3.2.1'),
    item('03.13.05', {}, 'SC.L2-3.13.5'),
    item('03.01.01', { notes: { count: 2, chars: 4 }, evidence: { count: 2, bytes: 2048, unavailable: 1 }, changedSinceCopy: 1, alreadyCopied: 2 }, 'AC.L1-3.1.1'),
  ];
  const f = (o: Partial<Parameters<typeof filterPreviewRows>[1]> = {}) => filterPreviewRows(rows, { onlyWithCopy: true, query: '', include: DEFAULT_INCLUDE, ...o });
  assert(f().map((r) => r.targetControlId).join() === '03.01.01,03.02.01,03.10.01', 'V4a: the empty row is hidden and 03.02.01 sorts before 03.10.01');
  assert(f({ onlyWithCopy: false }).length === 4, 'V4b: every row without the filter');
  assert(f({ query: 'ac.l2-3.1.1' }).map((r) => r.targetControlId).join() === '03.01.01', 'V4c: a Rev. 2 display id finds its row');
  assert(f({ query: '03.13', onlyWithCopy: false }).map((r) => r.targetControlId).join() === '03.13.05', 'V4d: a Rev. 3 prefix');
  const t = copyTotals(rows, DEFAULT_INCLUDE);
  assert(t.controls === 3 && t.notes === 3 && t.tools === 1 && t.evidence === 2 && t.evidenceBytes === 2048 && t.evidenceUnavailable === 1, 'V4e: totals', t);
  assert(t.changedSinceCopy === 1 && t.alreadyCopied === 2, 'V4f: earlier copies are summed');
  const n = copyTotals(rows, { ...off, notes: true });
  assert(n.controls === 2 && n.evidence === 0 && n.evidenceBytes === 0 && n.tools === 0 && n.changedSinceCopy === 1, 'V4g: excluded kinds count 0, changed since copy is always summed', n);
  assert(rowsShownText(41, 97) === 'Showing 41 of 97 Rev. 3 controls with Rev. 2 content.', 'V4h: some shown');
  assert(rowsShownText(97, 97) === 'Showing all 97 Rev. 3 controls with Rev. 2 content.', 'V4i: all shown');
  assert(rowsShownText(0, 97) === 'No Rev. 3 control has anything to copy with these settings.', 'V4j: none shown');
}

console.log('--- V5 bytes, confirmation, summary ---');
{
  assert([0, 1023, 1536, 1048576, 1073741824].map(formatCopyBytes).join('|') === '0 B|1023 B|1.5 KiB|1 MiB|1 GiB', 'V5a: formatCopyBytes');
  assert(confirmButtonLabel(1) === 'Append to 1 control' && confirmButtonLabel(41) === 'Append to 41 controls', 'V5b: button label');
  const totals = { controls: 41, notes: 38, objectives: 120, evidence: 57, evidenceBytes: 312 * 1048576, evidenceUnavailable: 0, tools: 12, documents: 9, alreadyCopied: 0, changedSinceCopy: 0 };
  const lines = confirmLines({ totals, include: DEFAULT_INCLUDE, targetName: 'R3 program', sourceName: 'L2 program' });
  assert(lines[0] === 'Append to 41 Rev. 3 controls of "R3 program" from "L2 program".', 'V5c: first line names both programs', lines[0]);
  assert(lines.includes('Evidence files: 57 (312 MiB)') && lines.includes('Notes: 38 blocks') && lines.includes('Document links: 9'), 'V5d: one line per included kind');
  const noEv = confirmLines({ totals, include: { ...DEFAULT_INCLUDE, evidence: false }, targetName: 'a', sourceName: 'b' });
  assert(!noEv.some((l) => /Evidence/.test(l)), 'V5e: no evidence line when evidence is off');
  assert(lines.some((l) => l.includes('never changed or removed')) && lines.some((l) => l.startsWith('Statuses are not changed')), 'V5f: the guarantees');
  const zero: FrameworkCopySummary = { notesAppended: 0, objectivesAppended: 0, evidenceCopied: 0, evidenceUnavailable: 0, toolLinksAdded: 0, toolLinksSkipped: 0, documentLinksAdded: 0, documentLinksSkipped: 0, alreadyCopied: 0, controls: [], newInR3: 0, notCarried: 0, mergedInto: 0 };
  assert(summaryHeadline(zero).startsWith('Nothing new to copy'), 'V5g: nothing copied');
  assert(summaryHeadline({ ...zero, notesAppended: 2, controls: ['03.01.01'] }) === 'Copied into 1 control.', 'V5h: one control');
  const warn = summaryRows({ ...zero, evidenceUnavailable: 2, toolLinksSkipped: 1 });
  const un = warn.find((r) => r.key === 'evidenceUnavailable');
  assert(un?.tone === 'warn' && /Attach these by hand/.test(un.note ?? '') && warn.find((r) => r.key === 'toolLinksSkipped')?.tone === 'warn', 'V5i: unavailable and skipped are warnings with a note');
  assert(summaryRows(zero).length === 9 && summaryRows(zero).every((r) => r.tone === 'normal'), 'V5j: nine rows, none a warning at zero');
}

console.log('--- V6 labels ---');
{
  assert(relationLabel('SAME') === 'Same requirement' && relationLabel('INCORPORATED_INTO') === 'Merged into this requirement' && relationLabel('ADDRESSED_BY') === 'Addressed by this requirement', 'V6a: relationLabel');
  assert(changeTypeLabel('NO_SIGNIFICANT_CHANGE') === 'No significant change' && changeTypeLabel('MINOR_CHANGE') === 'Minor change' && changeTypeLabel('SIGNIFICANT_CHANGE', true) === 'Significant change · new parameter', 'V6b: changeTypeLabel');
  assert(changeTypeLabel(undefined, true) === 'New parameter' && changeTypeLabel(undefined) === null, 'V6c: no type');
  assert(isR3ControlId('03.01.01') && !isR3ControlId('3.1.1') && !isR3ControlId('AC.L2-3.1.1') && !isR3ControlId('03.01'), 'V6d: isR3ControlId');
}

console.log('--- V7 copyErrorView ---');
{
  const e = (reason?: string, status = 0) => Object.assign(new Error('secret narrative text'), { status, reason });
  const table: [string, string, string | null][] = [
    ['copy_plan_stale', 'stale', 'preview_again'],
    ['copy_in_progress', 'in_progress', 'preview_again'],
    ['copy_too_large', 'too_large', 'clear_evidence'],
    ['program_archived', 'archived', null],
    ['framework_not_enabled', 'not_enabled', null],
    ['program_not_found', 'source_gone', 'refresh_programs'],
    ['invalid_copy_source', 'bad_source', null],
    ['invalid_copy_target', 'bad_target', null],
  ];
  for (const [reason, kind, action] of table) {
    const v = copyErrorView(e(reason, 409), 'commit');
    assert(v.kind === kind && v.action === action, `V7a: ${reason}`, v);
  }
  assert(copyErrorView({ status: 413 }, 'preview').kind === 'too_large', 'V7b: 413');
  assert(copyErrorView({ status: 404 }, 'preview').kind === 'source_gone', 'V7c: 404');
  assert(copyErrorView({ status: 403, reason: 'forbidden' }, 'commit').kind === 'forbidden', 'V7d: forbidden');
  assert(copyErrorView({ status: 0 }, 'preview').message !== copyErrorView({ status: 0 }, 'commit').message, 'V7e: unreachable differs by phase');
  assert(copyErrorView({ status: 0 }, 'preview').action === 'retry' && copyErrorView({ status: 0 }, 'commit').action === 'preview_again', 'V7f: unreachable actions');
  assert(copyErrorView(e(undefined, 500), 'commit').kind === 'failed' && !copyErrorView(e(undefined, 500), 'commit').message.includes('secret'), 'V7g: another error never repeats the error text');
  assert(copyErrorView(null, 'preview').kind === 'failed', 'V7h: a non-error');
  assert(!/Tenant Owner or MSP Admin/.test(copyErrorView({ status: 403 }, 'commit').message), 'V7i: the write roles are worded as on the other screens');
}

console.log('--- V8 lastRunLine ---');
{
  const run = (over: Partial<FrameworkCopyRun> = {}): FrameworkCopyRun => ({
    id: 'r1', sourceProgramId: 'p1', sourceFramework: 'CMMC_L2', actor: 'a@x.mil', createdAt: '2026-11-20T10:00:00Z',
    summary: { notesAppended: 1, objectivesAppended: 0, evidenceCopied: 0, evidenceUnavailable: 0, toolLinksAdded: 0, toolLinksSkipped: 0, documentLinksAdded: 0, documentLinksSkipped: 0, alreadyCopied: 0, controls: ['03.01.01', '03.01.02'], newInR3: 0, notCarried: 0, mergedInto: 0 },
    ...over,
  });
  assert(lastRunLine(run(), (id) => (id === 'p1' ? 'CMMC L2' : null)) === 'Last copied from "CMMC L2" on 2026-11-20 by a@x.mil: 2 controls changed.', 'V8a: a known program');
  assert((lastRunLine(run(), () => null) ?? '').includes('from a program that no longer exists on'), 'V8b: an unknown program');
  assert(lastRunLine(undefined, () => 'x') === null, 'V8c: no run');
}

console.log('--- V9 suggestions ---');
{
  const sug = (controlId: string, suggested: R3StatusSuggestion['suggested'], reasonCode: R3StatusSuggestion['reasonCode'], statuses: ('MET' | 'NOT_MET' | 'IN_PROGRESS')[], ids = ['AC.L1-3.1.1']): R3StatusSuggestion => ({
    controlId, suggested, reasonCode, sources: statuses.map((status, i) => ({ controlId: ids[i] ?? ids[0], relation: 'SAME', status })),
  });
  const data = { applies: true, sourceProgramId: 'p1', suggestions: [sug('03.01.01', 'MET', 'all_met_unchanged', ['MET']), sug('03.99.99', 'MET', 'all_met_unchanged', ['MET'])] };
  const cat = new Set(['03.01.01']);
  assert(suggestionIndex({ ...data, applies: false }, cat).size === 0 && suggestionIndex(null, cat).size === 0, 'V9a: nothing when it does not apply');
  const idx = suggestionIndex(data, cat);
  assert(idx.size === 1 && idx.has('03.01.01'), 'V9b: ids outside the catalog are dropped');
  assert(chipSuggestion(idx, '03.01.01', 'MET', true) === null, 'V9c: matches the current status');
  assert(chipSuggestion(idx, '03.01.01', 'NOT_STARTED', false) === null, 'V9d: status not loaded');
  assert(chipSuggestion(idx, '03.01.01', 'NOT_STARTED', true) === 'MET', 'V9e: otherwise the value');
  assert(chipSuggestion(new Map([['03.01.01', sug('03.01.01', null, null, ['NOT_STARTED' as never])]]), '03.01.01', 'MET', true) === null, 'V9f: no suggestion, no chip');
  assert(chipText('IN_PROGRESS') === 'Rev. 2 suggests In progress', 'V9g: chipText');
  assert(suggestionReasonText(sug('03.01.01', 'NOT_MET', 'any_not_met', ['NOT_MET'])) === 'At least one Rev. 2 source is Not met (AC.L2-3.1.1).', 'V9h: not met names the sources');
  assert(suggestionReasonText(sug('x', 'MET', 'all_met_unchanged', ['MET'])).includes('not significant'), 'V9i: met');
  assert(suggestionReasonText(sug('x', 'IN_PROGRESS', 'all_met_changed', ['MET'])).includes('needs a fresh review'), 'V9j: met but changed');
  assert(suggestionReasonText(sug('x', 'IN_PROGRESS', 'partial', ['MET', 'IN_PROGRESS'])).includes('none is Not met'), 'V9k: mixed');
  const base = { suggested: 'MET' as const, current: 'NOT_STARTED' as const, canEdit: true, archived: false, statusLoaded: true };
  assert(suggestionSetBlock({ ...base, current: 'MET', canEdit: false }) === 'matches', 'V9l: matches first');
  assert(suggestionSetBlock({ ...base, canEdit: false, archived: true }) === 'read_only', 'V9m: read-only before archived');
  assert(suggestionSetBlock({ ...base, archived: true, statusLoaded: false }) === 'archived', 'V9n: archived before not loaded');
  assert(suggestionSetBlock({ ...base, statusLoaded: false }) === 'not_loaded' && suggestionSetBlock(base) === null, 'V9o: not loaded, then free');
  assert(/Tenant Owner or Admin/.test(SUGGESTION_BLOCK_TEXT.read_only), 'V9p: the read-only text names the write roles');
  const c = suggestionConfirmText('03.01.01', 'NOT_STARTED', 'IN_PROGRESS');
  assert(c.includes('Record 03.01.01 as In progress?') && c.includes('only a suggestion'), 'V9q: confirm text', c);
}

console.log('--- V10 rev2CounterpartsView ---');
{
  const none = rev2CounterpartsView([], null, null);
  assert(none.empty === 'No Rev. 2 counterpart: this requirement is new in Rev. 3.' && none.items.length === 0 && none.heading === 'Rev. 2 counterparts', 'V10a: new in Rev. 3');
  const v = rev2CounterpartsView([{ cmmcId: 'AC.L1-3.1.1', relation: 'INCORPORATED_INTO', changeType: 'MINOR_CHANGE' }], new Map([['AC.L1-3.1.1', 'MET' as const]]), 'X');
  assert(v.empty === null && v.items[0].recordedLine === 'Met in "X" (Rev. 2)' && v.items[0].badge === 'Merged into this requirement' && v.items[0].detail === 'Minor change', 'V10b: a recorded status', v.items[0]);
  const r = rev2CounterpartsView([{ cmmcId: 'AC.L1-3.1.1', relation: 'SAME' }], null, null);
  assert(r.items[0].recordedLine?.startsWith('Reference only') === true && r.items[0].recordedStatus === null, 'V10c: reference only without a record');
}

console.log('--- V11 rendered components ---');
{
  const rows = [
    item('03.01.01', { notes: { count: 2, chars: 4 }, changedSinceCopy: 1 }, 'AC.L1-3.1.1'),
    item('03.13.08', { evidence: { count: 1, bytes: 1536, unavailable: 1 } }, 'SC.L2-3.13.8'),
  ];
  rows[1].sources = [{ controlId: 'SC.L2-3.13.8', relation: 'INCORPORATED_INTO' }];
  const html = renderToStaticMarkup(React.createElement(CopyPreviewTable, { rows, include: { ...DEFAULT_INCLUDE, tools: false } }));
  assert(html.includes('<caption') && html.includes('scope="col"') && html.includes('sticky top-0'), 'V11a: caption, column headers and a sticky header');
  assert(html.includes('AC.L2-3.1.1') && html.includes('Merged into this requirement'), 'V11b: Rev. 2 ids and relation');
  assert(html.includes('1 changed since copy') && html.includes('1.5 KiB') && html.includes('1 unavailable'), 'V11c: earlier copies, size, unavailable');
  assert(html.includes('Off'), 'V11d: an excluded kind shows Off');
  assert(html.includes('scope="row"') && html.includes('tabindex="0"'), 'V11e: row headers and a focusable scroll region');
  const sum = renderToStaticMarkup(React.createElement(CopySummaryView, { summary: { notesAppended: 1, objectivesAppended: 0, evidenceCopied: 0, evidenceUnavailable: 2, toolLinksAdded: 0, toolLinksSkipped: 0, documentLinksAdded: 0, documentLinksSkipped: 0, alreadyCopied: 0, controls: ['03.01.01'], newInR3: 0, notCarried: 0, mergedInto: 0 } }));
  assert(sum.includes('Notes appended') && sum.includes('Attach these by hand') && sum.includes('border-amber-800/40'), 'V11f: the summary cards');
}

console.log('--- V12 source checks ---');
{
  const dialog = readSrc('src/components/frameworkCopy/CopyFromRev2Dialog.tsx');
  assert(dialog.includes('max-h-[') && dialog.includes('DialogTitle') && !dialog.includes('dangerouslySetInnerHTML') && !dialog.includes('console.'), 'V12a: the dialog is height-capped, titled, and has no raw HTML or logging');
  assert(dialog.includes('aria-busy') && dialog.includes('role="status"') && dialog.includes('aria-label="Copy steps"'), 'V12b: busy, live region and step list');
  assert(!/err\.message|\.message\)/.test(dialog.replace('error?.message', '')), 'V12c: the dialog never shows an error text from the server');
  const matrix = readSrc('src/components/dashboard/AssessmentMatrix.tsx');
  assert(matrix.includes('<CopyFromRev2Entry') && matrix.includes('rev2Suggestion='), 'V12d: the matrix mounts the entry and passes the chip');
  assert(matrix.includes("case 'NIST_800_171_R3':") && matrix.includes("activeFramework !== 'NIST_800_171_R3' && ("), 'V12e: the subtitle and the baseline filter');
  assert(readSrc('src/components/dashboard/ControlCard.tsx').includes('data-testid="card-rev2-suggestion"'), 'V12f: the card chip');
  const inspect = readSrc('src/components/matrix/InspectDocumentModal.tsx');
  assert(inspect.includes('<Rev2SuggestionStrip') && inspect.includes('rev2='), 'V12g: the detail strip and the crosswalk prop');
  assert(inspect.includes('Under NIST SP 800-171A Rev. 3, each determination statement'), 'V12h: the assessment method banner for Rev. 3');
  assert(readSrc('src/components/matrix/ObjectiveChecklist.tsx').includes('NIST SP 800-171A Rev. 3 Objective Rollup'), 'V12i: the Rev. 3 rollup heading');
  assert(readSrc('src/components/matrix/CrosswalkPanel.tsx').includes('rev2CounterpartsView('), 'V12j: the crosswalk uses the Rev. 2 counterparts');
  assert(readSrc('src/views/PolicyLibraryView.tsx').includes("'03.17'") && readSrc('src/data/inventory/vendorRegisterView.ts').includes("'03.16.03'"), 'V12k: the policy families and the vendor control');
  for (const f of ['CopyFromRev2Entry', 'CopyFromRev2Dialog', 'CopyPreviewTable', 'Rev2SuggestionStrip']) {
    const s = readSrc(`src/components/frameworkCopy/${f}.tsx`);
    assert(!s.includes('javascript:') && !/Tenant Owner or MSP Admin/.test(s) && !s.includes('dangerouslySetInnerHTML') && !/console\./.test(s) && !/localStorage|sessionStorage/.test(s), `V12l: ${f} has no javascript:, wrong role wording, raw HTML, logging or browser storage`);
  }
  const hook = readSrc('src/hooks/useFrameworkCopy.ts');
  assert(!/console\.|localStorage|sessionStorage/.test(hook), 'V12m: the hooks log and store nothing');
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
