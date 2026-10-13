import { ComplianceFramework } from './framework';

export type TenantRole = 'TENANT_OWNER' | 'ASSESSOR' | 'VIEWER' | 'MSP_ADMIN';

export type SamStatus = 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'NOT_REGISTERED';

export type AuthProviderType = 'microsoft.com' | 'google.com' | 'password' | 'emailLink' | 'demo';

export interface EnclaveStackProfile {
  identityProvider: 'ENTRA_ID_GOV' | 'ENTRA_ID_COMMERCIAL' | 'OKTA' | 'ACTIVE_DIRECTORY';
  edrSolution: 'CROWDSTRIKE_FALCON' | 'DEFENDER_FOR_ENDPOINT' | 'SENTINELONE' | 'GENERIC_AV';
  infrastructure: 'AZURE_GOV' | 'AWS_GOVCLOUD' | 'ON_PREM_RHEL' | 'HYBRID_CLOUD';
  mdmSolution: 'INTUNE' | 'JAMF' | 'WORKSPACE_ONE' | 'MANUAL_GPO';
  siemSolution: 'SENTINEL' | 'SPLUNK_GOV' | 'ELASTIC' | 'LOCAL_AUDITD';
  odpParams?: Record<string, string>;
}

export interface Tenant {
  id: string; // e.g. "tenant-apex-01"
  name: string; // e.g. "Apex Defense Solutions, LLC"
  cageCode: string; // e.g. "9X7B4"
  samStatus: SamStatus;
  systemName: string; // e.g. "Corporate Operations Enclave (COE)"
  systemOwner: string;
  industry: string;
  domain?: string; // Associated corporate domain e.g. "apexdefense.us"
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  isDemo?: boolean;
  isConfigured?: boolean; // false if setup wizard / initial onboarding is needed
  systemBoundaryScope?: string;
  isSuspended?: boolean; // When true, access to this enclave is frozen while preserving records
  enabledFrameworks?: ComplianceFramework[]; // Enclave-scoped enabled frameworks e.g. ['CMMC_L1', 'CMMC_L2']
  primaryFramework?: ComplianceFramework;   // Default framework to render for this enclave
  stackProfile?: EnclaveStackProfile;
  /** True once this tenant has been confirmed by the server (GET /api/v1/tenants). Its name, settings and the user's role come from there. */
  serverBacked?: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  organization: string; // e.g. "Cyber Vanguard Managed Services (MSP)"
  googleWorkspaceEmail?: string;
  roles: Record<string, TenantRole>; // Map tenantId -> TenantRole
  authProvider?: AuthProviderType;
  emailVerified?: boolean;
  domain?: string;
  idToken?: string;
  isSuperAdmin?: boolean;
}

export interface TenantInvitation {
  id: string;
  token: string;
  tenantId: string;
  tenantName: string;
  email: string;
  role: TenantRole;
  invitedBy: string; // Email or name of inviter
  createdAt: string; // ISO string
  expiresAt: string; // ISO string
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  acceptedAt?: string;
  acceptedByUserId?: string;
  type: 'TENANT_ONBOARDING' | 'STAFF_INVITE';
  systemName?: string;
  cageCode?: string;
  /** True when issued and tracked by the server (the token is hashed there; this record is never persisted locally). */
  serverBacked?: boolean;
  /** The tenant's assessment program as the server holds it (primary framework + every enabled framework). */
  primaryFramework?: string;
  enabledFrameworks?: string[];
}

export interface TeamMember {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: TenantRole;
  status: 'ACTIVE' | 'PENDING_INVITE';
  joinedAt?: string;
  invitedAt?: string;
  invitationToken?: string;
  /** The pending invitation this row represents (server-backed invitations have no retrievable token). */
  invitationId?: string;
  /** The member's user id, for server-backed members. */
  userId?: string;
  avatarUrl?: string;
}

export interface GcpServiceConfig {
  projectId: string;
  region: string;
  gcsBucketName: string;
  cloudSqlInstance: string;
  databaseName: string;
  identityDomain: string;
}

