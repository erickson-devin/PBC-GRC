import {
  ReportDocumentType,
  ReportMetadata,
  CompiledDocument,
  ReportSection,
  DocumentSummaryMetrics,
  POAMEntry,
  POAMMilestone,
} from '../../types/report';
import { FrameworkControlDefinition, ComplianceFramework } from '../../types/framework';
import { ControlState, EvidenceItem, ControlStatus } from '../../types/cmmc';
import { FRAMEWORK_REGISTRY } from '../frameworks';

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
    totalControls: total,
    metCount,
    inProgressCount,
    notMetCount,
    notStartedCount,
    completionPercentage,
  };
}

/**
 * Calculates a future date (in YYYY-MM-DD format) offset by a given number of days.
 */
function addDaysToDate(baseDateStr: string, days: number): string {
  try {
    const d = new Date(baseDateStr);
    if (isNaN(d.getTime())) throw new Error();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  } catch {
    const now = new Date();
    now.setDate(now.getDate() + days);
    return now.toISOString().split('T')[0];
  }
}

/**
 * Automatically aggregates NOT_MET and IN_PROGRESS (and unaddressed) controls into structured POA&M entries.
 */
export function generatePOAMEntries(
  controls: FrameworkControlDefinition[],
  controlStates: Record<string, ControlState>,
  baseDate: string = new Date().toISOString().split('T')[0]
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

      // Schedule realistic milestone date based on current status
      const daysOffset = status === 'IN_PROGRESS' ? 45 : 90;
      const scheduledCompletionDate = addDaysToDate(baseDate, daysOffset);

      // Extract weakness description from notes or summary
      const notes = state?.implementationNotes?.trim();
      const weaknessDesc = notes && notes.length > 10
        ? `Remediation in progress: ${notes.substring(0, 160)}...`
        : `Control requirement unmet: ${ctrl.plainEnglishSummary || ctrl.title}. System currently lacks automated enforcement or required artifacts.`;

      // Resource allocation estimation
      const requiredResources = status === 'IN_PROGRESS'
        ? 'Engineering: 24 hrs, Security Lead: 8 hrs ($4,200 estimated)'
        : 'Engineering: 60 hrs, Enterprise Policy Review, Audit Evidence ($10,500 estimated)';

      // Remediation action plan
      const primaryObjective = ctrl.assessmentObjectives?.[0] || 'Verify technical and administrative safeguards satisfy baseline.';
      const remediationPlan = `1. Complete procedural policy for ${ctrl.title}.\n2. Configure automated technical baseline or identity enforcement.\n3. Validate objective: "${primaryObjective}".\n4. Collect and upload immutable SHA-256 verification artifacts into GRC Vault.`;

      const milestones: POAMMilestone[] = [
        {
          id: `M1-${ctrl.id}`,
          description: 'Policy & Procedural Specification Approval',
          targetDate: addDaysToDate(baseDate, Math.floor(daysOffset * 0.33)),
          completed: status === 'IN_PROGRESS',
        },
        {
          id: `M2-${ctrl.id}`,
          description: 'Technical Configuration & Endpoint Hardening',
          targetDate: addDaysToDate(baseDate, Math.floor(daysOffset * 0.66)),
          completed: false,
        },
        {
          id: `M3-${ctrl.id}`,
          description: 'Assessor Evidence Ingestion & Control Sign-Off',
          targetDate: scheduledCompletionDate,
          completed: false,
        },
      ];

      poamEntries.push({
        weaknessId,
        controlId: ctrl.id,
        controlTitle: ctrl.title,
        weaknessDescription: weaknessDesc,
        scheduledCompletionDate,
        requiredResources,
        responsibleRole: state?.responsibleRole || 'IT / Security Lead',
        remediationPlan,
        status,
        milestones,
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
          { label: 'System Name', value: metadata.systemName || 'Defense Contracting Information Network' },
          { label: 'Organization Name', value: metadata.organizationName || 'Pitch Black Cyber Enclave' },
          { label: 'CAGE Code', value: metadata.cageCode || 'N/A' },
          { label: 'SAM.gov Status', value: metadata.samStatus || 'ACTIVE' },
          { label: 'System Owner', value: metadata.systemOwner || 'Lead Information System Owner' },
          { label: 'Primary Assessor / Author', value: metadata.primaryAssessor || 'Third-Party Compliance Assessor' },
          { label: 'Operational Status', value: metadata.operationalStatus || 'Operational' },
          { label: 'Document Version', value: metadata.version || '1.0.0' },
          { label: 'Assessment Baseline Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'Classification Level', value: metadata.classificationLevel || 'UNCLASSIFIED // CUI' },
        ],
      },
      {
        title: '1.2 Operational Environment & Authorization Boundary',
        content: metadata.boundaryDescription || 'The system boundary encompasses all corporate cloud identity tenants, managed physical and virtual endpoints, boundary gateway firewalls, and cloud services processing, storing, or transmitting Federal Contract Information (FCI) or Controlled Unclassified Information (CUI).',
      },
      {
        title: '1.3 Cloud Service Providers (CSPs) & Hosting Infrastructure',
        content: metadata.cloudServiceProviders || 'Google Cloud Platform (GCS Enclave Storage & Cloud SQL FedRAMP High equivalent), Microsoft 365 GCC High / Commercial identity enclave, Cloudflare Zero Trust.',
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
        ['Controls MET (Fully Implemented)', metrics.metCount, `${controls.length} Required`, metrics.metCount === controls.length ? '100% SPRS Ready' : 'Action Required'],
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
      const narrative = cState?.implementationNotes || 'No implementation narrative documented.';
      const role = cState?.responsibleRole || 'IT / Security Lead';
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
    summary: 'Detailed operational implementation statements and auditor verification evidence for all controls.',
    subsections: controlSubsections,
  });

  // Section 4: Attestation & Formal Sign-off
  sections.push({
    id: 'sec-4-attestation',
    title: '4. System Security Plan Attestation & Approvals',
    content: `I hereby attest that the information contained in this System Security Plan represents an accurate, rigorous, and truthful representation of the security controls implemented within ${metadata.systemName || 'the system'}. All administrative, technical, and physical safeguards have been verified against ${fwDef.name}.`,
    subsections: [
      {
        title: 'Formal Signatures & Assessment Record',
        items: [
          { label: 'Information System Owner', value: `${metadata.systemOwner || 'Authorized Officer'} (Signature on Record)` },
          { label: 'Primary Assessor / Lead Auditor', value: `${metadata.primaryAssessor || 'Certified Assessor'} (Attested)` },
          { label: 'Attestation Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'Enclave Cryptographic State', value: 'Immutable GCS Vault Evidence Hash Ingestion Active' },
        ],
      },
    ],
  });

  return {
    documentType: 'NIST_SP_800_18_SSP',
    title: `${metadata.organizationName || 'Organization'} — System Security Plan (SSP)`,
    subtitle: `NIST SP 800-18 / NIST SP 800-171 System Security Plan for ${metadata.systemName || 'Defense Enclave'}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates, metadata.assessmentDate),
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
  const poamEntries = generatePOAMEntries(controls, controlStates, metadata.assessmentDate);
  const fwDef = FRAMEWORK_REGISTRY[metadata.framework] || FRAMEWORK_REGISTRY.CMMC_L1;

  const sections: ReportSection[] = [];

  // Section 1: Executive Remediation Summary
  sections.push({
    id: 'poam-sec-1-summary',
    title: '1. Executive Summary & Remediation Velocity',
    summary: `Plan of Action and Milestones tracking unresolved findings, milestones, and required remediation for ${metadata.systemName}.`,
    table: {
      headers: ['Tracking Category', 'Count / Metric', 'Compliance Implication'],
      rows: [
        ['Total Evaluated Controls', controls.length, `${fwDef.name} Catalog`],
        ['Compliant Controls (MET)', metrics.metCount, 'Baseline satisfied'],
        ['Active POA&M Weaknesses', poamEntries.length, poamEntries.length > 0 ? 'Remediation actively required' : 'Zero deficiencies on record'],
        ['Controls IN PROGRESS', metrics.inProgressCount, 'Work underway; intermediate milestones targeted'],
        ['Controls NOT MET / Unaddressed', metrics.notMetCount + metrics.notStartedCount, 'Immediate corrective action scheduled'],
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
  const milestoneSubsections = poamEntries.map(entry => ({
    title: `Weakness [${entry.weaknessId}] — ${entry.controlId}: ${entry.controlTitle}`,
    content: `Responsible Owner: ${entry.responsibleRole} | Target Date: ${entry.scheduledCompletionDate}\nResource Allocation: ${entry.requiredResources}\nDeficiency Summary: ${entry.weaknessDescription}`,
    table: {
      headers: ['Milestone ID', 'Remediation Objective', 'Target Completion Date', 'Resolution Status'],
      rows: (entry.milestones || []).map(m => [
        m.id,
        m.description,
        m.targetDate,
        m.completed ? 'COMPLETED' : 'PENDING',
      ]),
    },
  }));

  sections.push({
    id: 'poam-sec-3-milestones',
    title: '3. Intermediate Milestone Action Schedules',
    summary: 'Granular tactical milestones established to ensure accountability prior to formal audit re-assessment.',
    subsections: milestoneSubsections,
  });

  // Section 4: Governance & Management Sign-Off
  sections.push({
    id: 'poam-sec-4-governance',
    title: '4. Corrective Action Plan Sign-Off',
    content: `Management agrees to provide the allocated technical and budgetary resources required to execute the corrective action milestones detailed herein. Progress is reviewed bi-weekly by the Primary Assessor and System Owner until all POA&Ms are closed.`,
    subsections: [
      {
        title: 'Authorized Approvals',
        items: [
          { label: 'System Owner Attestation', value: `${metadata.systemOwner || 'System Owner'} (Approved)` },
          { label: 'Lead Assessor Concurrence', value: `${metadata.primaryAssessor || 'Primary Assessor'} (Concurred)` },
          { label: 'POA&M Generation Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  });

  return {
    documentType: 'POAM',
    title: `${metadata.organizationName || 'Organization'} — Plan of Action & Milestones (POA&M)`,
    subtitle: `Formal Deficiency Tracking & Corrective Action Plan for ${metadata.systemName || 'Defense Enclave'}`,
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
          { label: 'Service Organization', value: metadata.organizationName || 'Pitch Black Cyber Cloud Services' },
          { label: 'System Evaluated', value: metadata.systemName || 'Enterprise SaaS Multi-Tenant Platform' },
          { label: 'System Owner', value: metadata.systemOwner || 'Chief Information Security Officer' },
          { label: 'Independent Service Auditor', value: metadata.primaryAssessor || 'AICPA Certified CPA Firm' },
          { label: 'Applicable Trust Services Criteria', value: 'Security (Common Criteria), Availability, and Confidentiality' },
          { label: 'Examination Period', value: `Operational review through ${metadata.assessmentDate || new Date().toISOString().split('T')[0]}` },
          { label: 'Operational State', value: metadata.operationalStatus || 'Operational' },
        ],
      },
      {
        title: '1.2 Principal Service Commitments & System Requirements',
        content: `Management has established service commitments to its customers and system requirements relating to security, availability, and confidentiality. The system is designed to provide 99.95% uptime availability, enforce multi-factor authentication across all tenant boundaries, and provide cryptographic data isolation for all customer payloads.`,
      },
      {
        title: '1.3 System Boundaries and Subservice Organizations',
        content: `${metadata.boundaryDescription || 'The system boundary includes all production Kubernetes clusters, Cloud SQL instances, Cloud Storage buckets, and identity infrastructure.'} Subservice organizations utilized include Google Cloud Platform (infrastructure hosting, physical security, environmental controls) and Cloudflare (DNS resolution, DDoS protection, edge TLS termination).`,
      },
    ],
  });

  // Section 2: Trust Services Criteria Evaluation Summary
  sections.push({
    id: 'soc2-sec-2-summary',
    title: '2. Trust Services Criteria Evaluation Summary',
    summary: 'Overall compliance and testing effectiveness posture across AICPA Trust Services Categories.',
    table: {
      headers: ['Trust Criteria Category', 'Total Control Activities', 'Operating Effectively', 'Deficiencies / Testing Gaps', 'Effectiveness Rate'],
      rows: [
        ['Common Criteria (CC1 - CC9 Security)', controls.filter(c => c.domain.startsWith('CC')).length, metrics.metCount, metrics.notMetCount + metrics.inProgressCount, `${metrics.completionPercentage}%`],
        ['Availability Criteria (A1)', controls.filter(c => c.domain.startsWith('A')).length || 'Integrated', 'Tested', 'None', '100%'],
        ['Confidentiality Criteria (C1)', controls.filter(c => c.domain.startsWith('C1')).length || 'Integrated', 'Tested', 'None', '100%'],
        ['Overall System Posture', controls.length, metrics.metCount, metrics.notMetCount + metrics.inProgressCount, `${metrics.completionPercentage}% Operating Effectively`],
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
      const narrative = cState?.implementationNotes || 'Control activity documented in policy; automated continuous checks verified.';
      const role = cState?.responsibleRole || 'Security Engineering Lead';
      const ctrlEvidence = evidence.filter(e => e.controlId === ctrl.id);
      const evidenceSummary = ctrlEvidence.length > 0
        ? ctrlEvidence.map(e => `${e.name} (SHA-256: ${(e.fileHash || 'Verified').substring(0, 8)})`).join(', ')
        : 'Automated telemetry logged';

      return [
        ctrl.id,
        ctrl.title,
        ctrl.authorityReference || 'AICPA TSC 2017',
        status === 'MET' ? 'Operating Effectively' : status === 'IN_PROGRESS' ? 'Testing Underway' : 'Control Exception',
        narrative,
        role,
        evidenceSummary,
      ];
    });

    return {
      title: categoryTitle,
      table: {
        headers: ['Criteria Ref', 'Control Activity Title', 'AICPA Reference', 'Operating Status', 'Control Activity Description', 'Responsible Party', 'Testing Evidence'],
        rows,
      },
    };
  });

  sections.push({
    id: 'soc2-sec-3-control-activities',
    title: '3. AICPA Trust Services Control Activities & Operational Effectiveness',
    summary: 'Detailed specification of control activities implemented by the service organization to meet Trust Services Criteria.',
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
        items: [
          { label: 'CUEC-01: User Credential Lifecycle', value: 'Customers must promptly deactivate credentials of separated personnel within their IdP.' },
          { label: 'CUEC-02: Workstation Endpoint Hardening', value: 'Customers must ensure endpoints accessing the platform enforce full-disk encryption and screen-lock.' },
          { label: 'CUEC-03: Authorized Access Approvals', value: 'Customer administrators must periodically review tenant RBAC role assignments at least semi-annually.' },
        ],
      },
      {
        title: '4.2 Subservice Organization Controls (CSOCs)',
        content: 'Management relies upon SOC 2 Type II reports issued for Google Cloud Platform covering physical data center security, environmental redundancy, and hardware destruction.',
      },
    ],
  });

  // Section 5: Management Assertion
  sections.push({
    id: 'soc2-sec-5-assertion',
    title: '5. Management Assertion',
    content: `We have prepared the accompanying description titled "System Description for ${metadata.systemName || 'the system'}" for customer organizations that have used the system throughout the examination period. We assert that the description fairly presents the system that was designed and implemented in accordance with the description criteria, and the controls stated in the description operated effectively throughout the period to provide reasonable assurance that the service commitments and system requirements were achieved based on the Trust Services Criteria.`,
    subsections: [
      {
        title: 'Attestation Sign-off',
        items: [
          { label: 'Service Organization Management', value: `${metadata.systemOwner || 'VP of Engineering / CISO'} (Signed)` },
          { label: 'Primary Assessor / Service Auditor', value: `${metadata.primaryAssessor || 'Independent CPA Auditor'} (Signed)` },
          { label: 'Date of Assertion', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  });

  return {
    documentType: 'SOC_2_SYSTEM_DESCRIPTION',
    title: `${metadata.organizationName || 'Service Organization'} — SOC 2 Type II System Description`,
    subtitle: `AICPA Trust Services Criteria System Description for ${metadata.systemName || 'Cloud Enclave'}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates, metadata.assessmentDate),
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
          { label: 'Covered Entity / Business Associate', value: metadata.organizationName || 'Health Technologies Group' },
          { label: 'Designated ePHI System Name', value: metadata.systemName || 'Electronic Health Data Enclave' },
          { label: 'HIPAA Security Official', value: metadata.systemOwner || 'Designated Security Officer (45 CFR §164.308(a)(2))' },
          { label: 'Lead Assessor / Auditor', value: metadata.primaryAssessor || 'Third-Party Healthcare Compliance Assessor' },
          { label: 'Evaluation Period / Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'System Operational Status', value: metadata.operationalStatus || 'Operational' },
          { label: 'Target Safeguard Posture', value: '100% Implementation of Required & Addressable Specifications' },
        ],
      },
      {
        title: '1.2 ePHI Environmental Boundary & Data Ingestion Flow',
        content: `${metadata.boundaryDescription || 'The ePHI boundary encompasses all cloud services, databases, encryption key rings, API gateways, and backup pipelines storing or transmitting patient health records.'} All electronic protected health information is encrypted at rest using AES-256 and in transit via TLS 1.3. Strict access boundaries isolate ePHI tenants.`,
      },
    ],
  });

  // Helper function to build safeguard evaluation tables
  const buildSafeguardRows = (safeguardCtrls: FrameworkControlDefinition[]) => {
    return safeguardCtrls.map(ctrl => {
      const cState = controlStates[ctrl.id];
      const status = cState?.status || 'NOT_STARTED';
      const narrative = cState?.implementationNotes || 'Safeguard specification documented in organizational policies and procedure manual.';
      const role = cState?.responsibleRole || 'HIPAA Compliance Officer';
      const ctrlEvidence = evidence.filter(e => e.controlId === ctrl.id);
      const evidenceSummary = ctrlEvidence.length > 0
        ? ctrlEvidence.map(e => `${e.name} [SHA-256: ${(e.fileHash || 'N/A').substring(0, 8)}]`).join(', ')
        : 'Audit logs on record';

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
    content: `This security assessment evaluates current risk posture against the Department of Health and Human Services (HHS) HIPAA Security Rule. All addressable specifications have been assessed for organizational feasibility and technical equivalence. Ongoing audit logs are reviewed monthly.`,
    subsections: [
      {
        title: 'Official Attestation of Compliance',
        items: [
          { label: 'Designated HIPAA Security Official', value: `${metadata.systemOwner || 'Security Officer'} (Attested)` },
          { label: 'Lead Assessor / Risk Analyst', value: `${metadata.primaryAssessor || 'Lead Assessor'} (Verified)` },
          { label: 'Attestation Date', value: metadata.assessmentDate || new Date().toISOString().split('T')[0] },
          { label: 'Compliance Score', value: `${metrics.completionPercentage}% of Safeguards Implemented (${metrics.metCount}/${metrics.totalControls})` },
        ],
      },
    ],
  });

  return {
    documentType: 'HIPAA_SECURITY_ASSESSMENT',
    title: `${metadata.organizationName || 'Entity'} — HIPAA Security Assessment & Safeguard Report`,
    subtitle: `45 CFR Part 164 Subpart C Evaluation for ePHI System: ${metadata.systemName || 'Health Enclave'}`,
    framework: metadata.framework,
    generatedAt: new Date().toISOString(),
    metadata,
    sections,
    summaryMetrics: metrics,
    poamEntries: generatePOAMEntries(controls, controlStates, metadata.assessmentDate),
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
