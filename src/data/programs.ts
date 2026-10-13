import { FRAMEWORK_REGISTRY } from './frameworks/frameworkRegistry';
import type { ComplianceFramework } from '../types/framework';

/**
 * Assessment programs. A tenant is provisioned for a program: its primary framework plus any additional frameworks a
 * platform administrator enabled for it (for example a dedicated CMMC Level 2 enclave, or a separate NIST SP 800-53
 * tenant). The server enforces it: a tenant is only served the frameworks of its program (see
 * server/middleware/frameworkGuard.ts). It replaces the commercial "license tier": there is no billing, so there is
 * nothing to price; what distinguishes tenants is the assessment workflow they are set up for.
 */
export const PROGRAM_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];

export const DEFAULT_PROGRAM_FRAMEWORK: ComplianceFramework = 'CMMC_L1';

/** "CMMC Level 2", "NIST SP 800-53 Rev. 5", ... (falls back to the raw id for an unknown framework). */
export function frameworkLabel(framework: string): string {
  return FRAMEWORK_REGISTRY[framework as ComplianceFramework]?.shortName ?? framework;
}

export interface ProgramSummary {
  primary: string;
  /** Enabled frameworks other than the primary one. */
  additional: string[];
  /** One line: "CMMC Level 2" or "CMMC Level 2 + NIST SP 800-53 Rev. 5". */
  text: string;
}

export function programSummary(primary: string | undefined | null, enabled?: ReadonlyArray<string> | null): ProgramSummary {
  const main = primary || DEFAULT_PROGRAM_FRAMEWORK;
  const additional = [...new Set(enabled ?? [])].filter((f) => f !== main);
  return {
    primary: frameworkLabel(main),
    additional: additional.map(frameworkLabel),
    text: [frameworkLabel(main), ...additional.map(frameworkLabel)].join(' + '),
  };
}
