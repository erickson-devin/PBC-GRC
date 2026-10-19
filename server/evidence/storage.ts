import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Tenant-scoped local file storage shared by the vulnerability-management ingest (docs/VULNERABILITY_MANAGEMENT.md, 7.1).
 * Mirrors the path logic in server/routes/evidence.ts (which is deliberately not refactored here). Env is read per call
 * so tests can point the root at a temporary directory.
 */

/** Anything other than an explicit 'gcs' resolves to local disk. */
export function storageProvider(): 'local' | 'gcs' {
  return (process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'gcs' ? 'gcs' : 'local';
}

export function localStorageRoot(): string {
  return path.resolve(process.env.LOCAL_STORAGE_PATH || './data/evidence');
}

/**
 * Resolves `candidate` and returns it only if it stays inside `root` (path-traversal guard).
 * Returns null for anything that escapes the root or is the root itself.
 */
export function resolveWithin(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

/** Local files for a tenant may only live under <root>/tenants/<tenantId>/. */
export function resolveTenantLocalPath(tenantId: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate || candidate.startsWith('gs://')) return null;
  return resolveWithin(path.join(localStorageRoot(), 'tenants', tenantId), candidate);
}

/**
 * Reads a file the tenant's vault holds. `candidate` must be an absolute path that already sits inside
 * <root>/tenants/<tenantId>/ (the same confinement the VM worker applies to a recorded path); anything else, and a missing
 * file, returns null.
 */
export async function readTenantFile(tenantId: string, candidate: unknown): Promise<Buffer | null> {
  const resolved = resolveTenantLocalPath(tenantId, candidate);
  if (!resolved || resolved !== path.resolve(candidate as string)) return null;
  try {
    return await fs.promises.readFile(resolved);
  } catch {
    return null;
  }
}

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Writes `data` to <root>/tenants/<tenantId>/<relativeKey>. With `exclusive` an existing file is an error (flag 'wx').
 * Local provider only; rejects a tenant id or key that would leave the tenant directory.
 */
export async function writeTenantFile(
  tenantId: string,
  relativeKey: string,
  data: Buffer,
  options: { exclusive: boolean },
): Promise<{ absPath: string; sha256: string; size: number }> {
  if (storageProvider() !== 'local') throw new Error('Local storage is required');
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new Error('Invalid tenant id');
  const absPath = resolveTenantLocalPath(tenantId, relativeKey);
  if (!absPath) throw new Error('Invalid storage path');
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, data, { flag: options.exclusive ? 'wx' : 'w' });
  return { absPath, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}
