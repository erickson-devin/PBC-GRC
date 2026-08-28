import { get, set, del, keys } from 'idb-keyval';

const EVIDENCE_STORE_PREFIX = 'pbc_evidence_';

export const EvidenceVault = {
  /**
   * Save an uploaded file blob in IndexedDB keyed by evidence ID
   */
  async saveFile(evidenceId: string, file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const payload = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        data: buffer,
        uploadedAt: new Date().toISOString(),
      };
      await set(`${EVIDENCE_STORE_PREFIX}${evidenceId}`, payload);
    } catch (err) {
      console.error('Error storing file in IndexedDB:', err);
      throw err;
    }
  },

  /**
   * Retrieve file as Blob from IndexedDB
   */
  async getFile(evidenceId: string): Promise<{ blob: Blob; name: string; type: string } | null> {
    try {
      const result = await get<{ name: string; type: string; size: number; data: ArrayBuffer }>(
        `${EVIDENCE_STORE_PREFIX}${evidenceId}`
      );
      if (!result || !result.data) {
        return null;
      }
      const blob = new Blob([result.data], { type: result.type });
      return {
        blob,
        name: result.name,
        type: result.type,
      };
    } catch (err) {
      console.error('Error fetching file from IndexedDB:', err);
      return null;
    }
  },

  /**
   * Get an object URL or Data URL for previewing images/PDFs
   */
  async getPreviewUrl(evidenceId: string): Promise<string | null> {
    const fileData = await this.getFile(evidenceId);
    if (!fileData) return null;
    return URL.createObjectURL(fileData.blob);
  },

  /**
   * Delete a single evidence file from IndexedDB
   */
  async deleteFile(evidenceId: string): Promise<void> {
    try {
      await del(`${EVIDENCE_STORE_PREFIX}${evidenceId}`);
    } catch (err) {
      console.error('Error deleting file from IndexedDB:', err);
    }
  },

  /**
   * Clear all stored evidence files
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
      console.error('Error clearing evidence vault:', err);
    }
  },
};
