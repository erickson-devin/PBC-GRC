import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from '../db';
import { listAssets } from '../assets';
import { updateRun } from './store';
import type { ApplyRunResult, LinkedPoamItem, PoamCandidate, PoamDraft, SightingDraft } from './storeTypes';
import type { VmFinding, VmFindingStatus, VmPoamItem, VmPoamStatus, VmSeverity, VmSighting, VmVuln, VmVulnSource } from '../../src/types/vm';

/**
 * Persistence of findings, sightings, vulnerability reference rows and POA&M items for the VM worker: PostgreSQL (one tenant
 * transaction per run, opened by withVmTenantTx) or process memory when DB_MODE=memory. The memory branch enforces the same
 * uniqueness as the schema (sighting per run and finding; one auto-created POA&M item per finding) so reprocessing behaves
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
const memoryPoam = new Map<string, VmPoamItem>(); // key: id
const memoryVulns = new Map<string, VmVuln>(); // key: vuln_id

/** Test hook. */
export function __resetVmFindingsForTests(): void {
  memoryFindings.clear();
  memorySightings.clear();
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
 * it, so a failure part-way commits nothing.
 */
export async function withVmTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient | null) => Promise<T>): Promise<T> {
  if (isMemory()) return fn(null);
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
  'sla_due_at', 'package_name', 'package_version', 'fixed_version', 'justification', 'decided_by', 'decided_by_user_id', 'decided_at',
];

const findingValues = (f: VmFinding): unknown[] => [
  f.id, f.tenantId, f.assetId, f.vulnId, f.status, f.severity, f.firstSeenAt, f.lastSeenAt, f.resolvedAt, f.resolvedRunId,
  f.slaDueAt, f.packageName, f.packageVersion, f.fixedVersion, f.justification, f.decidedBy, f.decidedByUserId, f.decidedAt,
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
              package_version = u.package_version, fixed_version = u.fixed_version
       FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[], $7::timestamptz[], $8::text[], $9::timestamptz[],
                   $10::text[], $11::text[], $12::text[])
            AS u(id, status, severity, first_seen_at, last_seen_at, resolved_at, resolved_run_id, sla_due_at, package_name, package_version, fixed_version)
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

// ------------------------------------------------------------------------------------------------ POA&M

/** OPEN findings past their SLA (strictly before `now`), with the asset name and KEV flag, plus the POA&M items already linked to them. */
export async function listPoamCandidates(
  tenantId: string,
  now: string,
  client: pg.PoolClient | null,
): Promise<{ candidates: PoamCandidate[]; linked: LinkedPoamItem[] }> {
  if (isMemory()) {
    const names = new Map((await listAssets(tenantId)).map((a) => [a.id, a.hostName]));
    const candidates = [...memoryFindings.values()]
      .filter((f) => f.tenantId === tenantId && f.status === 'OPEN' && f.slaDueAt !== null && f.slaDueAt < new Date(now).toISOString())
      .map((f) => ({ finding: { ...f }, assetName: names.get(f.assetId) ?? '', kev: Boolean(memoryVulns.get(f.vulnId)?.kev) }));
    const ids = new Set(candidates.map((x) => x.finding.id));
    const linked = [...memoryPoam.values()]
      .filter((p) => p.tenantId === tenantId && p.findingId !== null && ids.has(p.findingId))
      .map((p) => ({ findingId: p.findingId as string, status: p.status, createdAt: p.createdAt }));
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
    'SELECT finding_id, status, created_at FROM vm_poam_items WHERE tenant_id = $1 AND finding_id = ANY($2::text[])',
    [tenantId, candidates.map((x) => x.finding.id)],
  );
  const linked = links.rows.map((r) => ({ findingId: r.finding_id as string, status: r.status as VmPoamStatus, createdAt: iso(r.created_at) as string }));
  return { candidates, linked };
}

/** Inserts the worker's POA&M items; the partial unique index (unq_vm_poam_items_auto) makes a repeat a no-op. */
export async function insertPoamItems(tenantId: string, drafts: PoamDraft[], client: pg.PoolClient | null): Promise<void> {
  if (drafts.length === 0) return;
  if (isMemory()) {
    for (const d of drafts) {
      const exists = [...memoryPoam.values()].some((p) => p.tenantId === tenantId && p.findingId === d.findingId && p.createdBy === d.createdBy);
      if (exists) continue;
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
      });
    }
    return;
  }
  const c = need(client);
  for (const part of chunks(drafts)) {
    await c.query(
      `INSERT INTO vm_poam_items (tenant_id, finding_id, control_id, weakness, mitigation, owner, scheduled_completion, status, created_by)
       VALUES ${placeholders(part.length, 9)}
       ON CONFLICT DO NOTHING`,
      part.flatMap((d) => [tenantId, d.findingId, d.controlId, d.weakness, d.mitigation, d.owner, d.scheduledCompletion, d.status, d.createdBy]),
    );
  }
}

// ------------------------------------------------------------------------------------------------ runs and listing

/** Marks the run NORMALIZED inside the run's own transaction, so the status never gets ahead of the data it describes. */
export async function markRunNormalized(tenantId: string, runId: string, finishedAt: string, warning: string | null, client: pg.PoolClient | null): Promise<void> {
  if (isMemory()) {
    await updateRun(tenantId, runId, { status: 'NORMALIZED', finishedAt, warning, error: null });
    return;
  }
  await need(client).query("UPDATE vm_runs SET status = 'NORMALIZED', finished_at = $3, warning = $4, error = NULL WHERE id = $1 AND tenant_id = $2", [runId, tenantId, finishedAt, warning]);
}

/**
 * Everything the snapshot evaluates, in one tenant transaction: every finding (any status), the ids of the vulnerabilities
 * on the known-exploited list that the tenant has findings for, and every POA&M item.
 */
export async function loadSnapshotFindings(tenantId: string): Promise<{ findings: VmFinding[]; kevVulnIds: string[]; poam: VmPoamItem[] }> {
  if (isMemory()) {
    const findings = [...memoryFindings.values()].filter((f) => f.tenantId === tenantId).map((f) => ({ ...f }));
    const kevVulnIds = [...new Set(findings.map((f) => f.vulnId))].filter((id) => memoryVulns.get(id)?.kev);
    const poam = [...memoryPoam.values()].filter((p) => p.tenantId === tenantId).map((p) => ({ ...p }));
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
  });
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
