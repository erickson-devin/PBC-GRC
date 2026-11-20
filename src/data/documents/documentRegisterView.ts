// What the document register screens, the CSV and the SSP show of the documents (#240). Pure: types, the location rules and the one "present" rule
// (expectedDocuments.ts) only. "Today" is always injected (YYYY-MM-DD); nothing here reads the clock, storage or the network, and no value is logged
// (titles, owners, locations and notes may be CUI).

import {
  DOCUMENT_KINDS,
  REVIEW_DUE_SOON_DAYS,
  type DocumentAttachment,
  type DocumentKind,
  type DocumentStatus,
  type GovernanceDocument,
  type ProgramDocuments,
  type ReviewState,
} from '../../types/documents';
import { classifyLocation, isRealDate, type LocationKind } from './documentSchema';
import { hasUsableCopy } from './expectedDocuments';

/** The plain-language name of each kind, as the register, the CSV and the SSP word it. */
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  PLAN: 'Plan',
  POLICY: 'Policy',
  PROCEDURE: 'Procedure',
  PROCESS: 'Process or worksheet',
  REFERENCE: 'Reference document',
  REVIEW_ASSESSMENT: 'Review or assessment',
  ARTIFACT: 'Artifact or record',
};

/** The plain-language name of each review state. */
export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  NOT_SET: 'Not set',
  OVERDUE: 'Overdue',
  DUE_SOON: 'Due within 30 days',
  CURRENT: 'Current',
  NOT_APPLICABLE: 'Not applicable',
};

const DAY_MS = 86_400_000;

const utcDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/** Whole calendar days from `today` to `date` (both YYYY-MM-DD, UTC calendar days): negative when the date has passed. NaN for a value that is not a real date. */
export function daysUntil(today: string, date: string): number {
  if (!isRealDate(today) || !isRealDate(date)) return Number.NaN;
  return utcDay(date) - utcDay(today);
}

/** RETIRED: not applicable; no date: not set; before today: overdue; today up to `windowDays` ahead: due soon; later: current. */
export function reviewState(d: Pick<GovernanceDocument, 'status' | 'reviewBy'>, today: string, windowDays: number = REVIEW_DUE_SOON_DAYS): ReviewState {
  if (d.status === 'RETIRED') return 'NOT_APPLICABLE';
  if (!d.reviewBy) return 'NOT_SET';
  const days = daysUntil(today, d.reviewBy);
  if (Number.isNaN(days)) return 'NOT_SET';
  if (days < 0) return 'OVERDUE';
  return days <= windowDays ? 'DUE_SOON' : 'CURRENT';
}

export interface DocumentFilter {
  kind?: DocumentKind | 'ALL';
  /** 'ACTIVE' is draft and approved (retired hidden), the register's default view. */
  status?: DocumentStatus | 'ALL' | 'ACTIVE';
  review?: ReviewState | 'ALL';
  /** Case-insensitive; matches the title, reference or owner. */
  query?: string;
}

/** The documents that pass every filter that is set, in the order given. */
export function filterDocuments(docs: GovernanceDocument[], f: DocumentFilter, today: string): GovernanceDocument[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return docs.filter((d) => {
    if (f.kind && f.kind !== 'ALL' && d.kind !== f.kind) return false;
    if (f.status === 'ACTIVE' ? d.status === 'RETIRED' : f.status && f.status !== 'ALL' && d.status !== f.status) return false;
    if (f.review && f.review !== 'ALL' && reviewState(d, today) !== f.review) return false;
    if (q !== '' && !`${d.title}\n${d.reference}\n${d.owner}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const KIND_ORDER = new Map<string, number>(DOCUMENT_KINDS.map((k, i) => [k, i]));

/** The kind order of DOCUMENT_KINDS, then the title (case-insensitive), then the id. A new array. */
export function sortDocuments(docs: GovernanceDocument[]): GovernanceDocument[] {
  return docs
    .slice()
    .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The documents of the program: the declared set, or every document while the program declares none. */
export function documentsInProgram(docs: GovernanceDocument[], pd: Pick<ProgramDocuments, 'declared' | 'documentIds'>): GovernanceDocument[] {
  if (!pd.declared) return docs;
  const ids = new Set(pd.documentIds);
  return docs.filter((d) => ids.has(d.id));
}

/** How many controls of the program each document is linked to (a document with none is absent from the map). */
export function controlCountsByDocument(links: ProgramDocuments['controlLinks']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of links) out[l.documentId] = (out[l.documentId] ?? 0) + 1;
  return out;
}

/** How many files each document has attached in the program. */
export function attachmentCountsByDocument(attachments: DocumentAttachment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of attachments) out[a.documentId] = (out[a.documentId] ?? 0) + 1;
  return out;
}

export interface AttachmentView {
  evidenceId: string;
  isPrimary: boolean;
  /** The evidence file was deleted after it was attached: the link stays, the screen says "file removed". */
  missing: boolean;
}

/** The attachments of one document, the primary first, each marked missing when its evidence is no longer in the program. */
export function attachmentsOf(documentId: string, attachments: DocumentAttachment[], liveEvidenceIds: ReadonlySet<string>): AttachmentView[] {
  return attachments
    .filter((a) => a.documentId === documentId)
    .map((a) => ({ evidenceId: a.evidenceId, isPrimary: a.isPrimary, missing: !liveEvidenceIds.has(a.evidenceId) }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0));
}

export type PrimarySource =
  | { type: 'attachment'; evidenceId: string; missing: boolean }
  | { type: 'location'; kind: LocationKind; value: string }
  | null;

/** The primary copy: the primary attachment wins (missing when its file was removed), else the internal location; null when there is neither. */
export function primarySource(doc: GovernanceDocument, attachments: DocumentAttachment[], liveEvidenceIds: ReadonlySet<string>): PrimarySource {
  const primary = attachments.find((a) => a.documentId === doc.id && a.isPrimary);
  if (primary) return { type: 'attachment', evidenceId: primary.evidenceId, missing: !liveEvidenceIds.has(primary.evidenceId) };
  if (doc.locationUrl) {
    const c = classifyLocation(doc.locationUrl);
    if (c.ok) return { type: 'location', kind: c.kind, value: c.value };
  }
  return null;
}

/**
 * Present (D7): approved and a usable primary copy (the primary attachment if there is one, and it must still exist; else the location). An overdue review
 * does not change it (flag it with reviewState). This is the one rule: the expected-documents checklist and its counts use the same function.
 */
export function isPresent(doc: GovernanceDocument, pd: Pick<ProgramDocuments, 'attachments'>, liveEvidenceIds: ReadonlySet<string>): boolean {
  return hasUsableCopy(doc, pd, liveEvidenceIds);
}

/** How many of the documents have a review that is past due (retired documents are not counted). */
export function overdueCount(docs: GovernanceDocument[], today: string): number {
  return docs.filter((d) => reviewState(d, today) === 'OVERDUE').length;
}
