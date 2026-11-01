/** Telemetry types: the asset inventory and the legacy per-asset fleet record. */
import type { FipsStandard, FipsValidationStatus } from '../data/telemetry/fipsValidation';

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



