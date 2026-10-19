import { Router, Request, Response } from 'express';
import { VmTokenError, createVmToken, listVmTokens, revokeVmToken } from '../vm/tokens';
import { listRuns, listSources } from '../vm/store';
import { ensureActiveTenant, ensureTenantAdmin } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';
import { VM_TOKEN_SCOPES } from '../../src/types/vm';
import type { VmTokenScope } from '../../src/types/vm';

/**
 * Tenant-scoped vulnerability management, mounted at /api/v1/tenants/:tenantId/vm by the tenants router, AFTER
 * requireWriteRole: creating and revoking service tokens is already limited to TENANT_OWNER / MSP_ADMIN.
 * The plaintext token is only ever returned by create, once.
 */
const router = Router({ mergeParams: true });

const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof VmTokenError && err.code === 'not_found') {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof VmTokenError && err.code === 'limit') {
    res.status(429).json({ error: err.message, code: 'limit' });
    return;
  }
  console.error('[VM API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

/**
 * POST /api/v1/tenants/:tenantId/vm/tokens
 * Body: { name, scopes?, expiresInDays? }. Returns { token, record }: the token is shown ONCE; the server keeps only its hash.
 * Refused over plain HTTP (the secret would cross the network in clear text) unless VM_ALLOW_INSECURE_TOKENS=true.
 */
router.post('/tokens', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const overridden = !req.secure && process.env.VM_ALLOW_INSECURE_TOKENS === 'true';
  if (!req.secure && !overridden) {
    res.status(403).json({ error: 'vm_insecure_transport' });
    return;
  }

  const { name, scopes, expiresInDays } = req.body ?? {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 255 || CONTROL_CHARS.test(trimmed)) {
    res.status(400).json({ error: 'Invalid name: 1 to 255 characters, no control characters' });
    return;
  }
  let tokenScopes: VmTokenScope[] = ['vm:ingest'];
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => (VM_TOKEN_SCOPES as readonly unknown[]).includes(s))) {
      res.status(400).json({ error: 'Invalid scopes: expected a non-empty list of ' + VM_TOKEN_SCOPES.join(', ') });
      return;
    }
    tokenScopes = [...new Set(scopes as VmTokenScope[])];
  }
  if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || !Number.isFinite(expiresInDays))) {
    res.status(400).json({ error: 'Invalid expiresInDays: expected a number' });
    return;
  }

  const user = req.user!;
  try {
    const { token, record } = await createVmToken(req.tenantId!, {
      name: trimmed,
      scopes: tokenScopes,
      expiresInDays,
      createdBy: user.name ? user.name + ' (' + (user.email ?? user.uid) + ')' : user.email ?? user.uid,
      createdByUserId: user.uid,
    });
    if (overridden) {
      console.warn('[VM API] service token ' + record.id + ' created over plain HTTP (VM_ALLOW_INSECURE_TOKENS=true) in ' + req.tenantId);
    }
    console.log('[VM API] ' + user.uid + ' created service token ' + record.id + ' in ' + req.tenantId);
    res.status(201).json({ token, record });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to create the service token');
  }
});

/** GET .../vm/tokens: every service token (active, revoked, expired). Never the token or its hash. */
router.get('/tokens', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res) || !ensureTenantAdmin(req, res)) return;
  try {
    const tokens = await listVmTokens(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: tokens.length, tokens });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the service tokens');
  }
});

/** POST .../vm/tokens/:id/revoke: idempotent. */
router.post('/tokens/:id/revoke', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = String(req.params.id);
  if (!TOKEN_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Service token not found' });
    return;
  }
  try {
    const token = await revokeVmToken(req.tenantId!, id);
    console.log('[VM API] ' + req.user?.uid + ' revoked service token ' + token.id + ' in ' + req.tenantId);
    res.json({ token });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to revoke the service token');
  }
});

/** GET .../vm/runs?limit=: received runs, newest first. The server-side storage path is not exposed. */
router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const rawLimit = req.query.limit;
  let limit = 100;
  if (rawLimit !== undefined) {
    const n = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      res.status(400).json({ error: 'Invalid limit: between 1 and 500' });
      return;
    }
    limit = n;
  }
  try {
    const runs = (await listRuns(req.tenantId!, { limit })).map(({ rawPath: _rawPath, ...rest }) => rest);
    res.json({ tenantId: req.tenantId, totalCount: runs.length, runs });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the runs');
  }
});

/** GET .../vm/sources */
router.get('/sources', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const sources = await listSources(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: sources.length, sources });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the sources');
  }
});

export default router;
