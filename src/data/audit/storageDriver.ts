/**
 * Event Horizon: Singularity — Evidence Storage Driver
 *
 * Implements environment-agnostic storage abstraction for both:
 * 1. Air-Gapped / On-Premises Enclaves (`STORAGE_PROVIDER === 'local'`)
 *    persisting files to local disk under `process.env.LOCAL_STORAGE_PATH || './data/evidence/'`.
 * 2. Cloud Deployments (`STORAGE_PROVIDER === 'gcs'`)
 *    persisting files to Google Cloud Storage with Signed URLs.
 *
 * Provides cryptographic SHA-256 integrity hashing and validation via `cryptoUtils.ts`.
 */

import { computeSha256 } from './cryptoUtils';

export type StorageProviderType = 'local' | 'gcs';

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

/**
 * Resolves the active storage provider from environment variables.
 * Defaults to 'local' for on-premises, air-gapped enclaves, and offline self-contained deployments.
 */
export function getStorageProvider(): StorageProviderType {
  // Check process.env (Node.js runtime / Express backend / Docker)
  if (typeof process !== 'undefined' && process.env?.STORAGE_PROVIDER) {
    return process.env.STORAGE_PROVIDER.toLowerCase() === 'gcs' ? 'gcs' : 'local';
  }

  // Check Vite client-side environment (import.meta.env)
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_STORAGE_PROVIDER) {
    return (import.meta as any).env.VITE_STORAGE_PROVIDER.toLowerCase() === 'gcs' ? 'gcs' : 'local';
  }

  return 'local';
}

/**
 * Resolves the root filesystem storage path for on-premise local evidence.
 * Defaults to './data/evidence/'.
 */
export function getLocalStoragePath(): string {
  if (typeof process !== 'undefined' && process.env?.LOCAL_STORAGE_PATH) {
    return process.env.LOCAL_STORAGE_PATH;
  }
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_LOCAL_STORAGE_PATH) {
    return (import.meta as any).env.VITE_LOCAL_STORAGE_PATH;
  }
  return './data/evidence/';
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
  const provider = getStorageProvider();
  return {
    provider,
    localStoragePath: getLocalStoragePath(),
    isAirGapped: provider === 'local',
    maxUploadSizeBytes: 100 * 1024 * 1024, // 100 MB
  };
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
