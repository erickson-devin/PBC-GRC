import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { importObjectives, listObjectiveEvents, readObjectives, writeObjective, writeObjectivesBulk, type ObjectiveActor } from '../controlObjectives';
import { ensureControlInFrameworkPolicy } from '../middleware/frameworkGuard';
import { requireWriteRole } from '../middleware/roleGuard';
import { MAX_OBJECTIVE_BULK, MAX_OBJECTIVE_IMPORT, controlIdOfObjective, validateObjectiveInput, type ObjectiveInput } from '../../src/types/controlObjectives';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may GET but never POST / PUT / DELETE.
router.use(requireWriteRole);

/** The tenant and program of the request (set by authMiddleware and the programContext middleware that is mounted before this router). */
const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });

/** The signed-in user, as recorded in the history: never a name taken from the request body. */
const actorOf = (req: Request): ObjectiveActor => ({
  source: 'human',
  actor: req.user?.name || req.user?.email || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

/** A null field means the same as a missing one (keep); only the known fields are passed on. */
function toInput(raw: Record<string, unknown>, objectiveId: unknown): Record<string, unknown> {
  const pick = (v: unknown): unknown => (v === null ? undefined : v);
  return { objectiveId, controlId: raw.controlId, status: pick(raw.status), narrative: pick(raw.narrative), linkedEvidenceIds: pick(raw.linkedEvidenceIds) };
}

/** The validated inputs of a list body, or the 400 already sent (null). The messages never repeat request text. */
function listFrom(req: Request, res: Response, max: number): ObjectiveInput[] | null {
  const list = (req.body ?? {}).objectives;
  if (!Array.isArray(list) || list.length === 0) {
    res.status(400).json({ error: 'objectives must be a non-empty list' });
    return null;
  }
  if (list.length > max) {
    res.status(400).json({ error: `At most ${max} objectives per request` });
    return null;
  }
  const inputs: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const raw = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const input = toInput(raw, raw.objectiveId);
    const problem = validateObjectiveInput(typeof item === 'object' && item !== null && !Array.isArray(item) ? input : item);
    if (problem) {
      res.status(400).json({ error: `objectives[${i}]: ${problem}` });
      return null;
    }
    inputs.push(input);
  }
  return inputs as unknown as ObjectiveInput[];
}

/** True when every control the inputs name is allowed in the tenant's program; otherwise the 403 is already sent. */
async function ensureControls(req: Request, res: Response, inputs: ObjectiveInput[]): Promise<boolean> {
  for (const controlId of new Set(inputs.map((i) => i.controlId))) {
    if (!(await ensureControlInFrameworkPolicy(req, res, controlId))) return false;
  }
  return true;
}

function fail(res: Response, req: Request, what: string, err: unknown): void {
  // errorMessage only: a database error can carry the row's values, and the narrative may be CUI
  console.error(`[Objectives API] Error ${what} for tenant ${req.tenantId}:`, errorMessage(err));
  res.status(500).json({ error: `Failed ${what}` });
}

/**
 * GET /api/v1/objectives[?controlId=]
 * The program's objective records (status, narrative, evidence links). Every role may read them.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const controlId = typeof req.query.controlId === 'string' && req.query.controlId !== '' ? req.query.controlId : undefined;
  try {
    const objectives = await readObjectives(scopeOf(req), controlId);
    res.json({ objectives });
  } catch (err: unknown) {
    fail(res, req, 'reading objectives', err);
  }
});

/**
 * PUT /api/v1/objectives
 * Body { objectives: [{ objectiveId, controlId, status?, narrative?, linkedEvidenceIds? }] }: up to 500 objectives, all or none.
 */
router.put('/', async (req: Request, res: Response): Promise<void> => {
  const inputs = listFrom(req, res, MAX_OBJECTIVE_BULK);
  if (!inputs) return;
  if (!(await ensureControls(req, res, inputs))) return;
  try {
    const result = await writeObjectivesBulk(scopeOf(req), inputs, actorOf(req));
    res.json(result);
  } catch (err: unknown) {
    fail(res, req, 'updating objectives', err);
  }
});

/**
 * POST /api/v1/objectives/import
 * Body { objectives: [...] } (up to 5000), the records a browser kept before the server stored them. Insert-only: an id that has no row is
 * created, an identical one is 'unchanged', a different one is a 'conflict' and writes nothing.
 */
router.post('/import', async (req: Request, res: Response): Promise<void> => {
  const inputs = listFrom(req, res, MAX_OBJECTIVE_IMPORT);
  if (!inputs) return;
  if (!(await ensureControls(req, res, inputs))) return;
  try {
    const results = await importObjectives(scopeOf(req), inputs, actorOf(req));
    res.json({ results });
  } catch (err: unknown) {
    fail(res, req, 'importing objectives', err);
  }
});

/**
 * GET /api/v1/objectives/:objectiveId/history?limit=
 * Who changed the objective and when, newest first. Carries the SHA-256 and length of the narrative, never its text.
 */
router.get('/:objectiveId/history', async (req: Request, res: Response): Promise<void> => {
  const objectiveId = String(req.params.objectiveId);
  const controlId = controlIdOfObjective(objectiveId);
  if (controlId === null) {
    res.status(400).json({ error: 'objectiveId must look like CONTROL-ID[a]' });
    return;
  }
  if (!(await ensureControlInFrameworkPolicy(req, res, controlId))) return;
  const rawLimit = typeof req.query.limit === 'string' ? req.query.limit : '';
  const limit = /^\d+$/.test(rawLimit) ? Math.min(200, Math.max(1, Number(rawLimit))) : 50;
  try {
    const events = await listObjectiveEvents(scopeOf(req), objectiveId, limit);
    res.json({ objectiveId, controlId, totalCount: events.length, events });
  } catch (err: unknown) {
    fail(res, req, 'reading the objective history', err);
  }
});

/**
 * PUT /api/v1/objectives/:objectiveId
 * Body { controlId, status?, narrative?, linkedEvidenceIds? }. A field left out (or null) keeps its stored value; an empty narrative clears it.
 * Nothing is written, and no history event recorded, when nothing differs. The change is recorded under the signed-in user.
 */
router.put('/:objectiveId', async (req: Request, res: Response): Promise<void> => {
  const input = toInput(req.body ?? {}, req.params.objectiveId);
  const problem = validateObjectiveInput(input);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const item = input as unknown as ObjectiveInput;
  if (!(await ensureControlInFrameworkPolicy(req, res, item.controlId))) return;
  try {
    const { record, changed } = await writeObjective(scopeOf(req), item, actorOf(req));
    res.json({ objective: record, changed });
  } catch (err: unknown) {
    fail(res, req, `updating objective ${item.objectiveId}`, err);
  }
});

export default router;
