import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnclaveAsset } from '../src/types/telemetry';
import type { VmObservedHost, VmObservedSoftware } from '../src/types/vm';
import {
  OBSERVED_COPY,
  assetEditPatch,
  filterObservedSoftware,
  formatCpuSpeed,
  formatMemoryBytes,
  isHotfix,
  observedSoftwareCaption,
  reportedOsText,
  truncationNotice,
} from '../src/data/telemetry/observedInventoryView';
import { ObservedInventoryPanel } from '../src/components/telemetry/ObservedInventoryPanel';

/**
 * #229 phase 2 UI: the pure rules (what an edit sends, display text, the software filter) and the scanner-data panel's states and wiring.
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

const baseAsset: EnclaveAsset = {
  id: 'a1', tenantId: 't1', hostName: 'WS-01', ipAddress: '10.0.0.5', macAddress: '', osProfile: 'win11',
  cmmcAssetCategory: 'CUI_ASSET', status: 'ACTIVE', sourceOrigin: 'MANUAL_ENTRY', discoveryStatus: 'ACTIVE', lastScannedAt: null,
  complianceScore: null, notes: '', owner: '', manufacturer: '', model: '', serialNumber: '', location: '',
  fipsValidationStatus: null, fipsCertificateNumber: null, fipsModuleName: null, fipsStandard: null,
};
const { id: _id, ...baseForm } = baseAsset;
const form = (over: Partial<Omit<EnclaveAsset, 'id'>> = {}): Omit<EnclaveAsset, 'id'> => ({ ...baseForm, ...over });

console.log('--- assetEditPatch ---');
assert(Object.keys(assetEditPatch(baseAsset, form())).length === 0, 'P1 an unchanged form sends nothing');
assert(JSON.stringify(assetEditPatch(baseAsset, form({ hostName: 'WS-02' }))) === '{"hostName":"WS-02"}', 'P2 a changed name sends only the name');
assert(JSON.stringify(assetEditPatch(baseAsset, form({ ipAddress: '' }))) === '{"ipAddress":""}', 'P3 clearing the IP address sends an empty string');
assert(JSON.stringify(assetEditPatch({ ...baseAsset, owner: undefined }, form({ owner: '' }))) === '{}', 'P4 an absent value and an empty one are the same');
const reported = assetEditPatch({ ...baseAsset, osProfile: 'Ubuntu 24.04 LTS' }, form({ osProfile: 'custom' }));
assert(!('osProfile' in reported), 'P5 a reported OS the select shows as custom is not overwritten by custom');
assert(assetEditPatch(baseAsset, form({ osProfile: 'rhel9' })).osProfile === 'rhel9', 'P6 a real OS change is sent');
const cat = assetEditPatch(baseAsset, form({ cmmcAssetCategory: 'OUT_OF_SCOPE' }));
assert(cat.cmmcAssetCategory === 'OUT_OF_SCOPE' && ['fipsValidationStatus', 'fipsCertificateNumber', 'fipsModuleName', 'fipsStandard'].every((k) => k in cat && (cat as Record<string, unknown>)[k] === null), 'P7 a category change carries all four FIPS fields');
const fips = assetEditPatch(baseAsset, form({ fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '4211' }));
assert(fips.cmmcAssetCategory === 'CUI_ASSET' && fips.fipsCertificateNumber === '4211' && 'fipsStandard' in fips && 'fipsModuleName' in fips, 'P8 a FIPS change carries the category and all four FIPS fields');
const keys = Object.keys(assetEditPatch(baseAsset, form({ status: 'INACTIVE', sourceOrigin: 'CSV_IMPORT', discoveryStatus: 'STALE', lastScannedAt: 'x', complianceScore: 5, serialNumber: 'SN1' })));
assert(keys.join(',') === 'serialNumber', 'P9 status, origin, discovery, scan and score are never sent', keys);

console.log('--- reportedOsText ---');
const host = (over: Partial<VmObservedHost> = {}): VmObservedHost => ({
  sourceId: 's1', sourceKind: 'WAZUH', sourceLabel: 'Wazuh prod', hostname: 'ws-01', ipAddress: '10.0.0.9', macAddress: '52:54:00:00:00:01',
  os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', platform: 'windows', kernel: '' },
  hardware: { architecture: 'x86_64', cpuName: 'Intel Xeon', cpuCores: 8, cpuMhz: 2400, memoryBytes: 17179869184, serialNumber: 'SN-REAL-1' },
  softwareReported: true, softwareCount: 3, collectedAt: '2026-11-01T00:00:00Z', firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-11-01T00:00:00Z', ...over,
});
assert(reportedOsText('win11', [host()]) === null, 'R1 a known profile has nothing to explain');
assert(reportedOsText('Ubuntu 24.04 LTS', []) === 'Ubuntu 24.04 LTS', 'R2 the raw text of an unknown profile is shown');
assert(reportedOsText('custom', [host()]) === 'Microsoft Windows 11 Pro 10.0.22631', 'R3 a custom profile shows what the scanner reported');
assert(reportedOsText('custom', []) === null && reportedOsText(undefined, [host({ os: { name: '', version: '', platform: '', kernel: '' } })]) === null, 'R4 nothing known gives null');

console.log('--- memory and speed ---');
assert(formatMemoryBytes(17179869184) === '16 GiB', 'M1 16 GiB drops the decimal');
assert(formatMemoryBytes(1610612736) === '1.5 GiB', 'M2 one decimal is kept');
assert(formatMemoryBytes(512) === '512 B' && formatMemoryBytes(2048) === '2 KiB', 'M3 bytes and KiB');
assert(formatMemoryBytes(null) === 'Not reported' && formatMemoryBytes(0) === 'Not reported' && formatMemoryBytes(-5) === 'Not reported', 'M4 unknown or non-positive is not reported');
assert(formatMemoryBytes(1099511627776) === '1 TiB', 'M5 TiB');
assert(formatMemoryBytes(NaN) === 'Not reported', 'M6 NaN is not reported');
assert(formatCpuSpeed(2400) === '2.4 GHz' && formatCpuSpeed(3000) === '3 GHz', 'S1 GHz from 1000 MHz up, decimal dropped when zero');
assert(formatCpuSpeed(999) === '999 MHz' && formatCpuSpeed(1000) === '1 GHz', 'S2 the 1000 MHz boundary');
assert(formatCpuSpeed(null) === 'Not reported' && formatCpuSpeed(0) === 'Not reported', 'S3 unknown speed is not reported');
assert(formatCpuSpeed(2595.4) === '2.6 GHz', 'S4 rounding to one decimal');

console.log('--- software filter ---');
const sw = (name: string, over: Partial<VmObservedSoftware> = {}): VmObservedSoftware => ({
  sourceId: 's1', name, version: '1.0', vendor: 'Acme', architecture: 'x86_64', type: 'package', installedAt: null, firstSeenAt: '', lastSeenAt: '', ...over,
});
const items = [sw('OpenSSL', { version: '3.0.2', vendor: 'OpenSSL Project' }), sw('KB5034441', { type: 'hotfix', vendor: '' }), sw('curl', { vendor: 'Haxx' })];
assert(isHotfix(items[1]) && !isHotfix(items[0]), 'F1 isHotfix reads the type');
assert(filterObservedSoftware(items, '', 'all').length === 3 && filterObservedSoftware(items, '  ', 'all').length === 3, 'F2 a blank query keeps everything');
assert(filterObservedSoftware(items, 'haxx', 'all').map((i) => i.name).join() === 'curl' && filterObservedSoftware(items, '3.0.2', 'all').length === 1, 'F3 the query matches name, version and vendor case-insensitively');
assert(filterObservedSoftware(items, '', 'hotfixes').length === 1 && filterObservedSoftware(items, '', 'packages').length === 2 && filterObservedSoftware(items, 'kb', 'packages').length === 0, 'F4 the type filter splits hotfixes from packages');

console.log('--- caption and truncation ---');
assert(observedSoftwareCaption(3, 3) === 'Showing 3 items' && observedSoftwareCaption(1, 1) === 'Showing 1 item', 'C1 all shown');
assert(observedSoftwareCaption(2, 10) === 'Showing 2 of 10 items loaded', 'C2 a filter hides some');
assert(observedSoftwareCaption(0, 0) === 'No software loaded', 'C3 nothing loaded');
assert(truncationNotice(1000, 1000) === null && truncationNotice(5, 3) === null, 'T1 no notice when everything is loaded');
assert((truncationNotice(1000, 2500) ?? '').includes('1000 of 2500'), 'T2 the notice says how many of how many');

console.log('--- the panel ---');
const recorded = { ipAddress: '10.0.0.5', macAddress: '', osProfile: 'win2022', serialNumber: '' };
const render = (props: Partial<React.ComponentProps<typeof ObservedInventoryPanel>>): string =>
  renderToStaticMarkup(React.createElement(ObservedInventoryPanel, { status: 'ready', hosts: [host()], recorded, note: 'NOTE', onRetry: () => {}, ...props }));
assert(render({ status: 'loading', hosts: [] }).includes(OBSERVED_COPY.loading), 'RP1 loading');
const err = render({ status: 'error', hosts: [] });
assert(err.includes(OBSERVED_COPY.loadError) && err.includes('>Retry<'), 'RP2 error with Retry');
assert(render({ status: 'ready', hosts: [] }).includes(OBSERVED_COPY.empty) && render({ status: 'gone', hosts: [] }).includes(OBSERVED_COPY.gone), 'RP3 empty and gone');
const full = render({});
assert(full.includes('Wazuh prod') && full.includes('16 GiB') && full.includes('2.4 GHz') && full.includes('SN-REAL-1') && full.includes('3 items'), 'RP4 a host shows its details');
assert(full.includes('Differs from record') && full.includes('Blank in record') && !full.includes(OBSERVED_COPY.useValue), 'RP5 differences are badged, and without onUseValue there is no Use button');
const withUse = render({ onUseValue: () => {} });
assert((withUse.match(/Use scanner value:/g) ?? []).length === 4, 'RP6 with onUseValue every differing, usable row can be used', (withUse.match(/Use scanner value:/g) ?? []).length);
const custom = render({ recorded: { ...recorded, osProfile: 'custom', ipAddress: '10.0.0.9', macAddress: '52-54-00-00-00-01', serialNumber: 'sn-real-1' }, onUseValue: () => {} });
assert(!custom.includes('Differs from record') && !custom.includes(OBSERVED_COPY.useValue), 'RP7 a custom recorded OS and equal values never differ');
const noHw = render({ hosts: [host({ hardware: null })] });
assert(noHw.includes(OBSERVED_COPY.noHardware) && noHw.includes('Not reported'), 'RP8 a host without hardware says so');
const hostile = render({ hosts: [host({ sourceLabel: '<img src=x onerror=1>', hostname: '<b>x</b>' })] });
assert(!hostile.includes('<img') && !hostile.includes('<b>x') && hostile.includes('&lt;img'), 'RP9 scanner text is escaped');

console.log('--- source checks ---');
const files = {
  panel: read('src/components/telemetry/ObservedInventoryPanel.tsx'),
  list: read('src/components/telemetry/ObservedSoftwareList.tsx'),
  dialog: read('src/components/telemetry/AssetScannerDataDialog.tsx'),
  hook: read('src/hooks/useObservedInventory.ts'),
  view: read('src/data/telemetry/observedInventoryView.ts'),
  modal: read('src/components/telemetry/AddAssetModal.tsx'),
  manager: read('src/components/telemetry/AssetInventoryManager.tsx'),
};
const scannerSources = [files.panel, files.list, files.dialog, files.hook, files.view].join('\n');
assert(!/console\.|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML/.test(scannerSources), 'SV1 the scanner-data code logs nothing, stores nothing and renders no HTML');
assert(!/localStorage|sessionStorage|console\./.test(files.modal + files.manager), 'SV2 the form and the inventory store and log nothing');
assert(files.dialog.includes('<DialogOverlay') && files.dialog.includes('max-h-[90vh]') && files.dialog.includes('Scanner data: {asset.hostName}'), 'SV3 the dialog is a titled, capped DialogOverlay');
assert(files.hook.includes('seq.current !== mine') && files.hook.includes('status === 404') && !/err\.message|errorMessage/.test(files.hook), 'SV4 the hooks ignore stale answers, tell a 404 apart and never show server text');
assert(files.modal.includes('useObservedInventory(') && files.modal.indexOf('useObservedInventory(') < files.modal.indexOf('if (!isOpen) return null'), 'SV5 the modal calls the hook above its isOpen guard');
assert(files.modal.includes('initialAsset && serverBacked') && files.modal.includes('onUseValue={applyScannerValue}') && !files.modal.includes('IP address is required'), 'SV6 the panel is edit-mode and server-backed only, and the IP address is optional');
assert(files.manager.includes('assetEditPatch(editingAsset, assetData)') && files.manager.includes('<AssetScannerDataDialog') && files.manager.includes('serverBacked={serverBacked}') && files.manager.includes('setScannerAsset(null)'), 'SV7 the inventory sends a patch, opens the dialog and resets it on a tenant change');
assert(files.manager.split('colSpan={columnCount}').length - 1 === 2 && !files.manager.includes('asset.complianceScore'), 'SV8 the inventory table keeps its two full-width rows and shows no stored score');
assert(files.list.includes('OBSERVED_COPY.softwareNote') && files.panel.includes('onUseValue(row)'), 'SV9 the software list carries the not-the-approved-list note, and the Use button calls onUseValue');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
