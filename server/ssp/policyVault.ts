import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

/**
 * Where an uploaded SSP (or other policy document) is kept: the evidence vault, under its own directory
 *
 *     tenants/<tenantId>/policies/uploaded/<jobId>_<file name>
 *
 * so documents a person uploaded are never mixed up with the documents this application generates. The file is kept after
 * it has been read (it is the source the suggestions came from) and is removed only when the import is deleted.
 * Uses the same storage settings as the evidence routes (STORAGE_PROVIDER, LOCAL_STORAGE_PATH, VITE_GCS_BUCKET_NAME).
 */
const provider: 'local' | 'gcs' = (process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 'gcs' ? 'gcs' : 'local';
const bucketName = process.env.VITE_GCS_BUCKET_NAME || 'pbc-grc-evidence-prod';
const localRoot = (): string => path.resolve(process.env.LOCAL_STORAGE_PATH || './data/evidence');

let gcs: Storage | null = null;
const gcsClient = (): Storage => (gcs ??= new Storage({ projectId: process.env.VITE_GCP_PROJECT_ID || 'grc-tool-507203' }));

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
): Promise<{ provider: 'local' | 'gcs'; path: string }> {
  const key = policyObjectKey(tenantId, jobId, fileName);
  if (provider === 'gcs') {
    await gcsClient().bucket(bucketName).file(key).save(data, { resumable: false });
    return { provider, path: key };
  }
  const target = resolveLocal(key);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, data, { flag: 'wx' });
  return { provider, path: key };
}

export async function readUploadedPolicy(stored: { provider: 'local' | 'gcs'; path: string }): Promise<Buffer> {
  if (stored.provider === 'gcs') {
    const [buf] = await gcsClient().bucket(bucketName).file(stored.path).download();
    return buf;
  }
  return fs.promises.readFile(resolveLocal(stored.path));
}

export async function deleteUploadedPolicy(stored: { provider: 'local' | 'gcs'; path: string }): Promise<void> {
  try {
    if (stored.provider === 'gcs') await gcsClient().bucket(bucketName).file(stored.path).delete({ ignoreNotFound: true });
    else await fs.promises.rm(resolveLocal(stored.path), { force: true });
  } catch (err) {
    console.warn('[SSP Import] Could not delete the stored document:', err instanceof Error ? err.message : err);
  }
}
