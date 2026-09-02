import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { Tenant, TenantRole, User, SamStatus, LicenseRequest } from '../types/tenant';

const TENANTS_STORAGE_KEY = 'pbc_tenants_registry_v3';
const CURRENT_TENANT_ID_KEY = 'pbc_active_tenant_id_v3';
const CURRENT_USER_KEY = 'pbc_active_user_v3';
const LICENSE_REQUESTS_STORAGE_KEY = 'pbc_license_requests_v1';

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
    updatedAt: new Date().toISOString(),
    isDemo: true,
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
    updatedAt: new Date().toISOString(),
    isDemo: true,
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
    updatedAt: new Date().toISOString(),
    isDemo: true,
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

interface TenantContextType {
  tenants: Tenant[];
  currentTenant: Tenant;
  currentUser: User;
  currentRole: TenantRole;
  canEdit: boolean;
  canManageTenant: boolean;
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
  }) => Tenant;
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
  // Load or seed Tenants
  const [tenants, setTenants] = useState<Tenant[]>(() => {
    try {
      const saved = localStorage.getItem(TENANTS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Tenant[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.error('Error loading tenants from storage:', err);
    }
    return SEED_TENANTS;
  });

  // Active Tenant ID
  const [currentTenantId, setCurrentTenantId] = useState<string>(() => {
    const saved = localStorage.getItem(CURRENT_TENANT_ID_KEY);
    if (saved && tenants.some(t => t.id === saved)) {
      return saved;
    }
    return tenants[0]?.id || SEED_TENANTS[0].id;
  });

  // Active User
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

  // Inbound License Requests (Sales onboarding pipeline)
  const [licenseRequests, setLicenseRequests] = useState<LicenseRequest[]>(() => {
    try {
      const saved = localStorage.getItem(LICENSE_REQUESTS_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved) as LicenseRequest[];
      }
    } catch (e) {
      console.error('Error loading license requests:', e);
    }
    return [];
  });

  const [isGcpArchitectureModalOpen, setIsGcpArchitectureModalOpen] = useState<boolean>(false);

  // Sync tenants to localStorage
  useEffect(() => {
    localStorage.setItem(TENANTS_STORAGE_KEY, JSON.stringify(tenants));
  }, [tenants]);

  // Sync active tenant id to localStorage
  useEffect(() => {
    localStorage.setItem(CURRENT_TENANT_ID_KEY, currentTenantId);
  }, [currentTenantId]);

  // Sync current user to localStorage
  useEffect(() => {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
  }, [currentUser]);

  // Sync license requests to localStorage
  useEffect(() => {
    localStorage.setItem(LICENSE_REQUESTS_STORAGE_KEY, JSON.stringify(licenseRequests));
  }, [licenseRequests]);

  const currentTenant = useMemo(() => {
    return tenants.find(t => t.id === currentTenantId) || tenants[0] || SEED_TENANTS[0];
  }, [tenants, currentTenantId]);

  const currentRole: TenantRole = useMemo(() => {
    return currentUser.roles[currentTenant.id] || 'TENANT_OWNER';
  }, [currentUser, currentTenant.id]);

  const canEdit = currentRole === 'TENANT_OWNER' || currentRole === 'ASSESSOR';
  const canManageTenant = currentRole === 'TENANT_OWNER';

  const switchTenant = useCallback((tenantId: string) => {
    if (tenants.some(t => t.id === tenantId)) {
      setCurrentTenantId(tenantId);
    }
  }, [tenants]);

  const createTenant = useCallback((data: {
    name: string;
    cageCode: string;
    samStatus: SamStatus;
    systemName: string;
    systemOwner: string;
    industry: string;
    domain?: string;
  }): Tenant => {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15);
    const newTenantId = `tenant-${slug}-${Math.random().toString(36).substring(2, 6)}`;
    const newTenant: Tenant = {
      id: newTenantId,
      name: data.name.trim(),
      cageCode: data.cageCode.trim().toUpperCase() || 'PENDING',
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName.trim() || `${data.name} Operations Boundary`,
      systemOwner: data.systemOwner.trim(),
      industry: data.industry || 'Defense Industrial Base (DIB)',
      domain: data.domain,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setTenants(prev => [...prev, newTenant]);
    
    // Assign creator as TENANT_OWNER
    setCurrentUser(prevUser => ({
      ...prevUser,
      roles: {
        ...prevUser.roles,
        [newTenantId]: 'TENANT_OWNER',
      },
    }));

    setCurrentTenantId(newTenantId);
    return newTenant;
  }, []);

  const updateTenant = useCallback((tenantId: string, updates: Partial<Tenant>) => {
    setTenants(prev => prev.map(t => {
      if (t.id === tenantId) {
        return {
          ...t,
          ...updates,
          updatedAt: new Date().toISOString(),
        };
      }
      return t;
    }));
  }, []);

  const deleteTenant = useCallback((tenantId: string) => {
    setTenants(prev => {
      if (prev.length <= 1) {
        alert('Cannot delete the only remaining tenant organization.');
        return prev;
      }
      const filtered = prev.filter(t => t.id !== tenantId);
      if (currentTenantId === tenantId) {
        setCurrentTenantId(filtered[0].id);
      }
      return filtered;
    });
  }, [currentTenantId]);

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
    // If the selected user has roles, set active tenant to one they have access to
    const accessibleTenants = Object.keys(user.roles);
    if (accessibleTenants.length > 0 && !accessibleTenants.includes(currentTenantId)) {
      setCurrentTenantId(accessibleTenants[0]);
    }
  }, [currentTenantId]);

  /**
   * Domain-based auto-tenant matching
   * Analyzes the email domain against existing tenants or auto-provisions a company enclave
   */
  const resolveTenantForEmail = useCallback((email: string): { tenant: Tenant; role: TenantRole } => {
    const parts = email.toLowerCase().trim().split('@');
    if (parts.length < 2) {
      return { tenant: currentTenant, role: currentRole };
    }

    const domain = parts[1]; // e.g. "apexdefense.us"
    const domainPrefix = domain.split('.')[0]; // e.g. "apexdefense"

    // 1. Check if email matches preset user
    const preset = PRESET_USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (preset) {
      const tenantIds = Object.keys(preset.roles);
      const targetTenant = tenants.find(t => tenantIds.includes(t.id)) || tenants[0];
      const role = preset.roles[targetTenant.id] || 'TENANT_OWNER';
      return { tenant: targetTenant, role };
    }

    // 2. Direct domain match against existing tenants
    const matchedByDomain = tenants.find(t => 
      t.domain?.toLowerCase() === domain ||
      t.name.toLowerCase().includes(domainPrefix) ||
      domain.includes(t.name.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );

    if (matchedByDomain) {
      // Determine role based on assessor email indicators
      const isAssessorDomain = domain.includes('audit') || domain.includes('c3pao') || domain.includes('assessor');
      const role: TenantRole = isAssessorDomain ? 'ASSESSOR' : 'TENANT_OWNER';
      return { tenant: matchedByDomain, role };
    }

    // 3. Auto-provision a new isolated company enclave for new defense contractor domain
    const formattedTitle = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1);
    const newTenant = createTenant({
      name: `${formattedTitle} Defense Systems, Inc.`,
      cageCode: Math.random().toString(36).substring(2, 7).toUpperCase(),
      samStatus: 'ACTIVE',
      systemName: `${formattedTitle} Defense Operations Enclave (DOE)`,
      systemOwner: email,
      industry: 'Defense Industrial Base (DIB)',
      domain: domain,
    });

    return { tenant: newTenant, role: 'TENANT_OWNER' };
  }, [tenants, currentTenant, currentRole, createTenant]);

  /**
   * Synchronize authenticated Firebase / Entra ID user with Tenant state
   */
  const syncAuthUser = useCallback((user: User, preferredTenantId?: string) => {
    setCurrentUser(user);
    if (preferredTenantId && tenants.some(t => t.id === preferredTenantId)) {
      setCurrentTenantId(preferredTenantId);
    } else {
      const userTenantIds = Object.keys(user.roles || {});
      if (userTenantIds.length > 0 && !userTenantIds.includes(currentTenantId)) {
        setCurrentTenantId(userTenantIds[0]);
      }
    }
  }, [tenants, currentTenantId]);

  /**
   * Submit new License Request & Sales Call scheduling
   */
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
    licenseRequests,
    switchTenant,
    createTenant,
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
    licenseRequests,
    switchTenant,
    createTenant,
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
