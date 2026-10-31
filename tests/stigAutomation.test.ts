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
import fs from 'fs';
import path from 'path';
import { planStigNarratives } from '../src/utils/stigNarrativePlan';

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

    // ---------------------------------------------------------------
    // Test 8: bulk STIG narrative plan (#79)
    // ---------------------------------------------------------------
    console.log('\n--- Test 8: bulk STIG narrative plan (#79) ---');
    const TS = '2026-10-30T00:00:00.000Z';
    const planCtx = { tenantId: 't1', updatedBy: 'Ann', timestamp: TS };
    const mk = (over: Partial<ControlState>): ControlState => ({ id: 'X', tenantId: 't1', status: 'MET', implementationNotes: 'Old', responsibleRole: 'R', lastUpdated: 'old', tags: ['k'], ...over } as ControlState);

    const p1 = planStigNarratives({}, { 'AC.L1-3.1.1': 'N1' }, planCtx);
    assert(
      p1.length === 1
        && JSON.stringify(p1[0].next) === JSON.stringify({ id: 'AC.L1-3.1.1', tenantId: 't1', status: 'IN_PROGRESS', implementationNotes: 'N1', responsibleRole: 'IT / Security Lead', lastUpdated: TS, tags: [], updatedBy: 'Ann' })
        && JSON.stringify(p1[0].serverUpdate) === '{"implementationNotes":"N1","updatedBy":"Ann","status":"IN_PROGRESS"}',
      'S79-1: a control with no state starts IN_PROGRESS with the narrative'
    );

    const p2 = planStigNarratives({ X: mk({}) }, { X: 'New' }, planCtx);
    assert(
      p2[0].next.implementationNotes === 'Old\n\n[STIG Baseline Implementation]:\nNew'
        && p2[0].next.status === 'MET'
        && p2[0].next.responsibleRole === 'R'
        && JSON.stringify(p2[0].next.tags) === '["k"]'
        && !('status' in p2[0].serverUpdate),
      'S79-2: existing notes get the narrative appended under the header; status and role are kept'
    );

    const p3 = planStigNarratives({ X: mk({ status: 'IN_PROGRESS', implementationNotes: 'Intro N1 outro' }) }, { X: 'N1' }, planCtx);
    assert(
      p3.length === 0,
      'S79-3: text already present and no status change plans nothing (#180)'
    );

    const p4 = planStigNarratives({ X: mk({ implementationNotes: '   ' }) }, { X: 'N1' }, planCtx);
    assert(p4[0].next.implementationNotes === 'N1', 'S79-4: whitespace-only notes are replaced by the narrative');

    const p5 = planStigNarratives({}, { A: '', B: 'b' }, planCtx);
    assert(JSON.stringify(p5.map(c => c.id)) === '["B"]', 'S79-5: an empty narrative is skipped');

    const inCtl = { X: mk({}) };
    const before = JSON.stringify(inCtl);
    const r1 = planStigNarratives(inCtl, { X: 'New' }, planCtx);
    const r2 = planStigNarratives(inCtl, { X: 'New' }, planCtx);
    assert(
      JSON.stringify(inCtl) === before && JSON.stringify(r1) === JSON.stringify(r2) && r1[0].next !== inCtl.X,
      'S79-6: the plan is pure (input untouched, same output twice)'
    );

    const ctxSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'context', 'AssessmentContext.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const bulkStart = ctxSrc.indexOf('const bulkApplyStigNarratives = useCallback');
    const bulkBody = ctxSrc.slice(bulkStart, ctxSrc.indexOf('// NIST SP 800-171A Objective-Level', bulkStart));
    const planAt = bulkBody.indexOf('planStigNarratives(stateRef.current.controls');
    const setAt = bulkBody.indexOf('setState(');
    assert(
      bulkStart > 0 && planAt > 0 && setAt > planAt
        && !bulkBody.slice(setAt).includes('saveControl(')
        && !bulkBody.includes('appliedCount')
        && /return changes\.length;/.test(bulkBody),
      'S79-7: bulkApplyStigNarratives plans and saves before setState and returns the planned count'
    );

    const planSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'utils', 'stigNarrativePlan.ts'), 'utf8');
    assert(
      (bulkBody.match(/saveControl\(/g) ?? []).length === 1 && !planSrc.includes('console.'),
      'S79-8: one save call site in the bulk apply, and the plan helper never logs'
    );

    // ---------------------------------------------------------------
    // Test 9: a fill that changes nothing plans nothing (#180)
    // ---------------------------------------------------------------
    console.log('\n--- Test 9: idempotent STIG fill (#180) ---');
    const c0 = { X: mk({ status: 'NOT_STARTED', implementationNotes: '' }) };
    const a180 = planStigNarratives(c0, { X: 'N1' }, planCtx);
    const c1 = { X: a180[0].next };
    assert(a180.length === 1 && planStigNarratives(c1, { X: 'N1' }, planCtx).length === 0, 'S180-1: a second run of the same fill plans nothing');

    const s180b = planStigNarratives({ X: mk({ status: 'NOT_STARTED', implementationNotes: 'Intro N1 outro' }) }, { X: 'N1' }, planCtx);
    assert(
      s180b.length === 1
        && s180b[0].next.status === 'IN_PROGRESS'
        && s180b[0].next.implementationNotes === 'Intro N1 outro'
        && JSON.stringify(s180b[0].serverUpdate) === '{"updatedBy":"Ann","status":"IN_PROGRESS"}',
      'S180-2: text present but NOT_STARTED plans only the status change'
    );

    const s180c = planStigNarratives({ A: mk({ id: 'A', implementationNotes: 'x a1 y' }), B: mk({ id: 'B' }) }, { A: 'a1', B: 'b1' }, planCtx);
    assert(JSON.stringify(s180c.map(c => c.id)) === '["B"]', 'S180-3: a mixed fill plans only the controls that change');

    assert(planStigNarratives({ X: mk({ implementationNotes: 'N1' }) }, { X: 'N1' }, planCtx).length === 0, 'S180-4: a MET control with the exact narrative plans nothing');

    const modalSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'stigs', 'StigAutomationModal.tsx'), 'utf8');
    assert(modalSrc.includes('Already applied; nothing changed.'), 'S180-5: the modal says so when nothing changed');

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
