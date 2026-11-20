import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { INVENTORY_STATUS, InventoryError } from '../inventory/registerStore';
import {
  changeProgramTools,
  linkVendorDocument,
  listProgramInventoryEvents,
  putToolControls,
  readDataInventory,
  readProgramInventory,
  unlinkVendorDocument,
  writeDataInventory,
} from '../inventory/programInventoryStore';
import { CUI_CATEGORY_IDS } from '../inventory/cuiCategories';
import type { InventoryActor } from '../inventory/events';
import { parseExpectedUpdatedAt, StaleWriteError } from '../controlAssessments';
import { requireWriteRole } from '../middleware/roleGuard';
import { programCatalogIds } from '../programs';
import { errorMessage } from '../../src/utils/errors';
import {
  INVENTORY_ID_PATTERN,
  validateDataInventoryInput,
  validateToolControlsInput,
  validateToolIdChange,
  validateVendorDocumentInput,
} from '../../src/data/inventory/inventorySchema';

/**
 * A program's side of the Tools and Services register (issues #239, #243, #248). Mounted at /api/v1/program-inventory after authMiddleware and
 * programContext (the program comes from x-program-id; an archived program answers 409 program_archived to writes).
 *
 *   GET    /                                         { programId, declared, toolIds, controlLinks, vendorDocuments }       any member
 *   PATCH  /tools                                    { add?, remove?, force? } the boundary, as deltas          TENANT_OWNER / TENANT_ADMIN / MSP_ADMIN
 *   PUT    /tools/:toolId/controls                   { controls: [{ controlId, evidenceSource }], expectedControlIds }
 *   GET    /data-inventory                           { handlesFci, categories, updatedAt, updatedBy }
 *   PUT    /data-inventory                           { handlesFci, categories, expectedUpdatedAt }
 *   POST   /vendor-documents                         { vendorId, evidenceId, docKind }
 *   DELETE /vendor-documents/:vendorId/:evidenceId
 *   GET    /events[?limit=n]                         { events }: newest first (ids, counts and flags only)
 *
 * VIEWER and ASSESSOR are strictly read-only (requireWriteRole). Control ids and CUI category ids are catalog codes, not CUI; names, missions and
 * notes of the tools never reach this API, its history or its logs.
 */
const router = Router();
router.use(requireWriteRole);

const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });
const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof StaleWriteError) {
    res.status(409).json({ error: 'The data inventory was saved by someone else after you loaded it.', code: 'stale_write', current: err.current });
    return;
  }
  if (err instanceof InventoryError) {
    res.status(INVENTORY_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Program Inventory API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const invalid = (res: Response, error: string, code = 'invalid', extra: Record<string, unknown> = {}): void => void res.status(400).json({ error, code, ...extra });

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readProgramInventory(scopeOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to read the program register');
  }
});

/** PATCH /tools: { add?, remove?, force? } -> { programId, declared, toolIds, added, removed, linksRemoved, cuiLinksRemoved }; 409 tool_in_use unless force. */
router.patch('/tools', async (req: Request, res: Response): Promise<void> => {
  const parsed = validateToolIdChange(req.body);
  if (!parsed.ok) return invalid(res, parsed.error, 'invalid_tool_ids');
  try {
    const result = await changeProgramTools(scopeOf(req), parsed.value, actorOf(req));
    if (result.added + result.removed > 0) console.log(`[Program Inventory API] ${req.user?.uid} changed the boundary of program ${result.programId} in ${req.tenantId} (+${result.added} -${result.removed})`);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Failed to change the boundary');
  }
});

/** PUT /tools/:toolId/controls: { controls, expectedControlIds } -> { toolId, controls, changed } (the whole set is replaced). */
router.put('/tools/:toolId/controls', async (req: Request, res: Response): Promise<void> => {
  const toolId = String(req.params.toolId);
  if (!INVENTORY_ID_PATTERN.test(toolId)) {
    res.status(404).json({ error: 'The tool was not found in this organization', code: 'tool_not_found' });
    return;
  }
  const parsed = validateToolControlsInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.json(await putToolControls(scopeOf(req), toolId, parsed.value.controls, parsed.value.expectedControlIds, programCatalogIds(req.program!), actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to save the control links');
  }
});

router.get('/data-inventory', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readDataInventory(scopeOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to read the data inventory');
  }
});

/** PUT /data-inventory: { handlesFci, categories, expectedUpdatedAt } (a whole replace) -> { ...record, changed }. */
router.put('/data-inventory', async (req: Request, res: Response): Promise<void> => {
  const body = req.body ?? {};
  const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!expected.ok || expected.value === undefined) {
    res.status(400).json({ error: 'expectedUpdatedAt must be a timestamp or null', code: 'invalid_expected_updated_at' });
    return;
  }
  try {
    const stored = await readDataInventory(scopeOf(req));
    const parsed = validateDataInventoryInput(body, CUI_CATEGORY_IDS, new Set(stored.categories.map((c) => c.categoryId)));
    if (!parsed.ok) return invalid(res, parsed.error, parsed.code, parsed.index === undefined ? {} : { index: parsed.index });
    const { record, changed } = await writeDataInventory(scopeOf(req), parsed.value, expected.value, actorOf(req));
    res.json({ ...record, changed });
  } catch (err) {
    sendError(res, err, 'Failed to save the data inventory');
  }
});

/** POST /vendor-documents: { vendorId, evidenceId, docKind } -> 201 { document }, or 200 { document, changed } when the pair was already linked. */
router.post('/vendor-documents', async (req: Request, res: Response): Promise<void> => {
  const parsed = validateVendorDocumentInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    const { document, created, changed } = await linkVendorDocument(scopeOf(req), parsed.value, actorOf(req));
    res.status(created ? 201 : 200).json({ document, changed });
  } catch (err) {
    sendError(res, err, 'Failed to link the document');
  }
});

router.delete('/vendor-documents/:vendorId/:evidenceId', async (req: Request, res: Response): Promise<void> => {
  const vendorId = String(req.params.vendorId);
  const evidenceId = String(req.params.evidenceId);
  if (!INVENTORY_ID_PATTERN.test(vendorId) || !INVENTORY_ID_PATTERN.test(evidenceId)) {
    res.status(404).json({ error: 'Document link not found', code: 'not_found' });
    return;
  }
  try {
    if (!(await unlinkVendorDocument(scopeOf(req), vendorId, evidenceId, actorOf(req)))) {
      res.status(404).json({ error: 'Document link not found', code: 'not_found' });
      return;
    }
    res.json({ removed: evidenceId, vendorId });
  } catch (err) {
    sendError(res, err, 'Failed to unlink the document');
  }
});

router.get('/events', async (req: Request, res: Response): Promise<void> => {
  const limit = Number(req.query.limit);
  try {
    res.json({ events: await listProgramInventoryEvents(scopeOf(req), Number.isFinite(limit) && limit > 0 ? limit : undefined) });
  } catch (err) {
    sendError(res, err, 'Failed to read the history');
  }
});

export default router;
