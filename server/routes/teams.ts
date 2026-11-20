import { Router, Request, Response } from 'express';
import { MAX_PROGRAMS_PER_TENANT, listPrograms } from '../programs';
import { ASSIGNMENT_STATUS, AssignmentError, countTeamAssignments, deleteTeamAssignments } from '../assignments/assignmentsStore';
import { changeTeamMembers, createTeam, deleteTeam, getTeam, listTeams, updateTeam } from '../assignments/teamsStore';
import { isCurrentMember, loadAssigneeContext } from '../assignments/assignmentsService';
import type { InventoryActor } from '../inventory/events';
import { parseExpectedUpdatedAt, StaleWriteError } from '../controlAssessments';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { validateTeamInput } from '../../src/data/assignments/assignmentSchema';
import { MAX_TEAMS_PER_TENANT, MAX_TEAM_MEMBERS } from '../../src/types/assignments';
import { errorMessage } from '../../src/utils/errors';

/**
 * Teams (#253). Mounted at /api/v1/tenants/:tenantId/teams.
 *
 *   GET    /                        { teams, limit }                                                         any member
 *   POST   /                        { name, description? } -> 201 { team }                                  TENANT_OWNER / TENANT_ADMIN / MSP_ADMIN
 *   PUT    /:teamId                 { name?, description?, expectedUpdatedAt } -> { team, changed }
 *   PATCH  /:teamId/members         { add?, remove? } (user ids) -> { team, added, removed }
 *   GET    /:teamId/usage           { programs: [{ programId, assignments }] }: the programs (archived included) whose assignments name the team
 *   DELETE /:teamId[?force=true]    { removed }; 409 team_in_use { assignments } while an assignment names the team, unless force (those assignments are
 *                                   deleted program by program, each in its own transaction, then the team)
 *
 * The write guard is applied here as well as at the tenants router: VIEWER and ASSESSOR are strictly read-only. A team's name and description may be
 * sensitive: errors name a field only, the logs carry ids only and the history holds digests. Teams grant nothing: they are labels for assignments.
 *   400 invalid { field } | invalid_expected_updated_at | invalid_member_ids | not_a_member { count }; 404 not_found; 409 duplicate_name | stale_write { current }
 *   | team_in_use { assignments }; 429 limit.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const teamIdOf = (req: Request): string => String(req.params.teamId);

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof StaleWriteError) {
    res.status(409).json({ error: 'This team was changed by someone else after you loaded it.', code: 'stale_write', current: err.current });
    return;
  }
  if (err instanceof AssignmentError) {
    res.status(ASSIGNMENT_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Teams API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const notFound = (res: Response): void => void res.status(404).json({ error: 'Team not found', code: 'not_found' });

/** How many assignments of each program (archived ones included) name the team, only the programs that have some. */
async function teamUsage(tenantId: string, teamId: string): Promise<{ programId: string; assignments: number }[]> {
  const programs = (await listPrograms(tenantId, { includeArchived: true })).slice(0, MAX_PROGRAMS_PER_TENANT);
  const out: { programId: string; assignments: number }[] = [];
  for (const p of programs) {
    const assignments = await countTeamAssignments({ tenantId, programId: p.id }, teamId);
    if (assignments > 0) out.push({ programId: p.id, assignments });
  }
  return out;
}

/** A list of user ids (at most MAX_TEAM_MEMBERS), or null when it is not one. Absent is an empty list. */
function idList(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_TEAM_MEMBERS) return null;
  return v.every((x) => typeof x === 'string' && USER_ID_PATTERN.test(x)) ? (v as string[]) : null;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ teams: await listTeams(req.tenantId!), limit: MAX_TEAMS_PER_TENANT });
  } catch (err) {
    sendError(res, err, 'Failed to list the teams');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateTeamInput(req.body, false);
  if (!parsed.ok) {
    res.status(400).json({ error: `${parsed.field} is invalid`, code: 'invalid', field: parsed.field });
    return;
  }
  try {
    const team = await createTeam(req.tenantId!, { name: parsed.value.name as string, description: parsed.value.description }, actorOf(req));
    console.log(`[Teams API] ${req.user?.uid} created team ${team.id} in ${req.tenantId}`);
    res.status(201).json({ team });
  } catch (err) {
    sendError(res, err, 'Failed to create the team');
  }
});

router.put('/:teamId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = teamIdOf(req);
  if (!TEAM_ID_PATTERN.test(id)) return notFound(res);
  const expected = parseExpectedUpdatedAt((req.body ?? {}).expectedUpdatedAt);
  if (!expected.ok || typeof expected.value !== 'string') {
    res.status(400).json({ error: 'expectedUpdatedAt must be the timestamp of the team you loaded', code: 'invalid_expected_updated_at' });
    return;
  }
  const parsed = validateTeamInput(req.body, true);
  if (!parsed.ok) {
    res.status(400).json({ error: `${parsed.field} is invalid`, code: 'invalid', field: parsed.field });
    return;
  }
  try {
    const result = await updateTeam(req.tenantId!, id, parsed.value, expected.value, actorOf(req));
    if (result.changed) console.log(`[Teams API] ${req.user?.uid} changed team ${id} in ${req.tenantId}`);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Failed to save the team');
  }
});

router.patch('/:teamId/members', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = teamIdOf(req);
  if (!TEAM_ID_PATTERN.test(id)) return notFound(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const add = idList(body.add);
  const remove = idList(body.remove);
  if (add === null || remove === null || Object.keys(body).some((k) => k !== 'add' && k !== 'remove')) {
    res.status(400).json({ error: 'add and remove are lists of member ids', code: 'invalid_member_ids' });
    return;
  }
  try {
    const tenantId = req.tenantId!;
    if (!(await getTeam(tenantId, id))) return notFound(res);
    if (add.length > 0) {
      const ctx = await loadAssigneeContext(tenantId);
      const outsiders = add.filter((u) => !isCurrentMember(ctx, u)).length;
      if (outsiders > 0) {
        res.status(400).json({ error: 'Some of the people to add are not current members of this organization', code: 'not_a_member', count: outsiders });
        return;
      }
    }
    const result = await changeTeamMembers(tenantId, id, { add, remove }, actorOf(req));
    if (result.added + result.removed > 0) console.log(`[Teams API] ${req.user?.uid} changed the members of team ${id} in ${tenantId} (+${result.added} -${result.removed})`);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Failed to change the team members');
  }
});

router.get('/:teamId/usage', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = teamIdOf(req);
  if (!TEAM_ID_PATTERN.test(id)) return notFound(res);
  try {
    if (!(await getTeam(req.tenantId!, id))) return notFound(res);
    res.json({ programs: await teamUsage(req.tenantId!, id) });
  } catch (err) {
    sendError(res, err, 'Failed to read the team usage');
  }
});

router.delete('/:teamId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = teamIdOf(req);
  if (!TEAM_ID_PATTERN.test(id)) return notFound(res);
  const tenantId = req.tenantId!;
  try {
    if (!(await getTeam(tenantId, id))) return notFound(res);
    const usage = await teamUsage(tenantId, id);
    const assignments = usage.reduce((n, u) => n + u.assignments, 0);
    if (assignments > 0 && req.query.force !== 'true') {
      res.status(409).json({ error: 'The team still has assignments', code: 'team_in_use', assignments, programs: usage.length });
      return;
    }
    // each program's assignments go in the program's own transaction, then the team (and its members)
    for (const u of usage) await deleteTeamAssignments({ tenantId, programId: u.programId }, id, actorOf(req));
    if (!(await deleteTeam(tenantId, id, actorOf(req)))) return notFound(res);
    console.log(`[Teams API] ${req.user?.uid} deleted team ${id} in ${tenantId} (${assignments} assignment(s) removed)`);
    res.json({ removed: id, assignmentsRemoved: assignments });
  } catch (err) {
    sendError(res, err, 'Failed to delete the team');
  }
});

export default router;
