import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCUMENT_UI_TEXT,
  KIND_LABELS,
  addYearsIso,
  approvalWillClear,
  approveFormFrom,
  attachLinkFailedText,
  attachmentRows,
  declareDocumentsText,
  docAriaSort,
  docCountCaption,
  docEmptyMessage,
  documentErrorMessage,
  documentFormFrom,
  generatedDraftFileName,
  kindCounts,
  locationMessage,
  membershipRemoveText,
  needsReviewConfirmation,
  primaryCell,
  primaryLabelMap,
  rebaseDocumentForm,
  registerCsvFileName,
  removeDocumentConfirmText,
  reviewChip,
  sortDocs,
  statusChip,
  statusMatches,
  summaryCounts,
  summaryLine,
  undeclaredDocumentsNote,
  unlinkAttachmentText,
  uploadControlChoices,
  validateApproveForm,
  validateDocumentForm,
  type StatusFilter,
} from '../src/data/documents/documentUiView';
import { sortDocuments } from '../src/data/documents/documentRegisterView';
import { DocumentLocation } from '../src/components/documents/DocumentLocation';
import { requestDocumentFocus, takeDocumentFocus } from '../src/components/documents/documentFocus';
import type { DocumentAttachment, GovernanceDocument } from '../src/types/documents';

/** The Document Register screens: their pure view logic (chips, sort, forms, merge, error texts) and the location component rendered on the server, plus source checks. */
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

console.log('--- DU1 statusChip ---');
{
  const a = statusChip({ status: 'DRAFT', origin: 'MANUAL' });
  const g = statusChip({ status: 'DRAFT', origin: 'GENERATED' });
  const ai = statusChip({ status: 'DRAFT', origin: 'AI_ASSISTED' });
  const ap = statusChip({ status: 'APPROVED', origin: 'GENERATED' });
  const r = statusChip({ status: 'RETIRED', origin: 'MANUAL' });
  assert(a.tone === 'amber' && a.text === 'Draft' && !a.untrusted, 'DU1a: a manual draft is amber "Draft"');
  assert(g.tone === 'amber' && g.text === 'Draft: generated text, needs review' && g.untrusted, 'DU1b: a generated draft is untrusted');
  assert(ai.tone === 'amber' && ai.text === 'Draft: AI-assisted, needs review' && ai.untrusted, 'DU1c: an AI-assisted draft is untrusted');
  assert(ap.tone === 'emerald' && ap.text === 'Approved' && !ap.untrusted, 'DU1d: approved is emerald and trusted whatever the origin');
  assert(r.tone === 'slate' && r.text === 'Retired' && !r.untrusted, 'DU1e: retired is slate');
}

console.log('--- DU2 reviewChip ---');
{
  const at = (reviewBy: string | null, status: GovernanceDocument['status'] = 'APPROVED') => reviewChip({ status, reviewBy }, TODAY);
  assert(at('2026-11-18')?.tone === 'rose' && at('2026-11-18')?.text === 'Review overdue', 'DU2a: yesterday is overdue (rose)');
  assert(at('2026-11-19')?.text === 'Review due today' && at('2026-11-19')?.tone === 'amber', 'DU2b: today is due today');
  assert(at('2026-11-20')?.text === 'Review due in 1 day', 'DU2c: tomorrow is "1 day"');
  assert(at('2026-12-19')?.text === 'Review due in 30 days', 'DU2d: 30 days ahead is still due soon');
  assert(at('2026-12-20') === null, 'DU2e: 31 days ahead shows no chip');
  assert(at(null)?.tone === 'slate' && at(null)?.text === 'No review date', 'DU2f: no date is a slate "No review date"');
  assert(at('2026-11-01', 'RETIRED') === null && at(null, 'RETIRED') === null, 'DU2g: a retired document has no review chip');
}

console.log('--- DU3 summaryCounts / summaryLine ---');
{
  assert(summaryLine({ drafts: 0, needsReview: 0, overdue: 0, dueSoon: 0 }) === null, 'DU3a: all zero gives null');
  assert(summaryLine({ drafts: 2, needsReview: 0, overdue: 1, dueSoon: 0 }) === '2 drafts · 1 review overdue', 'DU3b: the non-zero parts are joined');
  assert(summaryLine({ drafts: 1, needsReview: 0, overdue: 0, dueSoon: 3 }) === '1 draft · 3 due within 30 days', 'DU3c: singular draft and the due-soon part');
  const docs = [
    doc({ id: 'a', status: 'DRAFT', origin: 'GENERATED' }),
    doc({ id: 'b', status: 'DRAFT' }),
    doc({ id: 'c', status: 'APPROVED', reviewBy: '2026-11-01' }),
    doc({ id: 'd', status: 'APPROVED', reviewBy: '2026-11-25' }),
    doc({ id: 'e', status: 'RETIRED', reviewBy: '2026-11-01' }),
  ];
  const c = summaryCounts(docs, TODAY);
  assert(c.drafts === 2 && c.needsReview === 1 && c.overdue === 1 && c.dueSoon === 1, 'DU3d: counts exclude the retired document', c);
}

console.log('--- DU4 sortDocs ---');
{
  const docs = [
    doc({ id: 'a', title: 'beta', kind: 'PROCEDURE', reviewBy: '2026-12-01' }),
    doc({ id: 'b', title: 'Alpha', kind: 'POLICY', reviewBy: null }),
    doc({ id: 'c', title: 'gamma', kind: 'PLAN', reviewBy: '2026-11-01' }),
    doc({ id: 'd', title: 'delta', kind: 'POLICY', reviewBy: '2027-01-01' }),
  ];
  const ids = (l: GovernanceDocument[]): string => l.map((d) => d.id).join(',');
  assert(ids(sortDocs(docs, 'kind', 'asc')) === ids(sortDocuments(docs)), 'DU4a: kind ascending is the register order');
  assert(ids(sortDocs(docs, 'kind', 'desc')) === 'a,b,d,c', 'DU4b: kind descending reverses the kinds and keeps the titles ascending', ids(sortDocs(docs, 'kind', 'desc')));
  assert(ids(sortDocs(docs, 'reviewBy', 'asc')) === 'c,a,d,b', 'DU4c: review date ascending puts the missing date last', ids(sortDocs(docs, 'reviewBy', 'asc')));
  assert(ids(sortDocs(docs, 'reviewBy', 'desc')) === 'd,a,c,b', 'DU4d: review date descending also puts the missing date last', ids(sortDocs(docs, 'reviewBy', 'desc')));
  assert(ids(sortDocs(docs, 'title', 'asc')) === 'b,a,d,c' && ids(sortDocs(docs, 'title', 'desc')) === 'c,d,a,b', 'DU4e: title sorts without regard to case');
  assert(docAriaSort('title', 'title', 'desc') === 'descending' && docAriaSort('title', 'title', 'asc') === 'ascending' && docAriaSort('kind', 'title', 'asc') === 'none', 'DU4f: aria-sort');
  const before = ids(docs);
  sortDocs(docs, 'title', 'desc');
  assert(ids(docs) === before, 'DU4g: the input array is not reordered');
}

console.log('--- DU5 captions and filters ---');
{
  assert(docCountCaption(1, 1) === '1 document' && docCountCaption(12, 12) === '12 documents' && docCountCaption(3, 12) === '3 of 12 documents', 'DU5a: the count captions');
  const docs = [doc({ id: 'a', kind: 'POLICY' }), doc({ id: 'b', kind: 'PLAN', status: 'APPROVED' }), doc({ id: 'c', kind: 'PLAN', status: 'RETIRED' })];
  const cur = kindCounts(docs, 'CURRENT');
  assert(cur.ALL === 2 && cur.PLAN === 1 && cur.POLICY === 1, 'DU5b: the default filter excludes retired documents', cur);
  const all = kindCounts(docs, 'ALL');
  assert(all.ALL === 3 && all.PLAN === 2, 'DU5c: ALL counts every status');
  const filters: StatusFilter[] = ['CURRENT', 'DRAFT', 'APPROVED', 'RETIRED', 'ALL'];
  const matrix = filters.map((f) => docs.filter((d) => statusMatches(d, f)).map((d) => d.id).join(''));
  assert(matrix.join('|') === 'ab|a|b|c|abc', 'DU5d: statusMatches for the five filters', matrix);
  assert(docEmptyMessage({ total: 0, canEdit: true }) === DOCUMENT_UI_TEXT.emptyEditor && docEmptyMessage({ total: 0, canEdit: false }) === DOCUMENT_UI_TEXT.emptyReader && docEmptyMessage({ total: 3, canEdit: true }) === DOCUMENT_UI_TEXT.emptyFiltered, 'DU5e: the empty messages');
}

console.log('--- DU6 locationMessage ---');
{
  const script = locationMessage(['java', 'script:alert(1)'].join(''));
  assert(script.error !== null && script.error.includes('Other kinds of links are not accepted') && script.recognised === null, 'DU6a: a script scheme gets the scheme text');
  assert(locationMessage('https://u:p@intranet.example/x').error === 'Remove the user name and password from the address. Never store credentials here.', 'DU6b: credentials are refused with the credentials text');
  const unc = locationMessage('\\\\fs01\\Compliance\\a.docx');
  assert(unc.error === null && unc.recognised !== null && unc.recognised.includes('file share path'), 'DU6c: a UNC path is recognised', unc);
  const http = locationMessage('https://intranet.example/policies/ac.docx');
  assert(http.error === null && (http.recognised ?? '').includes('opens in a new tab'), 'DU6d: an https address is recognised as a link');
  assert(locationMessage('').error === null && locationMessage('').recognised === null && locationMessage('   ').error === null, 'DU6e: blank is fine and says nothing');
  assert(locationMessage('x'.repeat(2049)).error === 'Use 2,048 characters or fewer.', 'DU6f: too long');
  assert(locationMessage('S:\\Policies\\ac.docx').recognised?.includes('drive path') === true, 'DU6g: a drive path is recognised');
}

console.log('--- DU7 validateDocumentForm ---');
{
  const good = documentFormFrom(null, { title: 'Incident Response Plan', kind: 'PLAN' });
  assert(validateDocumentForm({ ...good, title: '   ' }, 'add').errors.title === 'Enter the document title.', 'DU7a: a blank title is refused');
  assert(validateDocumentForm({ ...good, kind: '' }, 'add').errors.kind === 'Choose the kind of document.', 'DU7b: no kind is refused');
  const edit = validateDocumentForm({ ...good, aiAssisted: true }, 'edit');
  assert(edit.input !== null && !('origin' in edit.input), 'DU7c: edit mode never sends origin');
  const add = validateDocumentForm({ ...good, aiAssisted: true }, 'add');
  assert(add.input?.origin === 'AI_ASSISTED', 'DU7d: add mode sends AI_ASSISTED when ticked');
  assert(validateDocumentForm(good, 'add').input !== null && !('origin' in (validateDocumentForm(good, 'add').input ?? {})), 'DU7e: no origin when not ticked');
  assert(validateDocumentForm(good, 'add').input?.locationUrl === null && validateDocumentForm(good, 'add').input?.reviewBy === null, 'DU7f: a blank location and review date are sent as null');
  assert(validateDocumentForm({ ...good, reviewBy: '2026-02-30' }, 'add').errors.reviewBy === 'Enter a real date (YYYY-MM-DD), or leave it blank.', 'DU7g: an unreal review date is refused');
  assert(validateDocumentForm({ ...good, locationUrl: 'ftp://x/y' }, 'add').errors.locationUrl !== undefined, 'DU7h: an unsupported location is refused');
  assert(validateDocumentForm({ ...good, title: 'x'.repeat(256) }, 'add').errors.title === 'Use 255 characters or fewer.', 'DU7i: a long title');
  assert(validateDocumentForm({ ...good, notes: 'x'.repeat(4001) }, 'add').errors.notes === 'Use 4,000 characters or fewer.', 'DU7j: long notes');
  const padded = validateDocumentForm({ ...good, title: '  Plan  ', reference: ' R1 ', owner: ' ISSO ' }, 'add').input;
  assert(padded?.title === 'Plan' && padded?.reference === 'R1' && padded?.owner === 'ISSO', 'DU7k: values are trimmed');
}

console.log('--- DU8 approvalWillClear ---');
{
  const approved = doc({ status: 'APPROVED', version: '1.0', owner: 'ISSO', locationUrl: 'S:\\a.docx', approvalDate: '2026-11-01' });
  const base = documentFormFrom(approved);
  assert(!approvalWillClear(approved, { ...base, owner: 'CISO' }), 'DU8a: changing the owner keeps the approval');
  assert(approvalWillClear(approved, { ...base, version: '1.1' }), 'DU8b: changing the version clears it');
  assert(approvalWillClear(approved, { ...base, title: 'Other title' }) && approvalWillClear(approved, { ...base, kind: 'PLAN' }) && approvalWillClear(approved, { ...base, locationUrl: 'S:\\b.docx' }), 'DU8c: title, kind and location clear it too');
  assert(!approvalWillClear(approved, base), 'DU8d: an unchanged form clears nothing');
  assert(!approvalWillClear(doc({ status: 'DRAFT', version: '1.0' }), { ...base, version: '2.0' }) && !approvalWillClear(null, base), 'DU8e: a draft or a new document has no approval to clear');
}

console.log('--- DU9 rebaseDocumentForm ---');
{
  const oldBase = doc({ owner: 'ISSO', version: '1.0', notes: '' });
  const newBase = doc({ owner: 'CISO', version: '1.1', notes: 'new note' });
  const form = { ...documentFormFrom(oldBase), notes: 'my note' };
  const merged = rebaseDocumentForm(oldBase, newBase, form);
  assert(merged.form.owner === 'CISO' && merged.form.version === '1.1', 'DU9a: an untouched field takes the server value');
  assert(merged.form.notes === 'my note' && merged.conflicts.join() === 'notes', 'DU9b: a field both changed keeps the person value and is a conflict', merged.conflicts);
  const both = rebaseDocumentForm(oldBase, newBase, { ...documentFormFrom(oldBase), owner: 'Director' });
  assert(both.conflicts.join() === 'owner' && both.form.owner === 'Director', 'DU9c: both changing owner differently conflicts on owner');
  const same = rebaseDocumentForm(oldBase, newBase, { ...documentFormFrom(oldBase), owner: 'CISO' });
  assert(same.conflicts.length === 0, 'DU9d: both changing to the same value is no conflict');
}

console.log('--- DU10 validateApproveForm ---');
{
  const ok = { version: '1.0', approvalDate: '2026-11-19', reviewBy: '2027-11-19', reviewed: false };
  assert(validateApproveForm({ ...ok, version: ' ' }, TODAY, false).errors.version === 'Enter the version you are approving, such as 1.0.', 'DU10a: a blank version');
  assert((validateApproveForm({ ...ok, approvalDate: '2026-11-20' }, TODAY, false).errors.approvalDate ?? '').includes('cannot be in the future'), 'DU10b: tomorrow is refused');
  assert(validateApproveForm({ ...ok, approvalDate: '' }, TODAY, false).errors.approvalDate === 'Enter the approval date (YYYY-MM-DD).', 'DU10c: a blank approval date');
  assert(validateApproveForm({ ...ok, reviewBy: '2026-11-01' }, TODAY, false).errors.reviewBy === 'The review date must be on or after the approval date.', 'DU10d: a review date before the approval');
  assert(validateApproveForm(ok, TODAY, true).errors.reviewed === DOCUMENT_UI_TEXT.reviewedRequired, 'DU10e: untrusted text without the tick');
  const confirmed = validateApproveForm({ ...ok, reviewed: true }, TODAY, true);
  assert(confirmed.value?.confirmReviewed === true, 'DU10f: with the tick the confirmation is sent');
  const manual = validateApproveForm({ ...ok, reviewed: true }, TODAY, false);
  assert(manual.value !== null && !('confirmReviewed' in manual.value), 'DU10g: a manual document never sends the confirmation');
  assert(validateApproveForm({ ...ok, reviewBy: '' }, TODAY, false).value?.reviewBy === null, 'DU10h: a blank review date is sent as null');
  assert(needsReviewConfirmation({ origin: 'GENERATED' }) && needsReviewConfirmation({ origin: 'AI_ASSISTED' }) && !needsReviewConfirmation({ origin: 'MANUAL' }), 'DU10i: only generated and AI text needs the confirmation');
  const f = approveFormFrom(doc({ version: '2.0', reviewBy: '2027-01-01' }), TODAY);
  assert(f.version === '2.0' && f.approvalDate === TODAY && f.reviewBy === '2027-01-01' && f.reviewed === false, 'DU10j: the approval form starts from the document and today');
}

console.log('--- DU11 addYearsIso ---');
assert(addYearsIso('2026-11-19', 1) === '2027-11-19', 'DU11a: one year later');
assert(addYearsIso('2028-02-29', 1) === '2029-02-28', 'DU11b: 29 February becomes 28 February');
assert(addYearsIso('2028-02-29', 4) === '2032-02-29', 'DU11c: a leap year stays 29 February');

console.log('--- DU12 documentErrorMessage ---');
{
  const e = (status: number, reason?: string) => ({ name: 'ApiError', status, reason, message: 'MARK' });
  const dup = documentErrorMessage(e(409, 'duplicate_title'), 'save');
  assert(dup.includes('already has this title') && !dup.includes('MARK'), 'DU12a: duplicate title, and never the server message');
  assert(documentErrorMessage(e(409, 'not_reviewed'), 'approve').includes('confirm that you reviewed'), 'DU12b: not_reviewed');
  assert(documentErrorMessage(e(409, 'document_not_in_program'), 'links', 'Alpha').includes('not in Alpha') && documentErrorMessage(e(409, 'document_not_in_program'), 'links').includes('this program'), 'DU12c: document_not_in_program names the program');
  assert(documentErrorMessage(e(403), 'save').includes('Tenant Owner or Admin'), 'DU12d: 403');
  assert(documentErrorMessage(e(0), 'save').includes('could not be reached'), 'DU12e: network failure');
  assert(documentErrorMessage(e(429, 'limit'), 'links').includes('most links') && documentErrorMessage(e(429, 'limit'), 'save') === DOCUMENT_UI_TEXT.limitReached, 'DU12f: limit differs for links and for the register');
  assert(documentErrorMessage(e(409, 'stale_write'), 'save') === DOCUMENT_UI_TEXT.staleDocument && documentErrorMessage(e(409, 'stale_write'), 'links') === DOCUMENT_UI_TEXT.linksStale, 'DU12g: stale_write per action');
  assert(documentErrorMessage(e(400, 'invalid_location'), 'save').includes('Other kinds of links are not accepted'), 'DU12h: invalid_location');
  assert(documentErrorMessage(e(409, 'duplicate_seed'), 'register').includes('already in the register'), 'DU12i: duplicate_seed');
  assert(documentErrorMessage(e(409, 'retired'), 'approve').includes('Reinstate'), 'DU12j: retired');
  assert(documentErrorMessage(e(400), 'save').includes('did not accept these values'), 'DU12k: a plain 400');
  assert(documentErrorMessage(e(500), 'delete') === 'The document could not be removed. Try again.' && documentErrorMessage(null, 'primary') === 'The primary copy could not be changed. Try again.', 'DU12l: the default per action');
  assert(documentErrorMessage(e(409, 'program_archived'), 'links').endsWith('Nothing was saved.'), 'DU12m: archived program');
  assert(documentErrorMessage(e(404, 'inherited_evidence'), 'attach').includes('Choose the original file'), 'DU12n: inherited evidence');
}

console.log('--- DU13 removeDocumentConfirmText and the program texts ---');
{
  const unknown = removeDocumentConfirmText(null);
  assert(unknown.includes('could not be checked'), 'DU13a: usage unknown');
  assert(removeDocumentConfirmText({ programs: 0, controlLinks: 0, attachments: 0, expectations: 0 }).includes('no control links, files or checklist links'), 'DU13b: unused');
  const used = removeDocumentConfirmText({ programs: 2, controlLinks: 5, attachments: 1, expectations: 0 });
  assert(used.includes('In 2 programs') && used.includes('5 control links, 1 file link and 0 checklist links'), 'DU13c: counts', used);
  const secret = 'SECRET-TITLE';
  const texts = [unknown, used, undeclaredDocumentsNote('Alpha', 3), declareDocumentsText('Alpha', 3, 1), membershipRemoveText('Alpha', { controlLinks: 1, attachments: 2, expectations: 0 }), unlinkAttachmentText(true)];
  assert(texts.every((t) => !t.includes(secret)), 'DU13d: no text takes a title');
  assert(declareDocumentsText('Alpha', 3, 1).includes('declares 1 document, and its SSP lists only that one'), 'DU13e: declare text');
  assert(membershipRemoveText('Alpha', { controlLinks: 1, attachments: 2, expectations: 0 }).includes('1 control link, 2 file links and 0 checklist links in Alpha'), 'DU13f: membership remove text');
  assert(undeclaredDocumentsNote('Alpha', 3) === 'Alpha has not declared its documents: its SSP lists every approved document in the register (3).', 'DU13g: undeclared note');
}

console.log('--- DU14 attachmentRows ---');
{
  const atts: DocumentAttachment[] = [
    { documentId: 'd1', evidenceId: 'e-b', isPrimary: false, linkedAt: '2026-11-01', linkedBy: null },
    { documentId: 'd1', evidenceId: 'e-a', isPrimary: true, linkedAt: '2026-11-01', linkedBy: null },
    { documentId: 'd1', evidenceId: 'e-gone', isPrimary: false, linkedAt: '2026-11-01', linkedBy: null },
    { documentId: 'd2', evidenceId: 'e-other', isPrimary: true, linkedAt: '2026-11-01', linkedBy: null },
  ];
  const ev = [
    { id: 'e-a', name: 'zeta.pdf', controlId: 'AC-1', uploadedAt: '2026-11-02T00:00:00Z' },
    { id: 'e-b', name: 'alpha.pdf', controlId: 'AC-2', uploadedAt: '2026-11-03T00:00:00Z' },
  ];
  const rows = attachmentRows(atts, 'd1', ev);
  assert(rows.length === 3 && rows[0].evidenceId === 'e-a' && rows[0].isPrimary, 'DU14a: the primary comes first and other documents are left out', rows.map((r) => r.evidenceId));
  assert(rows[1].evidenceId === 'e-gone' || rows[1].evidenceId === 'e-b', 'DU14b: the rest follow');
  const gone = rows.find((r) => r.evidenceId === 'e-gone');
  assert(gone?.missing === true && gone.name === null && gone.controlId === null, 'DU14c: an unknown file is missing with no name');
  assert(unlinkAttachmentText(true).includes('primary copy') && !unlinkAttachmentText(false).includes('primary copy'), 'DU14d: the unlink text mentions the primary copy only for the primary');
  assert(attachLinkFailedText('AC.L1-3.1.1').includes('AC.L1-3.1.1') && attachLinkFailedText('X').includes('A file already in the Evidence Vault'), 'DU14e: the failed-link text names the control and the way out');
  const choices = uploadControlChoices([{ documentId: 'd1', controlId: 'B-2' }, { documentId: 'd1', controlId: 'A-1' }, { documentId: 'd1', controlId: 'A-1' }, { documentId: 'd2', controlId: 'C-3' }], 'd1', (id) => id, { 'A-1': 'First', 'B-2': 'Second' });
  assert(choices.map((c) => c.id).join() === 'A-1,B-2' && choices[0].label === 'A-1 First', 'DU14f: upload controls are this document\'s linked controls, sorted, once each', choices);
  const live = new Set(['e-a']);
  const d = doc({ id: 'd1', locationUrl: 'S:\\fallback.docx' });
  assert(primaryCell(null, {}).kind === 'none', 'DU14g: no primary copy');
  assert(primaryCell({ type: 'attachment', evidenceId: 'e-a', missing: false }, { 'e-a': 'zeta.pdf' }).text === 'zeta.pdf', 'DU14h: a live file shows its name');
  assert(primaryCell({ type: 'attachment', evidenceId: 'e-x', missing: true }, {}).kind === 'removed', 'DU14i: a removed file');
  assert(primaryCell({ type: 'location', kind: 'drive', value: 'S:\\a' }, {}).kind === 'location', 'DU14j: a location');
  const labels = primaryLabelMap([d, doc({ id: 'd2' }), doc({ id: 'd3' })], [{ documentId: 'd1', evidenceId: 'e-a', isPrimary: true, linkedAt: 'x', linkedBy: null }, { documentId: 'd3', evidenceId: 'e-x', isPrimary: true, linkedAt: 'x', linkedBy: null }], ev, live);
  assert(labels.d1 === 'zeta.pdf' && labels.d2 === '' && labels.d3 === 'File removed', 'DU14k: the CSV labels', labels);
}

console.log('--- DU15 file names ---');
assert(generatedDraftFileName({ family: 'AC' }, TODAY) === 'ac-policy-draft-2026-11-19.md', 'DU15a: the generated draft file name');
assert(registerCsvFileName(TODAY) === 'document-register-2026-11-19.csv', 'DU15b: the register CSV file name');
assert(!generatedDraftFileName({ family: 'AC' }, TODAY).toLowerCase().includes('cage'), 'DU15c: no organization data in the name');
assert(Object.keys(KIND_LABELS).length === 7, 'DU15d: every kind has a label');

console.log('--- DU16 DocumentLocation (rendered) ---');
{
  const http = renderToStaticMarkup(React.createElement(DocumentLocation, { value: 'https://intranet.example/a' }));
  assert(http.includes('target="_blank"') && http.includes('rel="noopener noreferrer"') && /referrerPolicy|referrerpolicy/.test(http) && http.includes('no-referrer') && http.includes('href="https://intranet.example/a"'), 'DU16a: an https address is a link that opens in a new tab with no referrer', http);
  const unc = renderToStaticMarkup(React.createElement(DocumentLocation, { value: '\\\\fs01\\x' }));
  assert(unc.includes('<code') && !unc.includes('<a ') && unc.includes('File share path') && unc.includes('Copy the location'), 'DU16b: a UNC path is text with a Copy button', unc);
  const script = renderToStaticMarkup(React.createElement(DocumentLocation, { value: ['java', 'script:alert(1)'].join('') }));
  assert(!script.includes('href') && script.includes('<code'), 'DU16c: a script address is never a link', script);
  const file = renderToStaticMarkup(React.createElement(DocumentLocation, { value: 'file://fs01/share/a.docx' }));
  assert(!file.includes('<a ') && file.includes('file:// address'), 'DU16d: a file:// address is text');
  const compact = renderToStaticMarkup(React.createElement(DocumentLocation, { value: 'S:\\Policies\\ac.docx', compact: true }));
  assert(!compact.includes('Drive path') && compact.includes('truncate'), 'DU16e: compact drops the explanation');
}

console.log('--- DU17 DocumentLocation source ---');
{
  const src = readSrc('src/components/documents/DocumentLocation.tsx');
  assert(src.includes('safeLinkHref('), 'DU17a: the link target comes from safeLinkHref');
  assert(!src.includes('fetch(') && !src.includes('<img') && !src.toLowerCase().includes('prefetch'), 'DU17b: nothing is fetched, no image, no prefetch');
  assert((src.match(/href=/g) ?? []).length === 1 && src.includes('href={href}'), 'DU17c: href={href} is the only href');
}

console.log('--- DU18 ApproveDocumentDialog source ---');
{
  const src = readSrc('src/components/documents/ApproveDocumentDialog.tsx');
  assert(src.includes('reviewedLabel'), 'DU18a: the review confirmation is labelled');
  assert(!src.includes('confirmReviewed'), 'DU18b: the confirmation flag only comes from validateApproveForm');
  assert(src.includes('validateApproveForm(') && src.includes('z-[60]') && src.includes('max-h-['), 'DU18c: validated, stackable and capped');
  assert(src.includes('approverLine'), 'DU18d: the approver line is shown');
}

console.log('--- DU19 GeneratedDraftPreview source ---');
{
  const src = readSrc('src/components/documents/GeneratedDraftPreview.tsx');
  assert(src.includes('generatedBadge') && src.includes('border-dashed'), 'DU19a: the badge and the dashed border');
  assert(!src.includes('uploadEvidence') && !src.includes('create(') && !src.includes('fetch('), 'DU19b: nothing is uploaded, created or fetched');
  assert(src.includes('renderGeneratedDraft(') && src.includes('useMemo'), 'DU19c: the text is rendered live');
}

console.log('--- DU20 DocumentAttachmentsDialog source ---');
{
  const src = readSrc('src/components/documents/DocumentAttachmentsDialog.tsx');
  const at = src.indexOf('uploadEvidence(controlId');
  const call = at >= 0 ? src.slice(at, src.indexOf(');', at) + 2) : '';
  assert(at >= 0 && call.includes("'Governance document'") && !call.includes('doc.title') && !call.includes('.title'), 'DU20a: the upload description is the fixed text, never the title', call);
  assert(src.includes('<EvidenceAttachFieldset'), 'DU20b: the shared attach fieldset');
  assert(src.includes("e.id.includes('__inh_')"), 'DU20c: copies shared from another control are not offered');
}

console.log('--- DU21 DocumentRegisterPanel source ---');
{
  const src = readSrc('src/components/documents/DocumentRegisterPanel.tsx');
  assert(src.includes('documentRegisterCsv(') && src.includes('takeDocumentFocus(') && src.includes('aria-sort=') && src.includes('role="status"'), 'DU21a: CSV, focus hand-off, aria-sort and status');
  assert(!src.includes('setActiveFramework'), 'DU21b: the panel never changes the framework');
  assert(src.includes('<DocumentDialog') && src.includes('<ApproveDocumentDialog') && src.includes('<DocumentControlsEditor') && src.includes('<DocumentAttachmentsDialog') && src.includes('<GeneratedDraftPreview'), 'DU21c: every dialog is mounted');
  assert(!src.includes('uploadEvidence('), 'DU21d: the panel never uploads');
}

console.log('--- DU22 privacy and the dialog cap ---');
{
  const dir = 'src/components/documents';
  const files = readdirSync(join(process.cwd(), dir)).map((f) => `${dir}/${f}`).concat('src/data/documents/documentUiView.ts');
  const own = files.filter((f) => !/(ExpectedDocumentsPanel|DocumentsPage|expectedChecklistView|SspDocumentsSection)/.test(f));
  assert(own.length >= 9, 'DU22a: the scan sees the files', own);
  const leaks = own.filter((f) => /console\.|localStorage|sessionStorage|dangerouslySetInnerHTML/.test(readSrc(f)));
  assert(leaks.length === 0, 'DU22b: no console, browser storage or raw HTML', leaks);
  const uncapped: string[] = [];
  for (const f of own) {
    const s = readSrc(f);
    for (let at = s.indexOf('<DialogOverlay'); at >= 0; at = s.indexOf('<DialogOverlay', at + 1)) {
      const window = s.slice(at, at + 900);
      if (!window.includes('max-h-[') && !window.includes('my-auto')) uncapped.push(f);
    }
  }
  assert(uncapped.length === 0, 'DU22c: every dialog is height-capped', uncapped);
  const lit = ['java', 'script:'].join('');
  const withScheme = own.filter((f) => readSrc(f).toLowerCase().includes(lit));
  assert(withScheme.length === 0, 'DU22d: the script-scheme literal is nowhere in these files', withScheme);
  const wording = own.filter((f) => /Tenant Owner (or|\/|and) MSP Admin/i.test(readSrc(f)));
  assert(wording.length === 0, 'DU22e: the role wording is "a Tenant Owner or Admin"', wording);
}

console.log('--- DU23 focus hand-off ---');
{
  requestDocumentFocus('doc-1');
  assert(takeDocumentFocus() === 'doc-1' && takeDocumentFocus() === null, 'DU23a: the focus request is taken once');
}

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
