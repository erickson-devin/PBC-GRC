import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPECTED_UI_TEXT,
  ROW_STATE_VIEW,
  controlsSummary,
  expectedCsvFileName,
  expectedRowState,
  generateAction,
  generateResultText,
  overdueLine,
  presentLine,
  recommendedLine,
  registerPrefill,
  rowFilterCounts,
  rowMatchesFilter,
  visibleSuggestions,
} from '../src/data/documents/expectedChecklistView';
import { expectedStatus, type ExpectedDocument } from '../src/data/documents/expectedDocuments';
import { generatedSeedKey } from '../src/data/documents/generatedDrafts';
import type { DocumentAttachment, GovernanceDocument } from '../src/types/documents';

/** The expected-documents checklist screens: the pure row logic (state, counts, suggestions, generate rule, file names) and source checks on the panel, the page, the library and the navigation. */
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

const TODAY = '2026-11-19';
const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

const doc = (over: Partial<GovernanceDocument> = {}): GovernanceDocument => ({
  id: 'd1', tenantId: 't1', kind: 'POLICY', title: 'Access Control Policy', reference: '', owner: '', version: '', status: 'DRAFT',
  approvalDate: null, reviewBy: null, approvedBy: null, approvedAt: null, locationUrl: null, origin: 'MANUAL', seedKey: null, notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: null, ...over,
});
const entry = (over: Partial<ExpectedDocument> = {}): ExpectedDocument => ({
  id: 'e-ac', name: 'Access control policy', kind: 'POLICY', description: 'The access control policy.', controls: ['AC.L2-3.1.1'], keywords: ['access'],
  requirement: 'EXPECTED', generator: { family: 'AC' }, ...over,
});
const att = (documentId: string, evidenceId: string, isPrimary = true): DocumentAttachment => ({ documentId, evidenceId, isPrimary, linkedAt: '2026-11-01T00:00:00.000Z', linkedBy: null });

// A approved + live file, B draft, C approved with no copy, D retired
const A = doc({ id: 'A', title: 'Access Control Policy', status: 'APPROVED', approvalDate: '2026-10-01', reviewBy: '2027-10-01' });
const B = doc({ id: 'B', title: 'Incident Response Plan', kind: 'PLAN', status: 'DRAFT' });
const C = doc({ id: 'C', title: 'Media Plan', kind: 'PLAN', status: 'APPROVED', approvalDate: '2026-10-01' });
const D = doc({ id: 'D', title: 'Old Plan', kind: 'PLAN', status: 'RETIRED' });
const docs = [A, B, C, D];
const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
const live = new Set(['ev-A']);
const entries: ExpectedDocument[] = [
  entry({ id: 'e1' }),
  entry({ id: 'e2', name: 'Incident response plan', kind: 'PLAN', keywords: ['incident'], generator: undefined }),
  entry({ id: 'e3', name: 'Media plan', kind: 'PLAN', keywords: ['media'], generator: undefined }),
  entry({ id: 'e4', name: 'Missing thing', kind: 'ARTIFACT', keywords: ['zzz'], generator: undefined }),
  entry({ id: 'e5', name: 'Retired only', kind: 'PLAN', keywords: ['zzz'], generator: undefined }),
  entry({ id: 'e6', name: 'Recommended thing', kind: 'REFERENCE', keywords: ['zzz'], requirement: 'RECOMMENDED', generator: undefined }),
];
const pd = {
  attachments: [att('A', 'ev-A')],
  expectations: [
    { expectedId: 'e1', documentId: 'A' },
    { expectedId: 'e2', documentId: 'B' },
    { expectedId: 'e3', documentId: 'C' },
    { expectedId: 'e5', documentId: 'D' },
  ],
};
const rows = expectedStatus(entries, docs, pd, live, TODAY);
const rowOf = (id: string) => rows.find((r) => r.entry.id === id)!;

console.log('--- EU1 expectedRowState ---');
{
  assert(expectedRowState(rowOf('e1'), byId) === 'PRESENT', 'EU1a: an approved linked document with a live file is PRESENT');
  assert(expectedRowState(rowOf('e2'), byId) === 'DRAFT_ONLY', 'EU1b: a linked draft is DRAFT_ONLY');
  assert(expectedRowState(rowOf('e3'), byId) === 'NO_COPY', 'EU1c: approved with no copy on file is NO_COPY');
  assert(expectedRowState(rowOf('e4'), byId) === 'MISSING', 'EU1d: nothing linked is MISSING');
  assert(expectedRowState(rowOf('e5'), byId) === 'MISSING', 'EU1e: only a retired document is MISSING');
  assert(ROW_STATE_VIEW.PRESENT.text === 'Present' && ROW_STATE_VIEW.NO_COPY.text === 'Approved, no copy on file' && ROW_STATE_VIEW.DRAFT_ONLY.text === 'Draft only' && ROW_STATE_VIEW.MISSING.text === 'Missing', 'EU1f: the state texts');
  assert(ROW_STATE_VIEW.PRESENT.tone === 'emerald' && ROW_STATE_VIEW.MISSING.tone === 'rose' && ROW_STATE_VIEW.DRAFT_ONLY.tone === 'amber', 'EU1g: the state tones');
}

console.log('--- EU2 lines ---');
{
  assert(presentLine({ present: 8, total: 20 }) === '8 of 20 expected documents present', 'EU2a: the present line');
  assert(recommendedLine({ recommendedPresent: 0, recommendedTotal: 0 }) === null, 'EU2b: no recommended entries, no line');
  assert(recommendedLine({ recommendedPresent: 1, recommendedTotal: 3 }) === 'Recommended: 1 of 3 present', 'EU2c: the recommended line');
  assert(overdueLine(0) === null, 'EU2d: no overdue, no line');
  assert(overdueLine(1) === '1 present document is past its review date. It still counts; review it.', 'EU2e: one overdue');
  assert(overdueLine(2) === '2 present documents are past their review date. They still count; review them.', 'EU2f: two overdue');
}

console.log('--- EU3 rowFilterCounts ---');
{
  const c = rowFilterCounts(rows, byId);
  assert(c.ALL === 5, 'EU3a: only EXPECTED rows are counted (the recommended one is left out)', c);
  assert(c.PRESENT === 1 && c.MISSING === 2 && c.NOT_READY === 2, 'EU3b: NOT_READY is draft only plus no copy', c);
  assert(rowMatchesFilter('NO_COPY', 'NOT_READY') && rowMatchesFilter('DRAFT_ONLY', 'NOT_READY') && !rowMatchesFilter('MISSING', 'NOT_READY') && rowMatchesFilter('PRESENT', 'ALL'), 'EU3c: rowMatchesFilter');
}

console.log('--- EU4 visibleSuggestions ---');
{
  const row = { ...rowOf('e4'), suggestions: ['x', 'y', 'z'] };
  const v = visibleSuggestions(row, new Set(['e4:y', 'other:z']));
  assert(v.length === 2 && v[0] === 'x' && v[1] === 'z', 'EU4a: only the dismissed key of this entry is dropped', v);
  assert(visibleSuggestions(row, new Set()).length === 3, 'EU4b: nothing dismissed keeps all');
}

console.log('--- EU5 generateAction ---');
{
  const noGen = generateAction(entry({ generator: undefined }), docs, rowOf('e4'), 'CMMC_L2');
  assert(noGen === null, 'EU5a: no generator, no action');
  assert(generateAction(entry({ kind: 'PLAN' }), docs, rowOf('e4'), 'CMMC_L2') === null, 'EU5b: not a policy, no action');
  assert(generateAction(entry({ generator: { family: 'ZZ' } }), docs, rowOf('e4'), 'CMMC_L2') === null, 'EU5c: a family the generator does not draft, no action');
  const seed = generatedSeedKey('CMMC_L2', 'AC');
  const gen = doc({ id: 'G', seedKey: seed, origin: 'GENERATED' });
  const linked = { ...rowOf('e4'), satisfiedBy: ['G'] };
  assert(generateAction(entry(), [...docs, gen], linked, 'CMMC_L2') === null, 'EU5d: the generated draft is already linked, no action');
  const le = generateAction(entry(), [...docs, gen], rowOf('e4'), 'CMMC_L2');
  assert(le !== null && le.kind === 'link_existing' && le.documentId === 'G', 'EU5e: an existing generated draft is linked, not duplicated', le);
  const g = generateAction(entry(), docs, rowOf('e4'), 'CMMC_L2');
  assert(g !== null && g.kind === 'generate' && g.seedKey === generatedSeedKey('CMMC_L2', 'AC'), 'EU5f: otherwise generate with the seed key', g);
  const retired = doc({ id: 'R', seedKey: seed, origin: 'GENERATED', status: 'RETIRED' });
  const gr = generateAction(entry(), [...docs, retired], rowOf('e4'), 'CMMC_L2');
  assert(gr !== null && gr.kind === 'generate', 'EU5g: a retired generated draft does not count as existing');
  assert(generateResultText('created').includes('does not count as present') && generateResultText('linked_existing').includes('does not count as present'), 'EU5h: both results say a draft is not present');
}

console.log('--- EU6 controls, file names, prefill ---');
{
  const ids = Array.from({ length: 8 }, (_, i) => `AC.L2-3.1.${i + 1}`);
  const s = controlsSummary(ids, (id) => id.toLowerCase(), 6);
  assert(s.shown.length === 6 && s.more === 2 && s.shown[0] === 'ac.l2-3.1.1', 'EU6a: six shown, two more', s);
  assert(controlsSummary(ids.slice(0, 3), (id) => id).more === 0, 'EU6b: nothing more under the cap');
  assert(expectedCsvFileName('CMMC_L2', TODAY) === 'expected-documents-cmmc_l2-2026-11-19.csv', 'EU6c: the CSV file name has no organization name');
  const p = registerPrefill(entry({ name: 'Incident response plan', kind: 'PLAN' }));
  assert(p.kind === 'PLAN' && p.title === 'Incident response plan', 'EU6d: the register form starts from the entry name and kind', p);
}

console.log('--- EU6e wording ---');
{
  const all = JSON.stringify([EXPECTED_UI_TEXT, ROW_STATE_VIEW]);
  assert(!/MSP Admin/.test(all) && !/required by|mandatory/i.test(all), 'EU6e: no role-guard phrase, no "required by" or "mandatory"');
  assert(EXPECTED_UI_TEXT.unverified.includes('has not yet been checked by a person') && EXPECTED_UI_TEXT.unverified.includes('starting point'), 'EU6f: the unverified note says so plainly');
}

console.log('--- EU7 ExpectedDocumentsPanel source ---');
{
  const src = readSrc('src/components/documents/ExpectedDocumentsPanel.tsx');
  assert(src.includes("origin: 'GENERATED'") && src.includes('putExpectation('), 'EU7a: generating registers a GENERATED draft and links it');
  const from = src.indexOf('const act = generateAction(');
  const to = src.indexOf('};', from);
  const handler = from >= 0 && to > from ? src.slice(from, to) : '';
  assert(handler.length > 0, 'EU7b: the generate handler was found');
  assert(!handler.includes('uploadEvidence(') && !handler.includes('requestUploadUrl(') && !handler.includes('.approve(') && !handler.includes('putControls('), 'EU7c: generating never uploads, approves or links controls');
  assert(src.includes('role="progressbar"'), 'EU7d: the progress bar has its role');
  assert(src.includes('verified') && src.includes('catalogAsOfLine('), 'EU7e: the as-of date and the unverified note are shown');
  assert(!src.includes('setActiveFramework'), 'EU7f: the checklist never switches the framework');
}

console.log('--- EU8 PolicyLibraryView source ---');
{
  const src = readSrc('src/views/PolicyLibraryView.tsx');
  assert(src.includes("origin: 'GENERATED'") && src.includes('generatedSeedKey(activeFramework, selectedFamily.code)') && src.includes('Register as draft'), 'EU8a: Register as draft creates a GENERATED row with the shared seed key');
  assert(src.includes('withEffectiveStack(') && src.includes('copyText(') && src.includes('<MarkdownPreview'), 'EU8b: the generator, copy and preview are kept');
  assert(!src.includes('setActiveFramework'), 'EU8c: the library never switches the framework');
  assert(src.includes('reg.supported'), 'EU8d: browser-only organizations get no new control');
}

console.log('--- EU9 navigation ---');
{
  const side = readSrc('src/components/layout/Sidebar.tsx');
  assert(side.includes("id: 'documents'") && side.includes("label: 'Document Register'"), 'EU9a: the sidebar has the Document Register item');
  assert(side.indexOf("label: 'Document Register'") < side.indexOf("label: 'Living Policy Library'"), 'EU9b: the register comes before the Living Policy Library');
  const app = readSrc('src/App.tsx');
  assert(app.includes("{activeTab === 'documents' && <DocumentsPage />}") && app.includes('<PolicyLibraryView />'), 'EU9c: App mounts the page and keeps the library');
  assert(readSrc('src/context/AssessmentContext.tsx').includes("| 'documents'"), 'EU9d: the tab union has documents');
  assert(!readSrc('src/data/programDefaultChoice.ts').includes("'documents'"), 'EU9e: the register tab is organization-wide, not program-scoped');
  const page = readSrc('src/components/documents/DocumentsPage.tsx');
  assert(page.includes('aria-pressed') && page.includes('<ErrorBoundary') && page.includes('<ExpectedDocumentsPanel') && page.includes('<DocumentRegisterPanel'), 'EU9f: the page switches between the register and the checklist inside an error boundary');
}

console.log('--- EU10 privacy and dialog cap ---');
{
  for (const rel of ['src/components/documents/ExpectedDocumentsPanel.tsx', 'src/components/documents/DocumentsPage.tsx', 'src/data/documents/expectedChecklistView.ts']) {
    const src = readSrc(rel);
    assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|alert\(/.test(src), `EU10a: ${rel} logs nothing, stores nothing, injects no HTML`);
    let ok = true;
    let at = src.indexOf('<DialogOverlay');
    while (at >= 0) {
      const w = src.slice(at, at + 900);
      if (!w.includes('max-h-[') && !w.includes('my-auto')) ok = false;
      at = src.indexOf('<DialogOverlay', at + 1);
    }
    assert(ok, `EU10b: every dialog overlay in ${rel} is height-capped`);
  }
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
