import { Router, Request, Response } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import { searchProgram } from '../search/searchStore';
import { normalizeQuery } from '../../src/data/search/searchMatch';
import { SEARCH_KINDS, SEARCH_PER_KIND_DEFAULT, SEARCH_PER_KIND_MAX, type SearchKind } from '../../src/types/search';
import { errorMessage } from '../../src/utils/errors';

/**
 * POST /api/v1/search (issue #254): the global search of the open program. Body { q, kinds?, perKind? }: `q` is 2 to 100 characters after trimming, with no
 * control character; `kinds` is a non-empty list of SEARCH_KINDS (default all); `perKind` a whole number from 1 to 25 (default 8). The query travels in the
 * body, never in a URL (a URL reaches access logs, browser history and referrers). Mounted after authMiddleware, searchRateLimiter and programReadContext:
 * the program comes from x-program-id, every role may search and an archived program can be searched (searching never writes). There is deliberately no
 * write guard here: nothing in this router changes data.
 *
 * 200 { programId, groups: [{ kind, results, truncated }] }; 400 invalid_query (the query is never echoed) or invalid_options; 429 from the limiter.
 * Every response carries Cache-Control: no-store. The query and the snippets are never logged: the log line holds the user, the program and a count.
 */
const router = Router();

/** 60 searches a minute per user and tenant (a person typing makes a few; a script is slowed). `reset()` is for tests. */
export const SEARCH_MAX_PER_MINUTE = 60;
export const searchRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: SEARCH_MAX_PER_MINUTE,
  key: (req) => `${req.tenantId ?? ''}:${req.user?.uid ?? req.ip ?? 'unknown'}`,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

router.post('/', async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  const body = isRecord(req.body) ? req.body : {};
  const parsed = normalizeQuery(body.q);
  if (!parsed.ok) {
    res.status(400).json({ error: 'The search text must be 2 to 100 characters', code: 'invalid_query' });
    return;
  }
  let kinds: SearchKind[] = [...SEARCH_KINDS];
  if (body.kinds !== undefined) {
    const list = body.kinds;
    if (!Array.isArray(list) || list.length < 1 || list.length > SEARCH_KINDS.length || !list.every((k) => typeof k === 'string' && (SEARCH_KINDS as readonly string[]).includes(k))) {
      res.status(400).json({ error: 'kinds is a list of result kinds', code: 'invalid_options', field: 'kinds' });
      return;
    }
    kinds = [...new Set(list as SearchKind[])];
  }
  let perKind = SEARCH_PER_KIND_DEFAULT;
  if (body.perKind !== undefined) {
    if (typeof body.perKind !== 'number' || !Number.isInteger(body.perKind) || body.perKind < 1 || body.perKind > SEARCH_PER_KIND_MAX) {
      res.status(400).json({ error: `perKind is a whole number from 1 to ${SEARCH_PER_KIND_MAX}`, code: 'invalid_options', field: 'perKind' });
      return;
    }
    perKind = body.perKind;
  }
  try {
    const result = await searchProgram(req.program!, req.tenantId!, parsed.q, { kinds, perKind });
    const count = result.groups.reduce((n, g) => n + g.results.length, 0);
    console.log(`[Search] ${req.user?.uid} searched program ${req.programId} (${count} results)`);
    res.json(result);
  } catch (err: unknown) {
    // errorMessage only: a database error can carry the row's values, and the query must never reach a log
    console.error('[Search] Failed to search the program:', errorMessage(err));
    res.status(500).json({ error: 'Failed to search the program' });
  }
});

export default router;
