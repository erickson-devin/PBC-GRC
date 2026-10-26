import crypto from 'crypto';
import path from 'path';
import { getTenantProgram, queryWithProgram, queryWithTenant } from '../db';
import { frameworksDefiningControl } from '../middleware/frameworkGuard';
import { getEquivalentControlIds } from '../../src/data/frameworks/controlMappings';
import { listAgentAssetCandidates, listAssets } from '../assets';
import { writeControlAssessment, type ControlChangeActor } from '../controlAssessments';
import { ensureDefaultProgram } from '../programs';
import { localStorageRoot, readTenantFile, isLocalStorageConfigured, writeTenantFile } from '../evidence/storage';
import { listRunsSince, listSources } from './store';
import { loadSnapshotFindings } from './findingsStore';
import {
  VM_SNAPSHOT_ACTOR,
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

export async function loadSnapshotInput(tenantId: string, now: Date, cfg: VmSnapshotConfig, snapshotId: string): Promise<SnapshotInput> {
  const windowStart = new Date(now.getTime() - cfg.snapshotIntervalHours * 3_600_000).toISOString();
  const sources = await listSources(tenantId);
  const runs = await listRunsSince(tenantId, windowStart);
  const assets = await listAssets(tenantId);
  // AssetRecord has no last_vuln_seen_at: join the candidate list by id.
  const seen = new Map((await listAgentAssetCandidates(tenantId)).map((c) => [c.id, c.lastVulnSeenAt]));
  const { findings, kevVulnIds, poam } = await loadSnapshotFindings(tenantId);
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

export async function writeSnapshotEvidence(
  tenantId: string,
  report: SnapshotReport,
  md: string,
  now: Date,
  programId: string,
): Promise<WrittenSnapshotEvidence> {
  const scope = { tenantId, programId };
  const keys = snapshotFileKeys(report.snapshotId);
  const day = now.toISOString().slice(0, 10);
  const specs = [
    { key: keys.json, fileName: `${report.snapshotId}.json`, mimeType: 'application/json', data: Buffer.from(JSON.stringify(report, null, 2) + '\n') },
    { key: keys.md, fileName: `${report.snapshotId}.md`, mimeType: 'text/markdown', data: Buffer.from(md, 'utf8') },
  ];
  const files: SnapshotFileRecord[] = [];
  for (const s of specs) {
    const written = await writeTenantFile(tenantId, s.key, s.data, { exclusive: true });
    files.push({ key: s.key, fileName: s.fileName, absPath: written.absPath, sha256: written.sha256, size: written.size, mimeType: s.mimeType });
  }

  const controls = snapshotControlIds(await getTenantProgram(tenantId), frameworksDefiningControl);
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
      await queryWithProgram(scope, EVIDENCE_INSERT, [
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
        await queryWithProgram(scope, INHERITED_INSERT, [
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
  return { files, controls, evidenceIds, inheritedEvidenceIds, evidenceByControl };
}

// ------------------------------------------------------------------------------------------------ control notes

/**
 * Replaces the snapshot block in each control's notes (appending it when there is none). Status and role are not passed
 * through: NULL keeps the stored value (COALESCE), and the FOR UPDATE read inside writeControlAssessment closes the race with a
 * concurrent human edit. A control with no row yet is created as NOT_STARTED. Each write records a history event for `who`.
 */
export async function applySnapshotNotes(
  tenantId: string,
  report: SnapshotReport,
  evidenceByControl: Record<string, string[]>,
  who: ControlChangeActor,
  programId: string,
): Promise<void> {
  for (const controlId of Object.keys(evidenceByControl)) {
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
    );
  }
}

// ------------------------------------------------------------------------------------------------ run

export interface VmSnapshotSummary {
  id: string;
  createdAt: string;
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

/** Test hook: the next snapshot of this tenant throws (null clears it). */
export function __setVmSnapshotFaultForTests(tenantId: string | null): void {
  faultTenant = tenantId;
}

export async function runVmSnapshot(
  tenantId: string,
  opts: { now?: Date; trigger: 'manual' | 'scheduler'; triggeredBy?: { actor: string; userId: string | null }; programId?: string },
): Promise<{ snapshot: VmSnapshotSummary; report: SnapshotReport }> {
  if (!isLocalStorageConfigured()) throw new VmSnapshotError('requires_local_storage');
  if (running.has(tenantId)) throw new VmSnapshotError('in_progress');
  running.add(tenantId);
  try {
    if ((await listSources(tenantId)).length === 0) throw new VmSnapshotError('no_sources');
    if (faultTenant === tenantId) throw new Error('VM snapshot fault injected');

    const now = opts.now ?? new Date();
    const cfg = getVmSnapshotConfig();
    const snapshotId = newSnapshotId(now.getTime());
    const input = await loadSnapshotInput(tenantId, now, cfg, snapshotId);
    const report = computeSnapshot(input);
    const md = renderSnapshotMarkdown(report);
    // Snapshot evidence and notes belong to the tenant's default program (decision 6); the control set is still the allow-list's.
    const programId = opts.programId ?? (await ensureDefaultProgram(tenantId)).id;
    const written = await writeSnapshotEvidence(tenantId, report, md, now, programId);
    await applySnapshotNotes(tenantId, report, written.evidenceByControl, {
      source: 'vm-snapshot',
      actor: opts.triggeredBy?.actor ?? VM_SNAPSHOT_ACTOR,
      userId: opts.triggeredBy?.userId ?? null,
    }, programId);

    console.log(
      `[VM Snapshot] ${snapshotId} in ${tenantId}: criteria MET ${report.criteria.met ? 'yes' : 'no'}, ${written.evidenceIds.length + written.inheritedEvidenceIds.length} evidence rows (${opts.trigger})`,
    );
    return {
      snapshot: {
        id: snapshotId,
        createdAt: now.toISOString(),
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
  const res = await queryWithTenant(
    tenantId,
    'SELECT id, control_id, file_name, gcs_path, file_hash, sync_status, uploaded_by, uploaded_at FROM evidence_metadata WHERE tenant_id = $1 AND uploaded_by = $2 ORDER BY uploaded_at DESC',
    [tenantId, VM_SNAPSHOT_ACTOR],
  );
  return res.rows
    .filter((r) => r.uploaded_by === VM_SNAPSHOT_ACTOR && r.sync_status !== 'inherited' && SNAPSHOT_FILE.test(String(r.file_name)))
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
