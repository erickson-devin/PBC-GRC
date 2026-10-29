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

export function defaultBoundaryNarrative(org: string): string {
  return `The boundary for ${org.trim() || 'our organization'} encompasses the identity management, endpoints, servers and internal network infrastructure used to process, store, or transmit Federal Contract Information (FCI).`;
}

/** Follows a change of the organization name when the narrative is still the proposed one; typed text is kept. */
export function refreshBoundaryNarrative(current: string, previousOrg: string, nextOrg: string): string {
  return current.trim() === defaultBoundaryNarrative(previousOrg) ? defaultBoundaryNarrative(nextOrg) : current;
}

/** The cloud-services field starts empty: only the customer knows which providers are in scope. */
export const DEFAULT_CLOUD_PROVIDERS = '';
