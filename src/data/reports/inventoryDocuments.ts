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
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES, summarizeScope } from '../telemetry/assetScope';
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

export interface InventoryInput {
  assets: EnclaveAsset[];
  software: SoftwareItem[];
}

export const NO_ASSETS_RECORDED = 'No assets are recorded in this program boundary.';
export const INVENTORY_NOT_LOADED = 'The asset inventory could not be loaded; this document was compiled without it.';

const HARDWARE_HEADERS = ['Asset', 'CMMC category', 'Manufacturer', 'Model', 'Serial number', 'Location', 'Owner', 'Operating system', 'IP address', 'MAC address', 'Discovery'];
const SOFTWARE_HEADERS = ['Software', 'Version', 'Vendor', 'Approved (CM.L2-3.4.8)', 'Installed on', 'Source'];

const orNotRecorded = (v: string | null | undefined): string => (v && v.trim() ? v : NOT_RECORDED);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const byHostName = (a: EnclaveAsset, b: EnclaveAsset): number => a.hostName.localeCompare(b.hostName);

function hardwareEntries(assets: EnclaveAsset[]): NonNullable<InventoryPackageSection['hardware']> {
  return [...assets].sort(byHostName).map((a) => ({
    assetId: a.id,
    hostName: orNotRecorded(a.hostName),
    cmmcAssetCategory: CATEGORY_INFO[a.cmmcAssetCategory]?.label ?? NOT_RECORDED,
    manufacturer: orNotRecorded(a.manufacturer),
    model: orNotRecorded(a.model),
    serialNumber: orNotRecorded(a.serialNumber),
    location: orNotRecorded(a.location),
    owner: orNotRecorded(a.owner),
    osProfile: osLabel(a.osProfile),
    ipAddress: orNotRecorded(a.ipAddress),
    macAddress: orNotRecorded(a.macAddress),
    discoveryStatus: a.discoveryStatus === 'UNCONFIRMED_DISCOVERY' ? 'Unconfirmed' : 'Confirmed',
  }));
}

export function hardwareInventoryTable(assets: EnclaveAsset[]): ReportTable {
  return {
    headers: [...HARDWARE_HEADERS],
    rows: hardwareEntries(assets).map((h) => [
      h.hostName, h.cmmcAssetCategory, h.manufacturer, h.model, h.serialNumber, h.location, h.owner, h.osProfile, h.ipAddress, h.macAddress, h.discoveryStatus,
    ]),
  };
}

function softwareEntries(software: SoftwareItem[], assets: EnclaveAsset[]): NonNullable<InventoryPackageSection['software']> {
  const hostById = new Map(assets.map((a) => [a.id, a.hostName]));
  const out: NonNullable<InventoryPackageSection['software']> = software.map((s) => ({
    id: s.id,
    name: orNotRecorded(s.name),
    version: orNotRecorded(s.version),
    vendor: orNotRecorded(s.vendor),
    approved: s.approved,
    assetId: s.assetId,
    hostName: s.assetId === null ? null : hostById.get(s.assetId) ?? null,
    source: 'MANUAL',
  }));
  return out;
}

/** The distinct operating system profiles of the assets, with the host names running each, in a stable order. */
function osGroups(assets: EnclaveAsset[]): { profile: string; hosts: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const a of assets) {
    const profile = String(a.osProfile ?? '');
    const hosts = groups.get(profile) ?? [];
    hosts.push(orNotRecorded(a.hostName));
    groups.set(profile, hosts);
  }
  return [...groups.entries()]
    .map(([profile, hosts]) => ({ profile, hosts: hosts.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => osLabel(a.profile).localeCompare(osLabel(b.profile)) || a.profile.localeCompare(b.profile));
}

const approvalCell = (approved: boolean | null): string => (approved === true ? 'Approved' : approved === false ? 'Not approved' : NOT_RECORDED);

export function softwareInventoryTable(software: SoftwareItem[], assets: EnclaveAsset[]): ReportTable {
  const rows: string[][] = softwareEntries(software, assets).map((s) => [
    s.name,
    s.version,
    s.vendor,
    approvalCell(s.approved),
    s.assetId === null ? 'Tenant-wide' : orNotRecorded(s.hostName),
    'Manual entry',
  ]);
  for (const g of osGroups(assets)) {
    rows.push([osLabel(g.profile), NOT_RECORDED, NOT_RECORDED, NOT_RECORDED, `${plural(g.hosts.length, 'asset', 'assets')}: ${g.hosts.join(', ')}`, 'Asset operating system']);
  }
  return { headers: [...SOFTWARE_HEADERS], rows };
}

function scopeContent(input: InventoryInput | undefined): string {
  if (!input) return INVENTORY_NOT_LOADED;
  if (input.assets.length === 0) return NO_ASSETS_RECORDED;
  const s = summarizeScope(input.assets);
  const parts = CMMC_ASSET_CATEGORIES.map((c) => `${CATEGORY_INFO[c].label}: ${s.byCategory[c]}`);
  let text = `${plural(s.total, 'asset is', 'assets are')} recorded in this program boundary (${parts.join('; ')}).`;
  if (s.unconfirmed > 0) text += ` ${plural(s.unconfirmed, 'asset is', 'assets are')} discovered but not yet confirmed.`;
  if (s.decommissioned > 0) text += ` ${plural(s.decommissioned, 'decommissioned asset is', 'decommissioned assets are')} listed with its discovery state.`;
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
  const table = hardware ? hardwareInventoryTable(assets) : softwareInventoryTable(input?.software ?? [], assets);
  const sections: ReportSection[] = [
    { id: 'inventory-scope', title: 'Scope', content: scopeContent(input) },
    { id: 'inventory-table', title: hardware ? 'Hardware Inventory' : 'Software Inventory', table: input ? table : { headers: table.headers, rows: [] } },
  ];
  const inventory: InventoryPackageSection = { kind };
  if (hardware) inventory.hardware = input ? hardwareEntries(assets) : [];
  else inventory.software = input ? softwareEntries(input.software, assets) : [];
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
