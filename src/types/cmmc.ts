import { FailingAssetInfo } from './telemetry';
import { AssessmentObjective } from './assessment';

export type ControlStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'MET' | 'NOT_MET';

export type DomainCode = 'AC' | 'IA' | 'MP' | 'PE' | 'SC' | 'SI';

export interface DomainInfo {
  code: DomainCode;
  name: string;
  description: string;
  totalControls: number;
  iconName: string;
  color: string;
}

export interface StarterTemplate {
  title: string;
  description: string;
  category: 'm365' | 'activedirectory' | 'physical' | 'gcp';
  narrative: string;
  recommendedEvidence: string[];
}

export interface ControlDefinition {
  id: string; // e.g. "AC.L1-3.1.1"
  title: string;
  domain: DomainCode;
  farReference: string; // e.g. "FAR 52.204-21(b)(1)(i)"
  plainEnglishSummary: string;
  discussion: string;
  assessmentObjectives: string[];
  auditorChecklist: string[];
  starterTemplates: StarterTemplate[];
}

export type EvidenceSyncStatus = 'local_cached' | 'gcs_synced' | 'gcs_signed_url';

export interface EvidenceItem {
  id: string;
  tenantId: string; // Multi-tenant isolation key
  controlId: string;
  name: string;
  fileSize: number; // in bytes
  mimeType: string;
  uploadedAt: string; // ISO string
  description?: string;
  hasBlob?: boolean; // stored in IndexedDB vault
  gcsPath?: string; // e.g. "gs://pbc-grc-evidence-prod/tenants/tenant-1/controls/AC.L1-3.1.1/file_xyz.pdf"
  fileHash?: string; // SHA-256 hex string for immutability verification
  syncStatus?: EvidenceSyncStatus;
  uploadedBy?: string;
}

export interface ControlState {
  id: string;
  tenantId?: string; // Multi-tenant isolation key
  status: ControlStatus;
  implementationNotes: string;
  responsibleRole: string;
  lastUpdated: string;
  tags: string[];
  updatedBy?: string;
  failingAssets?: FailingAssetInfo[];
  telemetrySyncedAt?: string;
}

export interface SSPMetadata {
  tenantId?: string; // Multi-tenant isolation key
  systemName: string;
  organizationName: string;
  cageCode: string;
  samStatus?: string;
  systemOwner: string;
  authorName: string;
  assessmentDate: string;
  systemBoundaryScope: string;
  systemEnvironment: string;
  cloudServiceProviders: string;
  version: string;
  lastUpdated?: string;
}

export interface AssessmentState {
  version: string;
  tenantId: string; // Multi-tenant root partition
  sspMetadata: SSPMetadata;
  controls: Record<string, ControlState>;
  evidenceIndex: EvidenceItem[];
  lastSaved: string;
  objectives?: Record<string, AssessmentObjective>;
}

export interface ComplianceMetrics {
  totalControls: number;
  metCount: number;
  inProgressCount: number;
  notStartedCount: number;
  notMetCount: number;
  completionPercentage: number;
  isSprsReady: boolean;
  domainStats: Record<DomainCode, {
    total: number;
    met: number;
    inProgress: number;
    notStarted: number;
    notMet: number;
    percentage: number;
  }>;
}
