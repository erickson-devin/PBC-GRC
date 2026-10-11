import { Tenant, EnclaveStackProfile } from '../../types/tenant';
import { getCascadedObjectiveNarrative } from '../frameworks/policyCompiler';
import { getObjectivesForControl } from '../frameworks/assessmentObjectives';
import { getFrameworkControls } from '../frameworks/frameworkRegistry';

export function generatePolicyDocument(
  tenantOrFamily: Tenant | string,
  controlFamilyOrStack?: string | EnclaveStackProfile,
  familyTitleOrFramework?: string,
  frameworkArg?: string
): string {
  let tenant: Tenant;
  let controlFamily: string;
  let familyTitle: string;
  let activeFramework: string;

  if (typeof tenantOrFamily === 'string') {
    // Called as (familyCode, stack, activeFramework)
    controlFamily = tenantOrFamily;
    const stack = (controlFamilyOrStack as EnclaveStackProfile) || {};
    activeFramework = familyTitleOrFramework || 'NIST_800_53_REV5';
    familyTitle = `${controlFamily} Policy`;
    tenant = {
      id: 'default-tenant',
      name: 'Defense Enclave Organization',
      cageCode: 'CAGE-DEF',
      samStatus: 'ACTIVE',
      systemName: 'Boundary Enclave',
      systemOwner: 'Information System Security Manager',
      industry: 'Defense Industrial Base',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stackProfile: stack as EnclaveStackProfile,
    };
  } else {
    // Called as (tenant, controlFamily, familyTitle, activeFramework)
    tenant = tenantOrFamily;
    controlFamily = (controlFamilyOrStack as string) || 'AC';
    familyTitle = familyTitleOrFramework || `${controlFamily} Policy`;
    activeFramework = frameworkArg || tenant.primaryFramework || 'NIST_800_53_REV5';
  }

  const stack: EnclaveStackProfile = tenant.stackProfile || {
    identityProvider: 'ENTRA_ID_COMMERCIAL',
    edrSolution: 'DEFENDER_FOR_ENDPOINT',
    infrastructure: 'AZURE_GOV',
    mdmSolution: 'INTUNE',
    siemSolution: 'SENTINEL',
    odpParams: {},
  };

  const normFamily = (controlFamily || '').split('-')[0].trim().toUpperCase();
  const normFramework = (activeFramework || '').toUpperCase();

  let frameworkTitle = 'NIST SP 800-53 Policy';
  let frameworkCitation = 'in accordance with NIST SP 800-53 Rev. 5 Risk Management Framework.';

  if (normFramework === 'CMMC_L1' || normFramework === 'CMMC-L1') {
    frameworkTitle = 'CMMC Level 1 Policy';
    frameworkCitation = 'in accordance with DoD CMMC 2.0 Level 1 / FAR 52.204-21 basic safeguarding requirements.';
  } else if (normFramework === 'CMMC_L2' || normFramework === 'CMMC-L2') {
    frameworkTitle = 'CMMC Level 2 Policy';
    frameworkCitation = 'in accordance with DoD CMMC 2.0 Level 2 / NIST SP 800-171 Rev. 2 guidelines.';
  }

  // Retrieve controls strictly for active framework
  const allFrameworkControls = getFrameworkControls(activeFramework);
  const familyControls = allFrameworkControls.filter((ctrl) => {
    const domainNorm = (ctrl.domain || '').toUpperCase();
    if (domainNorm === normFamily) return true;
    const idUpper = (ctrl.id || '').toUpperCase();
    if (idUpper.startsWith(`${normFamily}.`) || idUpper.startsWith(`${normFamily}-`)) return true;
    return false;
  });

  // Sort controls by ID naturally
  familyControls.sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' })
  );

  let markdown = `# ${familyTitle} (${normFamily}) - ${frameworkTitle}\n\n`;
  markdown += `**Organization:** ${tenant.name}\n`;
  markdown += `**System Name:** ${tenant.systemName}\n`;
  markdown += `**Framework Scope:** ${frameworkTitle} (${activeFramework})\n`;
  markdown += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  markdown += `**Authorizing Official:** ${tenant.systemOwner}\n\n`;

  markdown += `## 1. Purpose\n`;
  markdown += `The purpose of this policy is to establish the requirements for the ${familyTitle} family of controls ${frameworkCitation}\n\n`;

  markdown += `## 2. Scope\n`;
  markdown += `This policy applies to all systems, networks, and personnel operating within the ${tenant.systemName} boundary.\n\n`;

  markdown += `## 3. Policy Statements\n\n`;

  if (familyControls.length > 0) {
    familyControls.forEach((control) => {
      markdown += `### ${control.id} - ${control.title}\n\n`;
      if (control.plainEnglishSummary) {
        markdown += `*Requirement Summary*: ${control.plainEnglishSummary}\n\n`;
      }
      const objectives = getObjectivesForControl(control.id, control.title);
      if (objectives && objectives.length > 0) {
        objectives.forEach((obj) => {
          const narrative = getCascadedObjectiveNarrative(control.id, obj.letter, stack);
          markdown += `**Objective ${obj.letter}**: ${obj.text}\n\n`;
          markdown += `**Implementation**: ${narrative}\n\n`;
        });
      }
    });
  } else {
    // If framework does not cover this family or if 800-53 fallback
    if (normFramework === 'CMMC_L1' || normFramework === 'CMMC_L2') {
      markdown += `> [!NOTE]\n> The **${normFamily}** family does not contain mandatory controls under **${frameworkTitle}**.\n\n`;
    } else {
      // Standard baseline statements for NIST SP 800-53 Rev. 5 families
      const genericStatements = [
        {
          id: `${normFamily}-1`,
          title: `${familyTitle} Policy and Operational Procedures`,
          req: `The organization develops, documents, disseminates, and reviews/updates at least annually a formal ${familyTitle} policy and operational procedures.`,
          impl: `This document serves as the formal baseline for ${familyTitle} within the ${tenant.systemName} boundary, governed by ${tenant.systemOwner} and enforced across ${stack.infrastructure}.`,
        },
        {
          id: `${normFamily}-2`,
          title: `${familyTitle} Operational Controls & Safeguards`,
          req: `Personnel and automated mechanisms execute ${familyTitle} safeguards adhering to defense baseline standards and continuous monitoring SLAs.`,
          impl: `Operational controls are continuously enforced through automated integration with ${stack.identityProvider}, ${stack.edrSolution}, and telemetry ingestion into ${stack.siemSolution}.`,
        },
        {
          id: `${normFamily}-3`,
          title: `${familyTitle} Continuous Monitoring and Oversight`,
          req: `Review and verify compliance metrics and technical telemetry associated with ${familyTitle}.`,
          impl: `Audit evidence is collected continuously into the enclave evidence vault, and non-compliances are tracked within the System Security Plan (SSP) and POA&M registers.`,
        },
      ];

      genericStatements.forEach((stmt) => {
        markdown += `### ${stmt.id} - ${stmt.title}\n\n`;
        markdown += `**Requirement**: ${stmt.req}\n\n`;
        markdown += `**Implementation**: ${stmt.impl}\n\n`;
      });
    }
  }

  markdown += `## 4. Revision History\n\n`;
  markdown += `| Date | Version | Description | Author |\n`;
  markdown += `|---|---|---|---|\n`;
  markdown += `| ${new Date().toISOString().split('T')[0]} | 1.0 | Initial Policy Generation (${frameworkTitle}) | Automated System |\n\n`;
  
  markdown += `## 5. Authorizing Official Block\n\n`;
  markdown += `I have reviewed and approved this policy for the ${tenant.systemName}.\n\n`;
  markdown += `**Signature:** ___________________________  **Date:** _________________\n\n`;
  markdown += `**Name:** ${tenant.systemOwner}\n\n`;
  markdown += `**Title:** System Owner\n`;

  return markdown;
}

export const generateFamilyPolicyDocument = generatePolicyDocument;
