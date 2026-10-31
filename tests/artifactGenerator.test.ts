/**
 * Dynamic SSP & Artifact Generator Upgrade Test Suite
 * Validates Ticket 1.2 functionality for Event Horizon GRC (PBC-GRC)
 */

import {
  compileNistSSP,
  compilePOAM,
  compileSoc2SystemDescription,
  compileHipaaAssessment,
  compileReportDocument,
  getDefaultDocumentTypeForFramework,
  generatePOAMEntries,
  calculateSummaryMetrics,
  NO_CSP_RECORDED,
} from '../src/data/reports/documentCompilers';
import {
  generatePrintableHtml,
  generateMachineReadablePackage,
  generatePoamCsv,
  computeSha256,
} from '../src/data/reports/reportExporters';
import {
  getFrameworkControls,
  FRAMEWORK_REGISTRY,
} from '../src/data/frameworks';
import { ReportMetadata, ReportSection } from '../src/types/report';
import { NO_CSP_RECORDED as NO_CSP_DEFAULT, NO_ORGANIZATION_RECORDED, NO_SYSTEM_NAME_RECORDED, NO_SYSTEM_OWNER_RECORDED, NO_SECURITY_OFFICIAL_RECORDED, NO_ASSESSOR_RECORDED, NO_CAGE_CODE_RECORDED, NO_SAM_STATUS_RECORDED, NO_BOUNDARY_RECORDED, NO_SERVICE_COMMITMENTS_RECORDED } from '../src/data/reports/documentDefaults';
import { getExportGaps } from '../src/data/reports/exportReadiness';
import { createDefaultSspMetadata, scrubInventedMetadata } from '../src/services/storageService';
import type { Tenant } from '../src/types/tenant';
import { ControlState, EvidenceItem, AssessmentState } from '../src/types/cmmc';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function runArtifactGeneratorTests() {
  console.log('\n================================================================');
  console.log('🛡️  EVENT HORIZON GRC - TICKET 1.2 AUTOMATED TEST SUITE');
  console.log('   Dynamic SSP & Artifact Generator Engine');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------
    // Mock Test Data
    // -------------------------------------------------------------
    const mockMetadata: ReportMetadata = {
      systemName: 'Defense Contracting Information Network (DCIN)',
      organizationName: 'Vanguard Defense Systems, LLC',
      cageCode: '8K3R1',
      samStatus: 'ACTIVE',
      systemOwner: 'Alex Mercer, CMMC CCA',
      primaryAssessor: 'Dr. Evelyn Reed, Lead C3PAO Assessor',
      boundaryDescription: 'Corporate M365 enclave, GCP FedRAMP-equivalent storage, Windows 11 Enterprise endpoints, and corporate gateway firewalls.',
      systemEnvironment: 'Hybrid Cloud SaaS & Corporate Facility On-Premises Network.',
      operationalStatus: 'Operational',
      cloudServiceProviders: 'Google Cloud Platform, Microsoft 365 GCC High, Cloudflare.',
      classificationLevel: 'UNCLASSIFIED // CUI',
      assessmentDate: '2026-09-15',
      version: '1.2.0',
      framework: 'CMMC_L1',
    };

    const cmmcL1Controls = getFrameworkControls('CMMC_L1');
    const cmmcL2Controls = getFrameworkControls('CMMC_L2');
    const nistControls = getFrameworkControls('NIST_800_53_REV5');
    const soc2Controls = getFrameworkControls('SOC_2_TYPE_II');
    const hipaaControls = getFrameworkControls('HIPAA_SECURITY');

    // Create partial mock states: some MET, some IN_PROGRESS, some NOT_MET
    const mockControlStates: Record<string, ControlState> = {};
    cmmcL1Controls.forEach((ctrl, idx) => {
      let status: 'MET' | 'IN_PROGRESS' | 'NOT_MET' = 'MET';
      if (idx === 0) status = 'IN_PROGRESS';
      if (idx === 1) status = 'NOT_MET';

      mockControlStates[ctrl.id] = {
        id: ctrl.id,
        status,
        implementationNotes: `Operational statement for ${ctrl.id}: Access enforcement implemented via IdP policies.`,
        responsibleRole: 'CISO / Security Engineering Lead',
        lastUpdated: '2026-09-14T10:00:00Z',
        tags: ['Automated', 'Identity'],
      };
    });

    const mockEvidence: EvidenceItem[] = [
      {
        id: 'ev-1',
        tenantId: 'tenant-vanguard-01',
        controlId: 'AC.L1-3.1.1',
        name: 'access_control_policy_v2.pdf',
        fileSize: 1048576,
        mimeType: 'application/pdf',
        uploadedAt: '2026-09-14T10:30:00Z',
        fileHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        gcsPath: 'gs://pbc-grc-vault/tenant-vanguard-01/controls/AC.L1-3.1.1/policy.pdf',
      },
    ];

    // -------------------------------------------------------------
    // Test 1: Framework Registry Default Document Types
    // -------------------------------------------------------------
    console.log('--- Test 1: Framework Registry Default Document Types ---');
    assert(
      getDefaultDocumentTypeForFramework('CMMC_L1') === 'NIST_SP_800_18_SSP',
      'CMMC_L1 defaults to NIST SP 800-18 SSP'
    );
    assert(
      getDefaultDocumentTypeForFramework('CMMC_L2') === 'NIST_SP_800_18_SSP',
      'CMMC_L2 defaults to NIST SP 800-18 SSP'
    );
    assert(
      getDefaultDocumentTypeForFramework('NIST_800_53_REV5') === 'NIST_SP_800_18_SSP',
      'NIST SP 800-53 defaults to NIST SP 800-18 SSP'
    );
    assert(
      getDefaultDocumentTypeForFramework('SOC_2_TYPE_II') === 'SOC_2_SYSTEM_DESCRIPTION',
      'SOC 2 Type II defaults to SOC 2 System Description'
    );
    assert(
      getDefaultDocumentTypeForFramework('HIPAA_SECURITY') === 'HIPAA_SECURITY_ASSESSMENT',
      'HIPAA Security defaults to HIPAA Security Assessment'
    );

    // -------------------------------------------------------------
    // Test 2: NIST SP 800-18 / 800-171 System Security Plan (SSP) Compiler
    // -------------------------------------------------------------
    console.log('\n--- Test 2: NIST SP 800-18 / 800-171 SSP Compiler ---');
    const sspDoc = compileNistSSP(mockMetadata, cmmcL1Controls, mockControlStates, mockEvidence);

    assert(sspDoc.documentType === 'NIST_SP_800_18_SSP', 'Document type is NIST_SP_800_18_SSP');
    assert(sspDoc.title.includes('Vanguard Defense Systems'), 'Title includes organization name');
    assert(sspDoc.sections.length === 4, `Compiled exactly 4 standard NIST SP 800-18 sections (found: ${sspDoc.sections.length})`);
    assert(sspDoc.sections[0].id === 'sec-1-system-identification', 'Section 1 is System Identification & Governance');
    assert(sspDoc.sections[1].id === 'sec-2-executive-summary', 'Section 2 is Executive Summary & Posture');
    assert(sspDoc.sections[2].id === 'sec-3-control-narratives', 'Section 3 is Security Control Implementation Statements');
    assert(sspDoc.sections[3].id === 'sec-4-attestation', 'Section 4 is System Security Plan Attestation');

    // Verify metadata items in section 1
    const sec1Items = sspDoc.sections[0].subsections?.[0].items || [];
    assert(sec1Items.some(i => i.label === 'CAGE Code' && i.value === '8K3R1'), 'Section 1 contains correct CAGE code');
    assert(sec1Items.some(i => i.label === 'System Name' && i.value.includes('DCIN')), 'Section 1 contains correct System Name');
    assert(sec1Items.some(i => i.label === 'Operational Status' && i.value === 'Operational'), 'Section 1 contains Operational Status');

    // Verify control implementation statements grouped by family
    const sec3Subsections = sspDoc.sections[2].subsections || [];
    assert(sec3Subsections.length > 0, `Section 3 groups controls into domain families (found: ${sec3Subsections.length})`);
    assert(sec3Subsections.some(s => s.title.includes('AC') || s.title.includes('Access Control')), 'Section 3 contains Access Control family');

    // Verify evidence SHA-256 inclusion
    const acFamily = sec3Subsections.find(s => s.title.includes('AC'));
    const acRows = acFamily?.table?.rows || [];
    const ctrl1Row = acRows.find(r => (Array.isArray(r) ? r[0] : r.cells[0]) === 'AC.L1-3.1.1');
    assert(Boolean(ctrl1Row), 'Found AC.L1-3.1.1 control row in family table');
    const evidenceCell = Array.isArray(ctrl1Row) ? ctrl1Row[6] : ctrl1Row?.cells[6];
    assert(String(evidenceCell).includes('access_control_policy_v2.pdf'), 'Evidence item listed in control row');
    assert(String(evidenceCell).includes('SHA-256: e3b0c442'), 'Evidence SHA-256 digest included');

    // -------------------------------------------------------------
    // Test 3: Plan of Action & Milestones (POA&M) Compiler
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Plan of Action & Milestones (POA&M) Compiler ---');
    const poamDoc = compilePOAM(mockMetadata, cmmcL1Controls, mockControlStates);

    assert(poamDoc.documentType === 'POAM', 'Document type is POAM');
    assert(poamDoc.poamEntries !== undefined && poamDoc.poamEntries.length === 2, `POA&M aggregated exactly 2 unmet/in-progress controls (found: ${poamDoc.poamEntries?.length})`);

    const entry1 = poamDoc.poamEntries?.[0];
    assert(Boolean(entry1?.weaknessId.startsWith('POAM-')), `Generated structured weakness ID (found: ${entry1?.weaknessId})`);
    assert(Boolean(entry1?.scheduledCompletionDate), `Generated scheduled completion date (found: ${entry1?.scheduledCompletionDate})`);
    assert(Boolean(entry1?.requiredResources), `Included allocated resources (found: ${entry1?.requiredResources})`);
    assert(Boolean(entry1?.responsibleRole), `Included responsible role (found: ${entry1?.responsibleRole})`);
    assert(Boolean(entry1?.remediationPlan.includes('Validate objective')), 'Generated actionable remediation plan with objectives');
    assert(Boolean(entry1?.milestones && entry1.milestones.length === 3), 'Generated 3 tactical intermediate milestones per weakness');

    // Verify POA&M master table
    const poamMatrixSec = poamDoc.sections.find(s => s.id === 'poam-sec-2-matrix');
    assert(Boolean(poamMatrixSec && poamMatrixSec.table?.rows.length === 2), 'POA&M master table contains rows for all weaknesses');

    // -------------------------------------------------------------
    // Test 4: SOC 2 Type II System Description Compiler
    // -------------------------------------------------------------
    console.log('\n--- Test 4: AICPA SOC 2 Type II System Description Compiler ---');
    const soc2Meta: ReportMetadata = {
      ...mockMetadata,
      framework: 'SOC_2_TYPE_II',
      classificationLevel: 'CONFIDENTIAL',
    };
    const mockSoc2States: Record<string, ControlState> = {};
    soc2Controls.forEach(ctrl => {
      mockSoc2States[ctrl.id] = {
        id: ctrl.id,
        status: 'MET',
        implementationNotes: `Operational control activity verified for ${ctrl.id}.`,
        responsibleRole: 'Security Operations Lead',
        lastUpdated: '2026-09-14T10:00:00Z',
        tags: ['SOC2', 'AICPA'],
      };
    });

    const soc2Doc = compileSoc2SystemDescription(soc2Meta, soc2Controls, mockSoc2States, mockEvidence);
    assert(soc2Doc.documentType === 'SOC_2_SYSTEM_DESCRIPTION', 'Document type is SOC_2_SYSTEM_DESCRIPTION');
    assert(soc2Doc.sections.length === 5, `Compiled 5 AICPA DC 200 sections (found: ${soc2Doc.sections.length})`);
    assert(soc2Doc.sections[0].id === 'soc2-sec-1-scope', 'Section 1 is Scope of System & Principal Service Commitments');
    assert(soc2Doc.sections[1].id === 'soc2-sec-2-summary', 'Section 2 is Trust Services Criteria Evaluation Summary');
    assert(soc2Doc.sections[2].id === 'soc2-sec-3-control-activities', 'Section 3 is Trust Services Control Activities');
    assert(soc2Doc.sections[3].id === 'soc2-sec-4-cuecs', 'Section 4 is Complementary User Entity Controls (CUECs)');
    assert(soc2Doc.sections[4].id === 'soc2-sec-5-assertion', 'Section 5 is Management Assertion');

    // Check Trust Services Categories (CC1-CC9, A1, C1)
    const critSubs = soc2Doc.sections[2].subsections || [];
    assert(critSubs.some(s => s.title.includes('CC1')), 'Contains CC1 Control Environment criteria');
    assert(critSubs.some(s => s.title.includes('CC6')), 'Contains CC6 Logical Access criteria');

    // #122: no document invents a cloud vendor; an empty provider list says so
    const subOf = (doc: typeof soc2Doc, sectionId: string, prefix: string) =>
      (doc.sections.find(s => s.id === sectionId)?.subsections || []).find(s => s.title.startsWith(prefix));
    const VENDOR_NAMES = /Google|Cloudflare|Cloud SQL|Microsoft/;
    const noCspSsp = compileNistSSP({ ...mockMetadata, cloudServiceProviders: '' }, cmmcL1Controls, mockControlStates);
    const csp13 = (noCspSsp.sections[0].subsections || []).find(s => s.title.startsWith('1.3'));
    assert(csp13?.content === NO_CSP_RECORDED, 'SSP 1.3 states that no cloud service provider is recorded when none is');
    const withCspSsp = compileNistSSP(mockMetadata, cmmcL1Controls, mockControlStates);
    const csp13Set = (withCspSsp.sections[0].subsections || []).find(s => s.title.startsWith('1.3'));
    assert(csp13Set?.content === mockMetadata.cloudServiceProviders, 'SSP 1.3 states the recorded cloud service providers');

    const noCspSoc2 = compileSoc2SystemDescription({ ...soc2Meta, cloudServiceProviders: '', boundaryDescription: '' }, soc2Controls, mockSoc2States, mockEvidence);
    const soc213 = subOf(noCspSoc2, 'soc2-sec-1-scope', '1.3');
    const soc242 = subOf(noCspSoc2, 'soc2-sec-4-cuecs', '4.2');
    assert(!!soc213 && !VENDOR_NAMES.test(soc213.content || '') && (soc213.content || '').includes('No subservice organization is recorded'), 'SOC 2 1.3 names no vendor and no subservice organization when none is recorded');
    assert(!!soc242 && !VENDOR_NAMES.test(soc242.content || ''), 'SOC 2 4.2 names no vendor when none is recorded');
    const acmeSoc2 = compileSoc2SystemDescription({ ...soc2Meta, cloudServiceProviders: 'Acme Hosting.' }, soc2Controls, mockSoc2States, mockEvidence);
    assert((subOf(acmeSoc2, 'soc2-sec-1-scope', '1.3')?.content || '').includes('Subservice organizations recorded for this system: Acme Hosting.'), 'SOC 2 1.3 lists the recorded subservice organization with one period');

    // -------------------------------------------------------------
    // Test 5: HIPAA Security Assessment & Safeguard Report Compiler
    // -------------------------------------------------------------
    console.log('\n--- Test 5: HIPAA Security Assessment Compiler ---');
    const hipaaMeta: ReportMetadata = {
      ...mockMetadata,
      framework: 'HIPAA_SECURITY',
      classificationLevel: 'RESTRICTED // LAW ENFORCEMENT SENSITIVE',
    };
    const mockHipaaStates: Record<string, ControlState> = {};
    hipaaControls.forEach(ctrl => {
      mockHipaaStates[ctrl.id] = {
        id: ctrl.id,
        status: 'MET',
        implementationNotes: `Safeguard operationalized for ePHI under ${ctrl.id}.`,
        responsibleRole: 'HIPAA Security Officer',
        lastUpdated: '2026-09-14T10:00:00Z',
        tags: ['HIPAA', 'ePHI'],
      };
    });

    const hipaaDoc = compileHipaaAssessment(hipaaMeta, hipaaControls, mockHipaaStates, mockEvidence);
    assert(hipaaDoc.documentType === 'HIPAA_SECURITY_ASSESSMENT', 'Document type is HIPAA_SECURITY_ASSESSMENT');
    assert(hipaaDoc.sections.some(s => s.id === 'hipaa-sec-1-executive'), 'Contains ePHI Boundary Executive Summary');
    assert(hipaaDoc.sections.some(s => s.id === 'hipaa-sec-2-admin'), 'Contains §164.308 Administrative Safeguards');
    assert(hipaaDoc.sections.some(s => s.id === 'hipaa-sec-3-phys'), 'Contains §164.310 Physical Safeguards');
    assert(hipaaDoc.sections.some(s => s.id === 'hipaa-sec-4-tech'), 'Contains §164.312 Technical Safeguards');
    assert(hipaaDoc.sections.some(s => s.id === 'hipaa-sec-6-attestation'), 'Contains Security Official Attestation');

    // -------------------------------------------------------------
    // Test 6: Universal Report Compiler Router
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Universal Report Compiler Router ---');
    const routedSsp = compileReportDocument('NIST_SP_800_18_SSP', mockMetadata, cmmcL1Controls, mockControlStates);
    assert(routedSsp.documentType === 'NIST_SP_800_18_SSP', 'Router compiles NIST_SP_800_18_SSP');

    const routedPoam = compileReportDocument('POAM', mockMetadata, cmmcL1Controls, mockControlStates);
    assert(routedPoam.documentType === 'POAM', 'Router compiles POAM');

    const routedSoc2 = compileReportDocument('SOC_2_SYSTEM_DESCRIPTION', soc2Meta, soc2Controls, mockSoc2States);
    assert(routedSoc2.documentType === 'SOC_2_SYSTEM_DESCRIPTION', 'Router compiles SOC_2_SYSTEM_DESCRIPTION');

    const routedHipaa = compileReportDocument('HIPAA_SECURITY_ASSESSMENT', hipaaMeta, hipaaControls, mockHipaaStates);
    assert(routedHipaa.documentType === 'HIPAA_SECURITY_ASSESSMENT', 'Router compiles HIPAA_SECURITY_ASSESSMENT');

    // -------------------------------------------------------------
    // Test 7: Printable HTML / PDF Document Engine
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Printable HTML / PDF Engine ---');
    const htmlOutput = generatePrintableHtml(sspDoc, { theme: 'light' });

    assert(htmlOutput.includes('<!DOCTYPE html>'), 'HTML begins with standard DOCTYPE');
    assert(htmlOutput.includes('@media print'), 'HTML includes @media print rules');
    assert(htmlOutput.includes('page-break-after: always'), 'HTML includes page break rules for cover page');
    assert(htmlOutput.includes('classification-banner'), 'HTML includes classification banner');
    assert(htmlOutput.includes('UNCLASSIFIED // CUI'), 'Classification banner contains classification level');
    assert(htmlOutput.includes('cover-title'), 'HTML includes formal cover page title');
    assert(htmlOutput.includes('signature-grid'), 'HTML includes executive signature block');
    assert(htmlOutput.includes('Alex Mercer, CMMC CCA'), 'Signature block includes System Owner');
    assert(htmlOutput.includes('Dr. Evelyn Reed'), 'Signature block includes Primary Assessor');
    assert(htmlOutput.includes('status-badge'), 'HTML renders stylized compliance status badges');

    // Dark theme support check
    const darkHtml = generatePrintableHtml(sspDoc, { theme: 'dark' });
    assert(darkHtml.includes('#0f172a'), 'Dark theme embeds slate dark background color');

    // -------------------------------------------------------------
    // Test 8: Structured Machine-Readable JSON Package Generator
    // -------------------------------------------------------------
    console.log('\n--- Test 8: Machine-Readable JSON Package Generator ---');
    const mockAssessmentState: AssessmentState = {
      version: '2.0.0',
      tenantId: 'tenant-vanguard-01',
      sspMetadata: {
        systemName: mockMetadata.systemName,
        organizationName: mockMetadata.organizationName,
        cageCode: mockMetadata.cageCode,
        systemOwner: mockMetadata.systemOwner,
        authorName: mockMetadata.primaryAssessor,
        assessmentDate: mockMetadata.assessmentDate,
        systemBoundaryScope: mockMetadata.boundaryDescription,
        systemEnvironment: mockMetadata.systemEnvironment,
        cloudServiceProviders: mockMetadata.cloudServiceProviders,
        version: mockMetadata.version,
      },
      controls: mockControlStates,
      evidenceIndex: mockEvidence,
      lastSaved: '2026-09-14T12:00:00Z',
    };

    const pkg = await generateMachineReadablePackage(sspDoc, mockAssessmentState);
    assert(pkg.schemaVersion === '2.0.0', 'JSON package schemaVersion is 2.0.0');
    assert(pkg.tenantId === 'tenant-vanguard-01', 'Package tenantId matches active tenant');
    assert(pkg.framework === 'CMMC_L1', 'Package framework matches assessment framework');
    assert(Boolean(pkg.integrityChecksum), `Generated SHA-256 integrity checksum (found: ${pkg.integrityChecksum.substring(0, 16)}...)`);
    assert(Object.keys(pkg.controls).length === cmmcL1Controls.length, `Package contains all evaluated controls (count: ${Object.keys(pkg.controls).length})`);
    const domainStats = pkg.metrics.domainStats;
    const domainTotal = Object.values(domainStats).reduce((sum, d) => sum + d.total, 0);
    assert(Object.keys(domainStats).length > 0, `Package metrics contain populated domain stats (domains: ${Object.keys(domainStats).join(', ')})`);
    assert(domainTotal === pkg.metrics.totalControls, 'Domain stats totals reconcile with totalControls');
    assert(pkg.evidenceIndex.length === 1, 'Package contains evidence index with hashes');
    assert(pkg.evidenceIndex[0].fileHash === mockEvidence[0].fileHash, 'Evidence SHA-256 hash preserved');

    // Verify SHA-256 computation utility
    const testHash = await computeSha256('EVENT_HORIZON_GRC_AUDIT_PAYLOAD');
    assert(testHash.length === 64, `SHA-256 hex digest has exact 64 character length (found: ${testHash.length})`);

    // -------------------------------------------------------------
    // Test 9: POA&M CSV Exporter
    // -------------------------------------------------------------
    console.log('\n--- Test 9: POA&M CSV Exporter ---');
    const csvOutput = generatePoamCsv(poamDoc.poamEntries || []);
    assert(csvOutput.includes('"Weakness ID","Control ID","Control Title"'), 'CSV contains standard POA&M headers');
    assert(csvOutput.includes('POAM-'), 'CSV contains generated weakness IDs');
    assert(csvOutput.includes('AC.L1-3.1.1'), 'CSV contains control ID');
    assert(csvOutput.includes('"IN_PROGRESS"') || csvOutput.includes('"NOT_MET"'), 'CSV contains status values');

    // -------------------------------------------------------------
    // Test 10: #151 a document says "not recorded" instead of inventing a value
    // -------------------------------------------------------------
    console.log('\n--- Test 10: #151 not-recorded values ---');
    const blank: ReportMetadata = { ...mockMetadata, systemName: '', organizationName: '', cageCode: '', samStatus: '', systemOwner: '', primaryAssessor: '', boundaryDescription: '', cloudServiceProviders: '' };
    const INVENTED_151 = [
      'Pitch Black Cyber', 'Health Technologies Group', 'Defense Contracting Information Network', 'Enterprise SaaS Multi-Tenant Platform',
      'Electronic Health Data Enclave', 'Defense Industrial Base Contractor', 'Corporate Operations Enclave', '99.95', 'uptime availability',
      'encrypted at rest using AES-256', 'bi-weekly', 'reviewed monthly', 'Third-Party Compliance Assessor', 'Third-Party Healthcare Compliance Assessor',
      'AICPA Certified CPA Firm', 'Lead Information System Owner', 'operations and compliance boundary', 'Organization Enclave', 'Lead Compliance Assessor',
      'Compliance & Audit Assessment Team', 'The system boundary encompasses', 'The ePHI boundary encompasses', 'automated continuous checks verified',
    ];
    const itemOf = (doc: { sections: ReportSection[] }, label: string) => {
      for (const sec of doc.sections) for (const sub of sec.subsections || []) for (const it of sub.items || []) if (it.label === label) return it.value;
      return undefined;
    };
    const subTitled = (doc: { sections: ReportSection[] }, prefix: string) => {
      for (const sec of doc.sections) for (const sub of sec.subsections || []) if (sub.title.startsWith(prefix)) return sub;
      return undefined;
    };
    const blankSsp = compileNistSSP(blank, cmmcL1Controls, mockControlStates);
    assert(itemOf(blankSsp, 'System Name') === NO_SYSTEM_NAME_RECORDED, 'S151-1 SSP 1.1 states no system name is recorded');
    assert(itemOf(blankSsp, 'Organization Name') === NO_ORGANIZATION_RECORDED, 'S151-1 SSP 1.1 states no organization is recorded');
    assert(itemOf(blankSsp, 'CAGE Code') === NO_CAGE_CODE_RECORDED, 'S151-1 SSP 1.1 states no CAGE code is recorded');
    assert(itemOf(blankSsp, 'SAM.gov Status') === NO_SAM_STATUS_RECORDED, 'S151-1 SSP 1.1 states no SAM status is recorded');
    assert(itemOf(blankSsp, 'System Owner') === NO_SYSTEM_OWNER_RECORDED, 'S151-1 SSP 1.1 states no system owner is recorded');
    assert(itemOf(blankSsp, 'Primary Assessor / Author') === NO_ASSESSOR_RECORDED, 'S151-1 SSP 1.1 states no assessor is recorded');
    assert(subTitled(blankSsp, '1.2')?.content === NO_BOUNDARY_RECORDED, 'S151-2 SSP 1.2 states no boundary is recorded');
    assert(blankSsp.subtitle === 'NIST SP 800-18 / NIST SP 800-171 System Security Plan for the system', 'S151-3 SSP subtitle names "the system"');
    assert(itemOf(blankSsp, 'Information System Owner') === NO_SYSTEM_OWNER_RECORDED, 'S151-3 SSP attestation names no invented owner and no signature suffix');
    assert(itemOf(blankSsp, 'Primary Assessor / Lead Auditor') === NO_ASSESSOR_RECORDED, 'S151-3 SSP attestation names no invented assessor and no attested suffix');
    const fullSsp = compileNistSSP(mockMetadata, cmmcL1Controls, mockControlStates);
    assert(itemOf(fullSsp, 'Organization Name') === 'Vanguard Defense Systems, LLC', 'S151-4 SSP 1.1 states the recorded organization');
    assert(subTitled(fullSsp, '1.2')?.content === mockMetadata.boundaryDescription, 'S151-4 SSP 1.2 states the recorded boundary');
    assert(itemOf(fullSsp, 'Information System Owner') === 'Alex Mercer, CMMC CCA (Signature on Record)', 'S151-4 SSP attestation keeps the suffix when the owner is recorded');

    const blankSoc2 = compileSoc2SystemDescription({ ...blank, framework: 'SOC_2_TYPE_II' }, soc2Controls, mockSoc2States, mockEvidence);
    assert(itemOf(blankSoc2, 'Service Organization') === NO_ORGANIZATION_RECORDED && itemOf(blankSoc2, 'System Evaluated') === NO_SYSTEM_NAME_RECORDED, 'S151-5 SOC 2 1.1 states no organization and no system name are recorded');
    assert(itemOf(blankSoc2, 'System Owner') === NO_SYSTEM_OWNER_RECORDED && itemOf(blankSoc2, 'Independent Service Auditor') === NO_ASSESSOR_RECORDED, 'S151-5 SOC 2 1.1 states no owner and no auditor are recorded');
    assert(subTitled(blankSoc2, '1.2')?.content === NO_SERVICE_COMMITMENTS_RECORDED, 'S151-5 SOC 2 1.2 states no service commitments are recorded');
    assert((subTitled(blankSoc2, '1.3')?.content || '').startsWith(NO_BOUNDARY_RECORDED), 'S151-5 SOC 2 1.3 states no boundary is recorded');
    assert((blankSoc2.subtitle || '').endsWith('for the system'), 'S151-5 SOC 2 subtitle names "the system"');
    assert(subTitled(soc2Doc, '1.2')?.content === NO_SERVICE_COMMITMENTS_RECORDED && !JSON.stringify(soc2Doc).includes('99.95'), 'S151-6 SOC 2 invents no uptime commitment even with full metadata');
    const emptySoc2 = compileSoc2SystemDescription(soc2Meta, soc2Controls, {}, mockEvidence);
    const soc2Rows = (emptySoc2.sections.find(s => s.id === 'soc2-sec-3-control-activities')?.subsections || [])
      .flatMap(sub => ((sub.table?.rows || []) as (string | number)[][]).map(r => (Array.isArray(r) ? r : (r as { cells: (string | number)[] }).cells)));
    assert(soc2Rows.length > 0 && soc2Rows.every(r => r[4] === 'No implementation narrative documented.' && r[6] === 'No files attached'), 'S151-7 SOC 2 control rows without a narrative or evidence say so');

    const blankHipaa = compileHipaaAssessment({ ...blank, framework: 'HIPAA_SECURITY' }, hipaaControls, mockHipaaStates, mockEvidence);
    assert(itemOf(blankHipaa, 'Covered Entity / Business Associate') === NO_ORGANIZATION_RECORDED && itemOf(blankHipaa, 'Designated ePHI System Name') === NO_SYSTEM_NAME_RECORDED, 'S151-8 HIPAA 1.1 states no entity and no system name are recorded');
    assert(itemOf(blankHipaa, 'HIPAA Security Official') === NO_SECURITY_OFFICIAL_RECORDED && itemOf(blankHipaa, 'Lead Assessor / Auditor') === NO_ASSESSOR_RECORDED, 'S151-8 HIPAA 1.1 states no security official and no assessor are recorded');
    assert(subTitled(blankHipaa, '1.2')?.content === NO_BOUNDARY_RECORDED, 'S151-8 HIPAA 1.2 states exactly that no boundary is recorded');
    assert((blankHipaa.subtitle || '').endsWith('ePHI System: the system'), 'S151-8 HIPAA subtitle names "the system"');
    assert(subTitled(hipaaDoc, '1.2')?.content === mockMetadata.boundaryDescription, 'S151-9 HIPAA 1.2 is the recorded boundary and nothing appended');
    const hipaaSec6 = hipaaDoc.sections.find(s => s.id === 'hipaa-sec-6-attestation')?.content || '';
    assert(!hipaaSec6.includes('reviewed monthly') && !hipaaSec6.includes('All addressable specifications have been assessed'), 'S151-9 HIPAA section 6 asserts no review cadence or addressable assessment');

    const blankPoam = compilePOAM(blank, cmmcL1Controls, mockControlStates);
    assert(blankPoam.subtitle === 'Formal Deficiency Tracking & Corrective Action Plan for the system', 'S151-10 POA&M subtitle names "the system"');
    assert((blankPoam.sections[0].summary || '').endsWith('for the system.'), 'S151-10 POA&M summary names "the system"');
    assert(!(blankPoam.sections.find(s => s.id === 'poam-sec-4-governance')?.content || '').includes('bi-weekly'), 'S151-10 POA&M states no review cadence');
    assert(itemOf(blankPoam, 'System Owner Attestation') === NO_SYSTEM_OWNER_RECORDED, 'S151-10 POA&M attestation names no invented owner');

    const blankJson = [blankSsp, blankSoc2, blankHipaa, blankPoam].map(d => JSON.stringify(d));
    assert(INVENTED_151.every(lit => blankJson.every(j => !j.includes(lit))), `S151-11 no compiler emits an invented literal for blank metadata (${INVENTED_151.filter(lit => blankJson.some(j => j.includes(lit))).join(' | ')})`);
    const blankHtml = generatePrintableHtml(blankSsp, blank);
    assert(blankHtml.includes('Not recorded • Not recorded') && !blankHtml.includes('• Active<'), 'S151-12 the printable cover page says "Not recorded" for CAGE and SAM');
    assert(NO_CSP_RECORDED === NO_CSP_DEFAULT, 'S151-13 NO_CSP_RECORDED is the one defined in documentDefaults');

    // B-1: export readiness
    assert(getExportGaps('NIST_SP_800_18_SSP', mockMetadata).length === 0, 'B-1 a complete SSP has no export gaps');
    const gapSys = getExportGaps('NIST_SP_800_18_SSP', { ...mockMetadata, systemName: '  ' });
    assert(gapSys.length === 1 && gapSys[0].field === 'systemName', 'B-1 a whitespace-only system name is one gap');
    assert(getExportGaps('POAM', { ...mockMetadata, boundaryDescription: '' }).length === 0, 'B-1 a POA&M needs no boundary description');
    assert(getExportGaps('SOC_2_SYSTEM_DESCRIPTION', blank).length === 4, 'B-1 a blank SOC 2 description has four gaps');
    assert(getExportGaps('NIST_SP_800_18_SSP', { ...mockMetadata, cageCode: '' }).every(g => g.advisory), 'B-1 a missing CAGE code is advisory only');

    // R1: values written by the old "Save & Sync Metadata" read back as never recorded
    const legacyMeta = { ...createDefaultSspMetadata({ id: 't1', name: 'Real Org' } as Tenant), organizationName: 'Organization Enclave', authorName: 'Lead Compliance Assessor', systemBoundaryScope: 'The system boundary encompasses corporate identity tenants, managed endpoints.' };
    const cleanedMeta = scrubInventedMetadata(legacyMeta);
    assert(cleanedMeta.organizationName === '' && cleanedMeta.authorName === '' && cleanedMeta.systemBoundaryScope === '', 'S151-25 the scrub empties the three seeded legacy values');
    assert(scrubInventedMetadata({ ...legacyMeta, authorName: 'Compliance & Audit Assessment Team' }).authorName === '', 'S151-25 the scrub empties the second legacy author value');
    const realMeta = { ...legacyMeta, organizationName: 'Vanguard', authorName: 'Dr. Reed', systemBoundaryScope: 'Our enclave.' };
    assert(scrubInventedMetadata(realMeta) === realMeta, 'S151-25 the scrub leaves real values alone (same object)');

    // -------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
    console.log('================================================================\n');

    if (passedTests !== totalTests) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution encountered fatal error:', err);
    process.exit(1);
  }
}

runArtifactGeneratorTests();
