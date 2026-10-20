import crypto from 'crypto';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { getTenantProgram } from '../db';
import { ensureFrameworkEnabled } from '../middleware/frameworkGuard';
import { ensureActiveTenant } from './tenantGuards';
import { commitReviewedSuggestions } from '../ssp/commit';
import { MAX_UPLOAD_BYTES, detectDocumentKind } from '../ssp/extract';
import { deleteUploadedPolicy, readUploadedPolicy, saveUploadedPolicy } from '../ssp/policyVault';
import { OllamaClient } from '../ssp/ollama';
import { ANALYZER_ID, aiAnalyzerId, cancelJob, enqueueImport, hashLiveControl, isJobActive, readLiveControls, recoverStaleJobs } from '../ssp/runner';
import { createJob, deleteJob, getJob, getStaged, listJobs, listStaged, newId, updateStaged } from '../ssp/store';
import {
  SSP_DEFAULT_BASELINE,
  SSP_BASELINES,
  SSP_IMPORT_FRAMEWORKS,
  isSspBaseline,
  SSP_JOB_TERMINAL,
  SSP_SETTABLE_STATES,
  isSspImportFramework,
  type SspReviewState,
} from '../ssp/types';
import { canRoleReviewSspImports, canRoleWrite } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';

/**
 * SSP import, mounted at /api/v1/tenants/:tenantId/ssp-imports AFTER requireWriteRole: uploading, reviewing and committing
 * are writes and so are limited to a Tenant Owner / MSP Admin. An Assessor can READ everything (jobs, suggestions, the
 * document) but cannot change or commit anything; a Viewer sees none of it (the document may contain CUI).
 */
const router = Router({ mergeParams: true });

const MAX_EDITED_NOTES = 20_000;
const MAX_CONCURRENT_UPLOADS = 4;
let uploadsInFlight = 0;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 8 } }).single('file');

/** Everything here needs the active tenant, and (for reading) a role that may see imports. */
function guard(req: Request, res: Response, next: NextFunction): void {
  if (!ensureActiveTenant(req, res)) return;
  if (!canRoleReviewSspImports(req.tenantRole)) {
    res.status(403).json({ error: 'Forbidden: your role cannot see SSP imports', role: req.tenantRole ?? null });
    return;
  }
  next();
}
router.use(guard);

const reviewerName = (req: Request): string => req.user?.name || req.user?.email || 'Compliance reviewer';

const cleanFileName = (name: string): string => path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 255) || 'document';

/** GET /capabilities: what this install can do and what the caller may do. */
router.get('/capabilities', async (req: Request, res: Response): Promise<void> => {
  const program = await getTenantProgram(req.tenantId!);
  const enabled = program?.enabledFrameworks ?? ['CMMC_L1'];
  const ai = await new OllamaClient().getStatus();
  const aiAvailable = ai.enabled && ai.reachable && ai.modelPresent;
  res.json({
    analyzer: ANALYZER_ID,
    /** The local language model can be used for an import right now. */
    ai: aiAvailable,
    aiStatus: { enabled: ai.enabled, available: aiAvailable, model: ai.model, ...(aiAvailable ? {} : { reason: ai.reason ?? 'The AI analysis is not available.' }) },
    maxUploadBytes: MAX_UPLOAD_BYTES,
    acceptedTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    frameworks: SSP_IMPORT_FRAMEWORKS.filter((f) => enabled.includes(f)),
    canUpload: canRoleWrite(req.tenantRole),
    canCommit: canRoleWrite(req.tenantRole),
  });
});

/** GET /: the tenant's imports, newest first. */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const jobs = await listJobs(req.tenantId!);
    recoverStaleJobs(jobs);
    res.json({ jobs });
  } catch (err: unknown) {
    console.error('[SSP Import] list failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to list SSP imports' });
  }
});

/**
 * POST /: upload a PDF or DOCX (multipart field "file") and the framework to map it to (field "framework": CMMC_L1 or
 * CMMC_L2, which must be part of the tenant's assessment program). Field "analysis" is "rules" (default) or "ai": with "ai"
 * the local model must be reachable and have its model installed, which is checked BEFORE the upload is accepted (409
 * ai_unavailable otherwise). Responds 202 with the job; the work happens in the background and the job is polled until
 * READY_FOR_REVIEW.
 */
router.post('/', (req: Request, res: Response): void => {
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
    res.status(429).json({ error: 'The server is busy receiving other uploads. Try again in a moment.' });
    return;
  }
  uploadsInFlight++;
  upload(req, res, async (uploadErr: unknown) => {
    try {
      if (uploadErr) {
        const code = (uploadErr as { code?: string }).code;
        if (code === 'LIMIT_FILE_SIZE') res.status(413).json({ error: `The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` });
        else res.status(400).json({ error: 'The upload could not be read. Send one file in the "file" field.' });
        return;
      }
      const tenantId = req.tenantId!;
      const file = req.file;
      const framework = req.body?.framework;
      if (!file || !file.buffer?.length) {
        res.status(400).json({ error: 'No file was uploaded (use the "file" field).' });
        return;
      }
      if (!isSspImportFramework(framework)) {
        res.status(400).json({ error: `framework is required and must be one of: ${SSP_IMPORT_FRAMEWORKS.join(', ')}` });
        return;
      }
      if (!(await ensureFrameworkEnabled(req, res, framework))) return;
      // NIST SP 800-53 only: the baseline the coverage is measured against (Moderate unless chosen)
      let baseline: (typeof SSP_BASELINES)[number] | null = null;
      if (framework === 'NIST_800_53_REV5') {
        const asked = req.body?.baseline ?? SSP_DEFAULT_BASELINE;
        if (!isSspBaseline(asked)) {
          res.status(400).json({ error: `baseline must be one of: ${SSP_BASELINES.join(', ')}` });
          return;
        }
        baseline = asked;
      }

      const analysis = req.body?.analysis ?? 'rules';
      if (analysis !== 'rules' && analysis !== 'ai') {
        res.status(400).json({ error: 'analysis must be "rules" or "ai"' });
        return;
      }
      const ollama = new OllamaClient();
      if (analysis === 'ai') {
        const status = await ollama.getStatus(true);
        if (!status.enabled || !status.reachable || !status.modelPresent) {
          res.status(409).json({ error: `The AI analysis is not available: ${status.reason ?? 'unknown reason'}`, code: 'ai_unavailable', reason: status.code });
          return;
        }
      }

      const running = (await listJobs(tenantId)).find((j) => !SSP_JOB_TERMINAL.includes(j.status) && isJobActive(j.id));
      if (running) {
        res.status(409).json({ error: 'Another import is still being processed. Wait for it to finish.', jobId: running.id });
        return;
      }

      // What the file is comes from its bytes, never from its name or the browser's Content-Type
      const detected = await detectDocumentKind(file.buffer);
      if (!detected) {
        res.status(415).json({ error: 'Only PDF and Word (.docx) documents can be imported.' });
        return;
      }

      const jobId = newId('sspj');
      const fileName = cleanFileName(file.originalname || 'document');
      const stored = await saveUploadedPolicy(tenantId, jobId, fileName, file.buffer);
      const job = await createJob({
        id: jobId,
        tenantId,
        createdBy: reviewerName(req),
        createdByUserId: req.user?.uid ?? null,
        fileName,
        mimeType: detected.mime,
        fileSize: file.size,
        fileSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
        framework,
        baseline,
        storedProvider: stored.provider,
        storedPath: stored.path,
        analyzer: analysis === 'ai' ? aiAnalyzerId(ollama.config.model) : ANALYZER_ID,
      });
      enqueueImport(tenantId, job.id);
      console.log(`[SSP Import] ${reviewerName(req)} uploaded "${fileName}" (${file.size} bytes) for ${framework} in ${tenantId}: job ${job.id}`);
      res.status(202).json({ job });
    } catch (err: unknown) {
      console.error('[SSP Import] upload failed:', errorMessage(err));
      if (!res.headersSent) res.status(500).json({ error: 'The upload could not be processed' });
    } finally {
      uploadsInFlight--;
    }
  });
});

/** POST /:jobId/cancel: stops an import that has not finished (a running AI analysis is aborted and nothing is staged). */
router.post('/:jobId/cancel', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const job = await getJob(tenantId, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  if (!(await cancelJob(tenantId, job.id))) {
    res.status(409).json({ error: 'This import has already finished.' });
    return;
  }
  console.log(`[SSP Import] ${reviewerName(req)} cancelled ${job.id}`);
  res.status(202).json({ job: await getJob(tenantId, job.id) });
});

/** GET /:jobId */
router.get('/:jobId', async (req: Request, res: Response): Promise<void> => {
  const job = await getJob(req.tenantId!, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  res.json({ job });
});

/** GET /:jobId/file: the document that was uploaded (kept in the evidence vault). */
router.get('/:jobId/file', async (req: Request, res: Response): Promise<void> => {
  const job = await getJob(req.tenantId!, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  try {
    const data = await readUploadedPolicy({ provider: job.storedProvider, path: job.storedPath });
    res.setHeader('Content-Type', job.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${job.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  } catch {
    res.status(404).json({ error: 'The stored document is no longer available' });
  }
});

/**
 * GET /:jobId/staged: the suggestions, each with the control's CURRENT answer next to it, and whether that answer changed
 * since the suggestion was staged.
 */
router.get('/:jobId/staged', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const job = await getJob(tenantId, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  try {
    const [staged, live] = await Promise.all([listStaged(tenantId, job.id), readLiveControls(tenantId)]);
    res.json({
      job,
      staged: staged.map((s) => {
        const current = live.get(s.controlId);
        return {
          ...s,
          current: current ? { status: current.status, notes: current.notes, updatedAt: current.updatedAt } : null,
          changedSinceStaged: hashLiveControl(current) !== s.baseHash,
        };
      }),
    });
  } catch (err: unknown) {
    console.error('[SSP Import] staged list failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to load the suggestions' });
  }
});

/**
 * PATCH /:jobId/staged/:id: record a review decision. Body: { reviewState: PENDING | ACCEPTED | EDITED | REJECTED,
 * editedNotes? }. Sending editedNotes with ACCEPTED makes it EDITED. Nothing is written to the controls here.
 */
router.patch('/:jobId/staged/:id', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const job = await getJob(tenantId, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  if (job.status !== 'READY_FOR_REVIEW') {
    res.status(409).json({ error: 'This import is not open for review.' });
    return;
  }
  const item = await getStaged(tenantId, job.id, String(req.params.id));
  if (!item) {
    res.status(404).json({ error: 'Suggestion not found' });
    return;
  }
  if (item.reviewState === 'COMMITTED') {
    res.status(409).json({ error: 'This suggestion has already been committed.' });
    return;
  }

  const { reviewState, editedNotes } = req.body ?? {};
  if (typeof reviewState !== 'string' || !(SSP_SETTABLE_STATES as readonly string[]).includes(reviewState)) {
    res.status(400).json({ error: `reviewState must be one of: ${SSP_SETTABLE_STATES.join(', ')}` });
    return;
  }
  if (editedNotes !== undefined && (typeof editedNotes !== 'string' || editedNotes.length > MAX_EDITED_NOTES)) {
    res.status(400).json({ error: `editedNotes must be text of at most ${MAX_EDITED_NOTES} characters` });
    return;
  }

  let state = reviewState as SspReviewState;
  let notes: string | null = item.editedNotes;
  if (typeof editedNotes === 'string') {
    notes = editedNotes;
    if (state === 'ACCEPTED' || state === 'EDITED') state = editedNotes.trim() === item.suggestedNotes.trim() ? 'ACCEPTED' : 'EDITED';
  }
  if (state === 'EDITED' && (notes ?? '').trim() === '') {
    res.status(400).json({ error: 'An edited suggestion needs text.' });
    return;
  }

  try {
    // Re-opening a conflicting suggestion compares it with the control as it is NOW
    let baseHash: string | null | undefined;
    if (item.reviewState === 'CONFLICT') baseHash = hashLiveControl((await readLiveControls(tenantId)).get(item.controlId));
    const updated = await updateStaged(tenantId, job.id, item.id, {
      reviewState: state,
      editedNotes: state === 'EDITED' ? notes : null,
      reviewedBy: state === 'PENDING' ? null : reviewerName(req),
      reviewedAt: state === 'PENDING' ? null : new Date().toISOString(),
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    res.json({ staged: updated });
  } catch (err: unknown) {
    console.error('[SSP Import] review update failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to save the decision' });
  }
});

/**
 * POST /:jobId/commit: apply the ACCEPTED and EDITED suggestions (optionally only `ids`) to the tenant's controls.
 * Responds with what was committed and which suggestions were skipped as conflicts.
 */
router.post('/:jobId/commit', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const job = await getJob(tenantId, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  if (job.status !== 'READY_FOR_REVIEW') {
    res.status(409).json({ error: 'This import is not open for review.' });
    return;
  }
  if (!(await ensureFrameworkEnabled(req, res, job.framework))) return;
  const ids = req.body?.ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((i: unknown) => typeof i !== 'string'))) {
    res.status(400).json({ error: 'ids must be a list of suggestion ids' });
    return;
  }
  try {
    const result = await commitReviewedSuggestions(tenantId, job, reviewerName(req), ids, req.user?.uid ?? null);
    res.json({ ...result, job: await getJob(tenantId, job.id) });
  } catch (err: unknown) {
    console.error('[SSP Import] commit failed:', errorMessage(err));
    res.status(500).json({ error: 'The commit failed part-way. Reload the import: what was already written is marked as committed.' });
  }
});

/** DELETE /:jobId: removes the import, its suggestions and the stored document. Committed control answers are not touched. */
router.delete('/:jobId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const job = await getJob(tenantId, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Import not found' });
    return;
  }
  if (isJobActive(job.id)) {
    res.status(409).json({ error: 'This import is still being processed.' });
    return;
  }
  await deleteJob(tenantId, job.id);
  await deleteUploadedPolicy({ provider: job.storedProvider, path: job.storedPath });
  res.status(204).end();
});

export default router;
