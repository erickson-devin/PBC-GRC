/**
 * Evidence files that exist only in this browser (IndexedDB) for a server-backed tenant: listing them, moving one to the
 * server with proof, and re-keying one. Pure: the browser and network pieces are injected. Never throws, no `console`, and no
 * result ever carries a file name.
 */
import { decideBlobAction, VerifyResult } from './evidenceBlobScrub';

const STORE_PREFIX = 'pbc_evidence_';

/** SHA-256 (lower-case hex) of the bytes, or null when this context has no crypto.subtle (a non-secure page). */
export async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

/** The control id inside a vault path (`tenants/<t>/controls/<controlId>/<file>`), or null. */
export function controlIdFromVaultPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const m = /\/controls\/([A-Za-z0-9._-]+)\//.exec(p);
  if (!m || m[1] === '.' || m[1] === '..') return null;
  return m[1];
}

export interface LocalEvidenceCopy {
  key: string;
  evidenceId: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
  controlId: string | null;
}

export interface LocalCopyStore {
  keys: () => Promise<unknown[]>;
  get: (key: string) => Promise<unknown>;
}

/** Browser copies of this tenant whose id the server does not hold, sorted by key. Never throws. */
export async function listLocalEvidenceCopies(
  deps: LocalCopyStore,
  tenantId: string,
  serverIds: ReadonlySet<string>
): Promise<LocalEvidenceCopy[]> {
  const out: LocalEvidenceCopy[] = [];
  let keys: unknown[] = [];
  try {
    keys = await deps.keys();
  } catch {
    return out;
  }
  const tenantPrefix = `${STORE_PREFIX}${tenantId}_`;
  const candidates = keys.filter((k): k is string => typeof k === 'string' && k.startsWith(STORE_PREFIX)).sort();
  for (const key of candidates) {
    try {
      const record = await deps.get(key);
      if (!record || typeof record !== 'object') continue;
      const r = record as Record<string, unknown>;
      if (!(r.data instanceof ArrayBuffer) || r.tenantId !== tenantId) continue;
      const evidenceId = key.startsWith(tenantPrefix) ? key.slice(tenantPrefix.length) : key.slice(STORE_PREFIX.length);
      if (!evidenceId || serverIds.has(evidenceId)) continue;
      out.push({
        key,
        evidenceId,
        name: typeof r.name === 'string' ? r.name : '',
        type: typeof r.type === 'string' ? r.type : '',
        size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : r.data.byteLength,
        uploadedAt: typeof r.uploadedAt === 'string' ? r.uploadedAt : '',
        controlId: controlIdFromVaultPath(r.gcsPath),
      });
    } catch {
      // One unreadable record never hides the rest
    }
  }
  return out;
}

/** A copy of the objectives with `linkedEvidenceIds` mapped to their server ids (inherited copies follow their base id). */
export function remapEvidenceLinks<T extends { linkedEvidenceIds?: string[] }>(
  objectives: Record<string, T>,
  idMap: Record<string, string>
): Record<string, T> {
  if (Object.keys(idMap).length === 0) return objectives;
  const mapId = (id: string): string => {
    if (Object.prototype.hasOwnProperty.call(idMap, id)) return idMap[id];
    const at = id.indexOf('__inh_');
    if (at > 0) {
      const base = id.slice(0, at);
      if (Object.prototype.hasOwnProperty.call(idMap, base)) return `${idMap[base]}${id.slice(at)}`;
    }
    return id;
  };
  const out: Record<string, T> = {};
  for (const [objectiveId, obj] of Object.entries(objectives)) {
    out[objectiveId] = Array.isArray(obj?.linkedEvidenceIds) ? { ...obj, linkedEvidenceIds: obj.linkedEvidenceIds.map(mapId) } : obj;
  }
  return out;
}

export interface MoveDeps {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  del: (key: string) => Promise<void>;
  hash: (data: ArrayBuffer) => Promise<string | null>;
  requestUploadUrl: (payload: {
    controlId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileHash: string;
    description?: string;
  }) => Promise<{ uploadUrl: string; evidenceId: string }>;
  uploadFile: (uploadUrl: string, blob: Blob, mimeType: string) => Promise<void>;
  verify: (evidenceId: string) => Promise<VerifyResult>;
  /** Only used when there is no local hash: the server copy is downloaded and compared byte for byte. */
  fetchServerBytes?: (evidenceId: string) => Promise<ArrayBuffer>;
  /** Best-effort cleanup of the record an upload-url call created when the bytes could not be uploaded. */
  deleteServerRecord?: (evidenceId: string) => Promise<void>;
}

export interface MoveInput {
  key: string;
  evidenceId: string;
  controlId: string | null;
  description?: string;
  targetTenantId: string;
}

export type MoveResult =
  | { status: 'moved'; serverEvidenceId: string }
  | { status: 'uploadedUnverified'; serverEvidenceId: string }
  | { status: 'failed' }
  | { status: 'needsControl' }
  | { status: 'missing' };

/**
 * Uploads one browser copy to the server. The browser copy is deleted only once the server is proven to hold the same bytes
 * (matching SHA-256, or, with no local hash, an exact byte comparison). Otherwise it is re-keyed under the server id so the
 * existing scrub verifies it later. Never throws.
 */
export async function moveLocalEvidenceCopy(deps: MoveDeps, input: MoveInput): Promise<MoveResult> {
  try {
    if (!input.controlId) return { status: 'needsControl' };
    const record = await deps.get(input.key);
    if (!record || typeof record !== 'object') return { status: 'missing' };
    const rec = record as Record<string, unknown>;
    const data = rec.data;
    if (!(data instanceof ArrayBuffer)) return { status: 'missing' };

    const mimeType = typeof rec.type === 'string' && rec.type ? rec.type : 'application/octet-stream';
    const fileName = typeof rec.name === 'string' && rec.name ? rec.name : 'evidence';
    const h = await deps.hash(data);

    let uploadUrl: string;
    let serverId: string;
    try {
      const resp = await deps.requestUploadUrl({
        controlId: input.controlId,
        fileName,
        fileSize: data.byteLength,
        mimeType,
        fileHash: h ?? 'sha256-unavailable',
        description: input.description || `Audit evidence for control ${input.controlId}`,
      });
      uploadUrl = resp.uploadUrl;
      serverId = resp.evidenceId;
    } catch {
      return { status: 'failed' };
    }

    try {
      await deps.uploadFile(uploadUrl, new Blob([data], { type: mimeType }), mimeType);
    } catch {
      try {
        await deps.deleteServerRecord?.(serverId);
      } catch {
        // Best effort: an orphan record is harmless and removable from the vault
      }
      return { status: 'failed' };
    }

    let v: VerifyResult | null = null;
    try {
      v = await deps.verify(serverId);
    } catch {
      v = null;
    }
    if (decideBlobAction(v, h) === 'delete') {
      await deps.del(input.key);
      return { status: 'moved', serverEvidenceId: serverId };
    }
    if (h === null && v && v.status === 200 && v.verified === true && deps.fetchServerBytes) {
      let same = false;
      try {
        same = bytesEqual(await deps.fetchServerBytes(serverId), data);
      } catch {
        same = false;
      }
      if (same) {
        await deps.del(input.key);
        return { status: 'moved', serverEvidenceId: serverId };
      }
    }

    await deps.set(`${STORE_PREFIX}${input.targetTenantId}_${serverId}`, { ...rec, tenantId: input.targetTenantId });
    await deps.del(input.key);
    return { status: 'uploadedUnverified', serverEvidenceId: serverId };
  } catch {
    return { status: 'failed' };
  }
}

/** Re-keys one browser copy under another tenant id (and rewrites its tenantId). False when there is nothing to move or it fails. */
export async function moveLocalEvidenceKey(
  deps: Pick<MoveDeps, 'get' | 'set' | 'del'>,
  fromKey: string,
  toTenantId: string,
  evidenceId: string
): Promise<boolean> {
  try {
    const record = await deps.get(fromKey);
    if (!record || typeof record !== 'object') return false;
    const toKey = `${STORE_PREFIX}${toTenantId}_${evidenceId}`;
    await deps.set(toKey, { ...(record as Record<string, unknown>), tenantId: toTenantId });
    if (toKey !== fromKey) await deps.del(fromKey);
    return true;
  } catch {
    return false;
  }
}
