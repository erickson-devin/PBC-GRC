import { Router, Request, Response } from 'express';
import releaseNotesFile from '../../src/data/releaseNotes/releaseNotes.json';
import { parseReleaseNotes, releaseVersions } from '../../src/data/releaseNotes/releaseNotes';
import { listVisibleAnnouncements } from '../announcements';
import { NOTICE_KINDS, NOTICE_REF_PATTERN, listReads, markRead, type NoticeKind } from '../noticeReads';
import { APP_VERSION } from '../version';

/**
 * What's new (issue #260), mounted at /api/v1/me/notices behind authOnlyMiddleware: any signed-in user, no tenant needed. Read state is
 * per user. The release notes ship inside the image (src/data/releaseNotes/releaseNotes.json, imported here); nothing is fetched.
 * GET   -> { currentVersion, notesAvailable, releaseReads: string[], announcements: [{ id, title, body, severity, createdAt, expiresAt, read }] }
 * POST /read { kind: 'release' | 'announcement', ref } -> 204. 400 invalid_request; 404 not_found (a version without notes, or an
 * announcement that is not visible now). Text is returned as plain text; the client never renders it as HTML.
 */
const router = Router();

const NOTE_VERSIONS = releaseVersions(parseReleaseNotes(releaseNotesFile));

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.uid;
    const [visible, reads] = await Promise.all([listVisibleAnnouncements(), listReads(userId)]);
    const readIds = new Set(reads.announcements);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      currentVersion: APP_VERSION,
      notesAvailable: NOTE_VERSIONS.includes(APP_VERSION),
      releaseReads: reads.releases,
      announcements: visible.map((a) => ({ id: a.id, title: a.title, body: a.body, severity: a.severity, createdAt: a.createdAt, expiresAt: a.expiresAt, read: readIds.has(a.id) })),
    });
  } catch {
    console.error('[Notices] Reading the notices failed');
    res.status(500).json({ error: 'The notices could not be read' });
  }
});

router.post('/read', async (req: Request, res: Response): Promise<void> => {
  const { kind, ref } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof kind !== 'string' || !NOTICE_KINDS.includes(kind as NoticeKind) || typeof ref !== 'string' || !NOTICE_REF_PATTERN.test(ref)) {
    res.status(400).json({ error: 'Expected a kind (release or announcement) and a ref', code: 'invalid_request', reason: 'invalid_request' });
    return;
  }
  try {
    const known = kind === 'release' ? NOTE_VERSIONS.includes(ref) : (await listVisibleAnnouncements()).some((a) => a.id === ref);
    if (!known) {
      res.status(404).json({ error: 'Nothing to mark as read', code: 'not_found', reason: 'not_found' });
      return;
    }
    await markRead(req.user!.uid, kind as NoticeKind, ref);
    res.status(204).end();
  } catch {
    console.error('[Notices] Marking a notice read failed');
    res.status(500).json({ error: 'The notice could not be marked as read' });
  }
});

export default router;
