import fs from 'fs';
import path from 'path';
import { HARDWARE_LIMITS, hardwareSummary, hardwareMatches } from '../src/data/telemetry/hardwareDetails';
import { parseAssetsCsv, parseServerAssets } from '../src/data/telemetry/assetScope';

/**
 * #229 phase 1b: the hand-recorded hardware fields on the client (display line, search, CSV and response parsing, form wiring).
 * Pure test: no server, no browser.
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

console.log('--- hardwareSummary ---');
assert(hardwareSummary({}) === null, 'HW1 nothing recorded gives null');
assert(hardwareSummary({ manufacturer: ' Dell ', model: 'R650' }) === 'Dell R650', 'HW2 manufacturer and model are trimmed and joined');
assert(hardwareSummary({ serialNumber: '7XK' }) === 'S/N 7XK', 'HW3 a serial number alone is prefixed with S/N');
assert(hardwareSummary({ manufacturer: 'Dell', model: 'R650', serialNumber: '7XK', location: 'Rack 4' }) === 'Dell R650 · S/N 7XK · Rack 4', 'HW4 all four fields make one line');
assert(hardwareSummary({ manufacturer: '  ', model: ' ', serialNumber: '\t', location: '  ' }) === null, 'HW5 whitespace-only fields give null');

console.log('--- hardwareMatches ---');
assert(hardwareMatches({ serialNumber: 'ABC123' }, 'c12') === true, 'HW6 a case-insensitive substring of a field matches');
assert(hardwareMatches({}, 'x') === false, 'HW7 no fields never match');
assert(hardwareMatches({ model: 'R650' }, '  ') === false, 'HW8 a blank query matches nothing');

console.log('--- limits and wiring ---');
assert(JSON.stringify(HARDWARE_LIMITS) === JSON.stringify({ manufacturer: 255, model: 255, serialNumber: 128, location: 255 }), 'HW9 the limits match the server');
const manager = read('src/components/telemetry/AssetInventoryManager.tsx');
const saveStart = manager.indexOf('const handleSaveAsset');
const updateCall = manager.slice(manager.indexOf('backend.update(', saveStart), manager.indexOf('backend.update(', saveStart) + 400);
assert(manager.includes('hardwareSummary(asset)') && updateCall.includes('serialNumber, location'), 'HW10 the row shows the summary and an edit keeps the hardware fields');
assert(read('src/components/telemetry/AddAssetModal.tsx').includes('serialNumber: serialNumber.trim()'), 'HW10b the form sends the trimmed serial number');

console.log('--- CSV and server parsing ---');
const csvRow = parseAssetsCsv('hostName,cmmcAssetCategory,manufacturer,model,serialNumber,location\nH1,CUI_ASSET,Acme,M1,SN-1,Rack 4').assets[0];
assert(csvRow.manufacturer === 'Acme' && csvRow.model === 'M1' && csvRow.serialNumber === 'SN-1' && csvRow.location === 'Rack 4', 'HW11 CSV hardware columns are parsed', csvRow);
const alias = parseAssetsCsv('hostName,cmmcAssetCategory,serial,site\nH1,CUI_ASSET,SN-2,HQ').assets[0];
assert(alias.serialNumber === 'SN-2' && alias.location === 'HQ', 'HW12 "serial" and "site" headers map to serialNumber and location', alias);
assert(!('manufacturer' in parseAssetsCsv('hostName,cmmcAssetCategory\nH1,CUI_ASSET').assets[0]), 'HW13 a CSV without hardware columns carries no hardware keys');
const srv = parseServerAssets([{ id: 'a', hostName: 'h', cmmcAssetCategory: 'CUI_ASSET', serialNumber: 'SN-1' }])[0];
assert(srv.serialNumber === 'SN-1' && srv.location === '', 'HW14 the response parser reads hardware fields and defaults the rest to empty', srv);

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
