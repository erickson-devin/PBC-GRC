/**
 * Event Horizon: Singularity - Immutable Cryptographic Audit Ledger Engine
 * Implements tamper-evident SHA-256 hash chaining adhering to NIST SP 800-171 3.3.1 & 3.3.2.
 */

import {
  AuditActionType,
  AuditLogEntry,
  AuditVerificationResult,
  AuditFilterOptions,
} from '../../types/audit';
import { computeSha256, canonicalJson } from './cryptoUtils';

// Re-export so existing consumers of auditLogger can keep their imports unchanged
export { computeSha256, canonicalJson } from './cryptoUtils';


export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';


/**
 * Builds the canonical string representation of an audit entry for hash computation.
 */
export function createCanonicalEntryPayload(
  sequenceNumber: number,
  timestamp: string,
  tenantId: string,
  actorEmail: string,
  actionType: AuditActionType,
  targetEntity: string,
  previousState: any,
  newState: any,
  metadata: any,
  previousHash: string
): string {
  const obj = {
    sequenceNumber,
    timestamp,
    tenantId,
    actorEmail,
    actionType,
    targetEntity,
    previousState: previousState === undefined ? null : previousState,
    newState: newState === undefined ? null : newState,
    metadata: metadata || {},
    previousHash,
  };
  return canonicalJson(obj);
}

// In-memory tenant cache for fast lookup & Node.js execution
const memoryLedgers: Record<string, AuditLogEntry[]> = {};

/**
 * Loads audit trail entries for a specific tenant from persistent storage.
 */
export function loadLedger(tenantId: string): AuditLogEntry[] {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = window.localStorage.getItem(`pbc_audit_ledger_${tenantId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          memoryLedgers[tenantId] = parsed;
          return parsed;
        }
      }
    } catch (err) {
      console.warn('Failed to load audit ledger from localStorage:', err);
    }
  }

  if (!memoryLedgers[tenantId]) {
    memoryLedgers[tenantId] = [];
  }
  return memoryLedgers[tenantId];
}

/**
 * Saves audit trail entries for a specific tenant.
 */
export function saveLedger(tenantId: string, entries: AuditLogEntry[]): void {
  memoryLedgers[tenantId] = entries;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(`pbc_audit_ledger_${tenantId}`, JSON.stringify(entries));
    } catch (err) {
      console.warn('Failed to persist audit ledger to localStorage:', err);
    }
  }
}

/**
 * Appends an immutable, SHA-256 chained entry to the tenant's audit ledger.
 */
export async function recordAuditEvent(params: {
  tenantId: string;
  actorId?: string;
  actorEmail: string;
  actorRole?: string;
  actionType: AuditActionType;
  targetEntity: string;
  previousState?: any;
  newState?: any;
  metadata?: Record<string, any>;
}): Promise<AuditLogEntry> {
  const entries = loadLedger(params.tenantId);
  const sequenceNumber = entries.length + 1;
  const timestamp = new Date().toISOString();
  const previousHash = entries.length > 0 ? entries[entries.length - 1].sha256Hash : GENESIS_HASH;

  const canonical = createCanonicalEntryPayload(
    sequenceNumber,
    timestamp,
    params.tenantId,
    params.actorEmail,
    params.actionType,
    params.targetEntity,
    params.previousState,
    params.newState,
    params.metadata,
    previousHash
  );

  const sha256Hash = await computeSha256(canonical);

  const newEntry: AuditLogEntry = {
    id: `audit_${params.tenantId}_${Date.now()}_${sequenceNumber}`,
    sequenceNumber,
    timestamp,
    tenantId: params.tenantId,
    actorId: params.actorId || 'actor_system',
    actorEmail: params.actorEmail,
    actorRole: params.actorRole || 'Operator',
    actionType: params.actionType,
    targetEntity: params.targetEntity,
    previousState: params.previousState,
    newState: params.newState,
    metadata: params.metadata,
    previousHash,
    sha256Hash,
  };

  entries.push(newEntry);
  saveLedger(params.tenantId, entries);

  return newEntry;
}

/**
 * Traverses and verifies the cryptographic integrity of an audit chain.
 * Detects any data tampering, payload modification, or broken hash sequence.
 */
export async function verifyAuditChain(entries: AuditLogEntry[]): Promise<AuditVerificationResult> {
  if (entries.length === 0) {
    return {
      isValid: true,
      totalEntries: 0,
      verifiedTimestamp: new Date().toISOString(),
      rootHash: GENESIS_HASH,
      headHash: GENESIS_HASH,
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i];
    const expectedPrevHash = i === 0 ? GENESIS_HASH : entries[i - 1].sha256Hash;

    // Verify chain linkage to previous block
    if (current.previousHash !== expectedPrevHash) {
      return {
        isValid: false,
        totalEntries: entries.length,
        brokenIndex: i,
        brokenEntryId: current.id,
        verifiedTimestamp: new Date().toISOString(),
        rootHash: entries[0].sha256Hash,
        headHash: entries[entries.length - 1].sha256Hash,
        errorMessage: `Chain linkage violation at index ${i} (sequence #${current.sequenceNumber}). Previous hash mismatch.`,
      };
    }

    // Verify self-integrity of current entry
    const canonical = createCanonicalEntryPayload(
      current.sequenceNumber,
      current.timestamp,
      current.tenantId,
      current.actorEmail,
      current.actionType,
      current.targetEntity,
      current.previousState,
      current.newState,
      current.metadata,
      current.previousHash
    );

    const recomputedHash = await computeSha256(canonical);
    if (recomputedHash !== current.sha256Hash) {
      return {
        isValid: false,
        totalEntries: entries.length,
        brokenIndex: i,
        brokenEntryId: current.id,
        verifiedTimestamp: new Date().toISOString(),
        rootHash: entries[0].sha256Hash,
        headHash: entries[entries.length - 1].sha256Hash,
        errorMessage: `Payload tampering detected at index ${i} (entry: ${current.id}). Digest mismatch.`,
      };
    }
  }

  return {
    isValid: true,
    totalEntries: entries.length,
    verifiedTimestamp: new Date().toISOString(),
    rootHash: entries[0].sha256Hash,
    headHash: entries[entries.length - 1].sha256Hash,
  };
}

/**
 * Queries and filters audit records for a given tenant.
 */
export function getAuditLogs(tenantId: string, filters?: AuditFilterOptions): AuditLogEntry[] {
  let list = loadLedger(tenantId);

  if (!filters) return list;

  return list.filter(entry => {
    if (filters.actionType && filters.actionType !== 'ALL' && entry.actionType !== filters.actionType) {
      return false;
    }
    if (filters.actorEmail && !entry.actorEmail.toLowerCase().includes(filters.actorEmail.toLowerCase())) {
      return false;
    }
    if (filters.targetEntity && !entry.targetEntity.toLowerCase().includes(filters.targetEntity.toLowerCase())) {
      return false;
    }
    if (filters.startDate && new Date(entry.timestamp) < new Date(filters.startDate)) {
      return false;
    }
    if (filters.endDate && new Date(entry.timestamp) > new Date(filters.endDate)) {
      return false;
    }
    if (filters.searchQuery) {
      const q = filters.searchQuery.toLowerCase();
      const match =
        entry.targetEntity.toLowerCase().includes(q) ||
        entry.actorEmail.toLowerCase().includes(q) ||
        entry.actionType.toLowerCase().includes(q) ||
        entry.sha256Hash.toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });
}

/**
 * Exports a cryptographically certified audit package as an immutable JSON string.
 */
export async function exportAuditPackageJson(tenantId: string, orgName: string = 'Enclave'): Promise<string> {
  const entries = loadLedger(tenantId);
  const verification = await verifyAuditChain(entries);

  const payload = {
    title: 'Event Horizon: Singularity - Cryptographic Audit Ledger',
    platform: 'Event Horizon: Singularity (Pitch Black Cyber)',
    complianceAuthority: 'NIST SP 800-171 3.3 / DFARS 252.204-7012',
    tenantId,
    organizationName: orgName,
    exportTimestamp: new Date().toISOString(),
    verificationSummary: verification,
    totalRecords: entries.length,
    chainLedger: entries,
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Initializes baseline seed audit events if tenant ledger is empty.
 */
export async function seedDemoAuditLedgerIfEmpty(tenantId: string, systemName: string = 'Defense Network'): Promise<void> {
  const existing = loadLedger(tenantId);
  if (existing.length > 0) return;

  const demoEvents: Parameters<typeof recordAuditEvent>[0][] = [
    {
      tenantId,
      actorEmail: 'alex.mercer@vanguard-defense.us',
      actorRole: 'Security Lead',
      actionType: 'DATA_RETENTION_APPLIED',
      targetEntity: 'GCS Enclave Bucket (gs://singularity-evidence-prod)',
      newState: { retentionPeriodDays: 1095, complianceStandard: 'DFARS 252.204-7012' },
      metadata: { policyId: 'RET-2026-VANGUARD' },
    },
    {
      tenantId,
      actorEmail: 'alex.mercer@vanguard-defense.us',
      actorRole: 'Security Lead',
      actionType: 'CONTROL_STATUS_UPDATED',
      targetEntity: 'AC.L1-3.1.1',
      previousState: 'NOT_STARTED',
      newState: 'MET',
      metadata: { reason: 'Configured Entra ID Conditional Access MFA and RBAC restrictions.' },
    },
    {
      tenantId,
      actorEmail: 'alex.mercer@vanguard-defense.us',
      actorRole: 'Security Lead',
      actionType: 'EVIDENCE_UPLOADED',
      targetEntity: 'AC.1.001_m365_rbac.pdf',
      newState: { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sizeBytes: 1048576 },
      metadata: { controlId: 'AC.L1-3.1.1' },
    },
    {
      tenantId,
      actorEmail: 'auditor.chen@defense-audit.org',
      actorRole: 'Assessor (Read-Only)',
      actionType: 'DOCUMENT_GENERATED',
      targetEntity: 'NIST_SP_800_18_SSP',
      newState: { version: '1.0.0', completionPercentage: 100 },
      metadata: { systemName },
    },
  ];

  for (const evt of demoEvents) {
    await recordAuditEvent(evt);
  }
}
