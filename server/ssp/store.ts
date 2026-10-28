import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool, type ProgramScope } from '../db';
import type {
  CoverageReport,
  GapAnalysis,
  SourceQuote,
  SspBaseline,
  SspImportFramework,
  SspImportJob,
  SspJobStatus,
  SspMatchKind,
  SspReviewState,
  StagedControl,
  StagedControlDraft,
  UnmappedFinding,
} from './types';

/**
 * Persistence of import jobs and staged suggestions: PostgreSQL (tenant RLS context set on every transaction) or process
 * memory when DB_MODE=memory. Nothing here reads or writes control_assessments.
 */
const isMemory = (): boolean => getDbMode() === 'memory';
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
export const newId = (prefix: string): string => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

const memoryJobs = new Map<string, SspImportJob>();
const memoryStaged = new Map<string, StagedControl>();

/** Test hook. */
export function __resetSspStoreForTests(): void {
  memoryJobs.clear();
  memoryStaged.clear();
}

/** One transaction under the tenant's AND the program's RLS context: ssp_import_jobs and staged_controls have a program row policy. */
async function inTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>, programId: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_program_id', programId]);
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

function rowToJob(r: pg.QueryResultRow): SspImportJob {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    programId: r.program_id ?? undefined,
    createdBy: r.created_by,
    createdByUserId: r.created_by_user_id ?? null,
    fileName: r.file_name,
    mimeType: r.mime_type,
    fileSize: Number(r.file_size),
    fileSha256: r.file_sha256,
    framework: r.framework as SspImportFramework,
    baseline: (r.baseline as SspBaseline | null) ?? null,
    status: r.status as SspJobStatus,
    stageProgress: r.stage_progress ?? {},
    storedProvider: r.stored_provider,
    storedPath: r.stored_path,
    pageCount: r.page_count ?? null,
    charCount: r.char_count ?? null,
    chunkCount: r.chunk_count ?? null,
    analyzer: r.analyzer,
    coverage: (r.coverage_report as CoverageReport | null) ?? null,
    unmapped: (r.unmapped_findings as UnmappedFinding[]) ?? [],
    error: r.error ?? null,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

function rowToStaged(r: pg.QueryResultRow): StagedControl {
  return {
    id: r.id,
    jobId: r.job_id,
    tenantId: r.tenant_id,
    programId: r.program_id ?? undefined,
    controlId: r.control_id,
    framework: r.framework as SspImportFramework,
    matchKind: r.match_kind as SspMatchKind,
    origin: (r.origin ?? 'RULES') as StagedControl['origin'],
    sectionHeading: r.section_heading ?? '',
    suggestedNotes: r.suggested_notes ?? '',
    confidence: Number(r.confidence),
    sourceQuotes: (r.source_quotes as SourceQuote[]) ?? [],
    gapAnalysis: (r.gap_analysis as GapAnalysis) ?? { source: 'heuristic', summary: '', gaps: [] },
    baseHash: r.base_hash ?? null,
    reviewState: r.review_state as SspReviewState,
    editedNotes: r.edited_notes ?? null,
    reviewedBy: r.reviewed_by ?? null,
    reviewedAt: iso(r.reviewed_at),
    committedAt: iso(r.committed_at),
  };
}

// ------------------------------------------------------------------------------------------------ jobs

export interface NewJob {
  id: string;
  tenantId: string;
  /** The program the import is stamped with: its suggestions can only be committed there. */
  programId: string;
  createdBy: string;
  createdByUserId: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileSha256: string;
  framework: SspImportFramework;
  /** NIST SP 800-53 imports only. */
  baseline?: SspBaseline | null;
  storedProvider: 'local';
  storedPath: string;
  analyzer: string;
}

export async function createJob(input: NewJob): Promise<SspImportJob> {
  if (isMemory()) {
    const job: SspImportJob = {
      ...input,
      baseline: input.baseline ?? null,
      status: 'QUEUED',
      stageProgress: {},
      pageCount: null,
      charCount: null,
      chunkCount: null,
      coverage: null,
      unmapped: [],
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    memoryJobs.set(job.id, job);
    return { ...job };
  }
  return inTenantTx(input.tenantId, async (c) => {
    const res = await c.query(
      `INSERT INTO ssp_import_jobs (id, tenant_id, created_by, created_by_user_id, file_name, mime_type, file_size, file_sha256,
                                    framework, stored_provider, stored_path, analyzer, baseline, program_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [input.id, input.tenantId, input.createdBy, input.createdByUserId, input.fileName, input.mimeType, input.fileSize,
       input.fileSha256, input.framework, input.storedProvider, input.storedPath, input.analyzer, input.baseline ?? null, input.programId]
    );
    return rowToJob(res.rows[0]);
  }, input.programId);
}

/** A job of another program is not found (a job written before programs existed has no program and counts as this one's). */
const inProgram = (rowProgram: string | null | undefined, scope: ProgramScope): boolean => !rowProgram || rowProgram === scope.programId;

export async function getJob(scope: ProgramScope, id: string): Promise<SspImportJob | null> {
  const { tenantId } = scope;
  if (isMemory()) {
    const j = memoryJobs.get(id);
    return j && j.tenantId === tenantId && inProgram(j.programId, scope) ? { ...j } : null;
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('SELECT * FROM ssp_import_jobs WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)', [id, tenantId, scope.programId]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }, scope.programId);
}

export async function listJobs(scope: ProgramScope): Promise<SspImportJob[]> {
  const { tenantId } = scope;
  if (isMemory()) {
    return [...memoryJobs.values()].filter((j) => j.tenantId === tenantId && inProgram(j.programId, scope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => ({ ...j }));
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('SELECT * FROM ssp_import_jobs WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY created_at DESC LIMIT 100', [tenantId, scope.programId]);
    return res.rows.map(rowToJob);
  }, scope.programId);
}

export interface JobPatch {
  status?: SspJobStatus;
  analyzer?: string;
  stageProgress?: SspImportJob['stageProgress'];
  pageCount?: number | null;
  charCount?: number | null;
  chunkCount?: number | null;
  coverage?: CoverageReport | null;
  unmapped?: UnmappedFinding[];
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** The job by id inside its tenant, whatever its program: for the job's own updates (the id is unique). */
async function getJobById(scope: ProgramScope, id: string): Promise<SspImportJob | null> {
  const { tenantId } = scope;
  if (isMemory()) {
    const j = memoryJobs.get(id);
    return j && j.tenantId === tenantId ? { ...j } : null;
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('SELECT * FROM ssp_import_jobs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }, scope.programId);
}

export async function updateJob(scope: ProgramScope, id: string, patch: JobPatch): Promise<SspImportJob | null> {
  const { tenantId } = scope;
  if (isMemory()) {
    const j = memoryJobs.get(id);
    if (!j || j.tenantId !== tenantId) return null;
    Object.assign(j, patch);
    return { ...j };
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown, json = false): void => {
    vals.push(json ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}${json ? '::jsonb' : ''}`);
  };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.analyzer !== undefined) add('analyzer', patch.analyzer);
  if (patch.stageProgress !== undefined) add('stage_progress', patch.stageProgress, true);
  if (patch.pageCount !== undefined) add('page_count', patch.pageCount);
  if (patch.charCount !== undefined) add('char_count', patch.charCount);
  if (patch.chunkCount !== undefined) add('chunk_count', patch.chunkCount);
  if (patch.coverage !== undefined) add('coverage_report', patch.coverage, true);
  if (patch.unmapped !== undefined) add('unmapped_findings', patch.unmapped, true);
  if (patch.error !== undefined) add('error', patch.error);
  if (patch.startedAt !== undefined) add('started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
  if (sets.length === 0) return getJobById(scope, id);
  vals.push(id, tenantId);
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query(`UPDATE ssp_import_jobs SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length} RETURNING *`, vals as never[]);
    return res.rows[0] ? rowToJob(res.rows[0]) : null;
  }, scope.programId);
}

export async function deleteJob(scope: ProgramScope, id: string): Promise<boolean> {
  const { tenantId } = scope;
  if (isMemory()) {
    const j = memoryJobs.get(id);
    if (!j || j.tenantId !== tenantId || !inProgram(j.programId, scope)) return false;
    memoryJobs.delete(id);
    for (const [sid, s] of memoryStaged) if (s.jobId === id) memoryStaged.delete(sid);
    return true;
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('DELETE FROM ssp_import_jobs WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)', [id, tenantId, scope.programId]);
    return (res.rowCount ?? 0) > 0; // staged_controls go with it (ON DELETE CASCADE)
  }, scope.programId);
}

// ------------------------------------------------------------------------------------------------ staged controls

/** Replaces the staged suggestions of a job (re-running an analysis starts from a clean slate). */
export async function replaceStaged(
  scope: ProgramScope,
  jobId: string,
  drafts: Array<StagedControlDraft & { baseHash: string | null }>
): Promise<void> {
  const { tenantId, programId } = scope;
  if (isMemory()) {
    for (const [sid, s] of memoryStaged) if (s.jobId === jobId) memoryStaged.delete(sid);
    for (const d of drafts) {
      const row: StagedControl = {
        ...d,
        id: newId('stg'),
        jobId,
        tenantId,
        programId,
        reviewState: 'PENDING',
        editedNotes: null,
        reviewedBy: null,
        reviewedAt: null,
        committedAt: null,
      };
      memoryStaged.set(row.id, row);
    }
    return;
  }
  await inTenantTx(tenantId, async (c) => {
    await c.query('DELETE FROM staged_controls WHERE job_id = $1 AND tenant_id = $2', [jobId, tenantId]);
    for (const d of drafts) {
      await c.query(
        `INSERT INTO staged_controls (id, tenant_id, job_id, control_id, framework, match_kind, origin, section_heading, suggested_notes,
                                      confidence, source_quotes, gap_analysis, base_hash, program_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`,
        [newId('stg'), tenantId, jobId, d.controlId, d.framework, d.matchKind, d.origin, d.sectionHeading, d.suggestedNotes, d.confidence,
         JSON.stringify(d.sourceQuotes), JSON.stringify(d.gapAnalysis), d.baseHash, programId]
      );
    }
  }, programId);
}

export async function listStaged(scope: ProgramScope, jobId: string): Promise<StagedControl[]> {
  const { tenantId } = scope;
  if (isMemory()) {
    return [...memoryStaged.values()]
      .filter((s) => s.tenantId === tenantId && s.jobId === jobId && inProgram(s.programId, scope))
      .sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }))
      .map((s) => ({ ...s }));
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('SELECT * FROM staged_controls WHERE job_id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL) ORDER BY control_id', [jobId, tenantId, scope.programId]);
    return res.rows.map(rowToStaged).sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));
  }, scope.programId);
}

export async function getStaged(scope: ProgramScope, jobId: string, id: string): Promise<StagedControl | null> {
  const { tenantId } = scope;
  if (isMemory()) {
    const s = memoryStaged.get(id);
    return s && s.tenantId === tenantId && s.jobId === jobId && inProgram(s.programId, scope) ? { ...s } : null;
  }
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query('SELECT * FROM staged_controls WHERE id = $1 AND job_id = $2 AND tenant_id = $3 AND (program_id = $4 OR program_id IS NULL)', [id, jobId, tenantId, scope.programId]);
    return res.rows[0] ? rowToStaged(res.rows[0]) : null;
  }, scope.programId);
}

export interface StagedPatch {
  reviewState?: SspReviewState;
  editedNotes?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  committedAt?: string | null;
  baseHash?: string | null;
}

export async function updateStaged(scope: ProgramScope, jobId: string, id: string, patch: StagedPatch): Promise<StagedControl | null> {
  const { tenantId } = scope;
  if (isMemory()) {
    const s = memoryStaged.get(id);
    if (!s || s.tenantId !== tenantId || s.jobId !== jobId || !inProgram(s.programId, scope)) return null;
    Object.assign(s, patch);
    return { ...s };
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown): void => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.reviewState !== undefined) add('review_state', patch.reviewState);
  if (patch.editedNotes !== undefined) add('edited_notes', patch.editedNotes);
  if (patch.reviewedBy !== undefined) add('reviewed_by', patch.reviewedBy);
  if (patch.reviewedAt !== undefined) add('reviewed_at', patch.reviewedAt);
  if (patch.committedAt !== undefined) add('committed_at', patch.committedAt);
  if (patch.baseHash !== undefined) add('base_hash', patch.baseHash);
  if (sets.length === 0) return getStaged(scope, jobId, id);
  vals.push(id, jobId, tenantId, scope.programId);
  return inTenantTx(tenantId, async (c) => {
    const res = await c.query(
      `UPDATE staged_controls SET ${sets.join(', ')} WHERE id = $${vals.length - 3} AND job_id = $${vals.length - 2} AND tenant_id = $${vals.length - 1} AND (program_id = $${vals.length} OR program_id IS NULL) RETURNING *`,
      vals as never[]
    );
    return res.rows[0] ? rowToStaged(res.rows[0]) : null;
  }, scope.programId);
}
