import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { Tenant, TenantRole, User, SamStatus, LicenseRequest } from '../types/tenant';
import { StorageService, createInitialState } from '../services/storageService';

// Storage Version 4 Keys (Strict separation of Live vs Sandbox)
const LIVE_TENANTS_STORAGE_KEY = 'pbc_live_tenants_v4';
const LIVE_ACTIVE_TENANT_ID_KEY = 'pbc_live_active_tenant_v4';
const DEMO_TENANTS_STORAGE_KEY = 'pbc_demo_tenants_v4';
const DEMO_ACTIVE_TENANT_ID_KEY = 'pbc_demo_active_tenant_v4';
const CURRENT_USER_KEY = 'pbc_active_user_v4';
const LICENSE_REQUESTS_STORAGE_KEY = 'pbc_license_requests_v4';

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
];

const DEFAULT_BLANK_TENANT: Tenant = {
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
  needsOnboarding: boolean;
  isOnboardingModalOpen: boolean;
  setIsOnboardingModalOpen: (open: boolean) => void;
  licenseRequests: LicenseRequest[];
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
  }) => Tenant;
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
  isGcpArchitectureModalOpen: boolean;
  setIsGcpArchitectureModalOpen: (open: boolean) => void;
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
          // Filter out any mock demo tenants that may have been saved
          const clean = parsed.filter(t => !t.isDemo && !SEED_TENANTS.some(st => st.id === t.id));
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
          const nonDemo = parsed.filter(t => !t.isDemo && !SEED_TENANTS.some(st => st.id === t.id));
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
          return deduplicateTenants(parsed);
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

  const [isGcpArchitectureModalOpen, setIsGcpArchitectureModalOpen] = useState<boolean>(false);
  const [isOnboardingModalOpen, setIsOnboardingModalOpen] = useState<boolean>(false);

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
  }): Tenant => {
    const normName = normalizeOrgName(data.name);

    if (isSandboxMode) {
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
      const newTenantId = `tenant-demo-${slug}-${Date.now().toString(36).substring(2, 6)}`;
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setDemoTenants(prev => deduplicateTenants([...prev, newDemoTenant]));
      setDemoActiveTenantId(newTenantId);
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
        updatedAt: new Date().toISOString(),
      } : t)));
      setLiveActiveTenantId(existing.id);
      return existing;
    }

    const slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
    const newTenantId = `tenant-${slug}-${Date.now().toString(36).substring(2, 6)}`;
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
  }, [isSandboxMode, demoTenants, liveTenants]);

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

  const value = useMemo(() => ({
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isSandboxMode,
    isMspUser,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    licenseRequests,
    switchTenant,
    createTenant,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resolveTenantForEmail,
    submitLicenseRequest,
    isGcpArchitectureModalOpen,
    setIsGcpArchitectureModalOpen,
  }), [
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isSandboxMode,
    isMspUser,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    licenseRequests,
    switchTenant,
    createTenant,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resolveTenantForEmail,
    submitLicenseRequest,
    isGcpArchitectureModalOpen,
    setIsGcpArchitectureModalOpen,
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
