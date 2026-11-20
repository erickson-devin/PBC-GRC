import { Router, Request, Response } from 'express';
import {
  INVENTORY_STATUS,
  InventoryError,
  createTool,
  createToolsBatch,
  createVendor,
  deleteTool,
  deleteVendor,
  getTool,
  listTools,
  listVendors,
  setRecoveryOrder,
  updateTool,
  updateVendor,
} from '../inventory/registerStore';
import { listInventoryEvents, redactEventsForRole, type InventoryActor } from '../inventory/events';
import { listToolMemberships, toolUsage } from '../inventory/toolUsage';
import { parseExpectedUpdatedAt, StaleWriteError } from '../controlAssessments';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { canRoleWrite } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import { INVENTORY_ID_PATTERN, validateRecoveryOrderInput, validateToolInput, validateVendorInput } from '../../src/data/inventory/inventorySchema';
import { MAX_BATCH, MAX_TOOLS_PER_TENANT, MAX_VENDORS_PER_TENANT, type InventoryTool } from '../../src/types/inventory';

/**
 * Tools and Services register (issues #239, #248, #249). Mounted at /api/v1/tenants/:tenantId/inventory.
 *
 *   GET    /tools                  every tool (annualCostCents only for the write roles)   any member
 *   POST   /tools                  add a tool                      TENANT_OWNER / TENANT_ADMIN / MSP_ADMIN
 *   POST   /tools/batch            add up to 200 tools, insert-only (survey seed, catalog quick add)
 *   PUT    /tools/recovery-order   rank the tools 1..n
 *   PUT    /tools/:toolId          change fields (expectedUpdatedAt required)
 *   GET    /tools/:toolId/usage    in how many programs and with how many links the tool is used
 *   DELETE /tools/:toolId          remove a tool
 *   GET    /tool-memberships       the declared boundary of every program
 *   GET/POST/PUT/DELETE /vendors[/:vendorId]   vendors and external service providers (same pattern; DELETE leaves the tools' vendorId null)
 *   GET    /events                 the register's history (digests only; cost digests only for the write roles)
 *
 * The RBAC guard is applied here as well as at the tenants router: VIEWER and ASSESSOR are strictly read-only. The annual cost is never sent to a
 * reader without a write role, in the tools and in the history. Names, missions and notes may be CUI: the logs carry ids only.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const idOf = (req: Request, key: string): string => String(req.params[key]);
const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof StaleWriteError) {
    res.status(409).json({ error: 'This entry was changed by someone else after you loaded it.', code: 'stale_write', current: err.current });
    return;
  }
  if (err instanceof InventoryError) {
    res.status(INVENTORY_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Inventory API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const notFound = (res: Response, what: string): void => void res.status(404).json({ error: `${what} not found`, code: 'not_found' });
const invalid = (res: Response, error: string, extra: Record<string, unknown> = {}): void => void res.status(400).json({ error, code: 'invalid', ...extra });

/** The tools as the caller may see them: the cost only with a write role. */
function forReader(req: Request, tools: InventoryTool[]): InventoryTool[] {
  if (canRoleWrite(req.tenantRole)) return tools;
  return tools.map((t) => {
    const { annualCostCents: _cost, ...rest } = t;
    return rest;
  });
}

/** The stamp the client loaded: required for a PUT, and a timestamp (null would mean "no row yet"). Sends the 400 and returns null otherwise. */
function expectedOf(req: Request, res: Response): string | null {
  const expected = parseExpectedUpdatedAt((req.body ?? {}).expectedUpdatedAt);
  if (!expected.ok || typeof expected.value !== 'string') {
    res.status(400).json({ error: 'expectedUpdatedAt must be the timestamp of the entry you loaded', code: 'invalid_expected_updated_at' });
    return null;
  }
  return expected.value;
}

// ------------------------------------------------------------------------------------------------ tools

router.get('/tools', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ tools: forReader(req, await listTools(req.tenantId!)), limit: MAX_TOOLS_PER_TENANT });
  } catch (err) {
    sendError(res, err, 'Failed to list the register');
  }
});

router.post('/tools', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateToolInput(req.body, false);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.status(201).json({ tool: await createTool(req.tenantId!, parsed.value, actorOf(req)) });
  } catch (err) {
    sendError(res, err, 'Failed to add the entry');
  }
});

/** POST /tools/batch: { items: (ToolInput & { seedKey? })[] } (1 to 200) -> { created, skipped: [{ index, reason }] }; origin comes from the seedKey prefix. */
router.post('/tools/batch', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const items = (req.body ?? {}).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) return invalid(res, `items must be a list of 1 to ${MAX_BATCH} entries`);
  const parsed = [];
  for (let index = 0; index < items.length; index++) {
    const one = validateToolInput(items[index], false, { allowSeedKey: true });
    if (!one.ok) return invalid(res, `items[${index}]: ${one.error}`, { index });
    parsed.push(one.value);
  }
  try {
    res.json(await createToolsBatch(req.tenantId!, parsed, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to add the entries');
  }
});

/** PUT /tools/recovery-order: { order, expectedOrder } -> { order }. Declared before /tools/:toolId. */
router.put('/tools/recovery-order', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateRecoveryOrderInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.json({ order: await setRecoveryOrder(req.tenantId!, parsed.value.order, parsed.value.expectedOrder, actorOf(req)) });
  } catch (err) {
    sendError(res, err, 'Failed to save the recovery order');
  }
});

router.put('/tools/:toolId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!INVENTORY_ID_PATTERN.test(idOf(req, 'toolId'))) return notFound(res, 'Tool');
  const expected = expectedOf(req, res);
  if (expected === null) return;
  const parsed = validateToolInput(req.body, true);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.json(await updateTool(req.tenantId!, idOf(req, 'toolId'), parsed.value, expected, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to update the entry');
  }
});

router.get('/tools/:toolId/usage', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!INVENTORY_ID_PATTERN.test(idOf(req, 'toolId'))) return notFound(res, 'Tool');
  try {
    if (!(await getTool(req.tenantId!, idOf(req, 'toolId')))) return notFound(res, 'Tool');
    res.json(await toolUsage(req.tenantId!, idOf(req, 'toolId')));
  } catch (err) {
    sendError(res, err, 'Failed to read the usage');
  }
});

router.delete('/tools/:toolId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!INVENTORY_ID_PATTERN.test(idOf(req, 'toolId'))) return notFound(res, 'Tool');
  try {
    const id = idOf(req, 'toolId');
    if (!(await deleteTool(req.tenantId!, id, actorOf(req)))) return notFound(res, 'Tool');
    console.log(`[Inventory API] ${req.user?.uid} removed ${id} from ${req.tenantId}`);
    res.json({ removed: id });
  } catch (err) {
    sendError(res, err, 'Failed to delete the entry');
  }
});

router.get('/tool-memberships', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ memberships: await listToolMemberships(req.tenantId!) });
  } catch (err) {
    sendError(res, err, 'Failed to list the boundaries');
  }
});

// ------------------------------------------------------------------------------------------------ vendors

router.get('/vendors', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ vendors: await listVendors(req.tenantId!), limit: MAX_VENDORS_PER_TENANT });
  } catch (err) {
    sendError(res, err, 'Failed to list the register');
  }
});

router.post('/vendors', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateVendorInput(req.body, false);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.status(201).json({ vendor: await createVendor(req.tenantId!, parsed.value, actorOf(req)) });
  } catch (err) {
    sendError(res, err, 'Failed to add the entry');
  }
});

router.put('/vendors/:vendorId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!INVENTORY_ID_PATTERN.test(idOf(req, 'vendorId'))) return notFound(res, 'Vendor');
  const expected = expectedOf(req, res);
  if (expected === null) return;
  const parsed = validateVendorInput(req.body, true);
  if (!parsed.ok) return invalid(res, parsed.error);
  try {
    res.json(await updateVendor(req.tenantId!, idOf(req, 'vendorId'), parsed.value, expected, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to update the entry');
  }
});

router.delete('/vendors/:vendorId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!INVENTORY_ID_PATTERN.test(idOf(req, 'vendorId'))) return notFound(res, 'Vendor');
  try {
    const id = idOf(req, 'vendorId');
    if (!(await deleteVendor(req.tenantId!, id, actorOf(req)))) return notFound(res, 'Vendor');
    console.log(`[Inventory API] ${req.user?.uid} removed ${id} from ${req.tenantId}`);
    res.json({ removed: id });
  } catch (err) {
    sendError(res, err, 'Failed to delete the entry');
  }
});

// ------------------------------------------------------------------------------------------------ history

/** GET /events[?entityId=&limit=n] -> { events }: newest first (at most 200); without a write role the cost digests are left out. */
router.get('/events', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const entityId = typeof req.query.entityId === 'string' ? req.query.entityId : undefined;
  if (entityId !== undefined && !INVENTORY_ID_PATTERN.test(entityId)) return invalid(res, 'entityId is invalid');
  const limit = Number(req.query.limit);
  try {
    const events = await listInventoryEvents(req.tenantId!, { entityId, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined });
    res.json({ events: redactEventsForRole(events, canRoleWrite(req.tenantRole)) });
  } catch (err) {
    sendError(res, err, 'Failed to read the history');
  }
});

export default router;
