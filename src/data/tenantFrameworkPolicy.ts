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

/** The frameworks the first-time setup wizard offers. SOC 2 and HIPAA are enabled later by a platform administrator. */
export const SETUP_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5'];
const MAX_SETUP_FRAMEWORK_ENTRIES = 10;

/**
 * The frameworks chosen at setup. Absent (undefined) or an empty list: the default, CMMC Level 1 only. Otherwise every entry must
 * be one of SETUP_FRAMEWORKS (exact id, no aliases); duplicates are dropped, the order kept, and the first entry is the primary.
 * Null when invalid (not a list, a non-string or unknown entry, more than 10 entries).
 */
export function parseSetupFrameworks(raw: unknown): ComplianceFramework[] | null {
  if (raw === undefined) return [DEFAULT_PRIMARY_FRAMEWORK];
  if (!Array.isArray(raw) || raw.length > MAX_SETUP_FRAMEWORK_ENTRIES) return null;
  if (raw.length === 0) return [DEFAULT_PRIMARY_FRAMEWORK];
  const out: ComplianceFramework[] = [];
  for (const f of raw) {
    if (typeof f !== 'string' || !SETUP_FRAMEWORKS.includes(f as ComplianceFramework)) return null;
    if (!out.includes(f as ComplianceFramework)) out.push(f as ComplianceFramework);
  }
  return out;
}

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
