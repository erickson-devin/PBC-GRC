/**
 * Evidence files of a server-backed tenant live only on the server. Older versions also kept a browser copy (IndexedDB) of every
 * upload; this removes such a copy, but only after the server proves it holds the same bytes. Pure: the browser pieces are injected.
 */

export type PreviewKind = 'image' | 'pdf' | 'text' | 'download';

const SAFE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * How a file may be shown inline. The type comes from the upload and is untrusted: SVG and HTML can carry script, so they (and
 * anything unknown) are download-only. Only a real PDF type is ever put in an iframe, and text is shown as text, never as HTML.
 */
export function previewKind(mimeType: string | undefined | null, name: string | undefined | null): PreviewKind {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase();
  const fileName = (name || '').toLowerCase();
  if (SAFE_IMAGE.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'download';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type === '' && /\.(csv|txt)$/.test(fileName)) return 'text';
  return 'download';
}

export interface VerifyResult {
  status: number;
  verified?: boolean;
  currentHash?: string;
}

export type BlobAction = 'delete' | 'keptNotOnServer' | 'keptUnverified';

/** Delete only when the server verified the file and its hash is exactly the hash of the browser copy's bytes. */
export function decideBlobAction(verify: VerifyResult | null | undefined, localHash: string | null | undefined): BlobAction {
  if (!verify) return 'keptUnverified';
  if (verify.status === 404) return 'keptNotOnServer';
  if (verify.status !== 200 || verify.verified !== true) return 'keptUnverified';
  const server = typeof verify.currentHash === 'string' ? verify.currentHash.toLowerCase() : '';
  const local = typeof localHash === 'string' ? localHash.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(server) || !/^[0-9a-f]{64}$/.test(local) || server !== local) return 'keptUnverified';
  return 'delete';
}

export interface ScrubDeps {
  get: (key: string) => Promise<unknown>;
  del: (key: string) => Promise<void>;
  verify: (evidenceId: string) => Promise<VerifyResult>;
  hash: (data: ArrayBuffer) => Promise<string | null>;
  log: (message: string) => void;
}

export interface ScrubCounts {
  removed: number;
  keptNotOnServer: number;
  keptUnverified: number;
}

const STORE_PREFIX = 'pbc_evidence_';

/** Browser copies of the given evidence ids (tenant key first, then the legacy key), one at a time. Never throws. */
export async function runEvidenceBlobScrub(deps: ScrubDeps & { tenantId: string }, ids: string[]): Promise<ScrubCounts> {
  const counts: ScrubCounts = { removed: 0, keptNotOnServer: 0, keptUnverified: 0 };
  try {
    for (const id of ids) {
      try {
        if (typeof id !== 'string' || !id) continue;
        const keys = [`${STORE_PREFIX}${deps.tenantId}_${id}`, `${STORE_PREFIX}${id}`];
        for (const key of keys) {
          const record = await deps.get(key);
          if (!record || typeof record !== 'object') continue;
          const data = (record as { data?: unknown }).data;
          if (!(data instanceof ArrayBuffer)) continue;

          let verify: VerifyResult | null = null;
          let localHash: string | null = null;
          try {
            verify = await deps.verify(id);
            localHash = await deps.hash(data);
          } catch {
            verify = null;
          }
          const action = decideBlobAction(verify, localHash);
          if (action === 'delete') {
            await deps.del(key);
            counts.removed++;
          } else if (action === 'keptNotOnServer') {
            counts.keptNotOnServer++;
          } else {
            counts.keptUnverified++;
          }
        }
      } catch {
        // One bad record never stops the rest
      }
    }
  } catch {
    // Never throws
  }
  try {
    deps.log(`[evidence-scrub] removed ${counts.removed}, kept-not-on-server ${counts.keptNotOnServer}, kept-unverified ${counts.keptUnverified}`);
  } catch {
    // Logging is best effort
  }
  return counts;
}
