import express, { Router, Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { queryWithProgram, type ProgramScope } from '../db';
import { requireWriteRole } from '../middleware/roleGuard';
import { getEquivalentControlIds } from '../../src/data/frameworks/controlMappings';
import { ensureControlInFrameworkPolicy } from '../middleware/frameworkGuard';
import { errorMessage } from '../../src/utils/errors';
import { VM_SNAPSHOT_ACTOR } from '../vm/snapshot';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may GET but never POST / PUT / DELETE (uploads included).
router.use(requireWriteRole);

// Evidence is controlled data: never let a browser or proxy cache a response (set before send, so sendFile keeps it).
router.use((_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Storage: local disk only (server/index.ts refuses any other STORAGE_PROVIDER at startup).
// The `storageProvider` / `provider` response fields stay (always 'local') so existing clients keep working.
const storageProvider = 'local' as const;
const localStoragePath = path.resolve(process.env.LOCAL_STORAGE_PATH || './data/evidence');

// Ensure the local evidence directory exists
try {
  fs.mkdirSync(localStoragePath, { recursive: true });
  console.log(`[Evidence Storage] Local Enclave Storage active at: ${localStoragePath}`);
} catch (err: unknown) {
  console.warn(`[Evidence Storage] Local storage directory setup notice: ${errorMessage(err)}`);
}

/** The tenant and program of the request (set by authMiddleware and the programContext middleware that is mounted before this router). */
const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });

const CONTROL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Resolves `candidate` and returns it only if it stays inside `root` (path-traversal guard).
 * Returns null for anything that escapes the root or is the root itself.
 */
function resolveWithin(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

/** Local evidence for a tenant may only live under <localStoragePath>/tenants/<tenantId>/. */
function resolveTenantLocalPath(tenantId: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate || candidate.startsWith('gs://')) return null;
  return resolveWithin(path.join(localStoragePath, 'tenants', tenantId), candidate);
}

function mapRowToEvidence(row: pg.QueryResultRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    controlId: row.control_id,
    name: row.file_name,
    fileSize: typeof row.file_size === 'number' ? row.file_size : parseInt(row.file_size, 10) || 0,
    mimeType: row.mime_type || 'application/octet-stream',
    gcsPath: row.gcs_path,
    fileHash: row.file_hash,
    syncStatus: row.sync_status || 'local_storage',
    description: row.description || '',
    uploadedBy: row.uploaded_by || '',
    uploadedAt: row.uploaded_at || new Date().toISOString(),
  };
}

/**
 * GET /api/v1/evidence/config/storage-info
 * Returns storage provider status, path, and air-gapped configuration.
 */
router.get('/config/storage-info', async (_req: Request, res: Response): Promise<void> => {
  res.json({
    provider: storageProvider,
    localStoragePath,
    isAirGapped: true,
    status: 'ACTIVE',
  });
});

/**
 * POST /api/v1/evidence/upload-url
 * Generates an upload URL for evidence artifacts:
 * Generates a relative local upload endpoint (/upload-local/:id).
 * Saves initial metadata to evidence table.
 */
router.post('/upload-url', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const {
    controlId,
    fileName,
    fileSize,
    mimeType,
    fileHash, // SHA-256 cryptographic hash computed on client or pipeline
    description,
  } = req.body;

  if (!controlId || !fileName || !fileHash) {
    res.status(400).json({
      error: 'Missing required parameters: controlId, fileName, and fileHash (SHA-256) are required',
    });
    return;
  }

  if (typeof controlId !== 'string' || !CONTROL_ID_PATTERN.test(controlId) || controlId === '.' || controlId === '..') {
    res.status(400).json({
      error: 'Invalid controlId: only letters, digits, dots, underscores and hyphens are allowed',
    });
    return;
  }

  if (typeof fileName !== 'string' || typeof fileHash !== 'string') {
    res.status(400).json({ error: 'Invalid fileName or fileHash: expected strings' });
    return;
  }

  // Framework segregation: evidence can only be attached to a control inside this tenant's assessment program
  if (!(await ensureControlInFrameworkPolicy(req, res, controlId))) return;

  const evidenceId = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectPath = `tenants/${tenantId}/controls/${controlId}/${evidenceId}_${cleanFileName}`;
  const effectiveMime = mimeType || 'application/octet-stream';
  const effectiveSize = fileSize || 0;
  const effectiveUser = req.user?.name || req.user?.email || 'Compliance Assessor';

  // On-premises enclave: upload to the local Express handler
  const safeLocalPath = resolveWithin(localStoragePath, objectPath);
  if (!safeLocalPath) {
    res.status(400).json({ error: 'Invalid evidence path: resolved location is outside the evidence store' });
    return;
  }
  const signedUploadUrl = `/api/v1/evidence/upload-local/${evidenceId}`;
  const storedStoragePath = safeLocalPath;
  const initialSyncStatus = 'local_storage';

  try {
    // Save record to evidence_metadata guarded by RLS tenant context
    const insertQuery = `
      INSERT INTO evidence_metadata (
        id, tenant_id, control_id, file_name, file_size, mime_type,
        gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12
      )
      RETURNING *;
    `;

    const scope = scopeOf(req);
    const result = await queryWithProgram(scope, insertQuery, [
      evidenceId,
      tenantId,
      controlId,
      fileName,
      effectiveSize,
      effectiveMime,
      storedStoragePath,
      fileHash,
      initialSyncStatus,
      description || `Audit Evidence for ${controlId}`,
      effectiveUser,
      scope.programId,
    ]);

    const savedRecord = mapRowToEvidence(result.rows[0]);

    // Cross-Framework Evidence Inheritance:
    try {
      const mappedControlIds = getEquivalentControlIds(controlId);
      for (const mappedId of mappedControlIds) {
        const inhId = `${evidenceId}__inh_${mappedId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const inhDesc = `[Inherited from ${controlId}] ${description || `Audit Evidence for ${controlId}`}`;
        const inhInsert = `
          INSERT INTO evidence_metadata (
            id, tenant_id, control_id, file_name, file_size, mime_type,
            gcs_path, file_hash, sync_status, description, uploaded_by, uploaded_at, program_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, 'inherited', $9, $10, NOW(), $11
          )
          ON CONFLICT (id) DO NOTHING;
        `;
        await queryWithProgram(scope, inhInsert, [
          inhId,
          tenantId,
          mappedId,
          fileName,
          effectiveSize,
          effectiveMime,
          storedStoragePath,
          fileHash,
          inhDesc,
          effectiveUser,
          scope.programId,
        ]);
      }
    } catch (inhErr: unknown) {
      console.warn(`[Evidence API] Cross-framework inheritance notice:`, errorMessage(inhErr));
    }

    res.status(201).json({
      message: 'Evidence record created for local enclave storage',
      uploadUrl: signedUploadUrl,
      gcsPath: storedStoragePath,
      storageProvider,
      evidenceId,
      evidence: savedRecord,
      inheritedTo: getEquivalentControlIds(controlId),
    });
  } catch (dbErr: unknown) {
    console.error(`[Evidence API] Failed to store evidence metadata for tenant ${tenantId}:`, dbErr);
    res.status(500).json({
      error: 'Failed to record evidence in database',
      details: errorMessage(dbErr),
    });
  }
});

/**
 * PUT /api/v1/evidence/upload-local/:evidenceId
 * Handles direct binary uploads for On-Premises and Air-Gapped Enclaves.
 * Persists raw file to LOCAL_STORAGE_PATH, computes SHA-256 hash, and verifies integrity.
 */
const handleLocalBinaryUpload = async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const evidenceId = String(req.params.evidenceId);

  if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
    res.status(400).json({ error: 'Invalid evidence ID' });
    return;
  }

  try {
    const result = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)',
      [evidenceId, tenantId, req.programId!]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: `Evidence record ${evidenceId} not found` });
      return;
    }

    const record = result.rows[0];
    const buffer = req.body as Buffer;

    if (!buffer || buffer.length === 0) {
      res.status(400).json({ error: 'No binary data received in request body' });
      return;
    }

    // Calculate SHA-256 integrity hash from the buffer
    const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Determine target local file destination
    let targetFilePath = resolveTenantLocalPath(tenantId, record.gcs_path);
    if (!targetFilePath) {
      const cleanFileName = (record.file_name || 'evidence.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!CONTROL_ID_PATTERN.test(String(record.control_id))) {
        res.status(400).json({ error: 'Evidence record has an invalid control ID' });
        return;
      }
      targetFilePath = resolveWithin(
        localStoragePath,
        `tenants/${tenantId}/controls/${record.control_id}/${evidenceId}_${cleanFileName}`
      );
    }
    if (!targetFilePath) {
      res.status(400).json({ error: 'Evidence storage path is outside the evidence store' });
      return;
    }

    const targetDir = path.dirname(targetFilePath);
    fs.mkdirSync(targetDir, { recursive: true });

    // Write file to disk
    fs.writeFileSync(targetFilePath, buffer);

    // Verify hash match with metadata
    const hashMatch = !record.file_hash || record.file_hash.toLowerCase() === computedHash.toLowerCase();

    // Update metadata record with verified file size, verified hash, and local_storage status
    await queryWithProgram(
      scopeOf(req),
      'UPDATE evidence_metadata SET file_size = $1, file_hash = $2, gcs_path = $3, sync_status = $4 WHERE id = $5 AND tenant_id = $6 AND (program_id = $7 OR program_id IS NULL)',
      [buffer.length, computedHash, targetFilePath, 'local_storage', evidenceId, tenantId, req.programId!]
    );

    res.status(200).json({
      success: true,
      message: 'Evidence successfully saved to local enclave disk',
      evidenceId,
      fileSize: buffer.length,
      fileHash: computedHash,
      hashVerified: hashMatch,
      storagePath: targetFilePath,
    });
  } catch (err: unknown) {
    console.error(`[Local Evidence Upload Error]:`, err);
    res.status(500).json({
      error: 'Failed to write evidence to local disk',
      details: errorMessage(err),
    });
  }
};

router.put('/upload-local/:evidenceId', express.raw({ type: () => true, limit: '100mb' }), handleLocalBinaryUpload);
router.post('/upload-local/:evidenceId', express.raw({ type: () => true, limit: '100mb' }), handleLocalBinaryUpload);

/**
 * GET /api/v1/evidence/:evidenceId/file
 * Downloads or previews evidence file from local disk or redirects.
 */
router.get('/:evidenceId/file', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { evidenceId } = req.params;

  try {
    const result = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)',
      [evidenceId, tenantId, req.programId!]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Evidence not found' });
      return;
    }

    const record = result.rows[0];
    const filePath = resolveTenantLocalPath(tenantId, record.gcs_path);

    if (filePath && fs.existsSync(filePath)) {
      const safeDownloadName = String(record.file_name || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Type', record.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeDownloadName}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(filePath);
      return;
    }

    res.status(404).json({ error: 'File not found on local storage path' });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

/**
 * GET /api/v1/evidence/:evidenceId/verify-integrity
 * Recalculates the SHA-256 hash from local disk and validates against recorded hash.
 */
router.get('/:evidenceId/verify-integrity', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { evidenceId } = req.params;

  try {
    const result = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)',
      [evidenceId, tenantId, req.programId!]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Evidence record not found' });
      return;
    }

    const record = result.rows[0];
    const filePath = resolveTenantLocalPath(tenantId, record.gcs_path);

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Local file does not exist on disk for verification' });
      return;
    }

    const buffer = fs.readFileSync(filePath);
    const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const isMatch = computedHash.toLowerCase() === (record.file_hash || '').toLowerCase();

    res.json({
      evidenceId,
      fileName: record.file_name,
      storedHash: record.file_hash,
      currentHash: computedHash,
      verified: isMatch,
      status: isMatch ? 'INTEGRITY_VERIFIED' : 'INTEGRITY_MISMATCH',
      verifiedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

/**
 * GET /api/v1/evidence
 * Retrieves all evidence artifacts of the active program.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { control_id } = req.query;

  try {
    const result = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY uploaded_at DESC',
      [tenantId, req.programId!]
    );

    let evidenceList = result.rows.map(mapRowToEvidence);

    if (control_id) {
      const targetId = control_id.toString().trim().toUpperCase();
      const mappedIds = new Set([targetId, ...getEquivalentControlIds(targetId).map(id => id.toUpperCase())]);
      evidenceList = evidenceList.filter(e => mappedIds.has(e.controlId.toUpperCase()));
    }

    res.json({
      tenantId,
      totalCount: evidenceList.length,
      evidence: evidenceList,
      storageProvider,
    });
  } catch (err: unknown) {
    console.error(`[Evidence API] Error fetching evidence for tenant ${tenantId}:`, err);
    res.status(500).json({
      error: 'Failed to fetch evidence records',
      details: errorMessage(err),
    });
  }
});

/**
 * GET /api/v1/evidence/:evidenceId
 */
router.get('/:evidenceId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { evidenceId } = req.params;

  try {
    const result = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)',
      [evidenceId, tenantId, req.programId!]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: `Evidence artifact '${evidenceId}' not found`,
        tenantId,
      });
      return;
    }

    res.json(mapRowToEvidence(result.rows[0]));
  } catch (err: unknown) {
    console.error(`[Evidence API] Error fetching evidence ${evidenceId}:`, err);
    res.status(500).json({
      error: 'Failed to fetch evidence record',
      details: errorMessage(err),
    });
  }
});

const EVIDENCE_DELETE = `
  DELETE FROM evidence_metadata
  WHERE tenant_id = $1 AND (id = $2 OR starts_with(id, $3::text)) AND (program_id = $4 OR program_id IS NULL)
  RETURNING id, gcs_path;
`;

/**
 * DELETE /api/v1/evidence/:evidenceId
 * Deletes an evidence record of the active program. A base record goes with its cross-framework copies (`<id>__inh_*`);
 * an inherited copy goes alone. The file is unlinked only when no remaining row of the program points at the same path
 * (VM snapshot rows share files). Objective links are left alone. VM snapshot evidence is system managed: 409.
 * 400 invalid id, 404 unknown id (or another program), 403 read-only role / 409 archived program come from the middleware.
 * The log line carries ids and counts only: never a file name or path.
 */
router.delete('/:evidenceId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const evidenceId = String(req.params.evidenceId);

  if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
    res.status(400).json({ error: 'Invalid evidence ID' });
    return;
  }

  try {
    const found = await queryWithProgram(
      scopeOf(req),
      'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)',
      [evidenceId, tenantId, req.programId!]
    );
    if (found.rows.length === 0) {
      res.status(404).json({ error: 'Evidence not found' });
      return;
    }
    if (found.rows[0].uploaded_by === VM_SNAPSHOT_ACTOR) {
      res.status(409).json({
        error: 'This evidence is generated by the vulnerability snapshot and cannot be deleted',
        code: 'evidence_system_managed',
      });
      return;
    }

    const deleted = await queryWithProgram(
      scopeOf(req),
      EVIDENCE_DELETE,
      [tenantId, evidenceId, evidenceId.includes('__inh_') ? null : `${evidenceId}__inh_`, req.programId!]
    );
    const removedIds: string[] = deleted.rows.map((r) => String(r.id));
    const paths = [...new Set(deleted.rows.map((r) => r.gcs_path).filter((p): p is string => typeof p === 'string' && p !== ''))];

    let fileRemoved = false;
    if (paths.length > 0) {
      const remaining = await queryWithProgram(
        scopeOf(req),
        'SELECT * FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY uploaded_at DESC',
        [tenantId, req.programId!]
      );
      const stillUsed = new Set(remaining.rows.map((r) => r.gcs_path));
      for (const gcsPath of paths) {
        if (stillUsed.has(gcsPath)) continue;
        const filePath = resolveTenantLocalPath(tenantId, gcsPath);
        if (!filePath) continue;
        try {
          await fs.promises.unlink(filePath);
          fileRemoved = true;
        } catch (fsErr: unknown) {
          const code = (fsErr as NodeJS.ErrnoException)?.code;
          // A missing file is already gone; any other failure is logged by errno code only (Node fs errors embed the path)
          if (code !== 'ENOENT') console.warn(`[Evidence API] Could not remove an evidence file (${code ?? 'unknown'})`);
        }
      }
    }

    console.info(`[Evidence API] ${req.user?.uid} deleted evidence ${evidenceId} (${removedIds.length} rows, file removed: ${fileRemoved ? 'yes' : 'no'}) in ${tenantId}`);
    res.status(200).json({ deleted: true, evidenceId, removedIds, fileRemoved });
  } catch (err: unknown) {
    console.error(`[Evidence API] Error deleting evidence ${evidenceId}: ${errorMessage(err)}`);
    res.status(500).json({ error: 'Failed to delete the evidence record' });
  }
});

export default router;
