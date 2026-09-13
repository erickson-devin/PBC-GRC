/**
 * DISA STIG & Technical Baseline Type Definitions
 * Event Horizon GRC (PBC-GRC)
 */

export type StigSeverity = 'CAT_I' | 'CAT_II' | 'CAT_III';

export type StigProfileId =
  | 'WIN11_SERVER2022_STIG'
  | 'RHEL9_STIG'
  | 'CISCO_IOS_STIG'
  | 'CLOUD_ENCLAVE_CIS'
  | 'TACTICAL_STANDALONE_STIG';

export interface StigRule {
  id: string; // e.g. "SV-254256r917887_rule"
  vulnId: string; // e.g. "V-254256"
  ruleVersion: string; // e.g. "WN11-00-000010"
  title: string;
  severity: StigSeverity;
  benchmarkId: StigProfileId;
  benchmarkTitle: string;
  discussion: string;
  checkText: string;
  fixText: string;
  powershellSnippet?: string;
  bashSnippet?: string;
  ansibleTaskSnippet?: string;
  mappedControlIds: string[]; // e.g. ['AC.L1-3.1.1', 'AC.L2-3.1.1', 'AC-2', 'CC6.1', '164.312(a)(1)']
  policyNarrative: string; // Official implementation narrative for control compliance
  verificationSteps: string[];
}

export interface StigProfile {
  id: StigProfileId;
  title: string;
  shortName: string;
  version: string;
  releaseDate: string;
  targetPlatform: string;
  category: 'os' | 'infrastructure' | 'cloud' | 'tactical';
  description: string;
  authority: string; // e.g., "DISA", "CIS", "DoD Cyber Exchange"
  rules: StigRule[];
  isTacticalOverlay?: boolean;
}

export interface StigExportOptions {
  profileId: StigProfileId;
  includeAnsible: boolean;
  includePowerShell: boolean;
  includeCkl: boolean;
  filterBySeverity?: StigSeverity | 'ALL';
  selectedRuleIds?: string[];
}
