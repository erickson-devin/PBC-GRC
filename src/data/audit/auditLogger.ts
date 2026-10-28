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
  previousState: unknown,
  newState: unknown,
  metadata: Record<string, unknown> | undefined,
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
 * Describes implementation notes for the ledger without storing any of their text (notes may contain CUI and the
 * ledger is persisted to localStorage). Returns '' for empty notes, else `sha256:<hex> (<n> chars)`. When Web Crypto
 * is unavailable it returns the length only, `(<n> chars)`, rather than a non-SHA-256 digest.
 */
export async function describeNotesForLedger(notes: string): Promise<string> {
  if (!notes || !notes.trim()) return '';
  const length = `(${notes.length} chars)`;
  const subtle: SubtleCrypto | undefined = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (!subtle) return length;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(notes));
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex} ${length}`;
  } catch {
    return length;
  }
}

/** Ledger descriptor for an IP or MAC address. Length only: a SHA-256 of a 32-bit address is reversible by enumeration. */
export async function describeAddressForLedger(value: string): Promise<string> {
  return !value || !value.trim() ? '' : `(${value.length} chars)`;
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
  previousState?: unknown;
  newState?: unknown;
  metadata?: Record<string, unknown>;
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

export const LEDGER_REDACTION_MARKER = '[redacted 2026-10-19]';

// What describeNotesForLedger writes: an optional digest plus the length, never text.
const NOTES_DESCRIPTOR_RE = /^(sha256:[0-9a-f]{64} )?\(\d+ chars\)$/;

function needsRedaction(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value !== LEDGER_REDACTION_MARKER && !NOTES_DESCRIPTOR_RE.test(value);
}

/** State keys that older builds filled with file names, host names, IPs or MACs (all may be CUI). */
export const LEDGER_IDENTIFIER_KEYS = ['fileName', 'hostName', 'ipAddress', 'targetIp', 'macAddress'] as const;
// IP and MAC get a length only: a hash of an address is reversible by enumeration
const ADDRESS_KEYS = new Set<string>(['ipAddress', 'targetIp', 'macAddress']);
// EVIDENCE_UPLOADED targets that are safe to keep: the evidence id, or the SCAP scan label
const EVIDENCE_TARGET_KEPT_RE = /^(ev_\d+_[0-9a-z]{1,5}|SCAP Scan: .*)$/;

/**
 * Removes text that older builds wrote into the ledger and that may be CUI (the ledger lives in localStorage):
 * implementation-notes excerpts in CONTROL_NOTES_UPDATED entries, and file names, host names, IPs and MACs in entry
 * states and in EVIDENCE_UPLOADED targets (replaced by describeNotesForLedger / describeAddressForLedger descriptors).
 * Redacting changes the hashed payload, so the chain is re-hashed from the first redacted entry and one
 * LEDGER_REDACTED entry is appended (counts and the old head hash). Returns the same array and 0 when nothing needed
 * redaction; never mutates its input.
 */
export async function redactLedgerNotesExcerpts(
  entries: AuditLogEntry[]
): Promise<{ entries: AuditLogEntry[]; redacted: number; notes: number; identifiers: number }> {
  let firstIndex = -1;
  let notes = 0;
  let identifiers = 0;

  const redactState = async (state: unknown): Promise<{ state: unknown; count: number }> => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { state, count: 0 };
    let copy: Record<string, unknown> | null = null;
    let count = 0;
    for (const key of LEDGER_IDENTIFIER_KEYS) {
      const value = (state as Record<string, unknown>)[key];
      if (!needsRedaction(value)) continue;
      if (!copy) copy = { ...(state as Record<string, unknown>) };
      copy[key] = ADDRESS_KEYS.has(key)
        ? await describeAddressForLedger(value as string)
        : await describeNotesForLedger(value as string);
      count++;
    }
    return { state: copy ?? state, count };
  };

  const next: AuditLogEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    let entry = entries[i];
    if (!entry) {
      next.push(entry);
      continue;
    }
    let changed = false;
    if (entry.actionType === 'CONTROL_NOTES_UPDATED') {
      const hitPrev = needsRedaction(entry.previousState);
      const hitNew = needsRedaction(entry.newState);
      if (hitPrev || hitNew) {
        notes += (hitPrev ? 1 : 0) + (hitNew ? 1 : 0);
        entry = {
          ...entry,
          previousState: hitPrev ? LEDGER_REDACTION_MARKER : entry.previousState,
          newState: hitNew ? LEDGER_REDACTION_MARKER : entry.newState,
        };
        changed = true;
      }
    }
    const prev = await redactState(entry.previousState);
    const nw = await redactState(entry.newState);
    if (prev.count + nw.count > 0) {
      identifiers += prev.count + nw.count;
      entry = { ...entry, previousState: prev.state, newState: nw.state };
      changed = true;
    }
    if (
      entry.actionType === 'EVIDENCE_UPLOADED' &&
      needsRedaction(entry.targetEntity) &&
      !EVIDENCE_TARGET_KEPT_RE.test(entry.targetEntity)
    ) {
      identifiers++;
      entry = { ...entry, targetEntity: await describeNotesForLedger(entry.targetEntity) };
      changed = true;
    }
    if (changed && firstIndex < 0) firstIndex = i;
    next.push(entry);
  }
  if (firstIndex < 0) return { entries, redacted: 0, notes: 0, identifiers: 0 };
  const redacted = notes + identifiers;

  const oldHead = entries[entries.length - 1].sha256Hash;
  for (let i = firstIndex; i < next.length; i++) {
    const previousHash = i === 0 ? GENESIS_HASH : next[i - 1].sha256Hash;
    const e = next[i];
    const canonical = createCanonicalEntryPayload(
      e.sequenceNumber,
      e.timestamp,
      e.tenantId,
      e.actorEmail,
      e.actionType,
      e.targetEntity,
      e.previousState,
      e.newState,
      e.metadata,
      previousHash
    );
    next[i] = { ...e, previousHash, sha256Hash: await computeSha256(canonical) };
  }

  const last = next[next.length - 1];
  const sequenceNumber = next.length + 1;
  const timestamp = new Date().toISOString();
  // LEDGER_REDACTED is written only here (see AuditActionType in src/types/audit.ts)
  const actionType: AuditActionType = 'LEDGER_REDACTED';
  const newState = `redacted ${notes} notes excerpt(s), ${identifiers} identifier(s) and re-chained`;
  const canonical = createCanonicalEntryPayload(
    sequenceNumber,
    timestamp,
    last.tenantId,
    'system',
    actionType,
    'audit-ledger',
    oldHead,
    newState,
    undefined,
    last.sha256Hash
  );
  next.push({
    id: `audit_${last.tenantId}_${Date.now()}_${sequenceNumber}`,
    sequenceNumber,
    timestamp,
    tenantId: last.tenantId,
    actorId: 'system',
    actorEmail: 'system',
    actorRole: 'System',
    actionType,
    targetEntity: 'audit-ledger',
    previousState: oldHead,
    newState,
    previousHash: last.sha256Hash,
    sha256Hash: await computeSha256(canonical),
  });
  return { entries: next, redacted, notes, identifiers };
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

