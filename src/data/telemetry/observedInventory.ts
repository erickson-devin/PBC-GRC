import type { EnclaveAsset } from '../../types/telemetry';
import { VM_SOURCE_KINDS } from '../../types/vm';
import type { VmObservedHost, VmObservedHostWithAsset, VmObservedSoftware, VmObservedSoftwareGroup, VmSourceKind } from '../../types/vm';
import { isKnownOsProfile, osProfileFor } from './osProfile';

/**
 * What the scanners observed about a host (docs/VULNERABILITY_MANAGEMENT.md, section 5.6), read defensively from the API, and the
 * comparison with what a person recorded on the asset. Pure: no network, no storage. The server imports usableSerial from here too.
 */

/** Serial numbers firmware ships when nobody filled them in: they identify nothing, so they are never used. */
const PLACEHOLDER_SERIALS = new Set([
  'to be filled by o.e.m.',
  'default string',
  'system serial number',
  'none',
  'n/a',
  'not specified',
  'chassis serial number',
]);

/** True when a reported serial number can identify a machine: not blank, not all zeros, not a firmware placeholder. */
export function usableSerial(serial: string | null | undefined): boolean {
  const s = String(serial ?? '').trim();
  if (s === '' || /^0+$/.test(s)) return false;
  return !PLACEHOLDER_SERIALS.has(s.toLowerCase());
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseHost(raw: unknown): VmObservedHost | null {
  if (!isObj(raw) || str(raw.sourceId) === '') return null;
  const os = isObj(raw.os) ? raw.os : {};
  const hw = isObj(raw.hardware) ? raw.hardware : null;
  const kind = (VM_SOURCE_KINDS as readonly string[]).includes(str(raw.sourceKind)) ? (str(raw.sourceKind) as VmSourceKind) : 'WAZUH';
  return {
    sourceId: str(raw.sourceId),
    sourceKind: kind,
    sourceLabel: str(raw.sourceLabel),
    hostname: str(raw.hostname),
    ipAddress: str(raw.ipAddress),
    macAddress: str(raw.macAddress),
    os: { name: str(os.name), version: str(os.version), platform: str(os.platform), kernel: str(os.kernel) },
    hardware: hw
      ? {
          architecture: str(hw.architecture),
          cpuName: str(hw.cpuName),
          cpuCores: num(hw.cpuCores),
          cpuMhz: num(hw.cpuMhz),
          memoryBytes: num(hw.memoryBytes),
          serialNumber: str(hw.serialNumber),
        }
      : null,
    softwareReported: raw.softwareReported === true,
    softwareCount: num(raw.softwareCount) ?? 0,
    collectedAt: str(raw.collectedAt),
    firstSeenAt: str(raw.firstSeenAt),
    lastSeenAt: str(raw.lastSeenAt),
  };
}

/** The hosts of an inventory response (the body or its `observed` list); anything malformed is dropped. */
export function parseObservedHosts(raw: unknown): VmObservedHost[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.observed) ? raw.observed : [];
  return list.map(parseHost).filter((h): h is VmObservedHost => h !== null);
}

/** The software of a software response (the body); malformed items are dropped and the total falls back to the item count. */
export function parseObservedSoftware(raw: unknown): { totalCount: number; items: VmObservedSoftware[] } {
  const list = isObj(raw) && Array.isArray(raw.items) ? raw.items : [];
  const items: VmObservedSoftware[] = [];
  for (const it of list) {
    if (!isObj(it) || str(it.name) === '') continue;
    items.push({
      sourceId: str(it.sourceId),
      name: str(it.name),
      version: str(it.version),
      vendor: str(it.vendor),
      architecture: str(it.architecture),
      type: str(it.type),
      installedAt: typeof it.installedAt === 'string' ? it.installedAt : null,
      firstSeenAt: str(it.firstSeenAt),
      lastSeenAt: str(it.lastSeenAt),
    });
  }
  return { totalCount: isObj(raw) ? (num(raw.totalCount) ?? items.length) : items.length, items };
}

/** The hosts of a program-wide response (GET /vm/inventory/hosts); a row without an asset id or a source id is dropped. */
export function parseProgramObservedHosts(raw: unknown): VmObservedHostWithAsset[] {
  const list = isObj(raw) && Array.isArray(raw.hosts) ? raw.hosts : [];
  const out: VmObservedHostWithAsset[] = [];
  for (const it of list) {
    const host = parseHost(it);
    const assetId = isObj(it) ? str(it.assetId) : '';
    if (host && assetId !== '') out.push({ ...host, assetId });
  }
  return out;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The package groups of a program-wide response (GET /vm/inventory/software); nameless groups are dropped, the total falls back to the group count. */
export function parseObservedSoftwareGroups(raw: unknown): { totalGroups: number; truncated: boolean; items: VmObservedSoftwareGroup[] } {
  const list = isObj(raw) && Array.isArray(raw.items) ? raw.items : [];
  const items: VmObservedSoftwareGroup[] = [];
  for (const it of list) {
    if (!isObj(it) || str(it.name) === '') continue;
    const assetIds = strList(it.assetIds);
    items.push({
      name: str(it.name),
      version: str(it.version),
      vendor: str(it.vendor),
      assetCount: num(it.assetCount) ?? assetIds.length,
      assetIds,
      sourceIds: strList(it.sourceIds),
      firstSeenAt: str(it.firstSeenAt),
      lastSeenAt: str(it.lastSeenAt),
    });
  }
  const totalGroups = isObj(raw) ? (num(raw.totalGroups) ?? items.length) : items.length;
  return { totalGroups, truncated: isObj(raw) && raw.truncated === true, items };
}

export type ObservedField = 'ipAddress' | 'macAddress' | 'serialNumber' | 'os';

export interface ObservedComparisonRow {
  field: ObservedField;
  sourceId: string;
  sourceLabel: string;
  /** What the asset records ('os': the profile key). */
  recorded: string;
  /** What the source observed ('os': the reported name and version). */
  observed: string;
  /** True when the source observed a usable value that disagrees with the recorded one. */
  differs: boolean;
  /** False for a blank value or an unusable serial number: there is nothing worth copying to the asset. */
  usable: boolean;
}

type RecordedAsset = Pick<EnclaveAsset, 'ipAddress' | 'macAddress' | 'osProfile' | 'serialNumber'>;

const macKey = (m: string): string => m.replace(/[:.\-\s]/g, '').toLowerCase();
const lower = (s: string): string => s.trim().toLowerCase();

/** One row per field per host: the recorded value beside what that source observed. */
export function compareRecordedObserved(asset: RecordedAsset, observed: VmObservedHost[]): ObservedComparisonRow[] {
  const rows: ObservedComparisonRow[] = [];
  for (const h of observed) {
    const base = { sourceId: h.sourceId, sourceLabel: h.sourceLabel };

    const ip = h.ipAddress.trim();
    const recIp = (asset.ipAddress ?? '').trim();
    rows.push({ ...base, field: 'ipAddress', recorded: recIp, observed: ip, usable: ip !== '', differs: ip !== '' && lower(ip) !== lower(recIp) });

    const mac = h.macAddress.trim();
    const recMac = (asset.macAddress ?? '').trim();
    const macUsable = mac !== '' && !/^0+$/.test(macKey(mac));
    rows.push({ ...base, field: 'macAddress', recorded: recMac, observed: mac, usable: macUsable, differs: macUsable && macKey(mac) !== macKey(recMac) });

    const serial = (h.hardware?.serialNumber ?? '').trim();
    const recSerial = (asset.serialNumber ?? '').trim();
    const serialOk = usableSerial(serial);
    rows.push({ ...base, field: 'serialNumber', recorded: recSerial, observed: serial, usable: serialOk, differs: serialOk && lower(serial) !== lower(recSerial) });

    const osText = [h.os.name, h.os.version].map((p) => p.trim()).filter(Boolean).join(' ');
    const recProfile = String(asset.osProfile ?? '');
    const observedProfile = osText === '' ? '' : osProfileFor(h.os.name, h.os.version);
    // A recorded 'custom' profile says nothing about the system, so it never counts as a disagreement.
    const osDiffers = isKnownOsProfile(recProfile) && observedProfile !== '' && observedProfile !== recProfile;
    rows.push({ ...base, field: 'os', recorded: recProfile, observed: osText, usable: isKnownOsProfile(observedProfile), differs: osDiffers });
  }
  return rows;
}
