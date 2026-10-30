import type { ComplianceFramework } from '../types/framework';

/** Default texts of the onboarding wizard. They name no vendor: the customer states its own cloud services. */

/** The two system names the wizard proposes for an organization name. */
export function derivedSystemNames(org: string): string[] {
  const o = org.trim() || 'Corporate';
  return [`${o} Operations Boundary`, `${o} Information Network (CIN)`];
}

/** Follows a change of the organization name when the system name is still one of the proposed ones; a typed name is kept. */
export function refreshSystemName(current: string, previousOrg: string, nextOrg: string): string {
  const i = derivedSystemNames(previousOrg).indexOf(current.trim());
  return i >= 0 ? derivedSystemNames(nextOrg)[i] : current;
}

/** The kind of information the boundary narrative says the system handles, per framework. */
export function boundaryInformationPhrase(framework: ComplianceFramework): string {
  switch (framework) {
    case 'CMMC_L2':
      return 'Controlled Unclassified Information (CUI)';
    case 'NIST_800_53_REV5':
    case 'nist-800-53-r5':
      return 'federal information';
    case 'SOC_2_TYPE_II':
      return 'customer data';
    case 'HIPAA_SECURITY':
      return 'electronic protected health information (ePHI)';
    default:
      return 'Federal Contract Information (FCI)';
  }
}

export function defaultBoundaryNarrative(org: string, framework: ComplianceFramework = 'CMMC_L1'): string {
  return `The boundary for ${org.trim() || 'our organization'} encompasses the identity management, endpoints, servers and internal network infrastructure used to process, store, or transmit ${boundaryInformationPhrase(framework)}.`;
}

const NARRATIVE_FRAMEWORKS: ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];

/** Follows a change of the organization name when the narrative is still the proposed one (of any framework); typed text is kept. */
export function refreshBoundaryNarrative(current: string, previousOrg: string, nextOrg: string, framework: ComplianceFramework = 'CMMC_L1'): string {
  const text = current.trim();
  return NARRATIVE_FRAMEWORKS.some((f) => text === defaultBoundaryNarrative(previousOrg, f)) ? defaultBoundaryNarrative(nextOrg, framework) : current;
}

/** The cloud-services field starts empty: only the customer knows which providers are in scope. */
export const DEFAULT_CLOUD_PROVIDERS = '';
