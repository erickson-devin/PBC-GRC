import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { listControlPoamEvents, readControlPoam, writeControlPoam } from '../controlPoam';
import { StaleWriteError } from '../controlAssessments';
import { CONTROL_POAM_CONTROL_ID_PATTERN, parseControlPoamPatch } from '../../src/data/controlPoamEdit';
import { PoamMilestoneError } from '../../src/data/poamMilestones';
import { ensureControlInFrameworkPolicy } from '../middleware/frameworkGuard';
import { requireWriteRole } from '../middleware/roleGuard';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may GET but never PATCH: requireWriteRole lets GET through for every role.
router.use(requireWriteRole);

/** The tenant and program of the request (set by authMiddleware and the programContext middleware that is mounted before this router). */
const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });

function fail(res: Response, req: Request, what: string, err: unknown): void {
  // errorMessage only: a database error can carry the row's values, and the owner, resources, plan and milestones may be CUI
  console.error(`[Control POA&M API] Error ${what} for tenant ${req.tenantId}:`, errorMessage(err));
  res.status(500).json({ error: `Failed ${what}` });
}

/** GET /api/v1/control-poam -> { entries }: the POA&M fields recorded for the program's controls (only controls with a stored entry), by control id. Every role may read. */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ entries: await readControlPoam(scopeOf(req)) });
  } catch (err: unknown) {
    fail(res, req, 'reading the control POA&M', err);
  }
});

/**
 * PATCH /api/v1/control-poam/:controlId (owner / admin, by requireWriteRole)
 * Body { expectedUpdatedAt, owner?, scheduledCompletion?, requiredResources?, plan?, milestones? } (parseControlPoamPatch): expectedUpdatedAt is required (the
 * entry's updatedAt as loaded; null = no entry yet). 200 { entry, changed } (a body that alters nothing: changed false, no event, the stamp stays; entry
 * is null when the control has none). 400 invalid_control_poam_patch with `field` (never the value; `milestones` also for an id the entry does not hold),
 * 403 framework_not_enabled, 404 for a malformed control id, 409 stale_write (with the current stamp and writer) / program_archived / program_required.
 * Allowed whatever the control's status. The log carries ids only; the history holds flags, lengths, counts and digests, never the text.
 */
router.patch('/:controlId', async (req: Request, res: Response): Promise<void> => {
  const controlId = String(req.params.controlId);
  if (!CONTROL_POAM_CONTROL_ID_PATTERN.test(controlId)) {
    res.status(404).json({ error: 'Control not found' });
    return;
  }
  const parsed = parseControlPoamPatch(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: 'Invalid ' + parsed.field, code: 'invalid_control_poam_patch', field: parsed.field });
    return;
  }
  if (!(await ensureControlInFrameworkPolicy(req, res, controlId))) return;
  try {
    const user = req.user!;
    const result = await writeControlPoam(
      scopeOf(req),
      controlId,
      parsed.patch,
      { actor: user.name || user.email || user.uid || 'Compliance Assessor', userId: user.uid ?? null },
      { expectedUpdatedAt: parsed.expectedUpdatedAt }
    );
    if (result.changed) console.log('[Control POA&M API] ' + user.uid + ' updated the POA&M entry of ' + controlId + ' in ' + req.tenantId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof StaleWriteError) {
      res.status(409).json({ error: 'This POA&M entry was saved by someone else after you loaded it.', code: 'stale_write', current: err.current });
      return;
    }
    if (err instanceof PoamMilestoneError) {
      res.status(400).json({ error: 'Invalid milestones', code: 'invalid_control_poam_patch', field: 'milestones' });
      return;
    }
    fail(res, req, 'saving the control POA&M', err);
  }
});

/** GET /api/v1/control-poam/:controlId/events -> { events }: the control's history, newest first, at most 100 (every role). Never the text. 404 for a malformed control id. */
router.get('/:controlId/events', async (req: Request, res: Response): Promise<void> => {
  const controlId = String(req.params.controlId);
  if (!CONTROL_POAM_CONTROL_ID_PATTERN.test(controlId)) {
    res.status(404).json({ error: 'Control not found' });
    return;
  }
  try {
    res.json({ events: await listControlPoamEvents(scopeOf(req), controlId, 100) });
  } catch (err: unknown) {
    fail(res, req, 'listing the control POA&M history', err);
  }
});

export default router;
