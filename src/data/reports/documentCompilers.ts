import {
  ReportDocumentType,
  ReportMetadata,
  CompiledDocument,
  ReportSection,
  DocumentSummaryMetrics,
  POAMEntry,
} from '../../types/report';
import { FrameworkControlDefinition, ComplianceFramework } from '../../types/framework';
import { ControlState, EvidenceItem, ControlStatus } from '../../types/cmmc';
import { FRAMEWORK_REGISTRY } from '../frameworks';
import { computeDomainStats } from '../frameworks/domainStats';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES, boundaryNarrative } from '../telemetry/assetScope';
import { applyFipsModules, isCryptographicProtectionControl } from '../telemetry/fipsValidation';
import { sprsAppliesTo } from './sprsCompiler';

import {
  NO_CSP_RECORDED,
  NOT_RECORDED,
  NO_ORGANIZATION_RECORDED,
  NO_SYSTEM_NAME_RECORDED,
  NO_SYSTEM_OWNER_RECORDED,
  NO_SECURITY_OFFICIAL_RECORDED,
  NO_ASSESSOR_RECORDED,
  NO_CAGE_CODE_RECORDED,
  NO_SAM_STATUS_RECORDED,
  NO_BOUNDARY_RECORDED,
  NO_SERVICE_COMMITMENTS_RECORDED,
  UNNAMED_SYSTEM,
  NO_MILESTONES_RECORDED,
  NO_CUECS_RECORDED,
  SOC2_TESTS_BY_SERVICE_AUDITOR,
  NO_SUBSERVICE_RELIANCE_RECORDED,
  UNSIGNED_ATTESTATION_NOTE,
  SIGNATURE_BLANK,
  recordedRole,
} from './documentDefaults';

/** Tests and callers import it from here (#122); the text lives in documentDefaults.ts (#151). */
export { NO_CSP_RECORDED } from './documentDefaults';

/**
 * Resolves the standard recommended document type for a given compliance framework.
 */
export function getDefaultDocumentTypeForFramework(framework: ComplianceFramework): ReportDocumentType {
  switch (framework) {
    case 'CMMC_L1':
    case 'CMMC_L2':
    case 'NIST_800_53_REV5':
      return 'NIST_SP_800_18_SSP';
    case 'SOC_2_TYPE_II':
      return 'SOC_2_SYSTEM_DESCRIPTION';
    case 'HIPAA_SECURITY':
      return 'HIPAA_SECURITY_ASSESSMENT';
    default:
      return 'NIST_SP_800_18_SSP';
  }
}

/**
 * Calculates aggregate compliance statistics from control definitions and evaluation states.
 */
export function calculateSummaryMetrics(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>
): DocumentSummaryMetrics {
  const total = controls.length;
  let metCount = 0;
  let inProgressCount = 0;
  let notMetCount = 0;
  let notStartedCount = 0;

  for (const ctrl of controls) {
    const s = controlStates[ctrl.id]?.status || 'NOT_STARTED';
    if (s === 'MET') metCount++;
    else if (s === 'IN_PROGRESS') inProgressCount++;
    else if (s === 'NOT_MET') notMetCount++;
    else notStartedCount++;
  }

  const completionPercentage = total > 0 ? Math.round((metCount / total) * 100) : 0;

  return {
    domainStats: computeDomainStats(controls, controlStates),
    totalControls: total,
    metCount,
    inProgressCount,
    notMetCount,
    notStartedCount,
    completionPercentage,
  };
}

/**
 * Automatically aggregates NOT_MET and IN_PROGRESS (and unaddressed) controls into structured POA&M entries.
 * #198: only what is recorded is stated. A due date, resources and milestones are never invented; they print as not recorded.
 */
export function generatePOAMEntries(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>
): POAMEntry[] {
  const poamEntries: POAMEntry[] = [];
  let counter = 1;

  for (const ctrl of controls) {
    const state = controlStates[ctrl.id];
    const status: ControlStatus = state?.status || 'NOT_STARTED';

    // POA&Ms apply to unmet, in-progress, or not started controls
    if (status !== 'MET') {
      const padNum = String(counter).padStart(3, '0');
      const weaknessId = `POAM-${ctrl.domain}-${padNum}`;
      counter++;

      // Weakness description: the recorded notes when there are any, else the requirement itself
      const notes = state?.implementationNotes?.trim();
      const weaknessDesc = notes
        ? `Recorded implementation notes: ${notes.substring(0, 160)}${notes.length > 160 ? '...' : ''}`
        : `Control requirement not met: ${ctrl.plainEnglishSummary || ctrl.title}.`;

      // Remediation action plan
      const primaryObjective = ctrl.assessmentObjectives?.[0] || 'Verify technical and administrative safeguards satisfy baseline.';
      const remediationPlan = `1. Complete procedural policy for ${ctrl.title}.\n2. Configure automated technical baseline or identity enforcement.\n3. Validate objective: "${primaryObjective}".\n4. Collect and upload immutable SHA-256 verification artifacts into GRC Vault.`;

      poamEntries.push({
        weaknessId,
        controlId: ctrl.id,
        controlTitle: ctrl.title,
        weaknessDescription: weaknessDesc,
        scheduledCompletionDate: NOT_RECORDED,
        requiredResources: NOT_RECORDED,
        responsibleRole: recordedRole(state?.responsibleRole),
        remediationPlan,
        status,
        milestones: [],
      });
    }
  }

  return poamEntries;
}

/**
 * 1. NIST SP 800-18 / NIST SP 800-171 System Security Plan (SSP) Compiler
 * Applicable for CMMC Level 1, CMMC Level 2, and NIST SP 800-53 Rev 5.
 */
export function compileNistSSP(
  metadata: ReportMetadata,
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  evidence: EvidenceItem[] = []
): CompiledDocument {
  const metrics = calculateSummaryMetrics(controls, controlStates);
  const fwDef = FRAMEWORK_REGISTRY[metadata.framework] || FRAMEWORK_REGISTRY.CMMC_L1;

  // Group controls by family/domain
  const domainGroups: Record<string, FrameworkControlDefinition[]> = {};
  for (const ctrl of controls) {
    const d = ctrl.domain || 'GEN';
    if (!domainGroups[d]) domainGroups[d] = [];
    domainGroups[d].push(ctrl);
  }

  const sections: ReportSection[] = [];

  // Section 1: System Identification & Operational Status
  sections.push({
    id: 'sec-1-system-identification',
    title: '1. System Identification & Governance Information',
    summary: 'Establishes the formal boundary identification, operational categorization, and organizational governance.',
    subsections: [
      {
        title: '1.1 System Identification & Ownership',
        items: [
          { label: 'System Name', value: metadata.systemName || NO_SYSTEM_NAME_RECORDED },
          { label: 'Organization Name', value: metadata.organizationName || NO_ORGANIZATION_RECORDED },
          { label: 'CAGE Code', value: metadata.cageCode || NO_CAGE_CODE_RECORDED },
          { label: 'SAM.gov Status', value: metadata.samStatus || NO_SAM_STATUS_RECORDED },
          { label: 'System Owner', value: metadata.systemOwner || NO_SYSTEM_OWNER_RECORDED },
          { label: 'Primary Assessor / Author', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Operational Status', value: metadata.operationalStatus || 'Operational' },
          { label: 'Document Version', value: metadata.version || '1.0.0' },
          { label: 'Assessment Baseline Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'Classification Level', value: metadata.classificationLevel || 'UNCLASSIFIED // CUI' },
        ],
      },
      {
        title: '1.2 Operational Environment & Authorization Boundary',
        content: metadata.boundaryDescription || NO_BOUNDARY_RECORDED,
      },
      ...(metadata.assetScope
        ? [
            {
              title: '1.2.1 CMMC Asset Scoping Summary',
              content: boundaryNarrative(metadata.assetScope),
              items: [
                ...CMMC_ASSET_CATEGORIES.map((cat) => ({ label: CATEGORY_INFO[cat].label, value: String(metadata.assetScope!.byCategory[cat]) })),
                { label: 'Total In-Scope Assets', value: String(metadata.assetScope.inScope) },
                { label: 'Awaiting Classification', value: String(metadata.assetScope.unconfirmed) },
              ],
            },
          ]
        : []),
      ...(metadata.cryptoModules
        ? [
            {
              title: '1.2.2 FIPS-Validated Cryptographic Modules',
              content:
                metadata.cryptoModules.length > 0
                  ? 'Cryptographic modules protecting CUI, as recorded on the Security Protection Assets in the asset inventory (NIST CMVP certificates).'
                  : 'No FIPS-validated cryptographic module is recorded in the asset inventory for the Security Protection Assets.',
              ...(metadata.cryptoModules.length > 0
                ? {
                    table: {
                      headers: ['CMVP Certificate', 'Cryptographic Module', 'Standard', 'Asset'],
                      rows: metadata.cryptoModules.map((m) => [`#${m.certificateNumber}`, m.moduleName || NOT_RECORDED, m.standard ? `FIPS ${m.standard}` : 'FIPS 140', m.assetName]),
                    },
                  }
                : {}),
            },
          ]
        : []),
      {
        title: '1.3 Cloud Service Providers (CSPs) & Hosting Infrastructure',
        content: metadata.cloudServiceProviders || NO_CSP_RECORDED,
      },
    ],
  });

  // Section 2: Executive Summary & Readiness Posture
  sections.push({
    id: 'sec-2-executive-summary',
    title: '2. Executive Summary & Assessment Posture',
    summary: `Current operational readiness evaluation against ${fwDef.name} (${fwDef.authority}).`,
    table: {
      headers: ['Compliance Metric', 'Evaluated Value', 'Compliance Target', 'Status Evaluation'],
      rows: [
        ['Total Framework Controls', controls.length, `${controls.length} Controls`, 'In Scope'],
        ['Controls MET (Fully Implemented)', metrics.metCount, `${controls.length} Required`, metrics.metCount === controls.length ? (sprsAppliesTo(metadata.framework) ? '100% SPRS Ready' : 'All controls met') : 'Action Required'],
        ['Controls IN PROGRESS', metrics.inProgressCount, '0 Allowed at Final Audit', metrics.inProgressCount === 0 ? 'Optimal' : `${metrics.inProgressCount} Open`],
        ['Controls NOT MET', metrics.notMetCount, '0 Allowed', metrics.notMetCount === 0 ? 'Compliant' : `${metrics.notMetCount} Deficiencies`],
        ['Overall Readiness Score', `${metrics.completionPercentage}%`, '100%', metrics.completionPercentage === 100 ? 'Fully Compliant' : 'Deficiency Remediation Needed'],
      ],
    },
  });

  // Section 3: Detailed Control Implementation Statements by Family
  const controlSubsections = Object.entries(domainGroups).map(([domainCode, domainCtrls]) => {
    const domainMeta = fwDef.domains[domainCode];
    const domainTitle = domainMeta ? `${domainMeta.name} (${domainCode})` : `Family: ${domainCode}`;

    const rows = domainCtrls.map(ctrl => {
      const cState = controlStates[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      let narrative = cState?.implementationNotes || 'No implementation narrative documented.';
      // 3.13.11: cite the validated modules from the asset inventory (plain text: this is a table cell)
      if (metadata.cryptoModules && isCryptographicProtectionControl(ctrl.id)) {
        narrative = applyFipsModules(narrative, metadata.cryptoModules, { bold: false });
      }
      const role = recordedRole(cState?.responsibleRole);
      const ctrlEvidence = evidence.filter(e => e.controlId === ctrl.id);
      const evidenceSummary = ctrlEvidence.length > 0
        ? ctrlEvidence.map(e => `${e.name} [SHA-256: ${(e.fileHash || 'N/A').substring(0, 8)}...]`).join('; ')
        : 'No files attached';

      return [
        ctrl.id,
        ctrl.title,
        ctrl.authorityReference || fwDef.authority,
        status,
        narrative,
        role,
        evidenceSummary,
      ];
    });

    return {
      title: domainTitle,
      table: {
        headers: ['Control ID', 'Title', 'Authority Reference', 'Status', 'Implementation Narrative', 'Responsible Role', 'Evidence Artifacts'],
        rows,
      },
    };
  });

  sections.push({
    id: 'sec-3-control-narratives',
    title: '3. Security Control Implementation Statements (NIST SP 800-18)',
    summary: 'Detailed operational implementation statements for all controls.',
    subsections: controlSubsections,
  });

  // Section 4: Attestation & Formal Sign-off
  sections.push({
    id: 'sec-4-attestation',
    title: '4. System Security Plan Attestation & Approvals',
    content: `${UNSIGNED_ATTESTATION_NOTE} I hereby attest that the information contained in this System Security Plan represents an accurate, rigorous, and truthful representation of the security controls implemented within ${metadata.systemName || UNNAMED_SYSTEM}. All administrative, technical, and physical safeguards have been verified against ${fwDef.name}.`,
    subsections: [
      {
        title: 'Formal Signatures & Assessment Record',
        items: [
          { label: 'Information System Owner', value: metadata.systemOwner || NO_SYSTEM_OWNER_RECORDED },
          { label: 'Primary Assessor / Lead Auditor', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Signature', value: SIGNATURE_BLANK },
          { label: 'Date signed', value: SIGNATURE_BLANK },
          { label: 'Generated', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  });

  return {
    documentType: 'NIST_SP_800_18_SSP',
    title: `${metadata.organizationName || 'Organization'} — System Security Plan (SSP)`,
    subtitle: `NIST SP 800-18 / NIST SP 800-171 System Security Plan for ${metadata.systemName || UNNAMED_SYSTEM}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates),
  };
}

/**
 * 2. Plan of Action & Milestones (POA&M) Compiler
 * Aggregates all NOT_MET and IN_PROGRESS controls into a structured remediation roadmap.
 */
export function compilePOAM(
  metadata: ReportMetadata,
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>
): CompiledDocument {
  const metrics = calculateSummaryMetrics(controls, controlStates);
  const poamEntries = generatePOAMEntries(controls, controlStates);
  const fwDef = FRAMEWORK_REGISTRY[metadata.framework] || FRAMEWORK_REGISTRY.CMMC_L1;

  const sections: ReportSection[] = [];

  // Section 1: Executive Remediation Summary
  sections.push({
    id: 'poam-sec-1-summary',
    title: '1. Executive Summary & Remediation Velocity',
    summary: `Plan of Action and Milestones tracking unresolved findings, milestones, and required remediation for ${metadata.systemName || UNNAMED_SYSTEM}.`,
    table: {
      headers: ['Tracking Category', 'Count / Metric', 'Compliance Implication'],
      rows: [
        ['Total Evaluated Controls', controls.length, `${fwDef.name} Catalog`],
        ['Compliant Controls (MET)', metrics.metCount, 'Baseline satisfied'],
        ['Active POA&M Weaknesses', poamEntries.length, poamEntries.length > 0 ? 'Remediation actively required' : 'Zero deficiencies on record'],
        ['Controls IN PROGRESS', metrics.inProgressCount, 'Recorded as in progress'],
        ['Controls NOT MET / Unaddressed', metrics.notMetCount + metrics.notStartedCount, 'Recorded as not met or not started'],
      ],
    },
  });

  // Section 2: Master POA&M Tracking Table
  const tableRows = poamEntries.map(entry => [
    entry.weaknessId,
    entry.controlId,
    entry.controlTitle,
    entry.weaknessDescription,
    entry.status,
    entry.scheduledCompletionDate,
    entry.responsibleRole,
    entry.requiredResources,
    entry.remediationPlan,
  ]);

  sections.push({
    id: 'poam-sec-2-matrix',
    title: '2. Master Plan of Action & Milestones Table',
    summary: 'Detailed register of all open security deficiencies, assigned owners, resource allocations, and target completion dates.',
    table: {
      headers: [
        'Weakness ID',
        'Control ID',
        'Requirement Title',
        'Deficiency Description',
        'Current Status',
        'Target Completion Date',
        'Responsible Role',
        'Allocated Resources',
        'Remediation Action Plan',
      ],
      rows: tableRows,
    },
  });

  // Section 3: Milestone Schedule Breakdown
  const milestoneSubsections = poamEntries.map(entry => {
    const milestones = entry.milestones || [];
    const summaryLines = `Responsible Owner: ${entry.responsibleRole} | Target Date: ${entry.scheduledCompletionDate}\nResource Allocation: ${entry.requiredResources}\nDeficiency Summary: ${entry.weaknessDescription}`;
    return {
      title: `Weakness [${entry.weaknessId}] — ${entry.controlId}: ${entry.controlTitle}`,
      content: milestones.length > 0 ? summaryLines : `${summaryLines}\n${NO_MILESTONES_RECORDED}`,
      ...(milestones.length > 0
        ? {
            table: {
              headers: ['Milestone ID', 'Remediation Objective', 'Target Completion Date', 'Resolution Status'],
              rows: milestones.map(m => [
                m.id,
                m.description,
                m.targetDate,
                m.completed ? 'COMPLETED' : 'PENDING',
              ]),
            },
          }
        : {}),
    };
  });

  sections.push({
    id: 'poam-sec-3-milestones',
    title: '3. Intermediate Milestone Action Schedules',
    summary: 'Milestones recorded for each weakness.',
    subsections: milestoneSubsections,
  });

  // Section 4: Governance & Management Sign-Off
  sections.push({
    id: 'poam-sec-4-governance',
    title: '4. Corrective Action Plan Sign-Off',
    content: `${UNSIGNED_ATTESTATION_NOTE} Management agrees to provide the resources this plan records for the corrective action milestones detailed herein.`,
    subsections: [
      {
        title: 'Authorized Approvals',
        items: [
          { label: 'System Owner Attestation', value: metadata.systemOwner || NO_SYSTEM_OWNER_RECORDED },
          { label: 'Lead Assessor Concurrence', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Signature', value: SIGNATURE_BLANK },
          { label: 'Date signed', value: SIGNATURE_BLANK },
          { label: 'Generated', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  });

  return {
    documentType: 'POAM',
    title: `${metadata.organizationName || 'Organization'} — Plan of Action & Milestones (POA&M)`,
    subtitle: `Formal Deficiency Tracking & Corrective Action Plan for ${metadata.systemName || UNNAMED_SYSTEM}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries,
  };
}

/**
 * 3. AICPA SOC 2 Type II System Description Compiler
 * Conforms to AICPA DC 200 (Description Criteria for a Service Organization's System).
 */
export function compileSoc2SystemDescription(
  metadata: ReportMetadata,
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  evidence: EvidenceItem[] = []
): CompiledDocument {
  const metrics = calculateSummaryMetrics(controls, controlStates);

  // Trust Services categories present in this catalog (CC = Security / Common Criteria)
  const soc2CategoryOf = (domain: string): string => /^CC/.test(domain) ? 'CC' : /^PI/.test(domain) ? 'PI' : /^A/.test(domain) ? 'A1' : /^C/.test(domain) ? 'C1' : /^P/.test(domain) ? 'P' : 'CC';
  const SOC2_CATEGORY_NAMES: Array<[string, string]> = [
    ['CC', 'Security (Common Criteria)'],
    ['A1', 'Availability'],
    ['C1', 'Confidentiality'],
    ['PI', 'Processing Integrity'],
    ['P', 'Privacy'],
  ];
  const presentCategories = SOC2_CATEGORY_NAMES.filter(([code]) => controls.some(c => soc2CategoryOf(c.domain || 'CC1') === code));

  // Group controls by SOC 2 criteria (CC1–CC9, A1, C1)
  const criteriaGroups: Record<string, FrameworkControlDefinition[]> = {};
  for (const ctrl of controls) {
    const domain = ctrl.domain || 'CC1';
    if (!criteriaGroups[domain]) criteriaGroups[domain] = [];
    criteriaGroups[domain].push(ctrl);
  }

  const sections: ReportSection[] = [];

  // Section 1: Scope & Principal Service Commitments (DC 200)
  sections.push({
    id: 'soc2-sec-1-scope',
    title: '1. Scope of the System and Principal Service Commitments',
    summary: 'Establishes the service organization system boundary, commitments, and examination period.',
    subsections: [
      {
        title: '1.1 System and Service Identification',
        items: [
          { label: 'Service Organization', value: metadata.organizationName || NO_ORGANIZATION_RECORDED },
          { label: 'System Evaluated', value: metadata.systemName || NO_SYSTEM_NAME_RECORDED },
          { label: 'System Owner', value: metadata.systemOwner || NO_SYSTEM_OWNER_RECORDED },
          { label: 'Independent Service Auditor', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Trust Services Categories in This Assessment', value: presentCategories.length > 0 ? presentCategories.map(([, name]) => name).join(', ') : NOT_RECORDED },
          { label: 'Examination Period', value: NOT_RECORDED },
          { label: 'Assessment Date', value: metadata.assessmentDate || NOT_RECORDED },
          { label: 'Operational State', value: metadata.operationalStatus || 'Operational' },
        ],
      },
      {
        title: '1.2 Principal Service Commitments & System Requirements',
        content: metadata.serviceCommitments?.trim() ? metadata.serviceCommitments : NO_SERVICE_COMMITMENTS_RECORDED,
      },
      {
        title: '1.3 System Boundaries and Subservice Organizations',
        content: `${metadata.boundaryDescription || NO_BOUNDARY_RECORDED} ${metadata.cloudServiceProviders ? `Subservice organizations recorded for this system: ${metadata.cloudServiceProviders.trim().replace(/\.$/, '')}.` : 'No subservice organization is recorded for this system.'}`,
      },
    ],
  });

  // Section 2: Trust Services Criteria Evaluation Summary
  sections.push({
    id: 'soc2-sec-2-summary',
    title: '2. Trust Services Criteria Evaluation Summary',
    summary: `Recorded status across the AICPA Trust Services Categories in this assessment. ${SOC2_TESTS_BY_SERVICE_AUDITOR}`,
    table: {
      headers: ['Trust Criteria Category', 'Control Activities', 'Recorded MET', 'Recorded NOT MET / In Progress', 'Not Started', 'Recorded MET %'],
      rows: [
        ...presentCategories.map(([code, name]) => {
          const catCtrls = controls.filter(c => soc2CategoryOf(c.domain || 'CC1') === code);
          const m = calculateSummaryMetrics(catCtrls, controlStates);
          return [name, catCtrls.length, m.metCount, m.notMetCount + m.inProgressCount, m.notStartedCount, `${m.completionPercentage}%`];
        }),
        ['Overall System Posture', controls.length, metrics.metCount, metrics.notMetCount + metrics.inProgressCount, metrics.notStartedCount, `${metrics.completionPercentage}%`],
      ],
    },
  });

  // Section 3: Control Activities and Tests of Controls
  const criteriaSubsections = Object.entries(criteriaGroups).map(([critCode, critCtrls]) => {
    const fwDef = FRAMEWORK_REGISTRY.SOC_2_TYPE_II;
    const domainMeta = fwDef.domains[critCode];
    const categoryTitle = domainMeta ? `${critCode}: ${domainMeta.name}` : `Criteria: ${critCode}`;

    const rows = critCtrls.map(ctrl => {
      const cState = controlStates[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      const narrative = cState?.implementationNotes || 'No implementation narrative documented.';
      const role = recordedRole(cState?.responsibleRole);
      const ctrlEvidence = evidence.filter(e => e.controlId === ctrl.id);
      const evidenceSummary = ctrlEvidence.length > 0
        ? ctrlEvidence.map(e => `${e.name} (SHA-256: ${(e.fileHash || 'N/A').substring(0, 8)})`).join(', ')
        : 'No files attached';

      return [
        ctrl.id,
        ctrl.title,
        ctrl.authorityReference || 'AICPA TSC 2017',
        status === 'MET' ? 'Met (self-assessed)' : status === 'IN_PROGRESS' ? 'In progress' : status === 'NOT_MET' ? 'Not met' : 'Not started',
        narrative,
        role,
        evidenceSummary,
      ];
    });

    return {
      title: categoryTitle,
      table: {
        headers: ['Criteria Ref', 'Control Activity Title', 'AICPA Reference', 'Recorded Status', 'Control Activity Description', 'Responsible Party', 'Evidence on File'],
        rows,
      },
    };
  });

  sections.push({
    id: 'soc2-sec-3-control-activities',
    title: '3. AICPA Trust Services Control Activities',
    summary: `Detailed specification of control activities implemented by the service organization to meet Trust Services Criteria. ${SOC2_TESTS_BY_SERVICE_AUDITOR}`,
    subsections: criteriaSubsections,
  });

  // Section 4: Complementary User Entity Controls (CUECs)
  sections.push({
    id: 'soc2-sec-4-cuecs',
    title: '4. Complementary User Entity Controls (CUECs) & Third-Party Controls',
    summary: 'Customer responsibilities required to maintain system integrity.',
    subsections: [
      {
        title: '4.1 Required Customer Responsibilities',
        content: NO_CUECS_RECORDED,
      },
      {
        title: '4.2 Subservice Organization Controls (CSOCs)',
        content: metadata.cloudServiceProviders ? NO_SUBSERVICE_RELIANCE_RECORDED : 'No subservice organization is recorded for this system, so no subservice SOC 2 report is relied upon.',
      },
    ],
  });

  // Section 5: Management Assertion
  sections.push({
    id: 'soc2-sec-5-assertion',
    title: '5. Management Assertion',
    content: `${UNSIGNED_ATTESTATION_NOTE} We have prepared the accompanying description titled "System Description for ${metadata.systemName || UNNAMED_SYSTEM}" for customer organizations that have used the system throughout the examination period. We assert that the description fairly presents the system that was designed and implemented in accordance with the description criteria, and the controls stated in the description operated effectively throughout the period to provide reasonable assurance that the service commitments and system requirements were achieved based on the Trust Services Criteria.`,
    subsections: [
      {
        title: 'Attestation Sign-off',
        items: [
          { label: 'Service Organization Management', value: metadata.systemOwner || NO_SYSTEM_OWNER_RECORDED },
          { label: 'Signature', value: SIGNATURE_BLANK },
          { label: 'Date signed', value: SIGNATURE_BLANK },
          { label: 'Generated', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  });

  return {
    documentType: 'SOC_2_SYSTEM_DESCRIPTION',
    title: `${metadata.organizationName || 'Service Organization'} — SOC 2 Type II System Description`,
    subtitle: `AICPA Trust Services Criteria System Description for ${metadata.systemName || UNNAMED_SYSTEM}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates),
  };
}

/**
 * 4. HIPAA Security Assessment & Safeguard Report Compiler
 * Compiles Administrative (§164.308), Physical (§164.310), and Technical (§164.312) Safeguards for ePHI environments.
 */
export function compileHipaaAssessment(
  metadata: ReportMetadata,
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  evidence: EvidenceItem[] = []
): CompiledDocument {
  const metrics = calculateSummaryMetrics(controls, controlStates);

  // Group controls by HIPAA safeguard domain
  const adminCtrls = controls.filter(c => c.domain === 'ADMIN');
  const physCtrls = controls.filter(c => c.domain === 'PHYS');
  const techCtrls = controls.filter(c => c.domain === 'TECH');
  const orgDocCtrls = controls.filter(c => c.domain === 'ORG' || c.domain === 'DOC');

  const sections: ReportSection[] = [];

  // Section 1: Executive Summary & ePHI Boundary Definition
  sections.push({
    id: 'hipaa-sec-1-executive',
    title: '1. Executive Summary & Electronic Protected Health Information (ePHI) Boundary',
    summary: 'Formal HIPAA Security Rule (45 CFR Part 164 Subpart C) risk assessment and safeguard evaluation.',
    subsections: [
      {
        title: '1.1 Entity Information & Regulatory Role',
        items: [
          { label: 'Covered Entity / Business Associate', value: metadata.organizationName || NO_ORGANIZATION_RECORDED },
          { label: 'Designated ePHI System Name', value: metadata.systemName || NO_SYSTEM_NAME_RECORDED },
          { label: 'HIPAA Security Official', value: metadata.systemOwner || NO_SECURITY_OFFICIAL_RECORDED },
          { label: 'Lead Assessor / Auditor', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Evaluation Period / Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'System Operational Status', value: metadata.operationalStatus || 'Operational' },
          { label: 'Target Safeguard Posture', value: '100% Implementation of Required & Addressable Specifications' },
        ],
      },
      {
        title: '1.2 ePHI Environmental Boundary & Data Ingestion Flow',
        content: metadata.boundaryDescription || NO_BOUNDARY_RECORDED,
      },
    ],
  });

  // Helper function to build safeguard evaluation tables
  const buildSafeguardRows = (safeguardCtrls: FrameworkControlDefinition[]) => {
    return safeguardCtrls.map(ctrl => {
      const cState = controlStates[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      const narrative = cState?.implementationNotes || 'No implementation narrative documented.';
      const role = recordedRole(cState?.responsibleRole);
      const ctrlEvidence = evidence.filter(e => e.controlId === ctrl.id);
      const evidenceSummary = ctrlEvidence.length > 0
        ? ctrlEvidence.map(e => `${e.name} [SHA-256: ${(e.fileHash || 'N/A').substring(0, 8)}]`).join(', ')
        : 'No files attached';

      return [
        ctrl.id,
        ctrl.title,
        ctrl.authorityReference || '45 CFR Part 164',
        status === 'MET' ? 'Compliant / Implemented' : status === 'IN_PROGRESS' ? 'Remediation Underway' : 'Deficiency / Gap',
        narrative,
        role,
        evidenceSummary,
      ];
    });
  };

  // Section 2: Administrative Safeguards (§164.308)
  sections.push({
    id: 'hipaa-sec-2-admin',
    title: '2. §164.308 Administrative Safeguards Evaluation',
    summary: 'Security management process, assigned security responsibility, workforce training, information access, and contingency planning.',
    table: {
      headers: ['Regulation (§)', 'Safeguard Standard', 'Authority Citation', 'Compliance Posture', 'Implementation Specification Narrative', 'Assigned Lead', 'Evidence Documentation'],
      rows: buildSafeguardRows(adminCtrls),
    },
  });

  // Section 3: Physical Safeguards (§164.310)
  sections.push({
    id: 'hipaa-sec-3-phys',
    title: '3. §164.310 Physical Safeguards Evaluation',
    summary: 'Facility access controls, workstation security and use policies, device and media disposal protocols.',
    table: {
      headers: ['Regulation (§)', 'Safeguard Standard', 'Authority Citation', 'Compliance Posture', 'Implementation Specification Narrative', 'Assigned Lead', 'Evidence Documentation'],
      rows: buildSafeguardRows(physCtrls),
    },
  });

  // Section 4: Technical Safeguards (§164.312)
  sections.push({
    id: 'hipaa-sec-4-tech',
    title: '4. §164.312 Technical Safeguards Evaluation',
    summary: 'Access control mechanisms, unique user identification, audit controls, data integrity, and end-to-end transmission encryption.',
    table: {
      headers: ['Regulation (§)', 'Safeguard Standard', 'Authority Citation', 'Compliance Posture', 'Implementation Specification Narrative', 'Assigned Lead', 'Evidence Documentation'],
      rows: buildSafeguardRows(techCtrls),
    },
  });

  // Section 5: Organizational & Documentation Requirements (§164.314 & §164.316)
  if (orgDocCtrls.length > 0) {
    sections.push({
      id: 'hipaa-sec-5-org-doc',
      title: '5. §164.314 & §164.316 Organizational & Documentation Safeguards',
      summary: 'Business Associate Agreements (BAAs), written policy retention (6 years), and periodic review schedules.',
      table: {
        headers: ['Regulation (§)', 'Safeguard Standard', 'Authority Citation', 'Compliance Posture', 'Implementation Specification Narrative', 'Assigned Lead', 'Evidence Documentation'],
        rows: buildSafeguardRows(orgDocCtrls),
      },
    });
  }

  // Section 6: Risk Remediation Roadmap & Security Official Attestation
  sections.push({
    id: 'hipaa-sec-6-attestation',
    title: '6. Risk Remediation Roadmap & HIPAA Officer Attestation',
    content: `${UNSIGNED_ATTESTATION_NOTE} This security assessment evaluates the recorded safeguard status against the Department of Health and Human Services (HHS) HIPAA Security Rule.`,
    subsections: [
      {
        title: 'Official Attestation of Compliance',
        items: [
          { label: 'Designated HIPAA Security Official', value: metadata.systemOwner || NO_SECURITY_OFFICIAL_RECORDED },
          { label: 'Lead Assessor / Risk Analyst', value: metadata.primaryAssessor || NO_ASSESSOR_RECORDED },
          { label: 'Signature', value: SIGNATURE_BLANK },
          { label: 'Date signed', value: SIGNATURE_BLANK },
          { label: 'Generated', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'Compliance Score', value: `${metrics.completionPercentage}% of Safeguards Implemented (${metrics.metCount}/${metrics.totalControls})` },
        ],
      },
    ],
  });

  return {
    documentType: 'HIPAA_SECURITY_ASSESSMENT',
    title: `${metadata.organizationName || 'Entity'} — HIPAA Security Assessment & Safeguard Report`,
    subtitle: `45 CFR Part 164 Subpart C Evaluation for ePHI System: ${metadata.systemName || UNNAMED_SYSTEM}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates),
  };
}

/**
 * Universal compiler router: Compiles the requested document type using the appropriate generator.
 */
export function compileReportDocument(
  documentType: ReportDocumentType,
  metadata: ReportMetadata,
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  evidence: EvidenceItem[] = []
): CompiledDocument {
  switch (documentType) {
    case 'NIST_SP_800_18_SSP':
      return compileNistSSP(metadata, controls, controlStates, evidence);
    case 'POAM':
      return compilePOAM(metadata, controls, controlStates);
    case 'SOC_2_SYSTEM_DESCRIPTION':
      return compileSoc2SystemDescription(metadata, controls, controlStates, evidence);
    case 'HIPAA_SECURITY_ASSESSMENT':
      return compileHipaaAssessment(metadata, controls, controlStates, evidence);
    default:
      return compileNistSSP(metadata, controls, controlStates, evidence);
  }
}
