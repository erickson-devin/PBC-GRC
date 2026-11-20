import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { createRateLimiter } from '../middleware/rateLimit';
import { COPY_STATUS, CopyError, commitCopy, copySuggestions, previewCopy } from '../frameworkCopy/runner';
import { listRuns } from '../frameworkCopy/store';
import type { InventoryActor } from '../inventory/events';
import type { FrameworkCopyInclude } from '../../src/types/frameworkCopy';
import { errorMessage } from '../../src/utils/errors';

/**
 * "Copy from Rev. 2" (#255): appends the content of a CMMC Level 2 / Level 1 program of the tenant to the active NIST SP 800-171 Rev. 3 program. Mounted at
 * /api/v1/framework-copy after authMiddleware and programContext: the TARGET is the program of x-program-id (an archived one answers 409 program_archived
 * to the POSTs). Write roles may preview and commit (requireWriteRole); every role may read the runs and the suggestions.
 *
 *   POST /preview      { sourceProgramId, include? }                  -> FrameworkCopyPreview (writes nothing; ids, counts and lengths only)
 *   POST /commit       { sourceProgramId, include?, planDigest }      -> { runId, summary }
 *   GET  /runs                                                       -> { runs }
 *   GET  /suggestions                                                -> FrameworkCopySuggestions (computed on request, never stored or written)
 *
 * Errors carry `code` and `reason` with the same value (the client reads either): 400 invalid_request | invalid_copy_target | invalid_copy_source,
 * 403 framework_not_enabled, 404 program_not_found, 409 copy_plan_stale { planDigest } | copy_in_progress, 413 copy_too_large, 429 from the limiter.
 * Logs, errors and responses never carry a note, a narrative or a file name: the log lines hold the user, the program ids and counts.
 */
const router = Router();
router.use(requireWriteRole);

/** 60 previews and commits a minute per user and tenant: a preview reads the evidence files of the source program. */
const copyLimiter = createRateLimiter({ windowMs: 60_000, max: 60, key: (req) => `${req.tenantId ?? ''}:${req.user?.uid ?? req.ip ?? 'unknown'}` });

const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const INCLUDE_KEYS: (keyof FrameworkCopyInclude)[] = ['notes', 'objectives', 'evidence', 'tools', 'documents'];

/** The error body of this router: `code` and `reason` carry the same value. */
function refuse(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error, code, reason: code, ...extra });
}

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof CopyError) {
    refuse(res, COPY_STATUS[err.code] ?? 400, err.code, err.message, err.details ?? {});
    return;
  }
  // errorMessage only: a database or file error can carry the row's values or a path
  console.error('[Framework Copy API]', fallback, errorMessage(err));
  refuse(res, 500, 'copy_failed', fallback);
}

/** The body's `include`: an object of booleans for the five known keys (missing = included), else null. */
function parseInclude(raw: unknown): { ok: true; include: Partial<FrameworkCopyInclude> | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, include: undefined };
  if (!isRecord(raw)) return { ok: false };
  const include: Partial<FrameworkCopyInclude> = {};
  for (const key of Object.keys(raw)) {
    if (!INCLUDE_KEYS.includes(key as keyof FrameworkCopyInclude) || typeof raw[key] !== 'boolean') return { ok: false };
    include[key as keyof FrameworkCopyInclude] = raw[key] as boolean;
  }
  return { ok: true, include };
}

router.post('/preview', copyLimiter, async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  const body = isRecord(req.body) ? req.body : {};
  const include = parseInclude(body.include);
  if (!include.ok) return refuse(res, 400, 'invalid_request', 'include is an object of booleans (notes, objectives, evidence, tools, documents)');
  try {
    res.json(await previewCopy(req.program!, body.sourceProgramId, include.include));
  } catch (err) {
    sendError(res, err, 'Failed to preview the copy');
  }
});

router.post('/commit', copyLimiter, async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  const body = isRecord(req.body) ? req.body : {};
  const include = parseInclude(body.include);
  if (!include.ok) return refuse(res, 400, 'invalid_request', 'include is an object of booleans (notes, objectives, evidence, tools, documents)');
  if (typeof body.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.planDigest)) return refuse(res, 400, 'invalid_request', 'planDigest is the digest the preview returned');
  try {
    const result = await commitCopy(req.program!, body.sourceProgramId, include.include, body.planDigest, actorOf(req));
    const s = result.summary;
    console.log(`[Framework Copy API] ${req.user?.uid} ran copy ${result.runId} into program ${req.programId} of ${req.tenantId}: ${s.notesAppended} notes, ${s.objectivesAppended} objectives, ${s.evidenceCopied} files, ${s.toolLinksAdded} tool links, ${s.documentLinksAdded} document links`);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Failed to copy');
  }
});

router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  try {
    const scope: ProgramScope = { tenantId: req.tenantId!, programId: req.programId! };
    res.json({ runs: await listRuns(scope) });
  } catch (err) {
    sendError(res, err, 'Failed to read the copy runs');
  }
});

router.get('/suggestions', async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await copySuggestions(req.program!));
  } catch (err) {
    sendError(res, err, 'Failed to read the suggestions');
  }
});

export default router;
