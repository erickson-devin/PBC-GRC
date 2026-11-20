import type pg from 'pg';
import { SSP_PROFILE_KEYS, type SspProfile, type SspProfileRecord } from '../src/types/sspProfile';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from './db';
import { matchesExpected, notesDigest, StaleWriteError } from './controlAssessments';
import { insertEventTx, pushMemoryEvent, type ProgramActor } from './programs';

/**
 * Read and write access to a program's SSP profile (issues #238, #241, #242, #246): the structured SSP fields (system identifier, C/I/A
 * categorization, responsible roles, maintenance and ownership answers), one row per program in program_ssp_profile. It sits beside the SSP
 * metadata (server/sspMetadata.ts) with its own stamp, so saving one never makes the other's autosave stale. The values may be CUI: they are never
 * logged and never go into the program history, which records only the changed top-level keys with the SHA-256 and length of each value.
 *
 * A write replaces the whole profile. A write that changes nothing writes no row and no event. expectedUpdatedAt (the stamp the client loaded;
 * null = no row yet) makes a write fail with StaleWriteError when the row changed since.
 *
 * The in-memory emulator (server/db.ts) answers unknown SQL with no rows, so memory mode keeps its own Map here and fails closed:
 * a scope without a tenant or a program reads nothing and cannot write.
 */

type StoredRow = { profile: SspProfile; updatedAt: string; updatedBy: string; updatedByUserId: string | null };

/** One transaction's view of the program's row: find (locking it in PostgreSQL), insert, update, record the history event. */
interface Tx {
  find(): Promise<StoredRow | null>;
  /** Inserts only when no row exists; null when one does (a concurrent first writer got there first). */
  insert(profile: SspProfile, who: { name: string; userId: string | null }): Promise<StoredRow | null>;
  update(profile: SspProfile, who: { name: string; userId: string | null }): Promise<StoredRow>;
  addEvent(oldValue: Record<string, unknown> | null, newValue: Record<string, unknown>): Promise<void>;
}

const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);

/** JSON with object keys sorted at every depth, so two equal values compare equal as strings whatever their key order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The known top-level keys only, in a fixed order. */
export function normalizeSspProfile(raw: unknown): SspProfile {
  const out: Record<string, unknown> = {};
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  for (const key of SSP_PROFILE_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as SspProfile;
}

const sameContent = (a: SspProfile, b: SspProfile): boolean => canonicalJson(normalizeSspProfile(a)) === canonicalJson(normalizeSspProfile(b));

/** Top-level keys that differ, with the digest of the value on each side (null when absent). Never the values. */
function digestsOf(before: SspProfile | null, after: SspProfile): { oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> } {
  const oldKeys: Record<string, unknown> = {};
  const newKeys: Record<string, unknown> = {};
  for (const key of SSP_PROFILE_KEYS) {
    const b = before?.[key];
    const a = after[key];
    const bs = b === undefined ? null : canonicalJson(b);
    const as = a === undefined ? null : canonicalJson(a);
    if (bs === as) continue;
    oldKeys[key] = bs === null ? null : notesDigest(bs);
    newKeys[key] = as === null ? null : notesDigest(as);
  }
  return { oldValue: before ? { profile: oldKeys } : null, newValue: { profile: newKeys } };
}

const copyProfile = (p: SspProfile): SspProfile => JSON.parse(JSON.stringify(p)) as SspProfile;

const toRecord = (row: StoredRow | null): SspProfileRecord =>
  row ? { profile: copyProfile(row.profile), updatedAt: row.updatedAt, updatedBy: row.updatedBy || null } : { profile: null, updatedAt: null, updatedBy: null };

async function applyWrite(tx: Tx, profile: SspProfile, who: ProgramActor, expected: string | null): Promise<{ record: SspProfileRecord; changed: boolean }> {
  const after = normalizeSspProfile(profile);
  const writer = { name: who.actor.slice(0, 255), userId: who.userId ? who.userId.slice(0, 128) : null };
  const before = await tx.find();
  if (before && sameContent(before.profile, after)) return { record: toRecord(before), changed: false };
  const stale = (current: StoredRow | null): StaleWriteError => new StaleWriteError({ updatedAt: current?.updatedAt ?? null, updatedBy: current?.updatedBy || null });
  if (!matchesExpected(before ? before.updatedAt : null, expected)) throw stale(before);
  let stored: StoredRow | null;
  if (before) {
    stored = await tx.update(after, writer);
  } else {
    stored = await tx.insert(after, writer);
    if (!stored) throw stale(await tx.find());
  }
  const { oldValue, newValue } = digestsOf(before ? before.profile : null, after);
  await tx.addEvent(oldValue, newValue);
  return { record: toRecord(stored), changed: true };
}

// ---- memory mode ----

const memoryRows = new Map<string, StoredRow>(); // by `${tenant}__${program}`
const scopeKey = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
let memoryQueue: Promise<unknown> = Promise.resolve();

export function __resetSspProfileForTests(): void {
  memoryRows.clear();
}

/** The profile of a deleted program goes with it (in PostgreSQL the foreign key cascades); the history events stay. */
export function __deleteProgramSspProfileForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryRows.delete(scopeKey(scope));
}

const copyRow = (r: StoredRow): StoredRow => ({ ...r, profile: copyProfile(r.profile) });

/** Runs `fn` one at a time against the stored row; the row and the event only land when it finishes. */
function memoryTransaction<T>(scope: ProgramScope, who: ProgramActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (!hasScope(scope)) throw new Error('A program is required to write the SSP profile');
    const key = scopeKey(scope);
    let row = memoryRows.get(key) ? copyRow(memoryRows.get(key)!) : null;
    const events: Array<{ oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> }> = [];
    const tx: Tx = {
      find: async () => (row ? copyRow(row) : null),
      insert: async (profile, w) => {
        if (row) return null;
        row = { profile: copyProfile(profile), updatedAt: nextStamp(), updatedBy: w.name, updatedByUserId: w.userId };
        return copyRow(row);
      },
      update: async (profile, w) => {
        row = { profile: copyProfile(profile), updatedAt: nextStamp(row?.updatedAt), updatedBy: w.name, updatedByUserId: w.userId };
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

const SELECT_ONE = 'SELECT * FROM program_ssp_profile WHERE tenant_id = $1 AND program_id = $2 FOR UPDATE';

const INSERT_ONLY = `
  INSERT INTO program_ssp_profile (tenant_id, program_id, profile, updated_by, updated_by_user_id)
  VALUES ($1, $2, $3::jsonb, $4, $5)
  ON CONFLICT (tenant_id, program_id) DO NOTHING
  RETURNING *;
`;

const UPDATE = `
  UPDATE program_ssp_profile
  SET profile = $3::jsonb,
      updated_by = $4,
      updated_by_user_id = $5,
      updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
  WHERE tenant_id = $1 AND program_id = $2
  RETURNING *;
`;

function rowFrom(row: pg.QueryResultRow): StoredRow {
  return {
    profile: normalizeSspProfile(row.profile),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by ?? '',
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

async function pgTransaction<T>(scope: ProgramScope, who: ProgramActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!hasScope(scope)) throw new Error('A program is required to write the SSP profile');
  const c = await pool.connect();
  const tx: Tx = {
    find: async () => {
      const res = await c.query(SELECT_ONE, [scope.tenantId, scope.programId]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    insert: async (profile, w) => {
      const res = await c.query(INSERT_ONLY, [scope.tenantId, scope.programId, JSON.stringify(profile), w.name, w.userId]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    update: async (profile, w) => {
      const res = await c.query(UPDATE, [scope.tenantId, scope.programId, JSON.stringify(profile), w.name, w.userId]);
      if (!res.rows.length) throw new Error('The SSP profile could not be written');
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

/** The program's SSP profile; profile, updatedAt and updatedBy are null when nothing has been saved yet. */
export async function readSspProfile(scope: ProgramScope): Promise<SspProfileRecord> {
  if (!hasScope(scope)) return toRecord(null);
  if (getDbMode() === 'memory') {
    const row = memoryRows.get(scopeKey(scope));
    return toRecord(row ? copyRow(row) : null);
  }
  const res = await queryWithProgram(scope, 'SELECT * FROM program_ssp_profile WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  const row = res.rows.find((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId);
  return toRecord(row ? rowFrom(row) : null);
}

/**
 * Replaces the program's SSP profile with `profile` (already validated). Throws StaleWriteError when expectedUpdatedAt is not the stored stamp
 * (null expects no row yet: only one of two concurrent first writers wins). A write that changes nothing returns the stored record, changed false.
 */
export async function writeSspProfile(
  scope: ProgramScope,
  profile: SspProfile,
  who: ProgramActor,
  options: { expectedUpdatedAt: string | null }
): Promise<{ record: SspProfileRecord; changed: boolean }> {
  const run = (tx: Tx) => applyWrite(tx, profile, who, options.expectedUpdatedAt);
  return getDbMode() === 'memory' ? memoryTransaction(scope, who, run) : pgTransaction(scope, who, run);
}
