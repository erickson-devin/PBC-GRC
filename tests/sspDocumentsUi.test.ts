import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeSspCompleteness } from '../src/data/ssp/sspCompleteness';
import { navEntriesView, documentsNavText } from '../src/data/ssp/sspBuilderView';
import { SspDocumentsSection } from '../src/components/ssp/SspDocumentsSection';
import { SSP_DOCUMENT_HEADERS, type SspDocumentRow, type SspDocumentsSnapshot } from '../src/data/documents/sspDocuments';

/**
 * #240 / #250: SSP section 1.3.2 (Governance documents) in the builder. The section component and the nav are rendered on the server (no browser), the
 * pure nav view is tested directly, and source pins keep the wiring (document view, copy, Markdown, export modal) from drifting.
 * Pure test: no server, no browser, no timers.
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
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const noop = () => undefined;

const row = (over: Partial<SspDocumentRow> & Pick<SspDocumentRow, 'id' | 'title'>): SspDocumentRow => ({
  reference: '', kind: 'POLICY', version: '1.0', approvalDate: '2026-10-01', reviewBy: '2027-10-01', reviewState: 'CURRENT', owner: 'Dana', primary: 'ac-policy.pdf', controlCount: 2, ...over,
});
const render = (status: 'unsupported' | 'loading' | 'ready' | 'error', snapshot: SspDocumentsSnapshot): string =>
  renderToStaticMarkup(React.createElement(SspDocumentsSection, { status, snapshot, onOpenRegister: noop, onRetry: noop }));
const NONE: SspDocumentsSnapshot = { supported: false, rows: [], draftCount: 0, overdueCount: 0, expected: null };

console.log('\n🧩 SSP 1.3.2 Governance documents in the builder (#240, #250)');

// ---------------------------------------------------------------- section component
console.log('--- The section ---');
const offHtml = render('unsupported', NONE);
assert(offHtml.includes('server-backed') && !offHtml.includes('<table') && !offHtml.includes('Open Document Register'), 'SD1 a browser-only organization gets the server-backed notice, no table and no register button');
const ready: SspDocumentsSnapshot = {
  supported: true,
  rows: [row({ id: 'a', title: 'Access Control Policy' }), row({ id: 'b', title: 'Incident Response Plan', kind: 'PLAN', owner: '', reviewBy: '2026-01-01', reviewState: 'OVERDUE', primary: 'File removed' })],
  draftCount: 1,
  overdueCount: 1,
  expected: { present: 3, total: 10 },
};
const readyHtml = render('ready', ready);
assert(readyHtml.includes('1 draft document is not listed') && readyHtml.includes('Expected documents present: 3 of 10.'), 'SD2 the draft count and the expected line');
assert(count(readyHtml, 'scope="col"') === 9 && SSP_DOCUMENT_HEADERS.length === 9, 'SD2b nine column headers');
assert(readyHtml.includes('Access Control Policy') && readyHtml.includes('Incident Response Plan') && readyHtml.includes('Review overdue') && readyHtml.includes('1 listed document is past the review date.'), 'SD2c the rows, the overdue chip and the overdue line');
assert(readyHtml.includes('(not recorded)') && readyHtml.includes('Open Document Register'), 'SD2d an unrecorded owner is flagged and the register button shows');
const emptyHtml = render('ready', { ...ready, rows: [], draftCount: 2, overdueCount: 0, expected: null });
assert(emptyHtml.includes('No approved documents in this program yet.') && emptyHtml.includes('2 draft documents are not listed') && !emptyHtml.includes('<table') && !emptyHtml.includes('Expected documents present'), 'SD2e an empty program says so and counts the drafts');
assert(render('loading', NONE).includes('role="status"') && render('error', NONE).includes('Try again') && render('error', NONE).includes('could not be loaded'), 'SD2f loading and error states');
assert(!readyHtml.includes('Mark section reviewed') && !readyHtml.includes('<input'), 'SD2g no sign-off block and no editing control');

// ---------------------------------------------------------------- nav
console.log('--- The nav ---');
const navEntries = navEntriesView(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null }), { supported: true, status: 'ready', sections: {} }, { documentsStatus: 'loading' });
const docEntry = navEntries.find((e) => e.id === 'documents');
assert(!!docEntry && docEntry.available === false && docEntry.unavailableText === 'Loading…' && docEntry.review === null, 'SD3 an unavailable documents entry is "Loading…" while loading and has no review chip');
assert(navEntriesView(computeSspCompleteness({ framework: 'CMMC_L2', metadata: {}, profile: null }), { supported: true, status: 'ready', sections: {} }).find((e) => e.id === 'documents')?.unavailableText === 'Not available', 'SD3b without a status it says Not available');
assert(documentsNavText('error') === 'Could not load' && documentsNavText('ready') === null, 'SD3c the other statuses');

// ---------------------------------------------------------------- source pins
console.log('--- Source pins ---');
const builderSrc = read('src/components/ssp/SSPBuilder.tsx');
const modalSrc = read('src/components/reports/ArtifactExportModal.tsx');
const sectionSrc = read('src/components/ssp/SspDocumentsSection.tsx');
assert(builderSrc.includes("setActiveTab('documents')") && builderSrc.includes('documentsStatus: docs.status') && builderSrc.includes('useSspDocuments({ enabled: true })') && builderSrc.includes('documents: docs.completenessInput'), 'SD4 the builder opens the Documents page and feeds the documents into the nav and the completeness');
assert(builderSrc.includes('GOVERNANCE DOCUMENTS:') && builderSrc.indexOf('GOVERNANCE DOCUMENTS:') > builderSrc.indexOf('INFORMATION TYPES: ') && builderSrc.indexOf('GOVERNANCE DOCUMENTS:') < builderSrc.indexOf('CLOUD SERVICE PROVIDERS: ') && builderSrc.includes('1.3.2 Governance Documents') && builderSrc.includes('documentsSubsection(docs.snapshot)') && builderSrc.includes('docs.snapshot') && builderSrc.includes('docs.status === \'loading\' ? null : docs.snapshot'), 'SD4b the plain-text copy, the document view and the Markdown download carry 1.3.2 from the shared module');
assert(modalSrc.includes('sspDocuments') && modalSrc.includes("useSspDocuments({ enabled: isOpen && selectedDocType === 'NIST_SP_800_18_SSP' })") && modalSrc.includes('delete next.sspDocuments;') && modalSrc.includes('{ ...next, sspDocuments: documentsSnapshot }') && modalSrc.includes('documents: sspDocs.completenessInput }'), 'SD4c the export modal loads the documents for the SSP only, carries the snapshot like the profile (deleted when none) and passes the completeness input');
assert(modalSrc.includes('Governance documents: ') && modalSrc.includes('could not be loaded, so section 1.3.2 says not available.'), 'SD4d the readiness line says what is loaded');
const readiness = modalSrc.slice(modalSrc.indexOf('data-testid="export-readiness"'), modalSrc.indexOf('{/* Modal Bottom Action Footer */}'));
assert(readiness.length > 0 && !readiness.includes('formData.') && !readiness.includes('disabled=') && !readiness.includes('sspDocs'), 'SD4e the readiness checklist region is untouched');
assert(!/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(|javascript:/.test(sectionSrc), 'SD5 the section logs nothing, touches no browser storage, uses no raw HTML and no alert()');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
