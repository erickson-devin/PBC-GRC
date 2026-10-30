import type { ComplianceFramework } from '../types/framework';
import { getFrameworkTitle } from './frameworks';
import { sprsAppliesTo } from './reports/sprsCompiler';

/** What the onboarding wizard says about the tenant's framework (#139). Pure: no React, no context. */
export interface OnboardingSummaryInput {
  framework: ComplianceFramework;
  total: number;
  met: number;
  evidenceCount: number;
  /** The framework / program data is still loading: the counts are not final yet. */
  loading: boolean;
}

export interface OnboardingSummary {
  frameworkTitle: string;
  unit: 'practices' | 'controls';
  unitLabel: string;
  countText: string;
  countSrText: string;
  readinessText: string;
  evidenceText: string;
  calloutTitle: string;
  calloutText: string;
  assessedUnder: string;
  sprsApplies: boolean;
}

/** CMMC calls its requirements practices, every other framework controls. */
export function onboardingUnit(framework: ComplianceFramework): 'practices' | 'controls' {
  return framework === 'CMMC_L1' || framework === 'CMMC_L2' ? 'practices' : 'controls';
}

/** The authority the system boundary is assessed under, as a phrase for "assessed under ...". */
export function onboardingAssessedUnder(framework: ComplianceFramework): string {
  switch (framework) {
    case 'CMMC_L1':
      return 'FAR 52.204-21 / CMMC Level 1';
    case 'CMMC_L2':
      return 'DFARS 252.204-7012 / CMMC Level 2 (NIST SP 800-171 Rev 2)';
    case 'NIST_800_53_REV5':
    case 'nist-800-53-r5':
      return 'NIST SP 800-53 Rev 5';
    case 'SOC_2_TYPE_II':
      return 'the AICPA Trust Services Criteria (SOC 2 Type II)';
    case 'HIPAA_SECURITY':
      return 'the HIPAA Security Rule (45 CFR Part 164 Subpart C)';
    default:
      return getFrameworkTitle(framework);
  }
}

export function onboardingSummary(input: OnboardingSummaryInput): OnboardingSummary {
  const { framework, loading } = input;
  const frameworkTitle = getFrameworkTitle(framework);
  const unit = onboardingUnit(framework);
  const singular = unit === 'practices' ? 'practice' : 'control';
  const total = Math.max(0, input.total);
  const met = Math.min(total, Math.max(0, input.met));
  const pct = total > 0 ? Math.round((met / total) * 100) : 0;
  const files = Math.max(0, input.evidenceCount);

  let calloutText: string;
  if (loading) calloutText = `Loading the ${frameworkTitle} ${unit} for this enclave.`;
  else if (met === 0) calloutText = `All ${total} ${frameworkTitle} ${unit} are set to NOT_STARTED${files === 0 ? ' with zero pre-populated evidence' : ''}.`;
  else calloutText = `${met} of ${total} ${frameworkTitle} ${unit} are already marked MET.`;

  return {
    frameworkTitle,
    unit,
    unitLabel: unit === 'practices' ? 'Practices Met' : 'Controls Met',
    countText: loading ? '…' : `${met} / ${total}`,
    countSrText: loading ? `Loading the ${singular} count` : `${met} of ${total} ${unit} met`,
    readinessText: loading ? '…' : `${pct}% Met`,
    evidenceText: `${files} ${files === 1 ? 'File' : 'Files'}`,
    calloutTitle: loading ? 'Loading Baseline:' : met === 0 ? 'Blank Baseline Initialized:' : 'Baseline Loaded:',
    calloutText,
    assessedUnder: onboardingAssessedUnder(framework),
    sprsApplies: sprsAppliesTo(framework),
  };
}
