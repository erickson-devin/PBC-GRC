import { get, set, del, keys } from 'idb-keyval';

const EVIDENCE_STORE_PREFIX = 'pbc_evidence_';

export interface StoredEvidenceRecord {
  tenantId: string;
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
  uploadedAt: string;
  gcsPath?: string;
  fileHash?: string;
}

export const EvidenceVault = {
  /**
   * Helper to construct tenant-scoped IDB key
   */
  getStoreKey(tenantId: string, evidenceId: string): string {
    return `${EVIDENCE_STORE_PREFIX}${tenantId}_${evidenceId}`;
  },

  /**
   * Save an uploaded file blob in IndexedDB keyed by tenant and evidence ID
   */
  async saveFile(
    tenantId: string,
    evidenceId: string,
    file: File,
    gcsPath?: string,
    fileHash?: string
  ): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const payload: StoredEvidenceRecord = {
        tenantId,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        data: buffer,
        uploadedAt: new Date().toISOString(),
        gcsPath,
        fileHash,
      };
      await set(this.getStoreKey(tenantId, evidenceId), payload);
    } catch (err) {
      console.error('Error storing file in IndexedDB:', err);
      throw err;
    }
  },

  /**
   * Retrieve file as Blob from IndexedDB
   */
  async getFile(
    tenantId: string,
    evidenceId: string
  ): Promise<{ blob: Blob; name: string; type: string; fileHash?: string; gcsPath?: string; buffer: ArrayBuffer } | null> {
    try {
      // Check tenant-scoped key first, then fallback to legacy unpartitioned key if needed
      let result = await get<StoredEvidenceRecord>(this.getStoreKey(tenantId, evidenceId));
      if (!result) {
        result = await get<StoredEvidenceRecord>(`${EVIDENCE_STORE_PREFIX}${evidenceId}`);
      }
      if (!result || !result.data) {
        return null;
      }
      const blob = new Blob([result.data], { type: result.type });
      return {
        blob,
        name: result.name,
        type: result.type,
        fileHash: result.fileHash,
        gcsPath: result.gcsPath,
        buffer: result.data,
      };
    } catch (err) {
      console.error('Error fetching file from IndexedDB:', err);
      return null;
    }
  },

  /**
   * Get an object URL for previewing images/PDFs
   */
  async getPreviewUrl(tenantId: string, evidenceId: string): Promise<string | null> {
    const fileData = await this.getFile(tenantId, evidenceId);
    if (!fileData) return null;
    return URL.createObjectURL(fileData.blob);
  },

  /**
   * Delete a single evidence file from IndexedDB for the active tenant
   */
  async deleteFile(tenantId: string, evidenceId: string): Promise<void> {
    try {
      await del(this.getStoreKey(tenantId, evidenceId));
      await del(`${EVIDENCE_STORE_PREFIX}${evidenceId}`); // Also delete legacy key if present
    } catch (err) {
      console.error('Error deleting file from IndexedDB:', err);
    }
  },

  /**
   * Clear all stored evidence files for a specific tenant
   */
  async clearTenant(tenantId: string): Promise<void> {
    try {
      const allKeys = await keys();
      const prefix = `${EVIDENCE_STORE_PREFIX}${tenantId}_`;
      for (const k of allKeys) {
        if (typeof k === 'string' && k.startsWith(prefix)) {
          await del(k);
        }
      }
    } catch (err) {
      console.error(`Error clearing evidence vault for tenant ${tenantId}:`, err);
    }
  },

  /**
   * Clear all stored evidence files across all tenants
   */
  async clearAll(): Promise<void> {
    try {
      const allKeys = await keys();
      for (const k of allKeys) {
        if (typeof k === 'string' && k.startsWith(EVIDENCE_STORE_PREFIX)) {
          await del(k);
        }
      }
    } catch (err) {
      console.error('Error clearing entire evidence vault:', err);
    }
  },
};
