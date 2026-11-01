/** Telemetry types: the asset inventory. */
import type { FipsStandard, FipsValidationStatus } from '../data/telemetry/fipsValidation';

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



