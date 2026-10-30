import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { CONTROL_CHANGE_SOURCES, type ControlAssessmentEvent, type ControlChangeSource } from '../src/types/controlHistory';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from './db';

// nextStamp lives in db.ts (the memory emulator there needs it and db.ts cannot import this file without a cycle); re-exported for callers of this module.
export { nextStamp };

/**
 * Read and write access to a program's control_assessments rows (a program is a tenant's authorization boundary; see server/programs.ts), shared by the control PUT, the SSP commit and the vulnerability-management
 * snapshot. Every write goes through writeControlAssessment, which also records a control_assessment_events row (who, what changed, and
 * the SHA-256 and length of the notes, never their text: they may hold CUI).
 */

/** Mirrors the statuses PUT /controls accepts. */
export const CONTROL_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'] as const;

export interface ControlAssessment {
  status: string;
  notes: string;
  role: string;
  updatedAt: string | null;
  /** Who made the last write (the stored updated_by); only set for a row read under a write. */
  updatedBy?: string | null;
}

/** The result of reading a request's `expectedUpdatedAt`: absent (undefined), no row expected (null) or a timestamp string. */
export function parseExpectedUpdatedAt(raw: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: raw };
  if (typeof raw === 'string' && raw.length <= 64 && Number.isFinite(Date.parse(raw))) return { ok: true, value: raw };
  return { ok: false };
}

/** True when the stored timestamp is the one the client loaded: null expects no stored row, a string must be the same instant. */
export function matchesExpected(current: string | null, expected: string | null): boolean {
  return expected === null ? current === null : current !== null && Date.parse(current) === Date.parse(expected);
}

/** A write was refused because the row changed after the client loaded it. Carries only the stored stamp and writer, never any text. */
export class StaleWriteError extends Error {
  readonly code = 'stale_write';
  constructor(readonly current: { updatedAt: string | null; updatedBy: string | null }) {
    super('stale write');
    this.name = 'StaleWriteError';
  }
}

/** Throws StaleWriteError unless the stored row is the version the client loaded. */
export function checkExpectedUpdatedAt(current: ControlAssessment | null, expected: string | null): void {
  if (!matchesExpected(current?.updatedAt ?? null, expected)) {
    throw new StaleWriteError({ updatedAt: current?.updatedAt ?? null, updatedBy: current?.updatedBy ?? null });
  }
}

/**
 * The program's current control answers, by control id. A legacy row that has no program yet counts as the default program's until it is
 * backfilled (migrateTenantToPrograms): the row policy maps it there, and no other program ever sees it.
 */
export async function readControlAssessments(scope: ProgramScope): Promise<Map<string, ControlAssessment>> {
  const res = await queryWithProgram(scope, 'SELECT * FROM control_assessments WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL)', [scope.tenantId, scope.programId]);
  const map = new Map<string, ControlAssessment>();
  for (const row of res.rows) {
    if (row.tenant_id !== scope.tenantId) continue; // defence in depth: the store already filters by tenant
    map.set(String(row.control_id), {
      status: row.status || 'NOT_STARTED',
      notes: row.implementation_notes || '',
      role: row.responsible_role || 'IT / Security Lead',
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    });
  }
  return map;
}

/**
 * NULL means keep, in both stores: a NULL status, notes or role leaves the stored value alone (COALESCE in the VALUES for a new row,
 * COALESCE against the current column on conflict). A new row gets the column defaults.
 */
const UPSERT = `
  INSERT INTO control_assessments (
    tenant_id, control_id, status, implementation_notes, responsible_role, updated_by, program_id
  ) VALUES (
    $1, $2, COALESCE($3::varchar, 'NOT_STARTED'), COALESCE($4::text, ''), COALESCE($5::varchar, 'IT / Security Lead'), $6, $7::varchar
  )
  ON CONFLICT (tenant_id, program_id, control_id)
  DO UPDATE SET
    status = COALESCE($3::varchar, control_assessments.status),
    implementation_notes = COALESCE($4::text, control_assessments.implementation_notes),
    responsible_role = COALESCE($5::varchar, control_assessments.responsible_role),
    updated_by = $6,
    program_id = COALESCE(control_assessments.program_id, $7::varchar),
    updated_at = GREATEST(NOW(), control_assessments.updated_at + interval '1 millisecond')
  RETURNING *;
`;

// A legacy row without a program is the default program's until it is backfilled (the row policy maps it there); the unique key is (tenant_id, program_id, control_id).
const SELECT_ONE = 'SELECT * FROM control_assessments WHERE tenant_id = $1 AND control_id = $2 AND (program_id = $3 OR program_id IS NULL) FOR UPDATE';

const INSERT_EVENT = `
  INSERT INTO control_assessment_events (
    tenant_id, control_id, source, actor, actor_user_id, old_status, new_status, old_role, new_role,
    notes_changed, old_notes_sha256, new_notes_sha256, old_notes_length, new_notes_length, program_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
  )
  RETURNING *;
`;

/** Who made a change, as recorded in the history. The actor comes from the authenticated user, never from a request body. */
export interface ControlChangeActor {
  source: ControlChangeSource;
  actor: string;
  userId: string | null;
}

/** What to write: null keeps the stored value (see UPSERT); an empty string clears the notes. */
export interface ControlAssessmentPatch {
  status: string | null;
  notes: string | null;
  role: string | null;
  updatedBy: string;
}

type NewControlAssessmentEvent = Omit<ControlAssessmentEvent, 'id' | 'createdAt'>;

/** SHA-256 (lowercase hex, of the UTF-8 bytes) and length (JS string length) of a control's notes. */
export function notesDigest(notes: string): { sha256: string; length: number } {
  return { sha256: createHash('sha256').update(notes, 'utf8').digest('hex'), length: notes.length };
}

/** The event for a change from `before` (null for a new row) to `after`. Pure; never carries the notes text. */
export function buildControlAssessmentEvent(
  tenantId: string,
  controlId: string,
  before: ControlAssessment | null,
  after: ControlAssessment,
  who: ControlChangeActor
): NewControlAssessmentEvent {
  if (!(CONTROL_CHANGE_SOURCES as readonly string[]).includes(who.source)) throw new Error(`Invalid control change source: ${who.source}`);
  const oldDigest = before ? notesDigest(before.notes) : null;
  const newDigest = notesDigest(after.notes);
  return {
    tenantId,
    controlId,
    source: who.source,
    actor: who.actor.slice(0, 255),
    actorUserId: who.userId === null ? null : who.userId.slice(0, 128),
    oldStatus: before ? before.status : null,
    newStatus: after.status,
    oldRole: before ? before.role : null,
    newRole: after.role,
    notesChanged: !oldDigest || oldDigest.sha256 !== newDigest.sha256,
    oldNotesSha256: oldDigest ? oldDigest.sha256 : null,
    newNotesSha256: newDigest.sha256,
    oldNotesLength: oldDigest ? oldDigest.length : null,
    newNotesLength: newDigest.length,
  };
}

function toAssessment(row: pg.QueryResultRow): ControlAssessment {
  return {
    status: row.status || 'NOT_STARTED',
    notes: row.implementation_notes || '',
    role: row.responsible_role || 'IT / Security Lead',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by ?? null,
  };
}

function toEvent(row: pg.QueryResultRow): ControlAssessmentEvent {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    controlId: String(row.control_id),
    source: row.source,
    actor: String(row.actor),
    actorUserId: row.actor_user_id ?? null,
    oldStatus: row.old_status ?? null,
    newStatus: String(row.new_status),
    oldRole: row.old_role ?? null,
    newRole: String(row.new_role),
    notesChanged: Boolean(row.notes_changed),
    oldNotesSha256: row.old_notes_sha256 ?? null,
    newNotesSha256: String(row.new_notes_sha256),
    oldNotesLength: row.old_notes_length === null || row.old_notes_length === undefined ? null : Number(row.old_notes_length),
    newNotesLength: Number(row.new_notes_length),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The history in memory mode (the emulator answers unknown SQL with no rows), by `${tenant}__${program}`, oldest first. */
const memoryEvents = new Map<string, ControlAssessmentEvent[]>();
const eventsKey = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;

export function __resetControlAssessmentEventsForTests(): void {
  memoryEvents.clear();
}

type Run = (sql: string, params: (string | number | boolean | null)[]) => Promise<pg.QueryResult>;

async function writeWith(
  run: Run,
  scope: ProgramScope,
  controlId: string,
  compose: (current: ControlAssessment | null) => ControlAssessmentPatch | null,
  who: ControlChangeActor,
  recordEvent: (event: NewControlAssessmentEvent) => Promise<void>
): Promise<pg.QueryResultRow | null> {
  const { tenantId, programId } = scope;
  const found = await run(SELECT_ONE, [tenantId, controlId, programId]);
  // the memory emulator ignores the WHERE clause, so filter again here (the program's own row first, else a legacy row without a program)
  const mine = found.rows.filter((r) => r.tenant_id === tenantId && r.control_id === controlId);
  const row = mine.find((r) => r.program_id === programId) ?? mine[0];
  const before = row ? toAssessment(row) : null;
  const patch = compose(before);
  if (!patch) return null;
  if (patch.status !== null && !(CONTROL_STATUSES as readonly string[]).includes(patch.status)) throw new Error(`Invalid control status: ${patch.status}`);
  const written = await run(UPSERT, [tenantId, controlId, patch.status, patch.notes, patch.role, patch.updatedBy, programId]);
  if (!written.rows.length) throw new Error(`Control ${controlId} could not be written`);
  await recordEvent(buildControlAssessmentEvent(tenantId, controlId, before, toAssessment(written.rows[0]), who));
  return written.rows[0];
}

/**
 * Writes one control's answer in the program and records the change, atomically. `compose` sees the current answer (null for a control never written,
 * read FOR UPDATE in PostgreSQL so a concurrent writer waits) and returns the patch, or null to write nothing. Returns the stored row,
 * or null only when compose returned null. A non-null patch.status outside CONTROL_STATUSES throws, as does a row that could not be written.
 * Without `client` PostgreSQL gets its own transaction; with one, the statements run on the caller's transaction (which commits or rolls back).
 */
export async function writeControlAssessment(
  scope: ProgramScope,
  controlId: string,
  compose: (current: ControlAssessment | null) => ControlAssessmentPatch | null,
  who: ControlChangeActor,
  client?: pg.PoolClient | null
): Promise<pg.QueryResultRow | null> {
  if (getDbMode() === 'memory') {
    const run: Run = (sql, params) => queryWithProgram(scope, sql, params);
    return writeWith(run, scope, controlId, compose, who, async (event) => {
      const list = memoryEvents.get(eventsKey(scope)) ?? [];
      list.push({ ...event, id: `cae_${Date.now()}_${randomBytes(4).toString('hex')}`, createdAt: new Date().toISOString() });
      memoryEvents.set(eventsKey(scope), list);
    });
  }

  const own = !client;
  const c = client ?? (await pool.connect());
  const run: Run = (sql, params) => c.query(sql, params);
  try {
    if (own) await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', scope.tenantId]);
    await c.query('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    const result = await writeWith(run, scope, controlId, compose, who, async (e) => {
      await c.query(INSERT_EVENT, [
        e.tenantId, e.controlId, e.source, e.actor, e.actorUserId, e.oldStatus, e.newStatus, e.oldRole, e.newRole,
        e.notesChanged, e.oldNotesSha256, e.newNotesSha256, e.oldNotesLength, e.newNotesLength, scope.programId,
      ]);
    });
    if (own) await c.query('COMMIT');
    return result;
  } catch (err) {
    if (own) await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    if (own) c.release();
  }
}

/** A control's history in the program, newest first. An event written before programs existed (no program) counts as the program's own. */
export async function listControlAssessmentEvents(scope: ProgramScope, controlId: string, limit: number): Promise<ControlAssessmentEvent[]> {
  if (getDbMode() === 'memory') {
    return (memoryEvents.get(eventsKey(scope)) ?? []).filter((e) => e.controlId === controlId).reverse().slice(0, limit);
  }
  const res = await queryWithProgram(
    scope,
    'SELECT * FROM control_assessment_events WHERE tenant_id = $1 AND control_id = $2 AND (program_id = $3 OR program_id IS NULL) ORDER BY created_at DESC, id DESC LIMIT $4',
    [scope.tenantId, controlId, scope.programId, limit]
  );
  return res.rows.map(toEvent);
}

/**
 * Retention sweep, memory mode: drops the events created before `cutoff` (all scopes, or only the tenants in `onlyTenantIds`).
 * Returns how many events went (or would go, with `dryRun`) and how many scopes held some.
 */
export function pruneMemoryControlAssessmentEvents(
  cutoff: Date,
  opts: { dryRun?: boolean; onlyTenantIds?: readonly string[] } = {}
): { deleted: number; scopes: number } {
  let deleted = 0;
  let scopes = 0;
  const limit = cutoff.getTime();
  for (const [key, list] of [...memoryEvents]) {
    if (opts.onlyTenantIds && !opts.onlyTenantIds.includes(list[0]?.tenantId ?? key.split('__')[0])) continue;
    const keep = list.filter((e) => !(Date.parse(e.createdAt) < limit));
    const gone = list.length - keep.length;
    if (!gone) continue;
    deleted += gone;
    scopes++;
    if (!opts.dryRun) memoryEvents.set(key, keep);
  }
  return { deleted, scopes };
}

/**
 * Retention sweep, PostgreSQL: deletes (or with `dryRun` counts) a scope's events created before `cutoff`, `batchSize` rows per transaction.
 * The row policies confine the statement to the scope, so another tenant's or program's rows are never touched.
 */
export async function pruneControlAssessmentEventsInScope(scope: ProgramScope, cutoff: Date, batchSize: number, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const res = await queryWithProgram(
      scope,
      'SELECT count(*)::int AS n FROM control_assessment_events WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) AND created_at < $3',
      [scope.tenantId, scope.programId, cutoff.toISOString()]
    );
    return Number(res.rows[0]?.n ?? 0);
  }
  let total = 0;
  for (;;) {
    const res = await queryWithProgram(
      scope,
      'DELETE FROM control_assessment_events WHERE ctid IN (SELECT ctid FROM control_assessment_events WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) AND created_at < $3 LIMIT $4)',
      [scope.tenantId, scope.programId, cutoff.toISOString(), batchSize]
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batchSize) return total;
  }
}

