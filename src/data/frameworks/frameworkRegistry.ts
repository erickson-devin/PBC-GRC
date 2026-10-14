import {
  ComplianceFramework,
  BaselineTier,
  OverlayParameter,
  FrameworkDefinition,
  FrameworkControlDefinition,
  FrameworkDomainInfo,
  BaselineImpactFilter,
} from '../../types/framework';
import { CMMC_LEVEL_1_CONTROLS, DOMAINS as CMMC_L1_DOMAINS } from '../cmmcLevel1Controls';
import { CMMC_LEVEL_2_CONTROLS, CMMC_L2_DOMAINS } from './cmmcLevel2Controls';
import { NIST_800_53_CONTROLS, NIST_800_53_DOMAINS } from './nist80053Controls';
import { SOC_2_CONTROLS, SOC_2_DOMAINS } from './soc2Controls';
import { HIPAA_CONTROLS, HIPAA_DOMAINS } from './hipaaControls';
import {
  getCrossFrameworkMappings,
  isEquivalentMapping,
} from './controlMappings';

// Adapt CMMC L1 controls into FrameworkControlDefinition
export const CMMC_L1_FRAMEWORK_CONTROLS: FrameworkControlDefinition[] = CMMC_LEVEL_1_CONTROLS.map(ctrl => {
  const isNetworkBoundary = ctrl.id === 'SC.L1-3.13.1' || ctrl.id === 'SC.L1-3.13.5';
  // "Equivalencies" only: the SP 800-171 -> SP 800-53 crosswalk (SUBSET) is shown by the Crosswalk panel instead.
  const mappings = getCrossFrameworkMappings(ctrl.id).filter(isEquivalentMapping).map(m => ({
    targetFramework: m.targetFramework === 'CMMC_L1' ? m.sourceFramework : m.targetFramework,
    targetControlId: m.targetControlId === ctrl.id ? m.sourceControlId : m.targetControlId,
    targetTitle: m.notes,
    mappingType: m.mappingType,
  }));

  return {
    id: ctrl.id,
    title: ctrl.title,
    framework: 'CMMC_L1',
    domain: ctrl.domain,
    domainName: CMMC_L1_DOMAINS[ctrl.domain]?.name || ctrl.domain,
    authorityReference: ctrl.farReference,
    plainEnglishSummary: ctrl.plainEnglishSummary,
    discussion: ctrl.discussion,
    assessmentObjectives: ctrl.assessmentObjectives,
    auditorChecklist: ctrl.auditorChecklist,
    starterTemplates: ctrl.starterTemplates,
    baselineTiers: ['LOW_LOW_LOW', 'MOD_MOD_MOD', 'LOW_LOW_MOD'],
    baselineImpact: 'LOW',
    nonNetworkedApplicable: !isNetworkBoundary,
    mappings,
  };
});

// Adapt CMMC L1 domains to FrameworkDomainInfo
const adaptedCmmcL1Domains: Record<string, FrameworkDomainInfo> = {};
for (const [code, info] of Object.entries(CMMC_L1_DOMAINS)) {
  adaptedCmmcL1Domains[code] = {
    code: info.code,
    name: info.name,
    description: info.description,
    totalControls: info.totalControls,
    iconName: info.iconName,
    color: info.color,
  };
}

/**
 * Canonical NIST SP 800-53 Rev. 5 Framework Definition
 * Encompassing all 20 control families (AC through SR) per SP 800-53 Rev. 5
 */
const NIST_800_53_DEF: FrameworkDefinition = {
  id: 'NIST_800_53_REV5',
  name: 'NIST SP 800-53 Rev. 5 (Federal RMF)',
  shortName: 'NIST SP 800-53 Rev. 5',
  version: 'Rev 5',
  authority: 'NIST Special Publication 800-53 Rev. 5 / NIST SP 800-53B',
  description: 'Comprehensive security and privacy control catalog for federal information systems and FedRAMP / FISMA authorizations. Covers all ' + Object.keys(NIST_800_53_DOMAINS).length + ' control families across Low, Moderate, and High baselines.',
  totalControls: NIST_800_53_CONTROLS.length,
  defaultBaseline: 'MOD_MOD_MOD',
  supportedBaselines: [
    { id: 'LOW_LOW_LOW', label: 'Low Baseline', description: 'Low confidentiality, integrity, and availability impact (standard low baseline per NIST SP 800-53B).' },
    { id: 'MOD_MOD_MOD', label: 'Moderate Baseline', description: 'Moderate confidentiality, integrity, and availability impact (FedRAMP Moderate standard).' },
    { id: 'LOW_LOW_MOD', label: 'Low-Mod Mixed', description: 'Low confidentiality/integrity with Moderate availability.' },
    { id: 'HIGH_HIGH_HIGH', label: 'High Baseline', description: 'High confidentiality, integrity, and availability impact (SP 800-53B high baseline).' },
    { id: 'ALL_CONTROLS', label: 'Entire Catalog', description: 'Every control and control enhancement in SP 800-53 Rev. 5, including those in no baseline.' },
  ],
  supportsNonNetworkedOverlay: true,
  domains: NIST_800_53_DOMAINS,
};

/**
 * Universal Framework Registry Definitions
 * Supports standard codes and hyphenated aliases (e.g., 'nist-800-53-r5')
 */
export const FRAMEWORK_REGISTRY: Record<string, FrameworkDefinition> = {
  CMMC_L1: {
    id: 'CMMC_L1',
    name: 'CMMC 2.0 Level 1 (Foundational)',
    shortName: 'CMMC Level 1',
    version: '2.0',
    authority: 'FAR 52.204-21',
    description: `${CMMC_LEVEL_1_CONTROLS.length} basic safeguarding requirements across ${Object.keys(adaptedCmmcL1Domains).length} families protecting Federal Contract Information (FCI). Requires 100% compliance with zero allowable POA&Ms.`,
    totalControls: CMMC_LEVEL_1_CONTROLS.length,
    supportsNonNetworkedOverlay: true,
    domains: adaptedCmmcL1Domains,
  },
  CMMC_L2: {
    id: 'CMMC_L2',
    name: 'CMMC 2.0 Level 2 (Advanced)',
    shortName: 'CMMC Level 2',
    version: '2.0',
    authority: 'NIST SP 800-171 Rev 2 / DFARS 252.204-7012',
    description: `${CMMC_LEVEL_2_CONTROLS.length} security requirements across ${Object.keys(CMMC_L2_DOMAINS).length} families safeguarding Controlled Unclassified Information (CUI). Requires DoD SPRS assessment scoring.`,
    totalControls: CMMC_LEVEL_2_CONTROLS.length,
    supportsNonNetworkedOverlay: true,
    domains: CMMC_L2_DOMAINS,
  },
  NIST_800_53_REV5: NIST_800_53_DEF,
  // Registered alias for RMF specification
  'nist-800-53-r5': {
    ...NIST_800_53_DEF,
    id: 'NIST_800_53_REV5',
  },
  SOC_2_TYPE_II: {
    id: 'SOC_2_TYPE_II',
    name: 'AICPA SOC 2 Type II',
    shortName: 'SOC 2 Type II',
    version: 'TSC 2017',
    authority: 'AICPA Trust Services Criteria (TSP Section 100)',
    description: 'Independent attestation evaluating Security (Common Criteria), Availability, and Confidentiality over an operational examination period.',
    totalControls: SOC_2_CONTROLS.length,
    supportsNonNetworkedOverlay: true,
    domains: SOC_2_DOMAINS,
  },
  HIPAA_SECURITY: {
    id: 'HIPAA_SECURITY',
    name: 'HIPAA Security Rule',
    shortName: 'HIPAA Security',
    version: '45 CFR Part 164',
    authority: 'HHS Office for Civil Rights / 45 CFR Part 164 Subpart C',
    description: 'National standards to protect individuals’ electronic personal health information (ePHI) across Administrative, Physical, and Technical safeguards.',
    totalControls: HIPAA_CONTROLS.length,
    supportsNonNetworkedOverlay: true,
    domains: HIPAA_DOMAINS,
  },
};

/**
 * Normalizes framework identifier strings to canonical registry keys
 */
export function normalizeFrameworkId(frameworkId: string): ComplianceFramework {
  const clean = (frameworkId || '').trim();
  if (clean === 'nist-800-53-r5' || clean.toLowerCase() === 'nist-800-53' || clean.toLowerCase() === 'rmf') {
    return 'NIST_800_53_REV5';
  }
  return clean as ComplianceFramework;
}

/**
 * Which SP 800-53B baseline a baseline selector means: 'low' | 'moderate' | 'high', or null for the whole catalog.
 * Accepts the tier ids (LOW_LOW_LOW, MOD_MOD_MOD, ...), the plain impact names, and a CIA triad (the high-water mark decides).
 * LOW_LOW_MOD (low confidentiality and integrity, moderate availability) has no baseline of its own and is read as Moderate.
 */
export function nistBaselineLevel(baseline: unknown): 'low' | 'moderate' | 'high' | null {
  if (typeof baseline === 'string') {
    const b = baseline.trim().toUpperCase();
    if (b === 'LOW' || b === 'LOW BASELINE' || b === 'LOW_LOW_LOW') return 'low';
    if (b === 'MODERATE' || b === 'MODERATE BASELINE' || b === 'MOD_MOD_MOD' || b === 'LOW_LOW_MOD') return 'moderate';
    if (b === 'HIGH' || b === 'HIGH BASELINE' || b === 'HIGH_HIGH_HIGH') return 'high';
    return null;
  }
  if (baseline && typeof baseline === 'object') {
    const t = baseline as { confidentiality?: string; integrity?: string; availability?: string; isAllControlsApplied?: boolean };
    if (t.isAllControlsApplied) return null;
    const impacts = [t.confidentiality, t.integrity, t.availability];
    return impacts.includes('HIGH') ? 'high' : impacts.includes('MODERATE') ? 'moderate' : 'low';
  }
  return null;
}

/**
 * Dynamic Filtered Control Retrieval
 * Filters controls by framework, baseline impact/tier, and operational overlay parameters.
 */
export function getFrameworkControls(
  framework: ComplianceFramework | string = 'CMMC_L1',
  baseline: BaselineTier | BaselineImpactFilter | any = 'ALL_CONTROLS',
  overlay: OverlayParameter | any = 'NONE'
): FrameworkControlDefinition[] {
  const canonicalFramework = normalizeFrameworkId(framework);
  let controls: FrameworkControlDefinition[];

  switch (canonicalFramework) {
    case 'CMMC_L1':
      controls = [...CMMC_L1_FRAMEWORK_CONTROLS];
      break;
    case 'CMMC_L2':
      controls = [...CMMC_LEVEL_2_CONTROLS];
      break;
    case 'NIST_800_53_REV5':
      controls = [...NIST_800_53_CONTROLS];
      break;
    case 'SOC_2_TYPE_II':
      controls = [...SOC_2_CONTROLS];
      break;
    case 'HIPAA_SECURITY':
      controls = [...HIPAA_CONTROLS];
      break;
    default:
      controls = [...CMMC_L1_FRAMEWORK_CONTROLS];
  }

  // 1. Baseline filtering (for NIST 800-53 / RMF baselines): SP 800-53B baseline membership, per control
  if (canonicalFramework === 'NIST_800_53_REV5') {
    const level = nistBaselineLevel(baseline);
    if (level) controls = controls.filter(c => c.baselines?.[level] ?? true);
  }

  // 2. Operational Overlays (Air-gapped, No Wireless, No Mobile, No PII)
  const isNonNetworked = overlay === 'NON_NETWORKED' || (typeof overlay === 'object' && overlay?.nonNetworkedOnly);
  const isNoWireless = typeof overlay === 'object' && Boolean(overlay?.noWireless);
  const isNoMobile = typeof overlay === 'object' && Boolean(overlay?.noMobileDevices);
  const isNoPii = typeof overlay === 'object' && Boolean(overlay?.noPiiProcessing);

  if (isNonNetworked) {
    controls = controls.filter(c => {
      if (c.nonNetworkedApplicable === false) return false;
      const cleanId = c.id.toUpperCase();
      if (cleanId === 'SC-7' || cleanId === 'AC-17' || cleanId === 'SC-8') return false;
      return true;
    });
  }

  if (isNoWireless) {
    controls = controls.filter(c => {
      if (c.requiresWireless) return false;
      const cleanId = c.id.toUpperCase();
      if (cleanId === 'AC-18' || cleanId === 'AC.L2-3.1.16') return false;
      return true;
    });
  }

  if (isNoMobile) {
    controls = controls.filter(c => {
      if (c.requiresMobile) return false;
      const cleanId = c.id.toUpperCase();
      if (cleanId === 'AC-19' || cleanId === 'MP-7' || cleanId === 'AC.L2-3.1.18') return false;
      return true;
    });
  }

  if (isNoPii) {
    controls = controls.filter(c => {
      if (c.requiresPii) return false;
      const cleanId = c.id.toUpperCase();
      if (c.domain === 'PT' || cleanId.startsWith('PT-')) return false;
      return true;
    });
  }

  return controls;
}

/**
 * Universal lookup across all frameworks by Control ID
 */
let definitionIndex: Map<string, FrameworkControlDefinition> | null = null;
export function findControlDefinition(controlId: string): FrameworkControlDefinition | undefined {
  if (!controlId) return undefined;
  if (!definitionIndex) {
    definitionIndex = new Map();
    for (const c of [...CMMC_L1_FRAMEWORK_CONTROLS, ...CMMC_LEVEL_2_CONTROLS, ...NIST_800_53_CONTROLS, ...SOC_2_CONTROLS, ...HIPAA_CONTROLS]) {
      const key = c.id.toUpperCase();
      if (!definitionIndex.has(key)) definitionIndex.set(key, c); // the first framework that defines an id wins, as before
    }
  }
  return definitionIndex.get(controlId.trim().toUpperCase());
}
