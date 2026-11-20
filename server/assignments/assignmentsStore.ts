import type pg from 'pg';
import type { ProgramScope } from '../db';
import { inTenantTx, isMemory, type InventoryActor, type Q } from '../inventory/events';
import { recordProgramInventoryEvent, recordProgramInventoryEventTx } from '../inventory/programInventoryStore';
import {
  MAX_ASSIGNMENTS_PER_PROGRAM,
  type AssigneeKind,
  type AssigneeRef,
  type AssignmentChange,
  type AssignmentDuty,
  type AssignmentTargetKind,
} from '../../src/types/assignments';

/**
 * Who is responsible for what in a program (#253): one assignee (a person or a team) per target (a control, an objective or an SSP section) and duty
 * (owner, or reviewer for a signable section). An assignment is a LABEL: nothing in the server reads these rows to allow or refuse an action, so an
 * assessor or a viewer named as an owner stays read-only. No foreign key to tenant_users: a member who left keeps their assignments (the readers show
 * "no longer a member"). Teams are tenant-wide (teamsStore.ts); a team assignee is checked when it is set, and removed with the team (with force).
 *
 * PostgreSQL: program_assignments has the tenant and the program row policies, so every statement runs in a transaction that sets both settings. A
 * batch is one transaction under the program lock, all or nothing. The in-memory store keeps a Map per program; its batch decides and writes with no
 * await in between. Only ids, kinds and duties go to the history (program_inventory_events, action assignment_changed): never a name.
 */

export type AssignmentErrorCode =
  | 'invalid'
  | 'not_found'
  | 'duplicate_name'
  | 'limit'
  | 'stale_write'
  | 'target_not_in_program'
  | 'reviewer_only_for_sections'
  | 'assignee_not_member'
  | 'team_not_found'
  | 'team_in_use'
  | 'invalid_member_ids'
  | 'not_a_member';

export class AssignmentError extends Error {
  constructor(
    public readonly code: AssignmentErrorCode,
    message: string,
    /** Extra facts for the caller (indexes, counts and ids only, never a name or a text). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AssignmentError';
  }
}

export const ASSIGNMENT_STATUS: Record<AssignmentErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  duplicate_name: 409,
  limit: 429,
  stale_write: 409,
  target_not_in_program: 400,
  reviewer_only_for_sections: 400,
  assignee_not_member: 400,
  team_not_found: 404,
  team_in_use: 409,
  invalid_member_ids: 400,
  not_a_member: 400,
};

/** A stored assignment (the assignee's state is worked out by the reader against the members and the teams). */
export interface StoredAssignment {
  targetKind: AssignmentTargetKind;
  targetId: string;
  duty: AssignmentDuty;
  assignee: AssigneeRef;
  assignedAt: string;
  assignedBy: string | null;
}

const keyOf = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);
const rowKey = (kind: string, id: string, duty: string): string => `${kind}|${id}|${duty}`;
const sameRef = (a: AssigneeRef | null, b: AssigneeRef | null): boolean => (a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id);
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

let limitOverride: number | null = null;
/** Test hook: lowers the assignments allowed per program (null restores MAX_ASSIGNMENTS_PER_PROGRAM). */
export function __setAssignmentLimitForTests(n: number | null): void {
  limitOverride = n;
}
const limit = (): number => limitOverride ?? MAX_ASSIGNMENTS_PER_PROGRAM;
/** The assignments allowed per program right now. */
export const assignmentLimit = limit;
const limitError = (): AssignmentError => new AssignmentError('limit', 'This program has reached the maximum number of assignments');

// ------------------------------------------------------------------------------------------------ memory store

const memoryRows = new Map<string, Map<string, StoredAssignment>>(); // key: tenantId__programId -> rowKey -> row

/** Test hook. */
export function __resetAssignmentsForTests(): void {
  memoryRows.clear();
  limitOverride = null;
}

/** The rows of a deleted program go with it (in PostgreSQL the foreign key cascades); its history stays in program_inventory_events. */
export function __deleteProgramAssignmentsForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryRows.delete(keyOf(scope));
}

/** Test hook: how many rows the memory store holds for the program. */
export function __programAssignmentRowsForTests(scope: ProgramScope): number {
  return memoryRows.get(keyOf(scope))?.size ?? 0;
}

const copy = (r: StoredAssignment): StoredAssignment => ({ ...r, assignee: { ...r.assignee } });
const byKey = (a: StoredAssignment, b: StoredAssignment): number => {
  const ka = rowKey(a.targetKind, a.targetId, a.duty);
  const kb = rowKey(b.targetKind, b.targetId, b.duty);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

function fromRow(r: pg.QueryResultRow): StoredAssignment {
  return {
    targetKind: r.target_kind as AssignmentTargetKind,
    targetId: String(r.target_id),
    duty: r.duty as AssignmentDuty,
    assignee: { kind: r.assignee_kind as AssigneeKind, id: String(r.assignee_id) },
    assignedAt: iso(r.assigned_at),
    assignedBy: r.assigned_by ?? null,
  };
}

/** One transaction under the tenant's and the program's row policies. */
function inProgramTx<T>(scope: ProgramScope, fn: (q: Q) => Promise<T>): Promise<T> {
  return inTenantTx(scope.tenantId, async (q) => {
    await q('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    return fn(q);
  });
}

/** Serializes the program's assignment writers (a lock that does not block the foreign keys of other tables). */
const lockProgram = (q: Q, scope: ProgramScope): Promise<pg.QueryResult> => q('SELECT 1 FROM programs WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE', [scope.tenantId, scope.programId]);

const COLUMNS = 'target_kind, target_id, duty, assignee_kind, assignee_id, assigned_at, assigned_by';

// ------------------------------------------------------------------------------------------------ reads

/** Every assignment of the program, by target kind, id and duty. */
export async function readAssignments(scope: ProgramScope): Promise<StoredAssignment[]> {
  if (!hasScope(scope)) return [];
  if (isMemory()) return [...(memoryRows.get(keyOf(scope))?.values() ?? [])].map(copy).sort(byKey);
  return inProgramTx(scope, async (q) => {
    const res = await q(`SELECT ${COLUMNS} FROM program_assignments WHERE tenant_id = $1 AND program_id = $2 ORDER BY target_kind, target_id, duty LIMIT $3`, [scope.tenantId, scope.programId, limit() + 1]);
    return res.rows.map(fromRow);
  });
}

/** How many assignments the program holds. */
export async function countAssignments(scope: ProgramScope): Promise<number> {
  if (!hasScope(scope)) return 0;
  if (isMemory()) return memoryRows.get(keyOf(scope))?.size ?? 0;
  return inProgramTx(scope, async (q) => {
    const res = await q('SELECT COUNT(*)::int AS n FROM program_assignments WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
    return Number(res.rows[0]?.n ?? 0);
  });
}

/** How many assignments of the program name the team (the team usage and the guard of a team delete). */
export async function countTeamAssignments(scope: ProgramScope, teamId: string): Promise<number> {
  if (!hasScope(scope)) return 0;
  if (isMemory()) return [...(memoryRows.get(keyOf(scope))?.values() ?? [])].filter((r) => r.assignee.kind === 'team' && r.assignee.id === teamId).length;
  return inProgramTx(scope, async (q) => {
    const res = await q("SELECT COUNT(*)::int AS n FROM program_assignments WHERE tenant_id = $1 AND program_id = $2 AND assignee_kind = 'team' AND assignee_id = $3", [scope.tenantId, scope.programId, teamId]);
    return Number(res.rows[0]?.n ?? 0);
  });
}

// ------------------------------------------------------------------------------------------------ writes

export interface AssignmentBatchResult {
  /** The rows that exist after the batch for the items that set an assignee and changed something. */
  changedRows: StoredAssignment[];
  /** How many items changed something (an assignment set, replaced or removed). */
  changed: number;
}

interface Plan {
  index: number;
  item: AssignmentChange;
  current: AssigneeRef | null;
}

const eventDetail = (item: AssignmentChange, from: AssigneeRef | null, to: AssigneeRef | null): Record<string, unknown> => ({
  targetKind: item.targetKind,
  targetId: item.targetId,
  duty: item.duty,
  from: from ? { kind: from.kind, id: from.id } : null,
  to: to ? { kind: to.kind, id: to.id } : null,
});

function checkExpected(plans: Plan[]): void {
  for (const p of plans) {
    if (!sameRef(p.current, p.item.expectedAssignee)) {
      throw new AssignmentError('stale_write', 'This assignment changed after you loaded it', { index: p.index, current: p.current ? { kind: p.current.kind, id: p.current.id } : null });
    }
  }
}

/**
 * Applies a validated batch, all or nothing. Each item's `expectedAssignee` must equal what is stored (stale_write with the item's `index` and the stored
 * `current`, nothing written); an item that sets what is already there changes nothing. At most MAX_ASSIGNMENTS_PER_PROGRAM rows per program (limit).
 * One `assignment_changed` event per change. The route has already checked the targets, the assignees and the teams.
 */
export async function applyAssignmentBatch(scope: ProgramScope, items: AssignmentChange[], who: InventoryActor, nowIso: string = new Date().toISOString()): Promise<AssignmentBatchResult> {
  if (!hasScope(scope) || items.length === 0) return { changedRows: [], changed: 0 };
  const actor = who.actor.slice(0, 255);

  if (isMemory()) {
    let rows = memoryRows.get(keyOf(scope));
    const plans: Plan[] = items.map((item, index) => ({ index, item, current: rows?.get(rowKey(item.targetKind, item.targetId, item.duty))?.assignee ?? null }));
    checkExpected(plans);
    const changing = plans.filter((p) => !sameRef(p.current, p.item.assignee));
    const adding = changing.filter((p) => p.current === null && p.item.assignee !== null).length;
    if (adding > 0 && (rows?.size ?? 0) + adding > limit()) throw limitError();
    if (!rows) {
      rows = new Map();
      memoryRows.set(keyOf(scope), rows);
    }
    const changedRows: StoredAssignment[] = [];
    for (const p of changing) {
      const k = rowKey(p.item.targetKind, p.item.targetId, p.item.duty);
      if (p.item.assignee === null) rows.delete(k);
      else {
        const row: StoredAssignment = { targetKind: p.item.targetKind, targetId: p.item.targetId, duty: p.item.duty, assignee: { ...p.item.assignee }, assignedAt: nowIso, assignedBy: actor };
        rows.set(k, row);
        changedRows.push(copy(row));
      }
    }
    if (rows.size === 0) memoryRows.delete(keyOf(scope));
    for (const p of changing) await recordProgramInventoryEvent(scope, 'assignment_changed', null, who, eventDetail(p.item, p.current, p.item.assignee));
    return { changedRows: changedRows.sort(byKey), changed: changing.length };
  }

  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    const found = await q(
      `SELECT a.target_kind, a.target_id, a.duty, a.assignee_kind, a.assignee_id
         FROM program_assignments a
         JOIN unnest($3::text[], $4::text[], $5::text[]) AS k(target_kind, target_id, duty) ON a.target_kind = k.target_kind AND a.target_id = k.target_id AND a.duty = k.duty
        WHERE a.tenant_id = $1 AND a.program_id = $2
        FOR UPDATE OF a`,
      [scope.tenantId, scope.programId, items.map((i) => i.targetKind), items.map((i) => i.targetId), items.map((i) => i.duty)]
    );
    const stored = new Map(found.rows.map((r) => [rowKey(String(r.target_kind), String(r.target_id), String(r.duty)), { kind: r.assignee_kind as AssigneeKind, id: String(r.assignee_id) }] as const));
    const plans: Plan[] = items.map((item, index) => ({ index, item, current: stored.get(rowKey(item.targetKind, item.targetId, item.duty)) ?? null }));
    checkExpected(plans);
    const changing = plans.filter((p) => !sameRef(p.current, p.item.assignee));
    const adding = changing.filter((p) => p.current === null && p.item.assignee !== null).length;
    if (adding > 0) {
      const count = await q('SELECT COUNT(*)::int AS n FROM program_assignments WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
      if (Number(count.rows[0].n) + adding > limit()) throw limitError();
    }
    const setting = changing.filter((p) => p.item.assignee !== null);
    const removing = changing.filter((p) => p.item.assignee === null);
    let changedRows: StoredAssignment[] = [];
    if (setting.length > 0) {
      const res = await q(
        `INSERT INTO program_assignments (tenant_id, program_id, target_kind, target_id, duty, assignee_kind, assignee_id, assigned_by, assigned_by_user_id)
         SELECT $1, $2, u.k, u.t, u.d, u.ak, u.ai, $8, $9 FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS u(k, t, d, ak, ai)
         ON CONFLICT (tenant_id, program_id, target_kind, target_id, duty)
         DO UPDATE SET assignee_kind = EXCLUDED.assignee_kind, assignee_id = EXCLUDED.assignee_id, assigned_by = EXCLUDED.assigned_by, assigned_by_user_id = EXCLUDED.assigned_by_user_id, assigned_at = NOW()
         RETURNING ${COLUMNS}`,
        [
          scope.tenantId,
          scope.programId,
          setting.map((p) => p.item.targetKind),
          setting.map((p) => p.item.targetId),
          setting.map((p) => p.item.duty),
          setting.map((p) => (p.item.assignee as AssigneeRef).kind),
          setting.map((p) => (p.item.assignee as AssigneeRef).id),
          actor,
          who.userId ? who.userId.slice(0, 128) : null,
        ]
      );
      changedRows = res.rows.map(fromRow).sort(byKey);
    }
    if (removing.length > 0) {
      await q(
        `DELETE FROM program_assignments a USING unnest($3::text[], $4::text[], $5::text[]) AS k(target_kind, target_id, duty)
          WHERE a.tenant_id = $1 AND a.program_id = $2 AND a.target_kind = k.target_kind AND a.target_id = k.target_id AND a.duty = k.duty`,
        [scope.tenantId, scope.programId, removing.map((p) => p.item.targetKind), removing.map((p) => p.item.targetId), removing.map((p) => p.item.duty)]
      );
    }
    for (const p of changing) await recordProgramInventoryEventTx(q, scope, 'assignment_changed', null, who, eventDetail(p.item, p.current, p.item.assignee));
    return { changedRows, changed: changing.length };
  });
}

/**
 * Deletes every assignment of the program that names the team (the forced delete of a team, in the program's own transaction), with one
 * `assignment_changed` event each. Returns how many went. The team itself is deleted by teamsStore afterwards.
 */
export async function deleteTeamAssignments(scope: ProgramScope, teamId: string, who: InventoryActor): Promise<number> {
  if (!hasScope(scope)) return 0;
  const detailOf = (r: StoredAssignment): Record<string, unknown> => eventDetail({ targetKind: r.targetKind, targetId: r.targetId, duty: r.duty, assignee: null, expectedAssignee: r.assignee }, r.assignee, null);
  if (isMemory()) {
    const rows = memoryRows.get(keyOf(scope));
    if (!rows) return 0;
    const gone = [...rows.values()].filter((r) => r.assignee.kind === 'team' && r.assignee.id === teamId).sort(byKey);
    for (const r of gone) rows.delete(rowKey(r.targetKind, r.targetId, r.duty));
    if (rows.size === 0) memoryRows.delete(keyOf(scope));
    for (const r of gone) await recordProgramInventoryEvent(scope, 'assignment_changed', null, who, detailOf(r));
    return gone.length;
  }
  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    const res = await q(`DELETE FROM program_assignments WHERE tenant_id = $1 AND program_id = $2 AND assignee_kind = 'team' AND assignee_id = $3 RETURNING ${COLUMNS}`, [scope.tenantId, scope.programId, teamId]);
    const gone = res.rows.map(fromRow).sort(byKey);
    for (const r of gone) await recordProgramInventoryEventTx(q, scope, 'assignment_changed', null, who, detailOf(r));
    return gone.length;
  });
}
