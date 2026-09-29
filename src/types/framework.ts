import { StarterTemplate } from './cmmc';

export type ComplianceFramework =
  | 'CMMC_L1'
  | 'CMMC_L2'
  | 'NIST_800_53_REV5'
  | 'nist-800-53-r5'
  | 'SOC_2_TYPE_II'
  | 'HIPAA_SECURITY';

export type ImpactLevel = 'LOW' | 'MODERATE' | 'HIGH';
export type BaselineImpactFilter = 'ALL' | 'LOW' | 'MODERATE' | 'HIGH';

export interface CiaTriadSelection {
  confidentiality: ImpactLevel;
  integrity: ImpactLevel;
  availability: ImpactLevel;
  isAllControlsApplied?: boolean;
}

export type BaselineTier = 'LOW_LOW_LOW' | 'MOD_MOD_MOD' | 'LOW_LOW_MOD' | 'ALL_CONTROLS';

export type OverlayParameter = 'NONE' | 'NON_NETWORKED';

export type MappingType = 'EXACT' | 'EQUIVALENT' | 'SUBSET' | 'SUPERSET';

export interface ControlMapping {
  id: string;
  sourceFramework: ComplianceFramework;
  sourceControlId: string;
  targetFramework: ComplianceFramework;
  targetControlId: string;
  mappingType: MappingType;
  notes?: string;
}

export interface FrameworkDomainInfo {
  code: string;
  name: string;
  description: string;
  totalControls: number;
  iconName: string;
  color: string;
}

export interface FrameworkControlDefinition {
  id: string; // e.g. "AC.L1-3.1.1", "AC-2", "CC6.1", "164.312(a)(1)"
  title: string;
  framework: ComplianceFramework;
  domain: string; // Domain or Family code (e.g., 'AC', 'CC6', 'TECH')
  domainName: string;
  authorityReference: string; // e.g., "FAR 52.204-21(b)(1)(i)", "NIST SP 800-53 Rev 5 AC-2", "AICPA TSC CC6.1"
  plainEnglishSummary: string;
  discussion: string;
  assessmentObjectives: string[];
  auditorChecklist: string[];
  starterTemplates?: StarterTemplate[];
  baselineTiers?: BaselineTier[];
  baselineImpact?: 'LOW' | 'MODERATE' | 'HIGH'; // NIST SP 800-53B baseline allocation (LOW, MODERATE, HIGH)
  nonNetworkedApplicable: boolean; // false for network/boundary specific controls (SC-7, AC-17, etc.)
  requiresWireless?: boolean; // true for wireless-specific controls (AC-18, etc.)
  requiresMobile?: boolean; // true for mobile device controls (AC-19, MP-7, etc.)
  requiresPii?: boolean; // true for PII/privacy controls (PT family, etc.)
  ciaImpact?: {
    confidentiality?: ImpactLevel;
    integrity?: ImpactLevel;
    availability?: ImpactLevel;
  };
  mappings?: {
    targetFramework: ComplianceFramework;
    targetControlId: string;
    targetTitle?: string;
    mappingType?: MappingType;
  }[];
}

export interface FrameworkDefinition {
  id: ComplianceFramework;
  name: string;
  shortName: string;
  version: string;
  authority: string;
  description: string;
  totalControls: number;
  defaultBaseline?: BaselineTier;
  supportedBaselines?: {
    id: BaselineTier;
    label: string;
    description: string;
  }[];
  supportsNonNetworkedOverlay: boolean;
  domains: Record<string, FrameworkDomainInfo>;
}

export interface OverlayFilters {
  nonNetworkedOnly: boolean; // Stand-alone / Air-gapped (excludes SC-7, AC-17, etc.)
  noWireless?: boolean; // No wireless capabilities (excludes AC-18, etc.)
  noMobileDevices?: boolean; // No mobile devices (excludes AC-19, etc.)
  noPiiProcessing?: boolean; // No PII processing (excludes PT family, privacy notices)
}
