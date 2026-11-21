import { Router, Request, Response } from 'express';
import { buildProgramSummary } from '../programSummary';
import { membershipNowMs } from '../db';
import { errorMessage } from '../../src/utils/errors';

/**
 * GET /api/v1/program-summary (issues #251, #252). Mounted after authMiddleware and programContext: the program comes from x-program-id, every role
 * may read it and an archived program can be read. Counts, flags and dates only (no note, name or file name); Cache-Control: no-store. Nothing else
 * is served here (a write method finds no route).
 */
const router = Router();

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const summary = await buildProgramSummary(req.program!, new Date(membershipNowMs()));
    res.set('Cache-Control', 'no-store');
    res.json(summary);
  } catch (err: unknown) {
    // errorMessage only: a database error can carry a row's values
    console.error('[Program Summary API] Failed to build the summary:', errorMessage(err));
    res.status(500).json({ error: 'Failed to build the program summary' });
  }
});

export default router;
