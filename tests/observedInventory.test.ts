import { compareRecordedObserved, parseObservedHosts, parseObservedSoftware, parseObservedSoftwareGroups, parseProgramObservedHosts, usableSerial } from '../src/data/telemetry/observedInventory';
import { usableSerial as serverUsableSerial } from '../server/vm/inventory';
import type { VmObservedHost } from '../src/types/vm';

/**
 * Pure checks for the client side of the host inventory (issue #229 phase 2): the defensive parsers and the comparison of what a
 * person recorded with what a scanner observed. Every value is made up.
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

const host = (o: Partial<VmObservedHost> = {}): VmObservedHost => ({
  sourceId: 'src-1',
  sourceKind: 'WAZUH',
  sourceLabel: 'Lab Wazuh',
  hostname: 'obs-1',
  ipAddress: '10.0.0.5',
  macAddress: 'AA:BB:CC:00:00:01',
  os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', platform: 'windows', kernel: '' },
  hardware: { architecture: 'x86_64', cpuName: 'Fake', cpuCores: 4, cpuMhz: 2000, memoryBytes: 1024, serialNumber: 'FAKE-1' },
  softwareReported: true,
  softwareCount: 3,
  collectedAt: '2026-11-10T10:00:00.000Z',
  firstSeenAt: '2026-11-10T10:00:00.000Z',
  lastSeenAt: '2026-11-10T10:00:00.000Z',
  ...o,
});
const asset = { ipAddress: '', macAddress: '', serialNumber: '', osProfile: 'custom' };
const row = (rows: ReturnType<typeof compareRecordedObserved>, field: string, sourceId = 'src-1') => rows.find((r) => r.field === field && r.sourceId === sourceId)!;

console.log('--- parsing ---');
assert(parseObservedHosts(null).length === 0 && parseObservedHosts('x').length === 0 && parseObservedHosts({}).length === 0 && parseObservedHosts({ observed: 5 }).length === 0, 'C-1 anything that is not a list of hosts parses to none');
const parsed = parseObservedHosts({ observed: [host(), { sourceId: '' }, 7, null, { sourceId: 's2', os: 'bad', hardware: 'bad', softwareCount: 'many', sourceKind: 'NOPE' }] });
assert(parsed.length === 2 && parsed[1].sourceId === 's2' && parsed[1].hardware === null && parsed[1].os.name === '' && parsed[1].softwareCount === 0 && parsed[1].sourceKind === 'WAZUH' && parsed[1].softwareReported === false, 'C-1 malformed entries are dropped and missing fields get safe defaults', parsed[1]);
assert(parseObservedHosts([host()]).length === 1 && parsed[0].hardware?.memoryBytes === 1024, 'C-1 a bare list parses too, numbers survive');
const sw = parseObservedSoftware({ totalCount: 9, items: [{ sourceId: 's', name: 'pkg', version: '1', installedAt: 'x' }, { name: '' }, 3] });
assert(sw.totalCount === 9 && sw.items.length === 1 && sw.items[0].vendor === '' && sw.items[0].installedAt === 'x', 'C-2 software: bad items are dropped, strings default to empty', sw);
assert(parseObservedSoftware(undefined).totalCount === 0 && parseObservedSoftware({ items: [{ name: 'a' }] }).totalCount === 1, 'C-2 an unusable body is empty; a missing total falls back to the item count');

console.log('\n--- program-wide parsing ---');
const progHosts = parseProgramObservedHosts({ hosts: [{ ...host(), assetId: 'a1' }, { ...host({ sourceId: 's2' }), assetId: 'a2' }, host(), { ...host(), assetId: '' }, { assetId: 'a3' }, { assetId: 'a4', sourceId: '' }, 7, null] });
assert(progHosts.length === 2 && progHosts[0].assetId === 'a1' && progHosts[1].sourceId === 's2' && progHosts[0].hardware?.serialNumber === 'FAKE-1', 'C-5 program hosts: well-formed rows kept, rows without an asset id or source id dropped', progHosts.length);
assert(parseProgramObservedHosts(null).length === 0 && parseProgramObservedHosts('x').length === 0 && parseProgramObservedHosts([host()]).length === 0 && parseProgramObservedHosts({ hosts: 5 }).length === 0, 'C-5 program hosts: a non-array or null body gives none');
let threw = false;
try {
  parseProgramObservedHosts({ hosts: [{ assetId: 7, sourceId: 's', os: 3, hardware: 'x', softwareCount: 'many' }, { assetId: 'a', sourceId: 's', ipAddress: 5, softwareReported: 'yes' }] });
} catch {
  threw = true;
}
assert(!threw, 'C-5 program hosts: wrong-typed fields do not throw');
const groups = parseObservedSoftwareGroups({ totalGroups: 7, truncated: true, items: [{ name: 'pkg', version: '1', vendor: 'v', assetCount: 2, assetIds: ['a1', 'a2', 5], sourceIds: ['s1'], firstSeenAt: 'f', lastSeenAt: 'l' }, { name: '' }, { version: '1' }, 3, null] });
assert(groups.totalGroups === 7 && groups.truncated && groups.items.length === 1 && groups.items[0].assetCount === 2 && groups.items[0].assetIds.join() === 'a1,a2' && groups.items[0].sourceIds.join() === 's1' && groups.items[0].lastSeenAt === 'l', 'C-6 software groups: well-formed group kept, nameless ones and wrong-typed ids dropped', groups);
const loose = parseObservedSoftwareGroups({ items: [{ name: 'a', assetIds: ['x', 'y'], assetCount: 'two', version: 4, truncated: 'yes' }], truncated: 'yes' });
assert(loose.totalGroups === 1 && !loose.truncated && loose.items[0].assetCount === 2 && loose.items[0].version === '', 'C-6 software groups: totals and counts fall back, wrong-typed fields default');
assert(parseObservedSoftwareGroups(null).items.length === 0 && parseObservedSoftwareGroups('x').totalGroups === 0 && parseObservedSoftwareGroups([]).items.length === 0 && parseObservedSoftwareGroups({ items: 'x' }).items.length === 0 && !parseObservedSoftwareGroups(undefined).truncated, 'C-6 software groups: a non-array or null body gives none');

console.log('\n--- comparison ---');
const blank = compareRecordedObserved(asset, [host()]);
assert(blank.length === 4 && blank.map((r) => r.field).join() === 'ipAddress,macAddress,serialNumber,os' && blank.every((r) => r.sourceId === 'src-1' && r.sourceLabel === 'Lab Wazuh'), 'C-3 one row per field per host, each carrying its source', blank);
assert(row(blank, 'ipAddress').differs && row(blank, 'ipAddress').usable && row(blank, 'ipAddress').recorded === '' && row(blank, 'ipAddress').observed === '10.0.0.5', 'C-3 a blank recorded value differs from an observed one and can be copied');
assert(row(blank, 'os').observed === 'Microsoft Windows 11 Pro 10.0.22631' && row(blank, 'os').usable && !row(blank, 'os').differs, 'C-3 a recorded custom profile is not a disagreement; the mapped profile can be used');
const same = compareRecordedObserved({ ipAddress: ' 10.0.0.5 ', macAddress: 'aa-bb-cc-00-00-01', serialNumber: 'fake-1', osProfile: 'win11' }, [host()]);
assert(same.every((r) => !r.differs), 'C-3 equal values (trimmed, MAC separators, case) do not differ', same.filter((r) => r.differs));
const other = compareRecordedObserved({ ipAddress: '10.9.9.9', macAddress: '11:22:33:44:55:66', serialNumber: 'MINE', osProfile: 'rhel9' }, [host()]);
assert(other.every((r) => r.differs && r.usable), 'C-3 different recorded values differ', other);
const unusable = compareRecordedObserved({ ...asset, serialNumber: 'MINE' }, [host({ ipAddress: '', macAddress: '00:00:00:00:00:00', hardware: { architecture: '', cpuName: '', cpuCores: null, cpuMhz: null, memoryBytes: null, serialNumber: 'To Be Filled By O.E.M.' }, os: { name: '', version: '', platform: '', kernel: '' } })]);
assert(unusable.every((r) => !r.usable && !r.differs), 'C-3 a blank value, an all-zero MAC and a placeholder serial are neither usable nor a difference', unusable);
const none = compareRecordedObserved(asset, [host({ hardware: null })]);
assert(!row(none, 'serialNumber').usable && row(none, 'serialNumber').observed === '', 'C-3 a host that reported no hardware has no serial to offer');
const two = compareRecordedObserved(asset, [host(), host({ sourceId: 'src-2', sourceLabel: 'Second', ipAddress: '10.0.0.6' })]);
assert(two.length === 8 && row(two, 'ipAddress', 'src-2').observed === '10.0.0.6' && row(two, 'ipAddress', 'src-1').observed === '10.0.0.5', 'C-3 two hosts give two rows per field, kept apart by source', two.length);
assert(compareRecordedObserved(asset, []).length === 0, 'C-3 no observed hosts, no rows');

console.log('\n--- usableSerial ---');
assert(usableSerial === serverUsableSerial && !usableSerial('N/A') && usableSerial('FAKE-1'), 'C-4 the server and the client share one usableSerial');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
