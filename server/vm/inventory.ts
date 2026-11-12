import type { IngestPayload } from './ingestSchema';
import { usableSerial } from '../../src/data/telemetry/observedInventory';
import { isKnownOsProfile, osProfileFor } from '../../src/data/telemetry/osProfile';

/**
 * Inventory adapter: turns the `hardware` and `software` of a validated ingest payload into one record per host, keyed by the host's agent
 * id (docs/VULNERABILITY_MANAGEMENT.md, section 5.6), and plans which blank asset fields a report may fill. Pure: no database.
 */

export { usableSerial };

export interface NormalizedHardware {
  architecture: string;
  cpuName: string;
  cpuCores: number | null;
  cpuMhz: number | null;
  memoryBytes: number | null;
  serialNumber: string;
}

export interface NormalizedSoftwareItem {
  name: string;
  version: string;
  vendor: string;
  architecture: string;
  type: string;
  /** ISO 8601 in UTC, or null. */
  installedAt: string | null;
}

export interface NormalizedInventory {
  ip: string;
  mac: string;
  os: { name: string; version: string; platform: string; kernel: string };
  /** Null when the host sent no hardware. */
  hardware: NormalizedHardware | null;
  /** Null when the host sent no software list (an empty list is a list: nothing is installed). */
  software: NormalizedSoftwareItem[] | null;
}

const iso = (v: string | undefined): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** The inventory of every host that reports hardware or software, by agent id. Software repeats (name, version, architecture) keep the first. */
export function normalizeInventory(payload: IngestPayload): Map<string, NormalizedInventory> {
  const out = new Map<string, NormalizedInventory>();
  for (const host of payload.hosts) {
    if (host.hardware === undefined && host.software === undefined) continue;
    const hw = host.hardware;
    let software: NormalizedSoftwareItem[] | null = null;
    if (host.software !== undefined) {
      const seen = new Set<string>();
      software = [];
      for (const s of host.software) {
        const item: NormalizedSoftwareItem = {
          name: s.name,
          version: s.version ?? '',
          vendor: s.vendor ?? '',
          architecture: s.architecture ?? '',
          type: s.type ?? '',
          installedAt: iso(s.installed_at),
        };
        const key = JSON.stringify([item.name, item.version, item.architecture]);
        if (seen.has(key)) continue;
        seen.add(key);
        software.push(item);
      }
    }
    out.set(host.agent_id, {
      ip: host.ip ?? '',
      mac: host.mac ?? '',
      os: { name: host.os?.name ?? '', version: host.os?.version ?? '', platform: host.os?.platform ?? '', kernel: host.os?.kernel ?? '' },
      hardware: hw
        ? {
            architecture: hw.architecture ?? '',
            cpuName: hw.cpu_name ?? '',
            cpuCores: hw.cpu_cores ?? null,
            cpuMhz: hw.cpu_mhz ?? null,
            memoryBytes: hw.memory_bytes ?? null,
            serialNumber: hw.serial_number ?? '',
          }
        : null,
      software,
    });
  }
  return out;
}

export interface BlankFillAsset {
  sourceOrigin: string;
  ipAddress: string;
  macAddress: string;
  serialNumber: string;
  osProfile: string;
}

export interface BlankFills {
  ipAddress?: string;
  macAddress?: string;
  serialNumber?: string;
  osProfile?: string;
}

/**
 * The fields a report may fill: only on an asset the scanner created (AGENT_REPORT), only fields that are blank, only with a usable observed
 * value. The OS profile is also repaired when it is the raw OS name an earlier run stored (not a known key and equal to the reported name).
 * A person's value is never overwritten; the database repeats the same guards in SQL.
 */
export function planBlankFills(asset: BlankFillAsset, observed: NormalizedInventory): BlankFills {
  const fills: BlankFills = {};
  if (asset.sourceOrigin !== 'AGENT_REPORT') return fills;
  const ip = observed.ip.trim();
  if (asset.ipAddress.trim() === '' && ip !== '') fills.ipAddress = ip;
  const mac = observed.mac.trim();
  if (asset.macAddress.trim() === '' && mac !== '' && !/^[0:.\-\s]*$/.test(mac)) fills.macAddress = mac;
  const serial = (observed.hardware?.serialNumber ?? '').trim();
  if (asset.serialNumber.trim() === '' && usableSerial(serial)) fills.serialNumber = serial;
  if (observed.os.name !== '' && !isKnownOsProfile(asset.osProfile) && asset.osProfile === observed.os.name) {
    const profile = osProfileFor(observed.os.name, observed.os.version);
    if (profile !== asset.osProfile) fills.osProfile = profile;
  }
  return fills;
}
