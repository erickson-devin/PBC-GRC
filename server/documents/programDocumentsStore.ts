import type pg from 'pg';
import { queryWithProgram, type ProgramScope } from '../db';
import { inTenantTx, isMemory, type InventoryActor, type Q } from '../inventory/events';
import { __pushProgramInventoryEventForMemory } from '../inventory/programInventoryStore';
import { DocumentError, countTenantDocuments, memoryDocumentIds } from './registerStore';
import {
  MAX_ATTACHMENTS_PER_DOCUMENT,
  MAX_CONTROLS_PER_DOCUMENT,
  MAX_DOCUMENT_LINKS_PER_PROGRAM,
  MAX_EXPECTATION_LINKS_PER_PROGRAM,
  type DocumentAttachment,
  type ProgramDocuments,
} from '../../src/types/documents';

/**
 * A program's side of the document register (issues #240, #250): which documents it declares (none declared = every document of the tenant applies, like
 * the boundary tools of programInventoryStore.ts), the controls each document is linked to (validated against the program's own catalog by the route),
 * the attachments (evidence ids of this program, at most one primary per document) and the expected-document links of the checklist. The documents
 * themselves live in registerStore.ts, tenant-wide.
 *
 * PostgreSQL: every table here has the tenant and the program row policies, so each statement runs in a transaction that sets both settings; deleting a
 * document or a program removes its rows through the foreign keys. The in-memory store keeps its own maps and intersects every read with the live
 * document ids of the tenant, which gives readers the same answer as the cascades. Its writes never await between a check and the write.
 *
 * An attachment whose evidence record was deleted stays listed (there is no foreign key): the client shows it as "file removed".
 * Only ids, flags, counts and enum values are stored in the history (program_inventory_events): never a title, a location or a note.
 */

const sortIds = (ids: Iterable<string>): string[] => [...ids].sort();
/** Ids kept per list in a history event (the counts are always exact). */
const MAX_EVENT_IDS = 200;
const cap = (ids: string[]): { ids: string[]; truncated: boolean } => ({ ids: ids.slice(0, MAX_EVENT_IDS), truncated: ids.length > MAX_EVENT_IDS });
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const keyOf = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && sortIds(a).every((id, i) => id === sortIds(b)[i]);
const actorName = (who: InventoryActor): string => who.actor.slice(0, 255);

// ------------------------------------------------------------------------------------------------ memory store

interface MemoryProgram {
  members: Set<string>;
  controls: Map<string, Set<string>>; // documentId -> controlIds
  attachments: DocumentAttachment[];
  expectations: Map<string, Set<string>>; // expectedId -> documentIds
}
const memoryPrograms = new Map<string, MemoryProgram>(); // key: tenantId__programId

const blank = (): MemoryProgram => ({ members: new Set(), controls: new Map(), attachments: [], expectations: new Map() });
function memoryOf(scope: ProgramScope): MemoryProgram {
  let m = memoryPrograms.get(keyOf(scope));
  if (!m) {
    m = blank();
    memoryPrograms.set(keyOf(scope), m);
  }
  return m;
}

/** Test hook. (The history lives in the shared program_inventory_events store of programInventoryStore.) */
export function __resetProgramDocumentsForTests(): void {
  memoryPrograms.clear();
}

/** The rows of a deleted program go with it (in PostgreSQL the foreign keys cascade). */
export function __deleteProgramDocumentsForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryPrograms.delete(keyOf(scope));
}

/** Test hook: how many rows (members, control links, attachments, expectation links) the memory store holds for the program. */
export function __programDocumentRowsForTests(scope: ProgramScope): number {
  const m = memoryPrograms.get(keyOf(scope));
  if (!m) return 0;
  let n = m.members.size + m.attachments.length;
  for (const c of m.controls.values()) n += c.size;
  for (const e of m.expectations.values()) n += e.size;
  return n;
}

// ------------------------------------------------------------------------------------------------ history

/** One event in the program's inventory history (the same table programInventoryStore reads), recorded in the writer's own transaction. */
async function insertEventTx(q: Q, scope: ProgramScope, action: string, entityId: string | null, who: InventoryActor, detail: Record<string, unknown>): Promise<void> {
  await q(
    `INSERT INTO program_inventory_events (tenant_id, program_id, action, entity_id, actor, actor_user_id, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp())`,
    [scope.tenantId, scope.programId, action, entityId, actorName(who), who.userId ? who.userId.slice(0, 128) : null, JSON.stringify(detail)]
  );
}

/** The memory store shares the history list of programInventoryStore: its reader (listProgramInventoryEvents) filters by tenant and program. */
function pushEvent(scope: ProgramScope, action: string, entityId: string | null, who: InventoryActor, detail: Record<string, unknown>): void {
  __pushProgramInventoryEventForMemory(scope, action, entityId, who, detail);
}

// ------------------------------------------------------------------------------------------------ PostgreSQL helpers

/** One transaction under the tenant's and the program's row policies. */
function inProgramTx<T>(scope: ProgramScope, fn: (q: Q) => Promise<T>): Promise<T> {
  return inTenantTx(scope.tenantId, async (q) => {
    await q('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    return fn(q);
  });
}

/** Serializes the program's document writers (a lock that does not block the foreign keys of other tables). */
const lockProgram = (q: Q, scope: ProgramScope): Promise<pg.QueryResult> => q('SELECT 1 FROM programs WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE', [scope.tenantId, scope.programId]);

async function membersTx(q: Q, scope: ProgramScope): Promise<string[]> {
  const res = await q('SELECT document_id FROM program_governance_documents WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  return sortIds(res.rows.map((r) => String(r.document_id)));
}

function attachmentFromRow(r: pg.QueryResultRow): DocumentAttachment {
  return { documentId: String(r.document_id), evidenceId: String(r.evidence_id), isPrimary: r.is_primary === true, linkedAt: iso(r.linked_at), linkedBy: r.linked_by ?? null };
}

const sortAttachments = (list: DocumentAttachment[]): DocumentAttachment[] => list.sort((a, b) => cmp(a.documentId, b.documentId) || cmp(a.evidenceId, b.evidenceId));

// ------------------------------------------------------------------------------------------------ reads

function liveMembers(scope: ProgramScope): string[] {
  const m = memoryPrograms.get(keyOf(scope));
  if (!m) return [];
  const live = memoryDocumentIds(scope.tenantId);
  return sortIds([...m.members].filter((id) => live.has(id)));
}

/** The document ids the program declares, sorted (none = every document of the tenant applies). */
export async function getProgramDocumentIds(scope: ProgramScope): Promise<string[]> {
  if (!hasScope(scope)) return [];
  if (isMemory()) return liveMembers(scope);
  return inProgramTx(scope, (q) => membersTx(q, scope));
}

/** The program's declared documents, control links, attachments and expected-document links. */
export async function readProgramDocuments(scope: ProgramScope): Promise<ProgramDocuments> {
  const empty: ProgramDocuments = { programId: scope.programId, declared: false, documentIds: [], controlLinks: [], attachments: [], expectations: [] };
  if (!hasScope(scope)) return empty;
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    if (!m) return empty;
    const live = memoryDocumentIds(scope.tenantId);
    const documentIds = liveMembers(scope);
    const controlLinks: ProgramDocuments['controlLinks'] = [];
    for (const [documentId, controls] of m.controls) {
      if (!live.has(documentId)) continue;
      for (const controlId of controls) controlLinks.push({ documentId, controlId });
    }
    const expectations: ProgramDocuments['expectations'] = [];
    for (const [expectedId, docs] of m.expectations) {
      for (const documentId of docs) if (live.has(documentId)) expectations.push({ expectedId, documentId });
    }
    return {
      programId: scope.programId,
      declared: documentIds.length > 0,
      documentIds,
      controlLinks: controlLinks.sort((a, b) => cmp(a.documentId, b.documentId) || cmp(a.controlId, b.controlId)),
      attachments: sortAttachments(m.attachments.filter((a) => live.has(a.documentId)).map((a) => ({ ...a }))),
      expectations: expectations.sort((a, b) => cmp(a.expectedId, b.expectedId) || cmp(a.documentId, b.documentId)),
    };
  }
  return inProgramTx(scope, async (q) => {
    const documentIds = await membersTx(q, scope);
    const links = await q('SELECT document_id, control_id FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 LIMIT $3', [scope.tenantId, scope.programId, MAX_DOCUMENT_LINKS_PER_PROGRAM]);
    const attachments = await q('SELECT document_id, evidence_id, is_primary, linked_by, linked_at FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
    const expectations = await q('SELECT expected_id, document_id FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 LIMIT $3', [scope.tenantId, scope.programId, MAX_EXPECTATION_LINKS_PER_PROGRAM]);
    return {
      programId: scope.programId,
      declared: documentIds.length > 0,
      documentIds,
      controlLinks: links.rows.map((r) => ({ documentId: String(r.document_id), controlId: String(r.control_id) })).sort((a, b) => cmp(a.documentId, b.documentId) || cmp(a.controlId, b.controlId)),
      attachments: sortAttachments(attachments.rows.map(attachmentFromRow)),
      expectations: expectations.rows.map((r) => ({ expectedId: String(r.expected_id), documentId: String(r.document_id) })).sort((a, b) => cmp(a.expectedId, b.expectedId) || cmp(a.documentId, b.documentId)),
    };
  });
}

/** How one document is used in the program: declared, linked to controls, with attachments, named in the checklist. */
export async function countDocumentUsage(scope: ProgramScope, documentId: string): Promise<{ member: boolean; controlLinks: number; attachments: number; expectations: number }> {
  const none = { member: false, controlLinks: 0, attachments: 0, expectations: 0 };
  if (!hasScope(scope)) return none;
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    if (!m) return none;
    let expectations = 0;
    for (const docs of m.expectations.values()) if (docs.has(documentId)) expectations++;
    return { member: m.members.has(documentId), controlLinks: m.controls.get(documentId)?.size ?? 0, attachments: m.attachments.filter((a) => a.documentId === documentId).length, expectations };
  }
  return inProgramTx(scope, async (q) => {
    const res = await q(
      `SELECT (SELECT COUNT(*)::int FROM program_governance_documents WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3) AS member,
              (SELECT COUNT(*)::int FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3) AS links,
              (SELECT COUNT(*)::int FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3) AS attachments,
              (SELECT COUNT(*)::int FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3) AS expectations`,
      [scope.tenantId, scope.programId, documentId]
    );
    const r = res.rows[0];
    return { member: Number(r.member) > 0, controlLinks: Number(r.links), attachments: Number(r.attachments), expectations: Number(r.expectations) };
  });
}

// ------------------------------------------------------------------------------------------------ membership

export interface ProgramDocumentsChanged {
  programId: string;
  declared: boolean;
  documentIds: string[];
  added: number;
  removed: number;
}

const inUse = (controlLinks: number, attachments: number, expectations: number): DocumentError =>
  new DocumentError('document_in_use', 'A document you are removing is still linked to controls, has attachments or satisfies an expected document', { controlLinks, attachments, expectations });
const unknownDocuments = (count: number): DocumentError => new DocumentError('unknown_documents', 'Some document ids are not in the register of this organization', { count });
const documentMissing = (): DocumentError => new DocumentError('document_not_found', 'The document was not found in this organization');
const outsideProgram = (): DocumentError => new DocumentError('document_not_in_program', 'The document is not in the set this program declares: add it to the program first');

/**
 * Adds and removes documents in the program's declared set (deltas, so two editors do not overwrite each other). Adding a member or removing a
 * non-member is not a change. Throws unknown_documents ({ count }: an id that is not a document of the tenant) and document_in_use ({ controlLinks,
 * attachments, expectations }) when a removed member still has links, unless `force`: then they are deleted in the same transaction. One
 * `document_membership_changed` event when something changed.
 */
export async function changeProgramDocuments(scope: ProgramScope, change: { add: string[]; remove: string[]; force: boolean }, who: InventoryActor): Promise<ProgramDocumentsChanged> {
  const eventDetail = (added: string[], removed: string[], links: number, attachments: number, expectations: number): Record<string, unknown> => {
    const a = cap(added);
    const r = cap(removed);
    return {
      added: a.ids,
      removed: r.ids,
      addedCount: added.length,
      removedCount: removed.length,
      forced: change.force && links + attachments + expectations > 0,
      controlLinksRemoved: change.force ? links : 0,
      attachmentsRemoved: change.force ? attachments : 0,
      expectationsRemoved: change.force ? expectations : 0,
      truncated: a.truncated || r.truncated,
    };
  };

  if (isMemory()) {
    const live = memoryDocumentIds(scope.tenantId);
    const unknown = change.add.filter((id) => !live.has(id)).length;
    if (unknown > 0) throw unknownDocuments(unknown);
    const m = memoryOf(scope);
    for (const id of [...m.members]) if (!live.has(id)) m.members.delete(id);
    const removing = change.remove.filter((id) => m.members.has(id));
    let links = 0;
    let attachments = 0;
    let expectations = 0;
    for (const id of removing) {
      links += m.controls.get(id)?.size ?? 0;
      attachments += m.attachments.filter((a) => a.documentId === id).length;
      for (const docs of m.expectations.values()) if (docs.has(id)) expectations++;
    }
    if (links + attachments + expectations > 0 && !change.force) throw inUse(links, attachments, expectations);
    for (const id of removing) {
      m.controls.delete(id);
      m.attachments = m.attachments.filter((a) => a.documentId !== id);
      for (const docs of m.expectations.values()) docs.delete(id);
    }
    const added = change.add.filter((id) => !m.members.has(id));
    for (const id of added) m.members.add(id);
    for (const id of removing) m.members.delete(id);
    if (added.length + removing.length > 0) pushEvent(scope, 'document_membership_changed', null, who, eventDetail(sortIds(added), sortIds(removing), links, attachments, expectations));
    return { programId: scope.programId, declared: m.members.size > 0, documentIds: sortIds(m.members), added: added.length, removed: removing.length };
  }

  try {
    return await inProgramTx(scope, async (q) => {
      await lockProgram(q, scope);
      if (change.add.length > 0) {
        const found = await countTenantDocuments(q, scope.tenantId, change.add);
        if (found < new Set(change.add).size) throw unknownDocuments(new Set(change.add).size - found);
      }
      let removing: string[] = [];
      let links = 0;
      let attachments = 0;
      let expectations = 0;
      if (change.remove.length > 0) {
        const members = await q('SELECT document_id FROM program_governance_documents WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])', [scope.tenantId, scope.programId, change.remove]);
        removing = members.rows.map((r) => String(r.document_id));
        if (removing.length > 0) {
          const use = await q(
            `SELECT (SELECT COUNT(*)::int FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])) AS links,
                    (SELECT COUNT(*)::int FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])) AS attachments,
                    (SELECT COUNT(*)::int FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])) AS expectations`,
            [scope.tenantId, scope.programId, removing]
          );
          links = Number(use.rows[0].links);
          attachments = Number(use.rows[0].attachments);
          expectations = Number(use.rows[0].expectations);
          if (links + attachments + expectations > 0 && !change.force) throw inUse(links, attachments, expectations);
          if (links > 0) await q('DELETE FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
          if (attachments > 0) await q('DELETE FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
          if (expectations > 0) await q('DELETE FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
          await q('DELETE FROM program_governance_documents WHERE tenant_id = $1 AND program_id = $2 AND document_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
        }
      }
      let added: string[] = [];
      if (change.add.length > 0) {
        const res = await q(
          `INSERT INTO program_governance_documents (tenant_id, program_id, document_id, added_by)
           SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x
           ON CONFLICT DO NOTHING
           RETURNING document_id`,
          [scope.tenantId, scope.programId, change.add, actorName(who)]
        );
        added = res.rows.map((r) => String(r.document_id));
      }
      if (added.length + removing.length > 0) await insertEventTx(q, scope, 'document_membership_changed', null, who, eventDetail(sortIds(added), sortIds(removing), links, attachments, expectations));
      const documentIds = await membersTx(q, scope);
      return { programId: scope.programId, declared: documentIds.length > 0, documentIds, added: added.length, removed: removing.length };
    });
  } catch (err) {
    // a document deleted between the check and the insert breaks the foreign key
    if ((err as { code?: string })?.code === '23503') throw unknownDocuments(1);
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ control links

const staleControls = (currentControlIds: string[]): DocumentError => new DocumentError('stale_write', 'The control links of this document changed after you loaded them', { currentControlIds });
const staleDocuments = (currentDocumentIds: string[]): DocumentError => new DocumentError('stale_write', 'The documents linked to this expected document changed after you loaded them', { currentDocumentIds });
const linkLimit = (): DocumentError => new DocumentError('limit', 'This program has reached the maximum number of document-to-control links');

/**
 * Replaces the set of controls a document is linked to in this program. `catalogIds` is the program's own control catalog: a control outside it is
 * refused (control_not_in_program, with the control id: ids are not CUI). `expectedControlIds` is the set the client loaded (stale_write, with
 * `currentControlIds`, when it differs). Refused with document_not_found, document_not_in_program (only when the program declares documents) and limit.
 * A write that changes nothing writes no row and no event (changed false). One `document_controls_changed` event otherwise.
 */
export async function putDocumentControls(
  scope: ProgramScope,
  documentId: string,
  controlIds: string[],
  expectedControlIds: string[],
  catalogIds: ReadonlySet<string>,
  who: InventoryActor
): Promise<{ documentId: string; controlIds: string[]; changed: boolean }> {
  const outside = controlIds.find((id) => !catalogIds.has(id));
  if (outside) throw new DocumentError('control_not_in_program', "A control is not part of this program's catalog", { controlId: outside });
  if (controlIds.length > MAX_CONTROLS_PER_DOCUMENT) throw linkLimit();

  const eventDetail = (added: string[], removed: string[]): Record<string, unknown> => {
    const a = cap(added);
    const r = cap(removed);
    return { documentId, added: a.ids, removed: r.ids, addedCount: added.length, removedCount: removed.length, controlCount: controlIds.length, truncated: a.truncated || r.truncated };
  };
  const sorted = sortIds(controlIds);

  if (isMemory()) {
    if (!memoryDocumentIds(scope.tenantId).has(documentId)) throw documentMissing();
    const m = memoryOf(scope);
    const members = liveMembers(scope);
    if (members.length > 0 && !members.includes(documentId)) throw outsideProgram();
    const current = m.controls.get(documentId) ?? new Set<string>();
    if (!sameSet([...current], expectedControlIds)) throw staleControls(sortIds(current));
    const live = memoryDocumentIds(scope.tenantId);
    let others = 0;
    for (const [id, set] of m.controls) if (id !== documentId && live.has(id)) others += set.size;
    if (others + controlIds.length > MAX_DOCUMENT_LINKS_PER_PROGRAM) throw linkLimit();
    const added = sorted.filter((id) => !current.has(id));
    const removed = sortIds([...current].filter((id) => !controlIds.includes(id)));
    if (added.length + removed.length === 0) return { documentId, controlIds: sorted, changed: false };
    if (controlIds.length === 0) m.controls.delete(documentId);
    else m.controls.set(documentId, new Set(controlIds));
    pushEvent(scope, 'document_controls_changed', documentId, who, eventDetail(added, removed));
    return { documentId, controlIds: sorted, changed: true };
  }

  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    if ((await countTenantDocuments(q, scope.tenantId, [documentId])) === 0) throw documentMissing();
    const members = await membersTx(q, scope);
    if (members.length > 0 && !members.includes(documentId)) throw outsideProgram();
    const res = await q('SELECT control_id FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3', [scope.tenantId, scope.programId, documentId]);
    const current = new Set(res.rows.map((r) => String(r.control_id)));
    if (!sameSet([...current], expectedControlIds)) throw staleControls(sortIds(current));
    const others = await q('SELECT COUNT(*)::int AS n FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id <> $3', [scope.tenantId, scope.programId, documentId]);
    if (Number(others.rows[0].n) + controlIds.length > MAX_DOCUMENT_LINKS_PER_PROGRAM) throw linkLimit();
    const added = sorted.filter((id) => !current.has(id));
    const removed = sortIds([...current].filter((id) => !controlIds.includes(id)));
    if (added.length + removed.length === 0) return { documentId, controlIds: sorted, changed: false };
    if (removed.length > 0) await q('DELETE FROM program_document_controls WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND control_id = ANY($4::text[])', [scope.tenantId, scope.programId, documentId, removed]);
    if (added.length > 0) {
      await q(
        `INSERT INTO program_document_controls (tenant_id, program_id, document_id, control_id, linked_by)
         SELECT $1, $2, $3, x, $5 FROM unnest($4::text[]) AS x`,
        [scope.tenantId, scope.programId, documentId, added, actorName(who)]
      );
    }
    await insertEventTx(q, scope, 'document_controls_changed', documentId, who, eventDetail(added, removed));
    return { documentId, controlIds: sorted, changed: true };
  });
}

// ------------------------------------------------------------------------------------------------ attachments

/** The same statement the evidence routes use: a record of this program (or a legacy one that has no program yet). */
const EVIDENCE_LOOKUP = 'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)';

const attachmentLimit = (): DocumentError => new DocumentError('limit', 'This document already has the maximum number of attachments in this program');

/**
 * Links an evidence record of this program to a document. The evidence id is checked against the program (evidence_not_found; an inherited copy,
 * whose id holds "__inh_", is refused as inherited_evidence), the document against the tenant (document_not_found) and the program's declared set
 * (document_not_in_program). `primary: true` makes it the document's one primary copy and demotes the old one in the same transaction. Linking the
 * same pair again is not a change (created false, changed false), unless it promotes the link to primary. At most 50 attachments per document (limit).
 */
export async function linkDocumentAttachment(
  scope: ProgramScope,
  documentId: string,
  input: { evidenceId: string; primary: boolean },
  who: InventoryActor
): Promise<{ attachment: DocumentAttachment; created: boolean; changed: boolean }> {
  if (input.evidenceId.includes('__inh_')) throw new DocumentError('inherited_evidence', 'An inherited evidence copy cannot be attached: attach the original record');
  const found = await queryWithProgram(scope, EVIDENCE_LOOKUP, [input.evidenceId, scope.tenantId, scope.programId]);
  if (!found.rows.some((r) => r.tenant_id === scope.tenantId)) throw new DocumentError('evidence_not_found', 'The evidence record was not found in this program');
  const eventDetail = (previous: string | null): Record<string, unknown> => ({ evidenceId: input.evidenceId, primary: input.primary, previousPrimary: previous });

  if (isMemory()) {
    if (!memoryDocumentIds(scope.tenantId).has(documentId)) throw documentMissing();
    const m = memoryOf(scope);
    const members = liveMembers(scope);
    if (members.length > 0 && !members.includes(documentId)) throw outsideProgram();
    const mineAll = m.attachments.filter((a) => a.documentId === documentId);
    const existing = mineAll.find((a) => a.evidenceId === input.evidenceId);
    const oldPrimary = mineAll.find((a) => a.isPrimary && a.evidenceId !== input.evidenceId) ?? null;
    if (existing) {
      if (!input.primary || existing.isPrimary) return { attachment: { ...existing }, created: false, changed: false };
      if (oldPrimary) oldPrimary.isPrimary = false;
      existing.isPrimary = true;
      pushEvent(scope, 'document_primary_changed', documentId, who, eventDetail(oldPrimary?.evidenceId ?? null));
      return { attachment: { ...existing }, created: false, changed: true };
    }
    if (mineAll.length >= MAX_ATTACHMENTS_PER_DOCUMENT) throw attachmentLimit();
    if (input.primary && oldPrimary) oldPrimary.isPrimary = false;
    const attachment: DocumentAttachment = { documentId, evidenceId: input.evidenceId, isPrimary: input.primary, linkedAt: new Date().toISOString(), linkedBy: actorName(who) };
    m.attachments.push(attachment);
    pushEvent(scope, 'document_attachment_linked', documentId, who, eventDetail(input.primary ? (oldPrimary?.evidenceId ?? null) : null));
    return { attachment: { ...attachment }, created: true, changed: true };
  }

  try {
    return await inProgramTx(scope, async (q) => {
      await lockProgram(q, scope);
      if ((await countTenantDocuments(q, scope.tenantId, [documentId])) === 0) throw documentMissing();
      const members = await membersTx(q, scope);
      if (members.length > 0 && !members.includes(documentId)) throw outsideProgram();
      const rows = await q(
        'SELECT document_id, evidence_id, is_primary, linked_by, linked_at FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 FOR UPDATE',
        [scope.tenantId, scope.programId, documentId]
      );
      const all = rows.rows.map(attachmentFromRow);
      const existing = all.find((a) => a.evidenceId === input.evidenceId);
      const oldPrimary = all.find((a) => a.isPrimary && a.evidenceId !== input.evidenceId) ?? null;
      const demote = (): Promise<pg.QueryResult> =>
        q('UPDATE program_document_attachments SET is_primary = FALSE WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND is_primary', [scope.tenantId, scope.programId, documentId]);
      if (existing) {
        if (!input.primary || existing.isPrimary) return { attachment: existing, created: false, changed: false };
        await demote();
        await q('UPDATE program_document_attachments SET is_primary = TRUE WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND evidence_id = $4', [scope.tenantId, scope.programId, documentId, input.evidenceId]);
        await insertEventTx(q, scope, 'document_primary_changed', documentId, who, eventDetail(oldPrimary?.evidenceId ?? null));
        return { attachment: { ...existing, isPrimary: true }, created: false, changed: true };
      }
      if (all.length >= MAX_ATTACHMENTS_PER_DOCUMENT) throw attachmentLimit();
      if (input.primary && oldPrimary) await demote();
      const res = await q(
        `INSERT INTO program_document_attachments (tenant_id, program_id, document_id, evidence_id, is_primary, linked_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING document_id, evidence_id, is_primary, linked_by, linked_at`,
        [scope.tenantId, scope.programId, documentId, input.evidenceId, input.primary, actorName(who)]
      );
      await insertEventTx(q, scope, 'document_attachment_linked', documentId, who, eventDetail(input.primary ? (oldPrimary?.evidenceId ?? null) : null));
      return { attachment: attachmentFromRow(res.rows[0]), created: true, changed: true };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23503') throw documentMissing();
    throw err;
  }
}

/**
 * Makes one attachment the primary copy of its document (demoting the old one), or clears its primary flag. Returns the document's attachments, or null
 * when the pair is not linked. Setting the state it already has is not a change (no event).
 */
export async function setAttachmentPrimary(scope: ProgramScope, documentId: string, evidenceId: string, primary: boolean, who: InventoryActor): Promise<DocumentAttachment[] | null> {
  if (!hasScope(scope)) return null;
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    if (!m || !memoryDocumentIds(scope.tenantId).has(documentId)) return null;
    const mineAll = m.attachments.filter((a) => a.documentId === documentId);
    const target = mineAll.find((a) => a.evidenceId === evidenceId);
    if (!target) return null;
    if (target.isPrimary !== primary) {
      const oldPrimary = mineAll.find((a) => a.isPrimary && a.evidenceId !== evidenceId) ?? null;
      if (primary && oldPrimary) oldPrimary.isPrimary = false;
      target.isPrimary = primary;
      pushEvent(scope, 'document_primary_changed', documentId, who, { evidenceId, primary, previousPrimary: primary ? (oldPrimary?.evidenceId ?? null) : null });
    }
    return sortAttachments(mineAll.map((a) => ({ ...a })));
  }
  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    const rows = await q(
      'SELECT document_id, evidence_id, is_primary, linked_by, linked_at FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 FOR UPDATE',
      [scope.tenantId, scope.programId, documentId]
    );
    const all = rows.rows.map(attachmentFromRow);
    const target = all.find((a) => a.evidenceId === evidenceId);
    if (!target) return null;
    if (target.isPrimary !== primary) {
      const oldPrimary = all.find((a) => a.isPrimary && a.evidenceId !== evidenceId) ?? null;
      if (primary && oldPrimary) await q('UPDATE program_document_attachments SET is_primary = FALSE WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND is_primary', [scope.tenantId, scope.programId, documentId]);
      await q('UPDATE program_document_attachments SET is_primary = $5 WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND evidence_id = $4', [scope.tenantId, scope.programId, documentId, evidenceId, primary]);
      await insertEventTx(q, scope, 'document_primary_changed', documentId, who, { evidenceId, primary, previousPrimary: primary ? (oldPrimary?.evidenceId ?? null) : null });
      for (const a of all) {
        if (a.evidenceId === evidenceId) a.isPrimary = primary;
        else if (primary) a.isPrimary = false;
      }
    }
    return sortAttachments(all);
  });
}

/** Removes an attachment link (the evidence record itself stays). False when there is no such link. */
export async function unlinkDocumentAttachment(scope: ProgramScope, documentId: string, evidenceId: string, who: InventoryActor): Promise<boolean> {
  if (!hasScope(scope)) return false;
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    const at = m ? m.attachments.findIndex((a) => a.documentId === documentId && a.evidenceId === evidenceId) : -1;
    if (!m || at < 0 || !memoryDocumentIds(scope.tenantId).has(documentId)) return false;
    const [removed] = m.attachments.splice(at, 1);
    pushEvent(scope, 'document_attachment_unlinked', documentId, who, { evidenceId, wasPrimary: removed.isPrimary });
    return true;
  }
  return inProgramTx(scope, async (q) => {
    const res = await q('DELETE FROM program_document_attachments WHERE tenant_id = $1 AND program_id = $2 AND document_id = $3 AND evidence_id = $4 RETURNING is_primary', [scope.tenantId, scope.programId, documentId, evidenceId]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, scope, 'document_attachment_unlinked', documentId, who, { evidenceId, wasPrimary: res.rows[0].is_primary === true });
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ expected-document links

/**
 * Replaces the set of documents that satisfy one expected document of the checklist (the route has checked the expected id against the program's
 * catalog). `expectedDocumentIds` is the set the client loaded (stale_write, with `currentDocumentIds`, when it differs). Refused with
 * document_not_found, document_not_in_program (only when the program declares documents) and limit. A write that changes nothing writes no row and no
 * event (changed false). One `document_expectation_changed` event otherwise.
 */
export async function putExpectationLinks(
  scope: ProgramScope,
  expectedId: string,
  documentIds: string[],
  expectedDocumentIds: string[],
  who: InventoryActor
): Promise<{ expectedId: string; documentIds: string[]; changed: boolean }> {
  const eventDetail = (added: string[], removed: string[]): Record<string, unknown> => {
    const a = cap(added);
    const r = cap(removed);
    return { expectedId, added: a.ids, removed: r.ids, addedCount: added.length, removedCount: removed.length, documentCount: documentIds.length, truncated: a.truncated || r.truncated };
  };
  const sorted = sortIds(documentIds);
  const limitError = (): DocumentError => new DocumentError('limit', 'This program has reached the maximum number of expected-document links');

  if (isMemory()) {
    const live = memoryDocumentIds(scope.tenantId);
    if (documentIds.some((id) => !live.has(id))) throw documentMissing();
    const members = liveMembers(scope);
    if (members.length > 0 && documentIds.some((id) => !members.includes(id))) throw outsideProgram();
    const m = memoryOf(scope);
    const current = new Set([...(m.expectations.get(expectedId) ?? [])].filter((id) => live.has(id)));
    if (!sameSet([...current], expectedDocumentIds)) throw staleDocuments(sortIds(current));
    let others = 0;
    for (const [id, docs] of m.expectations) if (id !== expectedId) others += [...docs].filter((d) => live.has(d)).length;
    if (others + documentIds.length > MAX_EXPECTATION_LINKS_PER_PROGRAM) throw limitError();
    const added = sorted.filter((id) => !current.has(id));
    const removed = sortIds([...current].filter((id) => !documentIds.includes(id)));
    if (added.length + removed.length === 0) return { expectedId, documentIds: sorted, changed: false };
    if (documentIds.length === 0) m.expectations.delete(expectedId);
    else m.expectations.set(expectedId, new Set(documentIds));
    pushEvent(scope, 'document_expectation_changed', expectedId, who, eventDetail(added, removed));
    return { expectedId, documentIds: sorted, changed: true };
  }

  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    if ((await countTenantDocuments(q, scope.tenantId, documentIds)) < documentIds.length) throw documentMissing();
    const members = await membersTx(q, scope);
    if (members.length > 0 && documentIds.some((id) => !members.includes(id))) throw outsideProgram();
    const res = await q('SELECT document_id FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND expected_id = $3', [scope.tenantId, scope.programId, expectedId]);
    const current = new Set(res.rows.map((r) => String(r.document_id)));
    if (!sameSet([...current], expectedDocumentIds)) throw staleDocuments(sortIds(current));
    const others = await q('SELECT COUNT(*)::int AS n FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND expected_id <> $3', [scope.tenantId, scope.programId, expectedId]);
    if (Number(others.rows[0].n) + documentIds.length > MAX_EXPECTATION_LINKS_PER_PROGRAM) throw limitError();
    const added = sorted.filter((id) => !current.has(id));
    const removed = sortIds([...current].filter((id) => !documentIds.includes(id)));
    if (added.length + removed.length === 0) return { expectedId, documentIds: sorted, changed: false };
    if (removed.length > 0) await q('DELETE FROM program_document_expectations WHERE tenant_id = $1 AND program_id = $2 AND expected_id = $3 AND document_id = ANY($4::text[])', [scope.tenantId, scope.programId, expectedId, removed]);
    if (added.length > 0) {
      await q(
        `INSERT INTO program_document_expectations (tenant_id, program_id, expected_id, document_id, linked_by)
         SELECT $1, $2, $3, x, $5 FROM unnest($4::text[]) AS x`,
        [scope.tenantId, scope.programId, expectedId, added, actorName(who)]
      );
    }
    await insertEventTx(q, scope, 'document_expectation_changed', expectedId, who, eventDetail(added, removed));
    return { expectedId, documentIds: sorted, changed: true };
  });
}
