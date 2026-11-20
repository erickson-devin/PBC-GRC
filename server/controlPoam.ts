import type pg from 'pg';
import type { ControlPoamEvent, ControlPoamPatch, ControlPoamRecord } from '../src/types/controlPoam';
import type { PoamMilestone } from '../src/types/poamMilestone';
import { canonicalMilestones, milestoneCounts, newMilestoneId, normalizeStoredMilestones, PoamMilestoneError, resolveMilestones, sameMilestones } from '../src/data/poamMilestones';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from './db';
import { matchesExpected, notesDigest, readControlAssessments, StaleWriteError } from './controlAssessments';

/**
 * Read and write access to the POA&M fields of a program's controls (#304): the owner, scheduled completion, required resources, plan and
 * milestones a person recorded, one row per control in control_poam_entries. The text may be CUI: it is never logged and never goes into the
 * history (control_poam_events holds changed flags, lengths, counts and SHA-256 digests only).
 *
 * A write patches the stored row (a field left out keeps its value). A write that changes nothing writes no row and no event. expectedUpdatedAt
 * (the stamp the client loaded; null = no row yet) makes a write fail with StaleWriteError when the row changed since. A control's status is
 * read in the same transaction and recorded on the event; it never blocks a write (a Met control keeps its row and simply prints no entry).
 *
 * The in-memory emulator (server/db.ts) answers unknown SQL with no rows, so memory mode keeps its own Map here and fails closed:
 * a scope without a tenant or a program reads nothing and cannot write.
 */

type StoredRow = {
  controlId: string;
  owner: string;
  scheduledCompletion: string | null;
  requiredResources: string;
  plan: string;
  milestones: PoamMilestone[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
};

type Fields = Pick<StoredRow, 'owner' | 'scheduledCompletion' | 'requiredResources' | 'plan' | 'milestones'>;

/** The writer as recorded: a display name (the stored updated_by) and the user id (only on the event row in PostgreSQL). */
export interface ControlPoamEditor {
  actor: string;
  userId: string | null;
}

/** What one change records (flags, dates, lengths, counts and digests: never any text). */
interface EventDraft {
  controlStatus: string | null;
  oldScheduledCompletion: string | null;
  newScheduledCompletion: string | null;
  ownerChanged: boolean;
  ownerDigest: { sha256: string; length: number } | null;
  resourcesChanged: boolean;
  resourcesDigest: { sha256: string; length: number } | null;
  planChanged: boolean;
  planDigest: { sha256: string; length: number } | null;
  milestonesChanged: boolean;
  milestoneCount: number | null;
  milestonesCompleted: number | null;
  milestonesSha256: string | null;
}

/** One transaction's view of a control's row: find (locking it in PostgreSQL), insert, update, record the event, read the control's status. */
interface Tx {
  find(controlId: string): Promise<StoredRow | null>;
  /** Inserts only when no row exists; null when one does (a concurrent first writer got there first). */
  insert(controlId: string, fields: Fields, who: ControlPoamEditor): Promise<StoredRow | null>;
  update(controlId: string, fields: Fields, who: ControlPoamEditor): Promise<StoredRow>;
  addEvent(controlId: string, draft: EventDraft, who: ControlPoamEditor): Promise<void>;
  controlStatus(controlId: string): Promise<string | null>;
}

const ACTOR_MAX = 255;
const USER_ID_MAX = 128;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

/** A DATE column as YYYY-MM-DD (the driver returns a Date at local midnight). */
const dateOnly = (v: unknown): string | null =>
  v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : ((v as string | null | undefined) ?? null);

const copyRow = (r: StoredRow): StoredRow => ({ ...r, milestones: r.milestones.map((m) => ({ ...m })) });

const toRecord = (r: StoredRow): ControlPoamRecord => ({
  controlId: r.controlId,
  owner: r.owner,
  scheduledCompletion: r.scheduledCompletion,
  requiredResources: r.requiredResources,
  plan: r.plan,
  milestones: r.milestones.map((m) => ({ ...m })),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
});

const EMPTY: Fields = { owner: '', scheduledCompletion: null, requiredResources: '', plan: '', milestones: [] };

async function applyWrite(
  tx: Tx,
  controlId: string,
  patch: ControlPoamPatch,
  who: ControlPoamEditor,
  expected: string | null
): Promise<{ entry: ControlPoamRecord | null; changed: boolean }> {
  const writer: ControlPoamEditor = { actor: who.actor.slice(0, ACTOR_MAX), userId: who.userId ? who.userId.slice(0, USER_ID_MAX) : null };
  const before = await tx.find(controlId);
  const stale = (current: StoredRow | null): StaleWriteError => new StaleWriteError({ updatedAt: current?.updatedAt ?? null, updatedBy: current?.updatedBy ?? null });
  if (!matchesExpected(before ? before.updatedAt : null, expected)) throw stale(before);
  const base: Fields = before ?? EMPTY;
  let milestones = base.milestones;
  if (patch.milestones !== undefined) {
    const resolved = resolveMilestones(base.milestones, patch.milestones, newMilestoneId);
    if (!resolved.ok) throw new PoamMilestoneError();
    milestones = resolved.milestones;
  }
  const after: Fields = {
    owner: patch.owner ?? base.owner,
    scheduledCompletion: patch.scheduledCompletion === undefined ? base.scheduledCompletion : patch.scheduledCompletion,
    requiredResources: patch.requiredResources ?? base.requiredResources,
    plan: patch.plan ?? base.plan,
    milestones,
  };
  const ownerChanged = after.owner !== base.owner;
  const resourcesChanged = after.requiredResources !== base.requiredResources;
  const planChanged = after.plan !== base.plan;
  const dateChanged = after.scheduledCompletion !== base.scheduledCompletion;
  const milestonesChanged = !sameMilestones(after.milestones, base.milestones);
  if (!ownerChanged && !resourcesChanged && !planChanged && !dateChanged && !milestonesChanged) return { entry: before ? toRecord(before) : null, changed: false };
  let stored: StoredRow | null;
  if (before) {
    stored = await tx.update(controlId, after, writer);
  } else {
    stored = await tx.insert(controlId, after, writer);
    if (!stored) throw stale(await tx.find(controlId));
  }
  const counts = milestoneCounts(after.milestones);
  await tx.addEvent(
    controlId,
    {
      controlStatus: await tx.controlStatus(controlId),
      oldScheduledCompletion: base.scheduledCompletion,
      newScheduledCompletion: after.scheduledCompletion,
      ownerChanged,
      ownerDigest: ownerChanged ? notesDigest(after.owner) : null,
      resourcesChanged,
      resourcesDigest: resourcesChanged ? notesDigest(after.requiredResources) : null,
      planChanged,
      planDigest: planChanged ? notesDigest(after.plan) : null,
      milestonesChanged,
      milestoneCount: milestonesChanged ? counts.count : null,
      milestonesCompleted: milestonesChanged ? counts.completed : null,
      milestonesSha256: milestonesChanged ? notesDigest(canonicalMilestones(after.milestones)).sha256 : null,
    },
    writer
  );
  return { entry: toRecord(stored), changed: true };
}

// ---- memory mode ----

type MemoryEvent = ControlPoamEvent & { tenantId: string; programId: string };

const memoryRows = new Map<string, StoredRow>(); // by `${tenant}__${program}__${control}`
const memoryEvents: MemoryEvent[] = []; // oldest first
const rowKey = (scope: ProgramScope, controlId: string): string => `${scope.tenantId}__${scope.programId}__${controlId}`;
let memoryQueue: Promise<unknown> = Promise.resolve();

export function __resetControlPoamForTests(): void {
  memoryRows.clear();
  memoryEvents.length = 0;
}

/** The entries of a deleted program go with it (in PostgreSQL the foreign key cascades); the history events stay. */
export function __deleteProgramControlPoamForMemory(scope: ProgramScope): void {
  if (!hasScope(scope)) return;
  const prefix = `${scope.tenantId}__${scope.programId}__`;
  for (const key of [...memoryRows.keys()]) if (key.startsWith(prefix)) memoryRows.delete(key);
}

/** Runs `fn` one at a time against the stored row; the row and the event only land when it finishes. */
function memoryTransaction<T>(scope: ProgramScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (!hasScope(scope)) throw new Error('A program is required to write the control POA&M');
    const staged = new Map<string, StoredRow>();
    const events: MemoryEvent[] = [];
    const current = (controlId: string): StoredRow | null => {
      const row = staged.get(controlId) ?? memoryRows.get(rowKey(scope, controlId));
      return row ? copyRow(row) : null;
    };
    const tx: Tx = {
      find: async (controlId) => current(controlId),
      insert: async (controlId, fields, w) => {
        if (current(controlId)) return null;
        const now = nextStamp();
        const row: StoredRow = { controlId, ...fields, milestones: fields.milestones.map((m) => ({ ...m })), createdAt: now, updatedAt: now, updatedBy: w.actor };
        staged.set(controlId, row);
        return copyRow(row);
      },
      update: async (controlId, fields, w) => {
        const prev = current(controlId) as StoredRow;
        const row: StoredRow = { ...prev, ...fields, milestones: fields.milestones.map((m) => ({ ...m })), updatedAt: nextStamp(prev.updatedAt), updatedBy: w.actor };
        staged.set(controlId, row);
        return copyRow(row);
      },
      addEvent: async (controlId, d, w) => {
        events.push({
          id: crypto.randomUUID(),
          tenantId: scope.tenantId,
          programId: scope.programId,
          controlId,
          actor: w.actor,
          controlStatus: d.controlStatus,
          oldScheduledCompletion: d.oldScheduledCompletion,
          newScheduledCompletion: d.newScheduledCompletion,
          ownerChanged: d.ownerChanged,
          resourcesChanged: d.resourcesChanged,
          planChanged: d.planChanged,
          milestonesChanged: d.milestonesChanged,
          milestoneCount: d.milestoneCount,
          milestonesCompleted: d.milestonesCompleted,
          createdAt: new Date().toISOString(),
        });
      },
      controlStatus: async (controlId) => (await readControlAssessments(scope)).get(controlId)?.status ?? null,
    };
    const result = await fn(tx);
    for (const [controlId, row] of staged) memoryRows.set(rowKey(scope, controlId), row);
    memoryEvents.push(...events);
    return result;
  };
  const next = memoryQueue.then(run, run);
  memoryQueue = next.catch(() => undefined);
  return next;
}

// ---- PostgreSQL ----

const SELECT_ONE = 'SELECT * FROM control_poam_entries WHERE tenant_id = $1::text AND program_id = $2::text AND control_id = $3::text FOR UPDATE';

const INSERT_ONLY = `
  INSERT INTO control_poam_entries (tenant_id, program_id, control_id, owner, scheduled_completion, required_resources, plan, milestones, created_by, updated_by)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::date, $6::text, $7::text, $8::jsonb, $9::text, $9::text)
  ON CONFLICT (tenant_id, program_id, control_id) DO NOTHING
  RETURNING *;
`;

const UPDATE = `
  UPDATE control_poam_entries
  SET owner = $4::text, scheduled_completion = $5::date, required_resources = $6::text, plan = $7::text, milestones = $8::jsonb, updated_by = $9::text,
      updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
  WHERE tenant_id = $1::text AND program_id = $2::text AND control_id = $3::text
  RETURNING *;
`;

const INSERT_EVENT = `
  INSERT INTO control_poam_events (tenant_id, program_id, control_id, actor, actor_user_id, control_status, old_scheduled_completion, new_scheduled_completion,
                                   owner_changed, new_owner_sha256, new_owner_length, resources_changed, new_resources_sha256, new_resources_length,
                                   plan_changed, new_plan_sha256, new_plan_length, milestones_changed, new_milestone_count, new_milestones_completed, new_milestones_sha256)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::date, $8::date,
          $9::boolean, $10::text, $11::integer, $12::boolean, $13::text, $14::integer,
          $15::boolean, $16::text, $17::integer, $18::boolean, $19::integer, $20::integer, $21::text)
`;

function rowFrom(r: pg.QueryResultRow): StoredRow {
  return {
    controlId: r.control_id as string,
    owner: r.owner ?? '',
    scheduledCompletion: dateOnly(r.scheduled_completion),
    requiredResources: r.required_resources ?? '',
    plan: r.plan ?? '',
    milestones: normalizeStoredMilestones(r.milestones),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by ?? null,
  };
}

const fieldParams = (f: Fields): Array<string | null> => [f.owner, f.scheduledCompletion, f.requiredResources, f.plan, JSON.stringify(f.milestones)];

async function pgTransaction<T>(scope: ProgramScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!hasScope(scope)) throw new Error('A program is required to write the control POA&M');
  const c = await pool.connect();
  const tx: Tx = {
    find: async (controlId) => {
      const res = await c.query(SELECT_ONE, [scope.tenantId, scope.programId, controlId]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    insert: async (controlId, fields, w) => {
      const res = await c.query(INSERT_ONLY, [scope.tenantId, scope.programId, controlId, ...fieldParams(fields), w.actor]);
      return res.rows[0] ? rowFrom(res.rows[0]) : null;
    },
    update: async (controlId, fields, w) => {
      const res = await c.query(UPDATE, [scope.tenantId, scope.programId, controlId, ...fieldParams(fields), w.actor]);
      if (!res.rows.length) throw new Error('The control POA&M entry could not be written');
      return rowFrom(res.rows[0]);
    },
    addEvent: async (controlId, d, w) => {
      await c.query(INSERT_EVENT, [
        scope.tenantId, scope.programId, controlId, w.actor, w.userId, d.controlStatus, d.oldScheduledCompletion, d.newScheduledCompletion,
        d.ownerChanged, d.ownerDigest?.sha256 ?? null, d.ownerDigest?.length ?? null, d.resourcesChanged, d.resourcesDigest?.sha256 ?? null, d.resourcesDigest?.length ?? null,
        d.planChanged, d.planDigest?.sha256 ?? null, d.planDigest?.length ?? null, d.milestonesChanged, d.milestoneCount, d.milestonesCompleted, d.milestonesSha256,
      ]);
    },
    controlStatus: async (controlId) => {
      // A legacy row without a program counts as the default program's until it is backfilled, like readControlAssessments
      const res = await c.query(
        'SELECT status FROM control_assessments WHERE tenant_id = $1::text AND control_id = $2::text AND (program_id = $3::text OR program_id IS NULL)',
        [scope.tenantId, controlId, scope.programId]
      );
      return res.rows[0] ? ((res.rows[0].status as string | null) ?? null) : null;
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

/** Every entry the program holds (only controls somebody recorded something for), by control id. Empty for a scope without a tenant or program. */
export async function readControlPoam(scope: ProgramScope): Promise<ControlPoamRecord[]> {
  if (!hasScope(scope)) return [];
  if (getDbMode() === 'memory') {
    const prefix = `${scope.tenantId}__${scope.programId}__`;
    return [...memoryRows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => toRecord(row))
      .sort((a, b) => (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0));
  }
  const res = await queryWithProgram(scope, 'SELECT * FROM control_poam_entries WHERE tenant_id = $1 AND program_id = $2 ORDER BY control_id', [scope.tenantId, scope.programId]);
  return res.rows.filter((r) => r.tenant_id === scope.tenantId && r.program_id === scope.programId).map((r) => toRecord(rowFrom(r)));
}

/**
 * Patches the POA&M fields of one control (already validated: parseControlPoamPatch). Throws StaleWriteError when expectedUpdatedAt is not the
 * stored stamp (null expects no row yet: only one of two concurrent first writers wins) and PoamMilestoneError for a milestone id the entry does
 * not hold. A write that changes nothing returns the stored entry (null when there is none), changed false, and writes no event.
 */
export async function writeControlPoam(
  scope: ProgramScope,
  controlId: string,
  patch: ControlPoamPatch,
  who: ControlPoamEditor,
  options: { expectedUpdatedAt: string | null }
): Promise<{ entry: ControlPoamRecord | null; changed: boolean }> {
  const run = (tx: Tx) => applyWrite(tx, controlId, patch, who, options.expectedUpdatedAt);
  return getDbMode() === 'memory' ? memoryTransaction(scope, run) : pgTransaction(scope, run);
}

/** The control's history, newest first (at most `limit`). Flags, dates, status, lengths and counts only: never any text. */
export async function listControlPoamEvents(scope: ProgramScope, controlId: string, limit: number): Promise<ControlPoamEvent[]> {
  if (!hasScope(scope)) return [];
  if (getDbMode() === 'memory') {
    return memoryEvents
      .filter((e) => e.tenantId === scope.tenantId && e.programId === scope.programId && e.controlId === controlId)
      .reverse()
      .slice(0, limit)
      .map(({ tenantId: _t, programId: _p, ...event }) => ({ ...event }));
  }
  const res = await queryWithProgram(
    scope,
    `SELECT id, control_id, actor, control_status, old_scheduled_completion, new_scheduled_completion, owner_changed, resources_changed, plan_changed,
            milestones_changed, new_milestone_count, new_milestones_completed, created_at
       FROM control_poam_events
      WHERE tenant_id = $1::text AND program_id = $2::text AND control_id = $3::text
      ORDER BY created_at DESC, id DESC
      LIMIT $4::integer`,
    [scope.tenantId, scope.programId, controlId, limit]
  );
  return res.rows.map((r): ControlPoamEvent => ({
    id: r.id,
    controlId: r.control_id,
    actor: r.actor,
    controlStatus: r.control_status ?? null,
    oldScheduledCompletion: dateOnly(r.old_scheduled_completion),
    newScheduledCompletion: dateOnly(r.new_scheduled_completion),
    ownerChanged: Boolean(r.owner_changed),
    resourcesChanged: Boolean(r.resources_changed),
    planChanged: Boolean(r.plan_changed),
    milestonesChanged: Boolean(r.milestones_changed),
    milestoneCount: r.new_milestone_count ?? null,
    milestonesCompleted: r.new_milestones_completed ?? null,
    createdAt: iso(r.created_at),
  }));
}
