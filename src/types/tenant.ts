import { ComplianceFramework } from './framework';

export type TenantRole = 'TENANT_OWNER' | 'ASSESSOR' | 'VIEWER' | 'MSP_ADMIN';

export type SamStatus = 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'NOT_REGISTERED';

export type AuthProviderType = 'microsoft.com' | 'google.com' | 'password' | 'emailLink' | 'demo';

export type CommercialLicenseTier = 'FOUNDATIONAL' | 'DEFENSE_PRO' | 'ENTERPRISE';
export type LegacyLicenseTier = 'single-org' | 'msp-assessor';
export type LicenseTier = CommercialLicenseTier | LegacyLicenseTier;

export interface LicenseTierDetails {
  id: CommercialLicenseTier;
  name: string;
  badgeLabel: string;
  price: number;
  priceFormatted: string;
  priceSubtext: string;
  target: string;
  features: string[];
  recommended?: boolean;
}

export const COMMERCIAL_LICENSE_TIERS: Record<CommercialLicenseTier, LicenseTierDetails> = {
  FOUNDATIONAL: {
    id: 'FOUNDATIONAL',
    name: 'Foundational Enclave',
    badgeLabel: 'Foundational ($3,500/yr)',
    price: 3500,
    priceFormatted: '$3,500',
    priceSubtext: '/ year',
    target: 'Small Suppliers & Commercial Organizations (FAR 52.204-21, HIPAA, SOC 2 Type II)',
    features: [
      '1 Enclave Boundary (Cloud SQL RLS isolation)',
      'CMMC Level 1 (17 Controls) or HIPAA / SOC 2',
      'PDF Artifact Exporter & evidence hashing',
      'Single-User Owner administrative seat',
      'Standard Support & Knowledge Base',
    ],
  },
  DEFENSE_PRO: {
    id: 'DEFENSE_PRO',
    name: 'Defense Professional',
    badgeLabel: 'Defense Pro ($7,000/yr)',
    price: 7000,
    priceFormatted: '$7,000',
    priceSubtext: '/ year',
    recommended: true,
    target: 'DoD Prime & Sub-Contractors handling CUI (NIST SP 800-171 / CMMC Level 2)',
    features: [
      'CMMC Level 2 (110 Controls) & NIST SP 800-171',
      'NIST SP 800-53 Rev 5 (Low/Mod + Tactical Overlays)',
      'DISA STIG Library & Ansible/PowerShell Script Generator',
      'Dynamic NIST SP 800-18 SSP & POA&M Compiler',
      'Cross-Framework Evidence Inheritance',
      '5 User Seats included',
    ],
  },
  ENTERPRISE: {
    id: 'ENTERPRISE',
    name: 'Enterprise & Assessor Enclave',
    badgeLabel: 'Enterprise ($14,000/yr)',
    price: 14000,
    priceFormatted: '$14,000',
    priceSubtext: '/ year',
    target: 'Defense MSPs, Multi-CAGE Enterprise Organizations & C3PAO Assessor Networks',
    features: [
      'Unlimited Enclaves / Multi-Boundary Management',
      'OpenSCAP Engine & Asset Sensor API Integration',
      'Custom Baseline Overlays & Tailored Control Scopes',
      'Dedicated Database Isolation & Cloud SQL RLS',
      'Priority 24/7 Defense Engineering Support',
      'Unlimited Assessor & Lead Auditor Team Seats',
    ],
  },
};

export function normalizeLicenseTier(tier?: string | null): CommercialLicenseTier {
  if (!tier) return 'FOUNDATIONAL';
  if (tier === 'DEFENSE_PRO') return 'DEFENSE_PRO';
  if (tier === 'ENTERPRISE' || tier === 'msp-assessor') return 'ENTERPRISE';
  if (tier === 'FOUNDATIONAL' || tier === 'single-org') return 'FOUNDATIONAL';
  return 'FOUNDATIONAL';
}

export function getLicenseTierPrice(tier?: string | null): number {
  const norm = normalizeLicenseTier(tier);
  return COMMERCIAL_LICENSE_TIERS[norm].price;
}

export function getLicenseTierLabel(tier?: string | null): string {
  const norm = normalizeLicenseTier(tier);
  return COMMERCIAL_LICENSE_TIERS[norm].name;
}

export function getLicenseTierBadge(tier?: string | null): { label: string; badge: string; priceFormatted: string } {
  const norm = normalizeLicenseTier(tier);
  const details = COMMERCIAL_LICENSE_TIERS[norm];
  return {
    label: details.name,
    badge: details.badgeLabel,
    priceFormatted: details.priceFormatted,
  };
}

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
  licenseTier?: LicenseTier;
  annualPrice?: number;
  isSuspended?: boolean; // When true, access to this enclave is frozen while preserving records
  enabledFrameworks?: ComplianceFramework[]; // Enclave-scoped enabled frameworks e.g. ['CMMC_L1', 'CMMC_L2']
  primaryFramework?: ComplianceFramework;   // Default framework to render for this enclave
  stackProfile?: EnclaveStackProfile;
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
  licenseTier?: LicenseTier;
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
  licenseTier?: LicenseTier;
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

export interface LicenseRequest {
  id: string;
  fullName: string;
  workEmail: string;
  companyName: string;
  cageCode?: string;
  selectedPlan: LicenseTier;
  inScopeUsers: string;
  targetTimeline: string;
  phoneNumber?: string;
  notes?: string;
  status: 'PENDING_CONTACT' | 'CALL_SCHEDULED' | 'PROVISIONED';
  createdAt: string;
}

