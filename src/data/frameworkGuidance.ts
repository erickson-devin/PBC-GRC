import type { ComplianceFramework } from '../types/framework';
import { getFrameworkGuidanceText, type FrameworkGuidanceInfo } from './frameworks/frameworkHelpers';

/**
 * The banner and policy text of a framework. NIST SP 800-171 Rev. 3 is answered here; every other framework is delegated to
 * getFrameworkGuidanceText (src/data/frameworks/frameworkHelpers.ts), whose unknown-framework default says "no POA&Ms" and would be wrong for Rev. 3.
 * No count is written into the text: the callers show the program's own totals.
 */
export function frameworkGuidance(framework: ComplianceFramework): FrameworkGuidanceInfo {
  if (framework === 'NIST_800_171_R3') {
    return {
      bannerTitle: 'NIST SP 800-171 Rev. 3 Protecting CUI Compliance Engine',
      authority: 'NIST SP 800-171 Rev. 3 / NIST SP 800-171A Rev. 3',
      standardRef: 'NIST SP 800-171 Rev. 3',
      poamPermitted: true,
      poamPolicyText: 'Gaps are tracked in a Plan of Action and Milestones (POA&M) with scheduled remediation milestones. Your contract and the assessing authority decide what may stay open.',
      scopeDescription: 'Safeguarding of Controlled Unclassified Information (CUI) in nonfederal systems and organizations.',
      inProgressGuidance: 'NIST SP 800-171 Rev. 3 asks you to satisfy every requirement of the catalog, each judged against its NIST SP 800-171A determination statements.',
      sprsReadyGuidance: 'All requirements are documented and MET. This program shows a completion percentage: there is no SPRS score for Rev. 3.',
    };
  }
  return getFrameworkGuidanceText(framework);
}
