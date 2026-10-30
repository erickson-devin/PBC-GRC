import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * The single storage root of the server: tenant-scoped local file storage used by the evidence routes
 * (server/routes/evidence.ts), the SSP upload vault (server/ssp/policyVault.ts) and the vulnerability-management ingest
 * (docs/VULNERABILITY_MANAGEMENT.md, 7.1). Env is read per call so tests can point the root at a temporary directory.
 */

/** Evidence lives on local disk only: STORAGE_PROVIDER may be unset, blank or "local". Read per call (tests change it). */
export function isLocalStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.STORAGE_PROVIDER ?? '').trim().toLowerCase();
  return value === '' || value === 'local';
}

/** Startup validation: refuse any other STORAGE_PROVIDER value instead of silently treating it as local. */
export function assertStorageConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLocalStorageConfigured(env)) {
    throw new Error(
      `STORAGE_PROVIDER="${env.STORAGE_PROVIDER}" is not supported: evidence is stored on local disk only (LOCAL_STORAGE_PATH). Remove STORAGE_PROVIDER or set it to "local".`
    );
  }
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
 * Local disk only; rejects a tenant id or key that would leave the tenant directory.
 */
export async function writeTenantFile(
  tenantId: string,
  relativeKey: string,
  data: Buffer,
  options: { exclusive: boolean },
): Promise<{ absPath: string; sha256: string; size: number }> {
  if (!isLocalStorageConfigured()) throw new Error('Local storage is required');
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) throw new Error('Invalid tenant id');
  const absPath = resolveTenantLocalPath(tenantId, relativeKey);
  if (!absPath) throw new Error('Invalid storage path');
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, data, { flag: options.exclusive ? 'wx' : 'w' });
  return { absPath, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}
