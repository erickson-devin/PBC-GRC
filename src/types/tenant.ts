export type TenantRole = 'TENANT_OWNER' | 'ASSESSOR' | 'VIEWER';

export type SamStatus = 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'NOT_REGISTERED';

export type AuthProviderType = 'microsoft.com' | 'google.com' | 'password' | 'emailLink' | 'demo';

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
}

export interface TenantUserAssignment {
  id: string;
  userId: string;
  tenantId: string;
  role: TenantRole;
  assignedAt: string;
}

export interface GcpServiceConfig {
  projectId: string;
  region: string;
  gcsBucketName: string;
  cloudSqlInstance: string;
  databaseName: string;
  identityDomain: string;
}

export interface LicenseRequest {
  id: string;
  fullName: string;
  workEmail: string;
  companyName: string;
  cageCode?: string;
  selectedPlan: 'single-org' | 'msp-assessor';
  inScopeUsers: string;
  targetTimeline: string;
  phoneNumber?: string;
  notes?: string;
  status: 'PENDING_CONTACT' | 'CALL_SCHEDULED' | 'PROVISIONED';
  createdAt: string;
}
