/**
 * #240 / #250: the client logic of the document register. The location rules, review state with an injected today, the register view (filter, order,
 * program set, counts, primary copy, the one "present" rule), the generated-draft seed, the CSV, the SSP 1.3.2 rows, the completeness items and their
 * export gaps, the compiled SSP and the Markdown with and without document data, and the privacy of the hooks (React state only: no browser storage,
 * no console). Pure test: no server, no browser.
 */
import fs from 'fs';
import path from 'path';
import { classifyLocation, safeLinkHref, GENERATED_SEED_PATTERN } from '../src/data/documents/documentSchema';
import {
  DOCUMENT_KIND_LABELS,
  REVIEW_STATE_LABELS,
  attachmentCountsByDocument,
  attachmentsOf,
  controlCountsByDocument,
  daysUntil,
  documentsInProgram,
  filterDocuments,
  isPresent,
  overdueCount,
  primarySource,
  reviewState,
  sortDocuments,
} from '../src/data/documents/documentRegisterView';
import { GENERATOR_FAMILIES, canGenerateDraft, generatedDraftFileName, generatedDraftTitle, generatedSeedKey, parseGeneratedSeed, renderGeneratedDraft } from '../src/data/documents/generatedDrafts';
import {
  DOCUMENTS_NOT_AVAILABLE,
  FILE_REMOVED,
  SSP_DOCUMENT_HEADERS,
  buildSspDocumentsCompletenessInput,
  buildSspDocumentsSnapshot,
  documentCompletenessItems,
  documentsSubsection,
  sspDocumentsMarkdown,
  type SspDocumentsSnapshot,
} from '../src/data/documents/sspDocuments';
import { expectedStatus, presentCounts, type ExpectedDocument } from '../src/data/documents/expectedDocuments';
import { DOCUMENT_CSV_HEADERS, EXPECTED_DOCUMENTS_CSV_HEADERS, documentRegisterCsv, expectedDocumentsCsv } from '../src/data/reports/documentRegisterCsv';
import { computeSspCompleteness, sspCompletenessFromReport } from '../src/data/ssp/sspCompleteness';
import { SSP_SECTIONS, SSP_SIGNABLE_SECTION_IDS, sectionCanonical } from '../src/data/ssp/sspSections';
import { getExportGaps } from '../src/data/reports/exportReadiness';
import { compileNistSSP } from '../src/data/reports/documentCompilers';
import { buildSspMarkdown } from '../src/services/storageService';
import { notifyDocumentsChanged, subscribeDocuments } from '../src/services/documentService';
import { buildSspInventorySnapshot, sspInventoryMarkdown } from '../src/data/inventory/sspInventory';
import { generateFamilyPolicyDocument } from '../src/data/reports/policyDocumentGenerator';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import type { DocumentAttachment, GovernanceDocument, ProgramDocuments } from '../src/types/documents';
import type { ReportMetadata } from '../src/types/report';
import type { AssessmentState } from '../src/types/cmmc';
import type { Tenant } from '../src/types/tenant';

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

const doc = (over: Partial<GovernanceDocument> & Pick<GovernanceDocument, 'id' | 'title'>): GovernanceDocument => ({
  tenantId: 't1',
  kind: 'POLICY',
  reference: '',
  owner: '',
  version: '',
  status: 'DRAFT',
  approvalDate: null,
  reviewBy: null,
  approvedBy: null,
  approvedAt: null,
  locationUrl: null,
  origin: 'MANUAL',
  seedKey: null,
  notes: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  updatedBy: null,
  ...over,
});
const approved = (over: Partial<GovernanceDocument> & Pick<GovernanceDocument, 'id' | 'title'>): GovernanceDocument =>
  doc({ version: '1.0', status: 'APPROVED', approvalDate: '2026-10-01', approvedBy: 'Jane', approvedAt: '2026-10-01T00:00:00.000Z', ...over });
const attach = (documentId: string, evidenceId: string, isPrimary: boolean): DocumentAttachment => ({ documentId, evidenceId, isPrimary, linkedAt: '2026-11-01T00:00:00.000Z', linkedBy: null });
const program = (over: Partial<ProgramDocuments> = {}): ProgramDocuments => ({ programId: 'p1', declared: false, documentIds: [], controlLinks: [], attachments: [], expectations: [], ...over });

const TODAY = '2026-11-19';

console.log('--- Locations (V1, V2) ---');
const cls = (v: string) => classifyLocation(v);
const c1 = cls('https://intranet.example/sites/grc/AC.docx');
assert(c1.ok && c1.kind === 'http' && c1.value === 'https://intranet.example/sites/grc/AC.docx', 'V1a an https link is kind http', c1);
const c1b = cls(' https://intranet.example/sites/grc/AC.docx ');
assert(c1b.ok && c1b.value === 'https://intranet.example/sites/grc/AC.docx', 'V1b the value is trimmed', c1b);
const cUnc = cls('\\\\fs01\\Compliance\\AC Policy.docx');
assert(cUnc.ok && cUnc.kind === 'unc', 'V1c a UNC share path is kind unc', cUnc);
const cFile = cls('file://fs01/Compliance/AC.docx');
assert(cFile.ok && cFile.kind === 'file', 'V1d a file:// location is kind file', cFile);
const cDrive = cls('S:\\Policies\\AC.docx');
assert(cDrive.ok && cDrive.kind === 'drive', 'V1e a mapped drive path is kind drive', cDrive);
const reasons = (v: string) => { const r = cls(v); return r.ok ? 'ok' : r.reason; };
assert(reasons('javascript:alert(1)') === 'scheme' && reasons('data:text/html,x') === 'scheme' && reasons('mailto:a@b.test') === 'scheme' && reasons('docs/AC.docx') === 'scheme', 'V1f other schemes and relative paths are refused as scheme');
assert(reasons('https://u:p@intranet/x') === 'credentials' && reasons('a'.repeat(2049)) === 'too_long' && reasons('   ') === 'empty' && reasons('https://intranet/\u0001x') === 'control_chars', 'V1g credentials, length, empty and control characters have their own reasons');
assert(safeLinkHref('\\\\fs01\\Compliance\\AC.docx') === null && safeLinkHref('file://fs01/x') === null && safeLinkHref('S:\\Policies\\AC.docx') === null && safeLinkHref('javascript:alert(1)') === null && safeLinkHref(null) === null, 'V2 only http and https become a link; UNC, file, drive and javascript are text');
assert(safeLinkHref('https://intranet.example/a b') === 'https://intranet.example/a%20b', 'V2b the link is the URL-encoded href', safeLinkHref('https://intranet.example/a b'));

console.log('\n--- Review state (V3) ---');
const rs = (reviewBy: string | null, status: GovernanceDocument['status'] = 'APPROVED') => reviewState({ status, reviewBy }, TODAY);
assert(rs('2026-11-18') === 'OVERDUE' && rs('2026-11-19') === 'DUE_SOON' && rs('2026-12-19') === 'DUE_SOON' && rs('2026-12-20') === 'CURRENT' && rs(null) === 'NOT_SET', 'V3 overdue before today; due soon from today to 30 days; current after; not set without a date');
assert(rs('2020-01-01', 'RETIRED') === 'NOT_APPLICABLE' && rs('garbage') === 'NOT_SET', 'V3b a retired document is not applicable; a value that is not a date is not set');
assert(daysUntil(TODAY, '2026-11-20') === 1 && daysUntil(TODAY, '2026-11-18') === -1 && daysUntil('2026-02-28', '2026-03-01') === 1 && daysUntil('2028-02-28', '2028-03-01') === 2 && Number.isNaN(daysUntil(TODAY, 'x')), 'V3c daysUntil counts UTC calendar days across month ends and leap days');
assert(reviewState({ status: 'DRAFT', reviewBy: '2026-12-01' }, TODAY, 5) === 'CURRENT' && reviewState({ status: 'DRAFT', reviewBy: '2026-11-24' }, TODAY, 5) === 'DUE_SOON', 'V3d the window is a parameter');
assert(Object.keys(REVIEW_STATE_LABELS).join() === 'NOT_SET,OVERDUE,DUE_SOON,CURRENT,NOT_APPLICABLE' && Object.keys(DOCUMENT_KIND_LABELS).length === 7, 'V3e every review state and every kind has a label');

console.log('\n--- Register view (V4) ---');
const d1 = doc({ id: 'd1', title: 'Access Control Policy', kind: 'POLICY', reference: 'POL-1', owner: 'Jane Roe', status: 'APPROVED', reviewBy: '2026-01-01', version: '1.0', approvalDate: '2025-01-01' });
const d2 = doc({ id: 'd2', title: 'Incident Response Plan', kind: 'PLAN', owner: 'Bob', reviewBy: '2027-06-01' });
const d3 = doc({ id: 'd3', title: 'Old Policy', kind: 'POLICY', status: 'RETIRED', reviewBy: '2020-01-01' });
const d4 = doc({ id: 'd4', title: 'Network diagram', kind: 'ARTIFACT' });
const four = [d1, d2, d3, d4];
const ids = (l: GovernanceDocument[]) => l.map((d) => d.id).join();
assert(ids(filterDocuments(four, { kind: 'POLICY' }, TODAY)) === 'd1,d3' && ids(filterDocuments(four, { kind: 'ALL' }, TODAY)) === 'd1,d2,d3,d4', 'V4 filter by kind');
assert(ids(filterDocuments(four, { status: 'RETIRED' }, TODAY)) === 'd3' && ids(filterDocuments(four, { status: 'ACTIVE' }, TODAY)) === 'd1,d2,d4' && ids(filterDocuments(four, { status: 'ALL' }, TODAY)) === 'd1,d2,d3,d4', 'V4b filter by status, ACTIVE hides the retired');
const overdueIds = four.filter((d) => d.status !== 'RETIRED' && d.reviewBy !== null && d.reviewBy < TODAY).map((d) => d.id).join();
assert(ids(filterDocuments(four, { review: 'OVERDUE' }, TODAY)) === overdueIds && overdueIds === 'd1' && ids(filterDocuments(four, { review: 'NOT_SET' }, TODAY)) === 'd4', 'V4c filter by review state (a retired document is never overdue)');
assert(ids(filterDocuments(four, { query: 'ACCESS' }, TODAY)) === 'd1' && ids(filterDocuments(four, { query: 'pol-1' }, TODAY)) === 'd1' && ids(filterDocuments(four, { query: ' roe ' }, TODAY)) === 'd1' && ids(filterDocuments(four, { query: 'zzz' }, TODAY)) === '', 'V4d search matches title, reference and owner, case-insensitively');
assert(ids(filterDocuments(four, { kind: 'POLICY', status: 'ACTIVE', query: 'policy' }, TODAY)) === 'd1', 'V4e filters combine');
assert(ids(sortDocuments([d4, d3, d2, d1])) === 'd2,d1,d3,d4' && ids(four) === 'd1,d2,d3,d4', 'V4f the order is the kind order (plan, policy ... artifact) then the title, and the input is not changed');
assert(ids(documentsInProgram(four, { declared: false, documentIds: [] })) === 'd1,d2,d3,d4' && ids(documentsInProgram(four, { declared: true, documentIds: ['d2', 'zz'] })) === 'd2', 'V4g an undeclared program uses every document; a declared one only its own');
const links = [{ documentId: 'd1', controlId: 'AC.L2-3.1.1' }, { documentId: 'd1', controlId: 'AC.L2-3.1.2' }, { documentId: 'd2', controlId: 'IR.L2-3.6.1' }];
assert(JSON.stringify(controlCountsByDocument(links)) === '{"d1":2,"d2":1}' && JSON.stringify(attachmentCountsByDocument([attach('d1', 'e1', true), attach('d1', 'e2', false), attach('d2', 'e3', true)])) === '{"d1":2,"d2":1}', 'V4h counts of connected controls and attachments per document');
assert(overdueCount(four, TODAY) === 1, 'V4i the overdue count leaves retired documents out');

console.log('\n--- Primary copy and the one "present" rule (V5) ---');
const live = new Set(['e1']);
const appr = approved({ id: 'a1', title: 'AC' });
const pdLive = program({ attachments: [attach('a1', 'e1', true)] });
const pdGone = program({ attachments: [attach('a1', 'e9', true)] });
assert(isPresent(appr, pdLive, live), 'V5 approved with a primary attachment that is live is present');
assert(!isPresent(appr, pdGone, live), 'V5b approved with a primary attachment that is gone and no location is not present');
assert(isPresent({ ...appr, locationUrl: 'https://intranet.example/ac' }, program(), live), 'V5c approved with a location only is present');
assert(!isPresent({ ...appr, status: 'DRAFT', locationUrl: 'https://intranet.example/ac' }, pdLive, live), 'V5d a draft is not present, whatever it has');
assert(!isPresent(appr, program({ attachments: [attach('a1', 'e1', false)] }), live), 'V5e an attachment that is not the primary and no location is not present');
assert(isPresent({ ...appr, reviewBy: '2020-01-01' }, pdLive, live), 'V5f an overdue review does not change it (it is flagged separately)');
const psrc = primarySource(appr, pdGone.attachments, live);
const psrc2 = primarySource({ ...appr, locationUrl: 'S:\\Policies\\AC.docx' }, [], live);
assert(psrc?.type === 'attachment' && psrc.missing === true && primarySource(appr, pdLive.attachments, live)?.type === 'attachment' && psrc2?.type === 'location' && psrc2.kind === 'drive' && primarySource(appr, [], live) === null, 'V5g the primary attachment wins and is marked missing when its file was removed; else the location; else none', { psrc, psrc2 });
const pdBoth = program({ attachments: [attach('a1', 'e1', true)] });
const srcBoth = primarySource({ ...appr, locationUrl: 'https://intranet.example/ac' }, pdBoth.attachments, live);
assert(srcBoth?.type === 'attachment', 'V5h an attachment wins over a location');
const atts = attachmentsOf('a1', [attach('a1', 'e2', false), attach('a1', 'e1', true), attach('a2', 'e3', true)], live);
assert(JSON.stringify(atts) === '[{"evidenceId":"e1","isPrimary":true,"missing":false},{"evidenceId":"e2","isPrimary":false,"missing":true}]', 'V5i the attachments of a document list the primary first and mark a removed file', atts);
// The checklist's present rule is this rule: for every combination both agree
const entry = (id: string): ExpectedDocument => ({ id, name: id, kind: 'POLICY', description: 'A description of the document.', controls: ['AC-1'], keywords: ['access'], requirement: 'EXPECTED' });
const combos = [
  { d: appr, pd: pdLive }, { d: appr, pd: pdGone }, { d: { ...appr, locationUrl: 'https://intranet.example/ac' }, pd: program() }, { d: { ...appr, status: 'DRAFT' as const }, pd: pdLive },
  { d: { ...appr, locationUrl: 'https://intranet.example/ac' }, pd: pdGone }, { d: appr, pd: program() },
];
const agree = combos.every(({ d, pd }) => {
  const rows = expectedStatus([entry('x')], [d], { attachments: pd.attachments, expectations: [{ expectedId: 'x', documentId: d.id }] }, live);
  return rows[0].present === isPresent(d, pd, live);
});
assert(agree, 'V5j the expected-documents checklist and the register use the same present rule');

console.log('\n--- Register CSV (V6) ---');
const csvDocs = [doc({ id: 'c1', title: '=cmd', owner: '+1', reference: '@ref', kind: 'PLAN', reviewBy: '2026-01-01' }), approved({ id: 'c2', title: 'AC, "Policy"', version: '2.0', owner: 'Jane', locationUrl: 'https://intranet.example/ac', reviewBy: '2027-01-01' })];
const csv = documentRegisterCsv(csvDocs, { today: TODAY, controlCounts: { c2: 3 }, primaryLabel: { c2: 'ac.pdf' } });
const csvLines = csv.split('\r\n');
assert(csvLines[0] === DOCUMENT_CSV_HEADERS.map((h) => `"${h}"`).join(',') && DOCUMENT_CSV_HEADERS.length === 13, 'V6 the header equals DOCUMENT_CSV_HEADERS', csvLines[0]);
assert(csvLines[1].startsWith(`"'=cmd","'@ref","PLAN","DRAFT"`) && csvLines[1].includes(`"'+1"`), 'V6b formula text is neutralised with a leading apostrophe', csvLines[1]);
assert(csv.endsWith('\r\n') && csvLines.length === 4 && !/[^\r]\n/.test(csv), 'V6c every line ends with CRLF', csvLines.length);
assert(csvLines[2].includes('"AC, ""Policy"""') && csvLines[2].includes('"CURRENT"') && csvLines[2].includes('"ac.pdf"') && csvLines[2].endsWith(',"3"'), 'V6d quotes are doubled, review state is computed from today, the primary label and the control count are written', csvLines[2]);
assert(csvLines[1].includes('"OVERDUE"') && csvLines[1].endsWith(',"0"'), 'V6e a missing control count is 0 and an overdue review is flagged', csvLines[1]);
assert(!csv.includes('(Approved)') && !/\((Approved|Signed|Attested)\)/.test(csv), 'V6f no approval suffix in the output');
const csvSrc = fs.readFileSync(path.join(process.cwd(), 'src/data/reports/documentRegisterCsv.ts'), 'utf8');
assert(csvSrc.includes("from './csv'") && !csvSrc.includes('addDaysToDate') && !csvSrc.includes(`replace(/"/g, '""')`) && !csvSrc.includes('(Approved)'), 'V6g the CSV writer imports ./csv, has no own quote escaping, no date maths helper and no approval suffix');
const rowsExp = expectedStatus([entry('e-a'), entry('e-b')], [approved({ id: 'a1', title: 'Access Control Policy', locationUrl: 'https://intranet.example/ac', reviewBy: '2020-01-01' })], { attachments: [], expectations: [{ expectedId: 'e-a', documentId: 'a1' }] }, live, TODAY);
const expCsv = expectedDocumentsCsv(rowsExp, { a1: 'Access Control Policy' });
const expLines = expCsv.split('\r\n');
assert(expLines[0] === EXPECTED_DOCUMENTS_CSV_HEADERS.map((h) => `"${h}"`).join(',') && expLines.length === 4 && expLines[1].includes('"PRESENT","Yes","Access Control Policy"') && expLines[2].includes('"MISSING","No",""'), 'V6h the expected-documents CSV has one row per entry with its state, overdue flag and the linked titles', expLines);

console.log('\n--- SSP 1.3.2 (V7) ---');
const sspDocs = [
  approved({ id: 'a', title: 'Access Control Policy', kind: 'POLICY', reference: 'POL-1', owner: 'Jane', reviewBy: '2027-01-01', locationUrl: 'https://intranet.example/ac' }),
  approved({ id: 'b', title: 'Incident Response Plan', kind: 'PLAN', owner: '', reviewBy: '2026-01-01' }),
  doc({ id: 'c', title: 'Draft Policy' }),
  doc({ id: 'd', title: 'Retired Policy', status: 'RETIRED' }),
];
const snap = buildSspDocumentsSnapshot({
  supported: true,
  documents: sspDocs,
  program: program({ controlLinks: [{ documentId: 'a', controlId: 'AC.L2-3.1.1' }], attachments: [attach('b', 'e1', true)] }),
  evidence: [{ id: 'e1', name: 'irp.pdf' }],
  today: TODAY,
  expected: { present: 3, total: 10 },
});
assert(snap.supported && snap.rows.map((r) => r.id).join() === 'b,a' && snap.draftCount === 1 && snap.overdueCount === 1, 'V7 the snapshot lists the approved documents (plans before policies), counts the draft and the overdue one, and leaves the retired out', snap);
assert(snap.rows[0].primary === 'irp.pdf' && snap.rows[1].primary === 'https://intranet.example/ac' && snap.rows[1].controlCount === 1 && snap.rows[0].controlCount === 0, 'V7b the primary copy is the attached file name or the location; the control count is the program\'s links');
const removed = buildSspDocumentsSnapshot({ supported: true, documents: sspDocs, program: program({ attachments: [attach('b', 'gone', true)] }), evidence: [], today: TODAY, expected: null });
assert(removed.rows.find((r) => r.id === 'b')?.primary === FILE_REMOVED && removed.expected === null, 'V7c a primary file that was removed prints "File removed"');
const declared = buildSspDocumentsSnapshot({ supported: true, documents: sspDocs, program: program({ declared: true, documentIds: ['a', 'c'] }), evidence: [], today: TODAY, expected: null });
assert(declared.rows.map((r) => r.id).join() === 'a' && declared.draftCount === 1, 'V7d a declared program lists only its own approved documents and counts only its own drafts');
const sub = documentsSubsection(snap);
assert(sub.title === '1.3.2 Governance documents' && JSON.stringify(sub.table?.headers) === JSON.stringify(SSP_DOCUMENT_HEADERS) && sub.table?.rows.length === 2, 'V7e the subsection is 1.3.2 with the SSP headers and 2 rows');
assert((sub.content ?? '').includes('1 draft') && (sub.content ?? '').includes('not yet approved') && (sub.content ?? '').includes('3 of 10 expected documents'), 'V7f the content notes the draft and the expected documents', sub.content);
assert(sub.table?.rows[0][6] === NOT_RECORDED && sub.table?.rows[1][2] === 'POL-1' && sub.table?.rows[0][1] === 'Plan', 'V7g a blank owner prints Not recorded; the kind is its label', sub.table?.rows);
const subNone = documentsSubsection(buildSspDocumentsSnapshot({ supported: true, documents: [sspDocs[2]], program: null, evidence: [], today: TODAY, expected: null }));
assert(!subNone.table && (subNone.content ?? '').includes('No approved documents') && (subNone.content ?? '').includes('1 draft'), 'V7h no approved document prints a plain sentence and still counts the draft', subNone);
const unsupported: SspDocumentsSnapshot = buildSspDocumentsSnapshot({ supported: false, documents: sspDocs, program: null, evidence: [], today: TODAY, expected: null });
assert(!unsupported.supported && unsupported.rows.length === 0 && (documentsSubsection(unsupported).content ?? '').includes('server-backed') && documentsSubsection(unsupported).content === DOCUMENTS_NOT_AVAILABLE, 'V7i an unsupported snapshot says it is not available');
const md = sspDocumentsMarkdown(snap);
assert(md.startsWith('### 1.3.2 Governance documents\n\n') && md.includes('| Document | Kind |') && md.includes('| Incident Response Plan | Plan |') && md.endsWith('\n\n') && sspDocumentsMarkdown(unsupported).includes('server-backed'), 'V7j the Markdown carries the same rows');
const pipeSnap = buildSspDocumentsSnapshot({ supported: true, documents: [approved({ id: 'p', title: 'A | B\nC' })], program: null, evidence: [], today: TODAY, expected: null });
assert(sspDocumentsMarkdown(pipeSnap).includes('| A \\| B C |'), 'V7k a pipe or line break in a title cannot break the Markdown table');

console.log('\n--- Completeness (V8) ---');
const items = documentCompletenessItems('CMMC_L2', { supported: true, approvedCount: 0, overdueCount: 1, expected: { present: 3, total: 10 } });
assert(items.length === 3 && items.every((i) => i.severity === 'advisory' && i.missing && i.sectionId === 'documents') && items.map((i) => i.id).join() === 'documents:approved,documents:overdue,documents:expected', 'V8 three advisory items, all missing', items);
assert(items[2].label === 'Expected documents present (3 of 10)', 'V8b the expected item says how many');
const ok = documentCompletenessItems('NIST_800_53_REV5', { supported: true, approvedCount: 2, overdueCount: 0, expected: { present: 10, total: 10 } });
assert(ok.every((i) => !i.missing) && documentCompletenessItems('CMMC_L2', { supported: true, approvedCount: 1, overdueCount: 0, expected: null }).length === 2 && documentCompletenessItems('CMMC_L2', { supported: false, approvedCount: 5, overdueCount: 0, expected: null }).length === 0, 'V8c nothing is missing when all is well; no expected item without a checklist; nothing when unsupported');
const without = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null });
const docsSection = without.sections.find((s) => s.sectionId === 'documents')!;
assert(!docsSection.available && docsSection.items.length === 0 && docsSection.requiredTotal === 0 && docsSection.advisoryMissing === 0, 'V8d without document data 1.3.2 is unavailable and counts for nothing', docsSection);
const withDocs = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, documents: buildSspDocumentsCompletenessInput(snap) });
const withDocsSection = withDocs.sections.find((s) => s.sectionId === 'documents')!;
assert(withDocsSection.available && withDocsSection.requiredTotal === 0 && withDocsSection.requiredMissing === 0 && withDocs.requiredMissing === without.requiredMissing && withDocs.complete === without.complete, 'V8e with document data 1.3.2 is available and never adds a required gap', withDocsSection);
assert(withDocs.advisoryMissing === without.advisoryMissing + withDocsSection.advisoryMissing && withDocsSection.advisoryMissing === 2, 'V8f its advisory gaps (an overdue document, expected documents missing) join the advisory total', withDocsSection);
const unsupportedDocs = computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null, documents: { supported: false, approvedCount: 0, overdueCount: 0, expected: null } });
assert(unsupportedDocs.requiredMissing === without.requiredMissing && unsupportedDocs.advisoryMissing === without.advisoryMissing && !unsupportedDocs.sections.find((s) => s.sectionId === 'documents')!.available, 'V8g an unsupported input counts for nothing, like none');
const meta: Partial<ReportMetadata> = { framework: 'CMMC_L2', systemName: 'S', organizationName: 'O', primaryAssessor: 'A', boundaryDescription: 'B', systemOwner: 'Jane', cageCode: 'C', samStatus: 'ACTIVE' };
const gapsNone = getExportGaps('NIST_SP_800_18_SSP', meta, { profile: null, framework: 'CMMC_L2' });
const gapsDocs = getExportGaps('NIST_SP_800_18_SSP', meta, { profile: null, framework: 'CMMC_L2', documents: buildSspDocumentsCompletenessInput(snap) });
const docGaps = gapsDocs.filter((g) => g.sspSection === 'documents');
assert(!gapsNone.some((g) => g.sspSection === 'documents') && docGaps.length === 2 && docGaps.every((g) => g.advisory === true) && gapsDocs.filter((g) => g.sspSection !== 'documents').length === gapsNone.length, 'V8h export gaps: none without document data; with it every gap is advisory and carries its section', docGaps);
const reportInput = sspCompletenessFromReport(meta, null, undefined, buildSspDocumentsCompletenessInput(snap));
assert(reportInput.documents?.supported === true && !('documents' in sspCompletenessFromReport(meta, null)) && !('documents' in sspCompletenessFromReport(meta, null, undefined)), 'V8i the report form carries the documents only when given');

console.log('\n--- Sections (V9) ---');
const sectionIds = SSP_SECTIONS.map((s) => s.id);
assert(sectionIds.indexOf('documents') === sectionIds.indexOf('system_details') + 1 && SSP_SECTIONS.find((s) => s.id === 'documents')?.number === '1.3.2' && SSP_SECTIONS.find((s) => s.id === 'documents')?.signable === false, 'V9 the documents section is 1.3.2, right after system_details, and not signable', sectionIds);
assert(SSP_SIGNABLE_SECTION_IDS.join() === 'identification,roles,environment,maintenance' && sectionCanonical('documents', { metadata: {}, profile: null }) === '[]', 'V9b the signable list is unchanged and the section has no saved fields to hash');

console.log('\n--- Compiled SSP and Markdown ---');
const fullMeta: ReportMetadata = {
  systemName: 'Sys', organizationName: 'Org', cageCode: 'C', samStatus: 'ACTIVE', systemOwner: 'Jane', primaryAssessor: 'A', boundaryDescription: 'B', systemEnvironment: 'E', operationalStatus: 'Operational',
  cloudServiceProviders: 'CSP', classificationLevel: 'UNCLASSIFIED // CUI', assessmentDate: '2026-11-19', version: '1.0.0', framework: 'CMMC_L2',
};
const subTitles = (d: ReturnType<typeof compileNistSSP>) => d.sections[0].subsections!.map((s) => s.title);
const invSnap = buildSspInventorySnapshot({ supported: true, tools: [], program: null, data: null, registry: null });
const docPlain = compileNistSSP(fullMeta, [], {}, []);
const docUndefined = compileNistSSP({ ...fullMeta, sspDocuments: undefined }, [], {}, []);
assert(JSON.stringify(docPlain.sections) === JSON.stringify(docUndefined.sections) && JSON.stringify(docPlain.summaryMetrics) === JSON.stringify(docUndefined.summaryMetrics) && !subTitles(docPlain).some((t) => t.startsWith('1.3.2')), 'V9c without document data the compiled SSP is byte-identical and prints no 1.3.2');
const docInvOnly = compileNistSSP({ ...fullMeta, sspInventory: invSnap }, [], {}, []);
const docBoth = compileNistSSP({ ...fullMeta, sspInventory: invSnap, sspDocuments: snap }, [], {}, []);
assert(subTitles(docBoth).join('|') === '1.1 System Identification & Categorization|1.2 Responsible Organization & Roles|1.3 System Details|1.3.1 Number of End Users and Privileged Users|1.3.2 Governance documents|1.4 Information Types (FCI and CUI)', 'V9d with both, 1.3.2 sits between 1.3.1 and 1.4', subTitles(docBoth));
assert(JSON.stringify(docBoth.sections[0].subsections!.filter((s) => !s.title.startsWith('1.3.2'))) === JSON.stringify(docInvOnly.sections[0].subsections) && JSON.stringify(docBoth.sections.slice(1)) === JSON.stringify(docPlain.sections.slice(1)), 'V9e adding documents changes nothing else in the SSP');
const docOnly = compileNistSSP({ ...fullMeta, sspDocuments: snap }, [], {}, []);
assert(subTitles(docOnly).join('|').endsWith('1.2 Responsible Organization & Roles|1.3.2 Governance documents') && JSON.stringify(docOnly).includes('Incident Response Plan') && JSON.stringify(compileNistSSP({ ...fullMeta, sspDocuments: unsupported }, [], {}, [])).includes('server-backed'), 'V9f documents alone follow the roles; an unsupported snapshot prints a not available line');
const state = { version: '2.0.0', tenantId: 't1', sspMetadata: { systemName: 'Sys', organizationName: 'Org', systemOwner: 'Jane', authorName: 'A', cageCode: 'C', samStatus: 'ACTIVE', assessmentDate: '2026-11-19', systemBoundaryScope: 'B', systemEnvironment: 'E', cloudServiceProviders: 'CSP', version: '1.0.0' }, controls: {}, evidenceIndex: [], lastSaved: 'x' } as unknown as AssessmentState;
const mdPlain = buildSspMarkdown(state, [], 'CMMC_L2', null);
const mdInv = buildSspMarkdown(state, [], 'CMMC_L2', null, invSnap);
assert(mdPlain === buildSspMarkdown(state, [], 'CMMC_L2', null, undefined, undefined) && mdPlain === buildSspMarkdown(state, [], 'CMMC_L2', null, null, null) && mdInv === buildSspMarkdown(state, [], 'CMMC_L2', null, invSnap, null) && !mdPlain.includes('1.3.2'), 'V9g without document data the Markdown SSP is byte-identical');
const mdBoth = buildSspMarkdown(state, [], 'CMMC_L2', null, invSnap, snap);
const i131 = mdBoth.indexOf('### 1.3.1 Number of End Users'), i132 = mdBoth.indexOf('### 1.3.2 Governance documents'), i14 = mdBoth.indexOf('## 1.4 Information Types'), i21 = mdBoth.indexOf('## 2.1 System Scope');
assert(i131 > 0 && i131 < i132 && i132 < i14 && i14 < i21 && mdBoth.replace(sspDocumentsMarkdown(snap), '') === mdInv && mdBoth.includes(sspInventoryMarkdown(invSnap, 'CMMC_L2').slice(0, 20)), 'V9h the Markdown places 1.3.2 between 1.3.1 and 1.4, and nothing else changes', { i131, i132, i14, i21 });

console.log('\n--- Hooks and purity (V10) ---');
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const hookFiles = ['src/hooks/useDocumentRegister.ts', 'src/hooks/useProgramDocuments.ts', 'src/hooks/useExpectedDocuments.ts', 'src/hooks/useSspDocuments.ts'];
for (const f of hookFiles) assert(!/localStorage|sessionStorage|indexedDB|\.setItem\(|console\./.test(read(f)), `V10 ${f} uses no browser storage and no console`);
const pureFiles = ['src/data/documents/documentRegisterView.ts', 'src/data/documents/generatedDrafts.ts', 'src/data/documents/sspDocuments.ts', 'src/data/reports/documentRegisterCsv.ts', 'src/services/documentService.ts'];
for (const f of pureFiles) assert(!/localStorage|sessionStorage|console\.|fetch\(|Date\.now|new Date\(\)|dangerouslySetInnerHTML/.test(read(f)), `V10b ${f} is pure: no storage, console, network, clock or raw HTML`);
assert(/Boolean\(currentTenant\.serverBacked\)/.test(read('src/hooks/useDocumentRegister.ts')) && /'unsupported'/.test(read('src/hooks/useDocumentRegister.ts')) && /subscribeDocuments/.test(read('src/hooks/useDocumentRegister.ts')), 'V10c the register hook is for server-backed tenants only and follows the other instances');
assert(/'unsupported'/.test(read('src/hooks/useProgramDocuments.ts')) && /'no_program'/.test(read('src/hooks/useProgramDocuments.ts')) && /subscribeDocuments/.test(read('src/hooks/useProgramDocuments.ts')) && /isOutOfDate/.test(read('src/hooks/useProgramDocuments.ts')) && /isOutOfDate/.test(read('src/hooks/useDocumentRegister.ts')), 'V10d the program hook has the unsupported and no-program states and reloads after a 404 or 409');
assert(/loadExpectedDocuments/.test(read('src/hooks/useExpectedDocuments.ts')) && /applicableExpected/.test(read('src/hooks/useExpectedDocuments.ts')), 'V10e the checklist hook loads the catalog lazily and filters it to the program');
const seen: string[] = [];
const off = subscribeDocuments((c) => seen.push(`${c.kind}:${c.programId ?? '-'}`));
notifyDocumentsChanged('t1', 'documents');
notifyDocumentsChanged('t1', 'program', 'p1');
off();
notifyDocumentsChanged('t1', 'documents');
assert(seen.join() === 'documents:-,program:p1', 'V10f the change notification reaches a subscriber until it unsubscribes', seen);
const apiSrc = read('src/services/apiClient.ts');
assert(!/[Dd]ocument[^\n]*console\./.test(apiSrc), 'V10g the document calls in the api client never log');

console.log('\n--- Generated drafts (V11) ---');
const key = generatedSeedKey('CMMC_L2', 'AC');
assert(key === 'generated:CMMC_L2:AC' && GENERATED_SEED_PATTERN.test(key) && JSON.stringify(parseGeneratedSeed(key)) === '{"framework":"CMMC_L2","family":"AC"}', 'V11 the seed key round-trips and matches the server pattern', key);
assert(Object.entries(GENERATOR_FAMILIES).every(([fw, fams]) => fams.every((f) => GENERATED_SEED_PATTERN.test(generatedSeedKey(fw, f)) && JSON.stringify(parseGeneratedSeed(generatedSeedKey(fw, f))) === JSON.stringify({ framework: fw, family: f }))), 'V11b every framework and family the generator drafts has a valid seed');
assert(parseGeneratedSeed(null) === null && parseGeneratedSeed('') === null && parseGeneratedSeed('generated:CMMC_L2') === null && parseGeneratedSeed('generated:CMMC_L2:ZZ') === null && parseGeneratedSeed('generated:SOC_2:AC') === null && parseGeneratedSeed('manual:CMMC_L2:AC') === null && parseGeneratedSeed('generated:CMMC_L2:AC:X') === null, 'V11c anything that is not a known seed parses to null');
assert(GENERATOR_FAMILIES.CMMC_L1.length === 6 && GENERATOR_FAMILIES.CMMC_L2.length === 14 && GENERATOR_FAMILIES.NIST_800_53_REV5.length === 20 && canGenerateDraft('CMMC_L2', 'AC') && !canGenerateDraft('CMMC_L1', 'AT') && !canGenerateDraft('SOC_2_TYPE_II', 'AC'), 'V11d the generator families are the Living Policy Library lists');
const stackTenant = { id: 't1', name: 'Org', systemName: 'Sys', systemOwner: 'Jane', primaryFramework: 'CMMC_L2' } as unknown as Tenant;
const dateLine = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}/g, 'DATE');
const rendered = renderGeneratedDraft(stackTenant, { framework: 'CMMC_L2', family: 'AC' }, 'Access Control Policy');
assert(dateLine(rendered) === dateLine(generateFamilyPolicyDocument(stackTenant, 'AC', 'Access Control Policy', 'CMMC_L2', undefined)) && rendered.includes('Access Control Policy'), 'V11e the rendered draft is the generator output for the same arguments, apart from the date');
assert(generatedDraftTitle(' Access Control ') === 'Access Control Policy' && generatedDraftFileName('AC', TODAY) === 'ac-policy-draft-2026-11-19.md', 'V11f the draft title and the download name carry no organization');
const genSrc = read('src/data/documents/generatedDrafts.ts');
assert(!/policyDocumentGenerator[\s\S]*\bfetch\b|apiClient|ApiClient|localStorage|uploadEvidence|requestUploadUrl/.test(genSrc), 'V11g nothing generated is uploaded or stored: the module calls the generator only');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
if (passed !== total) process.exit(1);
