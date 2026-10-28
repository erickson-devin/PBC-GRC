import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  MAX_OBJECTIVE_BULK,
  MAX_OBJECTIVE_IMPORT,
  OBJECTIVE_CHANGE_SOURCES,
  type ObjectiveChangeSource,
  type ObjectiveEvent,
  type ObjectiveImportResult,
  type ObjectiveInput,
  type ObjectiveRecord,
  type ObjectiveStatus,
} from '../src/types/controlObjectives';
import { getDbMode, pool, queryWithProgram, type ProgramScope } from './db';
import { notesDigest } from './controlAssessments';

/**
 * Read and write access to a program's control_objectives rows (800-171A / 800-53A objectives: status, narrative, evidence links), and
 * the control_objective_events history. Every write records an event (who, what changed, and the SHA-256 and length of the narrative,
 * never its text: it may hold CUI), in the same transaction as the row. A write that changes neither the status, the narrative nor the
 * evidence links writes no row and no event. Used by routes/objectives.ts and by the program clone (server/programs.ts).
 *
 * The in-memory emulator (server/db.ts) answers unknown SQL with no rows, so memory mode keeps its own Maps here and fails closed:
 * a scope without a tenant or a program reads nothing and cannot write.
 */

/** Who made a change, as recorded in the history. The actor comes from the authenticated user, never from a request body. */
export interface ObjectiveActor {
  source: ObjectiveChangeSource;
  actor: string;
  userId: string | null;
}

type NewObjectiveEvent = Omit<ObjectiveEvent, 'id' | 'createdAt'>;

/** One transaction's view of the program's rows: find (locking the row in PostgreSQL), save, record an event. */
interface Tx {
  find(objectiveId: string): Promise<ObjectiveRecord | null>;
  save(record: ObjectiveRecord): Promise<void>;
  /** Inserts only when no row has the id; false when one exists. */
  insertOnly(record: ObjectiveRecord): Promise<boolean>;
  addEvent(event: NewObjectiveEvent): Promise<void>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

function buildEvent(scope: ProgramScope, input: ObjectiveInput, before: ObjectiveRecord | null, after: ObjectiveRecord, who: ObjectiveActor): NewObjectiveEvent {
  if (!(OBJECTIVE_CHANGE_SOURCES as readonly string[]).includes(who.source)) throw new Error(`Invalid objective change source: ${who.source}`);
  const oldDigest = before ? notesDigest(before.narrative) : null;
  const newDigest = notesDigest(after.narrative);
  return {
    tenantId: scope.tenantId,
    programId: scope.programId,
    controlId: input.controlId,
    objectiveId: input.objectiveId,
    source: who.source,
    actor: who.actor.slice(0, 255),
    actorUserId: who.userId === null ? null : who.userId.slice(0, 128),
    oldStatus: before ? before.status : null,
    newStatus: after.status,
    narrativeChanged: !oldDigest || oldDigest.sha256 !== newDigest.sha256,
    oldNarrativeSha256: oldDigest ? oldDigest.sha256 : null,
    newNarrativeSha256: newDigest.sha256,
    oldNarrativeLength: oldDigest ? oldDigest.length : null,
    newNarrativeLength: newDigest.length,
    evidenceChanged: before ? !sameSet(before.linkedEvidenceIds, after.linkedEvidenceIds) : after.linkedEvidenceIds.length > 0,
  };
}

/** The record a write produces: a field the input leaves out keeps the stored value (a new row gets the defaults). */
function merge(input: ObjectiveInput, before: ObjectiveRecord | null, who: ObjectiveActor): ObjectiveRecord {
  return {
    objectiveId: input.objectiveId,
    controlId: input.controlId,
    status: input.status ?? before?.status ?? 'NOT_STARTED',
    narrative: input.narrative ?? before?.narrative ?? '',
    linkedEvidenceIds: input.linkedEvidenceIds !== undefined ? dedupe(input.linkedEvidenceIds) : before?.linkedEvidenceIds ?? [],
    updatedBy: who.actor.slice(0, 255),
    updatedAt: null,
  };
}

function unchanged(before: ObjectiveRecord, after: ObjectiveRecord): boolean {
  return (
    before.status === after.status &&
    notesDigest(before.narrative).sha256 === notesDigest(after.narrative).sha256 &&
    sameSet(before.linkedEvidenceIds, after.linkedEvidenceIds)
  );
}

async function applyWrite(tx: Tx, scope: ProgramScope, input: ObjectiveInput, who: ObjectiveActor): Promise<{ record: ObjectiveRecord; changed: boolean }> {
  const before = await tx.find(input.objectiveId);
  const after = merge(input, before, who);
  if (before && unchanged(before, after)) return { record: before, changed: false };
  await tx.save(after);
  await tx.addEvent(buildEvent(scope, input, before, after, who));
  return { record: after, changed: true };
}

async function applyImport(tx: Tx, scope: ProgramScope, input: ObjectiveInput, who: ObjectiveActor): Promise<ObjectiveImportResult> {
  const before = await tx.find(input.objectiveId);
  const incoming = merge(input, null, who);
  if (before) return unchanged(before, incoming) ? 'unchanged' : 'conflict';
  if (!(await tx.insertOnly(incoming))) return 'conflict'; // a concurrent writer got there first: nothing is overwritten
  await tx.addEvent(buildEvent(scope, input, null, incoming, who));
  return 'created';
}

function toRecord(row: pg.QueryResultRow): ObjectiveRecord {
  return {
    objectiveId: String(row.objective_id),
    controlId: String(row.control_id),
    status: row.status as ObjectiveStatus,
    narrative: row.narrative ?? '',
    linkedEvidenceIds: Array.isArray(row.linked_evidence_ids) ? row.linked_evidence_ids.map(String) : [],
    updatedBy: row.updated_by ?? '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function toEvent(row: pg.QueryResultRow): ObjectiveEvent {
  const length = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    programId: String(row.program_id),
    controlId: String(row.control_id),
    objectiveId: String(row.objective_id),
    source: row.source,
    actor: String(row.actor),
    actorUserId: row.actor_user_id ?? null,
    oldStatus: row.old_status ?? null,
    newStatus: String(row.new_status),
    narrativeChanged: Boolean(row.narrative_changed),
    oldNarrativeSha256: row.old_narrative_sha256 ?? null,
    newNarrativeSha256: String(row.new_narrative_sha256),
    oldNarrativeLength: length(row.old_narrative_length),
    newNarrativeLength: Number(row.new_narrative_length),
    evidenceChanged: Boolean(row.evidence_changed),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ---- memory mode ----

const memoryRows = new Map<string, Map<string, ObjectiveRecord>>(); // by `${tenant}__${program}`, then objective id
const memoryEvents = new Map<string, ObjectiveEvent[]>(); // by `${tenant}__${program}`, oldest first
const scopeKey = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);
let memoryQueue: Promise<unknown> = Promise.resolve();

export function __resetControlObjectivesForTests(): void {
  memoryRows.clear();
  memoryEvents.clear();
}

/** The answers of a deleted program go with it (in PostgreSQL the foreign key cascades); the history events stay. */
export function __deleteProgramObjectivesForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryRows.delete(scopeKey(scope));
}

const copyRecord = (r: ObjectiveRecord): ObjectiveRecord => ({ ...r, linkedEvidenceIds: [...r.linkedEvidenceIds] });

/** Runs `fn` on a staged copy of the program's rows that replaces the stored ones only when it finishes (all or nothing), one at a time. */
function memoryTransaction<T>(scope: ProgramScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (!hasScope(scope)) throw new Error('A program is required to write objectives');
    const key = scopeKey(scope);
    const rows = new Map<string, ObjectiveRecord>();
    for (const [id, r] of memoryRows.get(key) ?? []) rows.set(id, copyRecord(r));
    const added: ObjectiveEvent[] = [];
    const tx: Tx = {
      find: async (id) => {
        const r = rows.get(id);
        return r ? copyRecord(r) : null;
      },
      save: async (record) => {
        rows.set(record.objectiveId, { ...copyRecord(record), updatedAt: new Date().toISOString() });
      },
      insertOnly: async (record) => {
        if (rows.has(record.objectiveId)) return false;
        rows.set(record.objectiveId, { ...copyRecord(record), updatedAt: new Date().toISOString() });
        return true;
      },
      addEvent: async (event) => {
        added.push({ ...event, id: `coe_${Date.now()}_${randomBytes(4).toString('hex')}`, createdAt: new Date().toISOString() });
      },
    };
    const result = await fn(tx);
    memoryRows.set(key, rows);
    memoryEvents.set(key, [...(memoryEvents.get(key) ?? []), ...added]);
    return result;
  };
  const next = memoryQueue.then(run, run);
  memoryQueue = next.catch(() => undefined);
  return next;
}

// ---- PostgreSQL ----

const SELECT_ONE = 'SELECT * FROM control_objectives WHERE tenant_id = $1 AND program_id = $2 AND objective_id = $3 FOR UPDATE';

const UPSERT = `
  INSERT INTO control_objectives (tenant_id, program_id, control_id, objective_id, status, narrative, linked_evidence_ids, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)
  ON CONFLICT (tenant_id, program_id, objective_id)
  DO UPDATE SET
    control_id = EXCLUDED.control_id,
    status = EXCLUDED.status,
    narrative = EXCLUDED.narrative,
    linked_evidence_ids = EXCLUDED.linked_evidence_ids,
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW()
  RETURNING *;
`;

const INSERT_ONLY = `
  INSERT INTO control_objectives (tenant_id, program_id, control_id, objective_id, status, narrative, linked_evidence_ids, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)
  ON CONFLICT (tenant_id, program_id, objective_id) DO NOTHING
  RETURNING id;
`;

const INSERT_EVENT = `
  INSERT INTO control_objective_events (
    tenant_id, program_id, control_id, objective_id, source, actor, actor_user_id, old_status, new_status,
    narrative_changed, old_narrative_sha256, new_narrative_sha256, old_narrative_length, new_narrative_length, evidence_changed
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
  );
`;

async function pgTransaction<T>(scope: ProgramScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!hasScope(scope)) throw new Error('A program is required to write objectives');
  const c = await pool.connect();
  const values = (r: ObjectiveRecord): (string | string[])[] => [scope.tenantId, scope.programId, r.controlId, r.objectiveId, r.status, r.narrative, r.linkedEvidenceIds, r.updatedBy];
  const tx: Tx = {
    find: async (id) => {
      const res = await c.query(SELECT_ONE, [scope.tenantId, scope.programId, id]);
      return res.rows[0] ? toRecord(res.rows[0]) : null;
    },
    save: async (record) => {
      const res = await c.query(UPSERT, values(record));
      if (!res.rows.length) throw new Error(`Objective ${record.objectiveId} could not be written`);
    },
    insertOnly: async (record) => (await c.query(INSERT_ONLY, values(record))).rows.length > 0,
    addEvent: async (e) => {
      await c.query(INSERT_EVENT, [
        e.tenantId, e.programId, e.controlId, e.objectiveId, e.source, e.actor, e.actorUserId, e.oldStatus, e.newStatus,
        e.narrativeChanged, e.oldNarrativeSha256, e.newNarrativeSha256, e.oldNarrativeLength, e.newNarrativeLength, e.evidenceChanged,
      ]);
    },
  };
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', scope.tenantId]);
    await c.query('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    const result = await fn(tx);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const transaction = <T>(scope: ProgramScope, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  getDbMode() === 'memory' ? memoryTransaction(scope, fn) : pgTransaction(scope, fn);

// ---- public API ----

/** The program's objectives (all of them, or one control's), ordered by objective id. */
export async function readObjectives(scope: ProgramScope, controlId?: string): Promise<ObjectiveRecord[]> {
  if (!hasScope(scope)) return [];
  let records: ObjectiveRecord[];
  if (getDbMode() === 'memory') {
    records = [...(memoryRows.get(scopeKey(scope))?.values() ?? [])].map(copyRecord);
  } else {
    const res = await queryWithProgram(scope, 'SELECT * FROM control_objectives WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
    records = res.rows.filter((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId).map(toRecord);
  }
  return records.filter((r) => controlId === undefined || r.controlId === controlId).sort((a, b) => (a.objectiveId < b.objectiveId ? -1 : a.objectiveId > b.objectiveId ? 1 : 0));
}

/** Writes one objective and records the change, atomically. A field left out keeps the stored value; an empty narrative clears it. `changed` is false (and nothing is written) when nothing differs. */
export async function writeObjective(scope: ProgramScope, item: ObjectiveInput, who: ObjectiveActor): Promise<{ record: ObjectiveRecord; changed: boolean }> {
  return transaction(scope, (tx) => applyWrite(tx, scope, item, who));
}

/** Writes up to MAX_OBJECTIVE_BULK objectives in one transaction: all of them, or none when any fails. Returns how many changed. */
export async function writeObjectivesBulk(scope: ProgramScope, items: ObjectiveInput[], who: ObjectiveActor): Promise<{ total: number; changed: number }> {
  if (items.length > MAX_OBJECTIVE_BULK) throw new Error(`At most ${MAX_OBJECTIVE_BULK} objectives per request`);
  return transaction(scope, async (tx) => {
    let changed = 0;
    for (const item of items) if ((await applyWrite(tx, scope, item, who)).changed) changed++;
    return { total: items.length, changed };
  });
}

/**
 * Imports objectives that were kept in the browser, insert-only (history source 'browser-import'): an id with no row is created, an id whose
 * row has the same status, narrative and evidence is 'unchanged', and an id whose row differs is a 'conflict' and writes nothing (the server's copy wins).
 */
export async function importObjectives(
  scope: ProgramScope,
  items: ObjectiveInput[],
  who: ObjectiveActor
): Promise<{ objectiveId: string; result: ObjectiveImportResult }[]> {
  if (items.length > MAX_OBJECTIVE_IMPORT) throw new Error(`At most ${MAX_OBJECTIVE_IMPORT} objectives per import`);
  const by: ObjectiveActor = { ...who, source: 'browser-import' };
  return transaction(scope, async (tx) => {
    const results: { objectiveId: string; result: ObjectiveImportResult }[] = [];
    for (const item of items) results.push({ objectiveId: item.objectiveId, result: await applyImport(tx, scope, item, by) });
    return results;
  });
}

/** An objective's history in the program, newest first. Carries the SHA-256 and length of the narrative, never its text. */
export async function listObjectiveEvents(scope: ProgramScope, objectiveId: string, limit: number): Promise<ObjectiveEvent[]> {
  if (!hasScope(scope)) return [];
  if (getDbMode() === 'memory') {
    return (memoryEvents.get(scopeKey(scope)) ?? []).filter((e) => e.objectiveId === objectiveId).reverse().slice(0, limit);
  }
  const res = await queryWithProgram(
    scope,
    'SELECT * FROM control_objective_events WHERE tenant_id = $1 AND program_id = $2 AND objective_id = $3 ORDER BY created_at DESC, id DESC LIMIT $4',
    [scope.tenantId, scope.programId, objectiveId, limit]
  );
  return res.rows.filter((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId).map(toEvent);
}

/**
 * Seeds `toScope` from `fromScope` for a program clone of the same framework: each objective with a narrative is copied with the status
 * reset to NOT_STARTED and no evidence links, and records one history event (source 'clone') from `who`. `include` limits the copy to
 * some controls (the target's baseline). Returns how many were copied.
 */
export async function cloneObjectives(fromScope: ProgramScope, toScope: ProgramScope, who: ObjectiveActor, include?: (controlId: string) => boolean): Promise<number> {
  if (fromScope.tenantId !== toScope.tenantId) throw new Error('Objectives can only be cloned within one tenant');
  const rows = (await readObjectives(fromScope)).filter((r) => r.narrative !== '' && (!include || include(r.controlId)));
  if (!rows.length) return 0;
  const by: ObjectiveActor = { ...who, source: 'clone' };
  return transaction(toScope, async (tx) => {
    let copied = 0;
    for (const r of rows) {
      const input: ObjectiveInput = { objectiveId: r.objectiveId, controlId: r.controlId, status: 'NOT_STARTED', narrative: r.narrative, linkedEvidenceIds: [] };
      if ((await applyWrite(tx, toScope, input, by)).changed) copied++;
    }
    return copied;
  });
}
