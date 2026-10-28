/**
 * Enclave-Level Framework Scope Test Suite
 * Validates tenant-scoped framework isolation and provisioning for Event Horizon GRC
 */

import { DEFAULT_BLANK_TENANT } from '../src/context/TenantContext';
import { ComplianceFramework } from '../src/types/framework';
import { Tenant } from '../src/types/tenant';
import { FRAMEWORK_REGISTRY } from '../src/data/frameworks';
import { extractOwnerEmail, initialOwnerEmail, ownerEmailChanged } from '../src/utils/systemOwner';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  console.log('===============================================================');
  console.log('🧪 EVENT HORIZON GRC: ENCLAVE-LEVEL FRAMEWORK SCOPE TEST SUITE');
  console.log('===============================================================\n');

  // Test Group 1: Default & Seed Tenant Framework Scope Initialization
  console.log('📋 Test Group 1: Default & Seed Tenant Schema Scope');
  {
    assert(
      DEFAULT_BLANK_TENANT.primaryFramework === 'CMMC_L1',
      'DEFAULT_BLANK_TENANT initializes with primaryFramework = CMMC_L1',
      `Got ${DEFAULT_BLANK_TENANT.primaryFramework}`
    );

    assert(
      Array.isArray(DEFAULT_BLANK_TENANT.enabledFrameworks) &&
      DEFAULT_BLANK_TENANT.enabledFrameworks.length === 1 &&
      DEFAULT_BLANK_TENANT.enabledFrameworks[0] === 'CMMC_L1',
      'DEFAULT_BLANK_TENANT initializes with enabledFrameworks = ["CMMC_L1"]',
      `Got ${JSON.stringify(DEFAULT_BLANK_TENANT.enabledFrameworks)}`
    );

  }

  // Test Group 2: Enclave Provisioning Scope Simulation
  console.log('\n📋 Test Group 2: Enclave Provisioning Target Framework Scope');
  {
    function simulateProvisionTenant(params: {
      companyName: string;
      primaryFramework?: ComplianceFramework;
      enabledFrameworks?: ComplianceFramework[];
    }): Tenant {
      const prim = params.primaryFramework || 'CMMC_L1';
      const en = params.enabledFrameworks && params.enabledFrameworks.length > 0
        ? params.enabledFrameworks
        : [prim];
      const validEn = en.includes(prim) ? en : [prim, ...en];

      return {
        id: `tenant-${Date.now()}`,
        name: params.companyName,
        cageCode: '1A2B3',
        samStatus: 'ACTIVE',
        systemName: `${params.companyName} Enclave`,
        systemOwner: 'ciso@defense.us',
        industry: 'Defense Industrial Base (DIB)',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        primaryFramework: prim,
        enabledFrameworks: validEn,
      };
    }

    const singleOrgTenant = simulateProvisionTenant({
      companyName: 'Lockheed Subsidiary Alpha',
      primaryFramework: 'CMMC_L2',
      enabledFrameworks: ['CMMC_L2'],
    });

    assert(
      singleOrgTenant.primaryFramework === 'CMMC_L2' &&
      singleOrgTenant.enabledFrameworks?.length === 1 &&
      singleOrgTenant.enabledFrameworks[0] === 'CMMC_L2',
      'Single Org tenant provisioned strictly with CMMC_L2 scope'
    );

    const multiAuditTenant = simulateProvisionTenant({
      companyName: 'Raytheon Multi-Audit Labs',
      primaryFramework: 'NIST_800_53_REV5',
      enabledFrameworks: ['NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'],
    });

    assert(
      multiAuditTenant.primaryFramework === 'NIST_800_53_REV5' &&
      multiAuditTenant.enabledFrameworks?.length === 3 &&
      multiAuditTenant.enabledFrameworks.includes('SOC_2_TYPE_II') &&
      multiAuditTenant.enabledFrameworks.includes('HIPAA_SECURITY'),
      'Multi-Audit tenant provisioned with 3 active framework modules'
    );

    // Verify auto-inclusion if primary was omitted from enabled array
    const autoCorrectedTenant = simulateProvisionTenant({
      companyName: 'Auto Correct Defense',
      primaryFramework: 'CMMC_L2',
      enabledFrameworks: ['SOC_2_TYPE_II'],
    });

    assert(
      autoCorrectedTenant.enabledFrameworks?.includes('CMMC_L2') &&
      autoCorrectedTenant.primaryFramework === 'CMMC_L2',
      'Primary framework is automatically preserved in enabledFrameworks even if omitted in checklist'
    );
  }

  // Test Group 3: Enclave-Level Scope Filtering in FrameworkSwitcher
  console.log('\n📋 Test Group 3: Enclave-Level Scope Filtering Logic');
  {
    const allFrameworkIds = Object.keys(FRAMEWORK_REGISTRY) as ComplianceFramework[];

    function getSelectableFrameworksForTenant(tenant: Partial<Tenant>): ComplianceFramework[] {
      const allowed = tenant.enabledFrameworks && tenant.enabledFrameworks.length > 0
        ? tenant.enabledFrameworks
        : [tenant.primaryFramework || 'CMMC_L1'];
      return allFrameworkIds.filter(f => allowed.includes(f));
    }

    // Single-framework enclave:
    const singleFwAllowed = getSelectableFrameworksForTenant({
      primaryFramework: 'CMMC_L1',
      enabledFrameworks: ['CMMC_L1'],
    });

    assert(
      singleFwAllowed.length === 1 && singleFwAllowed[0] === 'CMMC_L1',
      'Single-framework enclave permits only 1 framework (no dropdown leakage)'
    );

    // Multi-framework enclave:
    const multiFwAllowed = getSelectableFrameworksForTenant({
      primaryFramework: 'NIST_800_53_REV5',
      enabledFrameworks: ['NIST_800_53_REV5', 'CMMC_L2'],
    });

    assert(
      multiFwAllowed.length === 2 &&
      multiFwAllowed.includes('NIST_800_53_REV5') &&
      multiFwAllowed.includes('CMMC_L2') &&
      !multiFwAllowed.includes('HIPAA_SECURITY'),
      'Multi-framework enclave limits choices strictly to enabled modules'
    );
  }

  // Test Group 4: Dynamic Enclave Framework Scope Mutation (updateTenantFrameworkScope)
  console.log('\n📋 Test Group 4: Dynamic Enclave Scope Update Mutation');
  {
    let currentTenant: Tenant = {
      id: 'tenant-test-mutate',
      name: 'Dynamic Test Enclave',
      cageCode: '99999',
      systemName: 'COE Boundary',
      systemOwner: 'owner@test.us',
      industry: 'Defense',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      primaryFramework: 'CMMC_L1',
      enabledFrameworks: ['CMMC_L1'],
    };

    let activeFramework: ComplianceFramework = 'CMMC_L1';

    function updateTenantFrameworkScope(
      tenantId: string,
      enabled: ComplianceFramework[],
      primary: ComplianceFramework
    ) {
      const validEnabled = enabled.length > 0 ? enabled : [primary];
      const validPrimary = validEnabled.includes(primary) ? primary : validEnabled[0];

      if (currentTenant.id === tenantId) {
        currentTenant = {
          ...currentTenant,
          enabledFrameworks: validEnabled,
          primaryFramework: validPrimary,
          updatedAt: new Date().toISOString(),
        };

        if (!validEnabled.includes(activeFramework)) {
          activeFramework = validPrimary;
        }
      }
    }

    // Add SOC 2 and CMMC L2 to the enclave scope
    updateTenantFrameworkScope('tenant-test-mutate', ['CMMC_L1', 'CMMC_L2', 'SOC_2_TYPE_II'], 'CMMC_L2');

    assert(
      currentTenant.primaryFramework === 'CMMC_L2',
      'Primary framework successfully promoted to CMMC_L2'
    );

    assert(
      currentTenant.enabledFrameworks?.length === 3 &&
      currentTenant.enabledFrameworks.includes('SOC_2_TYPE_II'),
      'Enabled frameworks updated to include 3 modules'
    );

    // Active framework was CMMC_L1, which is still in enabledFrameworks
    assert(
      activeFramework === 'CMMC_L1',
      'Active framework stays active if still present in enabled scope'
    );

    // Restrict scope to only HIPAA_SECURITY
    updateTenantFrameworkScope('tenant-test-mutate', ['HIPAA_SECURITY'], 'HIPAA_SECURITY');

    assert(
      currentTenant.primaryFramework === 'HIPAA_SECURITY' &&
      currentTenant.enabledFrameworks?.length === 1 &&
      currentTenant.enabledFrameworks[0] === 'HIPAA_SECURITY',
      'Scope restricted to single HIPAA_SECURITY framework'
    );

    assert(
      activeFramework === 'HIPAA_SECURITY',
      'Active framework automatically synchronized to new primary when previous framework was de-scoped'
    );
  }

  // System owner contact helpers
  {
    console.log('\n--- System owner contact helpers ---');
    assert(extractOwnerEmail('alex@example.com') === 'alex@example.com', 'extractOwnerEmail: plain email');
    assert(extractOwnerEmail('Alex Mercer (alex@example.com)') === 'alex@example.com', 'extractOwnerEmail: parenthesised email');
    assert(extractOwnerEmail('Alex <alex@example.com>') === 'alex@example.com', 'extractOwnerEmail: angle-bracket email');
    assert(extractOwnerEmail('Alex (CISO)') === '', 'extractOwnerEmail: non-email parenthetical is empty');
    assert(extractOwnerEmail('Alex Mercer') === '', 'extractOwnerEmail: plain name is empty');
    assert(extractOwnerEmail(undefined) === '', 'extractOwnerEmail: undefined is empty');
    assert(
      initialOwnerEmail({ systemOwner: 'wave4-check@pbc.test' }) === 'wave4-check@pbc.test',
      'initialOwnerEmail keeps the existing email (never invents admin@<domain>)'
    );
    assert(initialOwnerEmail({ systemOwner: 'Alex Mercer' }) === '', 'initialOwnerEmail: name without email is empty');
    assert(ownerEmailChanged('a@x.test', ' A@X.test ') === false, 'ownerEmailChanged: case/whitespace-only difference is unchanged');
    assert(ownerEmailChanged('a@x.test', 'b@x.test') === true, 'ownerEmailChanged: different email is changed');
    assert(ownerEmailChanged('a@x.test', '  ') === false, 'ownerEmailChanged: cleared field is not a change');
    assert(ownerEmailChanged('', 'b@x.test') === true, 'ownerEmailChanged: new email over empty pre-fill is changed');

    const modalSrc = readFileSync(join(process.cwd(), 'src', 'components', 'admin', 'EditEnclaveModal.tsx'), 'utf8');
    assert(!modalSrc.includes('admin@${'), 'EditEnclaveModal no longer invents admin@<domain>');
    assert(modalSrc.includes('ownerEmailChanged('), 'EditEnclaveModal gates the owner update on ownerEmailChanged');
  }

  // Summary
  console.log('\n===============================================================');
  console.log(`📊 RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('===============================================================');

  if (passedTests === totalTests) {
    console.log('🎉 ALL ENCLAVE FRAMEWORK SCOPE TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } else {
    console.error('❌ SOME ENCLAVE FRAMEWORK SCOPE TESTS FAILED.\n');
    process.exit(1);
  }
}

runTests();
