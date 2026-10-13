import { StarterTemplate } from './cmmc';

export type ComplianceFramework =
  | 'CMMC_L1'
  | 'CMMC_L2'
  | 'NIST_800_53_REV5'
  | 'nist-800-53-r5'
  | 'SOC_2_TYPE_II'
  | 'HIPAA_SECURITY';

export type ControlKind = 'BASE' | 'ENHANCEMENT';

export interface ControlBaselines {
  low: boolean;
  moderate: boolean;
  high: boolean;
  privacy: boolean;
}

export type ImpactLevel = 'LOW' | 'MODERATE' | 'HIGH';
export type BaselineImpactFilter = 'ALL' | 'LOW' | 'MODERATE' | 'HIGH';

export interface CiaTriadSelection {
  confidentiality: ImpactLevel;
  integrity: ImpactLevel;
  availability: ImpactLevel;
  isAllControlsApplied?: boolean;
}

export type BaselineTier = 'LOW_LOW_LOW' | 'MOD_MOD_MOD' | 'LOW_LOW_MOD' | 'HIGH_HIGH_HIGH' | 'ALL_CONTROLS';

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

/**
 * An organization-defined parameter (ODP) of a control: a blank the organisation must fill in before the control can be
 * assessed ("review accounts [Assignment: organization-defined frequency]"), or a choice it must make
 * ("[Selection (one or more): change password; ...]"). NIST SP 800-53 writes these as bracketed tags in the control text.
 */
export interface ControlParameter {
  /** Stable within its source: "<controlId>#1" for a tag in the control statement, the registry id for an objective ODP. */
  id: string;
  kind: 'ASSIGNMENT' | 'SELECTION';
  /** Short name for the parameter. */
  label: string;
  /** What has to be decided, e.g. "organization-defined frequency". */
  prompt: string;
  /** SELECTION only: the options. */
  choices?: string[];
  /** SELECTION only: pick exactly one, or one or more. */
  selectionMode?: 'ONE' | 'ONE_OR_MORE';
  /**
   * Where it was found. STATEMENT: a tag in the control's official text. OBJECTIVE: an ODP defined on an assessment
   * objective (the platform's own parameter registry). NOTES: a tag in the narrative a person wrote or pasted.
   */
  source: 'STATEMENT' | 'OBJECTIVE' | 'NOTES';
  /** The text of the whole tag and its character range in the text it was found in (STATEMENT and NOTES). */
  raw?: string;
  start?: number;
  end?: number;
  /** A baseline value suggested by the catalog (OBJECTIVE ODPs). */
  defaultValue?: string;
}

export interface FrameworkControlDefinition {
  id: string; // e.g. "AC.L1-3.1.1", "AC-2", "CC6.1", "164.312(a)(1)"
  title: string;
  /**
   * The control's official statement WITH its [Assignment: ...] and [Selection: ...] tags, when the catalog carries it. The
   * catalogs shipped today hold paraphrased text without tags; a catalog that supplies the statement gets its parameters
   * extracted automatically (see data/frameworks/parameters.ts).
   */
  statement?: string;
  /** The parameters in `statement`, filled in by attachParameters() (optional cache: resolveParameters() computes them if absent). */
  parameters?: ControlParameter[];
  framework: ComplianceFramework;
  domain: string; // Domain or Family code (e.g., 'AC', 'CC6', 'TECH')
  domainName: string;
  farReference?: string; // legacy CMMC L1 field name, mirrors authorityReference
  authorityReference: string; // e.g., "FAR 52.204-21(b)(1)(i)", "NIST SP 800-53 Rev 5 AC-2", "AICPA TSC CC6.1"
  plainEnglishSummary: string;
  discussion: string;
  assessmentObjectives: string[];
  auditorChecklist: string[];
  starterTemplates?: StarterTemplate[];
  baselineTiers?: BaselineTier[];
  baselineImpact?: 'LOW' | 'MODERATE' | 'HIGH'; // lowest NIST SP 800-53B baseline that includes the control
  /** NIST SP 800-53 only. A base control (AC-2) or a control enhancement (AC-2(1)). */
  controlKind?: ControlKind;
  /** NIST SP 800-53 enhancements only: the base control it enhances ("AC-2"). */
  parentControlId?: string;
  /** NIST SP 800-53 only: the SP 800-53B baselines (Low, Moderate, High, Privacy) that include the control. */
  baselines?: ControlBaselines;
  /** NIST SP 800-53 only: controls NIST lists as related to this one. */
  relatedControls?: string[];
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

/** Shape returned by `GET /api/v1/controls/frameworks` (registry metadata without the domain/control tables). */
export type FrameworkSummary = Pick<
  FrameworkDefinition,
  | 'id'
  | 'name'
  | 'shortName'
  | 'version'
  | 'authority'
  | 'description'
  | 'totalControls'
  | 'defaultBaseline'
  | 'supportedBaselines'
  | 'supportsNonNetworkedOverlay'
> & { domainCount: number };
