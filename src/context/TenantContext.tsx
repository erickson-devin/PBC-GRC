import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import {
  Tenant,
  TenantRole,
  User,
  SamStatus,
  LicenseRequest,
  TenantInvitation,
  TeamMember,
  AuthProviderType,
} from '../types/tenant';
import { StorageService, createInitialState } from '../services/storageService';
import { ControlState, EvidenceItem } from '../types/cmmc';
import { ApiClient, UploadUrlResponse } from '../services/apiClient';
import {
  ComplianceFramework,
  BaselineTier,
  OverlayFilters,
  OverlayParameter,
} from '../types/framework';

// Storage Version 4 Keys (Strict separation of Live vs Sandbox)
const LIVE_TENANTS_STORAGE_KEY = 'pbc_live_tenants_v4';
const LIVE_ACTIVE_TENANT_ID_KEY = 'pbc_live_active_tenant_v4';
const DEMO_TENANTS_STORAGE_KEY = 'pbc_demo_tenants_v4';
const DEMO_ACTIVE_TENANT_ID_KEY = 'pbc_demo_active_tenant_v4';
const CURRENT_USER_KEY = 'pbc_active_user_v4';
const LICENSE_REQUESTS_STORAGE_KEY = 'pbc_license_requests_v4';
const INVITATIONS_STORAGE_KEY = 'pbc_tenant_invitations_v4';
const TEAM_MEMBERS_STORAGE_KEY = 'pbc_tenant_team_members_v4';
const ACTIVE_FRAMEWORK_KEY = 'pbc_active_framework_v1';
const ACTIVE_BASELINE_TIER_KEY = 'pbc_active_baseline_tier_v1';
const ACTIVE_OVERLAY_FILTERS_KEY = 'pbc_active_overlay_filters_v1';

// Legacy keys to purge on initialization
const LEGACY_STORAGE_KEYS = [
  'pbc_tenants',
  'pbc_active_tenant',
  'pbc_tenants_registry_v1',
  'pbc_tenants_registry_v2',
  'pbc_tenants_registry_v3',
  'pbc_active_tenant_id_v3',
  'pbc_active_user_v3',
];

/**
 * Generate a cryptographically secure token for tenant and staff onboarding invites
 */
export function generateCryptoToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pbc_inv_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `pbc_inv_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Constructs the canonical invitation acceptance URL
 */
export function buildInviteUrl(token: string): string {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    return `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
  }
  return `https://grc.pitchblackcyber.com/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Super Admin check: Grants clearance to Pitch Black Cyber operators or users with explicit isSuperAdmin: true
 */
export function isSuperAdminUser(user?: User | null): boolean {
  if (!user) return false;
  if (user.isSuperAdmin === true) return true;
  const email = (user.email || '').toLowerCase().trim();
  return (
    email === 'devin@pitchblackcyber.com' ||
    email === 'admin@pitchblackcyber.com' ||
    email.endsWith('@pitchblackcyber.com')
  );
}

/**
 * Normalized string helper for deduplication
 * Removes legal entity suffixes (LLC, Inc, Corp, Co) and symbols to compare true entity identity
 */
export function normalizeOrgName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[,.]/g, '')
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|technologies|systems|group|enclave)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Deduplicate tenant lists by unique id, verified domain, or normalized name
 * Merges duplicate entries and retains the most configured / recent authoritative record
 */
export function deduplicateTenants(tenantList: Tenant[]): Tenant[] {
  const seenIds = new Set<string>();
  const seenEntities = new Map<string, Tenant>();
  const result: Tenant[] = [];

  for (const t of tenantList) {
    if (!t || !t.id) continue;
    if (seenIds.has(t.id)) continue;

    // Use normalized domain or normalized company name as entity identity
    const domainKey = t.domain && t.domain.trim() ? t.domain.toLowerCase().trim() : '';
    const nameKey = normalizeOrgName(t.name);
    const entityKey = domainKey ? `dom:${domainKey}` : `name:${nameKey}`;

    if (seenEntities.has(entityKey)) {
      const existing = seenEntities.get(entityKey)!;
      // Prefer configured over unconfigured, or newer record
      const preferCurrent =
        (!existing.isConfigured && t.isConfigured) ||
        (Boolean(t.isConfigured === existing.isConfigured) &&
          new Date(t.updatedAt || t.createdAt).getTime() >
            new Date(existing.updatedAt || existing.createdAt).getTime());

      if (preferCurrent) {
        const idx = result.findIndex(r => r.id === existing.id);
        if (idx !== -1) {
          result[idx] = t;
          seenEntities.set(entityKey, t);
          seenIds.add(t.id);
          seenIds.delete(existing.id);
        }
      }
    } else {
      seenEntities.set(entityKey, t);
      seenIds.add(t.id);
      result.push(t);
    }
  }

  return result;
}

/**
 * Sandbox Demo Tenants (Evaluator testing and unauthenticated /demo test drive)
 */
export const SEED_TENANTS: Tenant[] = [
  {
    id: 'tenant-vanguard-01',
    name: 'Vanguard Defense Systems LLC',
    cageCode: '8K3R1',
    samStatus: 'ACTIVE',
    systemName: 'Defense Contracting Information Network (DCIN)',
    systemOwner: 'Alex Mercer, CMMC CCA',
    industry: 'Defense IT & Systems Integration',
    domain: 'vanguard-defense.us',
    createdAt: '2026-01-15T08:00:00.000Z',
    updatedAt: '2026-01-15T08:00:00.000Z',
    isDemo: true,
    isConfigured: true,
    primaryFramework: 'CMMC_L1',
    enabledFrameworks: ['CMMC_L1', 'CMMC_L2'],
  },
  {
    id: 'tenant-apex-02',
    name: 'Apex Aerospace Enclave',
    cageCode: '9X7B4',
    samStatus: 'ACTIVE',
    systemName: 'Corporate Operations Enclave (COE)',
    systemOwner: 'Cyber Ops Administrator',
    industry: 'Aerospace & Defense Hardware',
    domain: 'apex-aerospace.us',
    createdAt: '2026-02-01T10:30:00.000Z',
    updatedAt: '2026-02-01T10:30:00.000Z',
    isDemo: true,
    isConfigured: true,
    primaryFramework: 'CMMC_L2',
    enabledFrameworks: ['CMMC_L2', 'NIST_800_53_REV5'],
  },
  {
    id: 'tenant-orbital-03',
    name: 'Orbital Dynamics Aerospace LLC',
    cageCode: '7M2P9',
    samStatus: 'PENDING',
    systemName: 'Orbital Flight Mission Systems (OFMS)',
    systemOwner: 'Dr. Elena Rostova, Director of Mission Assurance',
    industry: 'Satellite Systems & Propulsion R&D',
    domain: 'orbitaldynamics.com',
    createdAt: '2026-02-20T14:15:00.000Z',
    updatedAt: '2026-02-20T14:15:00.000Z',
    isDemo: true,
    isConfigured: true,
    primaryFramework: 'NIST_800_53_REV5',
    enabledFrameworks: ['NIST_800_53_REV5', 'SOC_2_TYPE_II'],
  },
];

export const PRESET_USERS: User[] = [
  {
    id: 'user-alex-lead',
    name: 'Alex Mercer, CMMC CCA',
    email: 'alex.mercer@vanguard-defense.us',
    organization: 'Vanguard Defense Systems / Lead Assessor',
    googleWorkspaceEmail: 'alex.mercer@vanguard-defense.us',
    authProvider: 'microsoft.com',
    roles: {
      'tenant-vanguard-01': 'TENANT_OWNER',
      'tenant-apex-02': 'ASSESSOR',
      'tenant-orbital-03': 'TENANT_OWNER',
    },
  },
  {
    id: 'user-cyber-admin',
    name: 'Cyber Ops Administrator',
    email: 'ops.admin@vanguard-defense.us',
    organization: 'Defense Cyber Operations Command',
    googleWorkspaceEmail: 'ops.admin@vanguard-defense.us',
    authProvider: 'google.com',
    roles: {
      'tenant-vanguard-01': 'ASSESSOR',
      'tenant-apex-02': 'ASSESSOR',
      'tenant-orbital-03': 'ASSESSOR',
    },
  },
  {
    id: 'user-morgan-observer',
    name: 'Morgan Vance (Observer)',
    email: 'm.vance@defense-observer.org',
    organization: 'Third-Party Assessment Org (C3PAO)',
    googleWorkspaceEmail: 'm.vance@defense-observer.org',
    authProvider: 'emailLink',
    roles: {
      'tenant-vanguard-01': 'VIEWER',
      'tenant-apex-02': 'VIEWER',
      'tenant-orbital-03': 'VIEWER',
    },
  },
  {
    id: 'user-devin-superadmin',
    name: 'Devin (Pitch Black Cyber)',
    email: 'devin@pitchblackcyber.com',
    organization: 'Pitch Black Cyber LLC (Super Admin)',
    authProvider: 'google.com',
    isSuperAdmin: true,
    roles: {
      'tenant-vanguard-01': 'TENANT_OWNER',
      'tenant-apex-02': 'TENANT_OWNER',
      'tenant-orbital-03': 'TENANT_OWNER',
    },
  },
];

export const SUPER_ADMIN_PRESET_USER: User = PRESET_USERS[3];

export const SEED_INVITATIONS: TenantInvitation[] = [
  {
    id: 'inv-seed-01',
    token: 'pbc_inv_7f4d1e9a3b8c2d5e0f1a4b7c8d9e2f3a',
    tenantId: 'tenant-vanguard-01',
    tenantName: 'Vanguard Defense Systems LLC',
    email: 'auditor@defense-c3pao.org',
    role: 'ASSESSOR',
    invitedBy: 'alex.mercer@vanguard-defense.us',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'PENDING',
    type: 'STAFF_INVITE',
    systemName: 'Defense Contracting Information Network (DCIN)',
    cageCode: '8K3R1',
    licenseTier: 'single-org',
  },
  {
    id: 'inv-seed-02',
    token: 'pbc_inv_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
    tenantId: 'tenant-apex-02',
    tenantName: 'Apex Aerospace Enclave',
    email: 'ciso@apex-aerospace.us',
    role: 'TENANT_OWNER',
    invitedBy: 'devin@pitchblackcyber.com',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'PENDING',
    type: 'TENANT_ONBOARDING',
    systemName: 'Corporate Operations Enclave (COE)',
    cageCode: '9X7B4',
    licenseTier: 'single-org',
  },
];

export const SEED_TEAM_MEMBERS: Record<string, TeamMember[]> = {
  'tenant-vanguard-01': [
    {
      id: 'mem-alex-01',
      tenantId: 'tenant-vanguard-01',
      email: 'alex.mercer@vanguard-defense.us',
      name: 'Alex Mercer, CMMC CCA',
      role: 'TENANT_OWNER',
      status: 'ACTIVE',
      joinedAt: '2026-01-15T08:00:00.000Z',
    },
    {
      id: 'mem-ops-02',
      tenantId: 'tenant-vanguard-01',
      email: 'ops.admin@vanguard-defense.us',
      name: 'Cyber Ops Administrator',
      role: 'ASSESSOR',
      status: 'ACTIVE',
      joinedAt: '2026-01-16T10:00:00.000Z',
    },
    {
      id: 'mem-vance-03',
      tenantId: 'tenant-vanguard-01',
      email: 'm.vance@defense-observer.org',
      name: 'Morgan Vance (Observer)',
      role: 'VIEWER',
      status: 'ACTIVE',
      joinedAt: '2026-01-20T14:30:00.000Z',
    },
    {
      id: 'mem-auditor-04',
      tenantId: 'tenant-vanguard-01',
      email: 'auditor@defense-c3pao.org',
      name: 'External C3PAO Lead',
      role: 'ASSESSOR',
      status: 'PENDING_INVITE',
      invitedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      invitationToken: 'pbc_inv_7f4d1e9a3b8c2d5e0f1a4b7c8d9e2f3a',
    },
  ],
};

export const DEFAULT_BLANK_TENANT: Tenant = {
  id: 'tenant-live-default-01',
  name: 'Pitch Black Cyber LLC',
  cageCode: 'PENDING',
  samStatus: 'ACTIVE',
  systemName: 'Corporate IT & Operations Boundary',
  systemOwner: 'Corporate Security Lead',
  industry: 'Defense Industrial Base (DIB)',
  domain: 'pitchblackcyber.com',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isDemo: false,
  isConfigured: false,
  primaryFramework: 'CMMC_L1',
  enabledFrameworks: ['CMMC_L1'],
};

// Check if current URL route is sandbox demo
const checkIsSandboxRoute = (): boolean => {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  const search = window.location.search.toLowerCase();
  return (
    hash.startsWith('#demo') ||
    hash.startsWith('#sandbox') ||
    path === '/demo' ||
    path === '/sandbox' ||
    search.includes('mode=sandbox') ||
    search.includes('view=demo')
  );
};

interface TenantContextType {
  tenants: Tenant[];
  currentTenant: Tenant;
  currentUser: User;
  currentRole: TenantRole;
  canEdit: boolean;
  canManageTenant: boolean;
  isSandboxMode: boolean;
  isMspUser: boolean;
  isSuperAdmin: boolean;
  needsOnboarding: boolean;
  isOnboardingModalOpen: boolean;
  setIsOnboardingModalOpen: (open: boolean) => void;
  isTeamModalOpen: boolean;
  setIsTeamModalOpen: (open: boolean) => void;
  isStigModalOpen: boolean;
  setIsStigModalOpen: (open: boolean) => void;
  licenseRequests: LicenseRequest[];
  invitations: TenantInvitation[];
  teamMembers: Record<string, TeamMember[]>;
  switchTenant: (tenantId: string) => void;
  createTenant: (tenantData: {
    name: string;
    cageCode: string;
    samStatus: SamStatus;
    systemName: string;
    systemOwner: string;
    industry: string;
    domain?: string;
    isDemo?: boolean;
    isConfigured?: boolean;
    licenseTier?: 'single-org' | 'msp-assessor';
    enabledFrameworks?: ComplianceFramework[];
    primaryFramework?: ComplianceFramework;
  }) => Tenant;
  provisionTenant: (data: {
    companyName: string;
    cageCode?: string;
    systemBoundaryName?: string;
    licenseTier: 'single-org' | 'msp-assessor';
    tenantOwnerEmail: string;
    primaryFramework?: ComplianceFramework;
    enabledFrameworks?: ComplianceFramework[];
  }) => Promise<{ tenant: Tenant; invitation: TenantInvitation; inviteUrl: string }>;
  updateTenantFrameworkScope: (
    tenantId: string,
    enabledFrameworks: ComplianceFramework[],
    primaryFramework: ComplianceFramework
  ) => void;
  claimInviteToken: (
    token: string,
    userCredentials: { id?: string; name: string; email: string; authProvider: AuthProviderType }
  ) => Promise<{ success: boolean; tenant?: Tenant; role?: TenantRole; error?: string }>;
  inviteStaffMember: (
    tenantId: string,
    email: string,
    role: 'ASSESSOR' | 'VIEWER'
  ) => Promise<{ invitation: TenantInvitation; inviteUrl: string }>;
  revokeInvitation: (invitationId: string) => void;
  resendInvitation: (invitationId: string) => Promise<{ inviteUrl: string }>;
  updateMemberRole: (tenantId: string, memberId: string, newRole: TenantRole) => void;
  removeMember: (tenantId: string, memberId: string) => void;
  getTenantMembers: (tenantId: string) => TeamMember[];
  getInvitationByToken: (token: string) => TenantInvitation | undefined;

  initializeBlankTenant: (email: string, domain?: string, orgName?: string) => Tenant;
  completeTenantOnboarding: (tenantId: string, data: {
    organizationName: string;
    cageCode?: string;
    samStatus?: SamStatus;
    systemName: string;
    systemOwner: string;
    systemBoundaryScope?: string;
  }) => void;
  updateTenant: (tenantId: string, updates: Partial<Tenant>) => void;
  deleteTenant: (tenantId: string) => void;
  switchUserRole: (role: TenantRole) => void;
  switchUser: (user: User) => void;
  syncAuthUser: (user: User, preferredTenantId?: string) => void;
  resolveTenantForEmail: (email: string) => { tenant: Tenant; role: TenantRole };
  submitLicenseRequest: (requestData: Omit<LicenseRequest, 'id' | 'createdAt' | 'status'>) => Promise<LicenseRequest>;
  // Cloud SQL Live Sync Engine
  liveControls: Record<string, ControlState> | null;
  liveEvidence: EvidenceItem[] | null;
  isSyncing: boolean;
  syncError: string | null;
  refreshLiveData: (
    tenantToFetch?: string,
    frameworkToFetch?: ComplianceFramework,
    baselineToFetch?: BaselineTier,
    overlayToFetch?: OverlayParameter
  ) => Promise<void>;
  updateLiveControl: (controlId: string, updates: Partial<ControlState>) => Promise<ControlState | null>;
  createLiveEvidenceUploadUrl: (payload: {
    controlId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileHash: string;
    description?: string;
  }) => Promise<UploadUrlResponse | null>;
  // Multi-Framework & Baseline Architecture
  activeFramework: ComplianceFramework;
  setActiveFramework: (framework: ComplianceFramework) => void;
  activeBaselineTier: BaselineTier;
  setActiveBaselineTier: (tier: BaselineTier) => void;
  activeOverlayFilters: OverlayFilters;
  setActiveOverlayFilters: React.Dispatch<React.SetStateAction<OverlayFilters>>;
  toggleNonNetworkedOverlay: () => void;
}

const TenantContext = createContext<TenantContextType | undefined>(undefined);

export const TenantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Mode detection: Sandbox (/demo) vs Live Enclave (/app)
  const [isSandboxMode, setIsSandboxMode] = useState<boolean>(() => checkIsSandboxRoute());

  useEffect(() => {
    const handleLocationChange = () => {
      setIsSandboxMode(checkIsSandboxRoute());
    };
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  // 1. LIVE TENANTS: Strictly non-demo organizations created or assigned to real users
  const [liveTenants, setLiveTenants] = useState<Tenant[]>(() => {
    try {
      // Check v4 key
      const savedLive = localStorage.getItem(LIVE_TENANTS_STORAGE_KEY);
      if (savedLive) {
        const parsed = JSON.parse(savedLive) as Tenant[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const clean = parsed
            .filter(t => !t.isDemo && !SEED_TENANTS.some(st => st.id === t.id))
            .map(t => ({
              ...t,
              primaryFramework: t.primaryFramework || 'CMMC_L1',
              enabledFrameworks: (t.enabledFrameworks && t.enabledFrameworks.length > 0) ? t.enabledFrameworks : [t.primaryFramework || 'CMMC_L1'],
            }));
          if (clean.length > 0) {
            return deduplicateTenants(clean);
          }
        }
      }

      // Migration: migrate any non-demo tenants from legacy storage
      const legacySaved = localStorage.getItem('pbc_tenants_registry_v3');
      if (legacySaved) {
        const parsed = JSON.parse(legacySaved) as Tenant[];
        if (Array.isArray(parsed)) {
          const nonDemo = parsed
            .filter(t => !t.isDemo && !SEED_TENANTS.some(st => st.id === t.id))
            .map(t => ({
              ...t,
              primaryFramework: t.primaryFramework || 'CMMC_L1',
              enabledFrameworks: (t.enabledFrameworks && t.enabledFrameworks.length > 0) ? t.enabledFrameworks : [t.primaryFramework || 'CMMC_L1'],
            }));
          const deduplicated = deduplicateTenants(nonDemo);
          if (deduplicated.length > 0) {
            return deduplicated;
          }
        }
      }
    } catch (err) {
      console.error('Error initializing live tenants:', err);
    } finally {
      // Purge legacy storage keys
      LEGACY_STORAGE_KEYS.forEach(k => {
        try { localStorage.removeItem(k); } catch {}
      });
    }

    return [DEFAULT_BLANK_TENANT];
  });

  // 2. DEMO TENANTS: Strictly sample demo organizations for testing
  const [demoTenants, setDemoTenants] = useState<Tenant[]>(() => {
    try {
      const savedDemo = localStorage.getItem(DEMO_TENANTS_STORAGE_KEY);
      if (savedDemo) {
        const parsed = JSON.parse(savedDemo) as Tenant[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = parsed.map(t => {
            const seedMatch = SEED_TENANTS.find(st => st.id === t.id);
            return {
              ...t,
              primaryFramework: t.primaryFramework || seedMatch?.primaryFramework || 'CMMC_L1',
              enabledFrameworks: (t.enabledFrameworks && t.enabledFrameworks.length > 0)
                ? t.enabledFrameworks
                : (seedMatch?.enabledFrameworks || [t.primaryFramework || 'CMMC_L1']),
            };
          });
          return deduplicateTenants(migrated);
        }
      }
    } catch {
      // fallback
    }
    return SEED_TENANTS;
  });

  // Active Tenant IDs per mode
  const [liveActiveTenantId, setLiveActiveTenantId] = useState<string>(() => {
    const saved = localStorage.getItem(LIVE_ACTIVE_TENANT_ID_KEY);
    if (saved && liveTenants.some(t => t.id === saved)) {
      return saved;
    }
    return liveTenants[0]?.id || DEFAULT_BLANK_TENANT.id;
  });

  const [demoActiveTenantId, setDemoActiveTenantId] = useState<string>(() => {
    const saved = localStorage.getItem(DEMO_ACTIVE_TENANT_ID_KEY);
    if (saved && demoTenants.some(t => t.id === saved)) {
      return saved;
    }
    return demoTenants[0]?.id || SEED_TENANTS[0].id;
  });

  // Active User Profile
  const [currentUser, setCurrentUser] = useState<User>(() => {
    try {
      const saved = localStorage.getItem(CURRENT_USER_KEY);
      if (saved) {
        return JSON.parse(saved) as User;
      }
    } catch (e) {
      console.error('Error loading user from storage:', e);
    }
    return PRESET_USERS[0];
  });

  // Inbound License Requests
  const [licenseRequests, setLicenseRequests] = useState<LicenseRequest[]>(() => {
    try {
      const saved = localStorage.getItem(LICENSE_REQUESTS_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved) as LicenseRequest[];
      }
    } catch {
      // ignore
    }
    return [];
  });

  // Tenant Invitations
  const [invitations, setInvitations] = useState<TenantInvitation[]>(() => {
    try {
      const saved = localStorage.getItem(INVITATIONS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as TenantInvitation[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Error loading invitations:', e);
    }
    return SEED_INVITATIONS;
  });

  // Tenant Team Members
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember[]>>(() => {
    try {
      const saved = localStorage.getItem(TEAM_MEMBERS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, TeamMember[]>;
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Error loading team members:', e);
    }
    return SEED_TEAM_MEMBERS;
  });

  const [isOnboardingModalOpen, setIsOnboardingModalOpen] = useState<boolean>(false);
  const [isTeamModalOpen, setIsTeamModalOpen] = useState<boolean>(false);
  const [isStigModalOpen, setIsStigModalOpen] = useState<boolean>(false);

  // Sync storage
  useEffect(() => {
    localStorage.setItem(LIVE_TENANTS_STORAGE_KEY, JSON.stringify(deduplicateTenants(liveTenants)));
  }, [liveTenants]);

  useEffect(() => {
    localStorage.setItem(LIVE_ACTIVE_TENANT_ID_KEY, liveActiveTenantId);
  }, [liveActiveTenantId]);

  useEffect(() => {
    localStorage.setItem(DEMO_TENANTS_STORAGE_KEY, JSON.stringify(deduplicateTenants(demoTenants)));
  }, [demoTenants]);

  useEffect(() => {
    localStorage.setItem(DEMO_ACTIVE_TENANT_ID_KEY, demoActiveTenantId);
  }, [demoActiveTenantId]);

  useEffect(() => {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem(LICENSE_REQUESTS_STORAGE_KEY, JSON.stringify(licenseRequests));
  }, [licenseRequests]);

  useEffect(() => {
    localStorage.setItem(INVITATIONS_STORAGE_KEY, JSON.stringify(invitations));
  }, [invitations]);

  useEffect(() => {
    localStorage.setItem(TEAM_MEMBERS_STORAGE_KEY, JSON.stringify(teamMembers));
  }, [teamMembers]);


  // Current active tenant list based strictly on mode
  const tenants = useMemo(() => {
    if (isSandboxMode) {
      return demoTenants;
    }
    // LIVE MODE: Render ONLY real, non-demo organizations!
    return liveTenants;
  }, [isSandboxMode, demoTenants, liveTenants]);

  // Current active tenant entity
  const currentTenant = useMemo(() => {
    if (isSandboxMode) {
      return demoTenants.find(t => t.id === demoActiveTenantId) || demoTenants[0] || SEED_TENANTS[0];
    }
    return liveTenants.find(t => t.id === liveActiveTenantId) || liveTenants[0] || DEFAULT_BLANK_TENANT;
  }, [isSandboxMode, demoTenants, demoActiveTenantId, liveTenants, liveActiveTenantId]);

  // Determine if active user holds an MSP role or has multi-tenant management rights
  const isMspUser = useMemo(() => {
    if (isSandboxMode) {
      // In sandbox mode, allow prospective customers to test drive switching between client enclaves
      return true;
    }
    // In live mode, only allow if user has explicit MSP_ADMIN role or MSP license tier
    const roleInCurrent = currentUser.roles?.[currentTenant.id];
    const hasMspRole =
      roleInCurrent === 'MSP_ADMIN' ||
      Object.values(currentUser.roles || {}).includes('MSP_ADMIN');
    const isMspTier =
      currentUser.licenseTier === 'msp-assessor' ||
      currentTenant.licenseTier === 'msp-assessor';

    return Boolean(hasMspRole || isMspTier || liveTenants.length > 1);
  }, [isSandboxMode, currentUser, currentTenant, liveTenants.length]);

  const isSuperAdmin = useMemo(() => {
    return isSuperAdminUser(currentUser);
  }, [currentUser]);

  // Multi-Framework & Baseline State
  const [activeFramework, setActiveFrameworkState] = useState<ComplianceFramework>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_FRAMEWORK_KEY);
      if (saved && ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'].includes(saved)) {
        return saved as ComplianceFramework;
      }
    } catch (e) {
      console.warn('Error loading active framework:', e);
    }
    return 'CMMC_L1';
  });

  const [activeBaselineTier, setActiveBaselineTierState] = useState<BaselineTier>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_BASELINE_TIER_KEY);
      if (saved && ['LOW_LOW_LOW', 'MOD_MOD_MOD', 'LOW_LOW_MOD'].includes(saved)) {
        return saved as BaselineTier;
      }
    } catch (e) {
      console.warn('Error loading active baseline tier:', e);
    }
    return 'LOW_LOW_LOW';
  });

  const [activeOverlayFilters, setActiveOverlayFilters] = useState<OverlayFilters>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_OVERLAY_FILTERS_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Error loading active overlay filters:', e);
    }
    return { nonNetworkedOnly: false };
  });

  const setActiveFramework = useCallback((framework: ComplianceFramework) => {
    setActiveFrameworkState(framework);
    try {
      localStorage.setItem(ACTIVE_FRAMEWORK_KEY, framework);
    } catch {}
  }, []);

  // When active tenant changes, dynamically synchronize active framework with the enclave's enabled framework scope
  useEffect(() => {
    const tenantEnabled: ComplianceFramework[] = currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0
      ? currentTenant.enabledFrameworks
      : (currentTenant.primaryFramework ? [currentTenant.primaryFramework] : ['CMMC_L1']);
    const tenantPrimary: ComplianceFramework = currentTenant.primaryFramework || tenantEnabled[0] || 'CMMC_L1';

    if (!tenantEnabled.includes(activeFramework)) {
      setActiveFramework(tenantPrimary);
    }
  }, [currentTenant.id, currentTenant.primaryFramework, currentTenant.enabledFrameworks, activeFramework, setActiveFramework]);

  const setActiveBaselineTier = useCallback((tier: BaselineTier) => {
    setActiveBaselineTierState(tier);
    try {
      localStorage.setItem(ACTIVE_BASELINE_TIER_KEY, tier);
    } catch {}
  }, []);

  const toggleNonNetworkedOverlay = useCallback(() => {
    setActiveOverlayFilters(prev => {
      const next = { ...prev, nonNetworkedOnly: !prev.nonNetworkedOnly };
      try {
        localStorage.setItem(ACTIVE_OVERLAY_FILTERS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_OVERLAY_FILTERS_KEY, JSON.stringify(activeOverlayFilters));
    } catch {}
  }, [activeOverlayFilters]);

  // ============================================================================
  // Cloud SQL Express API Live Sync Engine (Row-Level Security Tenant Isolation)
  // ============================================================================
  const [liveControls, setLiveControls] = useState<Record<string, ControlState> | null>(null);
  const [liveEvidence, setLiveEvidence] = useState<EvidenceItem[] | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  /**
   * Pull live control states and evidence artifacts from Cloud SQL /api/v1
   * Operates with dynamic framework, baseline, and overlay parameters
   */
  const refreshLiveData = useCallback(async (
    tenantToFetch?: string,
    frameworkToFetch?: ComplianceFramework,
    baselineToFetch?: BaselineTier,
    overlayToFetch?: OverlayParameter
  ) => {
    const targetTenantId = tenantToFetch || currentTenant.id;

    // Sandbox / Demo Fallback: Do not make API calls for demo/sandbox tenants
    if (isSandboxMode || currentTenant.isDemo || targetTenantId.startsWith('tenant-vanguard-') || targetTenantId.startsWith('tenant-apex-')) {
      setLiveControls(null);
      setLiveEvidence(null);
      return;
    }

    const token = ApiClient.getToken();
    if (!token) {
      // Unauthenticated fallback
      return;
    }

    setIsSyncing(true);
    setSyncError(null);

    const fw = frameworkToFetch || activeFramework;
    const bl = baselineToFetch || activeBaselineTier;
    const ov = overlayToFetch || (activeOverlayFilters.nonNetworkedOnly ? 'NON_NETWORKED' : 'NONE');

    try {
      const [controlsList, evidenceList] = await Promise.all([
        ApiClient.getControls(targetTenantId, { framework: fw, baseline: bl, overlay: ov }),
        ApiClient.getEvidence(targetTenantId),
      ]);

      const controlsMap: Record<string, ControlState> = {};
      for (const ctrl of controlsList) {
        controlsMap[ctrl.id] = ctrl;
      }

      setLiveControls(controlsMap);
      setLiveEvidence(evidenceList);
    } catch (err: any) {
      console.warn('[TenantContext] Live sync fallback to local storage:', err.message);
      setSyncError(err.message);
    } finally {
      setIsSyncing(false);
    }
  }, [isSandboxMode, currentTenant.id, currentTenant.isDemo, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly]);

  // Automatically pull live controls & evidence when tenant, framework, or overlay changes
  useEffect(() => {
    if (!isSandboxMode && !currentTenant.isDemo && ApiClient.getToken()) {
      refreshLiveData(currentTenant.id, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly ? 'NON_NETWORKED' : 'NONE');
    } else {
      setLiveControls(null);
      setLiveEvidence(null);
    }
  }, [currentTenant.id, isSandboxMode, currentTenant.isDemo, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly, refreshLiveData]);

  const updateLiveControl = useCallback(async (
    controlId: string,
    updates: Partial<ControlState>
  ): Promise<ControlState | null> => {
    if (isSandboxMode || currentTenant.isDemo) {
      return null;
    }
    try {
      const updated = await ApiClient.updateControl(currentTenant.id, controlId, updates);
      setLiveControls(prev => ({
        ...prev,
        [controlId]: updated,
      }));
      return updated;
    } catch (err: any) {
      console.error('[TenantContext] Failed to update live control:', err);
      return null;
    }
  }, [isSandboxMode, currentTenant.id, currentTenant.isDemo]);

  const createLiveEvidenceUploadUrl = useCallback(async (payload: {
    controlId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileHash: string;
    description?: string;
  }): Promise<UploadUrlResponse | null> => {
    if (isSandboxMode || currentTenant.isDemo) {
      return null;
    }
    try {
      const resp = await ApiClient.requestUploadUrl(currentTenant.id, payload);
      setLiveEvidence(prev => [resp.evidence, ...(prev || [])]);
      return resp;
    } catch (err: any) {
      console.error('[TenantContext] Failed to request live upload URL:', err);
      return null;
    }
  }, [isSandboxMode, currentTenant.id, currentTenant.isDemo]);


  // Check if active tenant requires initial setup wizard
  const needsOnboarding = useMemo(() => {
    if (isSandboxMode) return false;
    return currentTenant.isConfigured === false;
  }, [isSandboxMode, currentTenant.isConfigured]);

  // Automatically trigger onboarding modal if active live tenant requires setup
  useEffect(() => {
    if (!isSandboxMode && needsOnboarding) {
      setIsOnboardingModalOpen(true);
    }
  }, [isSandboxMode, needsOnboarding]);

  // Current role in active tenant
  const currentRole: TenantRole = useMemo(() => {
    if (currentUser.roles && currentUser.roles[currentTenant.id]) {
      return currentUser.roles[currentTenant.id];
    }
    return 'TENANT_OWNER';
  }, [currentUser.roles, currentTenant.id]);

  const canEdit = useMemo(() => {
    return currentRole === 'TENANT_OWNER' || currentRole === 'ASSESSOR' || currentRole === 'MSP_ADMIN';
  }, [currentRole]);

  const canManageTenant = useMemo(() => {
    return currentRole === 'TENANT_OWNER' || currentRole === 'MSP_ADMIN';
  }, [currentRole]);

  const switchTenant = useCallback((tenantId: string) => {
    if (isSandboxMode) {
      if (demoTenants.some(t => t.id === tenantId)) {
        setDemoActiveTenantId(tenantId);
      }
    } else {
      if (liveTenants.some(t => t.id === tenantId)) {
        setLiveActiveTenantId(tenantId);
      }
    }
  }, [isSandboxMode, demoTenants, liveTenants]);

  /**
   * Create a new organization with strict deduplication
   */
  const createTenant = useCallback((data: {
    name: string;
    cageCode: string;
    samStatus: SamStatus;
    systemName: string;
    systemOwner: string;
    industry: string;
    domain?: string;
    isDemo?: boolean;
    isConfigured?: boolean;
    licenseTier?: 'single-org' | 'msp-assessor';
    enabledFrameworks?: ComplianceFramework[];
    primaryFramework?: ComplianceFramework;
  }): Tenant => {
    const normName = normalizeOrgName(data.name);

    if (isSandboxMode) {
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
      const newTenantId = `tenant-demo-${slug}-${Date.now().toString(36).substring(2, 6)}`;
      const primFw = data.primaryFramework || 'CMMC_L1';
      const enFw = data.enabledFrameworks && data.enabledFrameworks.length > 0 ? data.enabledFrameworks : [primFw];
      const newDemoTenant: Tenant = {
        id: newTenantId,
        name: data.name.trim(),
        cageCode: data.cageCode.trim().toUpperCase() || 'PENDING',
        samStatus: data.samStatus || 'ACTIVE',
        systemName: data.systemName.trim() || `${data.name} Operations Boundary`,
        systemOwner: data.systemOwner.trim(),
        industry: data.industry || 'Defense Industrial Base (DIB)',
        domain: data.domain,
        isDemo: true,
        isConfigured: data.isConfigured ?? true,
        licenseTier: data.licenseTier,
        primaryFramework: primFw,
        enabledFrameworks: enFw,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setDemoTenants(prev => deduplicateTenants([...prev, newDemoTenant]));
      setDemoActiveTenantId(newTenantId);
      setActiveFramework(primFw);
      return newDemoTenant;
    }

    // Live mode deduplication check
    const existing = liveTenants.find(t =>
      (data.domain && t.domain && t.domain.toLowerCase().trim() === data.domain.toLowerCase().trim()) ||
      normalizeOrgName(t.name) === normName
    );

    if (existing) {
      // Update existing rather than creating duplicate
      setLiveTenants(prev => prev.map(t => (t.id === existing.id ? {
        ...t,
        name: data.name.trim(),
        cageCode: data.cageCode.trim().toUpperCase() || t.cageCode,
        samStatus: data.samStatus || t.samStatus,
        systemName: data.systemName.trim() || t.systemName,
        systemOwner: data.systemOwner.trim() || t.systemOwner,
        industry: data.industry || t.industry,
        primaryFramework: data.primaryFramework || t.primaryFramework || 'CMMC_L1',
        enabledFrameworks: data.enabledFrameworks || t.enabledFrameworks || ['CMMC_L1'],
        updatedAt: new Date().toISOString(),
      } : t)));
      setLiveActiveTenantId(existing.id);
      return existing;
    }

    const slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
    const newTenantId = `tenant-${slug}-${Date.now().toString(36).substring(2, 6)}`;
    const primFw = data.primaryFramework || 'CMMC_L1';
    const enFw = data.enabledFrameworks && data.enabledFrameworks.length > 0 ? data.enabledFrameworks : [primFw];
    const newTenant: Tenant = {
      id: newTenantId,
      name: data.name.trim(),
      cageCode: data.cageCode.trim().toUpperCase() || 'PENDING',
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName.trim() || `${data.name} Operations Boundary`,
      systemOwner: data.systemOwner.trim(),
      industry: data.industry || 'Defense Industrial Base (DIB)',
      domain: data.domain,
      isDemo: false,
      isConfigured: data.isConfigured ?? true,
      licenseTier: data.licenseTier,
      primaryFramework: primFw,
      enabledFrameworks: enFw,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setLiveTenants(prev => deduplicateTenants([...prev, newTenant]));
    setLiveActiveTenantId(newTenantId);

    // Assign creator as TENANT_OWNER
    setCurrentUser(prevUser => ({
      ...prevUser,
      roles: {
        ...prevUser.roles,
        [newTenantId]: 'TENANT_OWNER',
      },
    }));

    return newTenant;
  }, [isSandboxMode, liveTenants]);

  /**
   * Initializes a brand-new blank tenant state for an authenticated contractor
   * Performs deduplication check by domain and normalized company name
   */
  const initializeBlankTenant = useCallback((email: string, domain?: string, orgName?: string): Tenant => {
    const parts = email.toLowerCase().trim().split('@');
    const emailDomain = domain || (parts[1] ?? 'pitchblackcyber.com');
    const domainPrefix = emailDomain.split('.')[0];
    const formattedTitle = orgName || (domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1) + ' LLC');
    const normName = normalizeOrgName(formattedTitle);

    // 1. DEDUPLICATION CHECK: Check if an existing live tenant matches by domain or normalized name
    const existing = liveTenants.find(t =>
      (t.domain && t.domain.toLowerCase().trim() === emailDomain.toLowerCase().trim()) ||
      normalizeOrgName(t.name) === normName
    );

    if (existing) {
      setLiveActiveTenantId(existing.id);
      setCurrentUser(prevUser => ({
        ...prevUser,
        roles: {
          ...prevUser.roles,
          [existing.id]: prevUser.roles[existing.id] || 'TENANT_OWNER',
        },
      }));
      return existing;
    }

    // 2. If no duplicate exists, create new blank tenant
    const slug = domainPrefix.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
    const newTenantId = `tenant-${slug}-${Date.now().toString(36).substring(2, 7)}`;

    const newTenant: Tenant = {
      id: newTenantId,
      name: formattedTitle,
      cageCode: '',
      samStatus: 'NOT_REGISTERED',
      systemName: `${formattedTitle} Operations Boundary`,
      systemOwner: email,
      industry: 'Defense Industrial Base (DIB)',
      domain: emailDomain,
      isDemo: false,
      isConfigured: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Explicitly initialize 100% blank assessment state in localStorage
    const blankState = createInitialState(newTenant);
    StorageService.saveAssessment(newTenantId, blankState);

    // Register into liveTenants
    setLiveTenants(prev => deduplicateTenants([...prev.filter(t => t.id !== DEFAULT_BLANK_TENANT.id), newTenant]));
    setLiveActiveTenantId(newTenantId);

    // Assign authenticated user as TENANT_OWNER
    setCurrentUser(prevUser => ({
      ...prevUser,
      roles: {
        ...prevUser.roles,
        [newTenantId]: 'TENANT_OWNER',
      },
    }));

    setIsOnboardingModalOpen(true);
    return newTenant;
  }, [liveTenants]);

  /**
   * Complete 2-step onboarding wizard and finalize tenant configuration
   */
  const completeTenantOnboarding = useCallback((tenantId: string, data: {
    organizationName: string;
    cageCode?: string;
    samStatus?: SamStatus;
    systemName: string;
    systemOwner: string;
    systemBoundaryScope?: string;
  }) => {
    setLiveTenants(prev => {
      const updated = prev.map(t => {
        if (t.id === tenantId) {
          return {
            ...t,
            name: data.organizationName.trim(),
            cageCode: (data.cageCode || 'PENDING').trim().toUpperCase(),
            samStatus: data.samStatus || 'ACTIVE',
            systemName: data.systemName.trim(),
            systemOwner: data.systemOwner.trim(),
            systemBoundaryScope: data.systemBoundaryScope?.trim(),
            isConfigured: true,
            isDemo: false,
            updatedAt: new Date().toISOString(),
          };
        }
        return t;
      });
      return deduplicateTenants(updated);
    });

    // Update existing assessment's SSP metadata in storage
    const currentAssessment = StorageService.loadAssessment({
      id: tenantId,
      name: data.organizationName,
      cageCode: data.cageCode || '',
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName,
      systemOwner: data.systemOwner,
      industry: 'Defense Industrial Base (DIB)',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDemo: false,
      isConfigured: true,
    });

    currentAssessment.sspMetadata = {
      ...currentAssessment.sspMetadata,
      organizationName: data.organizationName.trim(),
      cageCode: (data.cageCode || '').trim().toUpperCase(),
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName.trim(),
      systemOwner: data.systemOwner.trim(),
      systemBoundaryScope: data.systemBoundaryScope?.trim() || currentAssessment.sspMetadata.systemBoundaryScope,
      lastUpdated: new Date().toISOString(),
    };

    StorageService.saveAssessment(tenantId, currentAssessment);
    setIsOnboardingModalOpen(false);
  }, []);

  const updateTenant = useCallback((tenantId: string, updates: Partial<Tenant>) => {
    if (isSandboxMode) {
      setDemoTenants(prev => prev.map(t => (t.id === tenantId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t)));
    } else {
      setLiveTenants(prev => prev.map(t => (t.id === tenantId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t)));
    }
  }, [isSandboxMode]);

  const updateTenantFrameworkScope = useCallback((
    tenantId: string,
    enabledFrameworks: ComplianceFramework[],
    primaryFramework: ComplianceFramework
  ) => {
    const validEnabled = enabledFrameworks.length > 0 ? enabledFrameworks : [primaryFramework];
    const validPrimary = validEnabled.includes(primaryFramework) ? primaryFramework : validEnabled[0];

    updateTenant(tenantId, {
      enabledFrameworks: validEnabled,
      primaryFramework: validPrimary,
    });

    if (currentTenant.id === tenantId) {
      setActiveFramework(validPrimary);
    }
  }, [updateTenant, currentTenant.id, setActiveFramework]);

  const deleteTenant = useCallback((tenantId: string) => {
    const list = isSandboxMode ? demoTenants : liveTenants;
    if (list.length <= 1) {
      alert('Cannot delete the only remaining organization in this enclave.');
      return;
    }
    if (isSandboxMode) {
      const filtered = demoTenants.filter(t => t.id !== tenantId);
      setDemoTenants(filtered);
      if (demoActiveTenantId === tenantId) setDemoActiveTenantId(filtered[0].id);
    } else {
      const filtered = liveTenants.filter(t => t.id !== tenantId);
      setLiveTenants(filtered);
      if (liveActiveTenantId === tenantId) setLiveActiveTenantId(filtered[0].id);
    }
  }, [isSandboxMode, demoTenants, demoActiveTenantId, liveTenants, liveActiveTenantId]);

  const switchUserRole = useCallback((role: TenantRole) => {
    setCurrentUser(prev => ({
      ...prev,
      roles: {
        ...prev.roles,
        [currentTenant.id]: role,
      },
    }));
  }, [currentTenant.id]);

  const switchUser = useCallback((user: User) => {
    setCurrentUser(user);
    const accessibleTenants = Object.keys(user.roles || {});
    if (accessibleTenants.length > 0) {
      const targetId = accessibleTenants[0];
      if (isSandboxMode) {
        setDemoActiveTenantId(targetId);
      } else {
        setLiveActiveTenantId(targetId);
      }
    }
  }, [isSandboxMode]);

  /**
   * Domain-based auto-tenant matching with deduplication
   */
  const resolveTenantForEmail = useCallback((email: string): { tenant: Tenant; role: TenantRole } => {
    const parts = email.toLowerCase().trim().split('@');
    if (parts.length < 2) {
      return { tenant: currentTenant, role: currentRole };
    }

    const domain = parts[1]; // e.g. "pitchblackcyber.com"
    const domainPrefix = domain.split('.')[0]; // e.g. "pitchblackcyber"
    const normalizedPrefix = normalizeOrgName(domainPrefix);

    // 1. In sandbox mode, check preset demo users
    if (isSandboxMode) {
      const preset = PRESET_USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (preset) {
        const tenantIds = Object.keys(preset.roles);
        const targetTenant = demoTenants.find(t => tenantIds.includes(t.id)) || demoTenants[0];
        const role = preset.roles[targetTenant.id] || 'TENANT_OWNER';
        return { tenant: targetTenant, role };
      }
    }

    // 2. LIVE MODE DEDUPLICATION: Match existing live tenants by domain or normalized name
    const matchedLive = liveTenants.find(t =>
      (t.domain && t.domain.toLowerCase() === domain) ||
      normalizeOrgName(t.name) === normalizedPrefix ||
      t.name.toLowerCase().includes(domainPrefix)
    );

    if (matchedLive) {
      const isAssessorDomain = domain.includes('audit') || domain.includes('c3pao') || domain.includes('assessor');
      const role: TenantRole = isAssessorDomain ? 'ASSESSOR' : 'TENANT_OWNER';
      setLiveActiveTenantId(matchedLive.id);
      return { tenant: matchedLive, role };
    }

    // 3. Initialize single blank tenant enclave for first-time defense contractor domain
    const formattedTitle = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1) + ' LLC';
    const newBlankTenant = initializeBlankTenant(email, domain, formattedTitle);

    return { tenant: newBlankTenant, role: 'TENANT_OWNER' };
  }, [isSandboxMode, demoTenants, liveTenants, currentTenant, currentRole, initializeBlankTenant]);

  /**
   * Synchronize authenticated user with Tenant state
   */
  const syncAuthUser = useCallback((user: User, preferredTenantId?: string) => {
    setCurrentUser(user);
    const targetList = isSandboxMode ? demoTenants : liveTenants;
    if (preferredTenantId && targetList.some(t => t.id === preferredTenantId)) {
      if (isSandboxMode) {
        setDemoActiveTenantId(preferredTenantId);
      } else {
        setLiveActiveTenantId(preferredTenantId);
      }
    } else {
      const userTenantIds = Object.keys(user.roles || {});
      const matched = userTenantIds.find(id => targetList.some(t => t.id === id));
      if (matched) {
        if (isSandboxMode) {
          setDemoActiveTenantId(matched);
        } else {
          setLiveActiveTenantId(matched);
        }
      }
    }

    // Automatically trigger live data sync upon authentication for real tenants
    if (!isSandboxMode && ApiClient.getToken()) {
      setTimeout(() => refreshLiveData(preferredTenantId), 50);
    }
  }, [isSandboxMode, demoTenants, liveTenants, refreshLiveData]);

  const submitLicenseRequest = useCallback(async (
    requestData: Omit<LicenseRequest, 'id' | 'createdAt' | 'status'>
  ): Promise<LicenseRequest> => {
    const newRequest: LicenseRequest = {
      id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      ...requestData,
      status: 'PENDING_CONTACT',
      createdAt: new Date().toISOString(),
    };

    setLicenseRequests(prev => [newRequest, ...prev]);
    return newRequest;
  }, []);

  /**
   * Provision a brand-new defense enclave with isolated database boundary and onboarding token
   */
  const provisionTenant = useCallback(async (data: {
    companyName: string;
    cageCode?: string;
    systemBoundaryName?: string;
    licenseTier: 'single-org' | 'msp-assessor';
    tenantOwnerEmail: string;
    primaryFramework?: ComplianceFramework;
    enabledFrameworks?: ComplianceFramework[];
  }): Promise<{ tenant: Tenant; invitation: TenantInvitation; inviteUrl: string }> => {
    const normName = normalizeOrgName(data.companyName);
    const slug = (normName || data.companyName.toLowerCase().replace(/[^a-z0-9]/g, '-')).slice(0, 15);
    const newTenantId = `tenant-${slug}-${Date.now().toString(36).substring(2, 6)}`;
    const emailDomain = data.tenantOwnerEmail.split('@')[1] || 'defense.us';
    const primFw = data.primaryFramework || 'CMMC_L1';
    const enFw = data.enabledFrameworks && data.enabledFrameworks.length > 0 ? data.enabledFrameworks : [primFw];

    const newTenant: Tenant = {
      id: newTenantId,
      name: data.companyName.trim(),
      cageCode: (data.cageCode || 'PENDING').trim().toUpperCase(),
      samStatus: 'ACTIVE',
      systemName: (data.systemBoundaryName || `${data.companyName.trim()} Operations Boundary`).trim(),
      systemOwner: data.tenantOwnerEmail.trim(),
      industry: 'Defense Industrial Base (DIB)',
      domain: emailDomain,
      isDemo: false,
      isConfigured: false,
      licenseTier: data.licenseTier,
      primaryFramework: primFw,
      enabledFrameworks: enFw,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Initialize 100% blank assessment state in storage
    const blankState = createInitialState(newTenant);
    StorageService.saveAssessment(newTenantId, blankState);

    // Cryptographic token & invitation
    const token = generateCryptoToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const invitation: TenantInvitation = {
      id: `inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      token,
      tenantId: newTenantId,
      tenantName: newTenant.name,
      email: data.tenantOwnerEmail.trim().toLowerCase(),
      role: 'TENANT_OWNER',
      invitedBy: currentUser.email || 'Pitch Black Cyber Super Admin',
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'PENDING',
      type: 'TENANT_ONBOARDING',
      systemName: newTenant.systemName,
      cageCode: newTenant.cageCode,
      licenseTier: data.licenseTier,
    };

    const ownerMember: TeamMember = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      tenantId: newTenantId,
      email: data.tenantOwnerEmail.trim().toLowerCase(),
      name: data.tenantOwnerEmail.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      role: 'TENANT_OWNER',
      status: 'PENDING_INVITE',
      invitedAt: new Date().toISOString(),
      invitationToken: token,
    };

    setLiveTenants(prev => deduplicateTenants([...prev, newTenant]));
    setInvitations(prev => [invitation, ...prev]);
    setTeamMembers(prev => ({
      ...prev,
      [newTenantId]: [ownerMember],
    }));

    const inviteUrl = buildInviteUrl(token);
    return { tenant: newTenant, invitation, inviteUrl };
  }, [currentUser.email]);


  /**
   * Claim and bind an invitation token to an authenticated or new user
   */
  const claimInviteToken = useCallback(async (
    token: string,
    userCredentials: { id?: string; name: string; email: string; authProvider: AuthProviderType }
  ): Promise<{ success: boolean; tenant?: Tenant; role?: TenantRole; error?: string }> => {
    const invite = invitations.find(inv => inv.token === token);
    if (!invite) {
      return { success: false, error: 'Invitation token was not found or is invalid.' };
    }

    if (invite.status === 'ACCEPTED') {
      return { success: false, error: 'This invitation has already been claimed.' };
    }

    if (invite.status === 'REVOKED') {
      return { success: false, error: 'This invitation has been revoked by the security administrator.' };
    }

    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      return { success: false, error: 'This invitation has expired. Please contact your administrator.' };
    }

    const now = new Date().toISOString();

    // 1. Mark invitation as ACCEPTED
    setInvitations(prev =>
      prev.map(inv =>
        inv.id === invite.id
          ? {
              ...inv,
              status: 'ACCEPTED' as const,
              acceptedAt: now,
              acceptedByUserId: userCredentials.id || userCredentials.email,
            }
          : inv
      )
    );

    // 2. Find target tenant
    const targetTenant =
      liveTenants.find(t => t.id === invite.tenantId) ||
      demoTenants.find(t => t.id === invite.tenantId) ||
      DEFAULT_BLANK_TENANT;

    // 3. If initial onboarding, update system owner
    if (!targetTenant.isConfigured && invite.type === 'TENANT_ONBOARDING') {
      setLiveTenants(prev =>
        prev.map(t =>
          t.id === targetTenant.id
            ? {
                ...t,
                systemOwner: userCredentials.name || userCredentials.email,
                updatedAt: now,
              }
            : t
        )
      );
    }

    // 4. Assign role to user profile
    const assignedRole = invite.role;
    setCurrentUser(prevUser => ({
      ...prevUser,
      id: userCredentials.id || prevUser.id,
      name: userCredentials.name || prevUser.name,
      email: userCredentials.email || prevUser.email,
      authProvider: userCredentials.authProvider || prevUser.authProvider,
      roles: {
        ...prevUser.roles,
        [invite.tenantId]: assignedRole,
      },
    }));

    // 5. Update team members list
    setTeamMembers(prev => {
      const currentList = prev[invite.tenantId] || [];
      const matchIdx = currentList.findIndex(
        m => m.email.toLowerCase() === userCredentials.email.toLowerCase() || m.invitationToken === token
      );

      let updatedList: TeamMember[];
      if (matchIdx >= 0) {
        updatedList = currentList.map((m, idx) =>
          idx === matchIdx
            ? {
                ...m,
                name: userCredentials.name || m.name,
                email: userCredentials.email || m.email,
                role: assignedRole,
                status: 'ACTIVE' as const,
                joinedAt: now,
              }
            : m
        );
      } else {
        const newMember: TeamMember = {
          id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          tenantId: invite.tenantId,
          email: userCredentials.email.toLowerCase(),
          name: userCredentials.name,
          role: assignedRole,
          status: 'ACTIVE',
          joinedAt: now,
        };
        updatedList = [...currentList, newMember];
      }

      return {
        ...prev,
        [invite.tenantId]: updatedList,
      };
    });

    // 6. Set active tenant
    if (isSandboxMode) {
      setDemoActiveTenantId(invite.tenantId);
    } else {
      setLiveActiveTenantId(invite.tenantId);
    }

    return { success: true, tenant: targetTenant, role: assignedRole };
  }, [invitations, liveTenants, demoTenants, isSandboxMode]);

  /**
   * Invite an assessor or viewer staff member to the specified tenant enclave
   */
  const inviteStaffMember = useCallback(async (
    tenantId: string,
    email: string,
    role: 'ASSESSOR' | 'VIEWER'
  ): Promise<{ invitation: TenantInvitation; inviteUrl: string }> => {
    const targetTenant =
      liveTenants.find(t => t.id === tenantId) ||
      demoTenants.find(t => t.id === tenantId) ||
      currentTenant;

    const token = generateCryptoToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const invitation: TenantInvitation = {
      id: `inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      token,
      tenantId,
      tenantName: targetTenant.name,
      email: email.trim().toLowerCase(),
      role,
      invitedBy: currentUser.name ? `${currentUser.name} (${currentUser.email})` : currentUser.email,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'PENDING',
      type: 'STAFF_INVITE',
      systemName: targetTenant.systemName,
      cageCode: targetTenant.cageCode,
      licenseTier: targetTenant.licenseTier,
    };

    const newMember: TeamMember = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      tenantId,
      email: email.trim().toLowerCase(),
      name: email.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase()),
      role,
      status: 'PENDING_INVITE',
      invitedAt: new Date().toISOString(),
      invitationToken: token,
    };

    setInvitations(prev => [invitation, ...prev]);
    setTeamMembers(prev => {
      const currentList = prev[tenantId] || [];
      const filtered = currentList.filter(m => m.email.toLowerCase() !== email.trim().toLowerCase());
      return {
        ...prev,
        [tenantId]: [...filtered, newMember],
      };
    });

    const inviteUrl = buildInviteUrl(token);
    return { invitation, inviteUrl };
  }, [liveTenants, demoTenants, currentTenant, currentUser]);

  /**
   * Revoke an active or pending invitation
   */
  const revokeInvitation = useCallback((invitationId: string) => {
    setInvitations(prev =>
      prev.map(inv =>
        inv.id === invitationId
          ? { ...inv, status: 'REVOKED' as const }
          : inv
      )
    );

    const targetInvite = invitations.find(i => i.id === invitationId);
    if (targetInvite) {
      setTeamMembers(prev => {
        const list = prev[targetInvite.tenantId] || [];
        return {
          ...prev,
          [targetInvite.tenantId]: list.filter(m => m.invitationToken !== targetInvite.token),
        };
      });
    }
  }, [invitations]);

  /**
   * Resend / refresh invitation with extended expiration
   */
  const resendInvitation = useCallback(async (invitationId: string): Promise<{ inviteUrl: string }> => {
    let token = '';
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    setInvitations(prev =>
      prev.map(inv => {
        if (inv.id === invitationId) {
          token = inv.token;
          return {
            ...inv,
            status: 'PENDING' as const,
            expiresAt: newExpiresAt,
          };
        }
        return inv;
      })
    );

    return { inviteUrl: buildInviteUrl(token) };
  }, []);

  /**
   * Update role for an active team member
   */
  const updateMemberRole = useCallback((tenantId: string, memberId: string, newRole: TenantRole) => {
    setTeamMembers(prev => {
      const list = prev[tenantId] || [];
      return {
        ...prev,
        [tenantId]: list.map(m => (m.id === memberId ? { ...m, role: newRole } : m)),
      };
    });

    // If updating current user's role
    const member = teamMembers[tenantId]?.find(m => m.id === memberId);
    if (member && member.email.toLowerCase() === currentUser.email.toLowerCase()) {
      setCurrentUser(prev => ({
        ...prev,
        roles: {
          ...prev.roles,
          [tenantId]: newRole,
        },
      }));
    }
  }, [teamMembers, currentUser.email]);

  /**
   * Remove a member from the organization
   */
  const removeMember = useCallback((tenantId: string, memberId: string) => {
    setTeamMembers(prev => {
      const list = prev[tenantId] || [];
      return {
        ...prev,
        [tenantId]: list.filter(m => m.id !== memberId),
      };
    });
  }, []);

  /**
   * Query team members for active or specified tenant
   */
  const getTenantMembers = useCallback((tenantId: string): TeamMember[] => {
    const list = teamMembers[tenantId];
    if (list && list.length > 0) {
      return list;
    }

    const targetTenant = tenants.find(t => t.id === tenantId) || currentTenant;
    const synthesized: TeamMember[] = [];

    const myRole = currentUser.roles?.[tenantId] || (tenantId === currentTenant.id ? currentRole : undefined);
    if (myRole) {
      synthesized.push({
        id: `mem-${currentUser.id}`,
        tenantId,
        email: currentUser.email,
        name: currentUser.name || 'Enclave Operator',
        role: myRole,
        status: 'ACTIVE',
        joinedAt: targetTenant.createdAt,
      });
    }

    return synthesized;
  }, [teamMembers, tenants, currentTenant, currentUser, currentRole]);

  /**
   * Lookup invitation by token string
   */
  const getInvitationByToken = useCallback((token: string): TenantInvitation | undefined => {
    return invitations.find(inv => inv.token === token);
  }, [invitations]);

  const value = useMemo(() => ({
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isSandboxMode,
    isMspUser,
    isSuperAdmin,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
    licenseRequests,
    invitations,
    teamMembers,
    switchTenant,
    createTenant,
    provisionTenant,
    claimInviteToken,
    inviteStaffMember,
    revokeInvitation,
    resendInvitation,
    updateMemberRole,
    removeMember,
    getTenantMembers,
    getInvitationByToken,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    updateTenantFrameworkScope,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resolveTenantForEmail,
    submitLicenseRequest,
    liveControls,
    liveEvidence,
    isSyncing,
    syncError,
    refreshLiveData,
    updateLiveControl,
    createLiveEvidenceUploadUrl,
    activeFramework,
    setActiveFramework,
    activeBaselineTier,
    setActiveBaselineTier,
    activeOverlayFilters,
    setActiveOverlayFilters,
    toggleNonNetworkedOverlay,
  }), [
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isSandboxMode,
    isMspUser,
    isSuperAdmin,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
    licenseRequests,
    invitations,
    teamMembers,
    switchTenant,
    createTenant,
    provisionTenant,
    claimInviteToken,
    inviteStaffMember,
    revokeInvitation,
    resendInvitation,
    updateMemberRole,
    removeMember,
    getTenantMembers,
    getInvitationByToken,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    updateTenantFrameworkScope,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resolveTenantForEmail,
    submitLicenseRequest,
    liveControls,
    liveEvidence,
    isSyncing,
    syncError,
    refreshLiveData,
    updateLiveControl,
    createLiveEvidenceUploadUrl,
    activeFramework,
    setActiveFramework,
    activeBaselineTier,
    setActiveBaselineTier,
    activeOverlayFilters,
    setActiveOverlayFilters,
    toggleNonNetworkedOverlay,
  ]);


  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = (): TenantContextType => {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
};
