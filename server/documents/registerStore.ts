import crypto from 'crypto';
import type pg from 'pg';
import { nextStamp } from '../db';
import { matchesExpected, notesDigest, StaleWriteError } from '../controlAssessments';
import { __resetInventoryEventsForTests, inTenantTx, insertEventTx, isMemory, pushMemoryInventoryEvent, type EventFields, type InventoryActor, type Q } from '../inventory/events';
import { approvalClearingChange, type ApprovalInput, type DocumentInputWithSeed } from '../../src/data/documents/documentSchema';
import { MAX_DOCUMENTS_PER_TENANT, type DocumentKind, type DocumentOrigin, type DocumentStatus, type GovernanceDocument } from '../../src/types/documents';

/**
 * The document register (issues #240, #250): governance documents (plans, policies, procedures, worksheets, references, review records and
 * artifacts), tenant-wide like the Tools and Services register. A program's membership, control links, attachments and expected-document links live in
 * programDocumentsStore.ts.
 *
 * Tenant isolation: every PostgreSQL statement runs in a transaction that sets app.current_tenant_id, and the tables have FORCE ROW LEVEL SECURITY with
 * that tenant policy (see schema.ts), on top of an explicit tenant_id filter. The in-memory store (DB_MODE=memory) filters by tenant id. Its writes
 * never await between a check and the write, so they are atomic on the event loop.
 *
 * Titles, owners, locations, references and notes may be CUI: they are never logged and never put in an error message or a history event (digests only,
 * in inventory_events with entity_kind 'document'). An update needs the stamp the client loaded (expectedUpdatedAt) and fails with StaleWriteError when
 * the row changed since. The approver always comes from the session. Nothing here fetches a location or reads a file.
 */

export type DocumentErrorCode =
  | 'invalid'
  | 'not_found'
  | 'document_not_found'
  | 'document_not_in_program'
  | 'duplicate_title'
  | 'duplicate_seed'
  | 'limit'
  | 'stale_write'
  | 'not_reviewed'
  | 'retired'
  | 'invalid_document_ids'
  | 'unknown_documents'
  | 'document_in_use'
  | 'control_not_in_program'
  | 'evidence_not_found'
  | 'inherited_evidence'
  | 'unknown_expected_document';

export class DocumentError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
    /** Extra facts for the caller (counts and ids only, never a title or a text). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export const DOCUMENT_STATUS: Record<DocumentErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  document_not_found: 404,
  document_not_in_program: 409,
  duplicate_title: 409,
  duplicate_seed: 409,
  limit: 429,
  stale_write: 409,
  not_reviewed: 409,
  retired: 409,
  invalid_document_ids: 400,
  unknown_documents: 400,
  document_in_use: 409,
  control_not_in_program: 400,
  evidence_not_found: 404,
  inherited_evidence: 400,
  unknown_expected_document: 400,
};

const isUniqueViolation = (err: unknown, constraint?: string): boolean =>
  (err as { code?: string })?.code === '23505' && (constraint === undefined || (err as { constraint?: string }).constraint === constraint);

const titleTaken = (): DocumentError => new DocumentError('duplicate_title', 'A document with that title already exists');
const missing = (): DocumentError => new DocumentError('not_found', 'Document not found');
const retiredError = (): DocumentError => new DocumentError('retired', 'A retired document cannot be approved: reinstate it first');
const notReviewed = (): DocumentError => new DocumentError('not_reviewed', 'A generated or AI-assisted document needs the reviewer to confirm it was reviewed');
const tooMany = (): DocumentError => new DocumentError('limit', 'This organization has reached the maximum number of documents');
const seedTaken = (documentId: string): DocumentError => new DocumentError('duplicate_seed', 'A document was already registered from that generated draft', { documentId });

const lower = (s: string): string => s.toLowerCase();

let documentLimit = MAX_DOCUMENTS_PER_TENANT;
/** Test hook: lowers the per-tenant limit (null restores it). */
export function __setDocumentLimitForTests(limit: number | null): void {
  documentLimit = limit === null ? MAX_DOCUMENTS_PER_TENANT : limit;
}

// ------------------------------------------------------------------------------------------------ rows

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
/** A DATE column as YYYY-MM-DD (the driver returns a Date at local midnight). */
const dateOnly = (v: unknown): string | null =>
  v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : ((v as string | null | undefined) ?? null);

function rowToDocument(r: pg.QueryResultRow): GovernanceDocument {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind as DocumentKind,
    title: r.title,
    reference: r.reference ?? '',
    owner: r.owner ?? '',
    version: r.version ?? '',
    status: r.status as DocumentStatus,
    approvalDate: dateOnly(r.approval_date),
    reviewBy: dateOnly(r.review_by),
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at ? iso(r.approved_at) : null,
    locationUrl: r.location_url ?? null,
    origin: r.origin as DocumentOrigin,
    seedKey: r.seed_key ?? null,
    notes: r.notes ?? '',
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by ?? null,
  };
}

// ------------------------------------------------------------------------------------------------ history

type Snapshot = Pick<GovernanceDocument, 'kind' | 'title' | 'reference' | 'owner' | 'version' | 'status' | 'approvalDate' | 'reviewBy' | 'locationUrl' | 'origin' | 'notes'>;

const DOC_TEXT = ['title', 'reference', 'owner', 'version', 'locationUrl', 'notes'] as const;
const DOC_PLAIN = ['kind', 'status', 'approvalDate', 'reviewBy', 'origin'] as const;
const EMPTY_SNAPSHOT: Snapshot = { kind: 'POLICY', title: '', reference: '', owner: '', version: '', status: 'DRAFT', approvalDate: null, reviewBy: null, locationUrl: null, origin: 'MANUAL', notes: '' };

/** The fields that differ between two versions of a document (before null = a new one). Text as digests only; enums, dates and flags as values. */
function documentEventFields(before: Snapshot | null, after: Snapshot): EventFields {
  const b: Snapshot = before ?? EMPTY_SNAPSHOT;
  const out: EventFields = {};
  for (const key of DOC_TEXT) if (b[key] !== after[key]) out[key] = notesDigest(String(after[key] ?? ''));
  for (const key of DOC_PLAIN) if (b[key] !== after[key] || (before === null && key === 'kind')) out[key] = (after[key] ?? null) as string | null;
  return out;
}

// ------------------------------------------------------------------------------------------------ memory store

const memoryDocuments = new Map<string, GovernanceDocument>(); // key: id

/** Test hook (also clears the history). */
export function __resetDocumentsForTests(): void {
  memoryDocuments.clear();
  documentLimit = MAX_DOCUMENTS_PER_TENANT;
  __resetInventoryEventsForTests();
}

/** The ids of the tenant's documents in the memory store (programDocumentsStore intersects its own rows with them, as the foreign keys would). */
export function memoryDocumentIds(tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const d of memoryDocuments.values()) if (d.tenantId === tenantId) ids.add(d.id);
  return ids;
}

const mine = (tenantId: string): GovernanceDocument[] => [...memoryDocuments.values()].filter((d) => d.tenantId === tenantId);
const byTitle = (a: GovernanceDocument, b: GovernanceDocument): number => lower(a.title).localeCompare(lower(b.title)) || a.createdAt.localeCompare(b.createdAt);
const titleClash = (tenantId: string, title: string, exceptId: string | null): boolean => mine(tenantId).some((d) => d.id !== exceptId && d.status !== 'RETIRED' && lower(d.title) === lower(title));

// ------------------------------------------------------------------------------------------------ reads

/** Every document of the tenant, by title. */
export async function listDocuments(tenantId: string): Promise<GovernanceDocument[]> {
  if (isMemory()) return mine(tenantId).sort(byTitle).map((d) => ({ ...d }));
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM governance_documents WHERE tenant_id = $1 ORDER BY lower(title), created_at LIMIT $2', [tenantId, MAX_DOCUMENTS_PER_TENANT]);
    return res.rows.map(rowToDocument);
  });
}

export async function getDocument(tenantId: string, id: string): Promise<GovernanceDocument | null> {
  if (isMemory()) {
    const d = memoryDocuments.get(id);
    return d && d.tenantId === tenantId ? { ...d } : null;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM governance_documents WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToDocument(res.rows[0]) : null;
  });
}

/** How many of the ids are documents of the tenant (the program store checks its links with it). */
export async function countTenantDocuments(q: Q, tenantId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await q('SELECT id FROM governance_documents WHERE tenant_id = $1 AND id = ANY($2::text[])', [tenantId, [...new Set(ids)]]);
  return res.rows.length;
}

// ------------------------------------------------------------------------------------------------ create

const INSERT_DOCUMENT = `INSERT INTO governance_documents (tenant_id, kind, title, reference, owner, version, review_by, location_url, origin, seed_key, notes, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $12) RETURNING *`;

/** Adds a DRAFT document (status, approval and approver are never taken from the input). Throws limit, duplicate_title and duplicate_seed ({ documentId }). */
export async function createDocument(tenantId: string, input: DocumentInputWithSeed, who: InventoryActor): Promise<GovernanceDocument> {
  const f = {
    kind: input.kind as DocumentKind,
    title: input.title as string,
    reference: input.reference ?? '',
    owner: input.owner ?? '',
    version: input.version ?? '',
    reviewBy: input.reviewBy ?? null,
    locationUrl: input.locationUrl ?? null,
    origin: input.origin ?? 'MANUAL',
    seedKey: input.seedKey ?? null,
    notes: input.notes ?? '',
  };
  const actor = who.actor.slice(0, 255);
  const eventOf = (d: GovernanceDocument): EventFields => ({ ...documentEventFields(null, d), origin: d.origin });

  if (isMemory()) {
    const all = mine(tenantId);
    if (all.length >= documentLimit) throw tooMany();
    const seeded = f.seedKey === null ? undefined : all.find((d) => d.seedKey === f.seedKey);
    if (seeded) throw seedTaken(seeded.id);
    if (titleClash(tenantId, f.title, null)) throw titleTaken();
    const now = nextStamp();
    const doc: GovernanceDocument = {
      ...f,
      id: crypto.randomUUID(),
      tenantId,
      status: 'DRAFT',
      approvalDate: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
      updatedBy: actor,
    };
    memoryDocuments.set(doc.id, doc);
    pushMemoryInventoryEvent(tenantId, 'document', doc.id, 'created', who, eventOf(doc));
    return { ...doc };
  }

  try {
    return await inTenantTx(tenantId, async (q) => {
      const count = await q('SELECT COUNT(*)::int AS n FROM governance_documents WHERE tenant_id = $1', [tenantId]);
      if (Number(count.rows[0].n) >= documentLimit) throw tooMany();
      if (f.seedKey !== null) {
        const seeded = await q('SELECT id FROM governance_documents WHERE tenant_id = $1 AND seed_key = $2', [tenantId, f.seedKey]);
        if (seeded.rows[0]) throw seedTaken(String(seeded.rows[0].id));
      }
      const res = await q(INSERT_DOCUMENT, [tenantId, f.kind, f.title, f.reference, f.owner, f.version, f.reviewBy, f.locationUrl, f.origin, f.seedKey, f.notes, actor]);
      const doc = rowToDocument(res.rows[0]);
      await insertEventTx(q, tenantId, 'document', doc.id, 'created', who, eventOf(doc));
      return doc;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_governance_documents_title')) throw titleTaken();
    if (isUniqueViolation(err, 'unq_governance_documents_seed') && f.seedKey !== null) {
      const existing = await inTenantTx(tenantId, (q) => q('SELECT id FROM governance_documents WHERE tenant_id = $1 AND seed_key = $2', [tenantId, f.seedKey]));
      if (existing.rows[0]) throw seedTaken(String(existing.rows[0].id));
    }
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ update

const DOCUMENT_COLUMNS = {
  kind: 'kind', title: 'title', reference: 'reference', owner: 'owner', version: 'version', reviewBy: 'review_by', locationUrl: 'location_url', notes: 'notes',
} as const;
type DocumentKey = keyof typeof DOCUMENT_COLUMNS;
const DOCUMENT_DATE_KEYS: ReadonlySet<string> = new Set(['reviewBy']);

const CLEARED_APPROVAL_SQL = "status = 'DRAFT', approval_date = NULL, approved_by = NULL, approved_by_user_id = NULL, approved_at = NULL";

function changedKeys(before: GovernanceDocument, patch: DocumentInputWithSeed): DocumentKey[] {
  return (Object.keys(DOCUMENT_COLUMNS) as DocumentKey[]).filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
}

const clearedApproval = { status: 'DRAFT' as const, approvalDate: null, approvedBy: null, approvedAt: null };

/**
 * Changes the fields sent. `expectedUpdatedAt` is the stamp the client loaded: another stamp is a StaleWriteError (nothing written), checked before
 * anything else. A change of version, title, kind or location clears an approval (approvalCleared true). A write that changes nothing writes no row
 * and no event (changed false). Throws not_found and duplicate_title.
 */
export async function updateDocument(
  tenantId: string,
  id: string,
  patch: DocumentInputWithSeed,
  expectedUpdatedAt: string,
  who: InventoryActor
): Promise<{ document: GovernanceDocument; changed: boolean; approvalCleared: boolean }> {
  const stale = (d: GovernanceDocument): StaleWriteError => new StaleWriteError({ updatedAt: d.updatedAt, updatedBy: d.updatedBy });
  const actor = who.actor.slice(0, 255);

  if (isMemory()) {
    const m = memoryDocuments.get(id);
    if (!m || m.tenantId !== tenantId) throw missing();
    if (!matchesExpected(m.updatedAt, expectedUpdatedAt)) throw stale(m);
    const keys = changedKeys(m, patch);
    if (keys.length === 0) return { document: { ...m }, changed: false, approvalCleared: false };
    const clears = m.status === 'APPROVED' && approvalClearingChange(m, patch);
    const nextTitle = keys.includes('title') ? (patch.title as string) : m.title;
    if ((keys.includes('title') || clears) && m.status !== 'RETIRED' && titleClash(tenantId, nextTitle, id)) throw titleTaken();
    const before: GovernanceDocument = { ...m };
    Object.assign(m, Object.fromEntries(keys.map((k) => [k, patch[k]])), clears ? clearedApproval : {}, { updatedAt: nextStamp(m.updatedAt), updatedBy: actor });
    pushMemoryInventoryEvent(tenantId, 'document', id, 'updated', who, { ...documentEventFields(before, m), ...(clears ? { approvalCleared: true } : {}) });
    return { document: { ...m }, changed: true, approvalCleared: clears };
  }

  try {
    return await inTenantTx(tenantId, async (q) => {
      const cur = await q('SELECT * FROM governance_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
      if (!cur.rows[0]) throw missing();
      const before = rowToDocument(cur.rows[0]);
      if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw stale(before);
      const keys = changedKeys(before, patch);
      if (keys.length === 0) return { document: before, changed: false, approvalCleared: false };
      const clears = before.status === 'APPROVED' && approvalClearingChange(before, patch);
      const params: unknown[] = [];
      const sets: string[] = [];
      for (const k of keys) {
        params.push(patch[k]);
        sets.push(`${DOCUMENT_COLUMNS[k]} = $${params.length}${DOCUMENT_DATE_KEYS.has(k) ? '::date' : ''}`);
      }
      if (clears) sets.push(CLEARED_APPROVAL_SQL);
      params.push(actor);
      sets.push(`updated_by = $${params.length}`, "updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')");
      params.push(id, tenantId);
      const res = await q(`UPDATE governance_documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`, params);
      const document = rowToDocument(res.rows[0]);
      await insertEventTx(q, tenantId, 'document', id, 'updated', who, { ...documentEventFields(before, document), ...(clears ? { approvalCleared: true } : {}) });
      return { document, changed: true, approvalCleared: clears };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_governance_documents_title')) throw titleTaken();
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ approval and status

/**
 * Approves the document: the approver and the time come from the session and the server (never the body), the version and the dates from the input.
 * Another stamp is a StaleWriteError, checked first; a RETIRED document is refused (retired); a GENERATED or AI_ASSISTED one needs confirmReviewed
 * (not_reviewed). Approving an approved document again records the new version and dates.
 */
export async function approveDocument(tenantId: string, id: string, input: ApprovalInput, expectedUpdatedAt: string, who: InventoryActor): Promise<GovernanceDocument> {
  const stale = (d: GovernanceDocument): StaleWriteError => new StaleWriteError({ updatedAt: d.updatedAt, updatedBy: d.updatedBy });
  const actor = who.actor.slice(0, 255);
  const userId = who.userId ? who.userId.slice(0, 128) : null;
  const gate = (d: GovernanceDocument): void => {
    if (!matchesExpected(d.updatedAt, expectedUpdatedAt)) throw stale(d);
    if (d.status === 'RETIRED') throw retiredError();
    if (d.origin !== 'MANUAL' && !input.confirmReviewed) throw notReviewed();
  };
  const eventOf = (before: Snapshot, after: GovernanceDocument): EventFields => ({ ...documentEventFields(before, after), reviewedConfirmed: input.confirmReviewed });

  if (isMemory()) {
    const m = memoryDocuments.get(id);
    if (!m || m.tenantId !== tenantId) throw missing();
    gate(m);
    const before: GovernanceDocument = { ...m };
    Object.assign(m, {
      status: 'APPROVED',
      version: input.version,
      approvalDate: input.approvalDate,
      reviewBy: input.reviewBy,
      approvedBy: actor,
      approvedAt: new Date().toISOString(),
      updatedAt: nextStamp(m.updatedAt),
      updatedBy: actor,
    });
    pushMemoryInventoryEvent(tenantId, 'document', id, 'approved', who, eventOf(before, m));
    return { ...m };
  }

  return inTenantTx(tenantId, async (q) => {
    const cur = await q('SELECT * FROM governance_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
    if (!cur.rows[0]) throw missing();
    const before = rowToDocument(cur.rows[0]);
    gate(before);
    const res = await q(
      `UPDATE governance_documents SET status = 'APPROVED', version = $3, approval_date = $4::date, review_by = $5::date, approved_by = $6, approved_by_user_id = $7,
          approved_at = NOW(), updated_by = $6, updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, input.version, input.approvalDate, input.reviewBy, actor, userId]
    );
    const document = rowToDocument(res.rows[0]);
    await insertEventTx(q, tenantId, 'document', id, 'approved', who, eventOf(before, document));
    return document;
  });
}

/**
 * Moves the document to DRAFT (withdraws an approval, or reinstates a retired document) or to RETIRED; either way the approval is cleared. The stamp
 * is checked first. Reinstating a document whose title is now used by another live document is duplicate_title. Same status = changed false.
 */
export async function setDocumentStatus(
  tenantId: string,
  id: string,
  status: 'DRAFT' | 'RETIRED',
  expectedUpdatedAt: string,
  who: InventoryActor
): Promise<{ document: GovernanceDocument; changed: boolean }> {
  const stale = (d: GovernanceDocument): StaleWriteError => new StaleWriteError({ updatedAt: d.updatedAt, updatedBy: d.updatedBy });
  const actor = who.actor.slice(0, 255);

  if (isMemory()) {
    const m = memoryDocuments.get(id);
    if (!m || m.tenantId !== tenantId) throw missing();
    if (!matchesExpected(m.updatedAt, expectedUpdatedAt)) throw stale(m);
    if (m.status === status) return { document: { ...m }, changed: false };
    if (status === 'DRAFT' && titleClash(tenantId, m.title, id)) throw titleTaken();
    const before: GovernanceDocument = { ...m };
    Object.assign(m, { ...clearedApproval, status, updatedAt: nextStamp(m.updatedAt), updatedBy: actor });
    pushMemoryInventoryEvent(tenantId, 'document', id, 'status_changed', who, { ...documentEventFields(before, m), withdrawnApproval: before.status === 'APPROVED' });
    return { document: { ...m }, changed: true };
  }

  try {
    return await inTenantTx(tenantId, async (q) => {
      const cur = await q('SELECT * FROM governance_documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
      if (!cur.rows[0]) throw missing();
      const before = rowToDocument(cur.rows[0]);
      if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw stale(before);
      if (before.status === status) return { document: before, changed: false };
      const res = await q(
        `UPDATE governance_documents SET ${CLEARED_APPROVAL_SQL}, status = $3, updated_by = $4, updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, tenantId, status, actor]
      );
      const document = rowToDocument(res.rows[0]);
      await insertEventTx(q, tenantId, 'document', id, 'status_changed', who, { ...documentEventFields(before, document), withdrawnApproval: before.status === 'APPROVED' });
      return { document, changed: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_governance_documents_title')) throw titleTaken();
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ delete

/** Removes a document; its program membership, control links, attachment links and expected-document links go with it (foreign key cascades). False when it does not exist. */
export async function deleteDocument(tenantId: string, id: string, who: InventoryActor): Promise<boolean> {
  if (isMemory()) {
    const m = memoryDocuments.get(id);
    if (!m || m.tenantId !== tenantId) return false;
    memoryDocuments.delete(id);
    pushMemoryInventoryEvent(tenantId, 'document', id, 'deleted', who, {});
    return true;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('DELETE FROM governance_documents WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, tenantId, 'document', id, 'deleted', who, {});
    return true;
  });
}
