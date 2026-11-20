// Validation of the document register (documents, their location, approval, status, program membership, control links, attachments and the
// expected-document links). Pure: shared by the server routes and the client; the server is authoritative. Errors name the field and never
// echo a value (titles, owners, locations and notes may be CUI).
import {
  DOCUMENT_KINDS,
  DOCUMENT_ORIGINS,
  MAX_CONTROLS_PER_DOCUMENT,
  MAX_DOCUMENTS_PER_TENANT,
  type DocumentInput,
  type DocumentKind,
  type DocumentOrigin,
  type GovernanceDocument,
} from '../../types/documents';

export type LocationKind = 'http' | 'file' | 'unc' | 'drive';
export type LocationRefusal = 'empty' | 'too_long' | 'control_chars' | 'scheme' | 'credentials' | 'malformed';

/** Field caps (the SQL columns are at least this wide). */
export const DOCUMENT_LIMITS = {
  title: 255,
  reference: 64,
  owner: 255,
  version: 32,
  notes: 4000,
  location: 2048,
} as const;

export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DOCUMENT_CONTROL_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const DOCUMENT_EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const EXPECTED_DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const GENERATED_SEED_PATTERN = /^generated:[A-Za-z0-9_.:-]{1,80}$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNC_PATH = /^\\\\[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|]+(\\[^\\/:*?"<>|]*)*$/;
const DRIVE_PATH = /^[A-Za-z]:\\[^<>|"*?]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A real calendar date written YYYY-MM-DD (years 1900 to 2999). */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1900 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Where a document lives on the organization's own storage: http / https (a link), file://, a UNC share or a mapped drive path (text only).
 * The value is trimmed; a URL with credentials, a control character, another scheme (script, data, mail and so on) or a relative path is refused.
 * Nothing here ever fetches or resolves the value.
 */
export function classifyLocation(raw: unknown): { ok: true; kind: LocationKind; value: string } | { ok: false; reason: LocationRefusal } {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty' };
  if (value.length > DOCUMENT_LIMITS.location) return { ok: false, reason: 'too_long' };
  if (CONTROL_CHARS.test(value)) return { ok: false, reason: 'control_chars' };
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (url.hostname === '') return { ok: false, reason: 'malformed' };
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
    if (url.href.length > DOCUMENT_LIMITS.location) return { ok: false, reason: 'too_long' };
    return { ok: true, kind: 'http', value: url.href };
  }
  if (/^file:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
    return { ok: true, kind: 'file', value };
  }
  if (UNC_PATH.test(value)) return { ok: true, kind: 'unc', value };
  if (DRIVE_PATH.test(value)) return { ok: true, kind: 'drive', value };
  return { ok: false, reason: 'scheme' };
}

/** The href to render as a link: only an http / https URL with a host (URL.href); everything else is shown as text. */
export function safeLinkHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const c = classifyLocation(raw);
  return c.ok && c.kind === 'http' ? c.value : null;
}

export type DocumentInputWithSeed = DocumentInput & { origin?: DocumentOrigin; seedKey?: string };
export type DocumentValidation<T> = { ok: true; value: T } | { ok: false; field: string; reason?: LocationRefusal };

const bad = (field: string, reason?: LocationRefusal): { ok: false; field: string; reason?: LocationRefusal } => (reason ? { ok: false, field, reason } : { ok: false, field });
/** A field name safe to send back: only a short plain identifier, never arbitrary text from the body. */
const safeField = (key: string): string => (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : 'body');

function textField(body: Record<string, unknown>, key: string, max: number, multiline = false): { ok: true; value: string | undefined } | { ok: false; field: string } {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, field: key };
  const value = raw.trim();
  if (value.length > max || (multiline ? MULTILINE_CONTROL_CHARS : CONTROL_CHARS).test(value)) return { ok: false, field: key };
  return { ok: true, value };
}

/**
 * Validates a document request body. `partial` (PUT) returns only the fields present and requires none (an `expectedUpdatedAt` key is allowed and
 * left to the route); otherwise (POST) kind and title are required and `origin` / `seedKey` are accepted (GENERATED needs a seed key, any other origin
 * forbids one). status, the approval dates and the approver are never writable here: any other key is refused by name.
 */
export function validateDocumentInput(body: unknown, partial: boolean): DocumentValidation<DocumentInputWithSeed> {
  if (!isRecord(body)) return bad('body');
  const allowed = new Set(['kind', 'title', 'reference', 'owner', 'version', 'reviewBy', 'locationUrl', 'notes', ...(partial ? ['expectedUpdatedAt'] : ['origin', 'seedKey'])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return bad(safeField(key));
  const out: DocumentInputWithSeed = {};

  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(body.kind)) return bad('kind');
    out.kind = body.kind as DocumentKind;
  } else if (!partial) {
    return bad('kind');
  }

  const title = textField(body, 'title', DOCUMENT_LIMITS.title);
  if (!title.ok) return title;
  if (title.value !== undefined) {
    if (title.value === '') return bad('title');
    out.title = title.value;
  } else if (!partial) {
    return bad('title');
  }

  const reference = textField(body, 'reference', DOCUMENT_LIMITS.reference);
  if (!reference.ok) return reference;
  if (reference.value !== undefined) out.reference = reference.value;
  const owner = textField(body, 'owner', DOCUMENT_LIMITS.owner);
  if (!owner.ok) return owner;
  if (owner.value !== undefined) out.owner = owner.value;
  const version = textField(body, 'version', DOCUMENT_LIMITS.version);
  if (!version.ok) return version;
  if (version.value !== undefined) out.version = version.value;
  const notes = textField(body, 'notes', DOCUMENT_LIMITS.notes, true);
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;

  if (body.reviewBy !== undefined) {
    if (body.reviewBy !== null && !isRealDate(body.reviewBy)) return bad('reviewBy');
    out.reviewBy = body.reviewBy;
  }
  if (body.locationUrl !== undefined) {
    if (body.locationUrl === null || (typeof body.locationUrl === 'string' && body.locationUrl.trim() === '')) {
      out.locationUrl = null;
    } else {
      const c = classifyLocation(body.locationUrl);
      if (!c.ok) return bad('locationUrl', c.reason);
      out.locationUrl = c.value;
    }
  }

  if (!partial) {
    const origin = body.origin === undefined ? 'MANUAL' : body.origin;
    if (typeof origin !== 'string' || !(DOCUMENT_ORIGINS as readonly string[]).includes(origin)) return bad('origin');
    out.origin = origin as DocumentOrigin;
    if (body.seedKey !== undefined && body.seedKey !== null) {
      if (typeof body.seedKey !== 'string' || !GENERATED_SEED_PATTERN.test(body.seedKey)) return bad('seedKey');
      out.seedKey = body.seedKey;
    }
    if (origin === 'GENERATED' && out.seedKey === undefined) return bad('seedKey');
    if (origin !== 'GENERATED' && out.seedKey !== undefined) return bad('seedKey');
  }
  return { ok: true, value: out };
}

/** True when the patch changes the version, title, kind or location of the stored document (an approval does not survive such a change). */
export function approvalClearingChange(before: Pick<GovernanceDocument, 'version' | 'title' | 'kind' | 'locationUrl'>, after: DocumentInput): boolean {
  return (
    (after.version !== undefined && after.version !== before.version) ||
    (after.title !== undefined && after.title !== before.title) ||
    (after.kind !== undefined && after.kind !== before.kind) ||
    (after.locationUrl !== undefined && after.locationUrl !== before.locationUrl)
  );
}

const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export interface ApprovalInput {
  version: string;
  approvalDate: string;
  reviewBy: string | null;
  confirmReviewed: boolean;
}

/**
 * Body of POST /:id/approve: version (required, not blank), approvalDate (a real date, not after the server's today + 1 day for time zones),
 * reviewBy (optional, not before the approval date) and confirmReviewed. `expectedUpdatedAt` is left to the route; the approver is never taken from
 * the body (any other key, such as approvedBy, is refused).
 */
export function validateApproval(body: unknown, serverToday: string): DocumentValidation<ApprovalInput> {
  if (!isRecord(body)) return bad('body');
  const allowed = new Set(['expectedUpdatedAt', 'version', 'approvalDate', 'reviewBy', 'confirmReviewed']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return bad(safeField(key));
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  if (version === '' || version.length > DOCUMENT_LIMITS.version || CONTROL_CHARS.test(version)) return bad('version');
  if (!isRealDate(body.approvalDate) || body.approvalDate > dayAfter(serverToday)) return bad('approvalDate');
  let reviewBy: string | null = null;
  if (body.reviewBy !== undefined && body.reviewBy !== null) {
    if (!isRealDate(body.reviewBy) || body.reviewBy < body.approvalDate) return bad('reviewBy');
    reviewBy = body.reviewBy;
  }
  if (body.confirmReviewed !== undefined && typeof body.confirmReviewed !== 'boolean') return bad('confirmReviewed');
  return { ok: true, value: { version, approvalDate: body.approvalDate, reviewBy, confirmReviewed: body.confirmReviewed === true } };
}

/** Body of POST /:id/status: DRAFT (withdraw an approval, or reinstate a retired document) or RETIRED. */
export function validateStatusInput(body: unknown): DocumentValidation<{ status: 'DRAFT' | 'RETIRED' }> {
  if (!isRecord(body)) return bad('body');
  for (const key of Object.keys(body)) if (key !== 'status' && key !== 'expectedUpdatedAt') return bad(safeField(key));
  if (body.status !== 'DRAFT' && body.status !== 'RETIRED') return bad('status');
  return { ok: true, value: { status: body.status } };
}

/** A list of ids (each matching `pattern`), without duplicates. */
function idList(raw: unknown, key: string, pattern: RegExp, max: number): DocumentValidation<string[]> {
  if (!Array.isArray(raw) || raw.length > max) return bad(key);
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || !pattern.test(id) || seen.has(id)) return bad(key);
    seen.add(id);
  }
  return { ok: true, value: [...raw] as string[] };
}

/** Body of PATCH /program-documents/documents: deltas, not both empty, no id in both lists. */
export function validateDocumentIdChange(body: unknown): DocumentValidation<{ add: string[]; remove: string[]; force: boolean }> {
  const b = isRecord(body) ? body : {};
  const lists: string[][] = [];
  for (const key of ['add', 'remove'] as const) {
    if (b[key] === undefined) {
      lists.push([]);
      continue;
    }
    const list = idList(b[key], key, DOCUMENT_ID_PATTERN, MAX_DOCUMENTS_PER_TENANT);
    if (!list.ok) return list;
    lists.push(list.value);
  }
  const [add, remove] = lists;
  if (add.length + remove.length === 0) return bad('add');
  const removing = new Set(remove);
  if (add.some((id) => removing.has(id))) return bad('add');
  if (b.force !== undefined && typeof b.force !== 'boolean') return bad('force');
  return { ok: true, value: { add, remove, force: b.force === true } };
}

/** Body of PUT /program-documents/documents/:id/controls: the whole set of control ids and the set the client last saw. */
export function validateDocumentControlsInput(body: unknown): DocumentValidation<{ controlIds: string[]; expectedControlIds: string[] }> {
  if (!isRecord(body)) return bad('body');
  const controlIds = idList(body.controlIds, 'controlIds', DOCUMENT_CONTROL_ID_PATTERN, MAX_CONTROLS_PER_DOCUMENT);
  if (!controlIds.ok) return controlIds;
  const expected = idList(body.expectedControlIds, 'expectedControlIds', DOCUMENT_CONTROL_ID_PATTERN, MAX_CONTROLS_PER_DOCUMENT);
  if (!expected.ok) return expected;
  return { ok: true, value: { controlIds: controlIds.value, expectedControlIds: expected.value } };
}

/** Body of POST /program-documents/documents/:id/attachments. */
export function validateAttachmentInput(body: unknown): DocumentValidation<{ evidenceId: string; primary: boolean }> {
  if (!isRecord(body)) return bad('body');
  if (typeof body.evidenceId !== 'string' || !DOCUMENT_EVIDENCE_ID_PATTERN.test(body.evidenceId)) return bad('evidenceId');
  if (body.primary !== undefined && typeof body.primary !== 'boolean') return bad('primary');
  return { ok: true, value: { evidenceId: body.evidenceId, primary: body.primary === true } };
}

/** Body of PATCH /program-documents/documents/:id/attachments/:evidenceId. */
export function validatePrimaryInput(body: unknown): DocumentValidation<{ primary: boolean }> {
  if (!isRecord(body) || typeof body.primary !== 'boolean') return bad('primary');
  return { ok: true, value: { primary: body.primary } };
}

/** Body of PUT /program-documents/expectations/:expectedId: the whole set of document ids and the set the client last saw. */
export function validateExpectationInput(body: unknown): DocumentValidation<{ documentIds: string[]; expectedDocumentIds: string[] }> {
  if (!isRecord(body)) return bad('body');
  const documentIds = idList(body.documentIds, 'documentIds', DOCUMENT_ID_PATTERN, MAX_DOCUMENTS_PER_TENANT);
  if (!documentIds.ok) return documentIds;
  const expected = idList(body.expectedDocumentIds, 'expectedDocumentIds', DOCUMENT_ID_PATTERN, MAX_DOCUMENTS_PER_TENANT);
  if (!expected.ok) return expected;
  return { ok: true, value: { documentIds: documentIds.value, expectedDocumentIds: expected.value } };
}
