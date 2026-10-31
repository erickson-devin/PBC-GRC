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
  authorityReference?: string; // framework-agnostic alias of farReference
  domainName?: string; // human-readable domain / family name
  plainEnglishSummary: string;
  discussion: string;
  assessmentObjectives: string[];
  auditorChecklist: string[];
  starterTemplates: StarterTemplate[];
}

export type EvidenceSyncStatus =
  | 'local_cached'
  | 'local_storage'
  | 'gcs_synced' // legacy rows from a former cloud deployment
  | 'gcs_signed_url' // legacy rows from a former cloud deployment
  | 'inherited'; // evidence reused from an equivalent control in another framework

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
  gcsPath?: string; // legacy field name: the path in the local vault, e.g. "tenants/tenant-1/controls/AC.L1-3.1.1/file_xyz.pdf"
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
  updatedAt?: string | null; // the server's stored timestamp (null: no row yet)
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
  /** The program this state was loaded for (absent for a browser-only tenant, or a state saved before programs); with tenantId it is the save guard's scope. */
  programId?: string;
  sspMetadata: SSPMetadata;
  controls: Record<string, ControlState>;
  evidenceIndex: EvidenceItem[];
  lastSaved: string;
  objectives?: Record<string, AssessmentObjective>;
  /** ISO time the client set once every cached objective narrative of this cache key is on the server; until then narratives stay in the cache. */
  objectivesMigratedAt?: string;
  /** Objective ids the server reported as conflicts; their narratives stay in the cache until the user resolves them. */
  objectivesPendingReview?: string[];
  /** ISO time the client set once this cache key's SSP metadata is on the server; from then on the cache holds none of it (#84). */
  sspMetadataMigratedAt?: string;
}

export interface DomainStat {
  total: number;
  met: number;
  inProgress: number;
  notStarted: number;
  notMet: number;
  percentage: number;
}

export interface ComplianceMetrics {
  totalControls: number;
  metCount: number;
  inProgressCount: number;
  notStartedCount: number;
  notMetCount: number;
  completionPercentage: number;
  isSprsReady: boolean;
  /** Keyed by the active framework's domain / family code (e.g. 'AC', 'CC6', 'TECH'). */
  domainStats: Record<string, DomainStat>;
}
