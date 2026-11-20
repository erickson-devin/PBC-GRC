// What the existing policy generator can draft, for the document register (#240, D3). A generated draft is a DRAFT register row whose text is rendered
// live by the generator when someone looks at it: nothing generated is stored, uploaded, attached or counted as evidence. The row's seed key
// (`generated:<framework>:<family>`) keeps one row per framework and family. The generator is only called, never changed.

import type { Tenant } from '../../types/tenant';
import type { FipsModuleRef } from '../telemetry/fipsValidation';
import { generateFamilyPolicyDocument } from '../reports/policyDocumentGenerator';
import { GENERATED_SEED_PATTERN } from './documentSchema';

export interface GeneratedSeed {
  framework: string;
  family: string;
}

/** The control families the generator drafts a policy for, per framework (the Living Policy Library's lists). */
export const GENERATOR_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  CMMC_L1: ['AC', 'IA', 'MP', 'PE', 'SC', 'SI'],
  CMMC_L2: ['AC', 'AT', 'AU', 'CA', 'CM', 'IA', 'IR', 'MA', 'MP', 'PE', 'PS', 'RA', 'SC', 'SI'],
  NIST_800_53_REV5: ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PM', 'PS', 'PT', 'RA', 'SA', 'SC', 'SI', 'SR'],
};

/** Whether the generator can draft a policy for the framework and control family. */
export function canGenerateDraft(framework: string, family: string): boolean {
  return (GENERATOR_FAMILIES[framework] ?? []).includes(family);
}

/** 'generated:CMMC_L2:AC'. Matches the server's seed pattern for every framework and family the generator knows. */
export function generatedSeedKey(framework: string, family: string): string {
  return `generated:${framework}:${family}`;
}

/** The framework and family of a seed key; null for no seed, a malformed one, or a family the generator does not draft. */
export function parseGeneratedSeed(seed: string | null | undefined): GeneratedSeed | null {
  if (typeof seed !== 'string' || !GENERATED_SEED_PATTERN.test(seed)) return null;
  const parts = seed.split(':');
  if (parts.length !== 3) return null;
  const [, framework, family] = parts;
  return canGenerateDraft(framework, family) ? { framework, family } : null;
}

/**
 * The Markdown the generator drafts for a seed, from the tenant's recorded stack (use the program's effective stack). Called fresh each time and never
 * stored: the text is a draft with an unsigned approval block, not an approved document.
 */
export function renderGeneratedDraft(stackTenant: Tenant, seed: GeneratedSeed, familyTitle: string, crypto?: ReadonlyArray<FipsModuleRef>): string {
  return generateFamilyPolicyDocument(stackTenant, seed.family, familyTitle, seed.framework, crypto);
}

/** The register title a generated draft is created with: "<family name> Policy" (the Living Policy Library's title for the family). */
export function generatedDraftTitle(familyName: string): string {
  return `${familyName.trim()} Policy`;
}

/** The download name of a generated draft: no organization name, no CAGE code. `today` is YYYY-MM-DD. */
export function generatedDraftFileName(family: string, today: string): string {
  return `${family.toLowerCase()}-policy-draft-${today}.md`;
}
