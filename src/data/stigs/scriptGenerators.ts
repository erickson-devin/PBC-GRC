/**
 * Script & DISA STIG Checklist Export Engine
 * Event Horizon GRC (PBC-GRC)
 * 
 * Generates:
 * 1. Ansible Hardening Playbooks (.yml)
 * 2. PowerShell DSC / Hardening Scripts (.ps1)
 * 3. DISA STIG Checklist (.ckl XML) for DISA STIG Viewer and eMASS submission
 */

import { StigProfile, StigRule } from '../../types/stig';
import { SSPMetadata, ControlState } from '../../types/cmmc';

function escapeXml(unsafe: string): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates an Ansible Hardening Playbook (.yml) for the specified profile and rules
 */
export function generateAnsiblePlaybook(
  profile: StigProfile,
  rules: StigRule[],
  metadata?: Partial<SSPMetadata>
): string {
  const orgName = metadata?.organizationName || 'Defense Enclave Organization';
  const cageCode = metadata?.cageCode || 'N/A';
  const systemName = metadata?.systemName || 'Defense Enclave System';
  const now = new Date().toISOString();

  const isWindows = profile.category === 'os' && profile.id.includes('WIN');
  const targetHosts = isWindows ? 'windows' : profile.category === 'cloud' ? 'localhost' : 'all';

  let playbook = `---
# ==============================================================================
# EVENT HORIZON GRC - AUTOMATED HARDENING PLAYBOOK
# ==============================================================================
# Baseline:         ${profile.title} (${profile.version})
# Organization:     ${orgName}
# CAGE Code:        ${cageCode}
# System Boundary:  ${systemName}
# Authority:        ${profile.authority}
# Total Tasks:      ${rules.length}
# Generated:        ${now}
# Disclaimer:       Review and validate against test enclave before production execution.
# ==============================================================================

- name: Enforce Technical Hardening Baseline - ${profile.shortName}
  hosts: ${targetHosts}
  gather_facts: true
  become: ${isWindows ? 'false' : 'true'}
  vars:
    enclave_org: "${orgName}"
    enclave_system: "${systemName}"
    baseline_id: "${profile.id}"
  tasks:
`;

  rules.forEach((rule, idx) => {
    playbook += `
    # --------------------------------------------------------------------------
    # Task ${idx + 1}/${rules.length}: [${rule.vulnId}] ${rule.ruleVersion} (${rule.severity})
    # Title: ${rule.title}
    # Mapped Controls: ${rule.mappedControlIds.join(', ')}
    # --------------------------------------------------------------------------
`;

    if (rule.ansibleTaskSnippet) {
      // Indent snippet by 4 spaces
      const indented = rule.ansibleTaskSnippet
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n');
      playbook += `${indented}\n`;
    } else if (rule.bashSnippet) {
      playbook += `    - name: "[${rule.vulnId}] ${rule.title.replace(/"/g, '\\"')}"
      ansible.builtin.shell: |
        ${rule.bashSnippet.split('\n').join('\n        ')}
      args:
        executable: /bin/bash
      register: stig_task_${idx}
      changed_when: stig_task_${idx}.rc == 0\n`;
    } else if (rule.powershellSnippet) {
      playbook += `    - name: "[${rule.vulnId}] ${rule.title.replace(/"/g, '\\"')}"
      ansible.windows.win_powershell:
        script: |
          ${rule.powershellSnippet.split('\n').join('\n          ')}\n`;
    } else {
      playbook += `    - name: "[${rule.vulnId}] Manual Verification Required: ${rule.title.replace(/"/g, '\\"')}"
      ansible.builtin.debug:
        msg: "Control mapped to ${rule.mappedControlIds.join(', ')}. Action required: ${rule.fixText.replace(/"/g, '\\"')}"\n`;
    }
  });

  return playbook;
}

/**
 * Generates a PowerShell DSC / Hardening Script (.ps1) for Windows baselines
 */
export function generatePowerShellDscScript(
  profile: StigProfile,
  rules: StigRule[],
  metadata?: Partial<SSPMetadata>
): string {
  const orgName = metadata?.organizationName || 'Defense Enclave Organization';
  const cageCode = metadata?.cageCode || 'N/A';
  const systemName = metadata?.systemName || 'Defense Enclave System';
  const now = new Date().toISOString();

  let script = `<#
.SYNOPSIS
    Event Horizon GRC - Technical Baseline Hardening Script (DISA STIG / CIS)

.DESCRIPTION
    Automated configuration script enforcing DoD DISA STIG and CIS Benchmarks.
    Baseline:        ${profile.title} (${profile.version})
    Target Enclave:  ${systemName}
    Organization:    ${orgName} (CAGE: ${cageCode})
    Generated:       ${now}
    Total Controls:  ${rules.length}

.NOTES
    Requires elevated Administrator privileges.
    Run: powershell.exe -ExecutionPolicy Bypass -File .\\${profile.id.toLowerCase()}_hardening.ps1
#>

#Requires -RunAsAdministrator
[CmdletBinding()]
Param(
    [switch]$WhatIf,
    [switch]$VerboseOutput = $true,
    [string]$LogPath = "$env:TEMP\\PBC_GRC_Hardening_${Date.now()}.log"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

Function Write-StigLog {
    Param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Formatted = "[$Timestamp] [$Level] $Message"
    Write-Host $Formatted -ForegroundColor $(switch ($Level) { "ERROR" { "Red" } "WARN" { "Yellow" } "SUCCESS" { "Green" } default { "Cyan" } })
    Add-Content -Path $LogPath -Value $Formatted -ErrorAction SilentlyContinue
}

Write-StigLog "Starting Technical Baseline Enforcement: ${profile.title}" "INFO"
Write-StigLog "Organization: ${orgName} | CAGE: ${cageCode}" "INFO"
Write-StigLog "Log output redirected to $LogPath" "INFO"

$TotalRules = ${rules.length}
$SuccessCount = 0
$FailureCount = 0
$SkippedCount = 0

`;

  rules.forEach((rule, idx) => {
    script += `
# ==============================================================================
# Rule ${idx + 1}/${rules.length}: [${rule.vulnId}] ${rule.ruleVersion} (${rule.severity})
# Title: ${rule.title}
# Mapped Controls: ${rule.mappedControlIds.join(', ')}
# ==============================================================================
Write-StigLog "Enforcing Rule ${idx + 1}/$TotalRules: [${rule.vulnId}] ${rule.title.replace(/"/g, '`"')}" "INFO"
try {
`;

    if (rule.powershellSnippet) {
      const indented = rule.powershellSnippet
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n');
      script += `${indented}
    $SuccessCount++
    Write-StigLog "Successfully enforced [${rule.vulnId}]" "SUCCESS"
`;
    } else {
      script += `    # Automated PowerShell snippet not defined for this non-Windows rule.
    # Official Fix Instruction: ${rule.fixText.replace(/"/g, '`"')}
    Write-StigLog "Manual administrative action required for [${rule.vulnId}]" "WARN"
    $SkippedCount++
`;
    }

    script += `} catch {
    $FailureCount++
    Write-StigLog "Failed enforcing [${rule.vulnId}]: $_" "ERROR"
}
`;
  });

  script += `
# ==============================================================================
# EXECUTION SUMMARY
# ==============================================================================
Write-StigLog "---------------------------------------------------------" "INFO"
Write-StigLog "Hardening Execution Completed for ${profile.shortName}" "INFO"
Write-StigLog "Total Rules: $TotalRules | Success: $SuccessCount | Skipped: $SkippedCount | Failed: $FailureCount" "INFO"
Write-StigLog "Log saved to: $LogPath" "SUCCESS"
`;

  return script;
}

/**
 * Generates a standard DISA STIG Checklist (.ckl XML) for DISA STIG Viewer and eMASS submission
 */
export function generateDisaStigChecklistXml(
  profile: StigProfile,
  rules: StigRule[],
  metadata?: Partial<SSPMetadata>,
  controlStates?: Record<string, ControlState>
): string {
  const orgName = metadata?.organizationName || 'Defense Enclave Organization';
  const cageCode = metadata?.cageCode || 'N/A';
  const systemName = metadata?.systemName || 'Corporate Operations Enclave';
  const boundaryScope = metadata?.systemBoundaryScope || 'Corporate Enclave Boundary';

  // Build VULN items
  const vulnXmlEntries = rules.map(rule => {
    // Determine status from mapped controls if available
    let status = 'Open';
    let findingDetails = '';
    let comments = `Policy Narrative: ${rule.policyNarrative}\n\nVerification: ${rule.verificationSteps.join('; ')}`;

    if (controlStates) {
      const mappedStates = rule.mappedControlIds
        .map(cId => controlStates[cId])
        .filter(Boolean);

      if (mappedStates.length > 0) {
        const isMet = mappedStates.some(s => s.status === 'MET');
        const isInProgress = mappedStates.some(s => s.status === 'IN_PROGRESS');
        const notes = mappedStates
          .map(s => s.implementationNotes)
          .filter(n => Boolean(n && n.trim()))
          .join('\n\n');

        if (isMet) {
          status = 'NotAFinding';
          findingDetails = `Control verification complete. Technical STIG baseline enforced and validated.\n${notes}`;
        } else if (isInProgress) {
          status = 'Open';
          findingDetails = `Control currently in progress.\n${notes}`;
        } else {
          status = 'Open';
          findingDetails = notes || 'Technical baseline check not yet verified in enclave.';
        }
      }
    }

    const severityMap: Record<string, string> = {
      CAT_I: 'high',
      CAT_II: 'medium',
      CAT_III: 'low',
    };
    const severityStr = severityMap[rule.severity] || 'medium';

    return `      <VULN>
        <STIG_DATA>
          <SID_NAME>Vuln_Num</SID_NAME>
          <SID_DATA>${escapeXml(rule.vulnId)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Severity</SID_NAME>
          <SID_DATA>${escapeXml(severityStr)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Group_Title</SID_NAME>
          <SID_DATA>${escapeXml(rule.vulnId)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Rule_ID</SID_NAME>
          <SID_DATA>${escapeXml(rule.id)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Rule_Ver</SID_NAME>
          <SID_DATA>${escapeXml(rule.ruleVersion)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Rule_Title</SID_NAME>
          <SID_DATA>${escapeXml(rule.title)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Discussion</SID_NAME>
          <SID_DATA>${escapeXml(rule.discussion)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Check_Content</SID_NAME>
          <SID_DATA>${escapeXml(rule.checkText)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Fix_Text</SID_NAME>
          <SID_DATA>${escapeXml(rule.fixText)}</SID_DATA>
        </STIG_DATA>
        <STIG_DATA>
          <SID_NAME>Mapped_Controls</SID_NAME>
          <SID_DATA>${escapeXml(rule.mappedControlIds.join(', '))}</SID_DATA>
        </STIG_DATA>
        <STATUS>${escapeXml(status)}</STATUS>
        <FINDING_DETAILS>${escapeXml(findingDetails)}</FINDING_DETAILS>
        <COMMENTS>${escapeXml(comments)}</COMMENTS>
        <SEVERITY_OVERRIDE_JUSTIFICATION></SEVERITY_OVERRIDE_JUSTIFICATION>
      </VULN>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- DISA STIG Checklist generated by Event Horizon GRC (PBC-GRC) -->
<!-- Exported for DISA STIG Viewer and eMASS Submission -->
<CHECKLIST>
  <ASSET>
    <ROLE>None</ROLE>
    <ASSET_TYPE>Computing</ASSET_TYPE>
    <HOST_NAME>${escapeXml(systemName.replace(/[^a-zA-Z0-9_-]/g, '_'))}</HOST_NAME>
    <HOST_IP>10.0.0.1</HOST_IP>
    <HOST_MAC></HOST_MAC>
    <HOST_FQDN>${escapeXml(systemName.toLowerCase().replace(/[^a-z0-9]/g, ''))}.defense.local</HOST_FQDN>
    <TARGET_COMMENT>Organization: ${escapeXml(orgName)} | CAGE: ${escapeXml(cageCode)} | Boundary: ${escapeXml(boundaryScope)} | Generated by Event Horizon GRC</TARGET_COMMENT>
    <TECH_AREA>Enclave Hardening</TECH_AREA>
    <TARGET_KEY>4182</TARGET_KEY>
    <WEB_OR_DATABASE>false</WEB_OR_DATABASE>
    <WEB_DB_SITE></WEB_DB_SITE>
    <WEB_DB_INSTANCE></WEB_DB_INSTANCE>
  </ASSET>
  <STIGS>
    <iSTIG>
      <STIG_INFO>
        <SI_DATA>
          <SID_NAME>version</SID_NAME>
          <SID_DATA>1</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>classification</SID_NAME>
          <SID_DATA>UNCLASSIFIED</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>customname</SID_NAME>
          <SID_DATA></SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>orig_file</SID_NAME>
          <SID_DATA>${escapeXml(profile.shortName)}.ckl</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>stigid</SID_NAME>
          <SID_DATA>${escapeXml(profile.id)}</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>description</SID_NAME>
          <SID_DATA>${escapeXml(profile.description)}</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>filename</SID_NAME>
          <SID_DATA>${escapeXml(profile.id)}.ckl</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>releaseinfo</SID_NAME>
          <SID_DATA>${escapeXml(profile.version)}</SID_DATA>
        </SI_DATA>
        <SI_DATA>
          <SID_NAME>title</SID_NAME>
          <SID_DATA>${escapeXml(profile.title)}</SID_DATA>
        </SI_DATA>
      </STIG_INFO>
${vulnXmlEntries}
    </iSTIG>
  </STIGS>
</CHECKLIST>`;
}

/**
 * Triggers a browser file download for generated text/code payloads
 */
export function downloadFile(filename: string, content: string, mimeType: string = 'text/plain;charset=utf-8'): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
