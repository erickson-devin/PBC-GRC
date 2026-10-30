import './testEnv';
// The browser code resolves its API base and session token from the environment / localStorage at call time.
process.env.VITE_API_URL = 'http://127.0.0.1:8080';
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
(globalThis as any).window = { localStorage: (globalThis as any).localStorage };

import { installSessionCookieBridge } from './sessionCookieBridge';
installSessionCookieBridge();
import { server } from '../server/index';
import { compileNistSSP } from '../src/data/reports/documentCompilers';
import { getFrameworkControls } from '../src/data/frameworks';
const cmmcL1Controls = getFrameworkControls('CMMC_L1');
import { parseAssetsCsv, parseServerAssets, summarizeScope } from '../src/data/telemetry/assetScope';
import { discoveryEndpointUrl } from '../src/data/telemetry/assetRegistry';
import type { ReportMetadata } from '../src/types/report';

/**
 * Client side of CMMC asset scoping: the CSV parser, the response parser, the backend that talks to the real server API
 * (CRUD, roles, duplicates, discovery, scan results, change notifications), the browser-local backend used by the demo
 * sandbox and not-yet-migrated tenants, and the SSP boundary summary that is built from the asset counts.
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

const BASE = 'http://127.0.0.1:8080/api/v1';
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64')}.mock_pbc_signature`;
const person = (sub: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { tenant_unrelated: 'VIEWER' } });
const signIn = (token: string) => localStorage.setItem('pbc_session_ref_v3', token);
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => ({ status: e.status, message: e.message }));

function pureTests() {
  console.log('--- CSV parser ---');
  const csv = [
    'hostName,ipAddress,osProfile,cmmcAssetCategory,macAddress,notes,owner',
    'WS-FIN-01,10.0.50.41,win11,CUI_ASSET,00:50:56:A1:01,Finance workstation,Finance',
    'FW-1,10.0.50.1,cisco_ios,Security Protection,,Edge firewall,NetOps',
    'CNC-1,10.0.60.9,custom,SPECIALIZED_ASSET,,Machine tool,Plant',
    'QA-LAB,10.0.70.3,ubuntu2204,CRMA,,,',
    'GUEST,10.0.99.1,custom,out of scope,,,',
    'MYSTERY,10.0.1.1,rhel9,banana,,,',
    ',10.0.1.2,rhel9,CUI_ASSET,,,',
  ].join('\n');
  const r = parseAssetsCsv(csv);
  assert(r.assets.length === 5, 'five valid rows are parsed', r.assets.map((a) => a.hostName));
  const by = (n: string) => r.assets.find((a) => a.hostName === n)!;
  assert(by('WS-FIN-01').cmmcAssetCategory === 'CUI_ASSET' && by('WS-FIN-01').owner === 'Finance' && by('WS-FIN-01').osProfile === 'win11', 'category, owner and OS are read');
  assert(by('FW-1').cmmcAssetCategory === 'SECURITY_PROTECTION' && by('QA-LAB').cmmcAssetCategory === 'CONTRACTOR_RISK' && by('GUEST').cmmcAssetCategory === 'OUT_OF_SCOPE', 'category words and abbreviations are understood');
  assert(by('CNC-1').cmmcAssetCategory === 'SPECIALIZED_ASSET', 'SPECIALIZED_ASSET imports');
  assert(r.assets.every((a) => a.sourceOrigin === 'CSV_IMPORT'), 'rows are marked as CSV imports');
  assert(r.errors.length === 2 && /MYSTERY.*"banana"/.test(r.errors[0]) && /no host name/.test(r.errors[1]), 'an unknown category and a missing name are reported per row, not guessed', r.errors);
  const reordered = parseAssetsCsv('cmmcAssetCategory,notes,hostName\nCUI_ASSET,n,H-1');
  assert(reordered.assets[0]?.hostName === 'H-1' && reordered.assets[0].cmmcAssetCategory === 'CUI_ASSET', 'columns are found by name, in any order');
  const noCat = parseAssetsCsv('hostName,ipAddress\nA,1.1.1.1');
  assert(noCat.assets.length === 0 && /no cmmcAssetCategory column/.test(noCat.errors[0]), 'a CSV without a category column imports nothing (never silently CUI)');
  assert(parseAssetsCsv('hostName').assets.length === 0 && parseAssetsCsv('').errors.length === 1, 'an empty CSV is an error');

  console.log('\n--- Discovery endpoint URL ---');
  assert(discoveryEndpointUrl('http://grc.local:3000', 't1') === 'http://grc.local:3000/api/v1/tenants/t1/assets/discovery', 'the URL is built from the install origin');
  assert(discoveryEndpointUrl('https://10.0.0.5/', 'a b') === 'https://10.0.0.5/api/v1/tenants/a%20b/assets/discovery', 'a trailing slash is dropped and the tenant id is encoded');
  assert(discoveryEndpointUrl('', 't1') === '/api/v1/tenants/t1/assets/discovery', 'an empty origin gives a relative path');
  assert(!/pitchblackcyber/i.test(discoveryEndpointUrl('http://grc.local', 't1') + discoveryEndpointUrl('', 't1')), 'the URL never names the vendor domain');

  console.log('\n--- Server response parser ---');
  const parsed = parseServerAssets([
    { id: 'a1', tenantId: 't', hostName: 'ok', cmmcAssetCategory: 'SPECIALIZED_ASSET', owner: 'x', notes: 'd' },
    { id: 'a2', hostName: 'bad-category', cmmcAssetCategory: 'NOPE' },
    { hostName: 'no-id', cmmcAssetCategory: 'CUI_ASSET' },
    null,
    'x',
  ]);
  assert(parsed.length === 1 && parsed[0].owner === 'x' && parsed[0].status === 'NEVER_SCANNED' && parsed[0].discoveryStatus === 'ACTIVE', 'valid assets are parsed with defaults; unusable entries are dropped');
  assert(parseServerAssets(undefined).length === 0 && parseServerAssets({}).length === 0, 'non-list payloads parse to empty');
}

const meta: ReportMetadata = {
  systemName: 'Sys', organizationName: 'Org', cageCode: '1ABC2', samStatus: 'ACTIVE', systemOwner: 'Owner', primaryAssessor: 'A',
  boundaryDescription: 'Custom boundary text.', systemEnvironment: 'Cloud', operationalStatus: 'Operational',
  cloudServiceProviders: 'GCP', classificationLevel: 'UNCLASSIFIED // CUI', assessmentDate: '2026-01-01', version: '1.0.0', framework: 'CMMC_L1',
};

function sspTests() {
  console.log('\n--- SSP boundary summary ---');
  const scope = summarizeScope([
    ...Array.from({ length: 3 }, () => ({ cmmcAssetCategory: 'CUI_ASSET' as const, discoveryStatus: 'ACTIVE' as const })),
    ...Array.from({ length: 2 }, () => ({ cmmcAssetCategory: 'SECURITY_PROTECTION' as const, discoveryStatus: 'ACTIVE' as const })),
    { cmmcAssetCategory: 'SPECIALIZED_ASSET' as const, discoveryStatus: 'ACTIVE' as const },
    { cmmcAssetCategory: 'OUT_OF_SCOPE' as const, discoveryStatus: 'ACTIVE' as const },
    { cmmcAssetCategory: 'CONTRACTOR_RISK' as const, discoveryStatus: 'UNCONFIRMED_DISCOVERY' as const },
  ]);
  const doc = compileNistSSP({ ...meta, assetScope: scope }, cmmcL1Controls, {}, []);
  const section = doc.sections.find((s) => s.id === 'sec-1-system-identification')!;
  const sub = section.subsections?.find((s) => s.title.startsWith('1.2.1'));
  assert(Boolean(sub), 'the SSP has a "CMMC Asset Scoping Summary" subsection under the boundary');
  const item = (label: string) => sub?.items?.find((i) => i.label === label)?.value;
  assert(item('CUI Asset') === '3' && item('Security Protection Asset (SPA)') === '2' && item('Specialized Asset (SA)') === '1' && item('Contractor Risk Managed Asset (CRMA)') === '0', 'CUI and SPA (and SA / CRMA) counts are stated with their full names', sub?.items);
  assert(item('Total In-Scope Assets') === '6' && item('Awaiting Classification') === '1' && item('Out-of-Scope Asset') === '1', 'in-scope total, unclassified and out-of-scope counts');
  assert(/6 in-scope assets: 3 CUI Assets, 2 Security Protection Assets \(SPA\)/.test(sub?.content ?? ''), 'the narrative repeats the counts', sub?.content);
  assert(section.subsections?.some((s) => s.content === 'Custom boundary text.'), "the organisation's own boundary description is still there");
  const titles = section.subsections?.map((s) => s.title) ?? [];
  assert(titles.indexOf(sub!.title) === titles.findIndex((t) => t.startsWith('1.2 ')) + 1, 'it sits directly after the boundary description (1.2)');
  const without = compileNistSSP(meta, cmmcL1Controls, {}, []);
  assert(!without.sections.find((s) => s.id === 'sec-1-system-identification')?.subsections?.some((s) => s.title.startsWith('1.2.1')), 'with no inventory loaded the SSP states no counts (never a wrong zero)');
}

async function backendTests() {
  await new Promise((r) => setTimeout(r, 500));
  const { assetBackendMode, getAssetBackend, subscribeAssets } = await import('../src/services/assetService');
  const { isDemoSeedAsset } = await import('../src/data/telemetry/assetRegistry');

  console.log('\n--- Backend selection ---');
  assert(assetBackendMode({ serverBacked: true }) === 'server', 'a server-backed tenant uses the API');
  assert(assetBackendMode({ serverBacked: false }) === 'local-legacy' && assetBackendMode({}) === 'local-legacy', 'a browser-only tenant stays local until moved');
  assert(isDemoSeedAsset({ id: 'asset-cui-01-tenant-x' }, 'tenant-x') && !isDemoSeedAsset({ id: 'abc' }, 'tenant-x') && !isDemoSeedAsset({ id: 'asset-cui-01-tenant-x' }, 'tenant-y'), 'the sample fleet an older version seeded is still recognised (so migration does not carry it over)');

  console.log('\n--- Server backend (real API) ---');
  const ownerToken = person('u_asv_owner');
  signIn(ownerToken);
  const created = await (await fetch(`${BASE}/tenants`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AssetSvc Org' }) })).json() as { tenant: { id: string } };
  const tenantId = created.tenant.id;
  const be = getAssetBackend(tenantId, 'server');
  let notified = 0;
  const unsubscribe = subscribeAssets((t) => { if (t === tenantId) notified++; });

  assert((await be.list()).length === 0, 'a live tenant starts with an empty inventory (no demo fleet)');
  const db = await be.create({ hostName: 'DB-1', ipAddress: '10.0.0.5', osProfile: 'rhel9', cmmcAssetCategory: 'CUI_ASSET', owner: 'Data', notes: 'Primary DB' });
  assert(db.cmmcAssetCategory === 'CUI_ASSET' && db.owner === 'Data' && db.tenantId === tenantId && db.id.length > 10, 'create goes to the server, which assigns id and tenant');
  const dup = await rejection(be.create({ hostName: 'db-1', cmmcAssetCategory: 'CUI_ASSET' }));
  assert(dup?.status === 409 && /already exists/.test(dup.message), 'a duplicate name surfaces the server message (409)', dup);
  const upd = await be.update(db.id, { cmmcAssetCategory: 'SPECIALIZED_ASSET', owner: 'OT' });
  assert(upd.cmmcAssetCategory === 'SPECIALIZED_ASSET' && upd.owner === 'OT' && upd.notes === 'Primary DB', 'update changes only what was sent');
  const swept = await be.ingest([{ agentId: 's1', hostName: 'ROGUE', ipAddress: '10.0.9.9', macAddress: '00:11:22:33:44:55', osFingerprint: 'Linux', discoveredPorts: [22], connectionType: 'ETHERNET' }]);
  assert(swept.newDiscoveredCount === 1 && swept.items.length === 2 && /^[0-9a-f]{64}$/.test(swept.auditHash), 'discovery ingestion returns counts, the full list and an audit digest');
  const rogue = swept.items.find((a) => a.hostName === 'ROGUE')!;
  assert(rogue.discoveryStatus === 'UNCONFIRMED_DISCOVERY' && summarizeScope(swept.items).unconfirmed === 1, 'a discovered device is unconfirmed and not counted in a category');
  const serverLedger = localStorage.getItem(`pbc_audit_ledger_${tenantId}`) ?? '';
  assert(serverLedger.includes('TELEMETRY_INGESTED') && !serverLedger.includes('ROGUE') && !serverLedger.includes('10.0.9.9') && !serverLedger.includes('00:11:22:33:44:55'), 'the browser audit ledger records the discovery without the host name, IP or MAC');
  const classified = await be.classify(rogue.id, 'CONTRACTOR_RISK');
  assert(classified.cmmcAssetCategory === 'CONTRACTOR_RISK' && classified.discoveryStatus === 'ACTIVE', 'classify assigns the category and confirms it');
  const sim1 = await be.simulateDiscovery();
  const sim2 = await be.simulateDiscovery();
  assert(sim1.newDiscoveredCount === 3 && sim2.newDiscoveredCount === 0 && sim2.updatedExistingCount === 3, 'the simulated sweep is deduplicated on the second run');

  const csv = await be.importCsv('hostName,cmmcAssetCategory,notes\nCSV-1,SPECIALIZED_ASSET,x\nCSV-2,banana,x\nDB-1,CUI_ASSET,dup');
  assert(csv.imported === 1 && csv.skipped.length === 2 && csv.skipped.some((s) => /banana/.test(s)) && csv.skipped.some((s) => /DB-1/.test(s)), 'CSV import reports unknown categories and duplicates, and imports the rest', csv);

  await be.recordScan('DB-1', '10.0.0.5', 87);
  const scanned = (await be.list()).find((a) => a.id === db.id)!;
  assert(scanned.complianceScore === 87 && scanned.status === 'NON_COMPLIANT' && Boolean(scanned.lastScannedAt), 'a scan result is stored on the matching asset');
  const snapshot = JSON.stringify(await be.list());
  await be.recordScan('NO-SUCH-HOST', '1.2.3.4', 100);
  assert(JSON.stringify(await be.list()) === snapshot, 'a scan of an unregistered host changes nothing');

  const before = notified;
  await be.remove((await be.list()).find((a) => a.hostName === 'CSV-1')!.id);
  assert(notified > before && (await be.list()).every((a) => a.hostName !== 'CSV-1'), 'removing an asset works and notifies subscribers (so every view refreshes)');
  assert(notified >= 6, 'every change notified the shared subscription', notified);

  console.log('\n--- Roles through the backend ---');
  const viewer = jwt({ sub: 'u_asv_viewer', email: 'v@test.mil', name: 'v', roles: { [tenantId]: 'VIEWER' } });
  signIn(viewer);
  assert((await be.list()).length > 0, 'a VIEWER can read');
  const denied = await rejection(be.create({ hostName: 'NOPE', cmmcAssetCategory: 'CUI_ASSET' }));
  assert(denied?.status === 403, 'a VIEWER cannot create (403 shown to the user)', denied);
  assert((await rejection(be.remove(db.id)))?.status === 403, 'a VIEWER cannot delete');
  assert((await rejection(be.classify(db.id, 'OUT_OF_SCOPE')))?.status === 403, 'a VIEWER cannot reclassify');
  await be.recordScan('DB-1', '10.0.0.5', 100).catch(() => undefined);
  assert((await be.list()).find((a) => a.id === db.id)?.complianceScore === 87, 'and a read-only scan result is not stored');
  localStorage.removeItem('pbc_session_ref_v3');
  assert((await rejection(be.list()))?.status === 401, 'without a session the backend says "sign in" (401)');
  unsubscribe();

  console.log('\n--- Local backend (browser-only tenants) ---');
  const legacy = getAssetBackend('tenant-legacy-1', 'local-legacy');
  assert((await legacy.list()).length === 0, 'a browser-only tenant starts empty (no fake fleet)');
  const l1 = await legacy.create({ hostName: 'LOCAL-1', cmmcAssetCategory: 'CUI_ASSET', ipAddress: '10.1.1.1' });
  assert((await legacy.list()).length === 1 && !(await legacy.list()).some((a) => isDemoSeedAsset(a, 'tenant-legacy-1')), 'adding the first asset does not seed a sample fleet either');
  assert((await rejection(legacy.create({ hostName: 'local-1', cmmcAssetCategory: 'CUI_ASSET' })))?.status === 409, 'duplicates are refused locally too');
  assert((await legacy.update(l1.id, { cmmcAssetCategory: 'SPECIALIZED_ASSET' })).cmmcAssetCategory === 'SPECIALIZED_ASSET', 'local update');
  const lcsv = await legacy.importCsv('hostName,cmmcAssetCategory\nL-2,CUI_ASSET\nL-3,wrong');
  assert(lcsv.imported === 1 && lcsv.skipped.length === 1, 'local CSV import skips unrecognised categories too');
  const ing = await legacy.ingest([{ agentId: 'a', ipAddress: '10.1.1.77', macAddress: 'AA:BB:CC:DD:EE:01', osFingerprint: '', discoveredPorts: [], connectionType: 'ETHERNET' }]);
  assert(ing.newDiscoveredCount === 1, 'local discovery ingestion works');
  const legacyLedger = localStorage.getItem('pbc_audit_ledger_tenant-legacy-1') ?? '';
  assert(legacyLedger.includes('TELEMETRY_INGESTED') && !legacyLedger.includes('10.1.1.77') && !legacyLedger.includes('AA:BB:CC:DD:EE:01') && !legacyLedger.includes('accretion-ee01'), 'the legacy tenant ledger holds no IP, MAC or default host name');
  await legacy.remove(l1.id);
  assert((await legacy.list()).every((a) => a.id !== l1.id), 'local remove');
  assert((await getAssetBackend('tenant-other', 'local-legacy').list()).length === 0, "another tenant's local inventory is separate");
}

async function run() {
  pureTests();
  sspTests();
  await backendTests();

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exitCode = passed === total ? 0 : 1;
  server.closeAllConnections();
  server.close();
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
