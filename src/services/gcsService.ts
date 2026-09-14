import { GcpServiceConfig } from '../types/tenant';
import { EvidenceItem } from '../types/cmmc';

const getEnv = (key: string, fallback: string = ''): string => {
  if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env[key]) {
    return (import.meta as any).env[key];
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key]!;
  }
  return fallback;
};

export const DEFAULT_GCP_CONFIG: GcpServiceConfig = {
  projectId: getEnv('VITE_GCP_PROJECT_ID', 'grc-tool-507203'),
  region: getEnv('VITE_GCP_REGION', 'us-central1'),
  gcsBucketName: getEnv('VITE_GCS_BUCKET_NAME', 'pbc-grc-evidence-prod'),
  cloudSqlInstance: getEnv('VITE_GCP_CLOUD_SQL_INSTANCE', 'pbc-grc-postgres-primary'),
  databaseName: getEnv('VITE_GCP_DATABASE_NAME', 'cmmc_compliance_db'),
  identityDomain: getEnv('VITE_GCP_IDENTITY_DOMAIN', 'pitchblackcyber.com'),
};

export const GcsService = {
  getConfig(): GcpServiceConfig {
    return { ...DEFAULT_GCP_CONFIG };
  },

  /**
   * Compute a cryptographic SHA-256 hex digest for any file/blob/buffer
   * using the standard Web Crypto API (supported natively in modern browsers)
   */
  async computeSha256(data: File | Blob | ArrayBuffer): Promise<string> {
    try {
      let buffer: ArrayBuffer;
      if (data instanceof ArrayBuffer) {
        buffer = data;
      } else {
        buffer = await data.arrayBuffer();
      }
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex;
    } catch (err) {
      console.error('Failed to compute SHA-256 hash:', err);
      // Fallback pseudo-hash if crypto.subtle is unavailable
      return `sha256_${Date.now().toString(16)}_${Math.random().toString(16).substring(2, 10)}`;
    }
  },

  /**
   * Format tenant-scoped GCS bucket key
   * Structure: gs://<bucket_name>/tenants/{tenant_id}/controls/{control_id}/{file_id}_{clean_name}
   */
  generateGcsPath(tenantId: string, controlId: string, fileId: string, fileName: string): string {
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `gs://${DEFAULT_GCP_CONFIG.gcsBucketName}/tenants/${tenantId}/controls/${controlId}/${fileId}_${cleanFileName}`;
  },

  /**
   * Simulate or generate a GCS Signed URL for direct-to-bucket upload or download
   */
  async generateSignedUploadUrl(
    tenantId: string,
    controlId: string,
    fileName: string,
    _contentType: string
  ): Promise<{ signedUrl: string; gcsPath: string; expiresAt: string }> {
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const gcsPath = this.generateGcsPath(tenantId, controlId, fileId, fileName);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min validity
    
    // In live GCP environment, presigned URLs are signed by cmmc-evidence-signer service account
    const mockSignedUrl = `https://storage.googleapis.com/${DEFAULT_GCP_CONFIG.gcsBucketName}/tenants/${tenantId}/controls/${controlId}/${fileId}?GoogleAccessId=cmmc-evidence-signer@${DEFAULT_GCP_CONFIG.projectId}.iam.gserviceaccount.com&Expires=${Math.floor(Date.now() / 1000) + 900}&Signature=GCS_SECURE_TOKEN_EMULATED`;

    return {
      signedUrl: mockSignedUrl,
      gcsPath,
      expiresAt,
    };
  },

  /**
   * Cryptographically verify evidence immutability by comparing stored SHA-256 hash
   */
  async verifyIntegrity(
    evidence: EvidenceItem,
    fileBuffer: ArrayBuffer
  ): Promise<{ isValid: boolean; expectedHash: string; computedHash: string }> {
    const computedHash = await this.computeSha256(fileBuffer);
    const expectedHash = evidence.fileHash || '';
    const isValid = Boolean(expectedHash && expectedHash.toLowerCase() === computedHash.toLowerCase());

    return {
      isValid,
      expectedHash,
      computedHash,
    };
  },
};
