import { Router, Request, Response } from 'express';
import { SoftwareError, createSoftware, deleteSoftware, getSoftware, listSoftware, updateSoftware, validateSoftwareInput } from '../softwareItems';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';

/**
 * Software inventory (issue #229). Mounted at /api/v1/tenants/:tenantId/software.
 *
 *   GET    /           every software entry          any member (VIEWER, ASSESSOR, ...)
 *   POST   /           add an entry                  TENANT_OWNER / MSP_ADMIN
 *   PUT    /:itemId    change fields                 TENANT_OWNER / MSP_ADMIN
 *   DELETE /:itemId    remove an entry               TENANT_OWNER / MSP_ADMIN
 *
 * The RBAC guard is applied here as well as at the tenants router: VIEWER and ASSESSOR are strictly read-only.
 * Names, versions, vendors and notes may be CUI: the logs carry ids only.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const itemIdOf = (req: Request): string => String(req.params.itemId);
const actorOf = (req: Request): string => {
  const u = req.user!;
  return u.name ? `${u.name} (${u.email ?? u.uid})` : u.email ?? u.uid;
};

function sendSoftwareError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof SoftwareError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'limit' ? 429 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[Software API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ items: await listSoftware(req.tenantId!) });
  } catch (err) {
    sendSoftwareError(res, err, 'Failed to list software');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateSoftwareInput(req.body, false);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: 'invalid' });
    return;
  }
  try {
    const item = await createSoftware(req.tenantId!, parsed.value, actorOf(req));
    res.status(201).json({ item });
  } catch (err) {
    sendSoftwareError(res, err, 'Failed to add software');
  }
});

router.put('/:itemId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!ITEM_ID.test(itemIdOf(req))) {
    res.status(404).json({ error: 'Software entry not found', code: 'not_found' });
    return;
  }
  const parsed = validateSoftwareInput(req.body, true);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: 'invalid' });
    return;
  }
  try {
    const item = await updateSoftware(req.tenantId!, itemIdOf(req), parsed.value, actorOf(req));
    res.json({ item });
  } catch (err) {
    sendSoftwareError(res, err, 'Failed to update software');
  }
});

router.delete('/:itemId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!ITEM_ID.test(itemIdOf(req))) {
    res.status(404).json({ error: 'Software entry not found', code: 'not_found' });
    return;
  }
  try {
    const existing = await getSoftware(req.tenantId!, itemIdOf(req));
    if (!existing || !(await deleteSoftware(req.tenantId!, itemIdOf(req)))) {
      res.status(404).json({ error: 'Software entry not found', code: 'not_found' });
      return;
    }
    console.log(`[Software API] ${req.user?.uid} removed software entry ${existing.id} from ${req.tenantId}`);
    res.json({ removed: existing.id });
  } catch (err) {
    sendSoftwareError(res, err, 'Failed to delete software');
  }
});

export default router;
