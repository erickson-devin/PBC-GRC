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
  generateInventoryCsv,
  isInventoryDocumentType,
} from '../src/data/reports/inventoryDocuments';
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
  assert(hwRow('NEW-DEV')[10] === 'Unconfirmed' && hwRow('WS-02')[10] === 'Confirmed', 'H6b discovery column');
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

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}
main().catch(() => { console.error('test run failed'); process.exit(1); });
