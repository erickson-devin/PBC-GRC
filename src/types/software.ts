/**
 * Software inventory entries (issue #229, phase 1b): manual, tenant-wide like
 * enclave_assets. `approved` is tri-state: null means nobody has reviewed the
 * item yet (CM.L2-3.4.8), so the Software Inventory document never claims
 * "not approved" for something unreviewed. Name, vendor and notes may be CUI:
 * never logged, never cached in browser storage.
 */
export interface SoftwareItem {
  id: string;
  tenantId: string;
  name: string;
  version: string;
  vendor: string;
  approved: boolean | null;
  /** Linked enclave asset, or null for a tenant-wide entry */
  assetId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type SoftwareItemInput = Partial<Pick<SoftwareItem, 'name' | 'version' | 'vendor' | 'approved' | 'assetId' | 'notes'>>;
