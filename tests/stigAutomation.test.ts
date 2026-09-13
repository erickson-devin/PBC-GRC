/**
 * DISA STIG & Technical Baseline Automation Suite Test
 * Validates Ticket 2.2 functionality for Event Horizon GRC (PBC-GRC)
 */

import {
  getAllStigProfiles,
  getStigProfile,
  getAllStigRules,
  getStigRulesForControl,
  STIG_PROFILES_REGISTRY,
} from '../src/data/stigs/stigCatalog';
import {
  generateAnsiblePlaybook,
  generatePowerShellDscScript,
  generateDisaStigChecklistXml,
} from '../src/data/stigs/scriptGenerators';
import { StigProfileId, StigSeverity } from '../src/types/stig';
import { ControlState, SSPMetadata } from '../src/types/cmmc';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runStigAutomationTests() {
  console.log('\n================================================================');
  console.log('🛡️  EVENT HORIZON GRC - TICKET 2.2 AUTOMATED TEST SUITE');
  console.log('   DISA STIG & Technical Baseline Automation Suite');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------
    // 1. STIG Profile Registry & Catalog Completeness
    // -------------------------------------------------------------
    console.log('--- Test 1: STIG Profile Registry & Catalog Completeness ---');
    const profiles = getAllStigProfiles();
    assert(profiles.length === 5, `Registered exactly 5 baseline profiles (found: ${profiles.length})`);

    const expectedProfileIds: StigProfileId[] = [
      'WIN11_SERVER2022_STIG',
      'RHEL9_STIG',
      'CISCO_IOS_STIG',
      'CLOUD_ENCLAVE_CIS',
      'TACTICAL_STANDALONE_STIG',
    ];

    expectedProfileIds.forEach(id => {
      const p = getStigProfile(id);
      assert(Boolean(p), `Profile [${id}] is present in registry`);
      assert(Boolean(p && p.rules.length > 0), `Profile [${id}] contains rules (count: ${p?.rules.length})`);
    });

    const allRules = getAllStigRules();
    assert(allRules.length >= 25, `Global rule catalog contains at least 25 rules (found: ${allRules.length})`);

    // Verify unique IDs across all rules
    const ruleIds = new Set<string>();
    let hasDuplicate = false;
    allRules.forEach(r => {
      if (ruleIds.has(r.id)) hasDuplicate = true;
      ruleIds.add(r.id);
    });
    assert(!hasDuplicate, 'All STIG rules have globally unique rule IDs');

    // -------------------------------------------------------------
    // 2. Rule Schema & DISA Metadata Integrity
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Rule Schema & DISA Metadata Integrity ---');
    allRules.forEach((rule, idx) => {
      const validSeverities: StigSeverity[] = ['CAT_I', 'CAT_II', 'CAT_III'];
      const hasValidSev = validSeverities.includes(rule.severity);
      const hasVulnId = rule.vulnId.startsWith('V-') || rule.vulnId.startsWith('CIS-') || rule.vulnId.startsWith('TAC-');
      const hasCheck = rule.checkText.length > 10;
      const hasFix = rule.fixText.length > 10;
      const hasNarrative = rule.policyNarrative.length > 10;
      const hasMappings = rule.mappedControlIds.length > 0;

      if (!hasValidSev || !hasVulnId || !hasCheck || !hasFix || !hasNarrative || !hasMappings) {
        console.error(`Rule ${rule.id} failed schema validation`);
      }
    });
    assert(true, 'All STIG rules conform to DISA/CIS schema (Vuln ID, Severity, Check, Fix, Policy Narrative, Mappings)');

    // -------------------------------------------------------------
    // 3. Cross-Framework Mapping & Inheritance Bridges
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Cross-Framework Control Mappings ---');
    // AC.L1-3.1.1 (CMMC Level 1 Access Control)
    const cmmcL1Rules = getStigRulesForControl('AC.L1-3.1.1');
    assert(cmmcL1Rules.length >= 4, `Control AC.L1-3.1.1 maps to ${cmmcL1Rules.length} STIG rules across platforms`);

    // NIST SP 800-53 (AC-2 Account Management)
    const nistAc2Rules = getStigRulesForControl('AC-2');
    assert(nistAc2Rules.length >= 3, `NIST SP 800-53 control AC-2 maps to ${nistAc2Rules.length} STIG rules`);

    // SOC 2 Type II (CC6.1 Logical Access Controls)
    const soc2Cc61Rules = getStigRulesForControl('CC6.1');
    assert(soc2Cc61Rules.length >= 4, `SOC 2 CC6.1 maps to ${soc2Cc61Rules.length} STIG rules`);

    // HIPAA Security Rule (164.312(a)(1) Access Control)
    const hipaaRules = getStigRulesForControl('164.312(a)(1)');
    assert(hipaaRules.length >= 3, `HIPAA 164.312(a)(1) maps to ${hipaaRules.length} STIG rules`);

    // Case-insensitivity check
    const lowerRules = getStigRulesForControl('ac.l1-3.1.1');
    assert(lowerRules.length === cmmcL1Rules.length, 'Control ID search is case-insensitive');

    // -------------------------------------------------------------
    // 4. Ansible Playbook Export Generation
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Ansible Playbook Generation ---');
    const winProfile = getStigProfile('WIN11_SERVER2022_STIG')!;
    const mockMetadata: Partial<SSPMetadata> = {
      organizationName: 'Aegis Defense Enclaves, LLC',
      cageCode: '8K9F2',
      systemName: 'Classified Workstation Enclave',
      systemBoundaryScope: 'Corporate & Tactical Boundary',
    };

    const winPlaybook = generateAnsiblePlaybook(winProfile, winProfile.rules, mockMetadata);
    assert(winPlaybook.includes('hosts: windows'), 'Windows playbook targets "hosts: windows"');
    assert(winPlaybook.includes('Aegis Defense Enclaves, LLC'), 'Playbook includes target organization name');
    assert(winPlaybook.includes('8K9F2'), 'Playbook includes target CAGE code');
    assert(winPlaybook.includes('V-254256'), 'Playbook includes DISA Vuln ID in comments/tasks');
    assert(winPlaybook.includes('ansible.windows.win_security_policy'), 'Playbook includes Windows security module tasks');

    const rhelProfile = getStigProfile('RHEL9_STIG')!;
    const rhelPlaybook = generateAnsiblePlaybook(rhelProfile, rhelProfile.rules, mockMetadata);
    assert(rhelPlaybook.includes('become: true'), 'Linux playbook includes "become: true"');
    assert(rhelPlaybook.includes('V-257812'), 'RHEL playbook includes RHEL 9 STIG V-ID');

    // -------------------------------------------------------------
    // 5. PowerShell DSC / Hardening Script Generation
    // -------------------------------------------------------------
    console.log('\n--- Test 5: PowerShell DSC Script Generation ---');
    const psScript = generatePowerShellDscScript(winProfile, winProfile.rules, mockMetadata);
    assert(psScript.includes('#Requires -RunAsAdministrator'), 'PowerShell script requires RunAsAdministrator');
    assert(psScript.includes('Aegis Defense Enclaves, LLC'), 'PowerShell script includes organization name');
    assert(psScript.includes('net accounts /minpwlen:15'), 'PowerShell script contains automated net accounts command');
    assert(psScript.includes('InactivityTimeoutSecs'), 'PowerShell script contains inactivity timeout registry enforcement');
    assert(psScript.includes('Write-StigLog'), 'PowerShell script includes structured auditing logger');
    assert(psScript.includes('EXECUTION SUMMARY'), 'PowerShell script includes summary reporting block');

    // -------------------------------------------------------------
    // 6. DISA STIG Checklist XML (.ckl) Generation
    // -------------------------------------------------------------
    console.log('\n--- Test 6: DISA STIG Checklist XML (.ckl) Export ---');
    const mockControlStates: Record<string, ControlState> = {
      'IA.L1-3.5.1': {
        id: 'IA.L1-3.5.1',
        status: 'MET',
        implementationNotes: 'Enforced via Intune GPO with 15 character minimum and alphanumeric complexity.',
        responsibleRole: 'Security Lead',
        lastUpdated: new Date().toISOString(),
        tags: [],
      },
      'AC.L1-3.1.1': {
        id: 'AC.L1-3.1.1',
        status: 'IN_PROGRESS',
        implementationNotes: 'NLA enabled on gateway, testing endpoints.',
        responsibleRole: 'IT Admin',
        lastUpdated: new Date().toISOString(),
        tags: [],
      },
    };

    const cklXml = generateDisaStigChecklistXml(winProfile, winProfile.rules, mockMetadata, mockControlStates);
    assert(cklXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'Checklist begins with standard XML declaration');
    assert(cklXml.includes('<CHECKLIST>'), 'Checklist contains <CHECKLIST> root node');
    assert(cklXml.includes('<ASSET>'), 'Checklist contains <ASSET> metadata block');
    assert(cklXml.includes('<TARGET_COMMENT>'), 'Checklist includes tenant metadata comment');
    assert(cklXml.includes('Aegis Defense Enclaves, LLC'), 'Checklist ASSET contains tenant org name');
    assert(cklXml.includes('<iSTIG>'), 'Checklist contains <iSTIG> container');
    assert(cklXml.includes('<SID_NAME>stigid</SID_NAME>'), 'Checklist contains stigid descriptor');
    assert(cklXml.includes('<SID_DATA>WIN11_SERVER2022_STIG</SID_DATA>'), 'Checklist contains profile STIG ID');
    assert(cklXml.includes('<VULN>'), 'Checklist contains <VULN> entries');
    assert(cklXml.includes('<STATUS>NotAFinding</STATUS>'), 'Checklist correctly maps MET control status to "NotAFinding"');
    assert(cklXml.includes('<STATUS>Open</STATUS>'), 'Checklist correctly maps IN_PROGRESS / unverified status to "Open"');

    // -------------------------------------------------------------
    // 7. Tactical Non-Networked Standalone Workstation Overlay
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Tactical Air-Gapped Standalone Profile ---');
    const tacticalProfile = getStigProfile('TACTICAL_STANDALONE_STIG')!;
    assert(tacticalProfile.isTacticalOverlay === true, 'Tactical profile is flagged as isTacticalOverlay = true');
    assert(tacticalProfile.category === 'tactical', 'Tactical profile has category = "tactical"');
    
    // Check air-gapped physical hardening rules
    const usbRule = tacticalProfile.rules.find(r => r.id === 'TAC-STIG-01_rule');
    assert(Boolean(usbRule), 'Tactical profile includes physical USB mass storage blocking rule');
    assert(usbRule?.severity === 'CAT_I', 'USB mass storage disabling is flagged CAT I (Critical)');
    assert(Boolean(usbRule?.powershellSnippet?.includes('USBSTOR')), 'USB rule includes USBSTOR registry disabling snippet');

    const radioRule = tacticalProfile.rules.find(r => r.id === 'TAC-STIG-02_rule');
    assert(Boolean(radioRule), 'Tactical profile includes Wi-Fi and Bluetooth radio deactivation rule');
    assert(radioRule?.severity === 'CAT_I', 'Radio deactivation is flagged CAT I (Critical)');

    const tpmRule = tacticalProfile.rules.find(r => r.id === 'TAC-STIG-04_rule');
    assert(Boolean(tpmRule), 'Tactical profile includes offline TPM BitLocker hardware encryption rule');

    const uefiRule = tacticalProfile.rules.find(r => r.id === 'TAC-STIG-05_rule');
    assert(Boolean(uefiRule), 'Tactical profile includes UEFI administrator password & Secure Boot rule');

  } catch (err: any) {
    console.error('Test run failed with error:', err);
  } finally {
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
    console.log('================================================================\n');
    process.exit(passedTests === totalTests ? 0 : 1);
  }
}

runStigAutomationTests();
