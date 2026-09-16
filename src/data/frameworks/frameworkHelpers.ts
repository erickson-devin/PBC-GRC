import { ComplianceFramework, FrameworkControlDefinition } from '../../types/framework';
import { FRAMEWORK_REGISTRY } from './index';

/**
 * Returns a clean, human-readable framework title.
 * e.g., "CMMC 2.0 Level 2", "NIST SP 800-53 Rev 5", "SOC 2 Type II"
 */
export function getFrameworkTitle(framework: ComplianceFramework): string {
  switch (framework) {
    case 'CMMC_L1':
      return 'CMMC 2.0 Level 1';
    case 'CMMC_L2':
      return 'CMMC 2.0 Level 2';
    case 'NIST_800_53_REV5':
      return 'NIST SP 800-53 Rev 5';
    case 'SOC_2_TYPE_II':
      return 'SOC 2 Type II';
    case 'HIPAA_SECURITY':
      return 'HIPAA Security Rule';
    default: {
      const reg = (FRAMEWORK_REGISTRY as Record<string, any>)[framework];
      return reg?.shortName || String(framework);
    }
  }
}

/**
 * Returns exact total control count for the active framework scope.
 * If controls array is passed, returns its length; otherwise looks up total in registry.
 */
export function getFrameworkControlCount(
  framework: ComplianceFramework,
  controls?: FrameworkControlDefinition[]
): number {
  if (controls && Array.isArray(controls)) {
    return controls.length;
  }
  return FRAMEWORK_REGISTRY[framework]?.totalControls || 0;
}

export interface FrameworkGuidanceInfo {
  bannerTitle: string;
  authority: string;
  standardRef: string;
  poamPermitted: boolean;
  poamPolicyText: string;
  scopeDescription: string;
  inProgressGuidance: string;
  sprsReadyGuidance: string;
}

/**
 * Returns dynamic banner descriptions, compliance context, and baseline policy text
 * matching the active framework and baseline tier.
 */
export function getFrameworkGuidanceText(framework: ComplianceFramework): FrameworkGuidanceInfo {
  switch (framework) {
    case 'CMMC_L1':
      return {
        bannerTitle: 'CMMC 2.0 Level 1 / FAR 52.204-21 Compliance Engine',
        authority: 'FAR 52.204-21',
        standardRef: 'FAR 52.204-21 / NIST SP 800-171',
        poamPermitted: false,
        poamPolicyText: 'Plans of Action & Milestones (POA&Ms) are NOT permitted for Level 1 certification.',
        scopeDescription: 'Basic safeguarding of Federal Contract Information (FCI).',
        inProgressGuidance: 'CMMC Level 1 mandates satisfying all 17 practices across 6 domains with zero allowable POA&Ms.',
        sprsReadyGuidance: 'All FAR 52.204-21 practices are evaluated as MET with zero allowable POA&Ms. Ready to generate formal SSP and submit score to SPRS.',
      };
    case 'CMMC_L2':
      return {
        bannerTitle: 'CMMC 2.0 Level 2 / NIST SP 800-171 Rev 2 Compliance Engine',
        authority: 'NIST SP 800-171 Rev 2 / DFARS 252.204-7012',
        standardRef: 'NIST SP 800-171 Rev 2',
        poamPermitted: true,
        poamPolicyText: 'Time-bounded POA&Ms (180-day remediation) are permitted for select 1-point and 3-point controls under DoD rules.',
        scopeDescription: 'Advanced safeguarding of Controlled Unclassified Information (CUI).',
        inProgressGuidance: 'CMMC Level 2 mandates satisfying 110 requirements across 14 security domains. Target SPRS score is +110.',
        sprsReadyGuidance: 'All 110 NIST SP 800-171 practices are documented and MET. Baseline score of +110 achieved for C3PAO assessment readiness.',
      };
    case 'NIST_800_53_REV5':
      return {
        bannerTitle: 'NIST SP 800-53 Rev 5 Security & Privacy Controls Engine',
        authority: 'NIST SP 800-53 Rev 5 / FISMA',
        standardRef: 'NIST SP 800-53 Rev 5',
        poamPermitted: true,
        poamPolicyText: 'Deficiencies must be tracked in an official POA&M with scheduled remediation milestones.',
        scopeDescription: 'Federal information system authorization and FedRAMP / FISMA boundary baseline.',
        inProgressGuidance: 'NIST SP 800-53 Rev 5 baseline requires satisfying all controls scoped to your selected security categorization tier.',
        sprsReadyGuidance: 'All baseline security controls are verified and satisfied. Ready to compile formal System Security Plan for ATO authorization.',
      };
    case 'SOC_2_TYPE_II':
      return {
        bannerTitle: 'AICPA SOC 2 Type II Trust Services Criteria Engine',
        authority: 'AICPA Trust Services Criteria (TSP Section 100)',
        standardRef: 'AICPA TSP Section 100',
        poamPermitted: true,
        poamPolicyText: 'Exceptions must be remediated or mitigated prior to the audit observation period conclusion.',
        scopeDescription: 'Evaluation of Security, Availability, and Confidentiality controls over an examination window.',
        inProgressGuidance: 'SOC 2 Type II mandates verifying Trust Services Criteria with operational operating effectiveness evidence.',
        sprsReadyGuidance: 'All Trust Services Criteria are satisfied with operating effectiveness evidence. System description ready for CPA examination.',
      };
    case 'HIPAA_SECURITY':
      return {
        bannerTitle: 'HIPAA Security Rule / 45 CFR Part 164 Compliance Engine',
        authority: '45 CFR Part 164 Subpart C',
        standardRef: '45 CFR §164.308, §164.310, §164.312',
        poamPermitted: true,
        poamPolicyText: 'Corrective action plans (CAPs) are required for non-implemented required specifications.',
        scopeDescription: 'Safeguarding electronic Protected Health Information (ePHI) across Administrative, Physical, and Technical safeguards.',
        inProgressGuidance: 'HIPAA Security Rule mandates complete evaluation of Administrative, Physical, and Technical safeguard specifications.',
        sprsReadyGuidance: 'All HIPAA Security Rule specifications are satisfied and verified. Security risk assessment documentation ready for HHS OCR review.',
      };
      return {
        bannerTitle: `${framework} Compliance Engine`,
        authority: 'Regulatory Compliance Standard',
        standardRef: framework,
        poamPermitted: false,
        poamPolicyText: 'All controls require evaluation.',
        scopeDescription: 'Regulatory compliance baseline.',
        inProgressGuidance: 'Satisfy all controls to achieve complete baseline compliance.',
        sprsReadyGuidance: 'All framework controls are evaluated as MET.',
      };
  }
}

export interface ImpactBadgeInfo {
  weight: number;
  label: string;
  tagText: string;
  badgeClass: string;
  dotClass: string;
  glowClass: string;
}

/**
 * Returns tactical styling and labels for CMMC Level 2 / NIST SP 800-171 impact weights:
 * 5 Points: Red/Cyan glowing badge (5 PTS // HIGH IMPACT)
 * 3 Points: Amber badge (3 PTS // MOD IMPACT)
 * 1 Point: Slate badge (1 PT // STD IMPACT)
 */
export function getControlImpactBadge(weight: number): ImpactBadgeInfo {
  switch (weight) {
    case 5:
      return {
        weight: 5,
        label: 'High Impact',
        tagText: '5 PTS // HIGH IMPACT',
        badgeClass: 'bg-rose-500/15 text-rose-300 border border-rose-500/40 ring-1 ring-cyan-400/40 shadow-[0_0_12px_rgba(244,63,94,0.35)]',
        dotClass: 'bg-rose-400 animate-ping',
        glowClass: 'shadow-rose-950/40',
      };
    case 3:
      return {
        weight: 3,
        label: 'Mod Impact',
        tagText: '3 PTS // MOD IMPACT',
        badgeClass: 'bg-amber-500/15 text-amber-300 border border-amber-500/40 ring-1 ring-amber-500/20 shadow-sm shadow-amber-950/40',
        dotClass: 'bg-amber-400',
        glowClass: 'shadow-amber-950/40',
      };
    case 1:
    default:
      return {
        weight: 1,
        label: 'Std Impact',
        tagText: '1 PT // STD IMPACT',
        badgeClass: 'bg-slate-800/80 text-slate-300 border border-slate-700 shadow-sm',
        dotClass: 'bg-slate-500',
        glowClass: 'shadow-slate-950/40',
      };
  }
}

