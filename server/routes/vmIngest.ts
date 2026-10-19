import crypto from 'crypto';
import fs from 'fs';
import express, { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import { serviceTokenMiddleware } from '../middleware/serviceTokenMiddleware';
import { validateIngestPayload, vmIngestMaxBytes } from '../vm/ingestSchema';
import { findRunBySha, recordReceivedRun, VmStoreError } from '../vm/store';
import { storageProvider, writeTenantFile } from '../evidence/storage';
import { errorMessage } from '../../src/utils/errors';

/**
 * Scanner push endpoint (mounted at /api/v1/vm), authenticated by a service token, never a user session.
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

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

async function ingestHandler(req: Request, res: Response): Promise<void> {
  if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) {
    res.status(415).json({ error: 'unsupported_media_type' });
    return;
  }
  if (storageProvider() !== 'local') {
    res.status(503).json({ error: 'vm_requires_local_storage' });
    return;
  }
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: '$: request body is required' });
    return;
  }

  const tenantId = req.tenantId!;
  const actor = 'service-token:' + req.serviceToken!.id;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  try {
    const existing = await findRunBySha(tenantId, sha256);
    if (existing) {
      res.status(200).json({ run_id: existing.id, status: existing.status, sha256, duplicate: true });
      return;
    }
  } catch (err: unknown) {
    console.error('[VM Ingest] lookup failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to record the payload' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.status(400).json({ error: '$: body is not valid JSON' });
    return;
  }
  const validation = validateIngestPayload(parsed);
  if (!validation.ok) {
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
      findingCount: payload.hosts.reduce((n, h) => n + h.findings.length, 0),
      rawPath: stored.absPath,
      rawSha256: sha256,
      rawBytes: stored.size,
    });
    console.log(`[VM Ingest] ${actor} -> run ${run.id} in ${tenantId}: ${run.hostCount} hosts, ${run.findingCount} findings`);
    // Phase 3: enqueueVmRun(tenantId, run.id)
    res.status(202).json({ run_id: run.id, status: 'RECEIVED', sha256 });
  } catch (err: unknown) {
    await fs.promises.rm(stored.absPath, { force: true }).catch(() => undefined);
    if (err instanceof VmStoreError && err.code === 'duplicate') {
      // A concurrent request with the same bytes won the race: answer as for any repeat.
      try {
        const winner = await findRunBySha(tenantId, sha256);
        if (winner) {
          res.status(200).json({ run_id: winner.id, status: winner.status, sha256, duplicate: true });
          return;
        }
      } catch (lookupErr: unknown) {
        console.error('[VM Ingest] lookup failed:', errorMessage(lookupErr));
      }
      res.status(500).json({ error: 'Failed to record the payload' });
      return;
    }
    if (err instanceof VmStoreError && err.code === 'source_kind_mismatch') {
      res.status(409).json({ error: 'vm_source_kind_mismatch' });
      return;
    }
    console.error('[VM Ingest] could not record the run:', errorMessage(err));
    res.status(500).json({ error: 'Failed to record the payload' });
  }
}

router.post(
  '/ingest',
  vmIngestRateLimiter,
  serviceTokenMiddleware('vm:ingest'),
  vmTokenRateLimiter,
  express.raw({ type: 'application/json', limit: vmIngestMaxBytes(), inflate: false }),
  ingestHandler,
);

router.use((err: { type?: string }, _req: Request, res: Response, next: NextFunction): void => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (err?.type === 'encoding.unsupported') {
    res.status(415).json({ error: 'unsupported_content_encoding' });
    return;
  }
  next(err);
});

export default router;
