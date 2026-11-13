import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool, queryWithProgram, type ProgramScope } from '../db';
import { listAssets } from '../assets';
import { listSources, noteSourceNormalized, updateRun } from './store';
import type { ApplyRunResult, LinkedPoamItem, PoamCandidate, PoamDraft, SightingDraft } from './storeTypes';
import type { OtherSourceReport } from './transitions';
import { VM_POAM_PACKAGES_RETURNED } from '../../src/types/vm';
import type { VmAffectedPackage, VmFinding, VmFindingStatus, VmPoamItem, VmPoamRow, VmPoamStatus, VmRun, VmSeverity, VmSighting, VmUpcomingFinding, VmVuln, VmVulnSource } from '../../src/types/vm';

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

/** Test hook. */
export function __resetVmFindingsForTests(): void {
  memoryFindings.clear();
  memorySightings.clear();
  memoryRunAssets.clear();
  memoryPoam.clear();
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
      overdueWithoutItemCount = open.filter((f) => Date.parse(f.slaDueAt as string) < nowMs && !mine.some((p) => p.findingId === f.id && itemCoversEpisode(p, f))).length;
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
      `SELECT p.*, f.vuln_id, f.severity AS f_severity, f.status AS f_status, f.first_seen_at AS f_first_seen_at, f.last_seen_at AS f_last_seen_at,
              f.sla_due_at AS f_sla_due_at, f.resolved_at AS f_resolved_at, f.affected_packages, f.affected_package_count, f.package_name,
              f.package_version, f.fixed_version, f.asset_id, a.asset_name, COALESCE(v.kev, FALSE) AS kev, (f.id IS NOT NULL) AS has_finding
         FROM vm_poam_items p
         LEFT JOIN vm_findings f ON f.tenant_id = p.tenant_id AND f.id = p.finding_id
         LEFT JOIN enclave_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id
         LEFT JOIN vm_vulns v ON v.vuln_id = f.vuln_id
        WHERE p.tenant_id = $1 AND p.program_id = $2${opts.openOnly ? " AND p.status IN ('OPEN', 'IN_PROGRESS')" : ''}
        ORDER BY CASE WHEN p.status IN ('OPEN', 'IN_PROGRESS') THEN 0 ELSE 1 END, ${sevOrder}, f.sla_due_at NULLS LAST, p.created_at, p.id
        LIMIT $3 OFFSET $4`,
      [scope.tenantId, scope.programId, opts.limit, opts.offset],
    );
    const items = itemRows.rows.map((r) => {
      const finding: VmFinding | null = r.has_finding
        ? rowToFinding({
            id: r.finding_id, tenant_id: r.tenant_id, asset_id: r.asset_id, vuln_id: r.vuln_id, status: r.f_status, severity: r.f_severity,
            first_seen_at: r.f_first_seen_at, last_seen_at: r.f_last_seen_at, resolved_at: r.f_resolved_at, sla_due_at: r.f_sla_due_at,
            package_name: r.package_name, package_version: r.package_version, fixed_version: r.fixed_version,
            affected_packages: r.affected_packages, affected_package_count: r.affected_package_count,
          })
        : null;
      return poamRowOf(rowToPoamItem(r), finding, finding && r.asset_name ? (r.asset_name as string) : null, Boolean(r.kev));
    });
    const counts = await c.query(
      `SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS')))::int AS open
         FROM vm_poam_items WHERE tenant_id = $1 AND program_id = $2`,
      [scope.tenantId, scope.programId],
    );
    let overdueWithoutItemCount = 0;
    let upcoming: VmUpcomingFinding[] = [];
    let upcomingTotal = 0;
    if (opts.includeFindingWindow) {
      const overdue = await c.query(
        `SELECT COUNT(*)::int AS n FROM vm_findings f
          WHERE f.tenant_id = $1 AND f.status = 'OPEN' AND f.sla_due_at < $2::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM vm_poam_items p
               WHERE p.tenant_id = f.tenant_id AND p.finding_id = f.id AND p.program_id = $3
                 AND (p.finding_first_seen_at = f.first_seen_at OR (p.finding_first_seen_at IS NULL AND p.created_at >= f.first_seen_at)))`,
        [scope.tenantId, nowIso, scope.programId],
      );
      overdueWithoutItemCount = Number(overdue.rows[0]?.n ?? 0);
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
