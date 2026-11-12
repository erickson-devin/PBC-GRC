import { Router, Request, Response } from 'express';
import { isPlatformAdminUser } from '../auth/platformAdmin';
import { DEFAULT_SYSTEM_USE_NOTICE, SYSTEM_USE_NOTICE_MAX, getSystemUseNotice, saveSystemUseNotice, validateSystemUseNoticeInput, type StoredSystemUseNotice } from '../auth/systemUseNotice';
import { requireAdminStepUp } from './auth';

/**
 * The system use notice (issue #256), mounted at /api/v1/platform/system-use-notice behind authOnlyMiddleware. Platform administrators only.
 * GET   -> { enabled, text, version, updatedAt, updatedByUserId, defaultText, maxLength }
 * PUT   { enabled, text, code } -> the same shape. The body is checked first (400 invalid_request), then the administrator's step-up
 * code (requireAdminStepUp). The text is never logged.
 */
const router = Router();

const view = (n: StoredSystemUseNotice) => ({ ...n, defaultText: DEFAULT_SYSTEM_USE_NOTICE, maxLength: SYSTEM_USE_NOTICE_MAX });
const FORBIDDEN = { error: 'Forbidden: only a platform administrator can read or change the system use notice' };

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(view(await getSystemUseNotice()));
  } catch {
    console.error('[SystemUse] Reading the notice failed');
    res.status(500).json({ error: 'The system use notice could not be read' });
  }
});

router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const input = validateSystemUseNoticeInput(req.body);
    if (!input) {
      res.status(400).json({ error: `The notice needs a text of 1 to ${SYSTEM_USE_NOTICE_MAX} characters and an on or off setting`, reason: 'invalid_request' });
      return;
    }
    if (!(await requireAdminStepUp(req, res, 'system-use-notice'))) return;
    const saved = await saveSystemUseNotice(input, { id: req.user!.uid, email: req.user!.email });
    res.setHeader('Cache-Control', 'no-store');
    res.json(view(saved));
  } catch {
    console.error('[SystemUse] Saving the notice failed');
    res.status(500).json({ error: 'The system use notice could not be saved' });
  }
});

export default router;
