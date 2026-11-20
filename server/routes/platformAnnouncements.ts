import { Router, Request, Response } from 'express';
import { isPlatformAdminUser } from '../auth/platformAdmin';
import { ANNOUNCEMENT_LIMITS, TooManyActiveError, listAllAnnouncements, postAnnouncement, validateAnnouncementInput, withdrawAnnouncement } from '../announcements';
import { requireAdminStepUp } from './auth';

/**
 * Platform announcements (issue #260), mounted at /api/v1/platform/announcements behind authOnlyMiddleware. Platform administrators only.
 * GET   -> { announcements: [...every one, withdrawn and expired included], limits }
 * POST  { title, body, severity?, expiresAt?, code } -> 201 { announcement }. The body is checked first (400 invalid_request with the
 *       field), then the administrator's step-up code (requireAdminStepUp); 409 too_many_active at 5 active.
 * POST /:id/withdraw { code } -> 200 { announcement }; 404 not_found; 409 already_withdrawn.
 * The title and body are never logged.
 */
const router = Router();

const FORBIDDEN = { error: 'Forbidden: only a platform administrator can manage announcements' };
const LIMITS = { titleMax: ANNOUNCEMENT_LIMITS.titleMax, bodyMax: ANNOUNCEMENT_LIMITS.bodyMax, maxActive: ANNOUNCEMENT_LIMITS.maxActive, maxExpiryDays: ANNOUNCEMENT_LIMITS.maxExpiryDays };

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ announcements: await listAllAnnouncements(), limits: LIMITS });
  } catch {
    console.error('[Announcements] Reading the announcements failed');
    res.status(500).json({ error: 'The announcements could not be read' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const checked = validateAnnouncementInput(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: `The announcement needs a one-line title of 1 to ${ANNOUNCEMENT_LIMITS.titleMax} characters and a text of 1 to ${ANNOUNCEMENT_LIMITS.bodyMax} characters`, reason: 'invalid_request', field: checked.field });
      return;
    }
    if (!(await requireAdminStepUp(req, res, 'announcement'))) return;
    const announcement = await postAnnouncement(checked.input, { id: req.user!.uid, email: req.user!.email });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ announcement });
  } catch (err: unknown) {
    if (err instanceof TooManyActiveError) {
      res.status(409).json({ error: `At most ${ANNOUNCEMENT_LIMITS.maxActive} announcements can be active. Withdraw one first.`, reason: 'too_many_active' });
      return;
    }
    console.error('[Announcements] Posting the announcement failed');
    res.status(500).json({ error: 'The announcement could not be posted' });
  }
});

router.post('/:id/withdraw', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    if (!(await requireAdminStepUp(req, res, 'announcement'))) return;
    const result = await withdrawAnnouncement(String(req.params.id), { id: req.user!.uid, email: req.user!.email });
    if (result === 'not_found') {
      res.status(404).json({ error: 'Announcement not found', reason: 'not_found' });
      return;
    }
    if (result === 'already_withdrawn') {
      res.status(409).json({ error: 'The announcement was already withdrawn', reason: 'already_withdrawn' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ announcement: result });
  } catch {
    console.error('[Announcements] Withdrawing the announcement failed');
    res.status(500).json({ error: 'The announcement could not be withdrawn' });
  }
});

export default router;
