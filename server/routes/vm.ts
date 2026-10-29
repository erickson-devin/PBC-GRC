import { Router, Request, Response } from 'express';
import { VmTokenError, createVmToken, listVmTokens, revokeVmToken } from '../vm/tokens';
import { getRun, listRuns, listSources, resetRunForReprocess } from '../vm/store';
import { listFindings } from '../vm/findingsStore';
import { enqueueVmRun, isVmRunActive, recoverStaleRuns } from '../vm/worker';
import {
  VmSnapshotError,
  lastManualSnapshotAt,
  listVmSnapshots,
  noteManualSnapshot,
  readLatestSnapshot,
  runVmSnapshot,
} from '../vm/snapshotWriter';
import { VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS, manualSnapshotAllowed } from '../vm/snapshot';
import { ensureActiveTenant, ensureTenantAdmin } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';
import { VM_FINDING_STATUSES, VM_SEVERITIES, VM_TOKEN_SCOPES } from '../../src/types/vm';
import type { VmFindingStatus, VmSeverity, VmTokenScope } from '../../src/types/vm';

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
  if (err instanceof VmSnapshotError) {
    if (err.code === 'in_progress') {
      res.status(409).json({ error: 'vm_snapshot_in_progress' });
      return;
    }
    if (err.code === 'no_sources') {
      res.status(409).json({ error: 'vm_no_sources' });
      return;
    }
    if (err.code === 'requires_local_storage') {
      res.status(503).json({ error: 'vm_requires_local_storage' });
      return;
    }
    if (err.code === 'integrity') {
      res.status(409).json({ error: 'vm_snapshot_integrity_mismatch' });
      return;
    }
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
    const all = await listRuns(req.tenantId!, { limit });
    void recoverStaleRuns(req.tenantId!);
    const runs = all.map(({ rawPath: _rawPath, ...rest }) => rest);
    res.json({ tenantId: req.tenantId, totalCount: runs.length, runs });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the runs');
  }
});

/**
 * POST .../vm/runs/:id/reprocess (owner / admin, by requireWriteRole): puts the run back to RECEIVED and normalizes it again.
 * The worker re-verifies the stored payload against its recorded checksum first; sightings and the reducer are idempotent.
 */
router.post('/runs/:id/reprocess', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = String(req.params.id);
  if (!TOKEN_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  try {
    const run = await getRun(req.tenantId!, id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    if ((run.status === 'RECEIVED' || run.status === 'NORMALIZING') && isVmRunActive(id)) {
      res.status(409).json({ error: 'vm_run_in_progress' });
      return;
    }
    await resetRunForReprocess(req.tenantId!, id);
    enqueueVmRun(req.tenantId!, id);
    console.log('[VM API] ' + req.user?.uid + ' reprocessed run ' + id + ' in ' + req.tenantId);
    res.status(202).json({ run_id: id, status: 'RECEIVED' });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to reprocess the run');
  }
});

/** GET .../vm/findings?assetId=&severity=&status=&limit=: most severe first, then earliest deadline. */
router.get('/findings', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { assetId, severity, status, limit: rawLimit } = req.query;
  if (assetId !== undefined && (typeof assetId !== 'string' || !TOKEN_ID_PATTERN.test(assetId))) {
    res.status(400).json({ error: 'Invalid assetId' });
    return;
  }
  if (severity !== undefined && !(typeof severity === 'string' && (VM_SEVERITIES as readonly string[]).includes(severity))) {
    res.status(400).json({ error: 'Invalid severity: ' + VM_SEVERITIES.join(', ') });
    return;
  }
  if (status !== undefined && !(typeof status === 'string' && (VM_FINDING_STATUSES as readonly string[]).includes(status))) {
    res.status(400).json({ error: 'Invalid status: ' + VM_FINDING_STATUSES.join(', ') });
    return;
  }
  let limit = 500;
  if (rawLimit !== undefined) {
    const n = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      res.status(400).json({ error: 'Invalid limit: between 1 and 1000' });
      return;
    }
    limit = n;
  }
  try {
    const findings = await listFindings(req.tenantId!, {
      assetId: assetId as string | undefined,
      severity: severity as VmSeverity | undefined,
      status: status as VmFindingStatus | undefined,
      limit,
    });
    res.json({ tenantId: req.tenantId, totalCount: findings.length, findings });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the findings');
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

/**
 * POST .../vm/snapshot (owner / admin, by requireWriteRole): evaluates the three assessor criteria now and writes the
 * evidence and control notes. At most one a minute per tenant (counted only after a success); the scheduler is exempt.
 */
router.post('/snapshot', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const nowMs = Date.now();
  const last = lastManualSnapshotAt(tenantId);
  if (!manualSnapshotAllowed(last, nowMs)) {
    const retryAfterSeconds = Math.max(1, Math.ceil((VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS - (nowMs - (last as number))) / 1000));
    res.status(429).json({ error: 'vm_snapshot_too_soon', retryAfterSeconds });
    return;
  }
  try {
    // The snapshot belongs to the tenant's VM target program (the default when none is set), whatever x-program-id says.
    const { snapshot } = await runVmSnapshot(tenantId, {
      trigger: 'manual',
      triggeredBy: { actor: req.user?.name || req.user?.email || 'Compliance Assessor', userId: req.user?.uid ?? null },
    });
    noteManualSnapshot(tenantId, Date.now());
    console.log('[VM API] ' + req.user?.uid + ' created snapshot ' + snapshot.id + ' in ' + tenantId);
    res.status(201).json({ snapshot });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to create the snapshot');
  }
});

/** GET .../vm/snapshots: the tenant's snapshots, newest first (at most 100). Open to every role, like /findings. */
router.get('/snapshots', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const snapshots = await listVmSnapshots(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: snapshots.length, snapshots });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the snapshots');
  }
});

/** GET .../vm/snapshot/latest: the newest snapshot with its report, after checking the stored file against its recorded sha256. */
router.get('/snapshot/latest', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const latest = await readLatestSnapshot(req.tenantId!);
    if (!latest) {
      res.status(404).json({ error: 'vm_snapshot_not_found' });
      return;
    }
    res.json({ snapshot: latest.snapshot, report: latest.report });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the snapshot');
  }
});

export default router;
