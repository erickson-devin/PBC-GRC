// Suggestions for the Tools and Services register from the technology survey (the enclave stack profile, #239). Pure and never automatic: a person
// reviews the list and chooses to add it. Insert-only: a tool already in the register (same seed key, or the same name ignoring case) is never offered again.

import { STACK_PROFILE_ENUM_KEYS } from '../stackProfileSchema';
import { stackValueLabel, type StackKey } from '../stackDraftView';
import type { EnclaveStackProfile } from '../../types/tenant';
import type { InventoryTool, ToolDeployment, ToolInput, ToolType } from '../../types/inventory';

/** Survey answers that name an approach, not a tool: they are never suggested. */
export const SURVEY_SEED_SKIP: Partial<Record<StackKey, string[]>> = {
  infrastructure: ['HYBRID_CLOUD'],
  mdmSolution: ['MANUAL_GPO'],
  edrSolution: ['GENERIC_AV'],
};

/**
 * The type and asset category each survey step suggests, and where each answer usually runs. A null deployment is left for the person to choose
 * (the product is offered both ways, or the answer is a custom one).
 */
export const SURVEY_SEED_DEFAULTS: Record<StackKey, { toolType: ToolType; deployment: Record<string, ToolDeployment | null>; assetCategory: 'SECURITY_PROTECTION' }> = {
  identityProvider: {
    toolType: 'IDENTITY_SSO',
    deployment: { ENTRA_ID_GOV: 'CLOUD', ENTRA_ID_COMMERCIAL: 'CLOUD', OKTA: 'CLOUD', ACTIVE_DIRECTORY: 'ON_PREM', CUSTOM: null },
    assetCategory: 'SECURITY_PROTECTION',
  },
  edrSolution: {
    toolType: 'EDR',
    deployment: { CROWDSTRIKE_FALCON: 'CLOUD', DEFENDER_FOR_ENDPOINT: 'CLOUD', SENTINELONE: 'CLOUD', GENERIC_AV: null, CUSTOM: null },
    assetCategory: 'SECURITY_PROTECTION',
  },
  infrastructure: {
    toolType: 'CLOUD_PLATFORM',
    deployment: { AZURE_GOV: 'CLOUD', AWS_GOVCLOUD: 'CLOUD', ON_PREM_RHEL: 'ON_PREM', HYBRID_CLOUD: null, CUSTOM: null },
    assetCategory: 'SECURITY_PROTECTION',
  },
  mdmSolution: {
    toolType: 'MDM_UEM',
    deployment: { INTUNE: 'CLOUD', JAMF: null, WORKSPACE_ONE: null, MANUAL_GPO: null, CUSTOM: null },
    assetCategory: 'SECURITY_PROTECTION',
  },
  siemSolution: {
    toolType: 'SIEM',
    deployment: { SENTINEL: 'CLOUD', SPLUNK_GOV: null, ELASTIC: null, LOCAL_AUDITD: 'ON_PREM', CUSTOM: null },
    assetCategory: 'SECURITY_PROTECTION',
  },
};

/**
 * What the survey suggests adding to the register, in survey order: one candidate per answered step, named as the survey names it (a custom answer
 * by its label), with seed key `survey:<step>`. Steps that are unanswered, name an approach (SURVEY_SEED_SKIP) or are already in `existing` are left out.
 */
export function seedCandidatesFromStackProfile(
  profile: EnclaveStackProfile | undefined,
  existing: Pick<InventoryTool, 'name' | 'seedKey'>[]
): (ToolInput & { seedKey: string })[] {
  if (!profile) return [];
  const seedKeys = new Set(existing.map((t) => t.seedKey).filter((k): k is string => typeof k === 'string'));
  const names = new Set(existing.map((t) => t.name.trim().toLowerCase()));
  const out: (ToolInput & { seedKey: string })[] = [];
  for (const key of STACK_PROFILE_ENUM_KEYS) {
    const value = profile[key];
    if (typeof value !== 'string' || SURVEY_SEED_SKIP[key]?.includes(value)) continue;
    const name = stackValueLabel(key, value, profile.customLabels);
    if (!name) continue;
    const seedKey = `survey:${key}`;
    const lowered = name.trim().toLowerCase();
    if (seedKeys.has(seedKey) || names.has(lowered)) continue;
    const defaults = SURVEY_SEED_DEFAULTS[key];
    names.add(lowered); // two steps with the same name are offered once
    out.push({ name, toolType: defaults.toolType, deployment: defaults.deployment[value] ?? null, assetCategory: defaults.assetCategory, seedKey });
  }
  return out;
}
