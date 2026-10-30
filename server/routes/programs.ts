import { Router, Request, Response } from 'express';
import {
  ProgramError,
  type ProgramErrorCode,
  archiveProgram,
  createProgram,
  deleteProgram,
  ensureDefaultProgram,
  getProgram,
  getProgramMetrics,
  listPrograms,
  listProgramEvents,
  setVmTargetProgram,
  unarchiveProgram,
  updateProgram,
  type Program,
  type ProgramPatch,
} from '../programs';
import { changeProgramAssets, getProgramBoundary, listAssetMemberships, parseAssetChange } from '../programAssets';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';

/**
 * The programs of a tenant (authorization boundaries): /api/v1/tenants/:tenantId/programs. Mounted by routes/tenants.ts after
 * authMiddleware, without the programContext middleware: a program is named in the URL here, and an archived one can be unarchived.
 * Creating, editing, archiving and deleting are for TENANT_OWNER and MSP_ADMIN only (requireWriteRole); every role may read.
 */
const router = Router({ mergeParams: true });

router.use(requireWriteRole);

const STATUS_BY_CODE: Record<ProgramErrorCode, number> = {
  invalid_name: 400,
  invalid_baseline: 400,
  framework_immutable: 400,
  framework_not_enabled: 403,
  program_not_found: 404,
  program_name_taken: 409,
  program_limit: 409,
  program_archived: 409,
  scoping_conflict: 409,
  program_is_default: 409,
  program_not_empty: 409,
  invalid_scoping: 400,
  invalid_vm_target: 400,
  invalid_asset_ids: 400,
  unknown_assets: 400,
  program_is_vm_target: 409,
  not_implemented: 501,
};

/** Answers a ProgramError with its status and `code`; anything else is a 500. */
function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof ProgramError) {
    res.status(STATUS_BY_CODE[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  console.error(`[Programs API] Failed to ${what}:`, errorMessage(err));
  res.status(500).json({ error: `Failed to ${what}` });
}

const idOf = (req: Request): string => String(req.params.id);

/**
 * GET /api/v1/tenants/:tenantId/programs[?includeArchived=true]
 * The tenant's programs, the default first, each with its metrics ({ documented, total, evidence, openPoam }).
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  try {
    await ensureDefaultProgram(tenantId);
    const programs = await listPrograms(tenantId, { includeArchived: req.query.includeArchived === 'true' });
    const withMetrics = await Promise.all(programs.map(async (p) => ({ ...p, metrics: await getProgramMetrics(p) })));
    res.json({ tenantId, totalCount: withMetrics.length, programs: withMetrics });
  } catch (err: unknown) {
    fail(res, err, 'list the programs');
  }
});

/**
 * GET /api/v1/tenants/:tenantId/programs/asset-memberships
 * -> { memberships: [{ programId, archived, assetIds }] }: the assets each program declares in its boundary, every program (archived
 * ones included) in the order of the program list. Declared before the /:id routes.
 */
router.get('/asset-memberships', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  try {
    await ensureDefaultProgram(tenantId);
    res.json({ memberships: await listAssetMemberships(tenantId) });
  } catch (err: unknown) {
    fail(res, err, 'list the asset memberships');
  }
});

/**
 * POST /api/v1/tenants/:tenantId/programs
 * Body: { name, frameworkId, baseline?, privacyBaseline?, scoping?, description?, systemBoundarySummary?, seed?: { cloneFrom: programId } }.
 * 201 { program }. The framework must be enabled for the tenant (403 framework_not_enabled); NIST SP 800-53 takes LOW, MODERATE or HIGH,
 * and may add the privacy baseline (privacyBaseline: true; any other framework, or a non-boolean, is a 400 invalid_baseline).
 * `scoping` (NIST SP 800-53 only) is an object of the overlay switches that are on: { nonNetworkedOnly?, noWireless?, noMobileDevices?, noPiiProcessing? };
 * anything else is a 400 invalid_scoping.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const seed = b.seed;
  if (seed !== undefined && seed !== null && (typeof seed !== 'object' || Array.isArray(seed))) {
    res.status(400).json({ error: 'Invalid seed: expected { cloneFrom: programId }', code: 'invalid_seed' });
    return;
  }
  const who = req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor';
  try {
    const program = await createProgram(
      tenantId,
      {
        name: b.name as string,
        frameworkId: b.frameworkId as string,
        baseline: b.baseline as string | null | undefined,
        privacyBaseline: b.privacyBaseline as boolean | null | undefined,
        scoping: b.scoping,
        description: b.description as string | undefined,
        systemBoundarySummary: b.systemBoundarySummary as string | undefined,
        seed: (seed ?? null) as { cloneFrom?: string } | null,
      },
      who,
      { source: 'human', actor: who, userId: req.user?.uid ?? null }
    );
    console.log(`[Programs API] ${req.user?.uid} created program ${program.id} (${program.frameworkId}) in ${tenantId}`);
    res.status(201).json({ program });
  } catch (err: unknown) {
    fail(res, err, 'create the program');
  }
});

/**
 * PUT /api/v1/tenants/:tenantId/programs/:id
 * Body: any of { name, description, systemBoundarySummary, scoping, expectedScoping }. frameworkId, baseline and privacyBaseline are immutable: sending a different value is a 400.
 * expectedScoping is the overlays the client last saw: when the stored ones differ the answer is 409 scoping_conflict and nothing is written.
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: ProgramPatch = {};
  for (const field of ['name', 'description', 'systemBoundarySummary', 'frameworkId'] as const) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== 'string') {
      res.status(400).json({ error: `Invalid ${field}: expected text` });
      return;
    }
    patch[field] = b[field] as string;
  }
  if (b.baseline !== undefined) patch.baseline = b.baseline as string | null;
  if (b.privacyBaseline !== undefined) patch.privacyBaseline = b.privacyBaseline as boolean | null;
  if (b.scoping !== undefined) {
    if (b.scoping === null || typeof b.scoping !== 'object' || Array.isArray(b.scoping)) {
      res.status(400).json({ error: 'Invalid scoping: expected an object of overlay switches', code: 'invalid_scoping' });
      return;
    }
    patch.scoping = b.scoping;
  }
  if (b.expectedScoping !== undefined) {
    if (b.expectedScoping === null || typeof b.expectedScoping !== 'object' || Array.isArray(b.expectedScoping)) {
      res.status(400).json({ error: 'Invalid expectedScoping: expected an object of overlay switches', code: 'invalid_scoping' });
      return;
    }
    patch.expectedScoping = b.expectedScoping;
  }
  const who = req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor';
  try {
    const program = await updateProgram(tenantId, idOf(req), patch, { actor: who, userId: req.user?.uid ?? null });
    res.json({ program });
  } catch (err: unknown) {
    fail(res, err, 'update the program');
  }
});

/**
 * PUT /api/v1/tenants/:tenantId/programs/:id/vm-target
 * Makes the program the tenant's VM target (the program that receives vulnerability-management snapshots and POA&M items); the flag of
 * the previous target is cleared. 200 { program, previousId, openPoamInPrevious }: existing data stays in the previous target, and
 * openPoamInPrevious is how many open POA&M items it still holds. Only a CMMC_L1 / CMMC_L2 program (400 invalid_vm_target), not an
 * archived one (409 program_archived).
 */
router.put('/:id/vm-target', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const who = req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor';
  try {
    const result = await setVmTargetProgram(req.tenantId!, idOf(req), { actor: who, userId: req.user?.uid ?? null });
    console.log(`[Programs API] ${req.user?.uid} set program ${result.program.id} as the VM target in ${req.tenantId}`);
    res.json(result);
  } catch (err: unknown) {
    fail(res, err, 'set the VM target');
  }
});

/**
 * GET /api/v1/tenants/:tenantId/programs/:id/assets
 * -> { programId, declared, assetIds, summary }: the assets the program declares in its boundary. `declared` is false when it names none,
 * and then `summary` (summarizeScope) covers the whole inventory.
 */
router.get('/:id/assets', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json(await getProgramBoundary(req.tenantId!, idOf(req)));
  } catch (err: unknown) {
    fail(res, err, 'read the program assets');
  }
});

/**
 * PATCH /api/v1/tenants/:tenantId/programs/:id/assets
 * Body: { add?: string[], remove?: string[] } (deltas, so two editors do not overwrite each other). 200 { programId, declared, assetIds, added, removed }.
 * 400 invalid_asset_ids (bad shape, nothing to change, an id in both lists, more than 5000 ids), 400 unknown_assets ({ count }: not in this
 * tenant's inventory), 404 program_not_found, 409 program_archived. Records an assets_changed event (counts and ids) when something changed.
 */
router.patch('/:id/assets', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const who = req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor';
  try {
    const result = await changeProgramAssets(req.tenantId!, idOf(req), parseAssetChange(req.body), { actor: who, userId: req.user?.uid ?? null });
    if (result.added + result.removed > 0) {
      console.log(`[Programs API] ${req.user?.uid} changed the assets of program ${result.programId} in ${req.tenantId} (+${result.added} -${result.removed})`);
    }
    res.json(result);
  } catch (err: unknown) {
    fail(res, err, 'change the program assets');
  }
});

/** GET /api/v1/tenants/:tenantId/programs/:id/events[?limit=n] -> { events }: scoping and VM target changes, newest first (booleans and ids only). */
router.get('/:id/events', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const program = await getProgram(req.tenantId!, idOf(req));
    if (!program) throw new ProgramError('program_not_found', 'Program not found');
    const limit = Number(req.query.limit);
    res.json({ events: await listProgramEvents({ tenantId: program.tenantId, programId: program.id }, Number.isFinite(limit) && limit > 0 ? limit : undefined) });
  } catch (err: unknown) {
    fail(res, err, 'read the program events');
  }
});

/** POST /api/v1/tenants/:tenantId/programs/:id/archive: reads stay possible, writes are refused. The default program cannot be archived. */
router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ program: await archiveProgram(req.tenantId!, idOf(req)) });
  } catch (err: unknown) {
    fail(res, err, 'archive the program');
  }
});

/** POST /api/v1/tenants/:tenantId/programs/:id/unarchive */
router.post('/:id/unarchive', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ program: await unarchiveProgram(req.tenantId!, idOf(req)) });
  } catch (err: unknown) {
    fail(res, err, 'unarchive the program');
  }
});

/**
 * DELETE /api/v1/tenants/:tenantId/programs/:id
 * 204. Never the default program (409 program_is_default) and never one that holds evidence, SSP imports or POA&M items
 * (409 program_not_empty, with the counts): archive those instead.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    await deleteProgram(req.tenantId!, idOf(req));
    res.status(204).end();
  } catch (err: unknown) {
    fail(res, err, 'delete the program');
  }
});

/** GET /api/v1/tenants/:tenantId/programs/:id/metrics -> { documented, total, evidence, openPoam } */
router.get('/:id/metrics', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const program: Program | null = await getProgram(req.tenantId!, idOf(req));
    if (!program) throw new ProgramError('program_not_found', 'Program not found');
    res.json(await getProgramMetrics(program));
  } catch (err: unknown) {
    fail(res, err, 'read the program metrics');
  }
});

export default router;
