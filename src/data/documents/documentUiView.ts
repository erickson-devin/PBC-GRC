// What the Document Register screens say and decide (#240): fixed copy, labels, filters, sort, the document form (parsing, validation, three-way merge after
// a stale write), the approval form, the confirmation texts and the error mapper. Pure: types, the document schema rules and the register view only; nothing
// here touches storage, the network, the clock or the log. "Today" is always injected (YYYY-MM-DD). Titles, owners, locations and notes may be CUI: no text
// here echoes a server message or a value, and the confirmation texts never carry a title.

import type { DocumentAttachment, DocumentInput, DocumentKind, GovernanceDocument } from '../../types/documents';
import type { EvidenceItem } from '../../types';
import { approvalClearingChange, classifyLocation, isRealDate, DOCUMENT_LIMITS, type LocationKind } from './documentSchema';
import { daysUntil, reviewState, sortDocuments, type PrimarySource, primarySource } from './documentRegisterView';

const LOCATION_SCHEME_TEXT =
  'Use an https:// or http:// address, a \\\\server\\share path, a file:// address or a drive path such as S:\\Policies. Other kinds of links are not accepted.';

export const DOCUMENT_UI_TEXT = {
  title: 'Document Register',
  intro: 'Plans, policies, procedures and other governance documents: owner, version, approval and the next review. Shared by every program in this organization; control links, files and the expected-documents checklist belong to each program.',
  unsupported: 'The Document Register is kept on the server, so it needs a server-backed organization. This organization is stored only in this browser',
  unsupportedMoveHint: ': move it to the server from the notice above the asset inventory',
  unsupportedTail: '. The Living Policy Library still generates policy text you can download.',
  readOnly: 'Read-only: only a Tenant Owner or Admin can change the Document Register or approve documents.',
  loading: 'Loading the Document Register…',
  loadFailed: 'The Document Register could not be loaded.',
  emptyEditor: 'No documents registered yet. Add your plans, policies and procedures, or register a generated policy draft from the Living Policy Library.',
  emptyReader: 'No documents registered yet. A Tenant Owner or Admin can add them.',
  emptyFiltered: 'No documents match your search and filters.',
  noProgram: 'No program is open, so control links, files and the expected-documents checklist are not shown. The register itself is shared by every program.',
  programLoading: "Loading this program's document links…",
  programFailed: "This program's document links and files could not be loaded. The register itself is unaffected.",
  archived: 'This program is archived, so its document links, files and checklist are read-only. The register itself can still be edited.',
  undeclaredEditor: ' Tick "In this program" on the documents it uses.',
  undeclaredReader: ' A Tenant Owner or Admin can declare them.',
  limitReached: 'The register holds at most 2,000 documents. Remove or retire documents you no longer need to add more.',
  locationHint: 'Where the controlled copy lives: an intranet address (https://…), a file share path (\\\\server\\share\\…), a file:// address or a drive path (S:\\…). The app stores and shows this text; it never opens or checks it.',
  locationShareNote: 'File share and drive paths open only from a computer that can reach the share: copy the path into your file manager.',
  notesHint: "Short notes for the register. Do not paste the document's text here.",
  reviewByHint: 'When this document is next due for review. The register flags it 30 days before.',
  aiAssistedLabel: 'Parts of this document were drafted with an AI tool',
  aiAssistedHint: 'It is marked AI-assisted, and approving it needs a confirmation that a person reviewed and edited it.',
  approvalWillClear: 'Saving withdraws the approval: the version, title, kind or location of an approved document changed. Approve it again afterwards.',
  dirtyStatus: 'Save or discard your changes first.',
  staleDocument: 'Someone else changed this document while you were editing. Nothing was saved. Your entries are kept; fields only they changed now show their values. Check the highlighted fields, then save again.',
  conflictField: 'Changed by someone else too: check this value.',
  documentGone: 'This document was removed meanwhile. Nothing was saved.',
  reviewNeeded: 'This document started as {origin}. Approve it only after a person has read and edited it, and the reviewed copy is attached or its location recorded.',
  reviewedLabel: 'I reviewed and edited this document',
  reviewedRequired: 'Confirm that you reviewed and edited the document.',
  approverLine: 'The server records you as the approver, from your sign-in.',
  noCopyOnApprove: 'No copy is on file in {program}: it will be approved, but it does not count as present in the expected-documents checklist until a file is attached or a location recorded.',
  withdrawConfirm: 'Withdraw the approval of this document? It goes back to Draft, leaves the SSP and stops counting as present. The approval date and approver are cleared.',
  retireConfirm: 'Retire this document? It leaves the SSP and stops counting as present. Its links and files stay, and you can reinstate it later.',
  linksIntro: 'Links belong to this program only; other programs keep their own.',
  linksStale: 'The links for this document changed elsewhere. Nothing was saved. The current links are loaded with your additions and removals kept on top; check them and save again.',
  linksReadOnly: 'Read-only: only a Tenant Owner or Admin can change control links.',
  linksNotInProgram: 'This document is not in this program. Add it to the program before linking controls.',
  filesIntro: 'Each file is an Evidence Vault file of this program; unlinking keeps the file. The primary copy is what the SSP and the checklist point to.',
  filesEmpty: 'No files linked in this program yet.',
  fileRemoved: 'File removed from the Evidence Vault',
  uploadHint: "Evidence is always filed under a control: choose one of this document's linked controls.",
  uploadNeedsControl: 'Link this document to a control first (Controls column), or choose a file that is already in the Evidence Vault.',
  primaryRule: 'A primary file wins over the internal location. Without a primary file, the internal location is the primary copy.',
  generatedBadge: 'Generated draft, not approved',
  generatedIntro: 'Rendered now from the policy generator with your current technology survey answers. It is not stored and is not evidence. Its revision table says 1.0 and Automated System: replace that with your own history when you edit it.',
  registeredDraft: 'Registered as a draft in the Document Register. It does not count as present until a person reviews it, attaches the reviewed copy and approves it.',
} as const;

export const KIND_LABELS: Record<DocumentKind, string> = {
  PLAN: 'Plan',
  POLICY: 'Policy',
  PROCEDURE: 'Procedure',
  PROCESS: 'Process or worksheet',
  REFERENCE: 'Reference document',
  REVIEW_ASSESSMENT: 'Review or assessment',
  ARTIFACT: 'Artifact or record',
};

export const KIND_FILTER_LABELS: Record<DocumentKind | 'ALL', string> = {
  ALL: 'All',
  PLAN: 'Plans',
  POLICY: 'Policies',
  PROCEDURE: 'Procedures',
  PROCESS: 'Processes',
  REFERENCE: 'Reference',
  REVIEW_ASSESSMENT: 'Reviews and assessments',
  ARTIFACT: 'Artifacts',
};

export const KIND_HINTS: Record<DocumentKind, string> = {
  PLAN: 'How the organization will do something over time: SSP, incident response plan, POA&M.',
  POLICY: 'What the organization requires: one per control family, or a combined policy.',
  PROCEDURE: 'Step-by-step instructions that carry out a policy.',
  PROCESS: 'A recurring process or worksheet: a checklist, a review form.',
  REFERENCE: 'Material the documents rely on: standards, contracts, diagrams kept for reference.',
  REVIEW_ASSESSMENT: 'The record of a review, test or assessment and its results.',
  ARTIFACT: 'A record the controls produce: inventories, logs, baseline configurations.',
};

export const ORIGIN_BADGE: Record<'GENERATED' | 'AI_ASSISTED', string> = { GENERATED: 'Generated text', AI_ASSISTED: 'AI-assisted' };

export const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  http: 'Intranet or web address',
  file: 'file:// address',
  unc: 'File share path',
  drive: 'Drive path',
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// ---- Filters, counts and chips ----

/** CURRENT = draft and approved (the default: retired documents are hidden). */
export type StatusFilter = 'CURRENT' | 'DRAFT' | 'APPROVED' | 'RETIRED' | 'ALL';

export function statusMatches(d: Pick<GovernanceDocument, 'status'>, f: StatusFilter): boolean {
  if (f === 'ALL') return true;
  if (f === 'CURRENT') return d.status !== 'RETIRED';
  return d.status === f;
}

/** How many documents each kind filter would show for the status filter (the kind and the search are ignored). */
export function kindCounts(docs: GovernanceDocument[], status: StatusFilter): Record<DocumentKind | 'ALL', number> {
  const out: Record<DocumentKind | 'ALL', number> = { ALL: 0, PLAN: 0, POLICY: 0, PROCEDURE: 0, PROCESS: 0, REFERENCE: 0, REVIEW_ASSESSMENT: 0, ARTIFACT: 0 };
  for (const d of docs) {
    if (!statusMatches(d, status)) continue;
    out.ALL += 1;
    out[d.kind] += 1;
  }
  return out;
}

export function statusChip(d: Pick<GovernanceDocument, 'status' | 'origin'>): { tone: 'amber' | 'emerald' | 'slate'; text: string; untrusted: boolean } {
  if (d.status === 'APPROVED') return { tone: 'emerald', text: 'Approved', untrusted: false };
  if (d.status === 'RETIRED') return { tone: 'slate', text: 'Retired', untrusted: false };
  if (d.origin === 'GENERATED') return { tone: 'amber', text: 'Draft: generated text, needs review', untrusted: true };
  if (d.origin === 'AI_ASSISTED') return { tone: 'amber', text: 'Draft: AI-assisted, needs review', untrusted: true };
  return { tone: 'amber', text: 'Draft', untrusted: false };
}

export function reviewChip(d: Pick<GovernanceDocument, 'status' | 'reviewBy'>, today: string): { tone: 'rose' | 'amber' | 'slate'; text: string } | null {
  const state = reviewState(d, today);
  if (state === 'OVERDUE') return { tone: 'rose', text: 'Review overdue' };
  if (state === 'NOT_SET') return { tone: 'slate', text: 'No review date' };
  if (state === 'DUE_SOON') {
    const n = daysUntil(today, d.reviewBy ?? '');
    return { tone: 'amber', text: n === 0 ? 'Review due today' : `Review due in ${n} ${plural(n, 'day', 'days')}` };
  }
  return null;
}

/** Retired documents are left out of every count. `needsReview` is the generated or AI-assisted drafts. */
export function summaryCounts(docs: GovernanceDocument[], today: string): { drafts: number; needsReview: number; overdue: number; dueSoon: number } {
  const c = { drafts: 0, needsReview: 0, overdue: 0, dueSoon: 0 };
  for (const d of docs) {
    if (d.status === 'RETIRED') continue;
    if (d.status === 'DRAFT') {
      c.drafts += 1;
      if (d.origin !== 'MANUAL') c.needsReview += 1;
    }
    const r = reviewState(d, today);
    if (r === 'OVERDUE') c.overdue += 1;
    else if (r === 'DUE_SOON') c.dueSoon += 1;
  }
  return c;
}

export function summaryLine(c: ReturnType<typeof summaryCounts>): string | null {
  const parts: string[] = [];
  if (c.drafts > 0) parts.push(`${c.drafts} ${plural(c.drafts, 'draft', 'drafts')}`);
  if (c.overdue > 0) parts.push(`${c.overdue} review overdue`);
  if (c.dueSoon > 0) parts.push(`${c.dueSoon} due within 30 days`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ---- Sort ----

export type DocSortKey = 'kind' | 'title' | 'reviewBy' | 'approvalDate';

const byTitle = (a: GovernanceDocument, b: GovernanceDocument): number =>
  a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A new array. 'kind' ascending is the register's own order; a missing date sorts last in both directions; ties fall back to the title. */
export function sortDocs(docs: GovernanceDocument[], key: DocSortKey, dir: 'asc' | 'desc'): GovernanceDocument[] {
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'kind') {
    if (dir === 'asc') return sortDocuments(docs);
    const asc = sortDocuments(docs);
    const kinds: DocumentKind[] = [];
    for (const d of asc) if (kinds[kinds.length - 1] !== d.kind) kinds.push(d.kind);
    return kinds.reverse().flatMap((k) => asc.filter((d) => d.kind === k));
  }
  return docs.slice().sort((a, b) => {
    if (key === 'title') return sign * byTitle(a, b);
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return byTitle(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av < bv ? -sign : av > bv ? sign : 0) || byTitle(a, b);
  });
}

export function docAriaSort(key: DocSortKey, active: DocSortKey, dir: 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (key !== active) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

export function docCountCaption(shown: number, total: number): string {
  if (shown === total) return `${total} ${plural(total, 'document', 'documents')}`;
  return `${shown} of ${total} ${plural(total, 'document', 'documents')}`;
}

export function docEmptyMessage(a: { total: number; canEdit: boolean }): string {
  if (a.total === 0) return a.canEdit ? DOCUMENT_UI_TEXT.emptyEditor : DOCUMENT_UI_TEXT.emptyReader;
  return DOCUMENT_UI_TEXT.emptyFiltered;
}

// ---- Primary copy ----

export function primaryCell(src: PrimarySource, names: Record<string, string>): { kind: 'file' | 'removed' | 'location' | 'none'; text: string } {
  if (!src) return { kind: 'none', text: 'None on file' };
  if (src.type === 'location') return { kind: 'location', text: src.value };
  if (src.missing) return { kind: 'removed', text: DOCUMENT_UI_TEXT.fileRemoved };
  return { kind: 'file', text: names[src.evidenceId] ?? 'File' };
}

/** For the CSV: the primary copy as the screen words it, by document id (a file name, "File removed", the location, or blank). */
export function primaryLabelMap(docs: GovernanceDocument[], atts: DocumentAttachment[], ev: { id: string; name: string }[], liveIds: ReadonlySet<string>): Record<string, string> {
  const names = Object.fromEntries(ev.map((e) => [e.id, e.name]));
  const out: Record<string, string> = {};
  for (const d of docs) {
    const src = primarySource(d, atts, liveIds);
    out[d.id] = !src ? '' : src.type === 'location' ? src.value : src.missing ? 'File removed' : names[src.evidenceId] ?? 'File';
  }
  return out;
}

// ---- The document form ----

export interface DocumentForm {
  title: string;
  kind: DocumentKind | '';
  reference: string;
  owner: string;
  version: string;
  reviewBy: string;
  locationUrl: string;
  notes: string;
  aiAssisted: boolean;
}

export type DocumentFormField = Exclude<keyof DocumentForm, 'aiAssisted'>;

/** The form for an existing document, or for a new one (optionally filled in, as the checklist's Register action does). */
export function documentFormFrom(d: GovernanceDocument | null, prefill?: Partial<DocumentForm>): DocumentForm {
  const blank: DocumentForm = { title: '', kind: '', reference: '', owner: '', version: '', reviewBy: '', locationUrl: '', notes: '', aiAssisted: false };
  if (d) {
    return { title: d.title, kind: d.kind, reference: d.reference, owner: d.owner, version: d.version, reviewBy: d.reviewBy ?? '', locationUrl: d.locationUrl ?? '', notes: d.notes, aiAssisted: false };
  }
  return { ...blank, ...(prefill ?? {}) };
}

/** What the person typed about the location: the error to show (null when fine or blank) and what it was recognised as. */
export function locationMessage(raw: string): { error: string | null; recognised: string | null } {
  const c = classifyLocation(raw);
  if (!c.ok) {
    switch (c.reason) {
      case 'empty': return { error: null, recognised: null };
      case 'too_long': return { error: 'Use 2,048 characters or fewer.', recognised: null };
      case 'control_chars': return { error: 'Remove the line breaks or control characters.', recognised: null };
      case 'scheme': return { error: LOCATION_SCHEME_TEXT, recognised: null };
      case 'credentials': return { error: 'Remove the user name and password from the address. Never store credentials here.', recognised: null };
      default: return { error: 'This address could not be read. Check it and try again.', recognised: null };
    }
  }
  if (c.kind === 'http') return { error: null, recognised: 'Recognised as an intranet or web address: shown as a link that opens in a new tab when clicked.' };
  return { error: null, recognised: `Recognised as a ${LOCATION_KIND_LABELS[c.kind].toLowerCase()}: shown as text with a Copy button.` };
}

const DATE_ERROR = 'Enter a real date (YYYY-MM-DD), or leave it blank.';
const tooLong = (n: number): string => `Use ${n.toLocaleString('en-US')} characters or fewer.`;

/** The location as the server stores it (an http address is normalised), or the trimmed text when it is not recognised; null when blank. */
function locationForInput(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const c = classifyLocation(t);
  return c.ok ? c.value : t;
}

/** Why the form cannot be saved, per field, and otherwise the input to send. `origin` goes only with a new document the person marked AI-assisted. */
export function validateDocumentForm(f: DocumentForm, mode: 'add' | 'edit'): { input: (DocumentInput & { origin?: 'AI_ASSISTED' }) | null; errors: Partial<Record<DocumentFormField, string>> } {
  const errors: Partial<Record<DocumentFormField, string>> = {};
  const title = f.title.trim();
  if (title === '') errors.title = 'Enter the document title.';
  else if (title.length > DOCUMENT_LIMITS.title) errors.title = tooLong(DOCUMENT_LIMITS.title);
  if (f.kind === '') errors.kind = 'Choose the kind of document.';
  if (f.reference.trim().length > DOCUMENT_LIMITS.reference) errors.reference = tooLong(DOCUMENT_LIMITS.reference);
  if (f.owner.trim().length > DOCUMENT_LIMITS.owner) errors.owner = tooLong(DOCUMENT_LIMITS.owner);
  if (f.version.trim().length > DOCUMENT_LIMITS.version) errors.version = tooLong(DOCUMENT_LIMITS.version);
  const reviewBy = f.reviewBy.trim();
  if (reviewBy !== '' && !isRealDate(reviewBy)) errors.reviewBy = DATE_ERROR;
  const loc = locationMessage(f.locationUrl);
  if (loc.error) errors.locationUrl = loc.error;
  if (f.notes.trim().length > DOCUMENT_LIMITS.notes) errors.notes = tooLong(DOCUMENT_LIMITS.notes);
  if (Object.keys(errors).length > 0 || f.kind === '') return { input: null, errors };
  const input: DocumentInput & { origin?: 'AI_ASSISTED' } = {
    kind: f.kind,
    title,
    reference: f.reference.trim(),
    owner: f.owner.trim(),
    version: f.version.trim(),
    reviewBy: reviewBy === '' ? null : reviewBy,
    locationUrl: locationForInput(f.locationUrl),
    notes: f.notes.trim(),
  };
  if (mode === 'add' && f.aiAssisted) input.origin = 'AI_ASSISTED';
  return { input, errors };
}

/** True when saving this form would withdraw the approval of an approved document (a changed version, title, kind or location). */
export function approvalWillClear(initial: GovernanceDocument | null, f: DocumentForm): boolean {
  if (!initial || initial.status !== 'APPROVED') return false;
  const change: DocumentInput = { title: f.title.trim(), version: f.version.trim(), locationUrl: locationForInput(f.locationUrl) };
  if (f.kind !== '') change.kind = f.kind;
  return approvalClearingChange(initial, change);
}

const FORM_FIELDS: DocumentFormField[] = ['title', 'kind', 'reference', 'owner', 'version', 'reviewBy', 'locationUrl', 'notes'];
const norm = (f: DocumentForm, k: DocumentFormField): string => f[k].trim();

/** Three-way merge after a stale write: fields the person did not touch take the new server value; conflicts = touched by both, to different values. */
export function rebaseDocumentForm(oldBase: GovernanceDocument, newBase: GovernanceDocument, form: DocumentForm): { form: DocumentForm; conflicts: DocumentFormField[] } {
  const was = documentFormFrom(oldBase);
  const now = documentFormFrom(newBase);
  const next: DocumentForm = { ...now, aiAssisted: form.aiAssisted };
  const conflicts: DocumentFormField[] = [];
  for (const k of FORM_FIELDS) {
    if (norm(form, k) === norm(was, k)) continue;
    (next as unknown as Record<string, string>)[k] = form[k];
    if (norm(now, k) !== norm(was, k) && norm(now, k) !== norm(form, k)) conflicts.push(k);
  }
  return { form: next, conflicts };
}

// ---- The approval form ----

export interface ApproveForm {
  version: string;
  approvalDate: string;
  reviewBy: string;
  reviewed: boolean;
}

/** Generated and AI-assisted text is approved only after the person confirms they reviewed and edited it. */
export function needsReviewConfirmation(d: Pick<GovernanceDocument, 'origin'>): boolean {
  return d.origin !== 'MANUAL';
}

export function approveFormFrom(d: GovernanceDocument, today: string): ApproveForm {
  return { version: d.version, approvalDate: today, reviewBy: d.reviewBy ?? '', reviewed: false };
}

/** The same calendar date `years` later; 29 February in a year without one becomes 28 February. */
export function addYearsIso(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const ny = y + years;
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  const p = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${p(ny, 4)}-${p(m, 2)}-${p(Math.min(d, last), 2)}`;
}

export function validateApproveForm(
  f: ApproveForm,
  today: string,
  needsReview: boolean
): { value: { version: string; approvalDate: string; reviewBy: string | null; confirmReviewed?: true } | null; errors: Partial<Record<'version' | 'approvalDate' | 'reviewBy' | 'reviewed', string>> } {
  const errors: Partial<Record<'version' | 'approvalDate' | 'reviewBy' | 'reviewed', string>> = {};
  const version = f.version.trim();
  if (version === '') errors.version = 'Enter the version you are approving, such as 1.0.';
  else if (version.length > DOCUMENT_LIMITS.version) errors.version = tooLong(DOCUMENT_LIMITS.version);
  const approvalDate = f.approvalDate.trim();
  if (!isRealDate(approvalDate)) errors.approvalDate = 'Enter the approval date (YYYY-MM-DD).';
  else if (approvalDate > today) errors.approvalDate = 'The approval date cannot be in the future.';
  const reviewBy = f.reviewBy.trim();
  if (reviewBy !== '') {
    if (!isRealDate(reviewBy)) errors.reviewBy = DATE_ERROR;
    else if (isRealDate(approvalDate) && reviewBy < approvalDate) errors.reviewBy = 'The review date must be on or after the approval date.';
  }
  if (needsReview && !f.reviewed) errors.reviewed = DOCUMENT_UI_TEXT.reviewedRequired;
  if (Object.keys(errors).length > 0) return { value: null, errors };
  const value: { version: string; approvalDate: string; reviewBy: string | null; confirmReviewed?: true } = { version, approvalDate, reviewBy: reviewBy === '' ? null : reviewBy };
  if (needsReview && f.reviewed) value.confirmReviewed = true;
  return { value, errors };
}

// ---- Errors ----

export type DocAction = 'save' | 'approve' | 'status' | 'delete' | 'membership' | 'links' | 'attach' | 'unlink' | 'primary' | 'expectation' | 'register';

const DEFAULT_ERROR: Record<DocAction, string> = {
  save: 'The document could not be saved. Try again.',
  approve: 'The document could not be approved. Try again.',
  status: 'The status could not be changed. Try again.',
  delete: 'The document could not be removed. Try again.',
  membership: 'The program membership could not be changed. Try again.',
  links: 'The control links could not be saved. Try again.',
  attach: 'The file could not be linked. Try again.',
  unlink: 'The file could not be unlinked. Try again.',
  primary: 'The primary copy could not be changed. Try again.',
  expectation: 'The checklist link could not be saved. Try again.',
  register: 'The draft could not be registered. Try again.',
};

/** Fixed text for a refused request: never the server's message and never a value. The reason is checked first, then the HTTP status. */
export function documentErrorMessage(err: unknown, action: DocAction, programName?: string): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  const linkish = action === 'links' || action === 'attach' || action === 'expectation';
  switch (e.reason) {
    case 'duplicate_title': return 'Another document in the register already has this title (titles are compared without regard to case). Nothing was saved.';
    case 'duplicate_seed': return 'A generated draft for this policy family is already in the register. Nothing new was created.';
    case 'invalid_location': return LOCATION_SCHEME_TEXT;
    case 'stale_write':
      if (action === 'links') return DOCUMENT_UI_TEXT.linksStale;
      if (action === 'expectation') return 'The links for this expected document changed elsewhere. Nothing was saved; the current links are loaded. Check them and try again.';
      return DOCUMENT_UI_TEXT.staleDocument;
    case 'not_reviewed': return 'This document started as generated or AI-assisted text: confirm that you reviewed and edited it. Nothing was approved.';
    case 'retired': return 'This document is retired. Reinstate it as a draft before approving it.';
    case 'document_in_use': return 'This document still has links in this program.';
    case 'document_not_in_program': return `This document is not in ${programName ?? 'this program'}. Add it to the program first. Nothing was saved.`;
    case 'control_not_in_program': return "One of these controls is not in this program's catalog. Nothing was saved; the links have been reloaded.";
    case 'evidence_not_found': return "That file is no longer in this program's Evidence Vault. Nothing was linked.";
    case 'inherited_evidence': return 'That file is a copy shared from another control. Choose the original file. Nothing was linked.';
    case 'unknown_expected_document': return 'This expected document does not apply to this program. The checklist has been refreshed.';
    case 'not_found':
    case 'document_not_found': return 'This document was removed meanwhile. The list has been refreshed.';
    case 'unknown_documents': return 'Some of these documents were removed meanwhile. Nothing was saved; the list has been refreshed.';
    case 'limit': return linkish ? 'This document or program holds the most links it can. Nothing was saved.' : DOCUMENT_UI_TEXT.limitReached;
    case 'program_archived': return `${DOCUMENT_UI_TEXT.archived} Nothing was saved.`;
    case 'invalid_expected_updated_at': return 'This page is out of date. Reload it and try again. Nothing was saved.';
    default: break;
  }
  if (e.status === 400) return 'The server did not accept these values. Check the fields and that none is too long. Nothing was saved.';
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change the Document Register. Nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved; try again.';
  return DEFAULT_ERROR[action];
}

// ---- Confirmation texts (counts only, never a title) ----

export function removeDocumentConfirmText(u: { programs: number; controlLinks: number; attachments: number; expectations: number } | null): string {
  if (u === null) {
    return 'Remove this document from the register? Where it is used could not be checked: its control links, file links and checklist links in every program are removed too. The files stay in the Evidence Vault.';
  }
  if (u.programs === 0 && u.controlLinks === 0 && u.attachments === 0 && u.expectations === 0) {
    return 'Remove this document from the register? It has no control links, files or checklist links in any program.';
  }
  const { programs: p, controlLinks: c, attachments: a, expectations: e } = u;
  return `Remove this document from the register? In ${p} ${plural(p, 'program', 'programs')} it has ${c} control ${plural(c, 'link', 'links')}, ${a} file ${plural(a, 'link', 'links')} and ${e} checklist ${plural(e, 'link', 'links')}; they are removed too. The files stay in the Evidence Vault.`;
}

export function undeclaredDocumentsNote(programName: string, approved: number): string {
  return `${programName} has not declared its documents: its SSP lists every approved document in the register (${approved}).`;
}

export function declareDocumentsText(programName: string, total: number, adding: number): string {
  return `${programName} has not declared its documents, so its SSP lists every approved document in the register (${total} documents). After this change it declares ${adding} ${plural(adding, 'document', 'documents')}, and its SSP lists only ${adding === 1 ? 'that one' : 'those'} once approved.`;
}

export function membershipRemoveText(programName: string, inUse: { controlLinks: number; attachments?: number; expectations?: number }): string {
  const c = inUse.controlLinks;
  const a = inUse.attachments ?? 0;
  const e = inUse.expectations ?? 0;
  return `Take this document out of ${programName}? Its ${c} control ${plural(c, 'link', 'links')}, ${a} file ${plural(a, 'link', 'links')} and ${e} checklist ${plural(e, 'link', 'links')} in ${programName} are removed too. The files stay in the Evidence Vault.`;
}

// ---- Files ----

/** The files linked to a document in the open program: the primary first, then by name; a file removed from the vault is `missing` with no name. */
export function attachmentRows(
  atts: DocumentAttachment[],
  documentId: string,
  ev: Pick<EvidenceItem, 'id' | 'name' | 'controlId' | 'uploadedAt'>[]
): { evidenceId: string; isPrimary: boolean; name: string | null; controlId: string | null; uploadedAt: string | null; missing: boolean }[] {
  const byId = new Map(ev.map((e) => [e.id, e]));
  return atts
    .filter((a) => a.documentId === documentId)
    .map((a) => {
      const item = byId.get(a.evidenceId);
      return {
        evidenceId: a.evidenceId,
        isPrimary: a.isPrimary,
        name: item ? item.name : null,
        controlId: item ? item.controlId : null,
        uploadedAt: item ? item.uploadedAt : null,
        missing: !item,
      };
    })
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase()) || (a.evidenceId < b.evidenceId ? -1 : 1));
}

export function unlinkAttachmentText(isPrimary: boolean): string {
  return `Unlink this file from the document? The file stays in the Evidence Vault.${isPrimary ? ' It is the primary copy, so the document has no primary file afterwards.' : ''}`;
}

export function attachLinkFailedText(displayId: string): string {
  return `The file was uploaded to the Evidence Vault under ${displayId}, but it could not be linked to this document. Choose it under "A file already in the Evidence Vault" to try again.`;
}

/** The controls a new file can be filed under: this document's linked controls, by display id. */
export function uploadControlChoices(
  links: { documentId: string; controlId: string }[],
  documentId: string,
  displayId: (id: string) => string,
  titles: Record<string, string>
): { id: string; label: string }[] {
  const ids = Array.from(new Set(links.filter((l) => l.documentId === documentId).map((l) => l.controlId)));
  return ids
    .map((id) => ({ id, shown: displayId(id) }))
    .sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0))
    .map(({ id, shown }) => ({ id, label: titles[id] ? `${shown} ${titles[id]}` : shown }));
}

// ---- File names (no organization name, no CAGE code) ----

export function generatedDraftFileName(seed: { family: string }, today: string): string {
  return `${seed.family.toLowerCase()}-policy-draft-${today}.md`;
}

export function registerCsvFileName(today: string): string {
  return `document-register-${today}.csv`;
}
