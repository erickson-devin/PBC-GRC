import crypto from 'crypto';
import type { ProgramScope } from '../db';
import { readControlAssessments } from '../controlAssessments';
import { errorMessage } from '../../src/utils/errors';
import { analyzeDocumentWithAi } from './analyze';
import { chunkDocument } from './chunk';
import { ANALYZER_ID, mapDocumentToControls } from './controlMapper';
import { ExtractionError, detectDocumentKind, extractDocument } from './extract';
import { OllamaClient, OllamaError } from './ollama';
import { readUploadedPolicy } from './policyVault';
import { getJob, replaceStaged, updateJob } from './store';
import { SSP_JOB_TERMINAL, type MappingResult, type SspImportJob } from './types';

/**
 * Runs import jobs: read the stored document, extract its text (in a child process), chunk it, map it to controls by rules,
 * optionally let the local language model read it as well, and write the suggestions to the staging tables. Jobs run one at
 * a time and can be cancelled. This module never writes control_assessments.
 */

export { ANALYZER_ID };

/** Analyzer id of a job that asks for the AI analysis: "ollama:<model>". */
export const aiAnalyzerId = (model: string): string => `ollama:${model}`;
export const wantsAi = (job: Pick<SspImportJob, 'analyzer'>): boolean => job.analyzer.startsWith('ollama:');

export interface LiveControl {
  status: string;
  notes: string;
  role: string;
  updatedAt: string | null;
}

/** The program's current control answers, by control id. */
export async function readLiveControls(scope: ProgramScope): Promise<Map<string, LiveControl>> {
  const map = new Map<string, LiveControl>();
  for (const [controlId, a] of await readControlAssessments(scope)) {
    map.set(controlId, { status: a.status, notes: a.notes, role: a.role, updatedAt: a.updatedAt });
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
const controllers = new Map<string, AbortController>();
let chain: Promise<void> = Promise.resolve();
const STALE_AFTER_MS = 2 * 60 * 1000;

export const isJobActive = (jobId: string): boolean => active.has(jobId);

export function enqueueImport(tenantId: string, programId: string, jobId: string): void {
  if (active.has(jobId)) return;
  active.add(jobId);
  controllers.set(jobId, new AbortController());
  chain = chain
    .then(() => processJob({ tenantId, programId }, jobId))
    .catch(() => undefined)
    .finally(() => {
      active.delete(jobId);
      controllers.delete(jobId);
    });
}

/**
 * Stops a job that has not finished. One that is running is told to stop (the request to the model is aborted and nothing is
 * staged); one that is still waiting is simply marked cancelled. Returns false when there was nothing to cancel.
 */
export async function cancelJob(scope: ProgramScope, jobId: string): Promise<boolean> {
  const { tenantId } = scope;
  const job = await getJob(scope, jobId);
  if (!job || SSP_JOB_TERMINAL.includes(job.status)) return false;
  controllers.get(jobId)?.abort();
  // The running worker records CANCELLED itself; a job nobody is working on is closed here
  if (!active.has(jobId)) await updateJob(tenantId, jobId, { status: 'CANCELLED', error: 'Cancelled.', finishedAt: new Date().toISOString() });
  return true;
}

/**
 * A job still unfinished with no worker for it (the server restarted while it ran) is started again: its document is still
 * in the vault. Called lazily when a tenant's jobs are listed, because on PostgreSQL a job can only be read in its
 * tenant's context.
 */
export function recoverStaleJobs(jobs: SspImportJob[], scope: ProgramScope): void {
  const now = Date.now();
  for (const j of jobs) {
    if (SSP_JOB_TERMINAL.includes(j.status) || active.has(j.id)) continue;
    const since = new Date(j.startedAt ?? j.createdAt).getTime();
    if (now - since > STALE_AFTER_MS) enqueueImport(j.tenantId, j.programId ?? scope.programId, j.id);
  }
}

// ------------------------------------------------------------------------------------------------ the job

async function fail(tenantId: string, jobId: string, message: string): Promise<void> {
  await updateJob(tenantId, jobId, { status: 'FAILED', error: message, finishedAt: new Date().toISOString() }).catch(() => undefined);
}

const aiOptions = () => ({
  maxSections: Math.max(1, Number.parseInt(process.env.SSP_AI_MAX_SECTIONS ?? '', 10) || 150),
  gapAnalysis: !['0', 'false', 'no', 'off'].includes((process.env.SSP_AI_GAP_ANALYSIS ?? 'true').trim().toLowerCase()),
});

async function processJob(scope: ProgramScope, jobId: string): Promise<void> {
  const { tenantId } = scope;
  const signal = controllers.get(jobId)?.signal;
  try {
    const job = await getJob(scope, jobId);
    if (!job || SSP_JOB_TERMINAL.includes(job.status)) return;

    await updateJob(tenantId, jobId, { status: 'EXTRACTING', startedAt: new Date().toISOString(), error: null, stageProgress: { stage: 'Reading the document' } });
    const buffer = await readUploadedPolicy({ provider: job.storedProvider, path: job.storedPath });
    const detected = await detectDocumentKind(buffer);
    if (!detected) {
      await fail(tenantId, jobId, 'The stored file is not a PDF or Word (.docx) document.');
      return;
    }
    const doc = await extractDocument(buffer, detected.kind);
    if (signal?.aborted) throw new OllamaError('cancelled', 'Cancelled.');

    await updateJob(tenantId, jobId, { status: 'ANALYZING', stageProgress: { stage: 'Mapping to controls' }, pageCount: doc.pageCount || null, charCount: doc.text.length });
    const chunks = chunkDocument(doc.text, doc.pages, { refStyle: job.framework === 'NIST_800_53_REV5' ? 'nist53' : 'cmmc' });
    const rules = mapDocumentToControls(doc.text, doc.pages, job.framework, chunks, job.baseline);

    // ---- the local language model, if the job asked for it
    let mapping: MappingResult = rules;
    let analyzer = job.analyzer;
    let progress: SspImportJob['stageProgress'] = { chunksTotal: chunks.length, controlsFound: rules.staged.length };
    if (wantsAi(job)) {
      const client = new OllamaClient();
      try {
        await client.ensureReady(); // checked again here: the model may have gone away since the upload
        const result = await analyzeDocumentWithAi({
          text: doc.text,
          pages: doc.pages,
          framework: job.framework,
          baseline: job.baseline,
          client,
          rules,
          signal,
          options: aiOptions(),
          onProgress: (p) => updateJob(tenantId, jobId, { stageProgress: p }).then(() => undefined, () => undefined), // awaited, so a late progress write can never overwrite the final state
        });
        mapping = result.mapping;
        progress = { chunksTotal: result.stats.sectionsAnalyzed + result.stats.sectionsFailed, controlsFound: mapping.staged.length, ai: result.stats, ...(result.warnings.length ? { warning: result.warnings.join(' ') } : {}) };
      } catch (err: unknown) {
        if (err instanceof OllamaError && err.code === 'cancelled') throw err;
        // The AI analysis could not be completed: the rule-based result is still worth having, and the reviewer is told why
        const reason = err instanceof OllamaError ? err.message : 'It failed unexpectedly.';
        console.warn(`[SSP Import] ${jobId}: AI analysis not used: ${errorMessage(err)}`);
        analyzer = ANALYZER_ID;
        progress = { ...progress, warning: `The AI analysis could not be completed (${reason}) so these are the rule-based results.` };
      }
    }

    // Remember what each control looks like NOW, so the commit can tell if it changed while this was being reviewed
    const live = await readLiveControls(scope);
    await replaceStaged(scope, jobId, mapping.staged.map((s) => ({ ...s, baseHash: hashLiveControl(live.get(s.controlId)) })));

    await updateJob(tenantId, jobId, {
      status: 'READY_FOR_REVIEW',
      analyzer,
      stageProgress: progress,
      chunkCount: chunks.length,
      coverage: mapping.coverage,
      unmapped: mapping.unmapped,
      finishedAt: new Date().toISOString(),
    });
    console.log(`[SSP Import] ${jobId}: ${mapping.staged.length}/${mapping.coverage.totalControls} ${job.framework} controls found in ${chunks.length} sections (${analyzer})`);
  } catch (err: unknown) {
    if (err instanceof OllamaError && err.code === 'cancelled') {
      await updateJob(tenantId, jobId, { status: 'CANCELLED', error: 'Cancelled.', finishedAt: new Date().toISOString() }).catch(() => undefined);
      return;
    }
    const message = err instanceof ExtractionError ? err.message : 'The import failed unexpectedly. Check the server log and try again.';
    if (!(err instanceof ExtractionError)) console.error(`[SSP Import] ${jobId} failed:`, errorMessage(err));
    await fail(tenantId, jobId, message);
  }
}
