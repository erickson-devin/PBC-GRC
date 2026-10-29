import { Router, Request, Response } from 'express';
import {
  AssetError,
  MAX_BULK_ASSETS,
  createAsset,
  createAssetsBulk,
  deleteAsset,
  getAsset,
  ingestDiscovery,
  listAssets,
  updateAsset,
  validateAssetInput,
  validateDiscoveryItems,
} from '../assets';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { summarizeScope } from '../../src/data/telemetry/assetScope';
import { errorMessage } from '../../src/utils/errors';

/**
 * CMMC asset scoping: the enclave's asset inventory and boundary. Mounted at /api/v1/tenants/:tenantId/assets.
 *
 *   GET    /            every asset plus the scope summary             any member (VIEWER, ASSESSOR, ...)
 *   GET    /summary     the scope summary only (counts per category)   any member
 *   POST   /            register an asset                              TENANT_OWNER / MSP_ADMIN
 *   POST   /bulk        register many (CSV import), max 500            TENANT_OWNER / MSP_ADMIN
 *   POST   /discovery   ingest network-sensor findings                 TENANT_OWNER / MSP_ADMIN
 *   PUT    /:assetId    change fields (including the CMMC category)   TENANT_OWNER / MSP_ADMIN
 *                       and the FIPS module record (Security Protection / CUI assets only)
 *   DELETE /:assetId    remove an asset                                TENANT_OWNER / MSP_ADMIN
 *
 * The RBAC guard is applied here as well as at the tenants router: VIEWER and ASSESSOR are strictly read-only.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const assetIdOf = (req: Request): string => String(req.params.assetId);
const actorOf = (req: Request): string => {
  const u = req.user!;
  return u.name ? `${u.name} (${u.email ?? u.uid})` : u.email ?? u.uid;
};

function sendAssetError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof AssetError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'duplicate' ? 409 : err.code === 'invalid' ? 400 : 429;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[Assets API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const assets = await listAssets(req.tenantId!);
    res.json({ assets, summary: summarizeScope(assets) });
  } catch (err) {
    sendAssetError(res, err, 'Failed to list assets');
  }
});

router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ summary: summarizeScope(await listAssets(req.tenantId!)) });
  } catch (err) {
    sendAssetError(res, err, 'Failed to summarize assets');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateAssetInput(req.body, false);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const asset = await createAsset(req.tenantId!, parsed.value, actorOf(req));
    res.status(201).json({ asset });
  } catch (err) {
    sendAssetError(res, err, 'Failed to create asset');
  }
});

router.post('/bulk', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const list = (req.body as { assets?: unknown } | undefined)?.assets;
  if (!Array.isArray(list) || list.length === 0) {
    res.status(400).json({ error: 'assets must be a non-empty list' });
    return;
  }
  if (list.length > MAX_BULK_ASSETS) {
    res.status(400).json({ error: `At most ${MAX_BULK_ASSETS} assets per request` });
    return;
  }
  // All-or-nothing validation first, so one malformed row is reported by index instead of half the file landing.
  const inputs = [];
  for (const [index, raw] of list.entries()) {
    const parsed = validateAssetInput(raw, false);
    if (!parsed.ok) {
      res.status(400).json({ error: `assets[${index}]: ${parsed.error}`, index });
      return;
    }
    inputs.push(parsed.value);
  }
  try {
    const result = await createAssetsBulk(req.tenantId!, inputs, actorOf(req));
    res.status(201).json(result);
  } catch (err) {
    sendAssetError(res, err, 'Failed to import assets');
  }
});

router.post('/discovery', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateDiscoveryItems(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await ingestDiscovery(req.tenantId!, parsed.value, actorOf(req));
    res.json(result);
  } catch (err) {
    sendAssetError(res, err, 'Failed to ingest discovery results');
  }
});

router.put('/:assetId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!ASSET_ID.test(assetIdOf(req))) {
    res.status(404).json({ error: 'Asset not found', code: 'not_found' });
    return;
  }
  const parsed = validateAssetInput(req.body, true);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const asset = await updateAsset(req.tenantId!, assetIdOf(req), parsed.value, actorOf(req));
    res.json({ asset });
  } catch (err) {
    sendAssetError(res, err, 'Failed to update asset');
  }
});

router.delete('/:assetId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!ASSET_ID.test(assetIdOf(req))) {
    res.status(404).json({ error: 'Asset not found', code: 'not_found' });
    return;
  }
  try {
    const existing = await getAsset(req.tenantId!, assetIdOf(req));
    if (!existing || !(await deleteAsset(req.tenantId!, assetIdOf(req)))) {
      res.status(404).json({ error: 'Asset not found', code: 'not_found' });
      return;
    }
    console.log(`[Assets API] ${req.user?.uid} removed asset ${existing.id} from ${req.tenantId}`);
    res.json({ removed: existing.id });
  } catch (err) {
    sendAssetError(res, err, 'Failed to delete asset');
  }
});

export default router;
