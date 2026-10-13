import crypto from 'crypto';
import { queryWithTenant } from '../db';
import { errorMessage } from '../../src/utils/errors';
import { chunkDocument } from './chunk';
import { ANALYZER_ID, mapDocumentToControls } from './controlMapper';
import { ExtractionError, detectDocumentKind, extractDocument } from './extract';
import { readUploadedPolicy } from './policyVault';
import { getJob, replaceStaged, updateJob } from './store';
import { SSP_JOB_TERMINAL, type SspImportJob } from './types';

/**
 * Runs import jobs: read the stored document, extract its text (in a worker thread), chunk it, map it to controls, and
 * write the suggestions to the staging tables. Jobs run one at a time. This module never writes control_assessments.
 */

export { ANALYZER_ID };

export interface LiveControl {
  status: string;
  notes: string;
  role: string;
  updatedAt: string | null;
}

/** The tenant's current control answers, by control id. */
export async function readLiveControls(tenantId: string): Promise<Map<string, LiveControl>> {
  const res = await queryWithTenant(tenantId, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [tenantId]);
  const map = new Map<string, LiveControl>();
  for (const row of res.rows) {
    if (row.tenant_id !== tenantId) continue; // defence in depth: the store already filters by tenant
    map.set(String(row.control_id), {
      status: row.status || 'NOT_STARTED',
      notes: row.implementation_notes || '',
      role: row.responsible_role || 'IT / Security Lead',
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    });
  }
  return map;
}

/**
 * Fingerprint of a control's live answer. A staged suggestion is only committed while this is unchanged.
 * A control with no answer yet and one holding the empty default (NOT_STARTED, no notes: GET /controls creates those for
 * CMMC L1) are the same thing, so merely opening the controls page never counts as a change.
 */
export const hashLiveControl = (c: Pick<LiveControl, 'status' | 'notes'> | undefined | null): string | null =>
  !c || (c.notes === '' && c.status === 'NOT_STARTED') ? null : crypto.createHash('sha256').update(`${c.notes}\u0000${c.status}`).digest('hex');

// ------------------------------------------------------------------------------------------------ queue

const active = new Set<string>();
let chain: Promise<void> = Promise.resolve();
const STALE_AFTER_MS = 2 * 60 * 1000;

export const isJobActive = (jobId: string): boolean => active.has(jobId);

export function enqueueImport(tenantId: string, jobId: string): void {
  if (active.has(jobId)) return;
  active.add(jobId);
  chain = chain.then(() => processJob(tenantId, jobId)).catch(() => undefined).finally(() => active.delete(jobId));
}

/**
 * A job still unfinished with no worker for it (the server restarted while it ran) is started again: its document is still
 * in the vault. Called lazily when a tenant's jobs are listed, because on PostgreSQL a job can only be read in its
 * tenant's context.
 */
export function recoverStaleJobs(jobs: SspImportJob[]): void {
  const now = Date.now();
  for (const j of jobs) {
    if (SSP_JOB_TERMINAL.includes(j.status) || active.has(j.id)) continue;
    const since = new Date(j.startedAt ?? j.createdAt).getTime();
    if (now - since > STALE_AFTER_MS) enqueueImport(j.tenantId, j.id);
  }
}

// ------------------------------------------------------------------------------------------------ the job

async function fail(tenantId: string, jobId: string, message: string): Promise<void> {
  await updateJob(tenantId, jobId, { status: 'FAILED', error: message, finishedAt: new Date().toISOString() }).catch(() => undefined);
}

async function processJob(tenantId: string, jobId: string): Promise<void> {
  try {
    const job = await getJob(tenantId, jobId);
    if (!job || SSP_JOB_TERMINAL.includes(job.status)) return;

    await updateJob(tenantId, jobId, { status: 'EXTRACTING', startedAt: new Date().toISOString(), error: null, stageProgress: { stage: 'Reading the document' } });
    const buffer = await readUploadedPolicy({ provider: job.storedProvider, path: job.storedPath });
    const detected = await detectDocumentKind(buffer);
    if (!detected) {
      await fail(tenantId, jobId, 'The stored file is not a PDF or Word (.docx) document.');
      return;
    }
    const doc = await extractDocument(buffer, detected.kind);

    await updateJob(tenantId, jobId, { status: 'ANALYZING', stageProgress: { stage: 'Mapping to controls' }, pageCount: doc.pageCount || null, charCount: doc.text.length });
    const chunks = chunkDocument(doc.text, doc.pages);
    const mapping = mapDocumentToControls(doc.text, doc.pages, job.framework, chunks);

    // Remember what each control looks like NOW, so the commit can tell if it changed while this was being reviewed
    const live = await readLiveControls(tenantId);
    await replaceStaged(tenantId, jobId, mapping.staged.map((s) => ({ ...s, baseHash: hashLiveControl(live.get(s.controlId)) })));

    await updateJob(tenantId, jobId, {
      status: 'READY_FOR_REVIEW',
      stageProgress: { chunksTotal: chunks.length, controlsFound: mapping.staged.length },
      chunkCount: chunks.length,
      coverage: mapping.coverage,
      unmapped: mapping.unmapped,
      finishedAt: new Date().toISOString(),
    });
    console.log(`[SSP Import] ${jobId}: ${mapping.staged.length}/${mapping.coverage.totalControls} ${job.framework} controls found in ${chunks.length} sections`);
  } catch (err: unknown) {
    const message = err instanceof ExtractionError ? err.message : 'The import failed unexpectedly. Check the server log and try again.';
    if (!(err instanceof ExtractionError)) console.error(`[SSP Import] ${jobId} failed:`, errorMessage(err));
    await fail(tenantId, jobId, message);
  }
}
