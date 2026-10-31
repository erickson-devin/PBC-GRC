import type pg from 'pg';
import { SSP_METADATA_FIELDS, type SspMetadataFields, type SspMetadataRecord } from '../src/types/sspMetadata';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from './db';
import { matchesExpected, notesDigest, StaleWriteError } from './controlAssessments';
import { insertEventTx, pushMemoryEvent, type ProgramActor } from './programs';

/**
 * Read and write access to a program's SSP metadata (issue #84): the system name, environment, boundary text and cloud service providers
 * of its System Security Plan, one row per program in program_ssp_metadata. The text may be CUI: it is never logged and never goes into
 * the program history, which records only the changed field names with the SHA-256 and length of each value.
 *
 * A write replaces the whole object. A write that changes nothing writes no row and no event. expectedUpdatedAt (the stamp the client
 * loaded; null = no row yet) makes a write fail with StaleWriteError when the row changed since.
 *
 * The in-memory emulator (server/db.ts) answers unknown SQL with no rows, so memory mode keeps its own Map here and fails closed:
 * a scope without a tenant or a program reads nothing and cannot write.
 */

type StoredRow = { metadata: SspMetadataFields; updatedAt: string; updatedBy: string };

/** One transaction's view of the program's row: find (locking it in PostgreSQL), insert, update, record the history event. */
interface Tx {
  find(): Promise<StoredRow | null>;
  /** Inserts only when no row exists; null when one does (a concurrent first writer got there first). */
  insert(metadata: SspMetadataFields, updatedBy: string): Promise<StoredRow | null>;
  update(metadata: SspMetadataFields, updatedBy: string): Promise<StoredRow>;
  addEvent(oldValue: Record<string, unknown> | null, newValue: Record<string, unknown>): Promise<void>;
}

const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);

/** The whitelisted fields only, in a fixed order, so two equal objects compare equal as strings. */
function normalize(raw: SspMetadataFields): SspMetadataFields {
  const out: SspMetadataFields = {};
  for (const key of SSP_METADATA_FIELDS) {
    const v = raw[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

const sameContent = (a: SspMetadataFields, b: SspMetadataFields): boolean => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Field names that differ, with the digest of the value on each side (null when absent). Never the text. */
function digestsOf(before: SspMetadataFields | null, after: SspMetadataFields): { oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> } {
  const oldFields: Record<string, unknown> = {};
  const newFields: Record<string, unknown> = {};
  for (const key of SSP_METADATA_FIELDS) {
    const b = before?.[key];
    const a = after[key];
    if (b === a) continue;
    oldFields[key] = b === undefined ? null : notesDigest(b);
    newFields[key] = a === undefined ? null : notesDigest(a);
  }
  return { oldValue: before ? { fields: oldFields } : null, newValue: { fields: newFields } };
}

const toRecord = (row: StoredRow | null): SspMetadataRecord =>
  row ? { metadata: { ...row.metadata }, updatedAt: row.updatedAt, updatedBy: row.updatedBy || null } : { metadata: null, updatedAt: null, updatedBy: null };

async function applyWrite(tx: Tx, fields: SspMetadataFields, who: ProgramActor, expected: string | null): Promise<{ record: SspMetadataRecord; changed: boolean }> {
  const after = normalize(fields);
  const updatedBy = who.actor.slice(0, 255);
  const before = await tx.find();
  if (before && sameContent(before.metadata, after)) return { record: toRecord(before), changed: false };
  const stale = (current: StoredRow | null): StaleWriteError => new StaleWriteError({ updatedAt: current?.updatedAt ?? null, updatedBy: current?.updatedBy || null });
  if (!matchesExpected(before ? before.updatedAt : null, expected)) throw stale(before);
  let stored: StoredRow | null;
  if (before) {
    stored = await tx.update(after, updatedBy);
  } else {
    stored = await tx.insert(after, updatedBy);
    if (!stored) throw stale(await tx.find());
  }
  const { oldValue, newValue } = digestsOf(before ? before.metadata : null, after);
  await tx.addEvent(oldValue, newValue);
  return { record: toRecord(stored), changed: true };
}

// ---- memory mode ----

const memoryRows = new Map<string, StoredRow>(); // by `${tenant}__${program}`
const scopeKey = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
let memoryQueue: Promise<unknown> = Promise.resolve();

export function __resetSspMetadataForTests(): void {
  memoryRows.clear();
}

/** The metadata of a deleted program goes with it (in PostgreSQL the foreign key cascades); the history events stay. */
export function __deleteProgramSspMetadataForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryRows.delete(scopeKey(scope));
}

const copyRow = (r: StoredRow): StoredRow => ({ ...r, metadata: { ...r.metadata } });

/** Runs `fn` one at a time against the stored row; the row and the event only land when it finishes. */
function memoryTransaction<T>(scope: ProgramScope, who: ProgramActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (!hasScope(scope)) throw new Error('A program is required to write SSP metadata');
    const key = scopeKey(scope);
    let row = memoryRows.get(key) ? copyRow(memoryRows.get(key)!) : null;
    const events: Array<{ oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> }> = [];
    const tx: Tx = {
      find: async () => (row ? copyRow(row) : null),
      insert: async (metadata, updatedBy) => {
        if (row) return null;
        row = { metadata: { ...metadata }, updatedAt: nextStamp(), updatedBy };
        return copyRow(row);
      },
      update: async (metadata, updatedBy) => {
        row = { metadata: { ...metadata }, updatedAt: nextStamp(row?.updatedAt), updatedBy };
        return copyRow(row);
      },
      addEvent: async (oldValue, newValue) => {
        events.push({ oldValue, newValue });
      },
    };
    const result = await fn(tx);
    if (row) memoryRows.set(key, row);
    for (const e of events) pushMemoryEvent(scope.tenantId, scope.programId, 'ssp_metadata_changed', who, e.oldValue, e.newValue);
    return result;
  };
  const next = memoryQueue.then(run, run);
  memoryQueue = next.catch(() => undefined);
  return next;
}

// ---- PostgreSQL ----

const SELECT_ONE = 'SELECT * FROM program_ssp_metadata WHERE tenant_id = $1 AND program_id = $2 FOR UPDATE';

const INSERT_ONLY = `
  INSERT INTO program_ssp_metadata (tenant_id, program_id, metadata, updated_by)
  VALUES ($1, $2, $3::jsonb, $4)
  ON CONFLICT (tenant_id, program_id) DO NOTHING
  RETURNING *;
`;

const UPDATE = `
  UPDATE program_ssp_metadata
  SET metadata = $3::jsonb,
      updated_by = $4,
      updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
  WHERE tenant_id = $1 AND program_id = $2
  RETURNING *;
`;

function rowFrom(row: pg.QueryResultRow): StoredRow {
  return {
    metadata: normalize((row.metadata ?? {}) as SspMetadataFields),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by ?? '',
  };
}

async function pgTransaction<T>(scope: ProgramScope, who: ProgramActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!hasScope(scope)) throw new Error('A program is required to write SSP metadata');
  const c = await pool.connect();
  const tx: Tx = {
    find: async () => {
      const res = await c.query(SELECT_ONE, [scope.tenantId, scope.programId]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    insert: async (metadata, updatedBy) => {
      const res = await c.query(INSERT_ONLY, [scope.tenantId, scope.programId, JSON.stringify(metadata), updatedBy]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    update: async (metadata, updatedBy) => {
      const res = await c.query(UPDATE, [scope.tenantId, scope.programId, JSON.stringify(metadata), updatedBy]);
      if (!res.rows.length) throw new Error('SSP metadata could not be written');
      return rowFrom(res.rows[0]);
    },
    addEvent: async (oldValue, newValue) => {
      await insertEventTx((text, params) => c.query(text, params), scope.tenantId, scope.programId, 'ssp_metadata_changed', who, oldValue, newValue);
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

// ---- public API ----

/** The program's SSP metadata; metadata, updatedAt and updatedBy are null when nothing has been saved yet. */
export async function readSspMetadata(scope: ProgramScope): Promise<SspMetadataRecord> {
  if (!hasScope(scope)) return toRecord(null);
  if (getDbMode() === 'memory') {
    const row = memoryRows.get(scopeKey(scope));
    return toRecord(row ? copyRow(row) : null);
  }
  const res = await queryWithProgram(scope, 'SELECT * FROM program_ssp_metadata WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  const row = res.rows.find((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId);
  return toRecord(row ? rowFrom(row) : null);
}

/**
 * Replaces the program's SSP metadata with `fields` (already validated). Throws StaleWriteError when expectedUpdatedAt is not the stored stamp
 * (null expects no row yet: only one of two concurrent first writers wins). A write that changes nothing returns the stored record, changed false.
 */
export async function writeSspMetadata(
  scope: ProgramScope,
  fields: SspMetadataFields,
  who: ProgramActor,
  options: { expectedUpdatedAt: string | null }
): Promise<{ record: SspMetadataRecord; changed: boolean }> {
  const run = (tx: Tx) => applyWrite(tx, fields, who, options.expectedUpdatedAt);
  return getDbMode() === 'memory' ? memoryTransaction(scope, who, run) : pgTransaction(scope, who, run);
}
