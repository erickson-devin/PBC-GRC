import { FRAMEWORK_REGISTRY } from './frameworks/frameworkRegistry';
import type { ComplianceFramework } from '../types/framework';

/**
 * The tenant framework policy (the UI calls it "Licensed Frameworks"). A tenant is provisioned with a primary framework
 * plus any additional frameworks a platform administrator enabled for it (for example a dedicated CMMC Level 2 enclave,
 * or a separate NIST SP 800-53 tenant). The server enforces it: a tenant is only served the frameworks of its policy
 * (see server/middleware/frameworkGuard.ts). There is no billing, so nothing to price; what distinguishes tenants is the
 * assessment workflow they are set up for. Not the assessment program entity (see src/types/program.ts), though
 * PROGRAM_FRAMEWORKS is also the list of frameworks an assessment program may carry.
 */
export const PROGRAM_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];

export const DEFAULT_PRIMARY_FRAMEWORK: ComplianceFramework = 'CMMC_L1';

/** "CMMC Level 2", "NIST SP 800-53 Rev. 5", ... (falls back to the raw id for an unknown framework). */
export function frameworkLabel(framework: string): string {
  return FRAMEWORK_REGISTRY[framework as ComplianceFramework]?.shortName ?? framework;
}

export interface FrameworkPolicySummary {
  primary: string;
  /** Enabled frameworks other than the primary one. */
  additional: string[];
  /** One line: "CMMC Level 2" or "CMMC Level 2 + NIST SP 800-53 Rev. 5". */
  text: string;
}

export function frameworkPolicySummary(primary: string | undefined | null, enabled?: ReadonlyArray<string> | null): FrameworkPolicySummary {
  const main = primary || DEFAULT_PRIMARY_FRAMEWORK;
  const additional = [...new Set(enabled ?? [])].filter((f) => f !== main);
  return {
    primary: frameworkLabel(main),
    additional: additional.map(frameworkLabel),
    text: [frameworkLabel(main), ...additional.map(frameworkLabel)].join(' + '),
  };
}
