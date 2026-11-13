import fs from 'fs';
import path from 'path';
import { compileReportDocument } from '../src/data/reports/documentCompilers';
import { generatePrintableHtml, generateMachineReadablePackage } from '../src/data/reports/reportExporters';
import { getExportGaps } from '../src/data/reports/exportReadiness';
import { getFrameworkControls } from '../src/data/frameworks';
import { NOT_RECORDED } from '../src/data/reports/documentDefaults';
import {
  OS_PROFILE_LABELS,
  NO_ASSETS_RECORDED,
  INVENTORY_NOT_LOADED,
  OBSERVED_NOT_LOADED,
  generateInventoryCsv,
  isInventoryDocumentType,
} from '../src/data/reports/inventoryDocuments';
import type { InventoryInput } from '../src/data/reports/inventoryDocuments';
import type { VmObservedHostWithAsset, VmObservedSoftwareGroup } from '../src/types/vm';
import type { ReportMetadata, ReportTableRow } from '../src/types/report';
import type { AssessmentState } from '../src/types/cmmc';
import type { EnclaveAsset } from '../src/types/telemetry';
import type { SoftwareItem } from '../src/types/software';

/**
 * Hardware and Software Inventory documents (issue #229, phase 1a): compilation from the asset inventory, CSV,
 * the optional package section, readiness and printable output. Pure test: no server, no browser.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const metadata: ReportMetadata = {
  systemName: 'Test System',
  organizationName: 'Test Org',
  cageCode: '',
  samStatus: '',
  systemOwner: 'Owner',
  primaryAssessor: '',
  boundaryDescription: '',
  systemEnvironment: '',
  operationalStatus: 'Operational',
  cloudServiceProviders: '',
  classificationLevel: 'UNCLASSIFIED // CUI',
  assessmentDate: '2026-11-06',
  version: '1.0.0',
  framework: 'CMMC_L2',
};

const baseAsset = {
  tenantId: 't1',
  ipAddress: '10.0.0.1',
  macAddress: 'aa:bb:cc:dd:ee:01',
  status: 'ACTIVE',
  sourceOrigin: 'MANUAL_ENTRY',
  discoveryStatus: 'CONFIRMED',
  lastScannedAt: null,
  complianceScore: null,
  notes: '',
  isManuallyAdded: true,
} as const;
const A1: EnclaveAsset = { ...baseAsset, id: 'a1', hostName: 'WS-02', cmmcAssetCategory: 'CUI_ASSET', manufacturer: 'Acme', model: 'X1', serialNumber: 'SN-0001', location: 'Bldg "A"', osProfile: 'win11' };
const A2: EnclaveAsset = { ...baseAsset, id: 'a2', hostName: 'FW-01', cmmcAssetCategory: 'SECURITY_PROTECTION', osProfile: 'cisco_ios' };
const A3: EnclaveAsset = { ...baseAsset, id: 'a3', hostName: 'NEW-DEV', cmmcAssetCategory: 'CONTRACTOR_RISK', discoveryStatus: 'UNCONFIRMED_DISCOVERY', osProfile: 'custom' };
const assets = [A1, A2, A3];

const sw = (over: Partial<SoftwareItem>): SoftwareItem => ({
  id: 's', tenantId: 't1', name: '', version: '', vendor: '', approved: null, assetId: null, notes: '', createdAt: '', updatedAt: '', ...over,
});
const S1 = sw({ id: 's1', name: 'Office Suite', version: '2024', approved: true, assetId: null });
const S2 = sw({ id: 's2', name: '=cmd|calc', approved: null, assetId: A1.id });
const S3 = sw({ id: 's3', name: 'Tool', approved: false, assetId: 'gone' });
const software = [S1, S2, S3];

const controls = getFrameworkControls('CMMC_L2');
const cellsOf = (rows: unknown): (string | number)[][] => (rows as (string | number)[][] | ReportTableRow[]).map((r) => (Array.isArray(r) ? r : r.cells));

async function main() {
  const hw = compileReportDocument('HARDWARE_INVENTORY', metadata, controls, {}, [], { assets, software });
  const swDoc = compileReportDocument('SOFTWARE_INVENTORY', metadata, controls, {}, [], { assets, software });
  const hwTable = hw.sections[1].table!;
  const swTable = swDoc.sections[1].table!;
  const hwRows = cellsOf(hwTable.rows);
  const swRows = cellsOf(swTable.rows);
  const hwRow = (host: string) => hwRows.find((r) => r[0] === host)!;

  console.log('--- Hardware Inventory ---');
  assert(hw.documentType === 'HARDWARE_INVENTORY' && hwRows.length === assets.length, 'H1 type and one row per asset', hwRows.length);
  assert(JSON.stringify(hwRows.map((r) => r[0])) === JSON.stringify(['FW-01', 'NEW-DEV', 'WS-02']), 'H2 rows are sorted by host name');
  assert(['Acme', 'X1', 'SN-0001', 'Bldg "A"'].every((v) => hwRow('WS-02').includes(v)), 'H3 recorded hardware fields are printed');
  assert([2, 3, 4, 5].every((i) => hwRow('FW-01')[i] === NOT_RECORDED), 'H4 empty hardware fields print NOT_RECORDED');
  assert(hwRow('FW-01')[7] === OS_PROFILE_LABELS.cisco_ios && hwRow('NEW-DEV')[7] === NOT_RECORDED, 'H5 OS label, custom profile not recorded');
  assert(!hwTable.headers.some((h) => /status/i.test(h)) && !swTable.headers.some((h) => /status/i.test(h)), 'H6 no header contains "status"');
  assert(hwRow('NEW-DEV')[13] === 'Unconfirmed' && hwRow('WS-02')[13] === 'Confirmed', 'H6b discovery column');
  const none = compileReportDocument('HARDWARE_INVENTORY', metadata, controls, {});
  assert(cellsOf(none.sections[1].table!.rows).length === 0 && (none.sections[0].content ?? '').includes(INVENTORY_NOT_LOADED), 'H7 no inventory: no rows and the document says so');
  const empty = compileReportDocument('HARDWARE_INVENTORY', metadata, controls, {}, [], { assets: [], software: [] });
  assert((empty.sections[0].content ?? '').includes(NO_ASSETS_RECORDED), 'H8 empty inventory states that none is recorded');
  assert(hw.inventory?.kind === 'HARDWARE_INVENTORY' && hw.inventory.hardware?.length === assets.length && hw.inventory.hardware.some((h) => h.serialNumber === 'SN-0001'), 'H9 the structured section carries the rows');

  console.log('--- Software Inventory ---');
  const distinctOs = new Set(assets.map((a) => a.osProfile)).size;
  assert(swRows.length === software.length + distinctOs, 'SW1 manual rows plus one row per distinct OS profile', swRows.length);
  const swRow = (name: string) => swRows.find((r) => r[0] === name)!;
  assert(swRow('Office Suite')[3] === 'Approved' && swRow('Tool')[3] === 'Not approved' && swRow('=cmd|calc')[3] === NOT_RECORDED, 'SW2 approval cells');
  assert(swRow('Office Suite')[4] === 'Tenant-wide' && swRow('=cmd|calc')[4] === 'WS-02' && swRow('Tool')[4] === NOT_RECORDED, 'SW3 installed-on cells');
  const osRows = swRows.filter((r) => r[5] === 'Asset operating system');
  assert(osRows.length === distinctOs && osRows.every((r) => r[3] === NOT_RECORDED), 'SW4 OS rows: source and approval not recorded');
  assert(swRows.some((r) => r[0] === 'Windows 11' && r[4] === '1 asset: WS-02'), 'SW5 OS row names its hosts');

  console.log('--- CSV ---');
  const hwCsv = generateInventoryCsv(hw);
  const hwLines = hwCsv.split('\r\n').filter((l) => l.length > 0);
  assert(hwLines.length === assets.length + 1 && hwLines[0] === hwTable.headers.map((h) => `"${h}"`).join(','), 'C1 header plus one line per asset', hwLines.length);
  const swCsv = generateInventoryCsv(swDoc);
  assert(swCsv.includes(`"'=cmd|calc"`) && !swCsv.includes(',"=cmd'), 'C2 a formula-like cell is neutralised');
  assert(hwCsv.includes('"Bldg ""A"""'), 'C3 quotes are doubled');

  console.log('--- Scanner-reported data (issue #279) ---');
  const host = (assetId: string, o: Partial<VmObservedHostWithAsset>): VmObservedHostWithAsset => ({
    assetId, sourceId: 'src-1', sourceKind: 'WAZUH', sourceLabel: 'wazuh-lab', hostname: '', ipAddress: '', macAddress: '',
    os: { name: '', version: '', platform: '', kernel: '' }, hardware: null, softwareReported: true, softwareCount: 0,
    collectedAt: '2026-11-10T12:00:00.000Z', firstSeenAt: '2026-11-01T12:00:00.000Z', lastSeenAt: '2026-11-10T12:00:00.000Z', ...o,
  });
  const group = (name: string, version: string, vendor: string, assetIds: string[]): VmObservedSoftwareGroup => ({
    name, version, vendor, assetCount: assetIds.length, assetIds, sourceIds: ['src-1'], firstSeenAt: '2026-11-01T12:00:00.000Z', lastSeenAt: '2026-11-10T12:00:00.000Z',
  });
  const hostA1 = host('a1', {
    ipAddress: '10.0.0.9',
    os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', platform: 'windows', kernel: '' },
    hardware: { architecture: 'x86_64', cpuName: 'Fake CPU', cpuCores: 8, cpuMhz: 2400, memoryBytes: 17179869184, serialNumber: 'SN-0001' },
  });
  const hostA1Old = host('a1', { lastSeenAt: '2026-10-01T12:00:00.000Z', ipAddress: '10.9.9.9', sourceLabel: 'old-source' });
  const hostA3 = host('a3', {
    os: { name: 'Debian GNU/Linux', version: '12', platform: 'linux', kernel: '' },
    hardware: { architecture: '', cpuName: '+cpu', cpuCores: null, cpuMhz: null, memoryBytes: null, serialNumber: '=SERIAL' },
  });
  const G1 = group('Office Suite', '2024', '', ['a1']);
  const G2 = group('=HYPERLINK("x")', '-1', '@vendor', ['a1', 'a3']);
  const G3 = group('office suite', '2023', '', ['a1']);
  const observed: InventoryInput['observed'] = { status: 'ready', hosts: [hostA1Old, hostA1, hostA3], software: [G1, G2, G3], totalGroups: 3, truncated: false };
  const hwN = compileReportDocument('HARDWARE_INVENTORY', metadata, controls, {}, [], { assets, software, observed });
  const swN = compileReportDocument('SOFTWARE_INVENTORY', metadata, controls, {}, [], { assets, software, observed });
  const hwNRows = cellsOf(hwN.sections[1].table!.rows);
  const swNRows = cellsOf(swN.sections[1].table!.rows);
  const hwNRow = (h: string) => hwNRows.find((r) => r[0] === h)!;
  assert(JSON.stringify(hwN.sections[1].table!.headers) === JSON.stringify(['Asset', 'CMMC category', 'Manufacturer', 'Model', 'Serial number', 'Location', 'Owner', 'Operating system', 'OS version', 'CPU', 'Memory', 'IP address', 'MAC address', 'Discovery', 'Scanner last reported']), 'HN1 the hardware header list');
  const ws = hwNRow('WS-02');
  assert(ws[7] === 'Windows 11' && ws[8] === '10.0.22631' && ws[9] === 'Fake CPU (8 cores)' && ws[10] === '16.0 GiB' && ws[11] === '10.0.0.1 (scanner reports: 10.0.0.9)' && ws[14] === '2026-11-10 (wazuh-lab)', 'HN2 a recorded value stays, the scanner value is shown beside it with its source', ws);
  assert(ws[4] === 'SN-0001' && ws[12] === 'aa:bb:cc:dd:ee:01', 'HN2b an equal serial and an unreported MAC print the recorded value alone', ws);
  const nd = hwNRow('NEW-DEV');
  assert(nd[7] === 'Debian GNU/Linux (scanner)' && nd[4] === '=SERIAL (scanner)', 'HN3 a blank recorded value is filled from the scanner and marked', nd);
  const fw = hwNRow('FW-01');
  assert(fw[9] === NOT_RECORDED && fw[10] === NOT_RECORDED && fw[14] === 'Not reported by a scanner', 'HN4 an asset no scanner reports has no CPU, memory or date', fw);
  const hwEntry = hwN.inventory?.hardware?.find((h) => h.hostName === 'WS-02');
  assert(hwEntry?.ipAddress === '10.0.0.1' && hwEntry.observed?.ipAddress === '10.0.0.9' && hwEntry.observed.sourceLabel === 'wazuh-lab' && hwEntry.cpu === 'Fake CPU (8 cores)', 'HN5 the JSON entry keeps the recorded and the observed value; the newest report wins', hwEntry);
  assert(hwN.inventory?.hardware?.find((h) => h.hostName === 'FW-01')?.observed === null, 'HN5b an asset without a scanner report has observed: null');

  const officeRows = swNRows.filter((r) => r[0] === 'Office Suite');
  assert(officeRows.length === 1 && officeRows[0][3] === 'Approved' && officeRows[0][5] === 'Manual entry; scanner: wazuh-lab' && officeRows[0][6] === '2026-11-10' && officeRows[0][4] === '1 asset: WS-02', 'SWN1 the manual entry and the scanner group with the same key are one row', officeRows);
  const old23 = swNRows.find((r) => r[0] === 'office suite' && r[1] === '2023')!;
  assert(old23?.[3] === NOT_RECORDED && old23[5] === 'Scanner: wazuh-lab', 'SWN2 another version is a scanner-only row, not reviewed', old23);
  const hyper = swNRows.find((r) => r[0] === '=HYPERLINK("x")')!;
  assert(hyper?.[4] === '2 assets: NEW-DEV, WS-02', 'SWN3 a group on two assets names both hosts', hyper);
  const expectedOs = new Set(['Microsoft Windows 11 Pro 10.0.22631', OS_PROFILE_LABELS.cisco_ios, 'Debian GNU/Linux 12']);
  const unmerged = [G1, G2, G3].filter((g) => !software.some((s) => s.name.trim().toLowerCase() === g.name.trim().toLowerCase() && s.version.trim() === g.version.trim() && s.vendor.trim().toLowerCase() === g.vendor.trim().toLowerCase())).length;
  assert(swNRows.length === software.length + unmerged + expectedOs.size, 'SWN4 manual rows, scanner-only rows and one row per distinct operating system', swNRows.length);
  const osNRows = swNRows.filter((r) => r[5] === 'Asset operating system');
  assert(swNRows.slice(-osNRows.length).every((r) => r[5] === 'Asset operating system') && osNRows.some((r) => r[0] === 'Microsoft Windows 11 Pro' && r[1] === '10.0.22631' && r[6] === '2026-11-10') && osNRows.some((r) => r[0] === 'Cisco IOS' && r[6] === 'Not reported by a scanner'), 'SWN5 operating system rows stay last and carry the scanner version', osNRows);
  const sortedNames = swNRows.slice(0, swNRows.length - osNRows.length).map((r) => r[0].toLowerCase());
  assert(JSON.stringify(sortedNames) === JSON.stringify([...sortedNames].sort((a, b) => a.localeCompare(b))), 'SWN6 manual and scanner rows are sorted by name', sortedNames);
  const withoutObserved = compileReportDocument('SOFTWARE_INVENTORY', metadata, controls, {}, [], { assets, software, observed: { status: 'unsupported', hosts: [], software: [], totalGroups: 0, truncated: false } });
  assert(JSON.stringify(cellsOf(withoutObserved.sections[1].table!.rows)) === JSON.stringify(swRows) && withoutObserved.sections[0].content === swDoc.sections[0].content, 'SWN7 unsupported scanner data changes nothing');
  const manualEntry = software.length > 0 ? swN.inventory?.software?.find((e) => e.id === 's1') : undefined;
  assert(manualEntry?.source === 'MANUAL_AND_SCANNER' && manualEntry.assetCount === 1 && manualEntry.sourceLabels?.join() === 'wazuh-lab' && manualEntry.approved === true, 'SWN8 the JSON entry of a merged row keeps the manual approval and gains the scanner facts', manualEntry);

  const hwNCsv = generateInventoryCsv(hwN);
  const swNCsv = generateInventoryCsv(swN);
  assert(swNCsv.includes(`"'=HYPERLINK(""x"")"`) && swNCsv.includes(`"'-1"`) && swNCsv.includes(`"'@vendor"`), 'C4 formula-like scanner values in the software CSV are neutralised', swNCsv);
  assert(hwNCsv.includes(`"'=SERIAL (scanner)"`) && hwNCsv.includes(`"'+cpu"`), 'C4b formula-like scanner values in the hardware CSV are neutralised', hwNCsv);
  assert([...hwNRows, ...swNRows].every((r) => r.every((c) => typeof c === 'string')), 'C5 every cell of both tables is a string');

  const errDoc = compileReportDocument('SOFTWARE_INVENTORY', metadata, controls, {}, [], { assets, software, observed: { status: 'error', hosts: [], software: [], totalGroups: 0, truncated: false } });
  assert((errDoc.sections[0].content ?? '').includes(OBSERVED_NOT_LOADED) && JSON.stringify(cellsOf(errDoc.sections[1].table!.rows)) === JSON.stringify(swRows), 'O1 a failed scanner read says so and leaves the rows as without it');
  assert(!(swDoc.sections[0].content ?? '').includes(OBSERVED_NOT_LOADED), 'O1b no sentence when no scanner data was asked for');
  const cut = compileReportDocument('SOFTWARE_INVENTORY', metadata, controls, {}, [], { assets, software, observed: { ...observed, truncated: true, totalGroups: 25000 } });
  assert((cut.sections[0].content ?? '').includes('first 3') && (cut.sections[0].content ?? '').includes('25000'), 'O2 a truncated list says how many of how many', cut.sections[0].content);
  assert((swN.sections[0].content ?? '').includes('3 scanner-reported packages are listed: 1 approved, 0 not approved, 2 not reviewed.'), 'O3 the scope counts scanner-reported packages by approval state', swN.sections[0].content);

  console.log('--- JSON package ---');
  const state: AssessmentState = {
    version: '2.0.0',
    tenantId: 'tenant-1',
    sspMetadata: {
      systemName: 'Test System', organizationName: 'Test Org', cageCode: '', systemOwner: 'Owner', authorName: '',
      assessmentDate: '2026-11-06', systemBoundaryScope: '', systemEnvironment: '', cloudServiceProviders: '', version: '1.0.0',
    },
    controls: {},
    evidenceIndex: [],
    lastSaved: '2026-11-06T12:00:00Z',
  } as AssessmentState;
  const sspPkg = await generateMachineReadablePackage(compileReportDocument('NIST_SP_800_18_SSP', metadata, controls, {}), state);
  assert(JSON.stringify(Object.keys(sspPkg).sort()) === JSON.stringify(['controls', 'evidenceIndex', 'exportTimestamp', 'framework', 'integrityChecksum', 'metadata', 'metrics', 'packageId', 'poamEntries', 'schemaVersion', 'tenantId']), 'J1 an SSP package gains no inventory key', Object.keys(sspPkg).sort());
  const hwPkg = await generateMachineReadablePackage(hw, state);
  assert(hwPkg.inventory?.hardware?.length === assets.length && hwPkg.integrityChecksum.length === 64, 'J2 the hardware package carries the inventory and a checksum');
  const swSources = new Set((swN.inventory?.software ?? []).map((e) => e.source));
  assert(['SCANNER', 'MANUAL_AND_SCANNER', 'ASSET_OS', 'MANUAL'].every((s) => swSources.has(s as 'SCANNER')), 'J3 the software package covers scanner, merged, operating system and manual entries', [...swSources]);

  console.log('--- Readiness, types, print ---');
  assert(JSON.stringify(getExportGaps('HARDWARE_INVENTORY', {}).map((g) => g.field)) === JSON.stringify(['systemName', 'organizationName', 'systemOwner']), 'R1 readiness fields');
  assert(isInventoryDocumentType('POAM') === false && isInventoryDocumentType('SOFTWARE_INVENTORY') === true, 'R2 isInventoryDocumentType');
  const sspHtml = generatePrintableHtml(compileReportDocument('NIST_SP_800_18_SSP', metadata, controls, {}));
  assert(!generatePrintableHtml(hw).includes('Assessment Compliance Readiness Posture') && sspHtml.includes('Assessment Compliance Readiness Posture'), 'P1 only inventory documents omit the posture box');

  console.log('--- Source pins ---');
  const modal = read('src/components/reports/ArtifactExportModal.tsx');
  const inv = read('src/data/reports/inventoryDocuments.ts');
  assert(modal.includes("id: 'HARDWARE_INVENTORY'") && modal.includes("id: 'SOFTWARE_INVENTORY'"), 'T1 the Export Center offers both documents');
  assert(!modal.includes('console.') && !inv.includes('console.') && !modal.includes('localStorage') && !inv.includes('localStorage'), 'T1b no console or browser storage');
  const progHook = read('src/hooks/useProgramObservedInventory.ts');
  assert(!/console\.|localStorage|sessionStorage/.test(progHook), 'T1c the scanner hook has no console or browser storage');
  assert(progHook.includes('seq.current !== mine'), 'T1c the scanner hook ignores a stale answer');
  const compileCall = modal.slice(modal.indexOf('compileReportDocument('), modal.indexOf('}, [selectedDocType, formData'));

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}
main().catch(() => { console.error('test run failed'); process.exit(1); });
