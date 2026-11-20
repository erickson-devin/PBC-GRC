// Document register (#240) and expected documents checklist (#250): pure types and limits, shared by the server and the client.
// Titles, owners, locations and notes can be sensitive: they are never logged and history records digests only.

export const DOCUMENT_KINDS = ['PLAN', 'POLICY', 'PROCEDURE', 'PROCESS', 'REFERENCE', 'REVIEW_ASSESSMENT', 'ARTIFACT'] as const; // PROCESS = worksheets
export type DocumentKind = typeof DOCUMENT_KINDS[number];

export const DOCUMENT_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const;
export type DocumentStatus = typeof DOCUMENT_STATUSES[number];

// GENERATED / AI_ASSISTED documents need confirmReviewed to be approved.
export const DOCUMENT_ORIGINS = ['MANUAL', 'GENERATED', 'AI_ASSISTED'] as const;
export type DocumentOrigin = typeof DOCUMENT_ORIGINS[number];

export const MAX_DOCUMENTS_PER_TENANT = 2000;
export const MAX_CONTROLS_PER_DOCUMENT = 1200;
export const MAX_DOCUMENT_LINKS_PER_PROGRAM = 20000;
export const MAX_ATTACHMENTS_PER_DOCUMENT = 50;
export const MAX_EXPECTATION_LINKS_PER_PROGRAM = 2000;
export const REVIEW_DUE_SOON_DAYS = 30;

export interface GovernanceDocument {
  id: string;
  tenantId: string;
  kind: DocumentKind;
  title: string;
  reference: string;
  owner: string;
  version: string;
  status: DocumentStatus;
  approvalDate: string | null;
  reviewBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  locationUrl: string | null;
  origin: DocumentOrigin;
  seedKey: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

// status, approvalDate and the approver fields are never writable through create or update.
export type DocumentInput = Partial<Pick<GovernanceDocument, 'kind' | 'title' | 'reference' | 'owner' | 'reviewBy' | 'locationUrl' | 'notes'>> & { version?: string };

export interface DocumentAttachment {
  documentId: string;
  evidenceId: string;
  isPrimary: boolean;
  linkedAt: string;
  linkedBy: string | null;
}

export interface ProgramDocuments {
  programId: string;
  declared: boolean;
  documentIds: string[];
  controlLinks: { documentId: string; controlId: string }[];
  attachments: DocumentAttachment[];
  expectations: { expectedId: string; documentId: string }[];
}

export type ReviewState = 'NOT_SET' | 'OVERDUE' | 'DUE_SOON' | 'CURRENT' | 'NOT_APPLICABLE';
