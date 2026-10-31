import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { readSspMetadata, writeSspMetadata } from '../sspMetadata';
import { parseExpectedUpdatedAt, StaleWriteError } from '../controlAssessments';
import { requireWriteRole } from '../middleware/roleGuard';
import type { ProgramActor } from '../programs';
import { validateSspMetadata } from '../../src/types/sspMetadata';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may GET but never PUT: requireWriteRole lets GET through for every role.
router.use(requireWriteRole);

/** The tenant and program of the request (set by authMiddleware and the programContext middleware that is mounted before this router). */
const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });

/** The signed-in user, as recorded in the history: never a name taken from the request body. */
const actorOf = (req: Request): ProgramActor => ({
  actor: req.user?.name || req.user?.email || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function fail(res: Response, req: Request, what: string, err: unknown): void {
  // errorMessage only: a database error can carry the row's values, and the SSP text may be CUI
  console.error(`[SSP Metadata API] Error ${what} for tenant ${req.tenantId}:`, errorMessage(err));
  res.status(500).json({ error: `Failed ${what}` });
}

/** GET /api/v1/ssp-metadata -> { metadata, updatedAt, updatedBy }: the program's SSP text fields (metadata is null until the first save). Every role may read. */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readSspMetadata(scopeOf(req)));
  } catch (err: unknown) {
    fail(res, req, 'reading the SSP metadata', err);
  }
});

/**
 * PUT /api/v1/ssp-metadata
 * Body { metadata, expectedUpdatedAt }: metadata replaces the program's SSP text fields (only the known string fields); expectedUpdatedAt is required
 * (the updatedAt the client loaded; null = no row yet) and makes the write fail with 409 stale_write when the row changed since. Nothing is written,
 * and no history event recorded, when nothing differs. A 400 names the field, a 409 carries only the stamp and writer, never any text.
 */
router.put('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};
  const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!expected.ok || expected.value === undefined) {
    res.status(400).json({ error: 'expectedUpdatedAt must be a timestamp or null', code: 'invalid_expected_updated_at' });
    return;
  }
  const checked = validateSspMetadata(body.metadata);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error, code: 'invalid_ssp_metadata' });
    return;
  }
  try {
    const { record, changed } = await writeSspMetadata(scopeOf(req), checked.value, actorOf(req), { expectedUpdatedAt: expected.value });
    res.json({ ...record, changed });
  } catch (err: unknown) {
    if (err instanceof StaleWriteError) {
      res.status(409).json({ error: 'The SSP metadata was saved by someone else after you loaded it.', code: 'stale_write', current: err.current });
      return;
    }
    fail(res, req, 'saving the SSP metadata', err);
  }
});

export default router;
