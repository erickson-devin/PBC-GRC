/**
 * Event Horizon: Singularity — Photon SCAP/STIG Telemetry Types
 * Defines the schema for OpenSCAP scan reports, rule-level results,
 * and CCE → CMMC / NIST SP 800-171 control mapping records.
 */
import type { FipsStandard, FipsValidationStatus } from '../data/telemetry/fipsValidation';


// ---------------------------------------------------------------------------
// SCAP Scan Result Types
// ---------------------------------------------------------------------------

export type ScapRuleStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface ScapRuleResult {
  /** OpenSCAP rule identifier (e.g. "xccdf_org.ssgproject.content_rule_sshd_disable_root_login") */
  ruleId: string;
  /** Common Configuration Enumeration ID (e.g. "CCE-27445-6") */
  cceId: string;
  /** Human-readable rule title */
  title: string;
  /** Evaluation outcome */
  status: ScapRuleStatus;
  /** DISA CAT severity level */
  severity: 'CAT_I' | 'CAT_II' | 'CAT_III';
  /** Optional DISA STIG ID (e.g. "V-254256") */
  stigId?: string;
  /** Raw scanner output / check detail */
  output: string;
}

export interface ScapScanReport {
  /** Unique identifier for this scan execution */
  scanId: string;
  /** Tenant partition key */
  tenantId: string;
  /** Hostname of the scanned target */
  hostName: string;
  /** IP address of the scanned target */
  targetIp: string;
  /** OS profile used for the scan (e.g. "rhel9", "win2022", "ubuntu2204") */
  osProfile: string;
  /** ISO 8601 UTC timestamp of scan execution */
  timestamp: string;
  /** OpenSCAP / SCAP Workbench version string */
  scapVersion: string;
  /** Total rules that evaluated as PASS */
  passedCount: number;
  /** Total rules that evaluated as FAIL */
  failedCount: number;
  /** Per-rule evaluation results */
  results: ScapRuleResult[];
}

// ---------------------------------------------------------------------------
// CCE → GRC Control Mapping Types
// ---------------------------------------------------------------------------

export interface ScapRuleMapping {
  /** Common Configuration Enumeration ID (e.g. "CCE-27445-6") */
  cceId: string;
  /** OpenSCAP rule identifier */
  ruleId: string;
  /** CMMC Level 1/2 control requirement ID (e.g. "3.1.1") */
  cmmcControlId: string;
  /** NIST SP 800-171 / 800-53 control ID (e.g. "AC-2") */
  nistControlId: string;
  /** Human-readable rule title */
  title: string;
}

// ---------------------------------------------------------------------------
// Photon Console State Types
// ---------------------------------------------------------------------------

export type PhotonScanStatus =
  | 'IDLE'
  | 'CONFIGURING'
  | 'SCANNING'
  | 'COMPLETED'
  | 'ERROR'
  | 'SYNCING';

export interface PhotonConsoleState {
  /** Current scan execution status */
  status: PhotonScanStatus;
  /** Target IP or hostname input */
  targetHost: string;
  /** Selected OS profile for benchmark selection */
  osProfile: string;
  /** Selected DISA STIG benchmark */
  stigBenchmark: string;
  /** Streaming terminal log lines */
  terminalLines: string[];
  /** Most recent scan report (null if no scan has run) */
  lastReport: ScapScanReport | null;
  /** Error message if status === 'ERROR' */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Per-Asset Telemetry Data Model
// ---------------------------------------------------------------------------

export interface AssetRuleResult {
  /** OpenSCAP rule identifier (e.g. "sshd_disable_root_login") */
  ruleId: string;
  /** Common Configuration Enumeration ID (e.g. "CCE-27286-4") */
  cceId: string;
  /** Mapped CMMC / NIST control requirement ID (e.g. "AC.L1-3.1.1" or "3.1.1") */
  cmmcControlId: string;
  /** Evaluation status */
  status: 'PASS' | 'FAIL';
  /** Severity level */
  severity: 'CAT_I' | 'CAT_II' | 'CAT_III';
  /** Human-readable rule title */
  title: string;
  /** Standard output or evaluation error from scanner */
  stdout: string;
  /** Remediation bash/ansible/powershell script */
  fixScript: string;
}

export interface AssetTelemetryRecord {
  /** SHA-256 or unique hash of hostname + IP address */
  assetId: string;
  /** Endpoint hostname (e.g. "WS-SEC-04", "enclave-node-01") */
  hostName: string;
  /** Network IP address (e.g. "192.168.1.142", "10.0.50.12") */
  ipAddress: string;
  /** OS platform profile (e.g. "rhel9", "ubuntu2204", "win2022") */
  osProfile: string;
  /** Hardware MAC address */
  macAddress: string;
  /** ISO timestamp of most recent STIG scan */
  lastScanTimestamp: string;
  /** Total count of evaluated rules */
  totalRulesEvaluated: number;
  /** Count of rules passing */
  passedRuleCount: number;
  /** Count of rules failing */
  failedRuleCount: number;
  /** Compliance score percentage (0-100) */
  assetComplianceScore: number;
  /** Detailed per-rule evaluation results */
  ruleResults: AssetRuleResult[];
}

/** Non-compliant asset breakdown item stored on control metadata */
export interface FailingAssetInfo {
  assetId?: string;
  hostName: string;
  ipAddress: string;
  failedRule: string; // e.g. "SV-214800", "CCE-27286-4", or rule ID
  cceId?: string;
  ruleTitle?: string;
  severity?: 'CAT_I' | 'CAT_II' | 'CAT_III';
  stdout?: string;
  fixScript?: string;
  osProfile?: string;
  lastScanTimestamp?: string;
}

/** Per-control boundary-wide evaluation rollup */
export interface BoundaryControlRollup {
  controlId: string;
  status: 'MET' | 'NOT_MET' | 'IN_PROGRESS';
  failingAssets: FailingAssetInfo[];
  totalEndpoints: number;
  failingEndpointsCount: number;
  passingEndpointsCount: number;
}

/** Complete boundary-wide telemetry aggregation report across all assets */
export interface BoundaryAggregationResult {
  tenantId: string;
  timestamp: string;
  totalAssets: number;
  compliantAssetsCount: number;
  nonCompliantAssetsCount: number;
  controlRollup: Record<string, BoundaryControlRollup>;
  auditHash: string;
}

// ---------------------------------------------------------------------------
// Enclave Asset & Hardware Inventory Manager Types
// ---------------------------------------------------------------------------

export type EnclaveAssetOsProfile =
  | 'rhel9'
  | 'rhel8'
  | 'win11'
  | 'win2022'
  | 'ubuntu2204'
  | 'cisco_ios'
  | 'custom';

export type CmmcAssetCategory =
  | 'CUI_ASSET'
  | 'SECURITY_PROTECTION'
  | 'CONTRACTOR_RISK'
  | 'SPECIALIZED_ASSET'
  | 'OUT_OF_SCOPE';

export type EnclaveAssetStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'NON_COMPLIANT'
  | 'NEVER_SCANNED';

export type AssetSourceOrigin =
  | 'MANUAL_ENTRY'
  | 'ACCRETION_DISCOVERY'
  | 'PHOTON_AGENT'
  | 'CSV_IMPORT'
  | 'AGENT_REPORT';

export type AssetDiscoveryStatus =
  | 'ACTIVE'
  | 'STALE'
  | 'UNCONFIRMED_DISCOVERY'
  | 'DECOMMISSIONED';

export interface AccretionMetadata {
  /** Unique ID of the Accretion collector/sensor */
  agentId: string;
  /** Open TCP/UDP ports discovered via port scanning */
  discoveredPorts: number[];
  /** Raw TCP/IP stack OS fingerprint banner */
  osFingerprint: string;
  /** ISO timestamp of last network packet or beacon */
  lastSeenAt: string;
  /** L2/L3 interface connection transport */
  connectionType: 'ETHERNET' | 'WIRELESS' | 'VIRTUAL' | 'VPN';
}

export interface AccretionDiscoveryItem {
  macAddress: string;
  ipAddress: string;
  hostName?: string;
  osFingerprint: string;
  osProfile?: EnclaveAssetOsProfile | string;
  discoveredPorts: number[];
  connectionType: 'ETHERNET' | 'WIRELESS' | 'VIRTUAL' | 'VPN';
  agentId: string;
  detectedAt?: string;
  notes?: string;
}

export interface AccretionIngestResult {
  totalProcessed: number;
  newDiscoveredCount: number;
  updatedExistingCount: number;
  auditHash: string;
  items: EnclaveAsset[];
}

export interface EnclaveAsset {
  /** Unique asset UUID */
  id: string;
  /** Multi-tenant isolation partition key */
  tenantId: string;
  /** Hostname or FQDN */
  hostName: string;
  /** Primary IPv4 or IPv6 network address */
  ipAddress: string;
  /** Hardware MAC address (required for network deduplication) */
  macAddress: string;
  /** Operating system profile */
  osProfile: EnclaveAssetOsProfile | string;
  /** CMMC scoping asset category */
  cmmcAssetCategory: CmmcAssetCategory;
  /** Operational & compliance status */
  status: EnclaveAssetStatus;
  /** Ingestion origin source */
  sourceOrigin: AssetSourceOrigin;
  /** Accretion active discovery status */
  discoveryStatus: AssetDiscoveryStatus;
  /** Detailed metadata from Elijah's Accretion tool */
  accretionMetadata?: AccretionMetadata;
  /** Timestamp of most recent OpenSCAP / STIG scan, or null */
  lastScannedAt: string | null;
  /** STIG benchmark compliance percentage (0-100), or null */
  complianceScore: number | null;
  /** Hardware specifications, role, or administrative notes (the server's ) */
  notes: string;
  /** Person or team accountable for the asset */
  owner?: string;
  /** Cryptographic module validation (Security Protection and CUI assets only), see data/telemetry/fipsValidation.ts */
  fipsValidationStatus?: FipsValidationStatus | null;
  /** CMVP certificate number, digits only */
  fipsCertificateNumber?: string | null;
  fipsModuleName?: string | null;
  /** FIPS 140 revision of the certificate, when known */
  fipsStandard?: FipsStandard | null;
  /** True if registered manually by administrator */
  isManuallyAdded: boolean;
}



