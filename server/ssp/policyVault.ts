import fs from 'fs';
import path from 'path';

/**
 * Where an uploaded SSP (or other policy document) is kept: the evidence vault, under its own directory
 *
 *     tenants/<tenantId>/policies/uploaded/<jobId>_<file name>
 *
 * so documents a person uploaded are never mixed up with the documents this application generates. The file is kept after
 * it has been read (it is the source the suggestions came from) and is removed only when the import is deleted.
 * Local disk only, rooted at LOCAL_STORAGE_PATH like the evidence routes.
 */
const provider = 'local' as const;
const localRoot = (): string => path.resolve(process.env.LOCAL_STORAGE_PATH || './data/evidence');

export const UPLOADED_POLICIES_DIR = 'policies/uploaded';

const safeSegment = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

/** Object key inside the vault; never contains path separators from user input. */
export const policyObjectKey = (tenantId: string, jobId: string, fileName: string): string =>
  `tenants/${safeSegment(tenantId)}/${UPLOADED_POLICIES_DIR}/${safeSegment(jobId)}_${safeSegment(fileName)}`;

function resolveLocal(key: string): string {
  const root = localRoot();
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid vault path');
  return resolved;
}

export async function saveUploadedPolicy(
  tenantId: string,
  jobId: string,
  fileName: string,
  data: Buffer
): Promise<{ provider: 'local'; path: string }> {
  const key = policyObjectKey(tenantId, jobId, fileName);
  const target = resolveLocal(key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, data, { flag: 'wx' });
  return { provider, path: key };
}

/** Rows written by a former cloud deployment may carry another provider in the database; this installation cannot read them. */
const FORMER_CLOUD_MESSAGE =
  'This document was stored in a cloud bucket by a former deployment, which this installation no longer supports.';

export async function readUploadedPolicy(stored: { provider: 'local'; path: string }): Promise<Buffer> {
  if (stored.provider !== 'local') throw new Error(FORMER_CLOUD_MESSAGE);
  return fs.promises.readFile(resolveLocal(stored.path));
}

export async function deleteUploadedPolicy(stored: { provider: 'local'; path: string }): Promise<void> {
  if (stored.provider !== 'local') {
    console.warn(`[SSP Import] ${FORMER_CLOUD_MESSAGE} Nothing was deleted.`);
    return;
  }
  try {
    await fs.promises.rm(resolveLocal(stored.path), { force: true });
  } catch (err) {
    console.warn('[SSP Import] Could not delete the stored document:', err instanceof Error ? err.message : err);
  }
}
