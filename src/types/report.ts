import { ComplianceFramework, BaselineTier } from './framework';
import { ControlStatus, ComplianceMetrics, DomainStat } from './cmmc';
import type { AssetScopeSummary } from '../data/telemetry/assetScope';

export type ReportDocumentType =
  | 'NIST_SP_800_18_SSP'
  | 'POAM'
  | 'SOC_2_SYSTEM_DESCRIPTION'
  | 'HIPAA_SECURITY_ASSESSMENT';

export type SystemOperationalStatus =
  | 'Operational'
  | 'Under Development'
  | 'Major Modification'
  | 'Decommissioning';

export type DocumentClassificationLevel =
  | 'UNCLASSIFIED // CUI'
  | 'CONFIDENTIAL'
  | 'PROPRIETARY'
  | 'RESTRICTED // LAW ENFORCEMENT SENSITIVE'
  | 'PUBLIC';

export interface ReportMetadata {
  systemName: string;
  organizationName: string;
  cageCode: string;
  samStatus: string;
  systemOwner: string;
  primaryAssessor: string;
  boundaryDescription: string;
  systemEnvironment: string;
  operationalStatus: SystemOperationalStatus;
  cloudServiceProviders: string;
  classificationLevel: DocumentClassificationLevel;
  assessmentDate: string;
  version: string;
  framework: ComplianceFramework;
  baselineTier?: BaselineTier;
  /**
   * The enclave's CMMC asset scope (counts per category). When present, the SSP states it in the boundary section; when
   * absent (inventory not loaded) the SSP makes no claim about asset counts.
   */
  assetScope?: AssetScopeSummary;
}

export interface POAMMilestone {
  id: string;
  description: string;
  targetDate: string;
  completed?: boolean;
}

export interface POAMEntry {
  weaknessId: string;
  controlId: string;
  controlTitle: string;
  weaknessDescription: string;
  scheduledCompletionDate: string;
  requiredResources: string;
  responsibleRole: string;
  remediationPlan: string;
  status: ControlStatus | 'OPEN' | 'DELAYED';
  milestones?: POAMMilestone[];
}

export interface ReportTableRow {
  cells: (string | number)[];
  highlight?: 'success' | 'warning' | 'danger' | 'info';
}

export interface ReportTable {
  headers: string[];
  rows: (string | number)[][] | ReportTableRow[];
}

export interface ReportSubsection {
  title: string;
  content?: string;
  items?: { label: string; value: string }[];
  table?: ReportTable;
}

export interface ReportSection {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  subsections?: ReportSubsection[];
  table?: ReportTable;
}

export interface DocumentSummaryMetrics {
  totalControls: number;
  metCount: number;
  inProgressCount: number;
  notMetCount: number;
  notStartedCount: number;
  completionPercentage: number;
  domainStats: Record<string, DomainStat>;
}

export interface CompiledDocument {
  documentType: ReportDocumentType;
  title: string;
  subtitle: string;
  framework: ComplianceFramework;
  generatedAt: string;
  metadata: ReportMetadata;
  sections: ReportSection[];
  summaryMetrics: DocumentSummaryMetrics;
  poamEntries?: POAMEntry[];
}

export interface MachineReadablePackage {
  schemaVersion: string;
  packageId: string;
  tenantId: string;
  framework: ComplianceFramework;
  exportTimestamp: string;
  integrityChecksum: string;
  metadata: ReportMetadata;
  metrics: ComplianceMetrics;
  controls: Record<string, {
    status: ControlStatus;
    implementationNotes: string;
    responsibleRole: string;
    lastUpdated: string;
    tags: string[];
    evidenceCount: number;
  }>;
  evidenceIndex: {
    id: string;
    controlId: string;
    name: string;
    fileSize: number;
    mimeType: string;
    uploadedAt: string;
    fileHash?: string;
    gcsPath?: string;
  }[];
  poamEntries?: POAMEntry[];
}
