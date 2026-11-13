import type { EnclaveAsset } from '../types/telemetry';
import type { SoftwareItem } from '../types/software';

/** Pure view logic of the Software Inventory panel and dialog (issue #229, phase 1b). */

export type ApprovalFilter = 'ALL' | 'APPROVED' | 'NOT_APPROVED' | 'NOT_REVIEWED';
export type ApprovalChoice = 'APPROVED' | 'NOT_APPROVED' | 'NOT_REVIEWED';

/** Mirrors the server's field limits. */
export const SOFTWARE_LIMITS = { name: 255, version: 128, vendor: 255, notes: 4000, perTenant: 5000 } as const;

export const approvalChoice = (approved: boolean | null): ApprovalChoice => (approved === true ? 'APPROVED' : approved === false ? 'NOT_APPROVED' : 'NOT_REVIEWED');

export const approvedFromChoice = (choice: ApprovalChoice): boolean | null => (choice === 'APPROVED' ? true : choice === 'NOT_APPROVED' ? false : null);

export const APPROVAL_LABELS: Record<ApprovalChoice, string> = { APPROVED: 'Approved', NOT_APPROVED: 'Not approved', NOT_REVIEWED: 'Not reviewed' };

export function hostNameMap(assets: Pick<EnclaveAsset, 'id' | 'hostName'>[]): Map<string, string> {
  return new Map(assets.map((a) => [a.id, a.hostName]));
}

/** What the "Installed on" column shows for an entry. */
export function installedOnLabel(assetId: string | null, hosts: Map<string, string>, assetsLoading: boolean): string {
  if (assetId === null) return 'Tenant-wide';
  if (assetsLoading) return 'Loading…';
  const host = hosts.get(assetId);
  if (host === undefined) return 'Asset not in the inventory';
  return host.trim() ? host : 'Unnamed asset';
}

/** Trimmed, case-insensitive search over every shown column, then the approval filter; sorted by name, then version. */
export function filterSoftware(items: SoftwareItem[], opts: { query: string; approval: ApprovalFilter }, hosts: Map<string, string>): SoftwareItem[] {
  const q = opts.query.trim().toLowerCase();
  const matches = items.filter((item) => {
    if (opts.approval === 'APPROVED' && item.approved !== true) return false;
    if (opts.approval === 'NOT_APPROVED' && item.approved !== false) return false;
    if (opts.approval === 'NOT_REVIEWED' && item.approved !== null) return false;
    if (!q) return true;
    return [item.name, item.version, item.vendor, item.notes, installedOnLabel(item.assetId, hosts, false)].some((f) => f.toLowerCase().includes(q));
  });
  const collator = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return matches.sort((a, b) => collator(a.name, b.name) || collator(a.version, b.version));
}

const UNNAMED_ASSET = 'Unnamed asset';

/** The "Installed on" choices of the dialog. */
export function assetOptions(assets: Pick<EnclaveAsset, 'id' | 'hostName' | 'ipAddress'>[]): { id: string; label: string }[] {
  return [...assets]
    .sort((a, b) => (a.hostName || '').localeCompare(b.hostName || '', undefined, { numeric: true, sensitivity: 'base' }))
    .map((a) => ({ id: a.id, label: `${a.hostName || UNNAMED_ASSET} (${a.ipAddress})` }));
}

export function softwareEmptyMessage({ total, canEdit }: { total: number; shown: number; canEdit: boolean }): string {
  if (total === 0) {
    return canEdit
      ? 'No software recorded yet. Add the applications in your assessment boundary, tenant-wide or per asset, and record whether each is approved.'
      : 'No software recorded yet. A Tenant Owner or MSP Admin can add entries.';
  }
  return 'No software entries match your search and filter.';
}

export function validateSoftwareName(name: string): string | null {
  return name.trim() ? null : 'Enter the software name.';
}

/** A fixed message per failure: the server's text is never shown, since it could echo what was typed. */
export function softwareErrorMessage(err: unknown, action: 'save' | 'delete'): string {
  const e = (err ?? {}) as { reason?: unknown; status?: unknown };
  switch (e.reason) {
    case 'invalid':
      return 'The server did not accept this entry. Check that the name is filled in and no field is too long. Nothing was saved.';
    case 'asset_not_found':
      return 'That asset is not in this tenant. Choose another asset or Tenant-wide. Nothing was saved.';
    case 'not_found':
      return 'This software entry was removed meanwhile. The list has been refreshed.';
    case 'limit':
      return 'This organization already has 5,000 software entries, the most it can hold. Remove entries you no longer need, then try again.';
    default:
      break;
  }
  if (e.status === 403) return 'Only a Tenant Owner or MSP Admin can change the software inventory. Nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved; try again.';
  return action === 'save' ? 'The software entry could not be saved. Try again.' : 'The software entry could not be removed. Try again.';
}

export function softwareCountCaption(shown: number, total: number): string {
  if (shown === total) return `${total} ${total === 1 ? 'entry' : 'entries'}`;
  return `${shown} of ${total} entries`;
}

/** The line the Export Center shows under the Software Inventory document. */
export function softwareExportLine({ supported, loading, error, count }: { supported: boolean; loading: boolean; error: boolean; count: number }): string {
  if (!supported) return "Software: this organization is stored only in this browser, so no software entries exist; the document lists each asset's operating system.";
  if (error) return 'Software: the software inventory could not be loaded, so this document lists no software entries.';
  if (loading) return 'Software: loading the software inventory…';
  return `Software: ${count} ${count === 1 ? 'entry' : 'entries'}.`;
}

/** The scanner line under the Software Inventory document: nothing for a browser-only organization. */
export function scannerExportLine({ status, packages, assets, truncated }: { status: 'loading' | 'ready' | 'error' | 'unsupported'; packages: number; assets: number; truncated?: boolean }): string | null {
  if (status === 'unsupported') return null;
  if (status === 'loading') return 'Scanner-reported: loading the packages the scanners report…';
  if (status === 'error') return 'Scanner-reported: the scanner data could not be loaded, so this document lists recorded software only.';
  const line = `Scanner-reported: ${packages} ${packages === 1 ? 'package' : 'packages'} on ${assets} ${assets === 1 ? 'asset' : 'assets'}.`;
  return truncated ? `${line} The list is cut at its limit; the document says how many packages are not listed.` : line;
}
