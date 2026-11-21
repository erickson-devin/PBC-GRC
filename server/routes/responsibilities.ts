import { Router, Request, Response } from 'express';
import { loadAssigneeContext, teamsOfUser, tenantResponsibilities } from '../assignments/assignmentsService';
import { getTeam } from '../assignments/teamsStore';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';

/**
 * GET /api/v1/tenants/:tenantId/responsibilities[?view=me|team][&teamId=][&includeArchived=true] (issue #253), every role.
 *   view=me (the default): what the caller is responsible for, directly and through their teams, in each active program.
 *   view=team&teamId=: the same for the assignments that name the team; 404 not_found for an unknown team.
 * -> { programs: [{ programId, name, frameworkId, archived, items }], truncated }: ids, duties and statuses only. A program with nothing is left out.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const view = req.query.view === undefined ? 'me' : req.query.view;
  const includeArchived = req.query.includeArchived === 'true';
  try {
    if (view === 'me') {
      const userId = req.user?.uid ?? '';
      const ctx = await loadAssigneeContext(tenantId);
      res.json(await tenantResponsibilities(tenantId, { kind: 'user', userId, teamIds: teamsOfUser(ctx, userId) }, includeArchived));
      return;
    }
    if (view === 'team') {
      const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : '';
      if (!TEAM_ID_PATTERN.test(teamId) || !(await getTeam(tenantId, teamId))) {
        res.status(404).json({ error: 'Team not found', code: 'not_found' });
        return;
      }
      res.json(await tenantResponsibilities(tenantId, { kind: 'team', teamId }, includeArchived));
      return;
    }
    res.status(400).json({ error: 'view is invalid', code: 'invalid', field: 'view' });
  } catch (err) {
    // errorMessage only: a database error can carry a row's values
    console.error('[Responsibilities API] Failed to read the responsibilities:', errorMessage(err));
    res.status(500).json({ error: 'Failed to read the responsibilities' });
  }
});

export default router;
