import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode } from '../db';
import { VM_CONFIG_RESULTS } from '../../src/types/vm';
import type { VmConfigResult, VmConfigRuleResult, VmConfigScan, VmConfigSeverity } from '../../src/types/vm';
import type { NormalizedConfigScan } from './adapters/config';
import { emptyResultCounts } from './adapters/config';
import { selectLatestScans } from './configSuggestions';
import { withVmTenantTx } from './findingsStore';

/**
 * Persistence of configuration scans and their rule results (issue #103): PostgreSQL (one tenant transaction, shared with the VM
 * worker through withVmTenantTx) or process memory when DB_MODE=memory. A run's scans are replaced as a whole, so reprocessing a
 * run stores the same rows again instead of adding to them. Nothing here reads or writes a control.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Rows per multi-row INSERT: keeps every statement far below the 65535 bind-parameter limit. */
const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const placeholders = (rows: number, width: number): string =>
  Array.from({ length: rows }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`).join(',');

const memoryScans = new Map<string, VmConfigScan>(); // key: id
const memoryResults = new Map<string, VmConfigRuleResult[]>(); // key: scan id

/** Test hook. */
export function __resetVmConfigForTests(): void {
  memoryScans.clear();
  memoryResults.clear();
}

function need(client: pg.PoolClient | null): pg.PoolClient {
  if (!client) throw new Error('A PostgreSQL client is required outside memory mode');
  return client;
}

export interface ConfigScanDraft {
  assetId: string;
  scan: NormalizedConfigScan;
}

/** One scan per (asset, benchmark, profile, scan time) in a run, as the schema requires: the first of a repeat wins. */
const draftKey = (d: ConfigScanDraft): string => `${d.assetId}|${d.scan.benchmarkId}|${d.scan.profileId}|${Date.parse(d.scan.scannedAt)}`;

function rowToScan(r: pg.QueryResultRow): VmConfigScan {
  const counts = emptyResultCounts();
  const stored = (r.result_counts ?? {}) as Record<string, unknown>;
  for (const k of VM_CONFIG_RESULTS) counts[k] = Number(stored[k] ?? 0);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    runId: r.run_id,
    sourceId: r.source_id,
    assetId: r.asset_id,
    benchmarkId: r.benchmark_id,
    benchmarkVersion: r.benchmark_version ?? '',
    benchmarkTitle: r.benchmark_title ?? '',
    profileId: r.profile_id ?? '',
    profileTitle: r.profile_title ?? '',
    scannerName: r.scanner_name,
    scannerVersion: r.scanner_version ?? '',
    startedAt: iso(r.started_at),
    scannedAt: iso(r.scanned_at) as string,
    receivedAt: iso(r.received_at) as string,
    sourceSha256: r.source_sha256 ? String(r.source_sha256) : null,
    resultCounts: counts,
  };
}

function rowToResult(r: pg.QueryResultRow): VmConfigRuleResult {
  return {
    scanId: r.scan_id,
    ruleId: r.rule_id,
    cce: r.cce ?? null,
    result: r.result as VmConfigResult,
    severity: (r.severity ?? null) as VmConfigSeverity | null,
    title: r.title ?? '',
  };
}

const byRule = (a: VmConfigRuleResult, b: VmConfigRuleResult): number => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);
const newestFirst = (a: VmConfigScan, b: VmConfigScan): number =>
  Date.parse(b.scannedAt) - Date.parse(a.scannedAt) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ------------------------------------------------------------------------------------------------ writing

/**
 * Replaces the run's configuration scans: deletes the ones stored for the run (their results go with them), then inserts `drafts`.
 * Runs inside the worker's transaction (the client is null in memory mode). Returns the number of rule results stored.
 */
export async function replaceRunConfigScans(
  tenantId: string,
  run: { id: string; sourceId: string; receivedAt: string },
  drafts: ConfigScanDraft[],
  client: pg.PoolClient | null,
): Promise<number> {
  const seen = new Set<string>();
  const unique = drafts.filter((d) => {
    const key = draftKey(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const received = new Date(run.receivedAt).toISOString();

  if (isMemory()) {
    for (const [id, s] of [...memoryScans]) {
      if (s.tenantId === tenantId && s.runId === run.id) {
        memoryScans.delete(id);
        memoryResults.delete(id);
      }
    }
    let stored = 0;
    for (const d of unique) {
      const id = crypto.randomUUID();
      memoryScans.set(id, {
        id,
        tenantId,
        runId: run.id,
        sourceId: run.sourceId,
        assetId: d.assetId,
        benchmarkId: d.scan.benchmarkId,
        benchmarkVersion: d.scan.benchmarkVersion,
        benchmarkTitle: d.scan.benchmarkTitle,
        profileId: d.scan.profileId,
        profileTitle: d.scan.profileTitle,
        scannerName: d.scan.scannerName,
        scannerVersion: d.scan.scannerVersion,
        startedAt: d.scan.startedAt,
        scannedAt: d.scan.scannedAt,
        receivedAt: received,
        sourceSha256: d.scan.sourceSha256,
        resultCounts: { ...d.scan.counts },
      });
      memoryResults.set(
        id,
        d.scan.results.map((r) => ({ scanId: id, ruleId: r.ruleId, cce: r.cce, result: r.result, severity: r.severity, title: r.title })),
      );
      stored += d.scan.results.length;
    }
    return stored;
  }

  const c = need(client);
  await c.query('DELETE FROM vm_config_scans WHERE tenant_id = $1 AND run_id = $2', [tenantId, run.id]);
  const ids = unique.map(() => crypto.randomUUID());
  const SCAN_WIDTH = 17;
  for (const part of chunks(unique.map((d, i) => ({ d, id: ids[i] })))) {
    await c.query(
      `INSERT INTO vm_config_scans (id, tenant_id, run_id, source_id, asset_id, benchmark_id, benchmark_version, benchmark_title, profile_id,
                                    profile_title, scanner_name, scanner_version, started_at, scanned_at, received_at, source_sha256, result_counts)
       VALUES ${Array.from({ length: part.length }, (_, r) => `(${Array.from({ length: SCAN_WIDTH }, (_, k) => `$${r * SCAN_WIDTH + k + 1}${k === SCAN_WIDTH - 1 ? '::jsonb' : ''}`).join(',')})`).join(',')}`,
      part.flatMap(({ d, id }) => [
        id, tenantId, run.id, run.sourceId, d.assetId, d.scan.benchmarkId, d.scan.benchmarkVersion, d.scan.benchmarkTitle, d.scan.profileId,
        d.scan.profileTitle, d.scan.scannerName, d.scan.scannerVersion, d.scan.startedAt, d.scan.scannedAt, received, d.scan.sourceSha256,
        JSON.stringify(d.scan.counts),
      ]),
    );
  }
  const rows: unknown[][] = [];
  unique.forEach((d, i) => {
    for (const r of d.scan.results) rows.push([tenantId, ids[i], r.ruleId, r.cce, r.result, r.severity, r.title]);
  });
  for (const part of chunks(rows)) {
    await c.query(
      `INSERT INTO vm_config_results (tenant_id, scan_id, rule_id, cce, result, severity, title) VALUES ${placeholders(part.length, 7)}`,
      part.flat(),
    );
  }
  return rows.length;
}

// ------------------------------------------------------------------------------------------------ reading

export interface ConfigScanFilter {
  assetId?: string;
  /** Only the newest scan per (asset, source, benchmark, profile). */
  latestOnly: boolean;
  limit: number;
}

/** Newest first. `totalCount` is the size of the filtered set before the limit. */
export async function listConfigScans(tenantId: string, f: ConfigScanFilter): Promise<{ totalCount: number; scans: VmConfigScan[] }> {
  if (isMemory()) {
    let scans = [...memoryScans.values()].filter((s) => s.tenantId === tenantId && (!f.assetId || s.assetId === f.assetId));
    if (f.latestOnly) scans = selectLatestScans(scans);
    scans.sort(newestFirst);
    return { totalCount: scans.length, scans: scans.slice(0, f.limit).map((s) => ({ ...s, resultCounts: { ...s.resultCounts } })) };
  }
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1';
  if (f.assetId) {
    params.push(f.assetId);
    where += ` AND asset_id = $${params.length}`;
  }
  const filtered = f.latestOnly
    ? `SELECT DISTINCT ON (asset_id, source_id, benchmark_id, profile_id) * FROM vm_config_scans WHERE ${where}
       ORDER BY asset_id, source_id, benchmark_id, profile_id, scanned_at DESC, received_at DESC, id`
    : `SELECT * FROM vm_config_scans WHERE ${where}`;
  params.push(f.limit);
  return withVmTenantTx(tenantId, async (client) => {
    const { rows } = await need(client).query(
      `SELECT *, count(*) OVER () AS total_count FROM (${filtered}) s ORDER BY scanned_at DESC, received_at DESC, id LIMIT $${params.length}`,
      params,
    );
    // The window count is taken before the limit; the limit is at least 1, so no row means an empty set.
    return { totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0, scans: rows.map(rowToScan) };
  });
}

export async function getConfigScan(tenantId: string, scanId: string): Promise<VmConfigScan | null> {
  if (isMemory()) {
    const s = memoryScans.get(scanId);
    return s && s.tenantId === tenantId ? { ...s, resultCounts: { ...s.resultCounts } } : null;
  }
  return withVmTenantTx(tenantId, async (client) => {
    const { rows } = await need(client).query('SELECT * FROM vm_config_scans WHERE tenant_id = $1 AND id = $2', [tenantId, scanId]);
    return rows[0] ? rowToScan(rows[0]) : null;
  });
}

export interface ConfigResultFilter {
  result?: VmConfigResult;
  limit: number;
}

/** Rule results of one scan, by rule id. `totalCount` is the size of the filtered set before the limit. */
export async function listConfigResults(tenantId: string, scanId: string, f: ConfigResultFilter): Promise<{ totalCount: number; results: VmConfigRuleResult[] }> {
  if (isMemory()) {
    const scan = memoryScans.get(scanId);
    if (!scan || scan.tenantId !== tenantId) return { totalCount: 0, results: [] };
    const all = (memoryResults.get(scanId) ?? []).filter((r) => !f.result || r.result === f.result).sort(byRule);
    return { totalCount: all.length, results: all.slice(0, f.limit).map((r) => ({ ...r })) };
  }
  return withVmTenantTx(tenantId, async (client) => {
    const c = need(client);
    const params: unknown[] = [tenantId, scanId];
    let where = 'tenant_id = $1 AND scan_id = $2';
    if (f.result) {
      params.push(f.result);
      where += ` AND result = $${params.length}`;
    }
    const count = await c.query(`SELECT count(*)::int AS n FROM vm_config_results WHERE ${where}`, params);
    params.push(f.limit);
    const { rows } = await c.query(`SELECT * FROM vm_config_results WHERE ${where} ORDER BY rule_id LIMIT $${params.length}`, params);
    return { totalCount: Number(count.rows[0]?.n ?? 0), results: rows.map(rowToResult) };
  });
}

/**
 * The newest scan per (asset, source, benchmark, profile) of the given assets, with all of their rule results: what the
 * suggestions read. Assets with no scan simply have none.
 */
export async function loadLatestConfigResults(tenantId: string, assetIds: string[]): Promise<{ scans: VmConfigScan[]; results: VmConfigRuleResult[] }> {
  if (assetIds.length === 0) return { scans: [], results: [] };
  if (isMemory()) {
    const wanted = new Set(assetIds);
    const scans = selectLatestScans([...memoryScans.values()].filter((s) => s.tenantId === tenantId && wanted.has(s.assetId)));
    const results = scans.flatMap((s) => (memoryResults.get(s.id) ?? []).map((r) => ({ ...r })));
    return { scans: scans.map((s) => ({ ...s, resultCounts: { ...s.resultCounts } })), results };
  }
  return withVmTenantTx(tenantId, async (client) => {
    const c = need(client);
    const found = await c.query(
      `SELECT DISTINCT ON (asset_id, source_id, benchmark_id, profile_id) *
         FROM vm_config_scans
        WHERE tenant_id = $1 AND asset_id = ANY($2::text[])
        ORDER BY asset_id, source_id, benchmark_id, profile_id, scanned_at DESC, received_at DESC, id`,
      [tenantId, assetIds],
    );
    const scans = found.rows.map(rowToScan);
    if (scans.length === 0) return { scans, results: [] };
    const res = await c.query('SELECT * FROM vm_config_results WHERE tenant_id = $1 AND scan_id = ANY($2::text[])', [tenantId, scans.map((s) => s.id)]);
    return { scans, results: res.rows.map(rowToResult) };
  });
}
