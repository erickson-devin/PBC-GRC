import {
  ComplianceFramework,
  BaselineTier,
  OverlayParameter,
  FrameworkDefinition,
  FrameworkControlDefinition,
  FrameworkDomainInfo,
} from '../../types/framework';
import { CMMC_LEVEL_1_CONTROLS, DOMAINS as CMMC_L1_DOMAINS } from '../cmmcLevel1Controls';
import { CMMC_LEVEL_2_CONTROLS, CMMC_L2_DOMAINS } from './cmmcLevel2Controls';
import { NIST_800_53_CONTROLS, NIST_800_53_DOMAINS } from './nist80053Controls';
import { SOC_2_CONTROLS, SOC_2_DOMAINS } from './soc2Controls';
import { HIPAA_CONTROLS, HIPAA_DOMAINS } from './hipaaControls';
import {
  CANONICAL_CONTROL_MAPPINGS,
  getCrossFrameworkMappings,
  getEquivalentControlIds,
} from './controlMappings';

// Adapt CMMC L1 controls into FrameworkControlDefinition
export const CMMC_L1_FRAMEWORK_CONTROLS: FrameworkControlDefinition[] = CMMC_LEVEL_1_CONTROLS.map(ctrl => {
  // Boundary controls are not applicable in purely non-networked systems
  const isNetworkBoundary = ctrl.id === 'SC.L1-3.13.1' || ctrl.id === 'SC.L1-3.13.5';
  const mappings = getCrossFrameworkMappings(ctrl.id).map(m => ({
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
 * Framework Registry Definitions
 */
export const FRAMEWORK_REGISTRY: Record<ComplianceFramework, FrameworkDefinition> = {
  CMMC_L1: {
    id: 'CMMC_L1',
    name: 'CMMC 2.0 Level 1 (Foundational)',
    shortName: 'CMMC Level 1',
    version: '2.0',
    authority: 'FAR 52.204-21',
    description: '17 basic safeguarding requirements protecting Federal Contract Information (FCI). Requires 100% compliance with zero allowable POA&Ms.',
    totalControls: 17,
    supportsNonNetworkedOverlay: true,
    domains: adaptedCmmcL1Domains,
  },
  CMMC_L2: {
    id: 'CMMC_L2',
    name: 'CMMC 2.0 Level 2 (Advanced)',
    shortName: 'CMMC Level 2',
    version: '2.0',
    authority: 'NIST SP 800-171 Rev 2 / DFARS 252.204-7012',
    description: '110 security requirements across 14 families safeguarding Controlled Unclassified Information (CUI). Requires DoD SPRS assessment scoring.',
    totalControls: 110,
    supportsNonNetworkedOverlay: true,
    domains: CMMC_L2_DOMAINS,
  },
  NIST_800_53_REV5: {
    id: 'NIST_800_53_REV5',
    name: 'NIST SP 800-53 Rev 5 (Low / Moderate)',
    shortName: 'NIST SP 800-53',
    version: 'Rev 5',
    authority: 'NIST Special Publication 800-53 Rev 5',
    description: 'Comprehensive security and privacy control catalog for federal information systems. Supports Low and Moderate baselines with non-networked overlays.',
    totalControls: NIST_800_53_CONTROLS.length,
    defaultBaseline: 'MOD_MOD_MOD',
    supportedBaselines: [
      { id: 'LOW_LOW_LOW', label: 'Low Baseline', description: 'Low confidentiality, integrity, and availability impact (standard low baseline).' },
      { id: 'MOD_MOD_MOD', label: 'Moderate Baseline', description: 'Moderate confidentiality, integrity, and availability impact (comprehensive defense posture).' },
      { id: 'LOW_LOW_MOD', label: 'Low-Mod Mixed', description: 'Low confidentiality/integrity with Moderate availability (high-resilience enclave).' },
    ],
    supportsNonNetworkedOverlay: true,
    domains: NIST_800_53_DOMAINS,
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
 * Dynamic Filtered Control Retrieval
 * Filters controls by framework, baseline tier / CIA triad, and overlay parameters.
 */
export function getFrameworkControls(
  framework: ComplianceFramework = 'CMMC_L1',
  baseline: BaselineTier | any = 'ALL_CONTROLS',
  overlay: OverlayParameter | any = 'NONE'
): FrameworkControlDefinition[] {
  let controls: FrameworkControlDefinition[];

  switch (framework) {
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

  // 1. Baseline filtering (primarily for NIST 800-53 or frameworks with baseline tiers)
  if (framework === 'NIST_800_53_REV5') {
    if (typeof baseline === 'string') {
      if (baseline !== 'ALL_CONTROLS') {
        controls = controls.filter(c => {
          if (!c.baselineTiers || c.baselineTiers.length === 0) return true;
          return c.baselineTiers.includes(baseline as BaselineTier);
        });
      }
    } else if (baseline && typeof baseline === 'object') {
      // CIA Triad object: { confidentiality, integrity, availability, isAllControlsApplied }
      if (!baseline.isAllControlsApplied) {
        const impacts = [baseline.confidentiality, baseline.integrity, baseline.availability];
        const isHigh = impacts.includes('HIGH');
        const isMod = impacts.includes('MODERATE');

        if (!isHigh) {
          if (isMod) {
            controls = controls.filter(c => {
              if (!c.baselineTiers || c.baselineTiers.length === 0) return true;
              return c.baselineTiers.includes('MOD_MOD_MOD') || c.baselineTiers.includes('LOW_LOW_MOD');
            });
          } else {
            // All Low Impact
            controls = controls.filter(c => {
              if (!c.baselineTiers || c.baselineTiers.length === 0) return true;
              return c.baselineTiers.includes('LOW_LOW_LOW');
            });
          }
        }
      }
    }
  }

  // 2. Operational Caveats / Overlays:
  // - Non-Networked / Stand-alone / Air-gapped
  // - No Wireless Capabilities
  // - No Mobile Devices
  // - No PII Processing
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
export function findControlDefinition(controlId: string): FrameworkControlDefinition | undefined {
  const cleanId = controlId.trim().toUpperCase();

  const allControls = [
    ...CMMC_L1_FRAMEWORK_CONTROLS,
    ...CMMC_LEVEL_2_CONTROLS,
    ...NIST_800_53_CONTROLS,
    ...SOC_2_CONTROLS,
    ...HIPAA_CONTROLS,
  ];

  return allControls.find(c => c.id.toUpperCase() === cleanId);
}

export {
  CANONICAL_CONTROL_MAPPINGS,
  getCrossFrameworkMappings,
  getEquivalentControlIds,
};

export * from './frameworkHelpers';
