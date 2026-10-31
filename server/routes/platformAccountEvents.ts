import { Router, Request, Response } from 'express';
import { listAccountEvents } from '../auth/accountEvents';
import { isPlatformAdminUser } from '../auth/platformAdmin';

/**
 * The account event log (issue #40), mounted at /api/v1/platform/account-events behind authOnlyMiddleware. Read-only, platform
 * administrators only. Events hold ids and codes (never an email or a name); no step-up is needed for a read.
 * GET /?limit=<1..200, default 50>&before=<event id>: newest first; `nextBefore` is the id to pass as `before` for the next page.
 */
const router = Router();

const LIMIT_PATTERN = /^\d{1,3}$/;
const BEFORE_PATTERN = /^\d{1,18}$/;
const INVALID_QUERY = { error: 'Invalid query: limit must be 1 to 200 and before a numeric event id', reason: 'invalid_request' } as const;

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!(await isPlatformAdminUser(req.user))) {
      res.status(403).json({ error: 'Forbidden: only a platform administrator can read account events' });
      return;
    }
    const rawLimit = req.query.limit;
    const rawBefore = req.query.before;
    if ((rawLimit !== undefined && typeof rawLimit !== 'string') || (rawBefore !== undefined && typeof rawBefore !== 'string')) {
      res.status(400).json(INVALID_QUERY);
      return;
    }
    if (rawLimit !== undefined && !LIMIT_PATTERN.test(rawLimit)) {
      res.status(400).json(INVALID_QUERY);
      return;
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 200 || (rawBefore !== undefined && !BEFORE_PATTERN.test(rawBefore))) {
      res.status(400).json(INVALID_QUERY);
      return;
    }
    const events = await listAccountEvents({ limit, beforeId: rawBefore ?? null });
    res.json({ events, nextBefore: events.length === limit ? events[events.length - 1].id : null });
  } catch {
    console.error('[AccountEvents] Listing failed');
    res.status(500).json({ error: 'Listing account events failed' });
  }
});

export default router;
