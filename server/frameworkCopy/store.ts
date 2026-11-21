import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool, queryWithProgram, type ProgramScope } from '../db';
import { markerKey } from '../../src/data/frameworkCopy/plan';
import type { FrameworkCopyKind, FrameworkCopyRun, FrameworkCopySummary } from '../../src/types/frameworkCopy';

/**
 * The storage of "Copy from Rev. 2" (#255): the idempotency markers (program_framework_copy_items: one row per copied item, so a re-run, a crash in the
 * middle of a run or two concurrent runs append nothing twice) and the run records (program_framework_copy_runs). `scope.programId` is always the TARGET
 * (Rev. 3) program. Both tables hold ids, digests and counts only: never narrative text or a file name.
 *
 * PostgreSQL: every statement of a run goes through one transaction (withCopyTx) that sets the tenant and the program settings, so the markers commit or
 * roll back together with the notes, the history events and the evidence rows of the run. The in-memory store keeps its own maps (the emulator answers
 * unknown SQL with no rows); a failed run removes the markers it added (memory mode has no rollback for the control and evidence rows themselves).
 */

const keyOf = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

export interface CopyMarkerInput {
  sourceProgramId: string;
  kind: FrameworkCopyKind;
  targetControlId: string;
  sourceKey: string;
  runId: string;
  /** SHA-256 hex of the copied text or file, null when there is none. */
  sourceSha256: string | null;
  /** The id of what the copy created (an evidence id), null when nothing was created. */
  targetRef: string | null;
}

export interface CopyRunInput {
  id: string;
  sourceProgramId: string;
  sourceFramework: string;
  mappingSha256: string;
  actor: string;
  actorUserId: string | null;
  summary: FrameworkCopySummary;
}

/** One run's transaction: the client in PostgreSQL (null in memory mode) and the undo steps of the memory store. */
export interface CopyTx {
  client: pg.PoolClient | null;
  onRollback(undo: () => void): void;
}

// ------------------------------------------------------------------------------------------------ memory store

interface MemoryMarker extends CopyMarkerInput {
  copiedAt: string;
}
interface MemoryRun extends FrameworkCopyRun {
  mappingSha256: string;
}
const memoryMarkers = new Map<string, Map<string, MemoryMarker>>(); // key: tenantId__programId -> `${sourceProgramId}|${kind}|${target}|${sourceKey}`
const memoryRuns = new Map<string, MemoryRun[]>(); // key: tenantId__programId, oldest first

const markerId = (m: Pick<CopyMarkerInput, 'sourceProgramId' | 'kind' | 'targetControlId' | 'sourceKey'>): string => `${m.sourceProgramId}|${markerKey(m.kind, m.targetControlId, m.sourceKey)}`;

/** Test hook. */
export function __resetFrameworkCopyForTests(): void {
  memoryMarkers.clear();
  memoryRuns.clear();
}

/** Test hook: how many markers and runs the memory store holds for the (target) program. */
export function __frameworkCopyRowsForTests(scope: ProgramScope): { markers: number; runs: number } {
  return { markers: memoryMarkers.get(keyOf(scope))?.size ?? 0, runs: memoryRuns.get(keyOf(scope))?.length ?? 0 };
}

/** The rows of a deleted program go with it (in PostgreSQL the foreign keys cascade). */
export function __deleteFrameworkCopyForMemory(scope: ProgramScope): void {
  if (!hasScope(scope)) return;
  memoryMarkers.delete(keyOf(scope));
  memoryRuns.delete(keyOf(scope));
}

// ------------------------------------------------------------------------------------------------ transaction

/**
 * Runs `fn` in one transaction under the tenant's and the program's row policies (PostgreSQL), or with the memory undo list. A throw rolls everything back
 * (PostgreSQL) or runs the undo steps, newest first (memory), and is rethrown.
 */
export async function withCopyTx<T>(scope: ProgramScope, fn: (tx: CopyTx) => Promise<T>): Promise<T> {
  if (isMemory()) {
    const undo: (() => void)[] = [];
    try {
      return await fn({ client: null, onRollback: (u) => undo.push(u) });
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', scope.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    const result = await fn({ client, onRollback: () => undefined });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------ markers

/**
 * The markers of earlier runs for the (target, source) pair: `KIND|target|key` -> the SHA-256 stored with it (null when none). The planner reads it to
 * find what is already copied and what changed since.
 */
export async function listMarkers(scope: ProgramScope, sourceProgramId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!hasScope(scope)) return out;
  if (isMemory()) {
    for (const m of memoryMarkers.get(keyOf(scope))?.values() ?? []) {
      if (m.sourceProgramId === sourceProgramId) out.set(markerKey(m.kind, m.targetControlId, m.sourceKey), m.sourceSha256);
    }
    return out;
  }
  const res = await queryWithProgram(
    scope,
    'SELECT item_kind, target_control_id, source_key, source_sha256 FROM program_framework_copy_items WHERE tenant_id = $1 AND program_id = $2 AND source_program_id = $3',
    [scope.tenantId, scope.programId, sourceProgramId]
  );
  for (const r of res.rows) out.set(markerKey(String(r.item_kind) as FrameworkCopyKind, String(r.target_control_id), String(r.source_key)), r.source_sha256 ?? null);
  return out;
}

/**
 * Records the marker of one item, FIRST, in the run's transaction: true when this run now owns the pair, false when a marker already exists (the caller
 * then appends nothing). ON CONFLICT DO NOTHING RETURNING in PostgreSQL, so two concurrent runs cannot both win.
 */
export async function insertMarkerTx(tx: CopyTx, scope: ProgramScope, input: CopyMarkerInput): Promise<boolean> {
  if (tx.client === null) {
    let map = memoryMarkers.get(keyOf(scope));
    if (!map) {
      map = new Map();
      memoryMarkers.set(keyOf(scope), map);
    }
    const id = markerId(input);
    if (map.has(id)) return false;
    map.set(id, { ...input, copiedAt: new Date().toISOString() });
    const owner = map;
    tx.onRollback(() => owner.delete(id));
    return true;
  }
  const res = await tx.client.query(
    `INSERT INTO program_framework_copy_items (tenant_id, program_id, source_program_id, item_kind, target_control_id, source_key, run_id, source_sha256, target_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING source_key`,
    [scope.tenantId, scope.programId, input.sourceProgramId, input.kind, input.targetControlId, input.sourceKey, input.runId, input.sourceSha256, input.targetRef]
  );
  return res.rows.length > 0;
}

// ------------------------------------------------------------------------------------------------ runs

/** Records the run (counts and ids only) in the run's transaction. */
export async function insertRunTx(tx: CopyTx, scope: ProgramScope, input: CopyRunInput): Promise<void> {
  if (tx.client === null) {
    let list = memoryRuns.get(keyOf(scope));
    if (!list) {
      list = [];
      memoryRuns.set(keyOf(scope), list);
    }
    const target = list;
    const row: MemoryRun = {
      id: input.id,
      sourceProgramId: input.sourceProgramId,
      sourceFramework: input.sourceFramework,
      actor: input.actor.slice(0, 255),
      createdAt: new Date().toISOString(),
      summary: { ...input.summary, controls: [...input.summary.controls] },
      mappingSha256: input.mappingSha256,
    };
    target.push(row);
    tx.onRollback(() => {
      const at = target.indexOf(row);
      if (at >= 0) target.splice(at, 1);
    });
    return;
  }
  await tx.client.query(
    `INSERT INTO program_framework_copy_runs (id, tenant_id, program_id, source_program_id, source_framework, mapping_sha256, actor, actor_user_id, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [input.id, scope.tenantId, scope.programId, input.sourceProgramId, input.sourceFramework, input.mappingSha256, input.actor.slice(0, 255), input.actorUserId ? input.actorUserId.slice(0, 128) : null, JSON.stringify(input.summary)]
  );
}

const publicRun = ({ mappingSha256: _mapping, ...run }: MemoryRun): FrameworkCopyRun => ({ ...run, summary: { ...run.summary, controls: [...run.summary.controls] } });

/** The runs of the (target) program, newest first (at most `limit`, 1 to 200, 50 by default). */
export async function listRuns(scope: ProgramScope, limit = 50): Promise<FrameworkCopyRun[]> {
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 50)));
  if (!hasScope(scope)) return [];
  if (isMemory()) return [...(memoryRuns.get(keyOf(scope)) ?? [])].reverse().slice(0, n).map(publicRun);
  const res = await queryWithProgram(
    scope,
    'SELECT id, source_program_id, source_framework, actor, created_at, summary FROM program_framework_copy_runs WHERE tenant_id = $1 AND program_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    [scope.tenantId, scope.programId, n]
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    sourceProgramId: String(r.source_program_id),
    sourceFramework: String(r.source_framework),
    actor: String(r.actor),
    createdAt: iso(r.created_at),
    summary: (r.summary ?? {}) as FrameworkCopySummary,
  }));
}

/** The newest run of the (target) program, or null. */
export async function latestRun(scope: ProgramScope): Promise<FrameworkCopyRun | null> {
  return (await listRuns(scope, 1))[0] ?? null;
}

/** A fresh run id (a UUID, like the column default). */
export const newRunId = (): string => crypto.randomUUID();
