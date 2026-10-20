import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { CONTROL_CHANGE_SOURCES, type ControlAssessmentEvent, type ControlChangeSource } from '../src/types/controlHistory';
import { getDbMode, pool, queryWithTenant } from './db';

/**
 * Read and write access to a tenant's control_assessments rows, shared by the control PUT, the SSP commit and the vulnerability-management
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
}

/** The tenant's current control answers, by control id. */
export async function readControlAssessments(tenantId: string): Promise<Map<string, ControlAssessment>> {
  const res = await queryWithTenant(tenantId, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [tenantId]);
  const map = new Map<string, ControlAssessment>();
  for (const row of res.rows) {
    if (row.tenant_id !== tenantId) continue; // defence in depth: the store already filters by tenant
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
    tenant_id, control_id, status, implementation_notes, responsible_role, updated_by
  ) VALUES (
    $1, $2, COALESCE($3::varchar, 'NOT_STARTED'), COALESCE($4::text, ''), COALESCE($5::varchar, 'IT / Security Lead'), $6
  )
  ON CONFLICT (tenant_id, control_id)
  DO UPDATE SET
    status = COALESCE($3::varchar, control_assessments.status),
    implementation_notes = COALESCE($4::text, control_assessments.implementation_notes),
    responsible_role = COALESCE($5::varchar, control_assessments.responsible_role),
    updated_by = $6,
    updated_at = NOW()
  RETURNING *;
`;

const SELECT_ONE = 'SELECT * FROM control_assessments WHERE tenant_id = $1 AND control_id = $2 FOR UPDATE';

const INSERT_EVENT = `
  INSERT INTO control_assessment_events (
    tenant_id, control_id, source, actor, actor_user_id, old_status, new_status, old_role, new_role,
    notes_changed, old_notes_sha256, new_notes_sha256, old_notes_length, new_notes_length
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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

/** The history in memory mode (the emulator answers unknown SQL with no rows), by tenant, oldest first. */
const memoryEvents = new Map<string, ControlAssessmentEvent[]>();

export function __resetControlAssessmentEventsForTests(): void {
  memoryEvents.clear();
}

type Run = (sql: string, params: (string | number | boolean | null)[]) => Promise<pg.QueryResult>;

async function writeWith(
  run: Run,
  tenantId: string,
  controlId: string,
  compose: (current: ControlAssessment | null) => ControlAssessmentPatch | null,
  who: ControlChangeActor,
  recordEvent: (event: NewControlAssessmentEvent) => Promise<void>
): Promise<pg.QueryResultRow | null> {
  const found = await run(SELECT_ONE, [tenantId, controlId]);
  // the memory emulator ignores the WHERE clause, so filter again here
  const row = found.rows.find((r) => r.tenant_id === tenantId && r.control_id === controlId);
  const before = row ? toAssessment(row) : null;
  const patch = compose(before);
  if (!patch) return null;
  if (patch.status !== null && !(CONTROL_STATUSES as readonly string[]).includes(patch.status)) throw new Error(`Invalid control status: ${patch.status}`);
  const written = await run(UPSERT, [tenantId, controlId, patch.status, patch.notes, patch.role, patch.updatedBy]);
  if (!written.rows.length) throw new Error(`Control ${controlId} could not be written`);
  await recordEvent(buildControlAssessmentEvent(tenantId, controlId, before, toAssessment(written.rows[0]), who));
  return written.rows[0];
}

/**
 * Writes one control's answer and records the change, atomically. `compose` sees the current answer (null for a control never written,
 * read FOR UPDATE in PostgreSQL so a concurrent writer waits) and returns the patch, or null to write nothing. Returns the stored row,
 * or null only when compose returned null. A non-null patch.status outside CONTROL_STATUSES throws, as does a row that could not be written.
 * Without `client` PostgreSQL gets its own transaction; with one, the statements run on the caller's transaction (which commits or rolls back).
 */
export async function writeControlAssessment(
  tenantId: string,
  controlId: string,
  compose: (current: ControlAssessment | null) => ControlAssessmentPatch | null,
  who: ControlChangeActor,
  client?: pg.PoolClient | null
): Promise<pg.QueryResultRow | null> {
  if (getDbMode() === 'memory') {
    const run: Run = (sql, params) => queryWithTenant(tenantId, sql, params);
    return writeWith(run, tenantId, controlId, compose, who, async (event) => {
      const list = memoryEvents.get(tenantId) ?? [];
      list.push({ ...event, id: `cae_${Date.now()}_${randomBytes(4).toString('hex')}`, createdAt: new Date().toISOString() });
      memoryEvents.set(tenantId, list);
    });
  }

  const own = !client;
  const c = client ?? (await pool.connect());
  const run: Run = (sql, params) => c.query(sql, params);
  try {
    if (own) await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await writeWith(run, tenantId, controlId, compose, who, async (e) => {
      await c.query(INSERT_EVENT, [
        e.tenantId, e.controlId, e.source, e.actor, e.actorUserId, e.oldStatus, e.newStatus, e.oldRole, e.newRole,
        e.notesChanged, e.oldNotesSha256, e.newNotesSha256, e.oldNotesLength, e.newNotesLength,
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

/** A control's history, newest first. */
export async function listControlAssessmentEvents(tenantId: string, controlId: string, limit: number): Promise<ControlAssessmentEvent[]> {
  if (getDbMode() === 'memory') {
    return (memoryEvents.get(tenantId) ?? []).filter((e) => e.controlId === controlId).reverse().slice(0, limit);
  }
  const res = await queryWithTenant(
    tenantId,
    'SELECT * FROM control_assessment_events WHERE tenant_id = $1 AND control_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    [tenantId, controlId, limit]
  );
  return res.rows.map(toEvent);
}

