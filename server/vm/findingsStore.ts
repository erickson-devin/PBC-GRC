import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, nextStamp, pool, queryWithProgram, type ProgramScope } from '../db';
import { listAssets } from '../assets';
import { listSources, noteSourceNormalized, updateRun } from './store';
import type { ApplyRunResult, LinkedPoamItem, OpenAutoPoamItem, PoamCandidate, PoamDraft, SightingDraft } from './storeTypes';
import { planPoamCompletions, VM_WORKER_ACTOR, type OtherSourceReport } from './transitions';
import { matchesExpected, notesDigest, StaleWriteError } from '../controlAssessments';
import { planVmPoamStatus, vmPoamFindingOpenInEpisode } from '../../src/data/vmPoamEdit';
import { VM_POAM_PACKAGES_RETURNED } from '../../src/types/vm';
import type { VmAffectedPackage, VmFinding, VmFindingStatus, VmPoamItem, VmPoamItemEvent, VmPoamItemPatch, VmPoamRow, VmPoamStatus, VmRun, VmSeverity, VmSighting, VmUpcomingFinding, VmVuln, VmVulnSource } from '../../src/types/vm';

/**
 * Persistence of findings, sightings, vulnerability reference rows and POA&M items for the VM worker: PostgreSQL (one tenant
 * transaction per run, opened by withVmTenantTx) or process memory when DB_MODE=memory. The memory branch enforces the same
 * uniqueness as the schema (sighting per run and finding; one auto-created POA&M item per finding episode and program) so reprocessing behaves
 * the same in tests.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Rows per multi-row INSERT / UPDATE: keeps every statement far below the 65535 bind-parameter limit. */
const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const memoryFindings = new Map<string, VmFinding>(); // key: id
const memorySightings = new Map<string, VmSighting>(); // key: tenantId|runId|findingId
const memoryRunAssets = new Map<string, { tenantId: string; runId: string; assetId: string; sourceId: string; receivedAt: string }>(); // key: tenantId|runId|assetId
const memoryPoam = new Map<string, VmPoamItem>(); // key: id (programId is null when a caller passes none; see insertPoamItems)
const memoryVulns = new Map<string, VmVuln>(); // key: vuln_id
/** vm_poam_item_events in memory mode, oldest first (the PostgreSQL table without the digest columns). Never holds owner or mitigation text. */
export const memoryPoamEvents: Array<VmPoamItemEvent & { tenantId: string; programId: string }> = [];

/** Test hook. */
export function __resetVmFindingsForTests(): void {
  memoryFindings.clear();
  memorySightings.clear();
  memoryRunAssets.clear();
  memoryPoam.clear();
  memoryPoamEvents.length = 0;
  memoryVulns.clear();
}

const newVuln = (vulnId: string, kev: boolean): VmVuln => ({
  vulnId,
  title: '',
  cvssV3: null,
  severity: null,
  publishedAt: null,
  kev,
  kevAddedAt: null,
  epss: null,
  epssPercentile: null,
  refs: [],
  source: 'INGEST',
  updatedAt: new Date().toISOString(),
});

/** Test hook: marks a vulnerability as known-exploited (memory mode), creating the reference row when it is missing. */
export function __setVmVulnKevForTests(vulnId: string, kev: boolean): void {
  const existing = memoryVulns.get(vulnId);
  if (existing) existing.kev = kev;
  else memoryVulns.set(vulnId, newVuln(vulnId, kev));
}

/**
 * Runs `fn` in one tenant transaction (the client is null in memory mode). Everything the worker writes for a run goes through
 * it, so a failure part-way commits nothing. With a `programId` the transaction also runs in that program's context (both settings,
 * tenant and program, which the program row policy of vm_poam_items needs); without one it can read no vm_poam_items row and write none.
 */
export async function withVmTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient | null) => Promise<T>, programId?: string): Promise<T> {
  if (isMemory()) return fn(null);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    if (programId) await client.query('SELECT set_config($1, $2, true)', ['app.current_program_id', programId]);
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

function need(client: pg.PoolClient | null): pg.PoolClient {
  if (!client) throw new Error('A PostgreSQL client is required outside memory mode');
  return client;
}

// ------------------------------------------------------------------------------------------------ row mapping

export function rowToFinding(r: pg.QueryResultRow): VmFinding {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    assetId: r.asset_id,
    vulnId: r.vuln_id,
    status: r.status as VmFindingStatus,
    severity: r.severity as VmSeverity,
    firstSeenAt: iso(r.first_seen_at) as string,
    lastSeenAt: iso(r.last_seen_at) as string,
    resolvedAt: iso(r.resolved_at),
    resolvedRunId: r.resolved_run_id ?? null,
    slaDueAt: iso(r.sla_due_at),
    packageName: r.package_name ?? '',
    packageVersion: r.package_version ?? '',
    fixedVersion: r.fixed_version ?? null,
    affectedPackages: Array.isArray(r.affected_packages)
      ? r.affected_packages.map((p: { name?: unknown; version?: unknown; fixedVersion?: string | null }) => ({ name: String(p.name ?? ''), version: String(p.version ?? ''), fixedVersion: p.fixedVersion ?? null }))
      : [],
    affectedPackageCount: Number(r.affected_package_count ?? 0),
    justification: r.justification ?? null,
    decidedBy: r.decided_by ?? null,
    decidedByUserId: r.decided_by_user_id ?? null,
    decidedAt: iso(r.decided_at),
  };
}

export function rowToSighting(r: pg.QueryResultRow): VmSighting {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    findingId: r.finding_id,
    runId: r.run_id,
    sourceId: r.source_id,
    reportedSeverity: r.reported_severity ?? null,
    reportedAt: iso(r.reported_at) as string,
    detail: (r.detail ?? {}) as Record<string, unknown>,
  };
}

export function rowToPoamItem(r: pg.QueryResultRow): VmPoamItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    findingId: r.finding_id ?? null,
    controlId: r.control_id,
    weakness: r.weakness,
    mitigation: r.mitigation ?? '',
    owner: r.owner ?? '',
    // DATE columns come back as Date at local midnight: format from local parts so the calendar date is preserved
    scheduledCompletion:
      r.scheduled_completion instanceof Date
        ? `${r.scheduled_completion.getFullYear()}-${String(r.scheduled_completion.getMonth() + 1).padStart(2, '0')}-${String(r.scheduled_completion.getDate()).padStart(2, '0')}`
        : (r.scheduled_completion ?? null),
    status: r.status as VmPoamStatus,
    createdBy: r.created_by,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    programId: r.program_id ?? null,
    findingFirstSeenAt: iso(r.finding_first_seen_at),
    updatedBy: r.updated_by ?? null,
    statusChangedBy: r.status_changed_by ?? null,
    statusChangedAt: iso(r.status_changed_at),
    autoComplete: r.auto_complete ?? true,
  };
}

export function rowToVuln(r: pg.QueryResultRow): VmVuln {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    vulnId: r.vuln_id,
    title: r.title ?? '',
    cvssV3: num(r.cvss_v3),
    severity: (r.severity ?? null) as VmSeverity | null,
    publishedAt: iso(r.published_at),
    kev: Boolean(r.kev),
    kevAddedAt: iso(r.kev_added_at),
    epss: num(r.epss),
    epssPercentile: num(r.epss_percentile),
    refs: Array.isArray(r.refs) ? r.refs : [],
    source: r.source as VmVulnSource,
    updatedAt: iso(r.updated_at) as string,
  };
}

// ------------------------------------------------------------------------------------------------ loading

/** Every finding of the given assets (any status), locked FOR UPDATE so two workers serialize on the same hosts. */
export async function loadFindingsForAssets(tenantId: string, assetIds: string[], client: pg.PoolClient | null): Promise<VmFinding[]> {
  if (assetIds.length === 0) return [];
  if (isMemory()) {
    const wanted = new Set(assetIds);
    return [...memoryFindings.values()].filter((f) => f.tenantId === tenantId && wanted.has(f.assetId)).map((f) => ({ ...f }));
  }
  const { rows } = await need(client).query('SELECT * FROM vm_findings WHERE tenant_id = $1 AND asset_id = ANY($2::text[]) FOR UPDATE', [tenantId, assetIds]);
  return rows.map(rowToFinding);
}

/** Ids of the given findings that this source sighted in a run other than `excludeRunId`. */
export async function loadSightedBySource(
  tenantId: string,
  sourceId: string,
  findingIds: string[],
  excludeRunId: string,
  client: pg.PoolClient | null,
): Promise<Set<string>> {
  if (findingIds.length === 0) return new Set();
  if (isMemory()) {
    const wanted = new Set(findingIds);
    const out = new Set<string>();
    for (const s of memorySightings.values()) {
      if (s.tenantId === tenantId && s.sourceId === sourceId && s.runId !== excludeRunId && wanted.has(s.findingId)) out.add(s.findingId);
    }
    return out;
  }
  const { rows } = await need(client).query(
    'SELECT DISTINCT finding_id FROM vm_sightings WHERE tenant_id = $1 AND source_id = $2 AND run_id <> $3 AND finding_id = ANY($4::text[])',
    [tenantId, sourceId, excludeRunId, findingIds],
  );
  return new Set(rows.map((r) => r.finding_id as string));
}

/**
 * For each OTHER source that reported one of the given assets: its latest run that listed the asset, whether the source is
 * enabled, its expected interval, and which of the given open findings that run sighted. Closure reads it so a finding another
 * manager still reports is not resolved by this one (docs/VULNERABILITY_MANAGEMENT.md, section 6.3). Runs from before
 * vm_run_assets existed have no rows and so are not seen.
 */
export async function loadOtherSourceReports(
  tenantId: string,
  sourceId: string,
  assetIds: string[],
  openFindingIds: string[],
  client: pg.PoolClient | null,
): Promise<OtherSourceReport[]> {
  if (assetIds.length === 0) return [];
  if (isMemory()) {
    const wanted = new Set(assetIds);
    const open = new Set(openFindingIds);
    const sources = new Map((await listSources(tenantId)).map((s) => [s.id, s]));
    const latest = new Map<string, { runId: string; assetId: string; sourceId: string; receivedAt: string }>();
    for (const ra of memoryRunAssets.values()) {
      if (ra.tenantId !== tenantId || ra.sourceId === sourceId || !wanted.has(ra.assetId)) continue;
      const key = `${ra.sourceId}|${ra.assetId}`;
      const cur = latest.get(key);
      if (!cur || ra.receivedAt > cur.receivedAt || (ra.receivedAt === cur.receivedAt && ra.runId > cur.runId)) latest.set(key, ra);
    }
    const out: OtherSourceReport[] = [];
    for (const l of latest.values()) {
      const src = sources.get(l.sourceId);
      if (!src) continue;
      const findingIds = new Set<string>();
      for (const s of memorySightings.values()) {
        if (s.tenantId === tenantId && s.runId === l.runId && open.has(s.findingId)) findingIds.add(s.findingId);
      }
      out.push({
        sourceId: l.sourceId,
        assetId: l.assetId,
        runId: l.runId,
        receivedAt: l.receivedAt,
        findingIds,
        enabled: src.enabled,
        expectedIntervalMinutes: src.expectedIntervalMinutes,
      });
    }
    return out;
  }
  const c = need(client);
  const { rows } = await c.query(
    `SELECT DISTINCT ON (r.source_id, ra.asset_id) r.source_id, ra.asset_id, ra.run_id, r.received_at, s.enabled, s.expected_interval_minutes
       FROM vm_run_assets ra
       JOIN vm_runs r ON r.tenant_id = ra.tenant_id AND r.id = ra.run_id
       JOIN vm_sources s ON s.tenant_id = r.tenant_id AND s.id = r.source_id
      WHERE ra.tenant_id = $1 AND ra.asset_id = ANY($2::text[]) AND r.source_id <> $3
      ORDER BY r.source_id, ra.asset_id, r.received_at DESC, ra.run_id DESC`,
    [tenantId, assetIds, sourceId],
  );
  if (rows.length === 0) return [];
  const runIds = [...new Set(rows.map((r) => r.run_id as string))];
  const sighted = new Map<string, Set<string>>(); // run id -> open findings it sighted
  if (openFindingIds.length > 0) {
    const res = await c.query(
      'SELECT run_id, finding_id FROM vm_sightings WHERE tenant_id = $1 AND run_id = ANY($2::text[]) AND finding_id = ANY($3::text[])',
      [tenantId, runIds, openFindingIds],
    );
    for (const r of res.rows) {
      const set = sighted.get(r.run_id as string) ?? new Set<string>();
      set.add(r.finding_id as string);
      sighted.set(r.run_id as string, set);
    }
  }
  return rows.map((r) => ({
    sourceId: r.source_id as string,
    assetId: r.asset_id as string,
    runId: r.run_id as string,
    receivedAt: new Date(r.received_at).toISOString(),
    findingIds: sighted.get(r.run_id as string) ?? new Set<string>(),
    enabled: r.enabled as boolean,
    expectedIntervalMinutes: r.expected_interval_minutes as number,
  }));
}

/** Which of the given vulnerabilities are on the known-exploited list. vm_vulns is global (no tenant filter). */
export async function loadKevVulnIds(vulnIds: string[], client: pg.PoolClient | null): Promise<Set<string>> {
  if (vulnIds.length === 0) return new Set();
  if (isMemory()) return new Set(vulnIds.filter((id) => memoryVulns.get(id)?.kev));
  const { rows } = await need(client).query('SELECT vuln_id FROM vm_vulns WHERE kev AND vuln_id = ANY($1::text[])', [vulnIds]);
  return new Set(rows.map((r) => r.vuln_id as string));
}

/** Tenant ingest may only insert a missing vuln_id (source INGEST); it never updates an existing row. */
export async function insertMissingVulns(vulnIds: string[], client: pg.PoolClient | null): Promise<void> {
  if (vulnIds.length === 0) return;
  if (isMemory()) {
    for (const id of vulnIds) if (!memoryVulns.has(id)) memoryVulns.set(id, newVuln(id, false));
    return;
  }
  await need(client).query("INSERT INTO vm_vulns (vuln_id, source) SELECT unnest($1::text[]), 'INGEST' ON CONFLICT (vuln_id) DO NOTHING", [[...new Set(vulnIds)]]);
}

// ------------------------------------------------------------------------------------------------ writing

const FINDING_COLUMNS = [
  'id', 'tenant_id', 'asset_id', 'vuln_id', 'status', 'severity', 'first_seen_at', 'last_seen_at', 'resolved_at', 'resolved_run_id',
  'sla_due_at', 'package_name', 'package_version', 'fixed_version', 'affected_packages', 'affected_package_count', 'justification', 'decided_by', 'decided_by_user_id', 'decided_at',
];

const findingValues = (f: VmFinding): unknown[] => [
  f.id, f.tenantId, f.assetId, f.vulnId, f.status, f.severity, f.firstSeenAt, f.lastSeenAt, f.resolvedAt, f.resolvedRunId,
  f.slaDueAt, f.packageName, f.packageVersion, f.fixedVersion, JSON.stringify(f.affectedPackages), f.affectedPackageCount, f.justification, f.decidedBy, f.decidedByUserId, f.decidedAt,
];

/** Builds `($1,$2,...),($n,...)` placeholders for `rows` rows of `width` columns. */
const placeholders = (rows: number, width: number): string =>
  Array.from({ length: rows }, (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`).join(',');

/**
 * Inserts the created findings and updates the changed and resolved ones by (tenant_id, id). Updates write only what the
 * reducer owns; the human decision columns (justification, decided_*) are never touched here.
 */
export async function saveFindings(tenantId: string, result: ApplyRunResult, client: pg.PoolClient | null): Promise<void> {
  if (isMemory()) {
    for (const f of [...result.created, ...result.updated, ...result.resolved]) {
      const stored = memoryFindings.get(f.id);
      // Updates keep the stored decision columns, like the SQL below
      memoryFindings.set(f.id, stored ? { ...f, justification: stored.justification, decidedBy: stored.decidedBy, decidedByUserId: stored.decidedByUserId, decidedAt: stored.decidedAt } : { ...f, tenantId });
    }
    return;
  }
  const c = need(client);
  for (const part of chunks(result.created)) {
    await c.query(`INSERT INTO vm_findings (${FINDING_COLUMNS.join(', ')}) VALUES ${placeholders(part.length, FINDING_COLUMNS.length)}`, part.flatMap(findingValues));
  }
  for (const part of chunks([...result.updated, ...result.resolved])) {
    await c.query(
      `UPDATE vm_findings AS f SET status = u.status, severity = u.severity, first_seen_at = u.first_seen_at, last_seen_at = u.last_seen_at,
              resolved_at = u.resolved_at, resolved_run_id = u.resolved_run_id, sla_due_at = u.sla_due_at, package_name = u.package_name,
              package_version = u.package_version, fixed_version = u.fixed_version,
              affected_packages = u.affected_packages::jsonb, affected_package_count = u.affected_package_count
       FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::timestamptz[], $8::text[], $9::timestamptz[],
                   $10::text[], $11::text[], $12::text[], $13::text[], $14::int[])
            AS u(id, status, severity, first_seen_at, last_seen_at, resolved_at, resolved_run_id, sla_due_at, package_name, package_version, fixed_version, affected_packages, affected_package_count)
       WHERE f.tenant_id = $1 AND f.id = u.id`,
      [
        tenantId,
        part.map((f) => f.id),
        part.map((f) => f.status),
        part.map((f) => f.severity),
        part.map((f) => f.firstSeenAt),
        part.map((f) => f.lastSeenAt),
        part.map((f) => f.resolvedAt),
        part.map((f) => f.resolvedRunId),
        part.map((f) => f.slaDueAt),
        part.map((f) => f.packageName),
        part.map((f) => f.packageVersion),
        part.map((f) => f.fixedVersion),
        part.map((f) => JSON.stringify(f.affectedPackages)),
        part.map((f) => f.affectedPackageCount),
      ],
    );
  }
}

/** Idempotent: a sighting already stored for (tenant, run, finding) is kept, so a reprocessed run adds nothing. */
export async function insertSightings(tenantId: string, drafts: SightingDraft[], client: pg.PoolClient | null): Promise<void> {
  if (drafts.length === 0) return;
  if (isMemory()) {
    for (const d of drafts) {
      const key = `${tenantId}|${d.runId}|${d.findingId}`;
      if (memorySightings.has(key)) continue;
      memorySightings.set(key, {
        id: crypto.randomUUID(),
        tenantId,
        findingId: d.findingId,
        runId: d.runId,
        sourceId: d.sourceId,
        reportedSeverity: d.reportedSeverity,
        reportedAt: new Date(d.reportedAt).toISOString(),
        detail: d.detail,
      });
    }
    return;
  }
  const c = need(client);
  for (const part of chunks(drafts)) {
    await c.query(
      `INSERT INTO vm_sightings (tenant_id, finding_id, run_id, source_id, reported_severity, reported_at, detail)
       VALUES ${Array.from({ length: part.length }, (_, r) => `($${r * 7 + 1},$${r * 7 + 2},$${r * 7 + 3},$${r * 7 + 4},$${r * 7 + 5},$${r * 7 + 6},$${r * 7 + 7}::jsonb)`).join(',')}
       ON CONFLICT (tenant_id, run_id, finding_id) DO NOTHING`,
      part.flatMap((d) => [tenantId, d.findingId, d.runId, d.sourceId, d.reportedSeverity, d.reportedAt, JSON.stringify(d.detail)]),
    );
  }
}

/** Records which assets a run reported (ids only), so a later run of another source can tell who still lists a finding. Idempotent. */
export async function insertRunAssets(
  tenantId: string,
  run: { id: string; sourceId: string; receivedAt: string },
  assetIds: string[],
  client: pg.PoolClient | null,
): Promise<void> {
  if (assetIds.length === 0) return;
  if (isMemory()) {
    for (const assetId of assetIds) {
      const key = `${tenantId}|${run.id}|${assetId}`;
      if (!memoryRunAssets.has(key)) memoryRunAssets.set(key, { tenantId, runId: run.id, assetId, sourceId: run.sourceId, receivedAt: run.receivedAt });
    }
    return;
  }
  await need(client).query(
    'INSERT INTO vm_run_assets (tenant_id, run_id, asset_id) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING',
    [tenantId, run.id, [...new Set(assetIds)]],
  );
}

// ------------------------------------------------------------------------------------------------ POA&M

/** OPEN findings past their SLA (strictly before `now`), with the asset name and KEV flag, plus the POA&M items already linked to them. */
export async function listPoamCandidates(
  tenantId: string,
  now: string,
  client: pg.PoolClient | null,
  programId?: string | null,
): Promise<{ candidates: PoamCandidate[]; linked: LinkedPoamItem[] }> {
  if (isMemory()) {
    const names = new Map((await listAssets(tenantId)).map((a) => [a.id, a.hostName]));
    const candidates = [...memoryFindings.values()]
      .filter((f) => f.tenantId === tenantId && f.status === 'OPEN' && f.slaDueAt !== null && f.slaDueAt < new Date(now).toISOString())
      .map((f) => ({ finding: { ...f }, assetName: names.get(f.assetId) ?? '', kev: Boolean(memoryVulns.get(f.vulnId)?.kev) }));
    const ids = new Set(candidates.map((x) => x.finding.id));
    const linked = [...memoryPoam.values()]
      // PostgreSQL sees only the transaction's program through RLS; the memory store filters the same way
      .filter((p) => p.tenantId === tenantId && (!programId || p.programId === programId) && p.findingId !== null && ids.has(p.findingId))
      .map((p) => ({ findingId: p.findingId as string, status: p.status, createdAt: p.createdAt, findingFirstSeenAt: p.findingFirstSeenAt ?? null }));
    return { candidates, linked };
  }
  const c = need(client);
  const found = await c.query(
    `SELECT f.*, a.asset_name, COALESCE(v.kev, FALSE) AS kev
       FROM vm_findings f
       JOIN enclave_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id
       LEFT JOIN vm_vulns v ON v.vuln_id = f.vuln_id
      WHERE f.tenant_id = $1 AND f.status = 'OPEN' AND f.sla_due_at < $2::timestamptz`,
    [tenantId, now],
  );
  const candidates = found.rows.map((r) => ({ finding: rowToFinding(r), assetName: r.asset_name as string, kev: Boolean(r.kev) }));
  if (candidates.length === 0) return { candidates, linked: [] };
  const links = await c.query(
    'SELECT finding_id, status, created_at, finding_first_seen_at FROM vm_poam_items WHERE tenant_id = $1 AND finding_id = ANY($2::text[])',
    [tenantId, candidates.map((x) => x.finding.id)],
  );
  const linked = links.rows.map((r) => ({ findingId: r.finding_id as string, status: r.status as VmPoamStatus, createdAt: iso(r.created_at) as string, findingFirstSeenAt: iso(r.finding_first_seen_at) }));
  return { candidates, linked };
}

/**
 * Inserts the worker's POA&M items and returns how many rows were really inserted. The partial unique index
 * (unq_vm_poam_items_auto_episode: tenant, program, finding, episode) makes a repeat a no-op. `programId` is the program the items
 * belong to (the VM target program the worker passes); without one the rows carry none.
 */
export async function insertPoamItems(tenantId: string, drafts: PoamDraft[], client: pg.PoolClient | null, programId: string | null = null): Promise<number> {
  if (drafts.length === 0) return 0;
  if (isMemory()) {
    let inserted = 0;
    for (const d of drafts) {
      const exists = [...memoryPoam.values()].some(
        (p) =>
          p.tenantId === tenantId &&
          (p.programId ?? null) === programId &&
          p.findingId === d.findingId &&
          p.createdBy === d.createdBy &&
          p.findingFirstSeenAt === d.findingFirstSeenAt,
      );
      if (exists) continue;
      inserted++;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      memoryPoam.set(id, {
        id,
        tenantId,
        findingId: d.findingId,
        controlId: d.controlId,
        weakness: d.weakness,
        mitigation: d.mitigation,
        owner: d.owner,
        scheduledCompletion: d.scheduledCompletion,
        status: d.status,
        createdBy: d.createdBy,
        createdAt: now,
        updatedAt: now,
        programId,
        findingFirstSeenAt: new Date(d.findingFirstSeenAt).toISOString(),
        updatedBy: null,
        statusChangedBy: null,
        statusChangedAt: null,
        autoComplete: true,
      });
    }
    return inserted;
  }
  const c = need(client);
  let inserted = 0;
  for (const part of chunks(drafts)) {
    const res = await c.query(
      `INSERT INTO vm_poam_items (tenant_id, finding_id, control_id, weakness, mitigation, owner, scheduled_completion, status, created_by, program_id, finding_first_seen_at)
       VALUES ${placeholders(part.length, 11)}
       ON CONFLICT DO NOTHING`,
      part.flatMap((d) => [tenantId, d.findingId, d.controlId, d.weakness, d.mitigation, d.owner, d.scheduledCompletion, d.status, d.createdBy, programId, d.findingFirstSeenAt]),
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export interface PoamViewOptions {
  /** Only OPEN and IN_PROGRESS items. */
  openOnly: boolean;
  limit: number;
  offset: number;
  /** Most upcoming findings returned (0 returns none; the total is still counted). */
  upcomingLimit: number;
  /** True for the VM target program: the upcoming findings and the overdue-without-item count are filled; otherwise they stay empty / 0. */
  includeFindingWindow: boolean;
}

export interface PoamView {
  items: VmPoamRow[];
  itemsTotal: number;
  openItemsTotal: number;
  overdueWithoutItemCount: number;
  upcoming: VmUpcomingFinding[];
  upcomingTotal: number;
}

const isOpenPoam = (status: string): boolean => status === 'OPEN' || status === 'IN_PROGRESS';
const DAY_MS = 86400000;

/** The first VM_POAM_PACKAGES_RETURNED packages of the finding; its single legacy package when the list is empty. */
function packagesReturned(f: Pick<VmFinding, 'affectedPackages' | 'packageName' | 'packageVersion' | 'fixedVersion'>): VmAffectedPackage[] {
  const list = f.affectedPackages.length > 0 ? f.affectedPackages : f.packageName ? [{ name: f.packageName, version: f.packageVersion, fixedVersion: f.fixedVersion }] : [];
  return list.slice(0, VM_POAM_PACKAGES_RETURNED).map((p) => ({ name: p.name, version: p.version, fixedVersion: p.fixedVersion }));
}

const packageCountOf = (f: Pick<VmFinding, 'affectedPackages' | 'packageName' | 'affectedPackageCount'>): number =>
  Math.max(f.affectedPackageCount, f.affectedPackages.length, f.affectedPackages.length === 0 && f.packageName ? 1 : 0);

function poamRowOf(item: VmPoamItem, f: VmFinding | null, assetName: string | null, kev: boolean): VmPoamRow {
  return {
    id: item.id,
    status: item.status,
    controlId: item.controlId,
    weakness: item.weakness,
    scheduledCompletion: item.scheduledCompletion,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    findingFirstSeenAt: item.findingFirstSeenAt ?? null,
    createdBy: item.createdBy,
    owner: item.owner,
    mitigation: item.mitigation,
    updatedBy: item.updatedBy ?? null,
    statusChangedBy: item.statusChangedBy ?? null,
    statusChangedAt: item.statusChangedAt ?? null,
    autoComplete: item.autoComplete ?? true,
    finding: f
      ? {
          id: f.id,
          vulnId: f.vulnId,
          severity: f.severity,
          status: f.status,
          kev,
          firstSeenAt: f.firstSeenAt,
          lastSeenAt: f.lastSeenAt,
          slaDueAt: f.slaDueAt,
          resolvedAt: f.resolvedAt,
          affectedPackages: packagesReturned(f),
          affectedPackageCount: packageCountOf(f),
          asset: assetName === null ? null : { id: f.assetId, name: assetName },
        }
      : null,
  };
}

function upcomingOf(f: VmFinding, assetName: string, kev: boolean, nowMs: number): VmUpcomingFinding {
  return {
    findingId: f.id,
    vulnId: f.vulnId,
    severity: f.severity,
    kev,
    firstSeenAt: f.firstSeenAt,
    slaDueAt: f.slaDueAt as string,
    daysRemaining: Math.floor((Date.parse(f.slaDueAt as string) - nowMs) / DAY_MS),
    assetId: f.assetId,
    assetName,
    affectedPackages: packagesReturned(f),
    affectedPackageCount: packageCountOf(f),
  };
}

/** Same episode rule as the planner (planPoamItems): the recorded episode, or for an item without one, created at or after first_seen_at. */
const itemCoversEpisode = (p: VmPoamItem, f: VmFinding): boolean =>
  p.findingFirstSeenAt ? Date.parse(p.findingFirstSeenAt) === Date.parse(f.firstSeenAt) : Date.parse(p.createdAt) >= Date.parse(f.firstSeenAt);

/**
 * The program's POA&M items with the finding and host each is about (open first, then most severe, earliest deadline), the counts, and
 * for the VM target program the open findings not yet due plus how many overdue ones have no item of their episode. One tenant
 * transaction on PostgreSQL (row security applies the program); the memory store filters by hand the same way. The tenant's other
 * programs' items are never read: every query names the program.
 */
export async function loadVmPoamView(scope: ProgramScope, nowIso: string, opts: PoamViewOptions): Promise<PoamView> {
  const nowMs = Date.parse(nowIso);
  if (isMemory()) {
    const names = new Map((await listAssets(scope.tenantId)).map((a) => [a.id, a.hostName]));
    const mine = [...memoryPoam.values()].filter((p) => p.tenantId === scope.tenantId && p.programId === scope.programId);
    const sev = (f: VmFinding | undefined): number => (f ? SEVERITY_ORDER[f.severity] : 5);
    const sorted = mine
      .filter((p) => !opts.openOnly || isOpenPoam(p.status))
      .map((p) => ({ p, f: p.findingId ? memoryFindings.get(p.findingId) : undefined }))
      .sort((a, b) => {
        const oa = isOpenPoam(a.p.status) ? 0 : 1;
        const ob = isOpenPoam(b.p.status) ? 0 : 1;
        if (oa !== ob) return oa - ob;
        if (sev(a.f) !== sev(b.f)) return sev(a.f) - sev(b.f);
        const da = a.f?.slaDueAt ?? null;
        const db = b.f?.slaDueAt ?? null;
        if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
        if (a.p.createdAt !== b.p.createdAt) return a.p.createdAt < b.p.createdAt ? -1 : 1;
        return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0;
      });
    const items = sorted.slice(opts.offset, opts.offset + opts.limit).map(({ p, f }) =>
      poamRowOf(p, f ? { ...f } : null, f ? (names.get(f.assetId) ?? null) : null, f ? Boolean(memoryVulns.get(f.vulnId)?.kev) : false),
    );
    let overdueWithoutItemCount = 0;
    let upcomingAll: VmFinding[] = [];
    if (opts.includeFindingWindow) {
      const open = [...memoryFindings.values()].filter((f) => f.tenantId === scope.tenantId && f.status === 'OPEN' && f.slaDueAt !== null);
      overdueWithoutItemCount = await countOverdueWithoutItem(scope, nowIso);
      upcomingAll = open
        .filter((f) => Date.parse(f.slaDueAt as string) >= nowMs)
        .sort((a, b) => (a.slaDueAt as string) < (b.slaDueAt as string) ? -1 : (a.slaDueAt as string) > (b.slaDueAt as string) ? 1 : SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return {
      items,
      itemsTotal: mine.length,
      openItemsTotal: mine.filter((p) => isOpenPoam(p.status)).length,
      overdueWithoutItemCount,
      upcoming: upcomingAll.slice(0, opts.upcomingLimit).map((f) => upcomingOf({ ...f }, names.get(f.assetId) ?? '', Boolean(memoryVulns.get(f.vulnId)?.kev), nowMs)),
      upcomingTotal: upcomingAll.length,
    };
  }
  return withVmTenantTx(scope.tenantId, async (client) => {
    const c = need(client);
    const sevOrder = "CASE f.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'UNKNOWN' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END";
    const itemRows = await c.query(
      `${POAM_ROW_SELECT}
        WHERE p.tenant_id = $1 AND p.program_id = $2${opts.openOnly ? " AND p.status IN ('OPEN', 'IN_PROGRESS')" : ''}
        ORDER BY CASE WHEN p.status IN ('OPEN', 'IN_PROGRESS') THEN 0 ELSE 1 END, ${sevOrder}, f.sla_due_at NULLS LAST, p.created_at, p.id
        LIMIT $3 OFFSET $4`,
      [scope.tenantId, scope.programId, opts.limit, opts.offset],
    );
    const items = itemRows.rows.map(poamRowFromJoined);
    const counts = await c.query(
      `SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS')))::int AS open
         FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2`,
      [scope.tenantId, scope.programId],
    );
    let overdueWithoutItemCount = 0;
    let upcoming: VmUpcomingFinding[] = [];
    let upcomingTotal = 0;
    if (opts.includeFindingWindow) {
      overdueWithoutItemCount = await countOverdueWithoutItem(scope, nowIso, c);
      const total = await c.query("SELECT COUNT(*)::int AS n FROM vm_findings f WHERE f.tenant_id = $1 AND f.status = 'OPEN' AND f.sla_due_at >= $2::timestamptz", [scope.tenantId, nowIso]);
      upcomingTotal = Number(total.rows[0]?.n ?? 0);
      if (opts.upcomingLimit > 0) {
        const rows = await c.query(
          `SELECT f.*, a.asset_name, COALESCE(v.kev, FALSE) AS kev
             FROM vm_findings f
             LEFT JOIN enclave_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id
             LEFT JOIN vm_vulns v ON v.vuln_id = f.vuln_id
            WHERE f.tenant_id = $1 AND f.status = 'OPEN' AND f.sla_due_at >= $2::timestamptz
            ORDER BY f.sla_due_at, ${sevOrder}, f.id
            LIMIT $3`,
          [scope.tenantId, nowIso, opts.upcomingLimit],
        );
        upcoming = rows.rows.map((r) => upcomingOf(rowToFinding(r), (r.asset_name as string | null) ?? '', Boolean(r.kev), nowMs));
      }
    }
    return {
      items,
      itemsTotal: Number(counts.rows[0]?.total ?? 0),
      openItemsTotal: Number(counts.rows[0]?.open ?? 0),
      overdueWithoutItemCount,
      upcoming,
      upcomingTotal,
    };
  }, scope.programId);
}

/**
 * How many OPEN findings are past their SLA deadline and have no POA&M item of their current episode in the program (any item
 * status counts as covering it). The same figure loadVmPoamView returns for the target program. Pass the transaction's client to read
 * inside it; without one a tenant transaction in the program's context is opened (PostgreSQL).
 */
export async function countOverdueWithoutItem(scope: ProgramScope, nowIso: string, client?: pg.PoolClient | null): Promise<number> {
  if (isMemory()) {
    const nowMs = Date.parse(nowIso);
    const mine = [...memoryPoam.values()].filter((p) => p.tenantId === scope.tenantId && p.programId === scope.programId);
    return [...memoryFindings.values()].filter(
      (f) =>
        f.tenantId === scope.tenantId && f.status === 'OPEN' && f.slaDueAt !== null && Date.parse(f.slaDueAt) < nowMs &&
        !mine.some((p) => p.findingId === f.id && itemCoversEpisode(p, f)),
    ).length;
  }
  const count = async (c: pg.PoolClient): Promise<number> => {
    const overdue = await c.query(
      `SELECT COUNT(*)::int AS n FROM vm_findings f
        WHERE f.tenant_id = $1 AND f.status = 'OPEN' AND f.sla_due_at < $2::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM vm_poam_items p
             WHERE p.tenant_id = f.tenant_id AND p.finding_id = f.id AND p.program_id = $3
               AND (p.finding_first_seen_at = f.first_seen_at OR (p.finding_first_seen_at IS NULL AND p.created_at >= f.first_seen_at)))`,
      [scope.tenantId, nowIso, scope.programId],
    );
    return Number(overdue.rows[0]?.n ?? 0);
  };
  if (client) return count(client);
  return withVmTenantTx(scope.tenantId, (c) => count(need(c)), scope.programId);
}

/**
 * Completes the worker's POA&M items of one program that a later scan confirmed fixed (#295; the rule is planPoamCompletions): every
 * eligible item of the program, so a backlog from before the upgrade completes too. Reprocessing a run completes nothing twice (a
 * completed item is no longer a candidate). Returns how many items were completed. Statuses, ids and dates only reach the events.
 */
async function completeInProgram(tenantId: string, runId: string, nowIso: string, client: pg.PoolClient | null, programId: string): Promise<number> {
  if (isMemory()) {
    const items = [...memoryPoam.values()].filter((p) => p.tenantId === tenantId && p.programId === programId && p.createdBy === VM_WORKER_ACTOR && isOpenPoam(p.status) && (p.autoComplete ?? true));
    const ids = planPoamCompletions(
      items.map((p) => {
        const f = p.findingId ? memoryFindings.get(p.findingId) : undefined;
        return {
          id: p.id,
          status: p.status,
          createdBy: p.createdBy,
          createdAt: p.createdAt,
          findingFirstSeenAt: p.findingFirstSeenAt ?? null,
          autoComplete: p.autoComplete ?? true,
          scheduledCompletion: p.scheduledCompletion,
          finding: f && f.tenantId === tenantId ? { status: f.status, firstSeenAt: f.firstSeenAt } : null,
        };
      }),
    );
    for (const id of ids) {
      const p = memoryPoam.get(id) as VmPoamItem;
      memoryPoam.set(id, { ...p, status: 'COMPLETED', statusChangedBy: VM_WORKER_ACTOR, statusChangedAt: nowIso, updatedBy: VM_WORKER_ACTOR, updatedAt: nextStamp(p.updatedAt) });
      memoryPoamEvents.push({
        id: crypto.randomUUID(),
        tenantId,
        programId,
        itemId: id,
        source: 'system',
        actor: VM_WORKER_ACTOR,
        oldStatus: p.status,
        newStatus: 'COMPLETED',
        oldScheduledCompletion: p.scheduledCompletion,
        newScheduledCompletion: p.scheduledCompletion,
        ownerChanged: false,
        mitigationChanged: false,
        runId,
        createdAt: new Date().toISOString(),
      });
    }
    return ids.length;
  }
  const c = need(client);
  const found = await c.query(
    `SELECT p.id, p.status, p.created_by, p.created_at, p.finding_first_seen_at, p.auto_complete, p.scheduled_completion,
            f.status AS f_status, f.first_seen_at AS f_first_seen_at
       FROM vm_poam_items p
       LEFT JOIN vm_findings f ON f.tenant_id = p.tenant_id AND f.id = p.finding_id
      WHERE p.tenant_id = $1 AND p.program_id = $2 AND p.created_by = $3 AND p.status IN ('OPEN', 'IN_PROGRESS') AND p.auto_complete
        FOR UPDATE OF p`,
    [tenantId, programId, VM_WORKER_ACTOR],
  );
  const items: OpenAutoPoamItem[] = found.rows.map((r) => ({
    id: r.id as string,
    status: r.status as VmPoamStatus,
    createdBy: r.created_by as string,
    createdAt: iso(r.created_at) as string,
    findingFirstSeenAt: iso(r.finding_first_seen_at),
    autoComplete: Boolean(r.auto_complete),
    scheduledCompletion: null, // not read by the planner; the event copies the column in SQL
    finding: r.f_status ? { status: r.f_status as VmFindingStatus, firstSeenAt: iso(r.f_first_seen_at) as string } : null,
  }));
  const ids = planPoamCompletions(items);
  if (ids.length === 0) return 0;
  const oldStatus = new Map(items.map((i) => [i.id, i.status]));
  for (const part of chunks(ids)) {
    await c.query(
      `UPDATE vm_poam_items
          SET status = 'COMPLETED', status_changed_by = $3::text, status_changed_at = $4::timestamptz, updated_by = $3::text,
              updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
        WHERE tenant_id = $1::text AND program_id = $5::text AND id = ANY($2::text[])`,
      [tenantId, part, VM_WORKER_ACTOR, nowIso, programId],
    );
    await c.query(
      `INSERT INTO vm_poam_item_events (tenant_id, program_id, item_id, source, actor, run_id, old_status, new_status, old_scheduled_completion, new_scheduled_completion)
       SELECT $1::text, $2::text, p.id, 'system', $3::text, $4::text, u.old_status, 'COMPLETED', p.scheduled_completion, p.scheduled_completion
         FROM unnest($5::text[], $6::text[]) AS u(id, old_status)
         JOIN vm_poam_items p ON p.tenant_id = $1::text AND p.program_id = $2::text AND p.id = u.id`,
      [tenantId, programId, VM_WORKER_ACTOR, runId, part, part.map((id) => oldStatus.get(id) as string)],
    );
  }
  return ids.length;
}

/** Completes the target program's worker items a later scan confirmed fixed (#295). `client` is the run's transaction, in `programId`'s context. */
export async function completeResolvedPoamItems(tenantId: string, runId: string, nowIso: string, client: pg.PoolClient | null, programId: string): Promise<number> {
  return completeInProgram(tenantId, runId, nowIso, client, programId);
}

/**
 * The same for the tenant's other programs that are not archived (items left behind in a program that was the VM target earlier). On PostgreSQL
 * the transaction's program setting is switched to each program in turn and restored to `targetProgramId` before returning, so a later write
 * of the run (always in the target) is under the right policy. An archived program's items are frozen and never touched.
 */
export async function completeResolvedPoamItemsInOtherPrograms(
  tenantId: string,
  runId: string,
  nowIso: string,
  client: pg.PoolClient | null,
  targetProgramId: string,
): Promise<number> {
  let completed = 0;
  if (isMemory()) {
    // Dynamic import: server/programs.ts imports this module (counts), so a static import would be a cycle.
    const { getProgram } = await import('../programs');
    const ids = [...new Set([...memoryPoam.values()].filter((p) => p.tenantId === tenantId && p.programId && p.programId !== targetProgramId).map((p) => p.programId as string))];
    for (const id of ids) {
      const program = await getProgram(tenantId, id);
      if (!program || program.archivedAt) continue;
      completed += await completeInProgram(tenantId, runId, nowIso, null, id);
    }
    return completed;
  }
  const c = need(client);
  const others = await c.query('SELECT id FROM programs WHERE tenant_id = $1 AND archived_at IS NULL AND id <> $2 ORDER BY id', [tenantId, targetProgramId]);
  if (others.rows.length === 0) return 0;
  for (const row of others.rows) {
    await c.query('SELECT set_config($1, $2, true)', ['app.current_program_id', row.id as string]);
    completed += await completeInProgram(tenantId, runId, nowIso, c, row.id as string);
  }
  await c.query('SELECT set_config($1, $2, true)', ['app.current_program_id', targetProgramId]);
  return completed;
}

/** The SELECT of one POA&M row with its finding, host and KEV flag (the caller adds WHERE, ORDER and LIMIT): see poamRowFromJoined. */
const POAM_ROW_SELECT = `SELECT p.*, f.vuln_id, f.severity AS f_severity, f.status AS f_status, f.first_seen_at AS f_first_seen_at, f.last_seen_at AS f_last_seen_at,
              f.sla_due_at AS f_sla_due_at, f.resolved_at AS f_resolved_at, f.affected_packages, f.affected_package_count, f.package_name,
              f.package_version, f.fixed_version, f.asset_id, a.asset_name, COALESCE(v.kev, FALSE) AS kev, (f.id IS NOT NULL) AS has_finding
         FROM vm_poam_items p
         LEFT JOIN vm_findings f ON f.tenant_id = p.tenant_id AND f.id = p.finding_id
         LEFT JOIN enclave_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id
         LEFT JOIN vm_vulns v ON v.vuln_id = f.vuln_id`;

function poamRowFromJoined(r: pg.QueryResultRow): VmPoamRow {
  const finding: VmFinding | null = r.has_finding
    ? rowToFinding({
        id: r.finding_id, tenant_id: r.tenant_id, asset_id: r.asset_id, vuln_id: r.vuln_id, status: r.f_status, severity: r.f_severity,
        first_seen_at: r.f_first_seen_at, last_seen_at: r.f_last_seen_at, resolved_at: r.f_resolved_at, sla_due_at: r.f_sla_due_at,
        package_name: r.package_name, package_version: r.package_version, fixed_version: r.fixed_version,
        affected_packages: r.affected_packages, affected_package_count: r.affected_package_count,
      })
    : null;
  return poamRowOf(rowToPoamItem(r), finding, finding && r.asset_name ? (r.asset_name as string) : null, Boolean(r.kev));
}

/** The item of the program as a row of GET /vm/poam, or null when the id is unknown or belongs to another tenant or program. */
export async function getVmPoamRow(scope: ProgramScope, itemId: string): Promise<VmPoamRow | null> {
  if (isMemory()) {
    const p = memoryPoam.get(itemId);
    if (!p || p.tenantId !== scope.tenantId || p.programId !== scope.programId) return null;
    return memoryRowOf(p, (await listAssets(scope.tenantId)).map((a) => [a.id, a.hostName] as const));
  }
  return withVmTenantTx(
    scope.tenantId,
    async (client) => {
      const res = await need(client).query(`${POAM_ROW_SELECT} WHERE p.tenant_id = $1 AND p.program_id = $2 AND p.id = $3`, [scope.tenantId, scope.programId, itemId]);
      return res.rows[0] ? poamRowFromJoined(res.rows[0]) : null;
    },
    scope.programId,
  );
}

function memoryRowOf(p: VmPoamItem, assets: ReadonlyArray<readonly [string, string]>): VmPoamRow {
  const f = p.findingId ? memoryFindings.get(p.findingId) : undefined;
  const name = f ? (assets.find(([id]) => id === f.assetId)?.[1] ?? null) : null;
  return poamRowOf(p, f ? { ...f } : null, name, f ? Boolean(memoryVulns.get(f.vulnId)?.kev) : false);
}

/** Why an edit was refused by the status rules (planVmPoamStatus). Carries a code only, never any text of the item. */
export class VmPoamEditError extends Error {
  constructor(readonly code: 'finding_still_open' | 'mitigation_required') {
    super(code);
    this.name = 'VmPoamEditError';
  }
}

export interface VmPoamEditor {
  /** Display name stored as updated_by and on the event. */
  actor: string;
  /** The signed-in user's id (stored only on the event row in PostgreSQL). */
  userId: string | null;
}

/** What an edit changes, from the stored item and the patch. Throws VmPoamEditError when the status rules refuse it. */
function planEdit(p: VmPoamItem, findingOpenInEpisode: boolean, patch: VmPoamItemPatch) {
  const owner = patch.owner ?? p.owner;
  const mitigation = patch.mitigation ?? p.mitigation;
  const scheduledCompletion = patch.scheduledCompletion === undefined ? p.scheduledCompletion : patch.scheduledCompletion;
  const status = patch.status ?? p.status;
  const ownerChanged = owner !== p.owner;
  const mitigationChanged = mitigation !== p.mitigation;
  const dateChanged = scheduledCompletion !== p.scheduledCompletion;
  const statusChanged = status !== p.status;
  const changed = ownerChanged || mitigationChanged || dateChanged || statusChanged;
  let reopen = false;
  if (changed) {
    const plan = planVmPoamStatus({ status: p.status, findingOpenInEpisode }, status, mitigation);
    if (!plan.ok) throw new VmPoamEditError(plan.code);
    reopen = plan.reopen;
  }
  return { owner, mitigation, scheduledCompletion, status, ownerChanged, mitigationChanged, dateChanged, statusChanged, changed, reopen };
}

const ACTOR_MAX = 255;
const USER_ID_MAX = 128;

/**
 * Edits one item of the program (#297): owner, mitigation, scheduled completion, status. `expectedUpdatedAt` must be the stored stamp
 * (else StaleWriteError). Null when the id is unknown or belongs to another tenant or program. A change that alters nothing writes
 * nothing (`changed: false`, no event, the stamp stays). A real change bumps updated_at, records who changed it and one event with the
 * statuses, dates, changed flags and the SHA-256 and length of the new owner / mitigation, never their text. Throws VmPoamEditError.
 */
export async function updateVmPoamItem(
  scope: ProgramScope,
  itemId: string,
  patch: VmPoamItemPatch,
  expectedUpdatedAt: string,
  who: VmPoamEditor,
): Promise<{ item: VmPoamRow; changed: boolean } | null> {
  const actor = who.actor.slice(0, ACTOR_MAX);
  if (isMemory()) {
    const p = memoryPoam.get(itemId);
    if (!p || p.tenantId !== scope.tenantId || p.programId !== scope.programId) return null;
    if (!matchesExpected(p.updatedAt, expectedUpdatedAt)) throw new StaleWriteError({ updatedAt: p.updatedAt, updatedBy: p.updatedBy ?? null });
    const f = p.findingId ? memoryFindings.get(p.findingId) : undefined;
    const plan = planEdit(p, vmPoamFindingOpenInEpisode(p, f && f.tenantId === scope.tenantId ? f : null), patch);
    const assets = (await listAssets(scope.tenantId)).map((a) => [a.id, a.hostName] as const);
    if (!plan.changed) return { item: memoryRowOf(p, assets), changed: false };
    const now = new Date().toISOString();
    const next: VmPoamItem = {
      ...p,
      owner: plan.owner,
      mitigation: plan.mitigation,
      scheduledCompletion: plan.scheduledCompletion,
      status: plan.status,
      updatedBy: actor,
      updatedAt: nextStamp(p.updatedAt),
      ...(plan.statusChanged ? { statusChangedBy: actor, statusChangedAt: now } : {}),
      ...(plan.reopen ? { autoComplete: false } : {}),
    };
    memoryPoam.set(itemId, next);
    memoryPoamEvents.push({
      id: crypto.randomUUID(),
      tenantId: scope.tenantId,
      programId: scope.programId,
      itemId,
      source: 'human',
      actor,
      oldStatus: p.status,
      newStatus: plan.status,
      oldScheduledCompletion: p.scheduledCompletion,
      newScheduledCompletion: plan.scheduledCompletion,
      ownerChanged: plan.ownerChanged,
      mitigationChanged: plan.mitigationChanged,
      runId: null,
      createdAt: now,
    });
    return { item: memoryRowOf(next, assets), changed: true };
  }
  const updated = await withVmTenantTx(
    scope.tenantId,
    async (client) => {
      const c = need(client);
      const found = await c.query(
        `SELECT p.*, f.status AS f_status, f.first_seen_at AS f_first_seen_at
           FROM vm_poam_items p
           LEFT JOIN vm_findings f ON f.tenant_id = p.tenant_id AND f.id = p.finding_id
          WHERE p.tenant_id = $1::text AND p.program_id = $2::text AND p.id = $3::text
            FOR UPDATE OF p`,
        [scope.tenantId, scope.programId, itemId],
      );
      const r = found.rows[0];
      if (!r) return null;
      const p = rowToPoamItem(r);
      if (!matchesExpected(p.updatedAt, expectedUpdatedAt)) throw new StaleWriteError({ updatedAt: p.updatedAt, updatedBy: p.updatedBy ?? null });
      const open = vmPoamFindingOpenInEpisode(p, r.f_status ? { status: r.f_status as VmFindingStatus, firstSeenAt: iso(r.f_first_seen_at) as string } : null);
      const plan = planEdit(p, open, patch);
      if (!plan.changed) return { changed: false };
      await c.query(
        `UPDATE vm_poam_items
            SET owner = $4::text, mitigation = $5::text, scheduled_completion = $6::date, status = $7::text, updated_by = $8::text,
                updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond'),
                status_changed_by = CASE WHEN $9::boolean THEN $8::text ELSE status_changed_by END,
                status_changed_at = CASE WHEN $9::boolean THEN NOW() ELSE status_changed_at END,
                auto_complete = CASE WHEN $10::boolean THEN FALSE ELSE auto_complete END
          WHERE tenant_id = $1::text AND program_id = $2::text AND id = $3::text`,
        [scope.tenantId, scope.programId, itemId, plan.owner, plan.mitigation, plan.scheduledCompletion, plan.status, actor, plan.statusChanged, plan.reopen],
      );
      const ownerDigest = plan.ownerChanged ? notesDigest(plan.owner) : null;
      const mitigationDigest = plan.mitigationChanged ? notesDigest(plan.mitigation) : null;
      await c.query(
        `INSERT INTO vm_poam_item_events (tenant_id, program_id, item_id, source, actor, actor_user_id, old_status, new_status,
                                          old_scheduled_completion, new_scheduled_completion, owner_changed, new_owner_sha256, new_owner_length,
                                          mitigation_changed, new_mitigation_sha256, new_mitigation_length)
         VALUES ($1::text, $2::text, $3::text, 'human', $4::text, $5::text, $6::text, $7::text, $8::date, $9::date, $10::boolean, $11::text, $12::integer,
                 $13::boolean, $14::text, $15::integer)`,
        [
          scope.tenantId, scope.programId, itemId, actor, who.userId ? who.userId.slice(0, USER_ID_MAX) : null, p.status, plan.status,
          p.scheduledCompletion, plan.scheduledCompletion, plan.ownerChanged, ownerDigest?.sha256 ?? null, ownerDigest?.length ?? null,
          plan.mitigationChanged, mitigationDigest?.sha256 ?? null, mitigationDigest?.length ?? null,
        ],
      );
      return { changed: true };
    },
    scope.programId,
  );
  if (!updated) return null;
  const item = await getVmPoamRow(scope, itemId);
  return item ? { item, changed: updated.changed } : null;
}

/** The item's history, newest first (at most `limit`). Statuses, dates and changed flags only: never the owner or mitigation text. */
export async function listVmPoamItemEvents(scope: ProgramScope, itemId: string, limit: number): Promise<VmPoamItemEvent[]> {
  if (isMemory()) {
    return memoryPoamEvents
      .filter((e) => e.tenantId === scope.tenantId && e.programId === scope.programId && e.itemId === itemId)
      .reverse()
      .slice(0, limit)
      .map(({ tenantId: _t, programId: _p, ...event }) => ({ ...event }));
  }
  return withVmTenantTx(
    scope.tenantId,
    async (client) => {
      const res = await need(client).query(
        `SELECT id, item_id, source, actor, old_status, new_status, old_scheduled_completion, new_scheduled_completion, owner_changed,
                mitigation_changed, run_id, created_at
           FROM vm_poam_item_events
          WHERE tenant_id = $1::text AND program_id = $2::text AND item_id = $3::text
          ORDER BY created_at DESC, id DESC
          LIMIT $4::integer`,
        [scope.tenantId, scope.programId, itemId, limit],
      );
      return res.rows.map((r): VmPoamItemEvent => ({
        id: r.id,
        itemId: r.item_id,
        source: r.source as 'human' | 'system',
        actor: r.actor,
        oldStatus: (r.old_status ?? null) as VmPoamStatus | null,
        newStatus: r.new_status as VmPoamStatus,
        oldScheduledCompletion: dateOnly(r.old_scheduled_completion),
        newScheduledCompletion: dateOnly(r.new_scheduled_completion),
        ownerChanged: Boolean(r.owner_changed),
        mitigationChanged: Boolean(r.mitigation_changed),
        runId: r.run_id ?? null,
        createdAt: iso(r.created_at) as string,
      }));
    },
    scope.programId,
  );
}

/** A DATE column as YYYY-MM-DD (the driver returns a Date at local midnight). */
const dateOnly = (v: unknown): string | null =>
  v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : ((v as string | null | undefined) ?? null);

/** The program's POA&M items still open (OPEN or IN_PROGRESS). A legacy item with no program is not counted until it is backfilled. */
export async function countOpenPoamItems(scope: ProgramScope): Promise<number> {
  return countPoam(scope, true);
}

/** Every POA&M item of the program, whatever its status (what keeps a program from being deleted). */
export async function countPoamItems(scope: ProgramScope): Promise<number> {
  return countPoam(scope, false);
}

async function countPoam(scope: ProgramScope, openOnly: boolean): Promise<number> {
  const open = (status: string): boolean => status === 'OPEN' || status === 'IN_PROGRESS';
  if (isMemory()) {
    return [...memoryPoam.values()].filter((p) => p.tenantId === scope.tenantId && p.programId === scope.programId && (!openOnly || open(p.status))).length;
  }
  const res = await queryWithProgram(
    scope,
    `SELECT COUNT(*)::int AS n FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2${openOnly ? " AND status IN ('OPEN', 'IN_PROGRESS')" : ''}`,
    [scope.tenantId, scope.programId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

// ------------------------------------------------------------------------------------------------ runs and listing

/** Marks the run NORMALIZED inside the run's own transaction, so the status never gets ahead of the data it describes. */
export async function markRunNormalized(
  tenantId: string,
  run: Pick<VmRun, 'id' | 'sourceId' | 'receivedAt'>,
  finishedAt: string,
  warning: string | null,
  client: pg.PoolClient | null,
): Promise<void> {
  if (isMemory()) {
    await updateRun(tenantId, run.id, { status: 'NORMALIZED', finishedAt, warning, error: null });
    await noteSourceNormalized(tenantId, run.sourceId, run.receivedAt, null);
    return;
  }
  await need(client).query("UPDATE vm_runs SET status = 'NORMALIZED', finished_at = $3, warning = $4, error = NULL WHERE id = $1 AND tenant_id = $2", [run.id, tenantId, finishedAt, warning]);
  await noteSourceNormalized(tenantId, run.sourceId, run.receivedAt, client);
}

/**
 * Everything the snapshot evaluates, in one tenant transaction: every finding (any status), the ids of the vulnerabilities
 * on the known-exploited list that the tenant has findings for, and the POA&M items of `programId` (the VM target program: the
 * tenant's default program unless one is set, which the caller resolves).
 */
export async function loadSnapshotFindings(tenantId: string, programId: string): Promise<{ findings: VmFinding[]; kevVulnIds: string[]; poam: VmPoamItem[] }> {
  if (isMemory()) {
    const findings = [...memoryFindings.values()].filter((f) => f.tenantId === tenantId).map((f) => ({ ...f }));
    const kevVulnIds = [...new Set(findings.map((f) => f.vulnId))].filter((id) => memoryVulns.get(id)?.kev);
    const poam = [...memoryPoam.values()].filter((p) => p.tenantId === tenantId && p.programId === programId).map((p) => ({ ...p }));
    return { findings, kevVulnIds, poam };
  }
  return withVmTenantTx(tenantId, async (client) => {
    const c = need(client);
    const found = await c.query('SELECT * FROM vm_findings WHERE tenant_id = $1', [tenantId]);
    const kev = await c.query('SELECT DISTINCT f.vuln_id FROM vm_findings f JOIN vm_vulns v ON v.vuln_id = f.vuln_id WHERE f.tenant_id = $1 AND v.kev', [tenantId]);
    const poam = await c.query('SELECT * FROM vm_poam_items WHERE tenant_id = $1', [tenantId]);
    return {
      findings: found.rows.map(rowToFinding),
      kevVulnIds: kev.rows.map((r) => r.vuln_id as string),
      poam: poam.rows.map(rowToPoamItem),
    };
  }, programId);
}

const SEVERITY_ORDER: Record<VmSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, UNKNOWN: 3, LOW: 4 };

export interface FindingFilter {
  assetId?: string;
  severity?: VmSeverity;
  status?: VmFindingStatus;
  limit: number;
}

/** Most severe first (CRITICAL, HIGH, MEDIUM, UNKNOWN, LOW), then earliest SLA deadline first with no deadline last. */
export async function listFindings(tenantId: string, f: FindingFilter): Promise<VmFinding[]> {
  if (isMemory()) {
    return [...memoryFindings.values()]
      .filter((x) => x.tenantId === tenantId && (!f.assetId || x.assetId === f.assetId) && (!f.severity || x.severity === f.severity) && (!f.status || x.status === f.status))
      .sort((a, b) => {
        if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (a.slaDueAt !== b.slaDueAt) {
          if (a.slaDueAt === null) return 1;
          if (b.slaDueAt === null) return -1;
          return a.slaDueAt < b.slaDueAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, f.limit)
      .map((x) => ({ ...x }));
  }
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (f.assetId) { params.push(f.assetId); where.push(`asset_id = $${params.length}`); }
  if (f.severity) { params.push(f.severity); where.push(`severity = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  params.push(f.limit);
  return withVmTenantTx(tenantId, async (client) => {
    const { rows } = await need(client).query(
      `SELECT * FROM vm_findings WHERE ${where.join(' AND ')}
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'UNKNOWN' THEN 3 ELSE 4 END,
                sla_due_at NULLS LAST, id
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToFinding);
  });
}
