import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { readSspMetadata, writeSspMetadata } from '../sspMetadata';
import { readSspProfile, writeSspProfile } from '../sspProfile';
import { readSspReviews, signOffSection, SectionChangedError } from '../sspReviews';
import { SSP_SIGNABLE_SECTION_IDS, type SspSectionId } from '../../src/data/ssp/sspSections';
import { validateSspProfile } from '../../src/types/sspProfile';
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

/** GET /api/v1/ssp-metadata/profile -> { profile, updatedAt, updatedBy }: the program's structured SSP fields (profile is null until the first save). Every role may read. */
router.get('/profile', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readSspProfile(scopeOf(req)));
  } catch (err: unknown) {
    fail(res, req, 'reading the SSP profile', err);
  }
});

/**
 * PUT /api/v1/ssp-metadata/profile
 * Body { profile, expectedUpdatedAt }: profile replaces the program's structured SSP fields; expectedUpdatedAt is required (the updatedAt the client
 * loaded; null = no row yet) and makes the write fail with 409 stale_write when the row changed since. Nothing is written, and no history event
 * recorded, when nothing differs. A 400 names the path, a 409 carries only the stamp and writer, never any value.
 */
router.put('/profile', async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};
  const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!expected.ok || expected.value === undefined) {
    res.status(400).json({ error: 'expectedUpdatedAt must be a timestamp or null', code: 'invalid_expected_updated_at' });
    return;
  }
  const checked = validateSspProfile(body.profile);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error, code: 'invalid_ssp_profile' });
    return;
  }
  try {
    const { record, changed } = await writeSspProfile(scopeOf(req), checked.value, actorOf(req), { expectedUpdatedAt: expected.value });
    res.json({ ...record, changed });
  } catch (err: unknown) {
    if (err instanceof StaleWriteError) {
      res.status(409).json({ error: 'The SSP profile was saved by someone else after you loaded it.', code: 'stale_write', current: err.current });
      return;
    }
    fail(res, req, 'saving the SSP profile', err);
  }
});

/** GET /api/v1/ssp-metadata/reviews -> { sections, history }: each signable section's server-computed currentDigest, newest sign-off and reviewed flag, and the sign-off history (newest first, at most 200). Every role may read. */
router.get('/reviews', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readSspReviews(scopeOf(req)));
  } catch (err: unknown) {
    fail(res, req, 'reading the SSP reviews', err);
  }
});

/**
 * POST /api/v1/ssp-metadata/reviews
 * Body { sectionId, expectedDigest }: signs off a section's saved content. The reviewer (user id, name, role, time) is the signed-in user: any other body
 * field is ignored. 409 section_changed (with the current digest, nothing written) when the section's content is no longer the one the caller saw.
 * 201 with the new review; 200 changed false when the same user already signed this same digest as the newest sign-off.
 */
router.post('/reviews', async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};
  const sectionId = typeof body.sectionId === 'string' && (SSP_SIGNABLE_SECTION_IDS as readonly string[]).includes(body.sectionId) ? (body.sectionId as SspSectionId) : null;
  if (!sectionId) {
    res.status(400).json({ error: 'sectionId is not a section that can be signed off', code: 'invalid_section' });
    return;
  }
  if (typeof body.expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedDigest)) {
    res.status(400).json({ error: 'expectedDigest must be a 64-character lowercase hex SHA-256', code: 'invalid_expected_digest' });
    return;
  }
  const uid = req.user?.uid;
  if (!uid) {
    res.status(403).json({ error: 'The reviewer could not be identified', code: 'reviewer_unknown' });
    return;
  }
  try {
    const result = await signOffSection(scopeOf(req), sectionId, body.expectedDigest, {
      userId: uid,
      name: req.user?.name || req.user?.email || uid,
      role: String(req.tenantRole ?? 'UNKNOWN'),
    });
    res.status(result.changed ? 201 : 200).json(result);
  } catch (err: unknown) {
    if (err instanceof SectionChangedError) {
      res.status(409).json({ error: 'This section changed since it loaded.', code: 'section_changed', currentDigest: err.currentDigest });
      return;
    }
    fail(res, req, 'signing off the SSP section', err);
  }
});

export default router;
