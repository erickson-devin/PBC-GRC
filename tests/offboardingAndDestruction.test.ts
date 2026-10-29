/**
 * Enclave Offboarding, NIST SP 800-88 Cryptographic Destruction & Lifecycle Test Suite
 * Validates Super Admin offboarding export, 3-pass cryptographic wipe, and certificate generation.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { Tenant } from '../src/types/tenant';
import {
  generateEnclaveHandoverPackage,
  executeCryptographicDestruction,
} from '../src/data/storage/offboardingEngine';
import { buildProgramHandover } from '../src/data/storage/offboardingPrograms';
import { programFrameworkControls, scopingToOverlays } from '../src/data/programScope';
import { getFrameworkControls } from '../src/data/frameworks';
import type { Program } from '../src/types/program';
import { computeSha256, canonicalJson } from '../src/data/audit/auditLogger';
import { boundaryNarrative, summarizeScope } from '../src/data/telemetry/assetScope';
import { createInitialState } from '../src/services/storageService';

// Polyfill minimal localStorage for Node environment if absent
if (typeof (global as any).localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
}
if (typeof (global as any).window === 'undefined') {
  (global as any).window = { localStorage: (global as any).localStorage };
}

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    if (detail) {
      console.error(`     Detail: ${detail}`);
    }
  }
}

async function runTests() {
  console.log('====================================================================');
  console.log('🧪 EVENT HORIZON: ENCLAVE OFFBOARDING & NIST SP 800-88 TEST SUITE');
  console.log('====================================================================\n');

  const testTenant: Tenant = {
    id: 'tenant-vanguard-01',
    name: 'Vanguard Defense Systems LLC',
    cageCode: '8K3R1',
    samStatus: 'ACTIVE',
    systemName: 'Defense Contracting Information Network (DCIN)',
    systemOwner: 'Alex Mercer, CMMC CCA',
    industry: 'Defense IT & Systems Integration',
    domain: 'vanguard-defense.us',
    createdAt: '2026-01-15T08:00:00.000Z',
    updatedAt: '2026-01-15T08:00:00.000Z',
    isConfigured: true,
    primaryFramework: 'CMMC_L1',
    enabledFrameworks: ['CMMC_L1', 'CMMC_L2'],
  };

  // Test Group 1: Offboarding Handover Package Compilation
  console.log('📦 Test Group 1: Compliance Offboarding Handover Package Compilation');
  {
    const handoverPackage = await generateEnclaveHandoverPackage(testTenant.id, testTenant);

    assert(
      handoverPackage.schemaVersion === '2.0.0',
      'Package schema version is 2.0.0',
      `Got ${handoverPackage.schemaVersion}`
    );

    assert(
      handoverPackage.packageType === 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER',
      'Package type is DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER',
      `Got ${handoverPackage.packageType}`
    );

    assert(
      handoverPackage.tenant.id === testTenant.id && handoverPackage.tenant.name === testTenant.name,
      'Package contains matching tenant metadata and legal name'
    );

    assert(
      Boolean(handoverPackage.reports.systemSecurityPlan),
      'Package includes compiled NIST SP 800-18 System Security Plan (SSP)'
    );

    assert(
      handoverPackage.reports.systemSecurityPlan.sections.length > 0,
      'Compiled SSP contains operational security sections'
    );

    assert(
      Array.isArray(handoverPackage.reports.poamMatrix),
      'Package includes structured POA&M deficiency matrix'
    );

    assert(
      Array.isArray(handoverPackage.evidenceIndex),
      'Package includes evidence metadata index'
    );

    assert(
      Array.isArray(handoverPackage.auditLedger),
      'Package includes cryptographic audit ledger'
    );

    assert(
      Boolean(handoverPackage.integrityChecksum && handoverPackage.integrityChecksum.length === 64),
      'Package integrity checksum is a valid 64-character SHA-256 hash',
      `Got: ${handoverPackage.integrityChecksum}`
    );

    assert(
      handoverPackage.retentionStandard.includes('DFARS 252.204-7012'),
      'Package declares DFARS 252.204-7012 audit retention standard'
    );
  }

  // Test Group 1b: server control states reach the handover package
  console.log('\n🗄️ Test Group 1b: Server Control States in the Handover Package');
  {
    const base = { responsibleRole: 'Owner', lastUpdated: '2026-01-01T00:00:00.000Z', tags: [] as string[] };
    const states = {
      'AC.L1-3.1.1': { ...base, id: 'AC.L1-3.1.1', status: 'MET' as const, implementationNotes: 'SERVER-NOTES-MARKER-55' },
    };
    const withStates = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, states);
    const without = await generateEnclaveHandoverPackage(testTenant.id, testTenant);

    assert(
      JSON.stringify(withStates.reports.systemSecurityPlan).includes('SERVER-NOTES-MARKER-55'),
      'O1: server implementation notes appear in the SSP when controlStates is provided'
    );
    assert(
      !JSON.stringify(without.reports.systemSecurityPlan).includes('SERVER-NOTES-MARKER-55'),
      'O2: SSP does not include the notes when controlStates is omitted'
    );

    const notMet = { ...states, 'AC.L1-3.1.1': { ...states['AC.L1-3.1.1'], status: 'NOT_MET' as const } };
    const overridden = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, notMet);
    assert(
      overridden.complianceSummary.notMetCount !== withStates.complianceSummary.notMetCount
        || overridden.complianceSummary.metCount !== withStates.complianceSummary.metCount,
      'O3: controlStates overrides the cached status in the report summary',
      `met ${withStates.complianceSummary.metCount}->${overridden.complianceSummary.metCount}, notMet ${withStates.complianceSummary.notMetCount}->${overridden.complianceSummary.notMetCount}`
    );
  }

  // Test Group 1c: a live tenant's evidence list comes from the server, not the browser cache
  console.log('\n🗂️ Test Group 1c: Server Evidence List in the Handover Package');
  {
    const srvTenant: Tenant = { ...testTenant, id: 'tenant-srv-evidence-01', serverBacked: true };
    const cached = createInitialState(srvTenant);
    cached.evidenceIndex = [{ id: 'ev-cached-1', tenantId: srvTenant.id, fileName: 'cached.pdf' } as any];
    localStorage.setItem(`pbc_cmmc_assessment_v3_${srvTenant.id}`, JSON.stringify(cached));

    const serverItem = { id: 'ev-srv-1', tenantId: srvTenant.id, fileName: 'server.pdf' } as any;
    const withList = await generateEnclaveHandoverPackage(srvTenant.id, srvTenant, undefined, undefined, [serverItem]);
    assert(
      withList.evidenceIndex.length === 1 && withList.evidenceIndex[0].id === 'ev-srv-1' && withList.complianceSummary.evidenceItemsCount === 1,
      'OB-E1: the evidence list passed in is the one the package holds'
    );
    const withoutList = await generateEnclaveHandoverPackage(srvTenant.id, srvTenant);
    assert(
      withoutList.evidenceIndex.length === 0 && withoutList.complianceSummary.evidenceItemsCount === 0,
      'OB-E2: a server tenant without a passed list gets none of the cached items'
    );
    const dashSrc = readFileSync(join(process.cwd(), 'src/components/admin/SuperAdminDashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    assert(
      /ApiClient\.getEvidence\(\s*\w+,\s*\w+\)/.test(dashSrc) && /getControls\(\s*\w+,\s*undefined,\s*\w+\)/.test(dashSrc) && dashSrc.includes('generateEnclaveHandoverPackage(tenant.id, tenant, assets)'),
      'OB-E3: SuperAdminDashboard fetches the server controls and evidence of a chosen program, and keeps the direct call for a browser-only tenant'
    );
  }

  // Test Group 1d: the handover per program (issue #27)
  console.log('\n🧭 Test Group 1d: Handover Package per Program');
  {
    const progTenant: Tenant = { ...testTenant, id: 'tenant-programs-01', serverBacked: true };
    const mk = (over: Partial<Program>): Program => ({
      id: 'p-default', name: 'Default program', description: '', framework: 'CMMC_L1', baseline: null, privacyBaseline: false, boundarySummary: '',
      scoping: {}, vmTarget: false, isDefault: true, archived: false, ...over,
    });
    const nistLow = mk({ id: 'p-nist-low', name: 'NIST Low', framework: 'NIST_800_53_REV5', baseline: 'LOW', isDefault: false });
    const opts = (program: Program) => ({ program, download: false });

    const p1 = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts(nistLow));
    const expected1 = programFrameworkControls(nistLow, scopingToOverlays({})).length;
    assert(p1.program?.id === 'p-nist-low' && p1.complianceSummary.totalControls === expected1, 'OB-P1: a program package holds that program\'s catalog and names the program', `${p1.complianceSummary.totalControls} vs ${expected1}`);

    const withBoundary = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts({ ...nistLow, boundarySummary: 'LAB-BOUNDARY-77' }));
    assert(JSON.stringify(withBoundary.reports.systemSecurityPlan).includes('LAB-BOUNDARY-77'), 'OB-P2: the SSP uses the program\'s boundary text');

    const noWireless = { ...nistLow, scoping: { noWireless: true as const } };
    const p3 = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts(noWireless));
    assert(
      p3.complianceSummary.totalControls === programFrameworkControls(noWireless, scopingToOverlays(noWireless.scoping)).length && p3.complianceSummary.totalControls <= p1.complianceSummary.totalControls,
      'OB-P3: the program\'s overlays narrow its package'
    );

    const plain = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, undefined, undefined, { download: false });
    assert(plain.program === undefined && plain.complianceSummary.totalControls === getFrameworkControls('CMMC_L1').length, 'OB-P4: without a program the package is the tenant\'s primary framework, as before');

    const freshId = 'tenant-programs-nocache-01';
    await generateEnclaveHandoverPackage(freshId, { ...progTenant, id: freshId }, undefined, {}, [], opts(nistLow));
    assert(localStorage.getItem(`pbc_cmmc_assessment_v3_${freshId}`) === null, 'OB-P5: a program package neither reads nor writes the browser cache');

    // Fake server: records what is asked
    const programs = [
      mk({ id: 'p-b', name: 'Second', isDefault: false, archived: true }),
      mk({ id: 'p-a', name: 'First', isDefault: true }),
    ];
    const controlCalls: string[] = [];
    const evidenceCalls: string[] = [];
    const deps = {
      listPrograms: async () => programs,
      getControls: async (_t: string, p: string) => { controlCalls.push(p); return []; },
      getEvidence: async (_t: string, p: string) => { evidenceCalls.push(p); return [{ id: `ev-${p}`, tenantId: progTenant.id, fileName: 'f.pdf' } as any]; },
    };
    const all = await buildProgramHandover(progTenant, { kind: 'all' }, undefined, deps);
    assert(
      all.packages.length === 2 && all.packages[0].program?.id === 'p-a' && all.packages[1].program?.archived === true
        && controlCalls.join() === 'p-a,p-b' && all.bundle?.integrityChecksum.length === 64 && all.bundle.programCount === 2,
      'OB-P6: "all programs" builds one package per program (default first, archived flagged) and one bundle',
      controlCalls.join()
    );

    controlCalls.length = 0;
    evidenceCalls.length = 0;
    const one = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-b' }, undefined, deps);
    assert(
      one.packages.length === 1 && one.bundle === null && controlCalls.join() === 'p-b' && one.packages[0].evidenceIndex[0]?.id === 'ev-p-b' && evidenceCalls.join() === 'p-b',
      'OB-P7: one program fetches only its own controls and evidence'
    );

    // OB-P10: the package states the program's declared assets, or the whole inventory while it declares none (issue #26)
    const bAssets = [
      { id: 'a1', hostName: 'H1', cmmcAssetCategory: 'CUI_ASSET' },
      { id: 'a2', hostName: 'H2', cmmcAssetCategory: 'CUI_ASSET' },
    ] as any[];
    const declaredNarrative = boundaryNarrative(summarizeScope([bAssets[0]]));
    const wholeNarrative = boundaryNarrative(summarizeScope(bAssets));
    const declaredPkg = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, {
      ...deps, getProgramAssets: async () => ({ declared: true, assetIds: ['a1'] }),
    });
    const undeclaredPkg = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, {
      ...deps, getProgramAssets: async () => ({ declared: false, assetIds: [] }),
    });
    assert(
      declaredNarrative !== wholeNarrative
        && JSON.stringify(declaredPkg.packages[0].reports.systemSecurityPlan).includes(declaredNarrative)
        && JSON.stringify(undeclaredPkg.packages[0].reports.systemSecurityPlan).includes(wholeNarrative),
      'OB-P10: a declared program states only its assets; an undeclared one states the whole inventory'
    );
    let failedClosed: unknown = null;
    try {
      await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, { ...deps, getProgramAssets: async () => { throw new Error('boom'); } });
    } catch (err) { failedClosed = err; }
    assert(failedClosed instanceof Error, 'OB-P10b: if the declared assets cannot be read the export rejects (no package with the wrong boundary)');

    let notFound: unknown = null;
    try { await buildProgramHandover(progTenant, { kind: 'program', programId: 'nope' }, undefined, deps); } catch (err) { notFound = err; }
    assert(notFound instanceof Error && /not found/.test(notFound.message), 'OB-P8: an unknown program rejects with "not found"');

    if (all.bundle) {
      const { integrityChecksum, ...rest } = all.bundle;
      assert(await computeSha256(canonicalJson(rest)) === integrityChecksum, 'OB-P9: the bundle checksum covers everything but itself');
    } else {
      assert(false, 'OB-P9: the bundle checksum covers everything but itself');
    }

    const dialogSrc = readFileSync(join(process.cwd(), 'src/components/admin/OffboardingProgramDialog.tsx'), 'utf8');
    const dashSrc2 = readFileSync(join(process.cwd(), 'src/components/admin/SuperAdminDashboard.tsx'), 'utf8');
    assert(dashSrc2.includes('OffboardingProgramDialog') && dashSrc2.includes('buildProgramHandover('), 'OB-U1: the dashboard opens the program chooser and builds the handover per program');
    assert(dialogSrc.includes('<DialogOverlay') && dialogSrc.includes('includeArchived: true') && dialogSrc.includes('<legend'), 'OB-U2: the chooser is a dialog with a legend, listing archived programs too');
    assert(!/console\./.test(dialogSrc), 'OB-U3: the chooser logs nothing');
    assert(dialogSrc.includes('You are not a member of this tenant') && dashSrc2.includes('NOT_MEMBER_MESSAGE'), 'OB-U4: the not-a-member text is still shown');
    assert(
      dashSrc2.includes('getProgramAssets: (t, p) => ApiClient.getProgramAssets(t, p)') && dialogSrc.includes('declared its assets') && !dialogSrc.includes('Each package states the whole asset inventory'),
      'OB-U5: the handover follows the program\'s declared assets (the dashboard reads them, the chooser says so)'
    );
  }

  // Test Group 2: NIST SP 800-88 Cryptographic Sanitization & Destruction Protocol
  console.log('\n🔥 Test Group 2: NIST SP 800-88 Cryptographic Destruction Protocol');
  {
    const mockTenantId = 'tenant-decom-alpha-09';
    const mockTenant = {
      ...testTenant,
      id: mockTenantId,
      name: 'Alpha Decommissioned Defense Corp',
      cageCode: '1A2B3',
    };

    const cert = await executeCryptographicDestruction({
      tenantId: mockTenant.id,
      systemName: mockTenant.systemName,
      cageCode: mockTenant.cageCode,
      actorName: 'Devin Erickson',
      actorEmail: 'devin@pitchblackcyber.com',
    });

    assert(
      Boolean(cert.certificateId && cert.certificateId.startsWith('CERT-DEST-')),
      'Certificate of Destruction generated with canonical CERT-DEST prefix',
      `Got: ${cert.certificateId}`
    );

    assert(
      cert.tenantId === mockTenantId,
      'Certificate scopes destroyed tenant enclave ID accurately'
    );

    assert(
      cert.cageCode === '1A2B3',
      'Certificate records accurate CAGE code for DoD compliance tracking'
    );

    assert(
      cert.sanitizationMethod.includes('Cryptographic Erase'),
      'Sanitization method complies with NIST SP 800-88 Cryptographic Erase standard'
    );

    assert(
      cert.complianceStandard.includes('DFARS 252.204-7012'),
      'Destruction certificate references DFARS 252.204-7012 compliance standard'
    );

    assert(
      cert.purgedObjectsCount > 0,
      `Purged objects count reflects total sanitized records (count: ${cert.purgedObjectsCount})`
    );

    assert(
      Boolean(cert.certificateSha256 && cert.certificateSha256.length === 64),
      'Certificate of Destruction contains valid 64-character SHA-256 tamper-evident digest',
      `Got: ${cert.certificateSha256}`
    );
  }

  // Test Group 2b: browser evidence files are cleared first, and destruction fails closed
  console.log('\n🧹 Test Group 2b: Evidence File Clearing (fail closed)');
  {
    const base = { actorName: 'Devin Erickson', actorEmail: 'devin@pitchblackcyber.com' };

    const calls: string[] = [];
    let certReturned = false;
    const okCert = await executeCryptographicDestruction({
      ...base,
      tenantId: 'tenant-evidence-spy',
      clearEvidenceFiles: async (id) => { calls.push(id); },
    });
    certReturned = Boolean(okCert.certificateId);
    assert(
      calls.length === 1 && calls[0] === 'tenant-evidence-spy' && certReturned,
      'OD1: evidence clearing is called once with the tenant id and the certificate is still issued',
      `calls=${JSON.stringify(calls)}`
    );

    let threw: unknown = null;
    let failCert: unknown = null;
    try {
      failCert = await executeCryptographicDestruction({
        ...base,
        tenantId: 'tenant-evidence-fail',
        clearEvidenceFiles: async () => { throw new Error('idb down'); },
      });
    } catch (err) {
      threw = err;
    }
    assert(
      failCert === null && threw instanceof Error && /no Certificate of Destruction was issued/.test(threw.message),
      'OD2: a failing evidence clear issues no certificate and surfaces an error',
      String(threw)
    );

    let noIdbCert: { certificateId?: string } | null = null;
    let noIdbErr: unknown = null;
    try {
      noIdbCert = await executeCryptographicDestruction({ ...base, tenantId: 'tenant-evidence-noidb' });
    } catch (err) {
      noIdbErr = err;
    }
    assert(
      typeof (globalThis as any).indexedDB === 'undefined' && noIdbErr === null && Boolean(noIdbCert?.certificateId),
      'OD3: without indexedDB and without an injected function there is nothing to clear and the certificate is issued',
      String(noIdbErr)
    );

    const engineSrc = readFileSync(join(process.cwd(), 'src/data/storage/offboardingEngine.ts'), 'utf8');
    assert(
      !engineSrc.includes('pbc_evidence_${'),
      'OD4: offboardingEngine no longer removes the dead pbc_evidence_<tenant> localStorage key'
    );

    const ctxSrc = readFileSync(join(process.cwd(), 'src/context/TenantContext.tsx'), 'utf8');
    const deleteBody = ctxSrc.slice(ctxSrc.indexOf('const deleteTenant = useCallback'));
    const deleteFn = deleteBody.slice(0, deleteBody.indexOf('}, ['));
    assert(
      deleteFn.includes('EvidenceVault.clearTenant(tenantId)'),
      'OD5: deleteTenant clears the tenant IndexedDB evidence files'
    );

    const vaultSrc = readFileSync(join(process.cwd(), 'src/services/evidenceVault.ts'), 'utf8').replace(/\r\n/g, '\n');
    const strictBody = vaultSrc.slice(vaultSrc.indexOf('async clearTenantStrict('), vaultSrc.indexOf('async clearAll('));
    assert(
      engineSrc.includes('EvidenceVault.clearTenantStrict(') && strictBody.length > 0 && !/catch\s*[({]/.test(strictBody),
      'OD6: destruction defaults to the strict clear, which has no catch (a failure rejects, so no certificate is issued)'
    );
    assert(
      strictBody.includes('legacyEvidenceIds') && strictBody.includes('`${EVIDENCE_STORE_PREFIX}${id}`'),
      'OD7: the strict clear also removes the legacy unpartitioned keys of the tenant evidence ids'
    );
  }

  // Test Group 3: Cryptographic Integrity Verification Check
  console.log('\n🔐 Test Group 3: Cryptographic Digest Consistency');
  {
    const testData = 'Pitch Black Cyber Defense Enclave Cryptographic Audit Ledger';
    const digest1 = await computeSha256(testData);
    const digest2 = await computeSha256(testData);

    assert(
      digest1 === digest2,
      'Cryptographic SHA-256 digest computation is deterministic'
    );

    assert(
      digest1.length === 64,
      'SHA-256 produces exact 256-bit hexadecimal digest (64 chars)'
    );
  }

  console.log('\n====================================================================');
  console.log(`📊 RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('====================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
