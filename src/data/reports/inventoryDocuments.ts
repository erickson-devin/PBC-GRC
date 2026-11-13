import type {
  CompiledDocument,
  DocumentSummaryMetrics,
  InventoryPackageSection,
  ReportMetadata,
  ReportSection,
  ReportTable,
} from '../../types/report';
import type { EnclaveAsset } from '../../types/telemetry';
import type { SoftwareItem } from '../../types/software';
import type { VmObservedHostWithAsset, VmObservedSoftwareGroup } from '../../types/vm';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES, summarizeScope } from '../telemetry/assetScope';
import { compareRecordedObserved } from '../telemetry/observedInventory';
import type { ObservedComparisonRow, ObservedField } from '../telemetry/observedInventory';
import { NOT_RECORDED, UNNAMED_SYSTEM } from './documentDefaults';
import { csvCell } from './csv';

/**
 * Hardware and Software Inventory documents (issue #229, phase 1a), compiled from the asset inventory (and the manual
 * software list). Pure: no console, DOM or storage. Values are never invented: an empty field prints NOT_RECORDED.
 */

export const INVENTORY_DOCUMENT_TYPES = ['HARDWARE_INVENTORY', 'SOFTWARE_INVENTORY'] as const;

export const isInventoryDocumentType = (t: string): boolean => (INVENTORY_DOCUMENT_TYPES as readonly string[]).includes(t);

export const OS_PROFILE_LABELS: Record<string, string> = {
  rhel9: 'Red Hat Enterprise Linux 9',
  rhel8: 'Red Hat Enterprise Linux 8',
  win11: 'Windows 11',
  win2022: 'Windows Server 2022',
  ubuntu2204: 'Ubuntu 22.04 LTS',
  cisco_ios: 'Cisco IOS',
};

/** The label of an operating system profile; a custom or unknown profile is not named, so it is not recorded. */
export function osLabel(p: string | null | undefined): string {
  const key = String(p ?? '');
  return Object.prototype.hasOwnProperty.call(OS_PROFILE_LABELS, key) ? OS_PROFILE_LABELS[key] : NOT_RECORDED;
}

/**
 * What the scanners report for the program (issue #279), loaded by the export modal: the newest host row of each asset and the distinct
 * package groups. Only 'ready' data is used; 'error' adds a scope sentence, 'unsupported' (a browser-only tenant) adds nothing.
 */
export interface InventoryObserved {
  status: 'ready' | 'error' | 'unsupported';
  hosts: VmObservedHostWithAsset[];
  software: VmObservedSoftwareGroup[];
  totalGroups: number;
  truncated: boolean;
}

export interface InventoryInput {
  assets: EnclaveAsset[];
  software: SoftwareItem[];
  /** Absent: the documents list recorded data only, as before. */
  observed?: InventoryObserved;
}

export const NO_ASSETS_RECORDED = 'No assets are recorded in this program boundary.';
export const INVENTORY_NOT_LOADED = 'The asset inventory could not be loaded; this document was compiled without it.';
export const OBSERVED_NOT_LOADED = 'Scanner-reported data could not be loaded; this document lists recorded data only.';
export const HARDWARE_OBSERVED_NOTE = 'Values a person recorded are never replaced: where a scanner reports a different one, both are shown with their source.';
export const SOFTWARE_OBSERVED_NOTE = 'Scanner-reported software is listed with its approval state; Windows hotfixes are not listed.';
export const NOT_REPORTED_BY_SCANNER = 'Not reported by a scanner';
/** The sentence for a package list cut at the limit: the scanners report `total` distinct packages and `listed` are in the document. */
export const observedTruncatedText = (total: number, listed: number): string => `The scanners report ${total} distinct packages; this document lists the first ${listed} by name.`;

const HARDWARE_HEADERS = ['Asset', 'CMMC category', 'Manufacturer', 'Model', 'Serial number', 'Location', 'Owner', 'Operating system', 'OS version', 'CPU', 'Memory', 'IP address', 'MAC address', 'Discovery', 'Scanner last reported'];
const SOFTWARE_HEADERS = ['Software', 'Version', 'Vendor', 'Approved (CM.L2-3.4.8)', 'Installed on', 'Source', 'Last reported'];

const orNotRecorded = (v: string | null | undefined): string => (v && v.trim() ? v : NOT_RECORDED);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const byHostName = (a: EnclaveAsset, b: EnclaveAsset): number => a.hostName.localeCompare(b.hostName);

type HardwareEntry = NonNullable<InventoryPackageSection['hardware']>[number];
type SoftwareEntry = NonNullable<InventoryPackageSection['software']>[number];

/** The scanner data the documents use: only when it loaded. */
const readyObserved = (input: InventoryInput | undefined): InventoryObserved | null => (input?.observed?.status === 'ready' ? input.observed : null);

/** The newest report (by last seen) of each asset; on a tie the earlier row of the list wins. */
function newestHostByAsset(observed: InventoryObserved | null): Map<string, VmObservedHostWithAsset> {
  const out = new Map<string, VmObservedHostWithAsset>();
  for (const h of observed?.hosts ?? []) {
    const cur = out.get(h.assetId);
    if (!cur || Date.parse(h.lastSeenAt) > Date.parse(cur.lastSeenAt)) out.set(h.assetId, h);
  }
  return out;
}

const dateOf = (iso: string): string | null => /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? null;

/** A recorded value beside what the scanner reports: the recorded one is kept; a blank one is filled from the scanner (marked); a different one is shown with both. */
function recordedOrScanner(recorded: string | null | undefined, row: ObservedComparisonRow | undefined): string {
  const rec = String(recorded ?? '');
  if (!row || !row.usable) return orNotRecorded(rec);
  if (rec.trim() === '') return `${row.observed} (scanner)`;
  return row.differs ? `${rec} (scanner reports: ${row.observed})` : rec;
}

function cpuCell(hw: VmObservedHostWithAsset['hardware'] | undefined): string {
  if (!hw) return NOT_RECORDED;
  const name = hw.cpuName.trim();
  const cores = hw.cpuCores !== null && hw.cpuCores > 0 ? plural(hw.cpuCores, 'core', 'cores') : '';
  return name && cores ? `${name} (${cores})` : name || cores || NOT_RECORDED;
}

const memoryCell = (hw: VmObservedHostWithAsset['hardware'] | undefined): string =>
  hw && hw.memoryBytes !== null && hw.memoryBytes > 0 ? `${(hw.memoryBytes / 2 ** 30).toFixed(1)} GiB` : NOT_RECORDED;

function hardwareRows(assets: EnclaveAsset[], observed: InventoryObserved | null): { entry: HardwareEntry; cells: string[] }[] {
  const newest = newestHostByAsset(observed);
  return [...assets].sort(byHostName).map((a) => {
    const host = newest.get(a.id);
    const rows = host ? compareRecordedObserved(a, [host]) : [];
    const field = (f: ObservedField) => rows.find((r) => r.field === f);
    const osRow = field('os');
    const recordedOs = osLabel(a.osProfile);
    const scannerOsName = host?.os.name.trim() ?? '';
    const osCell =
      recordedOs !== NOT_RECORDED
        ? osRow?.differs ? `${recordedOs} (scanner reports: ${osRow.observed})` : recordedOs
        : scannerOsName ? `${scannerOsName} (scanner)` : NOT_RECORDED;
    const osVersion = orNotRecorded(host?.os.version.trim());
    const cpu = cpuCell(host?.hardware);
    const memory = memoryCell(host?.hardware);
    const day = host ? dateOf(host.lastSeenAt) : null;
    const reported = host && day ? `${day}${host.sourceLabel.trim() ? ` (${host.sourceLabel.trim()})` : ''}` : NOT_REPORTED_BY_SCANNER;
    const serial = recordedOrScanner(a.serialNumber, field('serialNumber'));
    const ip = recordedOrScanner(a.ipAddress, field('ipAddress'));
    const mac = recordedOrScanner(a.macAddress, field('macAddress'));
    const entry: HardwareEntry = {
      assetId: a.id,
      hostName: orNotRecorded(a.hostName),
      cmmcAssetCategory: CATEGORY_INFO[a.cmmcAssetCategory]?.label ?? NOT_RECORDED,
      manufacturer: orNotRecorded(a.manufacturer),
      model: orNotRecorded(a.model),
      serialNumber: orNotRecorded(a.serialNumber),
      location: orNotRecorded(a.location),
      owner: orNotRecorded(a.owner),
      osProfile: recordedOs,
      ipAddress: orNotRecorded(a.ipAddress),
      macAddress: orNotRecorded(a.macAddress),
      discoveryStatus: a.discoveryStatus === 'UNCONFIRMED_DISCOVERY' ? 'Unconfirmed' : 'Confirmed',
      osVersion,
      cpu,
      memory,
      observed: host
        ? {
            sourceLabel: host.sourceLabel,
            lastSeenAt: host.lastSeenAt,
            osName: host.os.name,
            osVersion: host.os.version,
            cpuName: host.hardware?.cpuName ?? '',
            cpuCores: host.hardware?.cpuCores ?? null,
            memoryBytes: host.hardware?.memoryBytes ?? null,
            serialNumber: host.hardware?.serialNumber ?? '',
            ipAddress: host.ipAddress,
            macAddress: host.macAddress,
          }
        : null,
    };
    const cells = [
      entry.hostName, entry.cmmcAssetCategory, entry.manufacturer, entry.model, serial, entry.location, entry.owner, osCell, osVersion, cpu, memory, ip, mac, entry.discoveryStatus, reported,
    ];
    return { entry, cells };
  });
}

const hardwareEntries = (assets: EnclaveAsset[], observed: InventoryObserved | null): HardwareEntry[] => hardwareRows(assets, observed).map((r) => r.entry);

export function hardwareInventoryTable(assets: EnclaveAsset[], observed: InventoryObserved | null = null): ReportTable {
  return { headers: [...HARDWARE_HEADERS], rows: hardwareRows(assets, observed).map((r) => r.cells) };
}

/** The key two software records share when they are the same software: lower-cased trimmed name and vendor, exact trimmed version (never architecture). */
const softwareKey = (name: string, version: string, vendor: string): string => JSON.stringify([name.trim().toLowerCase(), version.trim(), vendor.trim().toLowerCase()]);

const approvalCell = (approved: boolean | null): string => (approved === true ? 'Approved' : approved === false ? 'Not approved' : NOT_RECORDED);

interface SoftwareRow {
  entry: SoftwareEntry;
  cells: string[];
}

const compareRows = (a: { name: string; version: string }, b: { name: string; version: string }): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.version.localeCompare(b.version);

/** The manual entries, merged with the scanner's package groups on the exact key, then the scanner-only groups, by name and version; then the operating system rows. */
function softwareRows(software: SoftwareItem[], assets: EnclaveAsset[], observed: InventoryObserved | null): SoftwareRow[] {
  const hostById = new Map(assets.map((a) => [a.id, a.hostName]));
  const labelOf = new Map<string, string>();
  for (const h of observed?.hosts ?? []) if (h.sourceLabel.trim()) labelOf.set(h.sourceId, h.sourceLabel.trim());
  const labelsFor = (ids: string[]): string[] => [...new Set(ids.map((id) => labelOf.get(id) ?? id))].sort((a, b) => a.localeCompare(b));
  const installedOn = (g: VmObservedSoftwareGroup): string => {
    const names = g.assetIds.map((id) => hostById.get(id));
    if (g.assetCount <= 10 && g.assetIds.length === g.assetCount && names.every((n) => n !== undefined)) {
      return `${plural(g.assetCount, 'asset', 'assets')}: ${(names as string[]).map(orNotRecorded).sort((a, b) => a.localeCompare(b)).join(', ')}`;
    }
    return plural(g.assetCount, 'asset', 'assets');
  };

  const groups = new Map<string, VmObservedSoftwareGroup>();
  for (const g of observed?.software ?? []) groups.set(softwareKey(g.name, g.version, g.vendor), g);
  const merged = new Set<string>();

  const manual: (SoftwareRow & { name: string; version: string })[] = software.map((s) => {
    const key = softwareKey(s.name, s.version, s.vendor);
    const g = groups.get(key);
    const take = g !== undefined && !merged.has(key); // a second manual entry with the same key keeps its own row, without the scanner data
    if (take) merged.add(key);
    const manualOn = s.assetId === null ? 'Tenant-wide' : orNotRecorded(hostById.get(s.assetId));
    const labels = take ? labelsFor(g.sourceIds) : [];
    const day = take ? dateOf(g.lastSeenAt) : null;
    const entry: SoftwareEntry = {
      id: s.id,
      name: orNotRecorded(s.name),
      version: orNotRecorded(s.version),
      vendor: orNotRecorded(s.vendor),
      approved: s.approved,
      assetId: s.assetId,
      hostName: s.assetId === null ? null : hostById.get(s.assetId) ?? null,
      source: take ? 'MANUAL_AND_SCANNER' : 'MANUAL',
      ...(take ? { assetCount: g.assetCount, sourceLabels: labels, lastReportedAt: g.lastSeenAt } : {}),
    };
    const cells = [
      entry.name,
      entry.version,
      entry.vendor,
      approvalCell(s.approved),
      take ? (s.assetId === null ? installedOn(g) : `${manualOn}; scanner: ${installedOn(g)}`) : manualOn,
      take ? `Manual entry; scanner: ${labels.join(', ')}` : 'Manual entry',
      day ?? NOT_REPORTED_BY_SCANNER,
    ];
    return { entry, cells, name: entry.name, version: entry.version };
  });

  const scannerOnly: (SoftwareRow & { name: string; version: string })[] = [];
  for (const [key, g] of groups) {
    if (merged.has(key)) continue;
    const labels = labelsFor(g.sourceIds);
    const entry: SoftwareEntry = {
      id: null,
      name: orNotRecorded(g.name),
      version: orNotRecorded(g.version),
      vendor: orNotRecorded(g.vendor),
      approved: null,
      assetId: null,
      hostName: null,
      source: 'SCANNER',
      assetCount: g.assetCount,
      sourceLabels: labels,
      lastReportedAt: g.lastSeenAt,
    };
    const cells = [entry.name, entry.version, entry.vendor, approvalCell(null), installedOn(g), `Scanner: ${labels.join(', ')}`, dateOf(g.lastSeenAt) ?? NOT_REPORTED_BY_SCANNER];
    scannerOnly.push({ entry, cells, name: entry.name, version: entry.version });
  }

  // Array.prototype.sort is stable: equal names and versions keep the manual entries before the scanner's.
  const rows: SoftwareRow[] = [...manual, ...scannerOnly].sort(compareRows);

  // Operating systems: grouped by what the scanner reports (name and version) when it reports one, else by the recorded profile.
  const newest = newestHostByAsset(observed);
  const osGroups = new Map<string, { name: string; version: string; hosts: string[]; labels: Set<string>; last: string }>();
  for (const a of assets) {
    const host = newest.get(a.id);
    const scannerName = host?.os.name.trim() ?? '';
    const profile = String(a.osProfile ?? '');
    const key = host && scannerName ? JSON.stringify(['scanner', scannerName.toLowerCase(), host.os.version.trim()]) : JSON.stringify(['profile', profile]);
    const g = osGroups.get(key) ?? {
      name: host && scannerName ? scannerName : osLabel(profile),
      version: host && scannerName ? orNotRecorded(host.os.version.trim()) : NOT_RECORDED,
      hosts: [],
      labels: new Set<string>(),
      last: '',
    };
    g.hosts.push(orNotRecorded(a.hostName));
    if (host && scannerName) {
      if (host.sourceLabel.trim()) g.labels.add(host.sourceLabel.trim());
      if (dateOf(host.lastSeenAt) && host.lastSeenAt > g.last) g.last = host.lastSeenAt;
    }
    osGroups.set(key, g);
  }
  const osRows = [...osGroups.values()].sort(compareRows).map((g): SoftwareRow => {
    const hosts = g.hosts.sort((a, b) => a.localeCompare(b));
    const labels = [...g.labels].sort((a, b) => a.localeCompare(b));
    const entry: SoftwareEntry = {
      id: null,
      name: g.name,
      version: g.version,
      vendor: NOT_RECORDED,
      approved: null,
      assetId: null,
      hostName: null,
      source: 'ASSET_OS',
      assetCount: hosts.length,
      ...(labels.length > 0 ? { sourceLabels: labels } : {}),
      ...(g.last ? { lastReportedAt: g.last } : {}),
    };
    const cells = [g.name, g.version, NOT_RECORDED, NOT_RECORDED, `${plural(hosts.length, 'asset', 'assets')}: ${hosts.join(', ')}`, 'Asset operating system', (g.last && dateOf(g.last)) || NOT_REPORTED_BY_SCANNER];
    return { entry, cells };
  });
  return [...rows, ...osRows];
}

const softwareEntries = (software: SoftwareItem[], assets: EnclaveAsset[], observed: InventoryObserved | null): SoftwareEntry[] => softwareRows(software, assets, observed).map((r) => r.entry);

export function softwareInventoryTable(software: SoftwareItem[], assets: EnclaveAsset[], observed: InventoryObserved | null = null): ReportTable {
  return { headers: [...SOFTWARE_HEADERS], rows: softwareRows(software, assets, observed).map((r) => r.cells) };
}

function scopeContent(input: InventoryInput | undefined, hardware: boolean): string {
  if (!input) return INVENTORY_NOT_LOADED;
  if (input.assets.length === 0) return NO_ASSETS_RECORDED;
  const s = summarizeScope(input.assets);
  const parts = CMMC_ASSET_CATEGORIES.map((c) => `${CATEGORY_INFO[c].label}: ${s.byCategory[c]}`);
  let text = `${plural(s.total, 'asset is', 'assets are')} recorded in this program boundary (${parts.join('; ')}).`;
  if (s.unconfirmed > 0) text += ` ${plural(s.unconfirmed, 'asset is', 'assets are')} discovered but not yet confirmed.`;
  if (s.decommissioned > 0) text += ` ${plural(s.decommissioned, 'decommissioned asset is', 'decommissioned assets are')} listed with its discovery state.`;
  if (input.observed?.status === 'error') text += ` ${OBSERVED_NOT_LOADED}`;
  const observed = readyObserved(input);
  if (observed) {
    if (hardware) {
      text += ` ${HARDWARE_OBSERVED_NOTE}`;
    } else {
      text += ` ${SOFTWARE_OBSERVED_NOTE}`;
      const scanner = softwareEntries(input.software, input.assets, observed).filter((e) => e.source === 'SCANNER' || e.source === 'MANUAL_AND_SCANNER');
      const approved = scanner.filter((e) => e.approved === true).length;
      const notApproved = scanner.filter((e) => e.approved === false).length;
      text += ` ${plural(scanner.length, 'scanner-reported package is', 'scanner-reported packages are')} listed: ${approved} approved, ${notApproved} not approved, ${scanner.length - approved - notApproved} not reviewed.`;
      if (observed.truncated) text += ` ${observedTruncatedText(observed.totalGroups, observed.software.length)}`;
    }
  }
  return text;
}

function compileInventory(
  kind: InventoryPackageSection['kind'],
  metadata: ReportMetadata,
  input: InventoryInput | undefined,
  metrics: DocumentSummaryMetrics
): CompiledDocument {
  const hardware = kind === 'HARDWARE_INVENTORY';
  const assets = input?.assets ?? [];
  const observed = readyObserved(input);
  const table = hardware ? hardwareInventoryTable(assets, observed) : softwareInventoryTable(input?.software ?? [], assets, observed);
  const sections: ReportSection[] = [
    { id: 'inventory-scope', title: 'Scope', content: scopeContent(input, hardware) },
    { id: 'inventory-table', title: hardware ? 'Hardware Inventory' : 'Software Inventory', table: input ? table : { headers: table.headers, rows: [] } },
  ];
  const inventory: InventoryPackageSection = { kind };
  if (hardware) inventory.hardware = input ? hardwareEntries(assets, observed) : [];
  else inventory.software = input ? softwareEntries(input.software, assets, observed) : [];
  return {
    documentType: kind,
    title: hardware ? 'Hardware Inventory' : 'Software Inventory',
    subtitle: hardware
      ? `Hardware inventory for ${metadata.systemName || UNNAMED_SYSTEM} (CMMC CM.L2-3.4.1)`
      : `Software inventory for ${metadata.systemName || UNNAMED_SYSTEM} (CMMC CM.L2-3.4.1 and CM.L2-3.4.8)`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    inventory,
  };
}

export function compileHardwareInventory(metadata: ReportMetadata, input: InventoryInput | undefined, metrics: DocumentSummaryMetrics): CompiledDocument {
  return compileInventory('HARDWARE_INVENTORY', metadata, input, metrics);
}

export function compileSoftwareInventory(metadata: ReportMetadata, input: InventoryInput | undefined, metrics: DocumentSummaryMetrics): CompiledDocument {
  return compileInventory('SOFTWARE_INVENTORY', metadata, input, metrics);
}

/** RFC 4180 CSV of the inventory table. A cell a spreadsheet could read as a formula gets a leading apostrophe. */
export function generateInventoryCsv(doc: CompiledDocument): string {
  const table = doc.sections.find((s) => s.id === 'inventory-table')?.table;
  if (!table) return '';
  let csv = table.headers.map(csvCell).join(',') + '\r\n';
  for (const row of table.rows) {
    const cells = Array.isArray(row) ? row : row.cells;
    csv += cells.map(csvCell).join(',') + '\r\n';
  }
  return csv;
}
