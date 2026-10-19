import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from '../db';
import type { VmRun, VmRunStatus, VmSource, VmSourceKind } from '../../src/types/vm';

/**
 * Persistence of vulnerability-ingest sources and runs: PostgreSQL (tenant RLS context set on every transaction) or process
 * memory when DB_MODE=memory. The memory branch enforces the same uniqueness as the schema (label per tenant, case
 * insensitive; raw_sha256 per tenant) so the duplicate path behaves the same in tests.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export type VmStoreErrorCode = 'duplicate' | 'source_kind_mismatch' | 'not_found';

export class VmStoreError extends Error {
  constructor(public readonly code: VmStoreErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VmStoreError';
  }
}

const memorySources = new Map<string, VmSource>();
const memoryRuns = new Map<string, VmRun>();

/** Test hook. */
export function __resetVmStoreForTests(): void {
  memorySources.clear();
  memoryRuns.clear();
}

async function inTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------ row mapping

function rowToSource(r: pg.QueryResultRow): VmSource {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind as VmSourceKind,
    label: r.label,
    enabled: Boolean(r.enabled),
    expectedIntervalMinutes: Number(r.expected_interval_minutes),
    lastRunId: r.last_run_id ?? null,
    lastRunAt: iso(r.last_run_at),
    staleSince: iso(r.stale_since),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

function rowToRun(r: pg.QueryResultRow): VmRun {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    sourceId: r.source_id,
    receivedAt: iso(r.received_at) as string,
    collectedAt: iso(r.collected_at),
    exporterName: r.exporter_name,
    exporterVersion: r.exporter_version,
    hostCount: Number(r.host_count),
    findingCount: Number(r.finding_count),
    rawPath: r.raw_path,
    rawSha256: r.raw_sha256,
    rawBytes: Number(r.raw_bytes),
    status: r.status as VmRunStatus,
    error: r.error ?? null,
    warning: r.warning ?? null,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export interface ReceivedRunInput {
  id: string;
  kind: VmSourceKind;
  label: string;
  collectedAt: string | null;
  exporterName: string;
  exporterVersion: string;
  hostCount: number;
  findingCount: number;
  rawPath: string;
  rawSha256: string;
  rawBytes: number;
}

export interface RunPatch {
  status?: VmRunStatus;
  error?: string | null;
  warning?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

// ------------------------------------------------------------------------------------------------ runs

export async function findRunBySha(tenantId: string, sha256: string): Promise<VmRun | null> {
  if (isMemory()) {
    for (const run of memoryRuns.values()) if (run.tenantId === tenantId && run.rawSha256 === sha256) return { ...run };
    return null;
  }
  return inTenantTx(tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM vm_runs WHERE tenant_id = $1 AND raw_sha256 = $2', [tenantId, sha256]);
    return rows[0] ? rowToRun(rows[0]) : null;
  });
}

/**
 * Records a run in status RECEIVED and resolves its source by (tenant, lower(label)), creating the source when the label is
 * new. One transaction: a duplicate body (same raw_sha256) or a kind mismatch leaves nothing behind.
 */
export async function recordReceivedRun(tenantId: string, input: ReceivedRunInput): Promise<{ run: VmRun; source: VmSource }> {
  if (isMemory()) {
    const lower = input.label.toLowerCase();
    let source = [...memorySources.values()].find((s) => s.tenantId === tenantId && s.label.toLowerCase() === lower);
    if (source && source.kind !== input.kind) throw new VmStoreError('source_kind_mismatch');
    for (const r of memoryRuns.values()) {
      if (r.tenantId === tenantId && r.rawSha256 === input.rawSha256) throw new VmStoreError('duplicate');
    }
    const now = new Date().toISOString();
    if (!source) {
      source = {
        id: crypto.randomUUID(),
        tenantId,
        kind: input.kind,
        label: input.label,
        enabled: true,
        expectedIntervalMinutes: 1440,
        lastRunId: null,
        lastRunAt: null,
        staleSince: null,
        createdAt: now,
        updatedAt: now,
      };
      memorySources.set(source.id, source);
    }
    const run: VmRun = {
      id: input.id,
      tenantId,
      sourceId: source.id,
      receivedAt: now,
      collectedAt: iso(input.collectedAt),
      exporterName: input.exporterName,
      exporterVersion: input.exporterVersion,
      hostCount: input.hostCount,
      findingCount: input.findingCount,
      rawPath: input.rawPath,
      rawSha256: input.rawSha256,
      rawBytes: input.rawBytes,
      status: 'RECEIVED',
      error: null,
      warning: null,
      startedAt: null,
      finishedAt: null,
    };
    memoryRuns.set(run.id, run);
    source.lastRunId = run.id;
    source.lastRunAt = now;
    source.updatedAt = now;
    return { run: { ...run }, source: { ...source } };
  }

  return inTenantTx(tenantId, async (client) => {
    await client.query(
      `INSERT INTO vm_sources (tenant_id, kind, label) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, input.kind, input.label],
    );
    const found = await client.query('SELECT * FROM vm_sources WHERE tenant_id = $1 AND lower(label) = lower($2)', [tenantId, input.label]);
    const existing = found.rows[0];
    if (!existing) throw new Error('Source could not be resolved');
    if (existing.kind !== input.kind) throw new VmStoreError('source_kind_mismatch');

    let runRow: pg.QueryResultRow;
    try {
      const inserted = await client.query(
        `INSERT INTO vm_runs (id, tenant_id, source_id, collected_at, exporter_name, exporter_version, host_count, finding_count,
                              raw_path, raw_sha256, raw_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'RECEIVED')
         RETURNING *`,
        [
          input.id,
          tenantId,
          existing.id,
          input.collectedAt,
          input.exporterName,
          input.exporterVersion,
          input.hostCount,
          input.findingCount,
          input.rawPath,
          input.rawSha256,
          input.rawBytes,
        ],
      );
      runRow = inserted.rows[0];
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'unq_vm_runs_raw_sha256') throw new VmStoreError('duplicate');
      throw err;
    }

    const updated = await client.query(
      `UPDATE vm_sources SET last_run_id = $3, last_run_at = $4, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, existing.id, runRow.id, runRow.received_at],
    );
    return { run: rowToRun(runRow), source: rowToSource(updated.rows[0]) };
  });
}

export async function getRun(tenantId: string, id: string): Promise<VmRun | null> {
  if (isMemory()) {
    const run = memoryRuns.get(id);
    return run && run.tenantId === tenantId ? { ...run } : null;
  }
  return inTenantTx(tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM vm_runs WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  });
}

/** Newest first by received_at. */
export async function listRuns(tenantId: string, options: { limit?: number } = {}): Promise<VmRun[]> {
  const limit = options.limit ?? 100;
  if (isMemory()) {
    // Reversed first so runs received in the same millisecond still list newest first (the sort is stable).
    return [...memoryRuns.values()]
      .reverse()
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  return inTenantTx(tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM vm_runs WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT $2', [tenantId, limit]);
    return rows.map(rowToRun);
  });
}

/** Applies only the fields present in `patch`; `error: null` clears the error. */
export async function updateRun(tenantId: string, id: string, patch: RunPatch): Promise<VmRun> {
  if (isMemory()) {
    const run = memoryRuns.get(id);
    if (!run || run.tenantId !== tenantId) throw new VmStoreError('not_found');
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.error !== undefined) run.error = patch.error;
    if (patch.warning !== undefined) run.warning = patch.warning;
    if (patch.startedAt !== undefined) run.startedAt = iso(patch.startedAt);
    if (patch.finishedAt !== undefined) run.finishedAt = iso(patch.finishedAt);
    return { ...run };
  }
  const sets: string[] = [];
  const params: unknown[] = [tenantId, id];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.error !== undefined) add('error', patch.error);
  if (patch.warning !== undefined) add('warning', patch.warning);
  if (patch.startedAt !== undefined) add('started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
  return inTenantTx(tenantId, async (client) => {
    const sql = sets.length
      ? `UPDATE vm_runs SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`
      : 'SELECT * FROM vm_runs WHERE tenant_id = $1 AND id = $2';
    const { rows } = await client.query(sql, params);
    if (!rows[0]) throw new VmStoreError('not_found');
    return rowToRun(rows[0]);
  });
}

/** Runs the worker has not finished (RECEIVED or NORMALIZING), oldest first. Used to recover after a restart. */
export async function listUnfinishedRuns(tenantId: string): Promise<VmRun[]> {
  if (isMemory()) {
    return [...memoryRuns.values()]
      .filter((r) => r.tenantId === tenantId && (r.status === 'RECEIVED' || r.status === 'NORMALIZING'))
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0))
      .map((r) => ({ ...r }));
  }
  return inTenantTx(tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM vm_runs WHERE tenant_id = $1 AND status IN ('RECEIVED', 'NORMALIZING') ORDER BY received_at",
      [tenantId],
    );
    return rows.map(rowToRun);
  });
}

/** Puts a run back to RECEIVED with its error, warning and timestamps cleared, so the worker normalizes it again. */
export async function resetRunForReprocess(tenantId: string, id: string): Promise<VmRun> {
  return updateRun(tenantId, id, { status: 'RECEIVED', error: null, warning: null, startedAt: null, finishedAt: null });
}

// ------------------------------------------------------------------------------------------------ sources

export async function listSources(tenantId: string): Promise<VmSource[]> {
  if (isMemory()) {
    return [...memorySources.values()]
      .filter((s) => s.tenantId === tenantId)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
      .map((s) => ({ ...s }));
  }
  return inTenantTx(tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM vm_sources WHERE tenant_id = $1 ORDER BY lower(label)', [tenantId]);
    return rows.map(rowToSource);
  });
}
