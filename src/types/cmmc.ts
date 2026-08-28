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

export interface EvidenceItem {
  id: string;
  controlId: string;
  name: string;
  fileSize: number; // in bytes
  mimeType: string;
  uploadedAt: string; // ISO string
  description?: string;
  hasBlob?: boolean; // stored in IndexedDB
}

export interface ControlState {
  id: string;
  status: ControlStatus;
  implementationNotes: string;
  responsibleRole: string;
  lastUpdated: string;
  tags: string[];
}

export interface SSPMetadata {
  systemName: string;
  organizationName: string;
  cageCode: string;
  systemOwner: string;
  authorName: string;
  assessmentDate: string;
  systemBoundaryScope: string;
  systemEnvironment: string;
  cloudServiceProviders: string;
  version: string;
}

export interface AssessmentState {
  version: string;
  sspMetadata: SSPMetadata;
  controls: Record<string, ControlState>;
  evidenceIndex: EvidenceItem[];
  lastSaved: string;
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
