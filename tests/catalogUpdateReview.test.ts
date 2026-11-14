import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CATALOG_LIST_PAGE,
  browserCatalogUpdate,
  catalogRevLabel,
  catalogUpdateDismissKey,
  catalogUpdateKeyPrefix,
  catalogUpdateNoticeCopy,
  catalogUpdateNoticeMode,
  catalogUpdateOverviewText,
  catalogUpdateRows,
  catalogUpdateSummary,
  groupByControl,
  objectiveNotInChecklist,
  objectiveStatusLabel,
  previousStatusBadge,
  rowsForView,
  toCheckSnapshot,
  type CatalogUpdateRow,
  type CatalogUpdateSummary,
} from '../src/data/cmmcGuide/catalogUpdateReview';
import { CatalogUpdateNotice, CatalogUpdateOverviewNotice } from '../src/components/dashboard/CatalogUpdateNotice';
import { CatalogUpdateListBody } from '../src/components/dashboard/CatalogUpdateList';
import { migrateCachedObjectives } from '../src/data/cmmcGuide/migration';
import { cmmcGuideLetter, cmmcGuideObjectiveId } from '../src/data/cmmcGuide/displayId';
import { CMMC_OBJECTIVE_CATALOG_REV, guideObjectives } from '../src/data/cmmcGuide/guide';
import { legacyObjectives } from '../src/data/cmmcGuide/objectives';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import type { AssessmentState } from '../src/types/cmmc';
import type { AssessmentObjective, ObjectiveStatus } from '../src/types/assessment';
import type { CatalogUpdateChanges, CatalogUpdateObjectiveChange } from '../src/types/controlObjectives';

/**
 * #287: the review of the answers the objective update set back to In progress. The pure helpers (rows, summary, notice copy, snapshot, grouping,
 * the dismissal key), the record a browser-only cache keeps, and static checks on the context, the hook and the screens.
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

const REV = 'cmmc-ag-2.13';
const AT = '2026-11-01T00:00:00.000Z';
const srv = (objectiveId: string, over: Partial<CatalogUpdateObjectiveChange> = {}): CatalogUpdateObjectiveChange => ({
  objectiveId,
  controlId: objectiveId.replace(/\[.*$/, ''),
  oldStatus: 'MET',
  newStatus: 'IN_PROGRESS',
  currentStatus: 'IN_PROGRESS',
  reviewed: false,
  changedAt: AT,
  ...over,
});
const changesOf = (objectives: CatalogUpdateObjectiveChange[]): CatalogUpdateChanges => ({ applies: true, catalogRev: REV, objectives, controls: [], truncated: false });
const row = (objectiveId: string, over: Partial<CatalogUpdateRow> = {}): CatalogUpdateRow => ({
  objectiveId,
  controlId: objectiveId.replace(/\[.*$/, ''),
  controlDisplayId: objectiveId.replace(/\[.*$/, ''),
  displayId: objectiveId,
  newText: 'new',
  oldText: 'old',
  previousStatus: 'MET',
  setTo: 'IN_PROGRESS',
  currentStatus: 'IN_PROGRESS',
  reviewed: false,
  orphan: false,
  changedAt: AT,
  ...over,
});
const sum = (over: Partial<CatalogUpdateSummary> = {}): CatalogUpdateSummary => ({ answers: 12, controls: 7, unreviewedAnswers: 12, unreviewedControls: 7, orphans: 0, controlIds: new Set<string>(), ...over });
const sorted = (xs: string[]) => [...xs].sort();

console.log('\n--- Rows ---');
const r1 = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]')]), 'CMMC_L2')[0];
const g1 = guideObjectives('3.12.4', 'CMMC_L2').find((g) => g.letter === 'a');
const o1 = legacyObjectives('CA.L2-3.12.4', 'CMMC_L2').find((o) => o.letter === 'a');
assert(!!g1 && r1.newText === g1.text && r1.oldText === (o1?.text ?? null) && !r1.orphan, 'R1 the row carries the guide wording and the earlier wording', r1);
assert(r1.previousStatus === 'MET' && r1.setTo === 'IN_PROGRESS' && r1.currentStatus === 'IN_PROGRESS' && !r1.reviewed && r1.controlDisplayId.length > 0, 'R1 statuses and the control display id come through');

let l1Id = '';
for (const c of getFrameworkControls('CMMC_L1')) {
  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    const id = `${c.id}[${letter}]`;
    if (!l1Id && cmmcGuideLetter(c.id, letter, 'CMMC_L1') !== letter) l1Id = id;
  }
}
const r2 = l1Id ? catalogUpdateRows(changesOf([srv(l1Id)]), 'CMMC_L1')[0] : null;
assert(l1Id !== '' && r2 !== null && r2.displayId === cmmcGuideObjectiveId(l1Id, 'CMMC_L1') && r2.displayId !== l1Id, 'R2 a Level 1 PE objective shows the guide id (re-lettered)', { l1Id, shown: r2?.displayId });

const r3 = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[z]')]), 'CMMC_L2')[0];
assert(r3.orphan && r3.newText === null, 'R3 a letter the guide no longer has is an orphan with no new text', r3);

const stateObjectives = { 'CA.L2-3.12.4[a]': { id: 'CA.L2-3.12.4[a]', status: 'MET' } } as unknown as Record<string, AssessmentObjective>;
const r4 = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]', { reviewed: false })]), 'CMMC_L2', stateObjectives)[0];
assert(r4.reviewed && r4.currentStatus === 'MET', 'R4 a status that differs from the one the update set counts as reviewed, even when the server says not', r4);
const r4b = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]', { reviewed: true })]), 'CMMC_L2')[0];
assert(r4b.reviewed, 'R4 the server\'s reviewed flag is kept');

console.log('\n--- Summary ---');
const rows5 = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]'), srv('CA.L2-3.12.4[z]'), srv('AC.L2-3.1.1[a]')]), 'CMMC_L2');
const s5 = catalogUpdateSummary(rows5);
assert(s5.answers === 2 && s5.controls === 2 && s5.unreviewedAnswers === 2 && s5.unreviewedControls === 2 && s5.orphans === 1 && sorted([...s5.controlIds]).join() === 'AC.L2-3.1.1,CA.L2-3.12.4', 'R5 the orphan is left out of the counts; both controls are in controlIds', { ...s5, controlIds: [...s5.controlIds] });

console.log('\n--- The dismissal key ---');
assert(catalogUpdateDismissKey('t1', 'p1', REV, 'u1') === 'pbc_catalog_update_reviewed_t1_p1_cmmc-ag-2.13_u1', 'R6 the key names tenant, program, revision and user');
assert(catalogUpdateDismissKey('t1', null, REV, 'u1') === 'pbc_catalog_update_reviewed_t1_local_cmmc-ag-2.13_u1', 'R6 a tenant with no program uses "local"');
assert(catalogUpdateDismissKey('t1', 'p1', REV, 'u1').startsWith(catalogUpdateKeyPrefix('t1')) && catalogUpdateKeyPrefix('t1') === 'pbc_catalog_update_reviewed_t1_', 'R6 the tenant prefix covers every key of the tenant');

console.log('\n--- The record a browser-only cache keeps ---');
const obj = (id: string, status: ObjectiveStatus, extra: Partial<AssessmentObjective> = {}): AssessmentObjective => ({
  id, controlId: id.replace(/\[.*$/, ''), letter: id.replace(/^.*\[|\]$/g, ''), text: 't', status, prefilledTemplate: '', implementationNarrative: '', linkedEvidenceIds: [], isAutoVerifiedByTelemetry: false, ...extra,
});
const ctrl = (id: string, status: 'MET' | 'IN_PROGRESS') => ({ id, status, implementationNotes: '', responsibleRole: '', lastUpdated: '', tags: [] });
const cached = {
  programId: 'p',
  controls: { 'AC.L1-3.1.1': ctrl('AC.L1-3.1.1', 'MET'), 'CA.L2-3.12.4': ctrl('CA.L2-3.12.4', 'MET'), 'AC.L2-3.1.5': ctrl('AC.L2-3.1.5', 'MET') },
  objectives: {
    'AC.L1-3.1.1[a]': obj('AC.L1-3.1.1[a]', 'MET'),
    'AC.L1-3.1.1[c]': obj('AC.L1-3.1.1[c]', 'MET'),
    'CA.L2-3.12.4[a]': obj('CA.L2-3.12.4[a]', 'MET', { implementationNarrative: 'SECRET', linkedEvidenceIds: ['ev1'] }),
    'AC-2[a]': obj('AC-2[a]', 'MET'),
  },
} as unknown as AssessmentState;
const mig = migrateCachedObjectives(cached, 'CMMC_L2');
const rec = browserCatalogUpdate(mig.changedObjectives, mig.changedControls, CMMC_OBJECTIVE_CATALOG_REV, AT);
assert(sorted(rec.objectives.map((o) => o.objectiveId)).join() === 'AC.L1-3.1.1[c],CA.L2-3.12.4[a]' && sorted(rec.objectives.map((o) => o.objectiveId)).join() === sorted(mig.changedObjectives.map((o) => o.id)).join(), 'R7 the record lists the changed objectives', rec.objectives);
assert(sorted(rec.controls.map((c) => c.controlId)).join() === 'AC.L1-3.1.1,CA.L2-3.12.4' && sorted(rec.controls.map((c) => c.controlId)).join() === sorted(mig.changedControls.map((c) => c.id)).join(), 'R7 the record lists the changed controls', rec.controls);
assert(!JSON.stringify(rec).includes('SECRET') && rec.rev === 'cmmc-ag-2.13' && rec.at === AT && rec.objectives[0].controlId === 'AC.L1-3.1.1', 'R7 the record holds ids and statuses only, with the control id of each objective');

console.log('\n--- Notice copy ---');
const copy = catalogUpdateNoticeCopy(sum(), { canEdit: true, rev: REV });
assert(copy.heading === 'The assessment objectives were updated to the CMMC Assessment Guide v2.13.' && copy.count === '12 answers on 7 controls need another look.' && copy.action === 'Check each answer against the new wording and set its status again.' && copy.orphanNote === null, 'R9 heading, count and action', copy);
assert(copy.explain === 'Answers that were Met or Not applicable on an objective whose wording changed were set to In progress. Narratives and evidence were kept.', 'R9 the explanation');
assert(catalogUpdateNoticeCopy(sum({ answers: 1, controls: 1, unreviewedAnswers: 1, unreviewedControls: 1 }), { canEdit: true, rev: REV }).count === '1 answer on 1 control needs another look.', 'R10 singular');
assert(catalogUpdateNoticeCopy(sum(), { canEdit: false, rev: REV }).action === 'A Tenant Owner or MSP Admin can set the status again.', 'R11 read-only action');
assert(catalogUpdateNoticeCopy(sum({ orphans: 2 }), { canEdit: true, rev: REV }).orphanNote === '2 more answers are kept for objectives the guide no longer has. They are in the list.'
  && catalogUpdateNoticeCopy(sum({ orphans: 1 }), { canEdit: true, rev: REV }).orphanNote === '1 more answer is kept for an objective the guide no longer has. It is in the list.', 'R12 orphan note, plural and singular');
assert(catalogUpdateNoticeCopy(sum({ answers: 5, unreviewedAnswers: 0, unreviewedControls: 0 }), { canEdit: true, rev: REV }).allDone === 'All 5 answers the objective update set to In progress have been updated since.'
  && catalogUpdateNoticeCopy(sum({ answers: 1, unreviewedAnswers: 0, unreviewedControls: 0 }), { canEdit: true, rev: REV }).allDone === 'The 1 answer the objective update set to In progress has been updated since.'
  && catalogUpdateNoticeCopy(sum({ answers: 0 }), { canEdit: true, rev: REV }).allDone === null, 'R13 all done, plural, singular and none');
assert(catalogRevLabel('cmmc-ag-2.13') === 'CMMC Assessment Guide v2.13' && catalogRevLabel('x') === 'CMMC Assessment Guide' && catalogRevLabel(null) === 'CMMC Assessment Guide', 'R14 the revision label');

console.log('\n--- Notice mode ---');
const modeOf = (status: 'off' | 'loading' | 'error' | 'ready', s: CatalogUpdateSummary, dismissed = false) => catalogUpdateNoticeMode({ status, summary: s, dismissed });
assert(modeOf('loading', sum()) === 'hidden' && modeOf('error', sum()) === 'hidden' && modeOf('off', sum()) === 'hidden' && modeOf('ready', sum(), true) === 'hidden'
  && modeOf('ready', sum({ answers: 0, unreviewedAnswers: 0, unreviewedControls: 0, orphans: 0 })) === 'hidden', 'R15 hidden while loading, on error, off, dismissed or with nothing changed');
assert(modeOf('ready', sum()) === 'review' && modeOf('ready', sum({ unreviewedAnswers: 0, unreviewedControls: 0 })) === 'done', 'R15 review while answers are left, done once none is');
assert(modeOf('ready', sum({ answers: 0, unreviewedAnswers: 0, unreviewedControls: 0, orphans: 2 })) === 'done', 'R15 only orphans listed: done');

console.log('\n--- Snapshot and groups ---');
const rowsA = [row('AC.L2-3.1.2[a]'), row('AC.L2-3.1.10[a]'), row('AC.L2-3.1.1[a]', { reviewed: true }), row('CA.L2-3.12.4[z]', { orphan: true })];
const snap = toCheckSnapshot(rowsA);
assert(snap.size === 2 && snap.has('AC.L2-3.1.2[a]') && !snap.has('AC.L2-3.1.1[a]') && !snap.has('CA.L2-3.12.4[z]'), 'R16 the snapshot holds the unreviewed answers that are not orphans');
const rowsB = rowsA.map((r) => (r.objectiveId === 'AC.L2-3.1.2[a]' ? { ...r, reviewed: true } : r));
assert(rowsForView(rowsB, 'check', snap).some((r) => r.objectiveId === 'AC.L2-3.1.2[a]') && rowsForView(rowsB, 'check', snap).length === 2, 'R16 a row reviewed since the snapshot stays in the check view');
assert(rowsForView(rowsB, 'all', snap).length === 3 && !rowsForView(rowsB, 'all', snap).some((r) => r.orphan), 'R16 the all view leaves orphans out');
assert(groupByControl([row('AC.L2-3.1.10[a]'), row('AC.L2-3.1.2[a]'), row('AC.L2-3.1.2[b]')]).map((g) => g.controlId).join() === 'AC.L2-3.1.2,AC.L2-3.1.10', 'R17 controls are in number order (3.1.2 before 3.1.10)');
assert(groupByControl([row('AC.L2-3.1.2[b]'), row('AC.L2-3.1.2[a]')])[0].rows.map((r) => r.objectiveId).join() === 'AC.L2-3.1.2[a],AC.L2-3.1.2[b]', 'R17 rows are in objective order');

console.log('\n--- Labels ---');
assert(objectiveStatusLabel('NOT_APPLICABLE') === 'Not applicable' && objectiveStatusLabel('MET') === 'Met' && objectiveStatusLabel('NOT_MET') === 'Not met' && objectiveStatusLabel('IN_PROGRESS') === 'In progress' && objectiveStatusLabel('NOT_STARTED') === 'Not started', 'R18 status labels');
assert(previousStatusBadge('MET') === 'Was Met before the objective update', 'R18 the previous-status badge');
assert(objectiveNotInChecklist('AC.L2-3.1.1[z]') === "Objective AC.L2-3.1.1[z] is not in this control's checklist.", 'R18 the missing-objective line');
const ov3 = catalogUpdateOverviewText(sum({ answers: 3 }), { rev: REV, sprs: true });
assert(ov3.startsWith('3 answers were set to In progress when the assessment objectives were updated to the CMMC Assessment Guide v2.13.') && ov3.endsWith('and the SPRS score. Narratives and evidence were kept.'), 'R19 overview text with the SPRS score', ov3);
assert(catalogUpdateOverviewText(sum({ answers: 3 }), { rev: REV, sprs: false }).endsWith('Met count. Narratives and evidence were kept.') && catalogUpdateOverviewText(sum({ answers: 1 }), { rev: REV, sprs: false }).startsWith('1 answer was set'), 'R19 without the SPRS score, and the singular');
assert(CATALOG_LIST_PAGE === 25, 'the list pages by 25 controls');

console.log('\n--- Source checks ---');
const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const ctxSrc = readSrc('src/context/AssessmentContext.tsx');
const tenantSrc = readSrc('src/context/TenantContext.tsx');
const hookSrc = readSrc('src/hooks/useCatalogUpdateChanges.ts');
const helperSrc = readSrc('src/data/cmmcGuide/catalogUpdateReview.ts');
const changedBlock = ctxSrc.slice(ctxSrc.indexOf('A browser-only tenant has no server history'), ctxSrc.indexOf('A browser-only tenant has no server history') + 1400);
assert(changedBlock.includes("source: 'catalog-update'") && changedBlock.includes('catalogRev: CMMC_OBJECTIVE_CATALOG_REV') && changedBlock.indexOf('metadata: auditMetadata') > changedBlock.indexOf("source: 'catalog-update'") && ctxSrc.includes('browserCatalogUpdate('), 'R8 the ledger entries of the browser-side update carry source catalog-update, and the record is kept');
assert(ctxSrc.includes('openControlAtObjective') && ctxSrc.includes('clearFocusObjective') && ctxSrc.includes('dismissCatalogUpdate') && /setFocusObjective\(null\);\n\s*setSelectedDomainFilter\('ALL'\)/.test(ctxSrc), 'R8 the context opens a control on an objective and resets it with the scope');
assert(!/console\./.test(hookSrc) && !/console\./.test(helperSrc), 'R8 the hook and the helper have no console');
const storageCalls = [...hookSrc.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)];
assert(storageCalls.length === 2 && storageCalls.every((x) => x[2].startsWith('dismissKey')) && !/sessionStorage/.test(hookSrc) && !/localStorage|sessionStorage/.test(helperSrc), 'R8 the hook touches browser storage only through the dismissal key', storageCalls.map((x) => x[0]));
assert(/catalogUpdateKeyPrefix\(tenantId\)/.test(tenantSrc), 'R8 removing a tenant clears its dismissal keys');
assert(hookSrc.includes('serverBacked') && hookSrc.includes('!serverBacked && state.catalogUpdate') && hookSrc.includes('getCatalogUpdateChanges(tenantId, programId)'), 'R8 a server-backed tenant ignores the cache record and asks the server');

console.log('\n--- The notice ---');
const noticeProps = (mode: 'hidden' | 'review' | 'done', over: Partial<React.ComponentProps<typeof CatalogUpdateNotice>> = {}): React.ComponentProps<typeof CatalogUpdateNotice> => ({
  mode,
  copy: catalogUpdateNoticeCopy(mode === 'done' ? sum({ unreviewedAnswers: 0, unreviewedControls: 0 }) : sum(), { canEdit: true, rev: REV }),
  filterOn: false,
  onToggleFilter: () => {},
  onOpenList: () => {},
  onDismiss: () => {},
  ...over,
});
const reviewHtml = renderToStaticMarkup(React.createElement(CatalogUpdateNotice, noticeProps('review')));
assert(reviewHtml.includes('role="region"') && reviewHtml.includes('The assessment objectives were updated to the CMMC Assessment Guide v2.13.') && reviewHtml.includes('aria-pressed="false"') && reviewHtml.includes('aria-label="Dismiss the objective update notice"'), 'R20 the review notice is a region with the heading, a filter toggle and a dismiss button');
assert(!reviewHtml.includes('role="alert"') && !reviewHtml.includes('aria-live="assertive"') && reviewHtml.includes('12 answers on 7 controls need another look.'), 'R20 the notice is not an alert and shows the count');
const doneHtml = renderToStaticMarkup(React.createElement(CatalogUpdateNotice, noticeProps('done')));
assert(doneHtml.includes('All 12 answers the objective update set to In progress have been updated since.') && !doneHtml.includes('aria-pressed'), 'R20 the done notice says all are updated and has no filter toggle');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateNotice, noticeProps('hidden'))) === '', 'R20 a hidden notice renders nothing');
const onHtml = renderToStaticMarkup(React.createElement(CatalogUpdateNotice, noticeProps('review', { filterOn: true })));
assert(onHtml.includes('aria-pressed="true"') && onHtml.includes('Showing only the controls with answers to check.'), 'R20 the filter toggle is pressed and announced politely when on');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateOverviewNotice, { text: 'TEXT', onOpenMatrix: () => {} })).includes('Review in the control matrix'), 'R20 the overview notice points at the matrix');

console.log('\n--- The list ---');
const listRows = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]'), srv('CA.L2-3.12.4[z]')]), 'CMMC_L2');
const bodyProps = (over: Partial<React.ComponentProps<typeof CatalogUpdateListBody>> = {}): React.ComponentProps<typeof CatalogUpdateListBody> => ({
  status: 'ready',
  rows: listRows,
  summary: catalogUpdateSummary(listRows),
  truncated: false,
  snapshot: toCheckSnapshot(listRows),
  mode: 'check',
  onModeChange: () => {},
  shownGroups: CATALOG_LIST_PAGE,
  onShowMore: () => {},
  titles: new Map(),
  onOpen: () => {},
  onRetry: () => {},
  ...over,
});
const listHtml = renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps()));
assert(listHtml.includes('aria-label="Open objective CA.L2-3.12.4[a]"') && listHtml.includes('Kept, no longer an objective in the guide (1)') && listHtml.includes('Open control'), 'R21 an answer has Open objective; an orphan is listed apart with Open control', listHtml.length);
assert(listHtml.includes('To check (1)') && listHtml.includes('All (1)') && listHtml.includes('Before:') && listHtml.includes('Guide wording') && listHtml.includes('Earlier wording'), 'R21 the view toggle, the statuses and both wordings are shown');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ truncated: true }))).includes('Only the first 1000 changed answers are listed.'), 'R21 a truncated listing says so');
const manyRows = Array.from({ length: 30 }, (_, i) => row(`AC.L2-3.1.${i + 1}[a]`));
const manyHtml = renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ rows: manyRows, summary: catalogUpdateSummary(manyRows), snapshot: toCheckSnapshot(manyRows) })));
assert(manyHtml.includes('Showing 25 of 30 controls') && manyHtml.includes('Show 5 more controls') && (manyHtml.match(/Open objective AC/g) ?? []).length === 25, 'R21 30 controls are drawn 25 at a time');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ snapshot: new Set<string>() }))).includes('Nothing left to check. Choose All to see every changed answer.'), 'R21 an empty check view says nothing is left');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ status: 'loading' }))).includes('Loading the changed answers…') && renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ status: 'error' }))).includes('Retry'), 'R21 loading and error states');
const reviewedRow = catalogUpdateRows(changesOf([srv('CA.L2-3.12.4[a]', { reviewed: true, currentStatus: 'MET' })]), 'CMMC_L2');
assert(renderToStaticMarkup(React.createElement(CatalogUpdateListBody, bodyProps({ rows: reviewedRow, summary: catalogUpdateSummary(reviewedRow), snapshot: new Set(['CA.L2-3.12.4[a]']) }))).includes('Updated since'), 'R21 a reviewed answer that was in the snapshot stays listed as Updated since');

console.log('\n--- Source checks (screens) ---');
const listSrc = readSrc('src/components/dashboard/CatalogUpdateList.tsx');
const noticeSrc = readSrc('src/components/dashboard/CatalogUpdateNotice.tsx');
const matrixSrc = readSrc('src/components/dashboard/AssessmentMatrix.tsx');
const overviewSrc = readSrc('src/components/dashboard/ComplianceOverview.tsx');
const inspectSrc = readSrc('src/components/matrix/InspectDocumentModal.tsx');
const checklistSrc = readSrc('src/components/matrix/ObjectiveChecklist.tsx');
assert(listSrc.includes('<DialogOverlay') && listSrc.includes('max-h-[85vh]') && ![listSrc, noticeSrc].some((x) => /console\./.test(x) || /localStorage|sessionStorage|dangerouslySetInnerHTML/.test(x)), 'the list is a dialog, and the new components have no console, storage or raw HTML');
assert(matrixSrc.includes('<CatalogUpdateNotice') && matrixSrc.includes('aria-pressed={catalogUpdateFilter !== null}') && matrixSrc.includes('catalogUpdateFilter && !catalogUpdateFilter.has(ctrl.id)') && matrixSrc.includes('{canEdit && <FailedMoveControlsNotice />}'), 'R8 the matrix shows the notice and the chip, filters by the snapshot and keeps the failed-move notice');
assert(matrixSrc.includes('<CatalogUpdateList') && matrixSrc.includes('openControlAtObjective(row.controlId, row.orphan ? null : row.objectiveId, row.previousStatus)'), 'the matrix opens a control on an objective, and an orphan on its control only');
assert(overviewSrc.includes('<CatalogUpdateOverviewNotice') && overviewSrc.includes("setActiveTab('matrix')"), 'the overview points at the matrix');
assert(inspectSrc.includes('focusObjective={') && inspectSrc.includes("focusObjective.controlId === activeId) setActiveTab('objectives')"), 'R8 the control dialog shows the objectives tab and passes the request to the checklist');
assert(checklistSrc.includes('data-objective-id={obj.id}') && checklistSrc.includes('tabIndex={-1}') && checklistSrc.includes('prefers-reduced-motion') && checklistSrc.includes('scrollIntoView('), 'R8 the checklist scrolls to the objective, focuses it and respects reduced motion');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
