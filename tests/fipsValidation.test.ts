import './testEnv';
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

import { server } from '../server/index';
import { TABLES_SQL } from '../server/schema';
import {
  applyFipsModules,
  collectFipsModules,
  describeFipsModule,
  describeFipsModules,
  isCryptographicProtectionControl,
  normalizeCertificateNumber,
  normalizeFips,
  FipsModuleRef,
} from '../src/data/telemetry/fipsValidation';
import { getCascadedObjectiveNarrative } from '../src/data/frameworks/policyCompiler';
import { generatePolicyDocument } from '../src/data/reports/policyDocumentGenerator';
import { compileNistSSP } from '../src/data/reports/documentCompilers';
import { getFrameworkControls } from '../src/data/frameworks';
import type { EnclaveStackProfile, Tenant } from '../src/types/tenant';
import type { ReportMetadata } from '../src/types/report';

/**
 * Cryptographic module (FIPS 140-2 / 140-3, CMVP) tracking: the schema, the validation rules, retention of the data
 * through the API (create, read, edit, reclassify, tenant isolation, roles), and its injection into the generated policy
 * text and the SSP for requirement 3.13.11.
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
const withRole = (sub: string, tenant: string, role: string) => jwt({ sub, email: `${sub}@test.mil`, name: sub, roles: { [tenant]: role } });
type Json = Record<string, any>;
async function call(method: string, p: string, token: string | null, tenant?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
}

const falcon: FipsModuleRef = { assetName: 'EDR-GATEWAY', moduleName: 'CrowdStrike Falcon', certificateNumber: '4211', standard: '140-2' };
const openssl: FipsModuleRef = { assetName: 'FW-EDGE', moduleName: 'OpenSSL FIPS Provider', certificateNumber: '4802', standard: '140-3' };
const stack: EnclaveStackProfile = { identityProvider: 'ENTRA_ID_COMMERCIAL', edrSolution: 'DEFENDER_FOR_ENDPOINT', infrastructure: 'AZURE_GOV', mdmSolution: 'INTUNE', siemSolution: 'SENTINEL', odpParams: {} };

function schemaTests() {
  console.log('--- Schema ---');
  const start = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS enclave_assets');
  const block = TABLES_SQL.slice(start, TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_users'));
  for (const col of ['fips_validation_status VARCHAR(16)', 'fips_certificate_number VARCHAR(16)', 'fips_module_name VARCHAR(255)', 'fips_standard VARCHAR(8)']) {
    assert(block.includes(`${col},`) || block.includes(`${col};`), `new optional column: ${col}`);
    assert(!new RegExp(`${col.split(' ')[0]} [A-Z0-9()]+ NOT NULL`).test(block), `${col.split(' ')[0]} is nullable`);
    assert(block.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `${col.split(' ')[0]} is added to existing databases too`);
  }
  assert(/enclave_assets_fips_status_check CHECK \(fips_validation_status IS NULL OR fips_validation_status IN \('VALIDATED', 'PENDING', 'NOT_APPLICABLE'\)\)/.test(block), 'the status is limited to VALIDATED / PENDING / NOT_APPLICABLE');
  assert(/enclave_assets_fips_standard_check CHECK \(fips_standard IS NULL OR fips_standard IN \('140-2', '140-3'\)\)/.test(block), 'the FIPS revision is limited to 140-2 / 140-3');
  assert(/enclave_assets_fips_cert_check CHECK \(fips_certificate_number IS NULL OR fips_certificate_number ~ '\^\[0-9\]\{1,6\}\$'\)/.test(block), 'the certificate number is 1-6 digits in the database too');
  assert(block.includes('DROP CONSTRAINT IF EXISTS enclave_assets_fips_status_check'), 'the constraints are re-created idempotently');
}

function ruleTests() {
  console.log('\n--- Validation rules ---');
  assert(normalizeCertificateNumber('4211') === '4211' && normalizeCertificateNumber('#4211') === '4211' && normalizeCertificateNumber(' Cert #4211 ') === '4211' && normalizeCertificateNumber(4211) === '4211', 'certificate numbers are normalised ("#4211", "Cert #4211")');
  assert(normalizeCertificateNumber('0042') === '42', 'leading zeros are dropped');
  assert(normalizeCertificateNumber('abc') === null && normalizeCertificateNumber('42a') === null && normalizeCertificateNumber('1234567') === null && normalizeCertificateNumber('') === null && normalizeCertificateNumber('-5') === null, 'anything else is not a certificate number');

  const ok = (cat: any, f: any) => normalizeFips(cat, f);
  const v = ok('SECURITY_PROTECTION', { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '#4211', fipsModuleName: '  CrowdStrike Falcon ', fipsStandard: '140-2' });
  assert(v.ok && v.fields.fipsCertificateNumber === '4211' && v.fields.fipsModuleName === 'CrowdStrike Falcon' && v.fields.fipsStandard === '140-2', 'a validated module is stored in canonical form');
  assert(ok('CUI_ASSET', { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '1' }).ok, 'CUI assets can carry FIPS details too');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'VALIDATED' }).ok, 'VALIDATED without a certificate number is refused (no claim without its evidence)');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: 'abc' }).ok, 'a malformed certificate number is refused');
  assert(!ok('SECURITY_PROTECTION', { fipsCertificateNumber: '4211' }).ok, 'a certificate number without a status is refused');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'NOT_APPLICABLE', fipsModuleName: 'x' }).ok, 'NOT_APPLICABLE carries no module');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'PENDING', fipsCertificateNumber: '4211' }).ok, 'PENDING has no certificate yet');
  const pending = ok('SECURITY_PROTECTION', { fipsValidationStatus: 'PENDING', fipsModuleName: 'Vendor module', fipsStandard: '140-3' });
  assert(pending.ok && pending.fields.fipsCertificateNumber === null && pending.fields.fipsModuleName === 'Vendor module', 'a pending module keeps its name but has no certificate');
  const na = ok('SECURITY_PROTECTION', { fipsValidationStatus: 'NOT_APPLICABLE', fipsStandard: '140-2' });
  assert(na.ok && na.fields.fipsStandard === null, 'NOT_APPLICABLE drops the revision');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'BOGUS' as any }).ok && !ok('SECURITY_PROTECTION', { fipsValidationStatus: 'PENDING', fipsStandard: '140-4' as any }).ok, 'unknown status / revision are refused');
  assert(!ok('SECURITY_PROTECTION', { fipsValidationStatus: 'PENDING', fipsModuleName: 'bad\u0000name' }).ok, 'control characters in the module name are refused');
  for (const cat of ['OUT_OF_SCOPE', 'CONTRACTOR_RISK', 'SPECIALIZED_ASSET']) {
    const cleared = ok(cat, { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '4211' });
    assert(cleared.ok && cleared.fields.fipsValidationStatus === null && cleared.fields.fipsCertificateNumber === null, `${cat}: FIPS details are cleared (the category cannot carry them)`);
  }

  console.log('\n--- Module selection and wording ---');
  const inventory = [
    { hostName: 'B', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '4802', fipsModuleName: 'OpenSSL FIPS Provider', fipsStandard: '140-3' as const },
    { hostName: 'A', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '4211', fipsModuleName: 'CrowdStrike Falcon', fipsStandard: '140-2' as const },
    { hostName: 'A2', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '4211', fipsModuleName: 'CrowdStrike Falcon', fipsStandard: '140-2' as const },
    { hostName: 'PEND', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, fipsValidationStatus: 'PENDING' as const, fipsCertificateNumber: null },
    { hostName: 'NOCERT', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, fipsValidationStatus: null },
    { hostName: 'CUI-DB', cmmcAssetCategory: 'CUI_ASSET' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '9999' },
    { hostName: 'ROGUE', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, discoveryStatus: 'UNCONFIRMED_DISCOVERY' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '1111' },
    { hostName: 'OLD', cmmcAssetCategory: 'SECURITY_PROTECTION' as const, discoveryStatus: 'DECOMMISSIONED' as const, fipsValidationStatus: 'VALIDATED' as const, fipsCertificateNumber: '2222' },
  ];
  const mods = collectFipsModules(inventory);
  assert(mods.length === 2 && mods[0].certificateNumber === '4211' && mods[1].certificateNumber === '4802', 'only validated Security Protection Assets with a certificate are cited, sorted, one per certificate', mods);
  assert(!mods.some((m) => ['9999', '1111', '2222'].includes(m.certificateNumber)), 'CUI assets, unclassified and decommissioned assets are not cited');
  assert(collectFipsModules(inventory, ['SECURITY_PROTECTION', 'CUI_ASSET']).length === 3, 'the category set is a parameter (CUI assets can be included)');
  assert(describeFipsModule(falcon) === 'FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)', 'the citation reads "FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)"', describeFipsModule(falcon));
  assert(describeFipsModule({ moduleName: null, certificateNumber: '7', standard: null }) === 'FIPS 140 Certificate #7', 'without revision or module name: "FIPS 140 Certificate #7"');
  assert(describeFipsModules([falcon, openssl]) === 'FIPS 140-2 Certificate #4211 (CrowdStrike Falcon) and FIPS 140-3 Certificate #4802 (OpenSSL FIPS Provider)', 'two modules are joined with "and"');
  assert(isCryptographicProtectionControl('SC.L2-3.13.11') && isCryptographicProtectionControl('3.13.11') && !isCryptographicProtectionControl('SC.L2-3.13.1') && !isCryptographicProtectionControl('SC.L2-3.13.110') && !isCryptographicProtectionControl('SC.L2-3.13.8'), 'only requirement 3.13.11 is matched');
  assert(applyFipsModules('Uses **FIPS 140-3** modules.', [falcon]) === 'Uses **FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)** modules.', 'generic FIPS 140-3 text is replaced in place');
  assert(applyFipsModules('Uses FIPS 140-2 and FIPS 140-3.', [falcon], { bold: false }) === 'Uses FIPS 140-2 Certificate #4211 (CrowdStrike Falcon) and FIPS 140-2 Certificate #4211 (CrowdStrike Falcon).', 'every generic mention is replaced; plain text for table cells');
  assert(/validated under the NIST Cryptographic Module Validation Program: \*\*FIPS 140-2 Certificate #4211/.test(applyFipsModules('No generic text.', [falcon])), 'with no generic text the modules are appended as a sentence');
  assert(/\[No FIPS-validated cryptographic module is recorded/.test(applyFipsModules('Text.', [])), 'with no modules a visible gap note is appended');
}

function compilerTests() {
  console.log('\n--- Policy compiler injection (3.13.11) ---');
  const generic = getCascadedObjectiveNarrative('SC.L2-3.13.11', 'a', stack);
  assert(/\*\*FIPS 140-3\*\*/.test(generic) && !/Certificate #/.test(generic), 'without the inventory the 3.13.11 text keeps the generic "FIPS 140-3" wording (unchanged behaviour)', generic);
  const one = getCascadedObjectiveNarrative('SC.L2-3.13.11', 'a', stack, [falcon]);
  assert(one.includes('**FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)**'), 'the certificate number and module name replace the generic text', one);
  assert(!/FIPS 140-3/.test(one), '...and no generic "FIPS 140-3" is left behind');
  assert(one.includes('FIPS mode'), 'the rest of the objective text is intact');
  const two = getCascadedObjectiveNarrative('SC.L2-3.13.11', 'a', stack, [falcon, openssl]);
  assert(two.includes('FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)** and **FIPS 140-3 Certificate #4802') === false && two.includes('FIPS 140-2 Certificate #4211 (CrowdStrike Falcon) and FIPS 140-3 Certificate #4802 (OpenSSL FIPS Provider)'), 'several modules are all cited', two);
  const none = getCascadedObjectiveNarrative('SC.L2-3.13.11', 'a', stack, []);
  assert(/\[No FIPS-validated cryptographic module is recorded in the asset inventory/.test(none) && /\*\*FIPS 140-3\*\*/.test(none), 'an empty inventory keeps the template and flags the gap');
  assert(getCascadedObjectiveNarrative('3.13.11', 'a', stack, [falcon]) === one, 'the bare requirement number works the same');
  const other = getCascadedObjectiveNarrative('SC.L2-3.13.8', 'a', stack, [falcon]);
  assert(/FIPS 140-3/.test(other) && !/Certificate #4211/.test(other), 'other requirements that mention FIPS 140-3 (3.13.8) are NOT rewritten with an unrelated module', other);

  console.log('\n--- Living policy document ---');
  const tenant: Tenant = { id: 't', name: 'Acme Defense', cageCode: '1ABC2', samStatus: 'ACTIVE', systemName: 'Enclave', systemOwner: 'Owner', industry: 'DIB', createdAt: '', updatedAt: '', stackProfile: stack, primaryFramework: 'CMMC_L2' };
  const doc = generatePolicyDocument(tenant, 'SC', 'System and Communications Protection', 'CMMC_L2', [falcon, openssl]);
  const sec = doc.slice(doc.indexOf('### SC.L2-3.13.11'), doc.indexOf('### SC.L2-3.13.12'));
  assert(sec.includes('FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)') && sec.includes('FIPS 140-3 Certificate #4802 (OpenSSL FIPS Provider)'), 'the generated SC policy cites both certificates under 3.13.11', sec);
  const sec8 = doc.slice(doc.indexOf('### SC.L2-3.13.8'), doc.indexOf('### SC.L2-3.13.9'));
  assert(sec8.length > 0 && !sec8.includes('Certificate #'), 'and only there (3.13.8 is untouched)');
  const plain = generatePolicyDocument(tenant, 'SC', 'System and Communications Protection', 'CMMC_L2');
  assert(!plain.includes('Certificate #') && !plain.includes('[No FIPS-validated'), 'a document generated without inventory data is exactly as before');
  const gap = generatePolicyDocument(tenant, 'SC', 'System and Communications Protection', 'CMMC_L2', []);
  assert(gap.includes('[No FIPS-validated cryptographic module is recorded'), 'a document generated with an empty inventory shows the gap');
  const stringForm = generatePolicyDocument('SC', stack, 'CMMC_L2', undefined, [falcon]);
  assert(stringForm.includes('Certificate #4211'), 'the (family, stack, framework) call form accepts the modules too');

  console.log('\n--- SSP narrative ---');
  const meta: ReportMetadata = {
    systemName: 'Sys', organizationName: 'Org', cageCode: '1ABC2', samStatus: 'ACTIVE', systemOwner: 'Owner', primaryAssessor: 'A',
    boundaryDescription: 'Boundary.', systemEnvironment: 'Cloud', operationalStatus: 'Operational', cloudServiceProviders: 'GCP',
    classificationLevel: 'UNCLASSIFIED // CUI', assessmentDate: '2026-01-01', version: '1.0.0', framework: 'CMMC_L2',
  };
  const controls = getFrameworkControls('CMMC_L2');
  const cellFor = (d: ReturnType<typeof compileNistSSP>) => {
    const rows = d.sections.find((s) => s.id === 'sec-3-control-narratives')!.subsections!.flatMap((s) => s.table?.rows ?? []);
    return String(rows.find((r) => r[0] === 'SC.L2-3.13.11')?.[4] ?? '');
  };
  const withModules = compileNistSSP({ ...meta, cryptoModules: [falcon, openssl] }, controls, { 'SC.L2-3.13.11': { id: 'SC.L2-3.13.11', tenantId: 't', status: 'MET', implementationNotes: 'Disk encryption enforced.', responsibleRole: 'IT', lastUpdated: '', tags: [] } as any }, []);
  const cell = cellFor(withModules);
  assert(cell.startsWith('Disk encryption enforced.') && cell.includes('FIPS 140-2 Certificate #4211 (CrowdStrike Falcon)') && !cell.includes('**'), 'the 3.13.11 narrative keeps the author\'s notes and adds the certificates (plain text)', cell);
  const sub = withModules.sections.find((s) => s.id === 'sec-1-system-identification')!.subsections!.find((s) => s.title.startsWith('1.2.2'));
  assert(Boolean(sub) && sub!.table!.rows.length === 2 && sub!.table!.rows[0][0] === '#4211' && sub!.table!.rows[0][1] === 'CrowdStrike Falcon' && sub!.table!.rows[0][2] === 'FIPS 140-2' && sub!.table!.rows[0][3] === 'EDR-GATEWAY', 'section 1.2.2 tabulates certificate, module, standard and asset', sub?.table);
  const empty = compileNistSSP({ ...meta, cryptoModules: [] }, controls, {}, []);
  assert(/No FIPS-validated cryptographic module is recorded/.test(cellFor(empty)) && /No FIPS-validated cryptographic module is recorded/.test(empty.sections.find((s) => s.id === 'sec-1-system-identification')!.subsections!.find((s) => s.title.startsWith('1.2.2'))!.content ?? ''), 'an empty inventory is stated plainly in the SSP');
  const absent = compileNistSSP(meta, controls, {}, []);
  assert(!cellFor(absent).includes('FIPS') && !absent.sections.find((s) => s.id === 'sec-1-system-identification')!.subsections!.some((s) => s.title.startsWith('1.2.2')), 'with no inventory loaded the SSP states nothing about modules');
}

async function apiTests() {
  await new Promise((r) => setTimeout(r, 500));
  const owner = person('u_fips_owner');
  const tenant = (await call('POST', '/tenants', owner, undefined, { name: 'Fips Org' })).body?.tenant?.id as string;
  const path = `/tenants/${tenant}/assets`;
  const mk = (b: Json) => call('POST', path, owner, tenant, { cmmcAssetCategory: 'SECURITY_PROTECTION', ...b });

  console.log('\n--- API: FIPS data retention ---');
  const created = await mk({ hostName: 'EDR-GATEWAY', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '#4211', fipsModuleName: 'CrowdStrike Falcon', fipsStandard: '140-2' });
  const a = created.body?.asset as Json;
  assert(created.status === 201 && a.fipsValidationStatus === 'VALIDATED' && a.fipsCertificateNumber === '4211' && a.fipsModuleName === 'CrowdStrike Falcon' && a.fipsStandard === '140-2', 'create stores and returns the FIPS fields (certificate normalised)', created.body);
  const fresh = await call('GET', path, owner, tenant);
  const listed = (fresh.body?.assets as Json[]).find((x) => x.id === a.id)!;
  assert(listed.fipsCertificateNumber === '4211' && listed.fipsModuleName === 'CrowdStrike Falcon' && listed.fipsStandard === '140-2' && listed.fipsValidationStatus === 'VALIDATED', 'a later read returns them (retained)');
  const plain = (await mk({ hostName: 'PLAIN-FW' })).body?.asset as Json;
  assert(plain.fipsValidationStatus === null && plain.fipsCertificateNumber === null && plain.fipsModuleName === null && plain.fipsStandard === null, 'the fields are optional: an asset without them returns nulls');

  const renamed = await call('PUT', `${path}/${a.id}`, owner, tenant, { owner: 'Security Ops', notes: 'edited' });
  assert(renamed.body?.asset.fipsCertificateNumber === '4211' && renamed.body?.asset.fipsModuleName === 'CrowdStrike Falcon', 'editing other fields keeps the FIPS data');
  const swapped = await call('PUT', `${path}/${a.id}`, owner, tenant, { fipsCertificateNumber: '4802', fipsModuleName: 'OpenSSL FIPS Provider', fipsStandard: '140-3' });
  assert(swapped.body?.asset.fipsCertificateNumber === '4802' && swapped.body?.asset.fipsStandard === '140-3' && swapped.body?.asset.fipsValidationStatus === 'VALIDATED', 'a partial update changes only the FIPS fields sent (status stays VALIDATED)');
  const pending = await call('PUT', `${path}/${a.id}`, owner, tenant, { fipsValidationStatus: 'PENDING' });
  assert(pending.status === 400 && /pending module has no certificate/i.test(pending.body?.error), 'moving to PENDING while a certificate is set is refused with an explanation', pending.body);
  const pend2 = await call('PUT', `${path}/${a.id}`, owner, tenant, { fipsValidationStatus: 'PENDING', fipsCertificateNumber: null });
  assert(pend2.status === 200 && pend2.body?.asset.fipsCertificateNumber === null && pend2.body?.asset.fipsModuleName === 'OpenSSL FIPS Provider', 'PENDING with the certificate cleared keeps the module name');
  const back = await call('PUT', `${path}/${a.id}`, owner, tenant, { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '4211', fipsModuleName: 'CrowdStrike Falcon', fipsStandard: '140-2' });
  assert(back.status === 200, 'back to VALIDATED');

  console.log('\n--- API: validation ---');
  const bad = async (name: string, body: Json, re: RegExp) => {
    const r = await mk({ hostName: `BAD-${name}`, ...body });
    assert(r.status === 400 && re.test(r.body?.error ?? ''), `400: ${name}`, r.body);
  };
  await bad('validated-no-cert', { fipsValidationStatus: 'VALIDATED' }, /certificate number/i);
  await bad('cert-letters', { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: 'abc' }, /1 to 6 digits/);
  await bad('cert-too-long', { fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '1234567' }, /1 to 6 digits/);
  await bad('cert-no-status', { fipsCertificateNumber: '4211' }, /status/i);
  await bad('na-with-module', { fipsValidationStatus: 'NOT_APPLICABLE', fipsModuleName: 'x' }, /status/i);
  await bad('status-unknown', { fipsValidationStatus: 'GREAT' }, /status must be one of/i);
  await bad('standard-unknown', { fipsValidationStatus: 'PENDING', fipsStandard: '140-4' }, /standard must be one of/i);
  await bad('module-object', { fipsValidationStatus: 'PENDING', fipsModuleName: { x: 1 } }, /module name must be text/i);
  assert((await call('GET', path, owner, tenant)).body?.assets.every((x: Json) => !String(x.hostName).startsWith('BAD-')), 'none of the refused requests stored anything');
  const num = await mk({ hostName: 'NUMERIC-CERT', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: 4211 });
  assert(num.status === 201 && num.body?.asset.fipsCertificateNumber === '4211', 'a numeric certificate number is accepted');

  console.log('\n--- API: categories ---');
  const cui = await mk({ hostName: 'CUI-DB', cmmcAssetCategory: 'CUI_ASSET', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '3000' });
  assert(cui.status === 201 && cui.body?.asset.fipsCertificateNumber === '3000', 'a CUI asset can carry FIPS details');
  const crma = await mk({ hostName: 'QA-LAPTOP', cmmcAssetCategory: 'CONTRACTOR_RISK', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '3000' });
  assert(crma.status === 201 && crma.body?.asset.fipsValidationStatus === null && crma.body?.asset.fipsCertificateNumber === null, 'a CRMA cannot: the details are not stored');
  const reclass = await call('PUT', `${path}/${a.id}`, owner, tenant, { cmmcAssetCategory: 'OUT_OF_SCOPE' });
  assert(reclass.status === 200 && reclass.body?.asset.fipsCertificateNumber === null && reclass.body?.asset.fipsValidationStatus === null, 'reclassifying to Out-of-Scope clears the FIPS details');
  const reclassBack = await call('PUT', `${path}/${a.id}`, owner, tenant, { cmmcAssetCategory: 'SECURITY_PROTECTION' });
  assert(reclassBack.status === 200 && reclassBack.body?.asset.fipsCertificateNumber === null, 'and they do not come back by themselves');
  const toCui = await call('PUT', `${path}/${(await mk({ hostName: 'MOVER', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '555' })).body?.asset.id}`, owner, tenant, { cmmcAssetCategory: 'CUI_ASSET' });
  assert(toCui.body?.asset.fipsCertificateNumber === '555', 'moving between the two eligible categories keeps them');
  const clear = await call('PUT', `${path}/${toCui.body?.asset.id}`, owner, tenant, { fipsValidationStatus: null, fipsCertificateNumber: null, fipsModuleName: null, fipsStandard: null });
  assert(clear.status === 200 && clear.body?.asset.fipsValidationStatus === null && clear.body?.asset.fipsCertificateNumber === null, 'the details can be cleared explicitly');
  const put = await call('PUT', `${path}/${toCui.body?.asset.id}`, owner, tenant, { fipsValidationStatus: 'VALIDATED' });
  assert(put.status === 400, 'a PUT that would leave a validated module without a certificate is refused');

  console.log('\n--- API: bulk, discovery, roles, isolation ---');
  const bulk = await call('POST', `${path}/bulk`, owner, tenant, { assets: [
    { hostName: 'B-1', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '777', fipsModuleName: 'Bulk Module' },
    { hostName: 'B-2', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED' },
  ] });
  assert(bulk.status === 400 && bulk.body?.index === 1, 'bulk import validates the FIPS rules per row (reported by index)', bulk.body);
  const bulkOk = await call('POST', `${path}/bulk`, owner, tenant, { assets: [{ hostName: 'B-1', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '777', fipsModuleName: 'Bulk Module' }] });
  assert(bulkOk.status === 201 && bulkOk.body?.created[0].fipsCertificateNumber === '777', 'bulk import retains FIPS data');
  const mac = await mk({ hostName: 'SENSED', macAddress: 'AA:BB:CC:DD:EE:77', ipAddress: '10.9.9.77', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '808' });
  await call('POST', `${path}/discovery`, owner, tenant, { items: [{ agentId: 's', macAddress: 'AA:BB:CC:DD:EE:77', ipAddress: '10.9.9.77', discoveredPorts: [22] }] });
  assert((await call('GET', path, owner, tenant)).body?.assets.find((x: Json) => x.id === mac.body?.asset.id)?.fipsCertificateNumber === '808', 'a later network-discovery sweep does not touch the FIPS data');
  const viewer = withRole('u_fips_viewer', tenant, 'ASSESSOR');
  assert((await call('GET', path, viewer, tenant)).body?.assets.find((x: Json) => x.hostName === 'CUI-DB')?.fipsCertificateNumber === '3000', 'a read-only role reads the FIPS details');
  assert((await call('PUT', `${path}/${a.id}`, viewer, tenant, { fipsValidationStatus: 'NOT_APPLICABLE' })).status === 403, 'but cannot change them (403)');
  assert((await call('POST', path, viewer, tenant, { hostName: 'X', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'NOT_APPLICABLE' })).status === 403, 'nor create an asset with them (403)');
  const rival = person('u_fips_rival');
  const rivalTenant = (await call('POST', '/tenants', rival, undefined, { name: 'Rival' })).body?.tenant?.id as string;
  const theirs = (await call('GET', `/tenants/${rivalTenant}/assets`, rival, rivalTenant)).body?.assets as Json[];
  assert(theirs.length === 0, "another tenant sees none of this tenant's modules");
  assert((await call('PUT', `/tenants/${rivalTenant}/assets/${a.id}`, rival, rivalTenant, { fipsValidationStatus: 'NOT_APPLICABLE' })).status === 404, "and cannot reach this tenant's asset by id");

  console.log('\n--- Inventory -> documents (end to end) ---');
  const inventory = (await call('GET', path, owner, tenant)).body?.assets as Json[];
  const modules = collectFipsModules(inventory as any);
  assert(modules.map((m) => m.certificateNumber).join() === '777,808,4211', 'the modules collected from the server inventory are the validated Security Protection ones', modules);
  const policy = getCascadedObjectiveNarrative('SC.L2-3.13.11', 'a', stack, modules);
  assert(policy.includes('FIPS 140 Certificate #777 (Bulk Module)') && policy.includes('FIPS 140 Certificate #808') && policy.includes('FIPS 140 Certificate #4211') && !policy.includes('CrowdStrike'), 'the policy text built from them cites the stored certificates', policy);

  console.log('\n--- Client services ---');
  const { getAssetBackend } = await import('../src/services/assetService');
  localStorage.setItem('pbc_session_id_token_v2', owner);
  const be = getAssetBackend(tenant, 'server');
  const viaClient = await be.create({ hostName: 'CLIENT-FW', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '1234', fipsModuleName: 'Client Module', fipsStandard: '140-3' });
  assert(viaClient.fipsCertificateNumber === '1234' && viaClient.fipsStandard === '140-3' && viaClient.fipsModuleName === 'Client Module', 'the client backend round-trips the FIPS fields through the server');
  const rejected = await be.create({ hostName: 'CLIENT-BAD', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED' }).then(() => null, (e: { status?: number; message: string }) => e);
  assert(rejected?.status === 400 && /certificate number/i.test(rejected.message), 'a refused change surfaces the server message to the user', rejected);
  const local = getAssetBackend('tenant-fips-local', 'local-legacy');
  const l1 = await local.create({ hostName: 'LOCAL-FW', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED', fipsCertificateNumber: '#99', fipsModuleName: 'Local Module' });
  assert(l1.fipsCertificateNumber === '99', 'the browser-local backend applies the same rules (normalised)');
  assert((await local.create({ hostName: 'LOCAL-BAD', cmmcAssetCategory: 'SECURITY_PROTECTION', fipsValidationStatus: 'VALIDATED' }).then(() => 'created', () => 'refused')) === 'refused', 'and refuses a validated module without a certificate');
  const l2 = await local.classify(l1.id, 'OUT_OF_SCOPE');
  assert(l2.fipsCertificateNumber === null && l2.fipsValidationStatus === null, 'and clears the details on reclassification');
  const l3 = await local.update(l1.id, { cmmcAssetCategory: 'CUI_ASSET', fipsValidationStatus: 'PENDING', fipsModuleName: 'Pending Module' });
  assert(l3.fipsValidationStatus === 'PENDING' && (await local.list()).find((x) => x.id === l1.id)?.fipsModuleName === 'Pending Module', 'local update retains FIPS data across reads');
}

async function run() {
  schemaTests();
  ruleTests();
  compilerTests();
  await apiTests();

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
