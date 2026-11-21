import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { membershipNowMs } from '../db';
import {
  ASSIGNMENT_STATUS,
  AssignmentError,
  applyAssignmentBatch,
  assignmentLimit,
  readAssignments,
} from '../assignments/assignmentsStore';
import { isCurrentMember, loadAssigneeContext, programResponsibilities, teamsOfUser, toAssignments } from '../assignments/assignmentsService';
import type { InventoryActor } from '../inventory/events';
import { requireWriteRole } from '../middleware/roleGuard';
import { programCatalogIds } from '../programs';
import { SSP_SECTIONS, SSP_SIGNABLE_SECTION_IDS } from '../../src/data/ssp/sspSections';
import { targetProblem, validateAssignmentBatch } from '../../src/data/assignments/assignmentSchema';
import { errorMessage } from '../../src/utils/errors';

/**
 * Assignments of a program (#253): who is responsible for a control, an objective or an SSP section. Mounted at /api/v1/assignments after authMiddleware and
 * programContext (the program comes from x-program-id; an archived program answers 409 program_archived to writes).
 *
 *   GET  /        { assignments, limit }                                  any member
 *   PUT  /        { items: [{ targetKind, targetId, duty, assignee, expectedAssignee }] } (1 to 500, all or nothing) -> { assignments, changed }
 *   GET  /mine    { items }: the caller's responsibilities in this program (directly and through teams)
 *
 * An assignment is a LABEL and grants nothing: VIEWER and ASSESSOR stay strictly read-only (requireWriteRole), an assignee never gets a permission, and the
 * reviewer duty is advisory (the sign-off route is unchanged). Errors name an item index and a field, never a value; the logs carry ids and counts only.
 *   400 invalid { index, field } | target_not_in_program { index } | reviewer_only_for_sections { index } | assignee_not_member { index };
 *   404 team_not_found { index }; 409 stale_write { index, current }; 429 limit.
 */
const router = Router();
router.use(requireWriteRole);

const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });
const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof AssignmentError) {
    res.status(ASSIGNMENT_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Assignments API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const [rows, ctx] = await Promise.all([readAssignments(scopeOf(req)), loadAssigneeContext(req.tenantId!)]);
    res.json({ assignments: toAssignments(rows, ctx), limit: assignmentLimit() });
  } catch (err) {
    sendError(res, err, 'Failed to read the assignments');
  }
});

/** GET /mine: { items }: what the caller is responsible for in this program, directly and through the teams they belong to. */
router.get('/mine', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid ?? '';
    const ctx = await loadAssigneeContext(req.tenantId!);
    res.json({ items: await programResponsibilities(scopeOf(req), { kind: 'user', userId, teamIds: teamsOfUser(ctx, userId) }) });
  } catch (err) {
    sendError(res, err, 'Failed to read your responsibilities');
  }
});

router.put('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = validateAssignmentBatch(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: 'The assignments are invalid', code: 'invalid', index: parsed.index, field: parsed.field });
    return;
  }
  try {
    const catalog = { catalogIds: programCatalogIds(req.program!), sectionIds: SSP_SECTIONS.map((s) => s.id) as readonly string[], signableIds: SSP_SIGNABLE_SECTION_IDS as readonly string[] };
    const ctx = await loadAssigneeContext(req.tenantId!);
    const nowMs = membershipNowMs();
    // every item is checked before anything is written (all or nothing)
    for (let index = 0; index < parsed.items.length; index++) {
      const item = parsed.items[index];
      const problem = targetProblem(item, catalog);
      if (problem) {
        res.status(400).json({ error: problem === 'target_not_in_program' ? 'The target is not part of this program' : 'The reviewer duty is for the signable SSP sections only', code: problem, index });
        return;
      }
      if (item.assignee === null) continue;
      if (item.assignee.kind === 'user' && !isCurrentMember(ctx, item.assignee.id, nowMs)) {
        res.status(400).json({ error: 'The assignee is not a current member of this organization', code: 'assignee_not_member', index });
        return;
      }
      if (item.assignee.kind === 'team' && !ctx.teams.has(item.assignee.id)) {
        res.status(404).json({ error: 'The team was not found in this organization', code: 'team_not_found', index });
        return;
      }
    }
    const result = await applyAssignmentBatch(scopeOf(req), parsed.items, actorOf(req));
    if (result.changed > 0) console.log(`[Assignments API] ${req.user?.uid} changed ${result.changed} assignment(s) in program ${req.programId} of ${req.tenantId}`);
    res.json({ assignments: toAssignments(result.changedRows, ctx, nowMs), changed: result.changed });
  } catch (err) {
    sendError(res, err, 'Failed to save the assignments');
  }
});

export default router;
