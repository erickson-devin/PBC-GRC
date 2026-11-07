import type { SoftwareItem } from '../../types/software';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Turns the server's software list into SoftwareItems. Entries without a string id and name are dropped; `approved` is
 * true / false only when the server sent a boolean (anything else is "not reviewed"); a non-string asset link is tenant-wide.
 */
export function parseServerSoftwareItems(raw: unknown): SoftwareItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SoftwareItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name) continue;
    items.push({
      id: r.id,
      tenantId: str(r.tenantId),
      name: r.name,
      version: str(r.version),
      vendor: str(r.vendor),
      approved: typeof r.approved === 'boolean' ? r.approved : null,
      assetId: typeof r.assetId === 'string' && r.assetId ? r.assetId : null,
      notes: str(r.notes),
      createdAt: str(r.createdAt),
      updatedAt: str(r.updatedAt),
    });
  }
  return items;
}
