import { SETUP_FRAMEWORKS, frameworkLabel } from './tenantFrameworkPolicy';
import type { ComplianceFramework } from '../types/framework';

/**
 * The framework choice on the first-run setup page (src/pages/SetupPage.tsx). Only SETUP_FRAMEWORKS are offered there;
 * SOC 2 and HIPAA are added later by a platform administrator under the organization's licensed frameworks.
 */
export const DEFAULT_SETUP_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1'];

export const SETUP_FRAMEWORKS_REQUIRED = 'Choose at least one framework.';
export const SETUP_FRAMEWORKS_REJECTED = 'The server did not accept that choice of frameworks. Choose from the list and try again.';

/** Ticks or unticks one framework. The result is in list order and holds only the frameworks the page offers. */
export function toggleSetupFramework(selected: readonly string[], id: ComplianceFramework): ComplianceFramework[] {
  return SETUP_FRAMEWORKS.filter((f) => (f === id ? !selected.includes(f) : selected.includes(f)));
}

/**
 * The `frameworks` sent to POST /setup; its first entry becomes the organization's primary framework. With several ticked,
 * the last one in list order (the most comprehensive: NIST SP 800-53 Rev. 5, then CMMC Level 2, then CMMC Level 1) is the
 * primary and the rest follow in list order. Nothing ticked gives [] (the page blocks that before sending).
 */
export function setupFrameworksPayload(selected: readonly string[]): ComplianceFramework[] {
  const ticked = SETUP_FRAMEWORKS.filter((f) => selected.includes(f));
  if (ticked.length === 0) return [];
  const primary = ticked[ticked.length - 1];
  return [primary, ...ticked.filter((f) => f !== primary)];
}

/** "CMMC Level 1", "CMMC Level 1 and CMMC Level 2", "CMMC Level 1, CMMC Level 2 and NIST SP 800-53 Rev. 5" (list order). */
export function setupFrameworksSentence(selected: readonly string[]): string {
  const labels = SETUP_FRAMEWORKS.filter((f) => selected.includes(f)).map(frameworkLabel);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
