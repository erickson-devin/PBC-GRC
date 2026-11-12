import './testEnv';
import { validateIngestPayload, INGEST_LIMITS, VM_INGEST_FEATURES } from '../server/vm/ingestSchema';
import type { IngestPayload } from '../server/vm/ingestSchema';
import { normalizeInventory, planBlankFills, usableSerial } from '../server/vm/inventory';
import { __resetVmInventoryForTests, getObservedHosts, listObservedSoftware, replaceHostInventory } from '../server/vm/inventoryStore';
import { isKnownOsProfile, osProfileFor, osProfileSelectValue, OS_PROFILE_KEYS } from '../src/data/telemetry/osProfile';

/**
 * Pure checks (no server, in-memory store) for the host inventory (issue #229 phase 2): the validator's new fields, the strict
 * operating system mapping, the inventory adapter, the serial and blank-fill rules, and the store's snapshot semantics.
 * Every value here is made up.
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

type Json = Record<string, any>;
const payload = (hosts: Json[]): Json => ({
  schema_version: 1,
  source: { kind: 'WAZUH', label: 'inv-lab' },
  exporter: { name: 'pbc-wazuh-exporter', version: '1.0.0' },
  collected_at: '2026-11-10T12:00:00Z',
  hosts,
});
const errorOf = (raw: unknown): string => {
  const v = validateIngestPayload(raw);
  return v.ok ? '' : v.error;
};
const sw = (n: number, prefix = 'pkg'): Json[] => Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i}`, version: '1.0' }));

async function main() {
  // ---------------------------------------------------------------------------------------------- validator
  console.log('--- validator ---');
  const full = payload([
    {
      agent_id: '001',
      hostname: 'inv-host-1',
      os: { name: 'Example Linux', version: '9.4', platform: 'rhel', kernel: '5.14.0-fake' },
      hardware: { architecture: 'x86_64', cpu_name: 'Fake CPU', cpu_cores: 8, cpu_mhz: 2400, memory_bytes: 17179869184, serial_number: 'FAKE-SERIAL-1' },
      software: [{ name: 'fakepkg', version: '1.2.3', vendor: 'Fake Vendor', architecture: 'x86_64', type: 'rpm', installed_at: '2026-01-02T03:04:05Z' }],
    },
  ]);
  assert(validateIngestPayload(full).ok, 'I1 a host with only hardware, software and OS details (no findings key) is accepted', errorOf(full));
  assert(validateIngestPayload(payload([{ agent_id: '001', software: [] }])).ok, 'I1b an empty software list alone is a valid report');
  assert(errorOf(payload([{ agent_id: '001' }])) === '$.hosts[0].findings: required (a host reports findings, configuration results, inventory or a combination)', 'I2 a host with nothing is refused with the new message');
  assert(errorOf(payload([{ agent_id: '001', hardware: { cpu_cores: 1.5 } }])).startsWith('$.hosts[0].hardware.cpu_cores'), 'I3 a fractional cpu_cores is refused', errorOf(payload([{ agent_id: '001', hardware: { cpu_cores: 1.5 } }])));
  assert(!validateIngestPayload(payload([{ agent_id: '001', hardware: { cpu_cores: INGEST_LIMITS.cpuCoresMax + 1 } }])).ok && !validateIngestPayload(payload([{ agent_id: '001', hardware: { memory_bytes: -1 } }])).ok, 'I4 out-of-range hardware numbers are refused');
  assert(!validateIngestPayload(payload([{ agent_id: '001', hardware: { cpu_name: 'x', extra: 1 } }])).ok && !validateIngestPayload(payload([{ agent_id: '001', software: [{ name: 'a', extra: 1 }] }])).ok, 'I5 unknown keys inside hardware and software items are refused');
  assert(!validateIngestPayload(payload([{ agent_id: '001', software: [{ name: '' }] }])).ok && !validateIngestPayload(payload([{ agent_id: '001', software: [{ name: 'a'.repeat(256) }] }])).ok, 'I6 an empty or over-long package name is refused');
  assert(validateIngestPayload(payload([{ agent_id: '001', software: sw(INGEST_LIMITS.maxSoftwarePerHost) }])).ok && !validateIngestPayload(payload([{ agent_id: '001', software: sw(INGEST_LIMITS.maxSoftwarePerHost + 1) }])).ok, 'I7 10000 software items per host are accepted, 10001 are refused');
  const manyHosts = (n: number) => Array.from({ length: n }, (_, i) => ({ agent_id: `h${i}`, software: sw(10000, `p${i}`) }));
  assert(validateIngestPayload(payload(manyHosts(20))).ok, 'I8 200000 software items in total are accepted');
  assert(errorOf(payload(manyHosts(21))) === '$.hosts: at most 200000 software items in total', 'I8 200001 are refused with the exact message', errorOf(payload(manyHosts(21))));
  assert(!validateIngestPayload(payload([{ agent_id: '001', software: [{ name: 'a', installed_at: 'yesterday' }] }])).ok, 'I8b a software install time must be a date-time');
  assert(JSON.stringify(VM_INGEST_FEATURES) === '["whoami","inventory"]', 'whoami advertises the inventory feature');

  // ---------------------------------------------------------------------------------------------- operating system mapping
  console.log('\n--- operating system mapping ---');
  assert(osProfileFor('Microsoft Windows 11 Pro', '10.0.22631') === 'win11', 'O1 Windows 11 -> win11');
  assert(osProfileFor('Microsoft Windows Server 2022 Standard', '10.0.20348') === 'win2022', 'O2 Windows Server 2022 -> win2022');
  assert(osProfileFor('Red Hat Enterprise Linux', '9.4') === 'rhel9' && osProfileFor('Red Hat Enterprise Linux Server', '8.10') === 'rhel8', 'O3 Red Hat 9 and 8 -> rhel9 and rhel8');
  assert(osProfileFor('Red Hat Enterprise Linux', '7.9') === 'custom' && osProfileFor('Red Hat Enterprise Linux', '') === 'custom', 'O4 Red Hat 7 or an unknown version -> custom');
  assert(osProfileFor('Ubuntu', '22.04.4 LTS') === 'ubuntu2204' && osProfileFor('Ubuntu', '24.04') === 'custom', 'O5 Ubuntu 22.04 -> ubuntu2204, 24.04 -> custom');
  assert(osProfileFor('Cisco IOS XE', '17.3') === 'cisco_ios', 'O6 Cisco IOS -> cisco_ios');
  assert(osProfileFor('Microsoft Windows 10 Pro', '10.0.19045') === 'custom' && osProfileFor('', '') === 'custom' && osProfileFor('Windows 111', '1') === 'custom', 'O7 Windows 10, nothing and look-alikes -> custom');
  assert(osProfileSelectValue('win11') === 'win11' && osProfileSelectValue('Microsoft Windows 11 Pro') === 'custom' && osProfileSelectValue(null) === 'custom' && osProfileSelectValue('custom') === 'custom', 'O8 the form select shows a known key, else custom');
  assert(OS_PROFILE_KEYS.every((k) => isKnownOsProfile(k)) && !isKnownOsProfile('custom') && !isKnownOsProfile(undefined), 'O8b isKnownOsProfile knows exactly the form keys');

  // ---------------------------------------------------------------------------------------------- adapter
  console.log('\n--- adapter ---');
  const parsed = validateIngestPayload(
    payload([
      { agent_id: 'a1', hostname: 'one', ip: '10.0.0.5', mac: 'AA:BB:CC:00:00:01', os: { name: 'Example', version: '1', platform: 'p', kernel: 'k' }, hardware: { serial_number: 'S1', cpu_cores: 2 }, software: [{ name: 'p', version: '1' }, { name: 'p', version: '1', vendor: 'dup' }, { name: 'p', version: '2' }, { name: 'q', installed_at: '2026-01-02T03:04:05+01:00' }] },
      { agent_id: 'a2', findings: [{ vuln_id: 'CVE-2024-0001', severity: 'HIGH' }] },
      { agent_id: 'a3', software: [] },
    ]),
  );
  assert(parsed.ok, 'N0 the adapter fixture validates', errorOf(parsed));
  const inv = normalizeInventory((parsed as { ok: true; value: IngestPayload }).value);
  assert(inv.size === 2 && inv.has('a1') && inv.has('a3') && !inv.has('a2'), 'N1 only hosts with hardware or software appear; absent = no entry', [...inv.keys()]);
  const a1 = inv.get('a1')!;
  assert(a1.software!.length === 3 && a1.software![0].vendor === '' && a1.software![2].installedAt === '2026-01-02T02:04:05.000Z', 'N2 software repeats keep the first; times are UTC ISO; absent strings are empty', a1.software);
  assert(a1.ip === '10.0.0.5' && a1.os.kernel === 'k' && a1.hardware?.serialNumber === 'S1' && a1.hardware?.cpuMhz === null && inv.get('a3')!.hardware === null && inv.get('a3')!.software!.length === 0, 'N2 hardware absent = null, an empty software list is kept as a list', a1);

  // ---------------------------------------------------------------------------------------------- serials and blank fills
  console.log('\n--- serial numbers and blank fills ---');
  const bad = ['', '   ', '0', '0000000', 'To Be Filled By O.E.M.', ' default string ', 'SYSTEM SERIAL NUMBER', 'None', 'N/A', 'Not Specified', 'Chassis Serial Number'];
  assert(bad.every((v) => !usableSerial(v)) && !usableSerial(undefined) && !usableSerial(null), 'U1 blank, all-zero and firmware placeholder serials are not usable', bad.filter((v) => usableSerial(v)));
  assert(usableSerial('FAKE-SERIAL-1') && usableSerial('0A1B2C') && usableSerial('Notebook 1'), 'U1b a real serial is usable');

  const observed = a1;
  const agentAsset = { sourceOrigin: 'AGENT_REPORT', ipAddress: '', macAddress: '', serialNumber: '', osProfile: 'custom' };
  const fills = planBlankFills(agentAsset, observed);
  assert(fills.ipAddress === '10.0.0.5' && fills.macAddress === 'AA:BB:CC:00:00:01' && fills.serialNumber === 'S1' && fills.osProfile === undefined, 'F1 a scanner-created asset with blank fields gets ip, mac and serial', fills);
  assert(Object.keys(planBlankFills({ ...agentAsset, sourceOrigin: 'MANUAL_ENTRY' }, observed)).length === 0 && Object.keys(planBlankFills({ ...agentAsset, sourceOrigin: 'CSV_IMPORT' }, observed)).length === 0, 'F1b a human-created asset gets no fill');
  const filled = planBlankFills({ ...agentAsset, ipAddress: '10.9.9.9', macAddress: 'AA:AA:AA:AA:AA:AA', serialNumber: 'MINE' }, observed);
  assert(Object.keys(filled).length === 0, 'F1c a field with a value is never overwritten', filled);
  const placeholder = planBlankFills(agentAsset, { ...observed, hardware: { ...observed.hardware!, serialNumber: 'To Be Filled By O.E.M.' }, mac: '00:00:00:00:00:00' });
  assert(placeholder.serialNumber === undefined && placeholder.macAddress === undefined, 'F1d a placeholder serial and an all-zero MAC are not used', placeholder);
  const repair = planBlankFills({ ...agentAsset, osProfile: 'Microsoft Windows 11 Pro' }, { ...observed, os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', platform: 'windows', kernel: '' } });
  assert(repair.osProfile === 'win11', 'F1e a raw OS name stored as the profile is repaired to the key', repair);
  const keep = planBlankFills({ ...agentAsset, osProfile: 'rhel9' }, { ...observed, os: { name: 'rhel9', version: '', platform: '', kernel: '' } });
  const custom = planBlankFills({ ...agentAsset, osProfile: 'custom' }, { ...observed, os: { name: 'Microsoft Windows 11 Pro', version: '10', platform: '', kernel: '' } });
  assert(keep.osProfile === undefined && custom.osProfile === undefined, 'F1f a known key or a chosen custom is never repaired', [keep, custom]);

  // ---------------------------------------------------------------------------------------------- store
  console.log('\n--- store (memory) ---');
  __resetVmInventoryForTests();
  const T = 't-inv';
  const run = (id: string) => ({ id, sourceId: 'src-1' });
  const draft = (assetId: string, o: Json = {}) => ({
    assetId,
    agentId: 'ag-' + assetId,
    hostname: 'host-' + assetId,
    inv: { ip: '10.0.0.1', mac: '', os: { name: 'Example', version: '1', platform: '', kernel: '' }, hardware: null, software: null, ...o },
  });
  const pkg = (name: string, version = '1', extra: Json = {}) => ({ name, version, vendor: '', architecture: 'x86_64', type: '', installedAt: null, ...extra });
  const hw = { architecture: 'x86_64', cpuName: 'Fake', cpuCores: 4, cpuMhz: 2000, memoryBytes: 8589934592, serialNumber: 'S9' };

  const stored1 = await replaceHostInventory(T, run('r1'), '2026-11-10T10:00:00Z', [draft('a1', { hardware: hw, software: [pkg('a'), pkg('b'), pkg('c')] })], null);
  const h1 = (await getObservedHosts(T, 'a1'))[0];
  assert(stored1 === 3 && h1.softwareCount === 3 && h1.softwareReported && h1.hardware?.memoryBytes === 8589934592 && h1.firstSeenAt === '2026-11-10T10:00:00.000Z', 'S1 the first report stores the host and its packages', h1);

  await replaceHostInventory(T, run('r2'), '2026-11-11T10:00:00Z', [draft('a1', { software: [pkg('b'), pkg('d')] })], null);
  const h2 = (await getObservedHosts(T, 'a1'))[0];
  const list2 = await listObservedSoftware(T, 'a1', { limit: 100 });
  assert(h2.hardware?.serialNumber === 'S9' && h2.softwareCount === 2 && h2.firstSeenAt === '2026-11-10T10:00:00.000Z' && h2.lastSeenAt === '2026-11-11T10:00:00.000Z', 'S2 a later report without hardware keeps the hardware, replaces the packages and moves last seen', h2);
  assert(list2.items.map((i) => i.name).join() === 'b,d' && list2.items[0].firstSeenAt === '2026-11-10T10:00:00.000Z' && list2.items[1].firstSeenAt === '2026-11-11T10:00:00.000Z', 'S3 packages no longer installed are gone; the survivor keeps its first-seen time', list2.items);

  await replaceHostInventory(T, run('r3'), '2026-11-11T11:00:00Z', [draft('a1', { hardware: hw })], null);
  assert((await listObservedSoftware(T, 'a1', { limit: 100 })).totalCount === 2 && (await getObservedHosts(T, 'a1'))[0].softwareCount === 2, 'S4 a report with no software list leaves the package list alone');

  await replaceHostInventory(T, run('r0'), '2026-11-09T00:00:00Z', [draft('a1', { software: [pkg('old')] })], null);
  assert((await listObservedSoftware(T, 'a1', { limit: 100 })).items.map((i) => i.name).join() === 'b,d', 'S5 a report older than the stored view is ignored');

  await replaceHostInventory(T, run('r4'), '2026-11-12T00:00:00Z', [draft('a1', { software: [] })], null);
  assert((await listObservedSoftware(T, 'a1', { limit: 100 })).totalCount === 0 && (await getObservedHosts(T, 'a1'))[0].softwareReported, 'S6 an empty list empties the packages');

  await replaceHostInventory(T, { id: 'r5', sourceId: 'src-2' }, '2026-11-12T01:00:00Z', [draft('a1', { software: [pkg('z')] }), draft('a2', { software: [pkg('Y'), pkg('x')] })], null);
  assert((await getObservedHosts(T, 'a1')).length === 2 && (await getObservedHosts('other-tenant', 'a1')).length === 0, 'S7 each source keeps its own view; another tenant sees nothing');
  const all = await listObservedSoftware(T, 'a2', { limit: 1 });
  assert(all.totalCount === 2 && all.items.length === 1 && all.items[0].name === 'x', 'S8 software is by name with a limit and the pre-limit total', all);
  assert((await listObservedSoftware(T, 'a1', { sourceId: 'src-2', limit: 10 })).items.map((i) => i.name).join() === 'z', 'S9 the source filter narrows the list');
  __resetVmInventoryForTests();
  assert((await getObservedHosts(T, 'a1')).length === 0, '__resetVmInventoryForTests empties the store');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
