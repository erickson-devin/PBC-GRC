import crypto from 'crypto';
import fs from 'fs';
import express, { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import { serviceTokenMiddleware } from '../middleware/serviceTokenMiddleware';
import { validateIngestPayload, vmIngestMaxBytes } from '../vm/ingestSchema';
import { listVmTokens, recordVmTokenPush } from '../vm/tokens';
import { findRunBySha, recordReceivedRun, VmStoreError } from '../vm/store';
import { enqueueVmRun, recoverStaleRuns } from '../vm/worker';
import { isLocalStorageConfigured, writeTenantFile } from '../evidence/storage';
import { errorMessage } from '../../src/utils/errors';
import type { VmPushErrorCode } from '../../src/types/vm';
import { fileURLToPath } from 'url';

/**
 * Scanner push endpoint (mounted at /api/v1/vm), authenticated by a service token, never a user session.
 *  - GET /whoami: what the exporter's `check` command asks (token name, scopes, contract hash, size limit). No tenant id, no hash.
 *  - POST /ingest: the exact request bytes are hashed, stored under the tenant's vault and recorded as a RECEIVED run.
 * The global JSON parser skips this path (server/index.ts): the body is read here as raw bytes with its own size limit.
 */
const router = Router();

export const vmIngestRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
export const vmTokenRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  key: (req) => 'token:' + (req.serviceToken?.id ?? '-'),
});

/** sha256 of the exact bytes of the ingest contract, computed once: an exporter compares it with its vendored copy. */
const CONTRACT_SHA256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(fileURLToPath(new URL('../vm/ingest.schema.json', import.meta.url))))
  .digest('hex');

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/** Records the token's latest push outcome (fixed code only). Never fails the request and never logs the tenant, the token id or the body. */
async function notePush(req: Request, code: VmPushErrorCode | null): Promise<void> {
  const t = req.serviceToken;
  if (!t) return;
  try {
    await recordVmTokenPush(t.tenantId, t.id, code);
  } catch (err: unknown) {
    console.error('[VM Ingest] could not record the push outcome:', errorMessage(err));
  }
}

async function ingestHandler(req: Request, res: Response): Promise<void> {
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
    await notePush(req, 'media_type');
    res.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  if (!isLocalStorageConfigured()) {
    await notePush(req, 'storage');
    res.status(503).json({ error: 'vm_requires_local_storage' });
    return;
  }
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    await notePush(req, 'validation');
    res.status(400).json({ error: '$: request body is required' });
    return;
  }

  const tenantId = req.tenantId!;
  const actor = 'service-token:' + req.serviceToken!.id;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  try {
    const existing = await findRunBySha(tenantId, sha256);
    if (existing) {
      await notePush(req, null);
      res.status(200).json({ run_id: existing.id, status: existing.status, sha256, duplicate: true });
      return;
    }
  } catch (err: unknown) {
    console.error('[VM Ingest] lookup failed:', errorMessage(err));
    await notePush(req, 'storage');
    res.status(500).json({ error: 'Failed to record the payload' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    await notePush(req, 'validation');
    res.status(400).json({ error: '$: body is not valid JSON' });
    return;
  }
  const validation = validateIngestPayload(parsed);
  if (!validation.ok) {
    await notePush(req, 'validation');
    res.status(400).json({ error: validation.error });
    return;
  }
  const payload = validation.value;

  const runId = crypto.randomUUID();
  let stored: { absPath: string; sha256: string; size: number };
  try {
    stored = await writeTenantFile(tenantId, 'vm/runs/' + runId + '.json', body, { exclusive: true });
  } catch (err: unknown) {
    console.error('[VM Ingest] could not store the payload:', errorMessage(err));
    await notePush(req, 'storage');
    res.status(500).json({ error: 'Failed to store the payload' });
    return;
  }

  try {
    const { run } = await recordReceivedRun(tenantId, {
      id: runId,
      kind: payload.source.kind,
      label: payload.source.label,
      collectedAt: payload.collected_at,
      exporterName: payload.exporter.name,
      exporterVersion: payload.exporter.version,
      hostCount: payload.hosts.length,
      findingCount: payload.hosts.reduce((n, h) => n + (h.findings?.length ?? 0), 0),
      configResultCount: payload.hosts.reduce((n, h) => n + (h.configuration ?? []).reduce((m, s) => m + s.results.length, 0), 0),
      rawPath: stored.absPath,
      rawSha256: sha256,
      rawBytes: stored.size,
      tokenId: req.serviceToken!.id,
    });
    console.log(`[VM Ingest] ${actor} -> run ${run.id} in ${tenantId}: ${run.hostCount} hosts, ${run.findingCount} findings, ${run.configResultCount} configuration results`);
    enqueueVmRun(tenantId, run.id);
    void recoverStaleRuns(tenantId);
    await notePush(req, null);
    res.status(202).json({ run_id: run.id, status: 'RECEIVED', sha256 });
  } catch (err: unknown) {
    await fs.promises.rm(stored.absPath, { force: true }).catch(() => undefined);
    if (err instanceof VmStoreError && err.code === 'duplicate') {
      // A concurrent request with the same bytes won the race: answer as for any repeat.
      try {
        const winner = await findRunBySha(tenantId, sha256);
        if (winner) {
          await notePush(req, null);
          res.status(200).json({ run_id: winner.id, status: winner.status, sha256, duplicate: true });
          return;
        }
      } catch (lookupErr: unknown) {
        console.error('[VM Ingest] lookup failed:', errorMessage(lookupErr));
      }
      await notePush(req, 'storage');
      res.status(500).json({ error: 'Failed to record the payload' });
      return;
    }
    if (err instanceof VmStoreError && err.code === 'source_kind_mismatch') {
      await notePush(req, 'kind_mismatch');
      res.status(409).json({ error: 'vm_source_kind_mismatch' });
      return;
    }
    console.error('[VM Ingest] could not record the run:', errorMessage(err));
    await notePush(req, 'storage');
    res.status(500).json({ error: 'Failed to record the payload' });
  }
}

/** The service token is a bearer secret: refuse it over plain HTTP, the same rule as token creation (vm.ts). Runs after authentication, so a missing token is still a 401. */
function requireSecureTransport(req: Request, res: Response, next: NextFunction): void {
  if (!req.secure && process.env.VM_ALLOW_INSECURE_TOKENS !== 'true') {
    res.status(403).json({ error: 'The ingest endpoint requires HTTPS', code: 'vm_insecure_transport' });
    return;
  }
  next();
}

/** Same check for the ingest route, which also records the refusal on the token (the whoami route has no push to record). */
async function requireSecureIngestTransport(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.secure && process.env.VM_ALLOW_INSECURE_TOKENS !== 'true') {
    await notePush(req, 'insecure');
    res.status(403).json({ error: 'The ingest endpoint requires HTTPS', code: 'vm_insecure_transport' });
    return;
  }
  next();
}

/** The caller's own token record (it authenticated moments ago, so it exists); never the hash or the tenant id. */
async function whoamiHandler(req: Request, res: Response): Promise<void> {
  const caller = req.serviceToken!;
  try {
    const record = (await listVmTokens(caller.tenantId)).find((t) => t.id === caller.id);
    if (!record) {
      res.status(401).json({ error: 'Unauthorized: invalid service token' });
      return;
    }
    res.status(200).json({
      token: { name: record.name, prefix: record.tokenPrefix, expires_at: record.expiresAt },
      scopes: caller.scopes,
      contract_sha256: CONTRACT_SHA256,
      limits: { max_bytes: vmIngestMaxBytes() },
      features: ['whoami'],
    });
  } catch (err: unknown) {
    console.error('[VM Ingest] whoami failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to read the service token' });
  }
}

router.get('/whoami', vmIngestRateLimiter, serviceTokenMiddleware('vm:ingest'), requireSecureTransport, vmTokenRateLimiter, whoamiHandler);

router.post(
  '/ingest',
  vmIngestRateLimiter,
  serviceTokenMiddleware('vm:ingest'),
  requireSecureIngestTransport,
  vmTokenRateLimiter,
  express.raw({ type: 'application/json', limit: vmIngestMaxBytes(), inflate: false }),
  ingestHandler,
);

router.use(async (err: { type?: string }, req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (err?.type === 'entity.too.large') {
    await notePush(req, 'too_large');
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (err?.type === 'encoding.unsupported') {
    await notePush(req, 'media_type');
    res.status(415).json({ error: 'unsupported_content_encoding' });
    return;
  }
  next(err);
});

export default router;
