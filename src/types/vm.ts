/**
 * Vulnerability management (VM) vocabularies and row shapes. The approved design is docs/VULNERABILITY_MANAGEMENT.md
 * (section 3); server/schema.ts interpolates these lists into the DDL, so a new value here reaches the CHECK constraints.
 * Timestamps are ISO strings, like EnclaveAsset in ./telemetry.
 */

/** Append-only: the CHECK on vm_sources.kind is re-created from this list on every boot, so removing a kind that rows still use would fail initDb. */
export const VM_SOURCE_KINDS = ['WAZUH', 'SENTINELONE', 'ACTION1', 'GREENBONE', 'NUCLEI', 'NMAP', 'SCAP'] as const;
export type VmSourceKind = (typeof VM_SOURCE_KINDS)[number];

/** Source kinds that report configuration results only: they never take part in the vulnerability snapshot or its sources check. */
export const VM_CONFIG_ONLY_SOURCE_KINDS: readonly VmSourceKind[] = ['SCAP'];

/** XCCDF rule result values (docs/VULNERABILITY_MANAGEMENT.md section 5.5); the CHECK on vm_config_results.result is built from this list. */
export const VM_CONFIG_RESULTS = ['pass', 'fail', 'error', 'unknown', 'notapplicable', 'notchecked', 'notselected', 'informational', 'fixed'] as const;
export type VmConfigResult = (typeof VM_CONFIG_RESULTS)[number];

export const VM_CONFIG_SEVERITIES = ['high', 'medium', 'low', 'info', 'unknown'] as const;
export type VmConfigSeverity = (typeof VM_CONFIG_SEVERITIES)[number];

export const VM_TOKEN_SCOPES = ['vm:ingest'] as const;
export type VmTokenScope = (typeof VM_TOKEN_SCOPES)[number];

export const VM_RUN_STATUSES = ['RECEIVED', 'NORMALIZING', 'NORMALIZED', 'FAILED'] as const;
export type VmRunStatus = (typeof VM_RUN_STATUSES)[number];

/** Outcome of a token's most recent ingest push. Fixed codes only: never a message (a validation message can name payload content). */
export const VM_PUSH_STATUSES = ['ok', 'error'] as const;
export type VmPushStatus = (typeof VM_PUSH_STATUSES)[number];
export const VM_PUSH_ERROR_CODES = ['validation', 'kind_mismatch', 'too_large', 'media_type', 'insecure', 'storage'] as const;
export type VmPushErrorCode = (typeof VM_PUSH_ERROR_CODES)[number];

export const VM_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type VmSeverity = (typeof VM_SEVERITIES)[number];

export const VM_FINDING_STATUSES = ['OPEN', 'RESOLVED', 'RISK_ACCEPTED', 'FALSE_POSITIVE'] as const;
export type VmFindingStatus = (typeof VM_FINDING_STATUSES)[number];

/** Statuses a person may set. RESOLVED is deliberately absent: closure is machine-confirmed by a later run. */
export const VM_HUMAN_DECISIONS = ['RISK_ACCEPTED', 'FALSE_POSITIVE'] as const;
export type VmHumanDecision = (typeof VM_HUMAN_DECISIONS)[number];

/**
 * Who wrote a vm_vulns row. Tenant ingest may only INSERT a missing vuln_id, with source INGEST, and never UPDATEs one. title, cvss_v3,
 * severity, published_at, kev and epss are written only by the feed job (FEED) or a platform administrator (ADMIN), which overwrite INGEST rows.
 * Append-only: the CHECK on vm_vulns.source is re-created from this list on every boot.
 */
export const VM_VULN_SOURCES = ['INGEST', 'FEED', 'ADMIN'] as const;
export type VmVulnSource = (typeof VM_VULN_SOURCES)[number];

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
  lastPushAt: string | null;
  lastPushStatus: VmPushStatus | null;
  lastPushErrorCode: VmPushErrorCode | null;
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
  /** received_at of the newest NORMALIZED run; staleness is measured from this, not from receipt. */
  lastNormalizedAt: string | null;
  staleSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VmRun {
  id: string;
  tenantId: string;
  sourceId: string;
  /** The service token that pushed this run; null for runs recorded before #231. */
  tokenId: string | null;
  receivedAt: string;
  collectedAt: string | null;
  exporterName: string;
  exporterVersion: string;
  hostCount: number;
  findingCount: number;
  /** Rule results across every configuration scan in the run. */
  configResultCount: number;
  rawPath: string;
  rawSha256: string;
  rawBytes: number;
  status: VmRunStatus;
  error: string | null;
  /** Non-fatal note on a NORMALIZED run (for example hosts skipped at the asset limit). */
  warning: string | null;
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
  source: VmVulnSource;
  updatedAt: string;
}

/** Most affected packages a finding stores; the full list stays on each run's sighting. */
export const VM_MAX_AFFECTED_PACKAGES = 50;

export interface VmAffectedPackage {
  name: string;
  version: string;
  fixedVersion: string | null;
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
  /** Sorted by name then version, at most VM_MAX_AFFECTED_PACKAGES. packageName/Version/fixedVersion are the first entry. */
  affectedPackages: VmAffectedPackage[];
  /** True number of affected packages in the latest run, even when the list is capped. */
  affectedPackageCount: number;
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
  /** The program the item belongs to; null for a legacy item that was never backfilled. */
  programId?: string | null;
  /** The finding's first_seen_at (episode) the item was created for; null for an item created before #275. */
  findingFirstSeenAt?: string | null;
  /** Who last edited the item (a person's display name, or the worker); null for an item never edited. */
  updatedBy?: string | null;
  /** Who last changed the status, and when; null while the status is the one the item was created with. */
  statusChangedBy?: string | null;
  statusChangedAt?: string | null;
  /** False once a person reopened the item: the worker no longer completes it automatically. */
  autoComplete?: boolean;
}

/** Most affected packages one POA&M row of GET /vm/poam carries (the count is always the true one). */
export const VM_POAM_PACKAGES_RETURNED = 10;

/** One item of GET /vm/poam with the finding it is about. */
export interface VmPoamRow {
  id: string;
  status: VmPoamStatus;
  controlId: string;
  weakness: string;
  scheduledCompletion: string | null;
  createdAt: string;
  updatedAt: string;
  findingFirstSeenAt: string | null;
  createdBy: string;
  owner: string;
  mitigation: string;
  updatedBy: string | null;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
  autoComplete: boolean;
  /** null when the finding was deleted with its asset (the key sets finding_id NULL). */
  finding: null | {
    id: string;
    vulnId: string;
    severity: VmSeverity;
    status: VmFindingStatus;
    kev: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    slaDueAt: string | null;
    resolvedAt: string | null;
    /** The first VM_POAM_PACKAGES_RETURNED; the single legacy package when the list is empty. */
    affectedPackages: VmAffectedPackage[];
    affectedPackageCount: number;
    asset: { id: string; name: string } | null;
  };
}

/** One status or field change of a POA&M item (vm_poam_item_events). Never carries the owner or mitigation text, nor a digest or user id. */
export interface VmPoamItemEvent {
  id: string;
  itemId: string;
  source: 'human' | 'system';
  actor: string;
  oldStatus: VmPoamStatus | null;
  newStatus: VmPoamStatus;
  oldScheduledCompletion: string | null;
  newScheduledCompletion: string | null;
  ownerChanged: boolean;
  mitigationChanged: boolean;
  runId: string | null;
  createdAt: string;
}

/** What PATCH .../vm/poam/:itemId may change (the body also carries `expectedUpdatedAt`). An empty owner or mitigation clears it; a null date clears the date. */
export interface VmPoamItemPatch {
  owner?: string;
  mitigation?: string;
  /** Calendar date (YYYY-MM-DD) or null. */
  scheduledCompletion?: string | null;
  status?: VmPoamStatus;
}

/** GET .../programs/:id/vm-target/preview: what choosing the program as the VM target would mean (nothing is changed). */
export interface VmTargetPreview {
  programId: string;
  /** The program already is the VM target (explicit or the implicit default). */
  isTarget: boolean;
  eligible: boolean;
  ineligibleReason: 'invalid_vm_target' | 'program_archived' | null;
  /** The program that receives the data now; null when there is none. */
  currentTargetId: string | null;
  currentTargetExplicit: boolean;
  /** Open POA&M items the current target holds (they stay there after a switch). */
  openPoamInCurrent: number;
  /** About how many open findings of the program are past their deadline and have no item (deadlines can pass before the next run). */
  overdueWithoutItem: number;
  autocreateEnabled: boolean;
}

/** An open finding whose deadline has not passed yet (no POA&M item is due for it). */
export interface VmUpcomingFinding {
  findingId: string;
  vulnId: string;
  severity: VmSeverity;
  kev: boolean;
  firstSeenAt: string;
  slaDueAt: string;
  /** floor((slaDueAt - generatedAt) / 1 day); 0 = due within 24 h. */
  daysRemaining: number;
  assetId: string;
  assetName: string;
  affectedPackages: VmAffectedPackage[];
  affectedPackageCount: number;
}

export interface VmPoamResponse {
  tenantId: string;
  programId: string;
  generatedAt: string;
  rules: {
    controlId: 'RA.L2-3.11.3';
    autocreateEnabled: boolean;
    vmTargetProgramId: string | null;
    isVmTarget: boolean;
    slaDays: { CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number };
  };
  items: VmPoamRow[];
  itemsTotal: number;
  openItemsTotal: number;
  /** OPEN findings past their deadline with no item of their episode in this program (autocreate off, or no run since the deadline). Target program only. */
  overdueWithoutItemCount: number;
  /** Target program only. */
  upcoming: VmUpcomingFinding[];
  upcomingTotal: number;
}

/** One configuration (XCCDF) scan of one asset in one run. Timestamps are ISO strings. */
export interface VmConfigScan {
  id: string;
  tenantId: string;
  runId: string;
  sourceId: string;
  assetId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  benchmarkTitle: string;
  profileId: string;
  profileTitle: string;
  scannerName: string;
  scannerVersion: string;
  startedAt: string | null;
  scannedAt: string;
  receivedAt: string;
  sourceSha256: string | null;
  /** Count of rules per result value; every value in VM_CONFIG_RESULTS is present. */
  resultCounts: Record<VmConfigResult, number>;
}

export interface VmConfigRuleResult {
  scanId: string;
  ruleId: string;
  cce: string | null;
  result: VmConfigResult;
  severity: VmConfigSeverity | null;
  title: string;
}

/** A suggestion is computed on read from the latest scans; it is never written to a control. */
export type VmConfigSuggestionValue = 'MET' | 'NOT_MET' | 'REVIEW';

export interface VmConfigSuggestion {
  controlId: string;
  suggestion: VmConfigSuggestionValue;
  assets: { inScope: number; evaluated: number; failing: number; passing: number; error: number; unconfirmed: number };
  rules: { mapped: number; failing: number };
  failingAssetIds: string[];
  latestScanAt: string | null;
}

export interface VmConfigSuggestionsResponse {
  tenantId: string;
  programId: string;
  frameworkId: string;
  supported: boolean;
  boundary: { declared: boolean; inScope: number; evaluated: number };
  generatedAt: string;
  controls: VmConfigSuggestion[];
  unmappedRuleCount: number;
}

/** One source's current view of a host (GET /vm/assets/:assetId/inventory). Timestamps are ISO strings; BIGINT memory is a number. */
export interface VmObservedHost {
  sourceId: string;
  sourceKind: VmSourceKind;
  sourceLabel: string;
  hostname: string;
  ipAddress: string;
  macAddress: string;
  os: { name: string; version: string; platform: string; kernel: string };
  /** Null when the source never reported hardware for this host. */
  hardware: {
    architecture: string;
    cpuName: string;
    cpuCores: number | null;
    cpuMhz: number | null;
    memoryBytes: number | null;
    serialNumber: string;
  } | null;
  softwareReported: boolean;
  softwareCount: number;
  collectedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One installed package a source reported for a host (GET /vm/assets/:assetId/software). */
export interface VmObservedSoftware {
  sourceId: string;
  name: string;
  version: string;
  vendor: string;
  architecture: string;
  type: string;
  installedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One host row of the program-wide read (GET /vm/inventory/hosts): the per-asset view plus the asset it belongs to. */
export type VmObservedHostWithAsset = VmObservedHost & { assetId: string };

/** One distinct package across the program's hosts (GET /vm/inventory/software), grouped by lower-cased trimmed name and vendor and trimmed version. */
export interface VmObservedSoftwareGroup {
  name: string;
  version: string;
  vendor: string;
  assetCount: number;
  /** At most 50 asset ids, sorted. */
  assetIds: string[];
  sourceIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
