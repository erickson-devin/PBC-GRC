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
import { computeSha256 } from '../src/data/audit/auditLogger';

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
