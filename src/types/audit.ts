/**
 * Event Horizon: Singularity - Cryptographic Audit Ledger & Compliance Safeguard Types
 * Complies with NIST SP 800-171 3.3 (Audit and Accountability) & DFARS 252.204-7012.
 */

export type AuditActionType =
  | 'CONTROL_STATUS_UPDATED'
  | 'CONTROL_NOTES_UPDATED'
  | 'LEDGER_REDACTED'
  | 'CONTROL_ROLE_UPDATED'
  | 'TEMPLATE_APPLIED'
  | 'EVIDENCE_UPLOADED'
  | 'EVIDENCE_DELETED'
  | 'DOCUMENT_GENERATED'
  | 'DOCUMENT_EXPORTED'
  | 'SPRS_CALCULATED'
  | 'EMASS_EXPORTED'
  | 'RBAC_ROLE_MODIFIED'
  | 'DATA_RETENTION_APPLIED'
  | 'CRYPTOGRAPHIC_WIPE_PERFORMED'
  | 'ASSESSMENT_RESET'
  | 'TELEMETRY_INGESTED';

export interface AuditLogEntry {
  id: string;
  sequenceNumber: number;
  timestamp: string; // ISO 8601 UTC
  tenantId: string;
  actorId: string;
  actorEmail: string;
  actorRole?: string;
  actionType: AuditActionType;
  targetEntity: string; // e.g. "AC.L1-3.1.1", "evidence-7a91b", "NIST_SP_800_18_SSP"
  previousState?: unknown;
  newState?: unknown;
  metadata?: Record<string, unknown>;
  previousHash: string; // SHA-256 hash of preceding entry in chain
  sha256Hash: string; // SHA-256 digest of this entry payload + previousHash
}

export interface AuditVerificationResult {
  isValid: boolean;
  totalEntries: number;
  brokenIndex?: number;
  brokenEntryId?: string;
  verifiedTimestamp: string;
  rootHash: string;
  headHash: string;
  errorMessage?: string;
}

export interface AuditFilterOptions {
  startDate?: string;
  endDate?: string;
  actorEmail?: string;
  actionType?: AuditActionType | 'ALL';
  targetEntity?: string;
  searchQuery?: string;
}

export interface CertificateOfDestruction {
  certificateId: string;
  tenantId: string;
  systemName: string;
  cageCode?: string;
  actorName: string;
  actorEmail: string;
  destructionDate: string;
  complianceStandard: 'DFARS 252.204-7012' | 'NIST SP 800-88 Rev 1' | 'DoD 5220.22-M';
  sanitizationMethod: 'Cryptographic Erase (Overwriting + Key Revocation)';
  purgedObjectsCount: number;
  auditTrailReference: string;
  certificateSha256: string;
}

export interface SprsScoreResult {
  /** null when the score cannot be calculated (no completed SSP): never display a number in that case. */
  score: number | null;
  scoreStatus: 'SCORED' | 'NOT_SCORED';
  notScoredReason?: string;
  /** What is still missing from the SSP (empty when scored). */
  sspGaps: string[];
  maxScore: number;
  minScore?: number;
  totalControls: number;
  metCount: number;
  inProgressCount: number;
  notMetCount: number;
  notStartedCount: number;
  totalDeductions: number;
  deductionsByWeight: {
    fivePoint: string[];
    threePoint: string[];
    onePoint: string[];
  };
  completionPercentage: number;
}
