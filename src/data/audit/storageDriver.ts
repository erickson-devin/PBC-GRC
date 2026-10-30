/**
 * Event Horizon: Singularity — Evidence Storage Driver
 *
 * Local-disk storage for on-premises enclaves (`STORAGE_PROVIDER === 'local'`), persisting files under
 * `process.env.LOCAL_STORAGE_PATH || './data/evidence/'`. It is the only provider.
 *
 * Provides cryptographic SHA-256 integrity hashing and validation via `cryptoUtils.ts`.
 */

import { computeSha256 } from './cryptoUtils';
import { ApiClient } from '../../services/apiClient';

export type StorageProviderType = 'local';

export interface StorageConfig {
  provider: StorageProviderType;
  localStoragePath: string;
  isAirGapped: boolean;
  maxUploadSizeBytes: number;
}

export interface StoredEvidenceMetadata {
  evidenceId: string;
  tenantId: string;
  controlId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storagePath: string;
  fileHash: string;
  uploadedAt: string;
  uploadedBy?: string;
  integrityVerified: boolean;
}

const DEFAULT_LOCAL_STORAGE_PATH = './data/evidence/';
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** Last storage configuration reported by the server (single source of truth). */
let serverStorageConfig: StorageConfig | null = null;
/** Cached env-derived default used until the server answers (keeps getStorageConfig referentially stable). */
let fallbackStorageConfig: StorageConfig | null = null;
const configListeners = new Set<() => void>();

function nodeEnv(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

/** Local disk is the only provider: any other value (e.g. a legacy one from an old server) normalises to it. */
function normalizeProvider(_value: string | undefined): StorageProviderType {
  return 'local';
}

/**
 * Applies a storage configuration fetched from the server and notifies subscribers.
 */
export function setServerStorageConfig(info: {
  provider?: string;
  localStoragePath?: string;
  isAirGapped?: boolean;
}): StorageConfig {
  const provider = normalizeProvider(info.provider);
  const next: StorageConfig = {
    provider,
    localStoragePath: info.localStoragePath || '',
    isAirGapped: info.isAirGapped ?? provider === 'local',
    maxUploadSizeBytes: DEFAULT_MAX_UPLOAD_BYTES,
  };
  const prev = serverStorageConfig;
  if (
    prev &&
    prev.provider === next.provider &&
    prev.localStoragePath === next.localStoragePath &&
    prev.isAirGapped === next.isAirGapped
  ) {
    return prev; // unchanged: keep the same reference and skip notifying subscribers
  }
  serverStorageConfig = next;
  configListeners.forEach((listener) => listener());
  return next;
}

/** Returns the config last fetched from the server, or null if none has been loaded yet. */
export function getServerStorageConfig(): StorageConfig | null {
  return serverStorageConfig;
}

/** Subscribe to storage config changes (used by useStorageConfig via useSyncExternalStore). */
export function subscribeStorageConfig(listener: () => void): () => void {
  configListeners.add(listener);
  return () => {
    configListeners.delete(listener);
  };
}

/**
 * Fetches the active storage configuration from `GET /api/v1/evidence/config/storage-info`.
 * The server is the single source of truth, so the browser can never disagree with it
 * because of a stale build-time `VITE_*` value. Returns null if the server is unreachable.
 */
export async function fetchStorageConfig(tenantId: string, sessionRef?: string | null): Promise<StorageConfig | null> {
  try {
    const info = await ApiClient.getStorageInfo(tenantId, sessionRef);
    return info ? setServerStorageConfig(info) : null;
  } catch {
    return null;
  }
}

/**
 * The path to show people: the server's value, or null while it is not known (never the client default, which
 * is not where the server keeps evidence).
 */
export function storagePathLabel(c: { localStoragePath: string; loaded: boolean }): string | null {
  return c.loaded && c.localStoragePath ? c.localStoragePath : null;
}

/**
 * Resolves the active storage provider.
 * - Browser: the value reported by the server (see fetchStorageConfig); 'local' until loaded.
 * - Node (Express backend / Docker / tests): process.env.STORAGE_PROVIDER.
 * Defaults to 'local' for on-premises, air-gapped enclaves, and offline self-contained deployments.
 */
export function getStorageProvider(): StorageProviderType {
  if (serverStorageConfig) return serverStorageConfig.provider;
  return normalizeProvider(nodeEnv('STORAGE_PROVIDER'));
}

/**
 * Resolves the root filesystem storage path for on-premise local evidence.
 * Defaults to './data/evidence/'.
 */
export function getLocalStoragePath(): string {
  if (serverStorageConfig) return serverStorageConfig.localStoragePath;
  return nodeEnv('LOCAL_STORAGE_PATH') || DEFAULT_LOCAL_STORAGE_PATH;
}

/**
 * Checks if the system is running in local on-premises / air-gapped enclave mode.
 */
export function isLocalStorageProvider(): boolean {
  return getStorageProvider() === 'local';
}

/**
 * Retrieves the comprehensive storage configuration object.
 */
export function getStorageConfig(): StorageConfig {
  if (serverStorageConfig) return serverStorageConfig;

  // This is the `getSnapshot` for useSyncExternalStore, so it MUST return the same object
  // reference while nothing has changed; a fresh object per call makes React re-render forever.
  const provider = getStorageProvider();
  const localStoragePath = getLocalStoragePath();
  if (
    !fallbackStorageConfig ||
    fallbackStorageConfig.provider !== provider ||
    fallbackStorageConfig.localStoragePath !== localStoragePath
  ) {
    fallbackStorageConfig = {
      provider,
      localStoragePath,
      isAirGapped: provider === 'local',
      maxUploadSizeBytes: DEFAULT_MAX_UPLOAD_BYTES,
    };
  }
  return fallbackStorageConfig;
}

/**
 * Generates a normalized, tenant-partitioned object relative path.
 * Format: tenants/{tenantId}/controls/{controlId}/{evidenceId}_{cleanFileName}
 */
export function generateEvidenceObjectPath(
  tenantId: string,
  controlId: string,
  evidenceId: string,
  fileName: string
): string {
  const cleanTenant = (tenantId || 'default-tenant').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanControl = (controlId || 'general').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const cleanFile = (fileName || 'evidence.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `tenants/${cleanTenant}/controls/${cleanControl}/${evidenceId}_${cleanFile}`;
}

/**
 * Computes a SHA-256 hex digest for evidence file contents using cryptoUtils.
 */
export async function computeFileHash(
  data: string | ArrayBuffer | Uint8Array
): Promise<string> {
  return computeSha256(data);
}

/**
 * Validates that an evidence file's binary content matches its recorded SHA-256 hash.
 */
export async function verifyEvidenceIntegrity(
  fileContent: string | ArrayBuffer | Uint8Array,
  expectedHash: string
): Promise<{ verified: boolean; computedHash: string; expectedHash: string }> {
  const computedHash = await computeFileHash(fileContent);
  const normalizedComputed = computedHash.toLowerCase().trim();
  const normalizedExpected = (expectedHash || '').toLowerCase().trim();

  return {
    verified: Boolean(normalizedExpected && normalizedComputed === normalizedExpected),
    computedHash: normalizedComputed,
    expectedHash: normalizedExpected,
  };
}
