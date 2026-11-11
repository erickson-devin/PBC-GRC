/**
 * What the scanner-data views show (#229 phase 2): the fixed copy and the pure rules of ObservedInventoryPanel, ObservedSoftwareList and
 * the asset form, kept here so they can be tested without React. Scanner-reported strings (names, versions, vendors) never pass through
 * the copy: the views render them as text nodes. Nothing here stores or logs.
 */
import type { EnclaveAsset } from '../../types/telemetry';
import type { VmObservedHost, VmObservedSoftware } from '../../types/vm';
import type { AssetInput } from './assetScope';
import type { FipsFields } from './fipsValidation';
import type { ObservedField } from './observedInventory';
import { osProfileSelectValue } from './osProfile';

export const NOT_REPORTED = 'Not reported';

export const OBSERVED_COPY = {
  heading: 'Scanner data',
  loading: 'Loading the scanner data…',
  empty: 'No scanner has reported host inventory for this asset yet.',
  loadError: 'The scanner data could not be loaded. The asset record is unaffected.',
  gone: 'This asset no longer exists.',
  noHardware: 'This source has not reported hardware for this host.',
  editNote: 'What the scanner last reported. A value becomes part of the asset record only when you use it and save.',
  viewNoteEditor: 'What the scanner last reported. It does not change the asset record. To copy a value into the asset record, use Edit on the asset.',
  viewNoteReadOnly: 'What the scanner last reported. It does not change the asset record. Read-only: only a Tenant Owner or MSP Admin can copy a value into the asset record.',
  differs: 'Differs from record',
  blank: 'Blank in record',
  useValue: 'Use scanner value',
  scannerValueHelp: 'Scanner value, not saved yet.',
  softwareNote: 'Reported by the scanner. This is not the approved software list: record approval decisions in the Software Inventory.',
  softwareEmpty: 'No installed software has been reported for this asset.',
  softwareLoading: 'Loading the installed software…',
  softwareError: 'The installed software could not be loaded. The asset record is unaffected.',
  loadMore: 'Load up to 10,000',
  retry: 'Retry',
} as const;

export const OBSERVED_FIELD_LABEL: Record<ObservedField, string> = {
  ipAddress: 'IP address',
  macAddress: 'MAC address',
  serialNumber: 'Serial number',
  os: 'OS profile',
};

/** The software list asks for this many items first, and at most this many on request (the server's own cap). */
export const SOFTWARE_PAGE_LIMIT = 1000;
export const SOFTWARE_MAX_LIMIT = 10000;

// --- Saving only what changed ---

const TEXT_FIELDS = ['hostName', 'ipAddress', 'macAddress', 'notes', 'owner', 'manufacturer', 'model', 'serialNumber', 'location'] as const;
const FIPS_KEYS = ['fipsValidationStatus', 'fipsCertificateNumber', 'fipsModuleName', 'fipsStandard'] as const;

/**
 * The fields of an edit that differ from the asset as it was loaded. An edit sends only these: a field the form did not change is left
 * to the server (scan data and discovery data may have changed since the form opened, and a reported OS profile the form cannot show
 * must not be overwritten by the form's 'custom'). The category and the four FIPS fields travel together, because the server validates
 * them as one. Status, origin, discovery and scan fields are never sent.
 */
export function assetEditPatch(before: EnclaveAsset, after: Omit<EnclaveAsset, 'id'>): AssetInput {
  const patch: Record<string, unknown> = {};
  for (const f of TEXT_FIELDS) {
    if ((before[f] ?? '') !== (after[f] ?? '')) patch[f] = after[f] ?? '';
  }
  if (after.osProfile !== before.osProfile && after.osProfile !== osProfileSelectValue(before.osProfile)) patch.osProfile = after.osProfile;
  const fipsChanged = FIPS_KEYS.some((k) => (before[k] ?? null) !== (after[k] ?? null));
  if (before.cmmcAssetCategory !== after.cmmcAssetCategory || fipsChanged) {
    patch.cmmcAssetCategory = after.cmmcAssetCategory;
    const fips: Record<string, unknown> = {};
    for (const k of FIPS_KEYS) fips[k] = after[k] ?? null;
    Object.assign(patch, fips as unknown as FipsFields);
  }
  return patch as AssetInput;
}

// --- Display text ---

/** A host's OS as one line: name and version, whichever are reported. */
export function osText(host: Pick<VmObservedHost, 'os'>): string {
  return [host.os.name, host.os.version].map((p) => p.trim()).filter(Boolean).join(' ');
}

/**
 * The OS text to show beside the form's OS select when it reads 'custom': the raw text the asset carries, else what the first source
 * reported. Null when the select shows a known profile (nothing to explain) or nothing is known.
 */
export function reportedOsText(rawProfile: string | null | undefined, observed: VmObservedHost[]): string | null {
  if (osProfileSelectValue(rawProfile) !== 'custom') return null;
  const raw = String(rawProfile ?? '').trim();
  if (raw !== '' && raw !== 'custom') return raw;
  for (const h of observed) {
    const t = osText(h);
    if (t !== '') return t;
  }
  return null;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

const oneDecimal = (n: number): string => {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** Memory in binary units with one decimal that is dropped when it is zero ("16 GiB", "1.5 GiB"); "Not reported" when unknown. */
export function formatMemoryBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return NOT_REPORTED;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${oneDecimal(value)} ${UNITS[unit]}`;
}

/** A clock speed from MHz: GHz with one decimal from 1000 MHz up; "Not reported" when unknown. */
export function formatCpuSpeed(mhz: number | null | undefined): string {
  if (typeof mhz !== 'number' || !Number.isFinite(mhz) || mhz <= 0) return NOT_REPORTED;
  return mhz >= 1000 ? `${oneDecimal(mhz / 1000)} GHz` : `${Math.round(mhz)} MHz`;
}

// --- The software list ---

export type SoftwareTypeFilter = 'all' | 'packages' | 'hotfixes';

export const isHotfix = (item: Pick<VmObservedSoftware, 'type'>): boolean => item.type.trim().toLowerCase() === 'hotfix';

/** The items whose name, version or vendor contains the query (case-insensitive), narrowed to packages or hotfixes. */
export function filterObservedSoftware(items: VmObservedSoftware[], query: string, type: SoftwareTypeFilter): VmObservedSoftware[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (type === 'hotfixes' && !isHotfix(it)) return false;
    if (type === 'packages' && isHotfix(it)) return false;
    if (q === '') return true;
    return [it.name, it.version, it.vendor].some((v) => v.toLowerCase().includes(q));
  });
}

const itemsLabel = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;

/** "Showing 12 of 340 loaded items" while a filter hides some, otherwise the plain count. */
export function observedSoftwareCaption(shown: number, loaded: number): string {
  if (loaded === 0) return 'No software loaded';
  if (shown === loaded) return `Showing ${itemsLabel(loaded)}`;
  return `Showing ${shown} of ${itemsLabel(loaded)} loaded`;
}

/** The note for a list the server cut short; null when everything is loaded. */
export function truncationNotice(loaded: number, total: number): string | null {
  if (total <= loaded) return null;
  return `Showing the first ${loaded} of ${total} items reported. Search and filters apply to the items shown.`;
}
