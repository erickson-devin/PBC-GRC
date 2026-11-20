import type { CmmcAssetCategory } from './telemetry';

/**
 * Tools and services register, vendors / external service providers, boundary links and the data inventory.
 * Pure types and constants: shared by the server, the client logic and the shipped catalogs. Enum lists are validated by
 * the application (the SQL CHECKs are patterns), so a later image may add values without a migration.
 */

/** ESP = external service provider (32 CFR 170.4, including CSP / MSP / MSSP). */
export const TOOL_DEPLOYMENTS = ['ON_PREM', 'CLOUD', 'ESP'] as const;
export type ToolDeployment = (typeof TOOL_DEPLOYMENTS)[number];

export const TOOL_TYPES = [
  'IDENTITY_SSO', 'MFA', 'DIRECTORY', 'PAM', 'EDR', 'ANTIVIRUS', 'SIEM', 'LOG_MANAGEMENT', 'VULNERABILITY_SCANNING', 'PATCH_RMM',
  'MDM_UEM', 'CONFIG_MANAGEMENT', 'EMAIL_COLLABORATION', 'EMAIL_SECURITY', 'FILE_SHARING', 'BACKUP_RECOVERY', 'FIREWALL_NETWORK',
  'REMOTE_ACCESS_VPN', 'WEB_DNS_FILTERING', 'DLP', 'ENCRYPTION_KEY_MGMT', 'CLOUD_PLATFORM', 'ITSM_TICKETING', 'SECURITY_AWARENESS',
  'PASSWORD_MANAGER', 'SECURE_FILE_TRANSFER', 'PHYSICAL_SECURITY', 'MANAGED_SERVICE', 'OTHER',
] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

export const FEDRAMP_STATUSES = ['UNKNOWN', 'NOT_APPLICABLE', 'NOT_AUTHORIZED', 'IN_PROCESS', 'LI_SAAS', 'LOW', 'MODERATE', 'HIGH', 'MODERATE_EQUIVALENT'] as const;
export type FedrampStatus = (typeof FEDRAMP_STATUSES)[number];

export const TOOL_ORIGINS = ['MANUAL', 'SURVEY', 'CATALOG'] as const;
export type ToolOrigin = (typeof TOOL_ORIGINS)[number];

export const VENDOR_KINDS = ['VENDOR', 'CSP', 'MSP', 'MSSP', 'OTHER_ESP'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const VENDOR_DOCUMENT_KINDS = ['CRM', 'SRM', 'CONTRACT', 'FEDRAMP_PACKAGE', 'ATTESTATION', 'OTHER'] as const;
export type VendorDocumentKind = (typeof VENDOR_DOCUMENT_KINDS)[number];

export const MAX_TOOLS_PER_TENANT = 1000;
export const MAX_VENDORS_PER_TENANT = 500;
export const MAX_BATCH = 200;
/** 800-53 including enhancements. */
export const MAX_LINKS_PER_TOOL = 1200;
export const MAX_LINKS_PER_PROGRAM = 20000;
export const MAX_CUI_TOOL_ROWS_PER_PROGRAM = 5000;
export const MAX_DOCS_PER_VENDOR_PER_PROGRAM = 50;

export interface InventoryTool {
  id: string;
  tenantId: string;
  name: string;
  vendorName: string;
  vendorId: string | null;
  mission: string;
  toolType: ToolType | null;
  deployment: ToolDeployment | null;
  assetCategory: CmmcAssetCategory | null;
  fedrampStatus: FedrampStatus;
  /** YYYY-MM-DD */
  fedrampVerifiedOn: string | null;
  crmOnFile: boolean | null;
  endUsers: number | null;
  privilegedUsers: number | null;
  recoveryRank: number | null;
  /** Absent for read roles. */
  annualCostCents?: number | null;
  renewalDate: string | null;
  origin: ToolOrigin;
  seedKey: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export type ToolInput = Partial<
  Pick<
    InventoryTool,
    'name' | 'vendorName' | 'vendorId' | 'mission' | 'toolType' | 'deployment' | 'assetCategory' | 'fedrampStatus' | 'fedrampVerifiedOn' | 'crmOnFile' | 'endUsers' | 'privilegedUsers' | 'annualCostCents' | 'renewalDate' | 'notes'
  >
>;

export interface InventoryVendor {
  id: string;
  tenantId: string;
  name: string;
  kind: VendorKind;
  services: string;
  contractStart: string | null;
  contractEnd: string | null;
  renewalDate: string | null;
  fedrampStatus: FedrampStatus;
  fedrampReference: string;
  fedrampVerifiedOn: string | null;
  crmOnFile: boolean | null;
  lastReviewDate: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ToolControlLink {
  toolId: string;
  controlId: string;
  evidenceSource: boolean;
}

export interface VendorDocumentLink {
  vendorId: string;
  evidenceId: string;
  docKind: VendorDocumentKind;
  linkedAt: string;
  linkedBy: string | null;
}

export interface ProgramInventory {
  programId: string;
  declared: boolean;
  toolIds: string[];
  controlLinks: ToolControlLink[];
  vendorDocuments: VendorDocumentLink[];
}

export interface CuiToolRole {
  toolId: string;
  stores: boolean;
  processes: boolean;
  transmits: boolean;
}

export interface DataInventoryRecord {
  handlesFci: boolean | null;
  categories: { categoryId: string; tools: CuiToolRole[] }[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface InventoryEvent {
  id: string;
  entityKind: 'tool' | 'vendor' | 'order';
  entityId: string | null;
  action: string;
  actor: string;
  createdAt: string;
  fields: Record<string, { sha256: string; length: number } | string | number | boolean | null>;
}

export interface ProgramInventoryEvent {
  id: string;
  action: string;
  entityId: string | null;
  actor: string;
  createdAt: string;
  detail: Record<string, unknown>;
}

/** GET /tools/:toolId/usage: counted per program, archived ones included. */
export interface ToolUsage {
  /** Programs where the tool is in the declared boundary, has control links or is named in the data inventory. */
  programs: number;
  controlLinks: number;
  cuiLinks: number;
}

/** GET /tool-memberships: the declared boundary of each program (an undeclared program lists none and uses the whole register). */
export interface ToolMembership {
  programId: string;
  archived: boolean;
  declared: boolean;
  toolIds: string[];
}

export type ToolBatchSkipReason = 'duplicate_name' | 'duplicate_seed' | 'limit';

/** POST /tools/batch: the tools created, and the items (by position in the request) that were skipped and why. */
export interface ToolBatchResult {
  created: InventoryTool[];
  skipped: { index: number; reason: ToolBatchSkipReason }[];
}
