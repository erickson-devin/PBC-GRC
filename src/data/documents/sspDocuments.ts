// What the SSP prints and checks of the document register (#240, #250): section 1.3.2 (Governance documents), the approved documents of the program only,
// with a count of the drafts that are not listed. The compiled SSP, the Markdown export and the on-screen section take their rows from here, so they
// word the same data the same way. Pure: types and the register's view rules only. A value that was never recorded prints as "Not recorded"; nothing here
// touches storage, the network or the console (titles, owners and locations may be CUI).

import type { ReportSubsection } from '../../types/report';
import type { GovernanceDocument, ProgramDocuments, ReviewState } from '../../types/documents';
import type { SspItemStatus } from '../ssp/sspCompleteness';
import { NOT_RECORDED } from '../reports/documentDefaults';
import { DOCUMENT_KIND_LABELS, controlCountsByDocument, documentsInProgram, primarySource, reviewState, sortDocuments } from './documentRegisterView';

export interface SspDocumentRow {
  id: string;
  title: string;
  reference: string;
  kind: GovernanceDocument['kind'];
  version: string;
  approvalDate: string | null;
  reviewBy: string | null;
  reviewState: ReviewState;
  owner: string;
  /** The primary copy: the attached file's name, "File removed", or the internal location; '' when there is none. */
  primary: string;
  controlCount: number;
}

/** The documents as the SSP prints them. */
export interface SspDocumentsSnapshot {
  /** False for a browser-only organization, or when nothing was loaded: the SSP then says the section is not available. */
  supported: boolean;
  /** The approved documents of the program (retired ones left out), by kind then title. */
  rows: SspDocumentRow[];
  /** Drafts of the program: counted, never listed (not yet approved). */
  draftCount: number;
  /** Approved documents whose review-by date has passed. */
  overdueCount: number;
  /** The expected documents present, when the checklist was loaded; null otherwise. */
  expected: { present: number; total: number } | null;
}

export const SSP_DOCUMENT_HEADERS = ['Document', 'Kind', 'Reference', 'Version', 'Approval date', 'Review by', 'Owner', 'Primary copy', 'Connected controls'];

/** What 1.3.2 states for an organization stored only in this browser. */
export const DOCUMENTS_NOT_AVAILABLE = 'Not available: the document register needs a server-backed organization.';
export const NO_APPROVED_DOCUMENTS = 'No approved documents are recorded for this system.';
/** Printed beside a primary copy whose evidence file was deleted after it was attached. */
export const FILE_REMOVED = 'File removed';

const SUBSECTION_TITLE = '1.3.2 Governance documents';
const INTRO = 'The approved governance documents recorded in the Document Register for this system. Draft and retired documents are not listed.';

export const NOT_SUPPORTED_DOCUMENTS: SspDocumentsSnapshot = { supported: false, rows: [], draftCount: 0, overdueCount: 0, expected: null };

interface DocumentSources {
  supported: boolean;
  documents: GovernanceDocument[];
  /** The program's set, links and attachments; null before it is loaded (then every document applies and nothing is linked). */
  program: ProgramDocuments | null;
  /** The program's evidence files (id and file name): resolves a primary attachment to its name and tells a removed file. */
  evidence: { id: string; name: string }[];
  /** YYYY-MM-DD, injected. */
  today: string;
  expected: { present: number; total: number } | null;
}

/**
 * The snapshot the SSP prints: the approved documents of the program (a retired one is not part of it; drafts are only counted). Unsupported gives an
 * empty snapshot with `supported: false`.
 */
export function buildSspDocumentsSnapshot(a: DocumentSources): SspDocumentsSnapshot {
  if (!a.supported) return NOT_SUPPORTED_DOCUMENTS;
  const pd: ProgramDocuments = a.program ?? { programId: '', declared: false, documentIds: [], controlLinks: [], attachments: [], expectations: [] };
  const mine = documentsInProgram(a.documents, pd);
  const live = new Set(a.evidence.map((e) => e.id));
  const nameOf = new Map(a.evidence.map((e) => [e.id, e.name]));
  const counts = controlCountsByDocument(pd.controlLinks);
  const approved = sortDocuments(mine.filter((d) => d.status === 'APPROVED'));
  const rows: SspDocumentRow[] = approved.map((d) => {
    const src = primarySource(d, pd.attachments, live);
    return {
      id: d.id,
      title: d.title,
      reference: d.reference,
      kind: d.kind,
      version: d.version,
      approvalDate: d.approvalDate,
      reviewBy: d.reviewBy,
      reviewState: reviewState(d, a.today),
      owner: d.owner,
      primary: src === null ? '' : src.type === 'attachment' ? (src.missing ? FILE_REMOVED : nameOf.get(src.evidenceId) ?? '') : src.value,
      controlCount: counts[d.id] ?? 0,
    };
  });
  return {
    supported: true,
    rows,
    draftCount: mine.filter((d) => d.status === 'DRAFT').length,
    overdueCount: rows.filter((r) => r.reviewState === 'OVERDUE').length,
    expected: a.expected ? { present: a.expected.present, total: a.expected.total } : null,
  };
}

const orNotRecorded = (v: string | null | undefined): string => (typeof v === 'string' && v.trim() !== '' ? v : NOT_RECORDED);

/** 1.3.2: one row per approved document, headers SSP_DOCUMENT_HEADERS; a blank value prints "Not recorded". */
export function sspDocumentTableRows(s: SspDocumentsSnapshot): string[][] {
  return s.rows.map((r) => [
    r.title,
    DOCUMENT_KIND_LABELS[r.kind],
    orNotRecorded(r.reference),
    orNotRecorded(r.version),
    orNotRecorded(r.approvalDate),
    orNotRecorded(r.reviewBy),
    orNotRecorded(r.owner),
    orNotRecorded(r.primary),
    String(r.controlCount),
  ]);
}

/** "n draft documents are not listed (not yet approved)." or '' for none. */
export function draftNote(draftCount: number): string {
  if (draftCount <= 0) return '';
  return draftCount === 1 ? '1 draft document is not listed (not yet approved).' : `${draftCount} draft documents are not listed (not yet approved).`;
}

/** The sentence about the expected documents checklist, '' when it was not loaded. */
export function expectedLine(s: SspDocumentsSnapshot): string {
  return s.expected ? `${s.expected.present} of ${s.expected.total} expected documents are present.` : '';
}

/** 1.3.2 Governance documents. Unsupported: a single "not available" text. */
export function documentsSubsection(s: SspDocumentsSnapshot): ReportSubsection {
  if (!s.supported) return { title: SUBSECTION_TITLE, content: DOCUMENTS_NOT_AVAILABLE };
  const notes = [draftNote(s.draftCount), expectedLine(s)].filter((n) => n !== '');
  if (s.rows.length === 0) return { title: SUBSECTION_TITLE, content: [NO_APPROVED_DOCUMENTS, ...notes].join(' ') };
  return { title: SUBSECTION_TITLE, content: [INTRO, ...notes].join(' '), table: { headers: SSP_DOCUMENT_HEADERS, rows: sspDocumentTableRows(s) } };
}

const mdCell = (v: string): string => v.replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|');
const mdTable = (headers: string[], rows: string[][]): string =>
  `| ${headers.map(mdCell).join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`).join('\n')}\n`;

/** The Markdown of 1.3.2 (the same rows as the compiled SSP), ending with a blank line; goes between 1.3.1 and 1.4 in the Markdown SSP. */
export function sspDocumentsMarkdown(s: SspDocumentsSnapshot): string {
  const md = `### ${SUBSECTION_TITLE}\n\n`;
  if (!s.supported) return `${md}${DOCUMENTS_NOT_AVAILABLE}\n\n`;
  const notes = [draftNote(s.draftCount), expectedLine(s)].filter((n) => n !== '');
  if (s.rows.length === 0) return `${md}${[NO_APPROVED_DOCUMENTS, ...notes].join(' ')}\n\n`;
  return `${md}${[INTRO, ...notes].join(' ')}\n\n${mdTable(SSP_DOCUMENT_HEADERS, sspDocumentTableRows(s))}\n`;
}

// ---------------------------------------------------------------------------------------------------------------- completeness

/** What the completeness check needs of the register (all of it advisory: the expected-documents checklist is where the gaps live). */
export interface SspDocumentsCompletenessInput {
  /** False for a browser-only organization or while nothing is loaded: section 1.3.2 is then "not available" and counts for nothing. */
  supported: boolean;
  approvedCount: number;
  overdueCount: number;
  expected: { present: number; total: number } | null;
}

/** The completeness input of the snapshot the SSP prints. */
export function buildSspDocumentsCompletenessInput(s: SspDocumentsSnapshot): SspDocumentsCompletenessInput {
  return { supported: s.supported, approvedCount: s.rows.length, overdueCount: s.overdueCount, expected: s.expected };
}

/**
 * The items of section 1.3.2 (the same shape as the other completeness items; none has a `reportField`). Every one is advisory, whatever the framework:
 * at least one approved document, no approved document past its review date, and (when the checklist was loaded) every expected document present.
 * Nothing for an unsupported input.
 */
export function documentCompletenessItems(_framework: string, inv: SspDocumentsCompletenessInput): SspItemStatus[] {
  if (!inv.supported) return [];
  const items: SspItemStatus[] = [
    { id: 'documents:approved', sectionId: 'documents', label: 'At least one approved governance document', severity: 'advisory', missing: inv.approvedCount < 1 },
    { id: 'documents:overdue', sectionId: 'documents', label: 'No approved document is past its review date', severity: 'advisory', missing: inv.overdueCount > 0 },
  ];
  if (inv.expected) {
    items.push({ id: 'documents:expected', sectionId: 'documents', label: `Expected documents present (${inv.expected.present} of ${inv.expected.total})`, severity: 'advisory', missing: inv.expected.present < inv.expected.total });
  }
  return items;
}
