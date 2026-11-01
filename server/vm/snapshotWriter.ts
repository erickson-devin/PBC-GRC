import crypto from 'crypto';
import path from 'path';
import type pg from 'pg';
import { getDbMode, getTenantFrameworkPolicy, memoryTenantCheckpoint, queryWithProgram, type ProgramScope } from '../db';
import { frameworksDefiningControl } from '../middleware/frameworkGuard';
import { getEquivalentControlIds } from '../../src/data/frameworks/controlMappings';
import { listAgentAssetCandidates, listAssets } from '../assets';
import { memoryEventsCheckpoint, writeControlAssessment, type ControlChangeActor } from '../controlAssessments';
import { getProgram, resolveVmTargetProgram } from '../programs';
import { localStorageRoot, readTenantFile, isLocalStorageConfigured, removeTenantFile, writeTenantFile } from '../evidence/storage';
import { listRunsSince, listSources } from './store';
import { loadSnapshotFindings, withVmTenantTx } from './findingsStore';
import {
  VM_SNAPSHOT_ACTOR,
  completeSnapshotStems,
  computeSnapshot,
  getVmSnapshotConfig,
  newEvidenceId,
  newSnapshotId,
  renderNotesBlock,
  renderSnapshotMarkdown,
  replaceDelimitedBlock,
  snapshotControlIds,
  snapshotFileKeys,
} from './snapshot';
import type { SnapshotInput, SnapshotReport, VmSnapshotConfig } from './snapshot';
import { VM_CONFIG_ONLY_SOURCE_KINDS } from '../../src/types/vm';

/**
 * Writes a vulnerability management snapshot (docs/VULNERABILITY_MANAGEMENT.md, section 7): the evaluation from ./snapshot is
 * stored as two files in the tenant's evidence vault (JSON and Markdown), registered as evidence on the program's controls
 * exactly like an upload (so /verify-integrity works and the cross-framework inheritance applies), and summarised in a
 * delimited block of each control's implementation notes. A control's status is never changed here.
 */

export type VmSnapshotErrorCode = 'in_progress' | 'requires_local_storage' | 'no_sources' | 'integrity';

export class VmSnapshotError extends Error {
  constructor(public readonly code: VmSnapshotErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VmSnapshotError';
  }
}

// ------------------------------------------------------------------------------------------------ input

async function vulnerabilitySources(tenantId: string) {
  return (await listSources(tenantId)).filter((s) => !VM_CONFIG_ONLY_SOURCE_KINDS.includes(s.kind));
}

export async function loadSnapshotInput(tenantId: string, now: Date, cfg: VmSnapshotConfig, snapshotId: string, programId?: string): Promise<SnapshotInput> {
  const windowStart = new Date(now.getTime() - cfg.snapshotIntervalHours * 3_600_000).toISOString();
  // Configuration-only sources (SCAP) report no vulnerabilities: they are not part of the vulnerability snapshot.
  const sources = await vulnerabilitySources(tenantId);
  const runs = await listRunsSince(tenantId, windowStart);
  const assets = await listAssets(tenantId);
  // AssetRecord has no last_vuln_seen_at: join the candidate list by id.
  const seen = new Map((await listAgentAssetCandidates(tenantId)).map((c) => [c.id, c.lastVulnSeenAt]));
  const { findings, kevVulnIds, poam } = await loadSnapshotFindings(tenantId, programId ?? (await resolveVmTargetProgram(tenantId)).program.id);
  return {
    snapshotId,
    tenantId,
    now: now.toISOString(),
    windowHours: cfg.snapshotIntervalHours,
    coverageThreshold: cfg.coverageThreshold,
    sources,
    runs,
    assets: assets.map((a) => ({
      id: a.id,
      hostName: a.hostName,
      cmmcCategory: a.cmmcAssetCategory,
      discoveryStatus: a.discoveryStatus,
      lastVulnSeenAt: seen.get(a.id) ?? null,
    })),
    findings,
    kevVulnIds,
    poamItems: poam,
  };
}

// ------------------------------------------------------------------------------------------------ evidence

export interface SnapshotFileRecord {
  key: string;
  fileName: string;
  absPath: string;
  sha256: string;
  size: number;
  mimeType: string;
}

export interface WrittenSnapshotEvidence {
  files: SnapshotFileRecord[];
  controls: string[];
  /** Base evidence rows (one per control and file). */
  evidenceIds: string[];
  /** Rows created by the cross-framework inheritance. */
  inheritedEvidenceIds: string[];
  /** Base evidence ids by control id, for the notes block. */
  evidenceByControl: Record<string, string[]>;
}

// Same statements as the upload route (server/routes/evidence.ts), with the program the rows belong to as the last parameter.
const EVIDENCE_INSERT = `
  INSERT INTO evidence_metadata (
    id, tenant_id, control_id, file_name, file_size, mime_type,
    gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12
  )
  RETURNING *;
`;

const INHERITED_INSERT = `
  INSERT INTO evidence_metadata (
    id, tenant_id, control_id, file_name, file_size, mime_type,
    gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, 'inherited', $9, $10, NOW(), $11
  )
  ON CONFLICT (id) DO NOTHING;
`;

/**
 * Writes the two vault files (JSON and Markdown). This happens outside the database transaction (a file cannot roll back); if the
 * second write fails the first is removed, so a failure leaves no file behind.
 */
export async function writeSnapshotFiles(tenantId: string, report: SnapshotReport, md: string): Promise<SnapshotFileRecord[]> {
  const keys = snapshotFileKeys(report.snapshotId);
  const specs = [
    { key: keys.json, fileName: `${report.snapshotId}.json`, mimeType: 'application/json', data: Buffer.from(JSON.stringify(report, null, 2) + '\n') },
    { key: keys.md, fileName: `${report.snapshotId}.md`, mimeType: 'text/markdown', data: Buffer.from(md, 'utf8') },
  ];
  const files: SnapshotFileRecord[] = [];
  try {
    for (const s of specs) {
      const written = await writeTenantFile(tenantId, s.key, s.data, { exclusive: true });
      files.push({ key: s.key, fileName: s.fileName, absPath: written.absPath, sha256: written.sha256, size: written.size, mimeType: s.mimeType });
    }
  } catch (err) {
    await removeSnapshotFiles(tenantId, files);
    throw err;
  }
  return files;
}

/** Best effort and silent: removes files a failed snapshot wrote (a missing file is fine). */
async function removeSnapshotFiles(tenantId: string, files: readonly SnapshotFileRecord[]): Promise<void> {
  for (const f of files) await removeTenantFile(tenantId, f.absPath).catch(() => undefined);
}

/** An explicit VM target program decides the control list from its own framework; otherwise the tenant's allow-list does. */
async function resolveSnapshotControls(tenantId: string, controlFrameworks?: string[]): Promise<string[]> {
  return snapshotControlIds(controlFrameworks ? { enabledFrameworks: controlFrameworks } : await getTenantFrameworkPolicy(tenantId), frameworksDefiningControl);
}

/**
 * Inserts the evidence rows (base rows and inheritance rows). With a `client` the statements join the caller's transaction (which
 * already holds the tenant and program settings); without one (memory mode) each goes through the program-scoped helper.
 */
export async function insertSnapshotEvidence(
  scope: ProgramScope,
  files: readonly SnapshotFileRecord[],
  controls: readonly string[],
  now: Date,
  client: pg.PoolClient | null,
): Promise<WrittenSnapshotEvidence> {
  const { tenantId, programId } = scope;
  const exec = (sql: string, params: (string | number | null)[]): Promise<unknown> => (client ? client.query(sql, params) : queryWithProgram(scope, sql, params));
  const day = now.toISOString().slice(0, 10);
  const description = `Automated vulnerability management snapshot ${day}`;
  const evidenceIds: string[] = [];
  const inheritedEvidenceIds: string[] = [];
  const evidenceByControl: Record<string, string[]> = {};
  const used = new Set<string>();
  const nextId = (): string => {
    let id = newEvidenceId(now.getTime());
    while (used.has(id)) id = newEvidenceId(now.getTime());
    used.add(id);
    return id;
  };

  for (const controlId of controls) {
    evidenceByControl[controlId] = [];
    for (const f of files) {
      const id = nextId();
      await exec(EVIDENCE_INSERT, [
        id,
        tenantId,
        controlId,
        f.fileName,
        f.size,
        f.mimeType,
        f.absPath,
        f.sha256,
        'local_storage',
        description,
        VM_SNAPSHOT_ACTOR,
        programId,
      ]);
      evidenceIds.push(id);
      evidenceByControl[controlId].push(id);

      // Cross-framework inheritance, explicit as in the upload route so both database modes hold the same rows.
      for (const mappedId of getEquivalentControlIds(controlId)) {
        const inhId = `${id}__inh_${mappedId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        await exec(INHERITED_INSERT, [
          inhId,
          tenantId,
          mappedId,
          f.fileName,
          f.size,
          f.mimeType,
          f.absPath,
          f.sha256,
          `[Inherited from ${controlId}] ${description}`,
          VM_SNAPSHOT_ACTOR,
          programId,
        ]);
        inheritedEvidenceIds.push(inhId);
      }
    }
  }
  return { files: [...files], controls: [...controls], evidenceIds, inheritedEvidenceIds, evidenceByControl };
}

// ------------------------------------------------------------------------------------------------ control notes

/**
 * Replaces the snapshot block in each control's notes (appending it when there is none). Status and role are not passed
 * through: NULL keeps the stored value (COALESCE), and the FOR UPDATE read inside writeControlAssessment closes the race with a
 * concurrent human edit. A control with no row yet is created as NOT_STARTED. Each write records a history event for `who`.
 * The writes run on the snapshot's transaction `client` (null in memory mode), in sorted control order so row locks are always
 * taken in the same order; `afterNote` is the fault hook's seam and is called after each control.
 */
export async function applySnapshotNotes(
  tenantId: string,
  report: SnapshotReport,
  evidenceByControl: Record<string, string[]>,
  who: ControlChangeActor,
  programId: string,
  client: pg.PoolClient | null,
  afterNote?: (writtenSoFar: number) => void,
): Promise<void> {
  let written = 0;
  for (const controlId of Object.keys(evidenceByControl).sort()) {
    await writeControlAssessment(
      { tenantId, programId },
      controlId,
      (cur) => ({
        status: null,
        notes: replaceDelimitedBlock(cur?.notes ?? '', renderNotesBlock(report, evidenceByControl[controlId])),
        role: null,
        updatedBy: VM_SNAPSHOT_ACTOR,
      }),
      who,
      client,
    );
    written++;
    afterNote?.(written);
  }
}

// ------------------------------------------------------------------------------------------------ run

export interface VmSnapshotSummary {
  id: string;
  createdAt: string;
  /** The program the evidence and notes were written to (the tenant's VM target program). */
  programId: string;
  criteriaMet: boolean;
  evidenceIds: string[];
  controls: string[];
  summary: {
    sourcesWithinInterval: string;
    coverage: number | null;
    openTotal: number;
    kevOpen: number;
    overdueCriticalOrKev: number;
  };
}

const running = new Set<string>();
let faultTenant: string | null = null;
export type VmSnapshotFaultStage = 'start' | 'after_evidence' | 'after_first_note';
let faultStage: VmSnapshotFaultStage = 'start';

/**
 * Test hook: snapshots of this tenant throw until cleared (null clears it). `stage` is where: 'start' (before anything is written),
 * 'after_evidence' (all evidence rows inserted, no note yet) or 'after_first_note' (inside the transaction, after one control's notes).
 */
export function __setVmSnapshotFaultForTests(tenantId: string | null, stage: VmSnapshotFaultStage = 'start'): void {
  faultTenant = tenantId;
  faultStage = stage;
}

const faultAt = (tenantId: string, stage: VmSnapshotFaultStage): void => {
  if (faultTenant === tenantId && faultStage === stage) throw new Error('VM snapshot fault injected');
};

/**
 * The snapshot's database writes as one transaction: PostgreSQL runs `fn` in withVmTenantTx (tenant and program set for the whole
 * transaction, committed or rolled back as one); memory mode has no ROLLBACK, so it takes a checkpoint of the tenant's controls,
 * evidence and the scope's history and restores it when `fn` throws.
 */
async function snapshotTx<T>(scope: ProgramScope, fn: (client: pg.PoolClient | null) => Promise<T>): Promise<T> {
  if (getDbMode() !== 'memory') return withVmTenantTx(scope.tenantId, fn, scope.programId);
  const undoTenant = memoryTenantCheckpoint(scope.tenantId);
  const undoEvents = memoryEventsCheckpoint(scope);
  try {
    return await fn(null);
  } catch (err) {
    undoTenant();
    undoEvents();
    throw err;
  }
}

export async function runVmSnapshot(
  tenantId: string,
  opts: { now?: Date; trigger: 'manual' | 'scheduler'; triggeredBy?: { actor: string; userId: string | null }; programId?: string },
): Promise<{ snapshot: VmSnapshotSummary; report: SnapshotReport }> {
  if (!isLocalStorageConfigured()) throw new VmSnapshotError('requires_local_storage');
  if (running.has(tenantId)) throw new VmSnapshotError('in_progress');
  running.add(tenantId);
  try {
    if ((await vulnerabilitySources(tenantId)).length === 0) throw new VmSnapshotError('no_sources');
    faultAt(tenantId, 'start');

    const now = opts.now ?? new Date();
    const cfg = getVmSnapshotConfig();
    const snapshotId = newSnapshotId(now.getTime());
    // Snapshot evidence and notes belong to the tenant's VM target program (the default program when none is set, decision 6).
    // Only an explicit target decides the control list; without one the allow-list's control set stays as it was.
    let target: { program: { id: string; frameworkId: string }; explicit: boolean };
    if (opts.programId) {
      const chosen = await getProgram(tenantId, opts.programId);
      if (!chosen) throw new Error('VM snapshot program not found');
      target = { program: chosen, explicit: true };
    } else {
      target = await resolveVmTargetProgram(tenantId);
    }
    const programId = target.program.id;
    const input = await loadSnapshotInput(tenantId, now, cfg, snapshotId, programId);
    const report = computeSnapshot(input);
    const md = renderSnapshotMarkdown(report);
    const controls = await resolveSnapshotControls(tenantId, target.explicit ? [target.program.frameworkId] : undefined);
    const scope = { tenantId, programId };

    // Files first (they cannot roll back), then every evidence row and note in ONE transaction: a failure leaves no row, no history
    // event and (the files are removed) no file, so a half-written snapshot never postpones the retry.
    const files = await writeSnapshotFiles(tenantId, report, md);
    let written: WrittenSnapshotEvidence;
    try {
      written = await snapshotTx(scope, async (client) => {
        const inserted = await insertSnapshotEvidence(scope, files, controls, now, client);
        faultAt(tenantId, 'after_evidence');
        await applySnapshotNotes(
          tenantId,
          report,
          inserted.evidenceByControl,
          { source: 'vm-snapshot', actor: opts.triggeredBy?.actor ?? VM_SNAPSHOT_ACTOR, userId: opts.triggeredBy?.userId ?? null },
          programId,
          client,
          (n) => {
            if (n === 1) faultAt(tenantId, 'after_first_note');
          },
        );
        return inserted;
      });
    } catch (err) {
      await removeSnapshotFiles(tenantId, files);
      throw err;
    }

    console.log(
      `[VM Snapshot] ${snapshotId} in ${tenantId}: criteria MET ${report.criteria.met ? 'yes' : 'no'}, ${written.evidenceIds.length + written.inheritedEvidenceIds.length} evidence rows (${opts.trigger})`,
    );
    return {
      snapshot: {
        id: snapshotId,
        createdAt: now.toISOString(),
        programId,
        criteriaMet: report.criteria.met,
        evidenceIds: written.evidenceIds,
        controls: written.controls,
        summary: {
          sourcesWithinInterval: `${report.sources.withinInterval}/${report.sources.enabled}`,
          coverage: report.coverage.ratio,
          openTotal: report.findings.openTotal,
          kevOpen: report.findings.kevOpen,
          overdueCriticalOrKev: report.findings.overdueCriticalOrKev,
        },
      },
      report,
    };
  } finally {
    running.delete(tenantId);
  }
}

// ------------------------------------------------------------------------------------------------ reading snapshots back

interface SnapshotRow {
  id: string;
  controlId: string;
  fileName: string;
  gcsPath: string;
  fileHash: string;
  uploadedAtMs: number;
}

const SNAPSHOT_FILE = /^(vmsnap_[A-Za-z0-9_-]+)\.(json|md)$/;

/** The snapshot evidence rows of a tenant (base rows only), newest first. The memory store ignores WHERE, so filter here too. */
async function snapshotRows(tenantId: string): Promise<SnapshotRow[]> {
  // evidence_metadata is program-scoped: the snapshot evidence lives in the tenant's VM target program (the default when none is set)
  const res = await queryWithProgram(
    { tenantId, programId: (await resolveVmTargetProgram(tenantId)).program.id },
    'SELECT id, control_id, file_name, gcs_path, file_hash, sync_status, uploaded_by, uploaded_at FROM evidence_metadata WHERE tenant_id = $1 AND uploaded_by = $2 ORDER BY uploaded_at DESC',
    [tenantId, VM_SNAPSHOT_ACTOR],
  );
  const own = res.rows.filter((r) => r.uploaded_by === VM_SNAPSHOT_ACTOR && r.sync_status !== 'inherited' && SNAPSHOT_FILE.test(String(r.file_name)));
  // Only a stem with both files counts: a lone file is what a snapshot written before the single transaction (issue #56) left behind.
  const complete = completeSnapshotStems(own.map((r) => ({ fileName: String(r.file_name) })));
  return own
    .filter((r) => complete.has((SNAPSHOT_FILE.exec(String(r.file_name)) as RegExpExecArray)[1]))
    .map((r) => ({
      id: String(r.id),
      controlId: String(r.control_id),
      fileName: String(r.file_name),
      gcsPath: String(r.gcs_path ?? ''),
      fileHash: String(r.file_hash ?? ''),
      uploadedAtMs: new Date(r.uploaded_at).getTime(),
    }))
    .sort((a, b) => b.uploadedAtMs - a.uploadedAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export interface VmSnapshotListing {
  id: string;
  createdAt: string;
  evidenceIds: string[];
  controls: string[];
}

function groupSnapshots(rows: readonly SnapshotRow[]): VmSnapshotListing[] {
  const byStem = new Map<string, { createdMs: number; evidenceIds: string[]; controls: Set<string> }>();
  for (const r of rows) {
    const stem = (SNAPSHOT_FILE.exec(r.fileName) as RegExpExecArray)[1];
    let g = byStem.get(stem);
    if (!g) {
      g = { createdMs: r.uploadedAtMs, evidenceIds: [], controls: new Set() };
      byStem.set(stem, g);
    }
    g.createdMs = Math.min(g.createdMs, r.uploadedAtMs);
    g.evidenceIds.push(r.id);
    g.controls.add(r.controlId);
  }
  return [...byStem.entries()]
    .map(([id, g]) => ({ id, createdAt: new Date(g.createdMs).toISOString(), evidenceIds: g.evidenceIds, controls: [...g.controls] }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** When the tenant's newest snapshot was written, or null when it has none. */
export async function latestSnapshotAt(tenantId: string): Promise<string | null> {
  const rows = await snapshotRows(tenantId);
  return rows.length ? new Date(rows[0].uploadedAtMs).toISOString() : null;
}

/** Newest first, at most 100. */
export async function listVmSnapshots(tenantId: string): Promise<VmSnapshotListing[]> {
  return groupSnapshots(await snapshotRows(tenantId)).slice(0, 100);
}

/**
 * The newest snapshot's report, read back from the vault. Null when there is none or its file is missing or outside
 * <root>/tenants/<tenant>/vm/snapshots/; VmSnapshotError 'integrity' when the file no longer matches the recorded sha256.
 */
export async function readLatestSnapshot(tenantId: string): Promise<{ snapshot: VmSnapshotListing; report: SnapshotReport } | null> {
  const rows = await snapshotRows(tenantId);
  const jsonRow = rows.find((r) => r.fileName.endsWith('.json'));
  if (!jsonRow) return null;
  const dir = path.join(localStorageRoot(), 'tenants', tenantId, 'vm', 'snapshots') + path.sep;
  if (!path.resolve(jsonRow.gcsPath).startsWith(dir)) return null;
  const bytes = await readTenantFile(tenantId, jsonRow.gcsPath);
  if (!bytes) return null;
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== jsonRow.fileHash.toLowerCase()) throw new VmSnapshotError('integrity');
  let report: SnapshotReport;
  try {
    report = JSON.parse(bytes.toString('utf8')) as SnapshotReport;
  } catch {
    throw new VmSnapshotError('integrity');
  }
  const stem = (SNAPSHOT_FILE.exec(jsonRow.fileName) as RegExpExecArray)[1];
  const snapshot = groupSnapshots(rows).find((s) => s.id === stem) as VmSnapshotListing;
  return { snapshot, report };
}

// ------------------------------------------------------------------------------------------------ manual limiter

const lastManual = new Map<string, number>();

export const lastManualSnapshotAt = (tenantId: string): number | null => lastManual.get(tenantId) ?? null;
export const noteManualSnapshot = (tenantId: string, ms: number): void => void lastManual.set(tenantId, ms);

/** Test hook. */
export function __resetVmSnapshotLimiterForTests(): void {
  lastManual.clear();
}
