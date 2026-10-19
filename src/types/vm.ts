/**
 * Vulnerability management (VM) vocabularies and row shapes. The approved design is docs/VULNERABILITY_MANAGEMENT.md
 * (section 3); server/schema.ts interpolates these lists into the DDL, so a new value here reaches the CHECK constraints.
 * Timestamps are ISO strings, like EnclaveAsset in ./telemetry.
 */

/** Append-only: the CHECK on vm_sources.kind is re-created from this list on every boot, so removing a kind that rows still use would fail initDb. */
export const VM_SOURCE_KINDS = ['WAZUH', 'SENTINELONE', 'ACTION1', 'GREENBONE', 'NUCLEI', 'NMAP'] as const;
export type VmSourceKind = (typeof VM_SOURCE_KINDS)[number];

export const VM_TOKEN_SCOPES = ['vm:ingest'] as const;
export type VmTokenScope = (typeof VM_TOKEN_SCOPES)[number];

export const VM_RUN_STATUSES = ['RECEIVED', 'NORMALIZING', 'NORMALIZED', 'FAILED'] as const;
export type VmRunStatus = (typeof VM_RUN_STATUSES)[number];

export const VM_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type VmSeverity = (typeof VM_SEVERITIES)[number];

export const VM_FINDING_STATUSES = ['OPEN', 'RESOLVED', 'RISK_ACCEPTED', 'FALSE_POSITIVE'] as const;
export type VmFindingStatus = (typeof VM_FINDING_STATUSES)[number];

/** Statuses a person may set. RESOLVED is deliberately absent: closure is machine-confirmed by a later run. */
export const VM_HUMAN_DECISIONS = ['RISK_ACCEPTED', 'FALSE_POSITIVE'] as const;
export type VmHumanDecision = (typeof VM_HUMAN_DECISIONS)[number];

export const VM_POAM_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'RISK_ACCEPTED'] as const;
export type VmPoamStatus = (typeof VM_POAM_STATUSES)[number];

/** API shape of a service token: the hash is never returned, only the non-secret display prefix. */
export interface VmServiceToken {
  id: string;
  tenantId: string;
  name: string;
  tokenPrefix: string;
  scopes: VmTokenScope[];
  createdBy: string;
  createdByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface VmSource {
  id: string;
  tenantId: string;
  kind: VmSourceKind;
  label: string;
  enabled: boolean;
  expectedIntervalMinutes: number;
  lastRunId: string | null;
  lastRunAt: string | null;
  staleSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VmRun {
  id: string;
  tenantId: string;
  sourceId: string;
  receivedAt: string;
  collectedAt: string | null;
  exporterName: string;
  exporterVersion: string;
  hostCount: number;
  findingCount: number;
  rawPath: string;
  rawSha256: string;
  rawBytes: number;
  status: VmRunStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Global reference data (no tenant). */
export interface VmVuln {
  vulnId: string;
  title: string;
  cvssV3: number | null;
  severity: VmSeverity | null;
  publishedAt: string | null;
  kev: boolean;
  kevAddedAt: string | null;
  epss: number | null;
  epssPercentile: number | null;
  refs: unknown[];
  updatedAt: string;
}

export interface VmFinding {
  id: string;
  tenantId: string;
  assetId: string;
  vulnId: string;
  status: VmFindingStatus;
  severity: VmSeverity;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedRunId: string | null;
  slaDueAt: string | null;
  packageName: string;
  packageVersion: string;
  fixedVersion: string | null;
  justification: string | null;
  decidedBy: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

export interface VmSighting {
  id: string;
  tenantId: string;
  findingId: string;
  runId: string;
  sourceId: string;
  reportedSeverity: string | null;
  reportedAt: string;
  detail: Record<string, unknown>;
}

export interface VmPoamItem {
  id: string;
  tenantId: string;
  findingId: string | null;
  controlId: string;
  weakness: string;
  mitigation: string;
  owner: string;
  /** Calendar date (YYYY-MM-DD). */
  scheduledCompletion: string | null;
  status: VmPoamStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
