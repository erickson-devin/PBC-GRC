import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { Tenant, TenantRole, User, SamStatus } from '../types/tenant';

const TENANTS_STORAGE_KEY = 'pbc_tenants_registry_v2';
const CURRENT_TENANT_ID_KEY = 'pbc_active_tenant_id_v2';
const CURRENT_USER_KEY = 'pbc_active_user_v2';

export const SEED_TENANTS: Tenant[] = [
  {
    id: 'tenant-apex-01',
    name: 'Apex Defense Solutions, LLC',
    cageCode: '9X7B4',
    samStatus: 'ACTIVE',
    systemName: 'Corporate Operations Enclave (COE)',
    systemOwner: 'Devin Erickson, Chief Information Security Officer',
    industry: 'Aerospace & Defense Hardware',
    createdAt: '2026-01-15T08:00:00.000Z',
    updatedAt: new Date().toISOString(),
    isDemo: true,
  },
  {
    id: 'tenant-vanguard-02',
    name: 'Cyber Vanguard Technologies, Inc.',
    cageCode: '8K3R1',
    samStatus: 'ACTIVE',
    systemName: 'Defense Contracting Information Network (DCIN)',
    systemOwner: 'Marcus Vance, VP of Security & Infrastructure',
    industry: 'Defense IT & Systems Integration',
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
    createdAt: '2026-02-20T14:15:00.000Z',
    updatedAt: new Date().toISOString(),
    isDemo: true,
  },
];

export const PRESET_USERS: User[] = [
  {
    id: 'user-devin-msp',
    name: 'Devin Erickson',
    email: 'devin@apexdefense.us',
    organization: 'Apex Defense / Lead Assessor',
    googleWorkspaceEmail: 'devin@apexdefense.us',
    roles: {
      'tenant-apex-01': 'TENANT_OWNER',
      'tenant-vanguard-02': 'ASSESSOR',
      'tenant-orbital-03': 'TENANT_OWNER',
    },
  },
  {
    id: 'user-sarah-auditor',
    name: 'Sarah Jenkins (C3PAO Assessor)',
    email: 's.jenkins@defense-audit.org',
    organization: 'Third-Party Assessment Org (C3PAO)',
    googleWorkspaceEmail: 's.jenkins@defense-audit.org',
    roles: {
      'tenant-apex-01': 'ASSESSOR',
      'tenant-vanguard-02': 'ASSESSOR',
      'tenant-orbital-03': 'ASSESSOR',
    },
  },
  {
    id: 'user-alex-viewer',
    name: 'Alex Chen (Auditor Observer)',
    email: 'alex.chen@clientcorp.io',
    organization: 'Stakeholder Executive',
    googleWorkspaceEmail: 'alex.chen@clientcorp.io',
    roles: {
      'tenant-apex-01': 'VIEWER',
      'tenant-vanguard-02': 'VIEWER',
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
  switchTenant: (tenantId: string) => void;
  createTenant: (tenantData: {
    name: string;
    cageCode: string;
    samStatus: SamStatus;
    systemName: string;
    systemOwner: string;
    industry: string;
  }) => Tenant;
  updateTenant: (tenantId: string, updates: Partial<Tenant>) => void;
  deleteTenant: (tenantId: string) => void;
  switchUserRole: (role: TenantRole) => void;
  switchUser: (user: User) => void;
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
  }): Tenant => {
    const newTenantId = `tenant-${data.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15)}-${Math.random().toString(36).substring(2, 6)}`;
    const newTenant: Tenant = {
      id: newTenantId,
      name: data.name.trim(),
      cageCode: data.cageCode.trim().toUpperCase(),
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName.trim() || `${data.name} Operations Boundary`,
      systemOwner: data.systemOwner.trim(),
      industry: data.industry || 'Defense Industrial Base',
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
  }, []);

  const value = useMemo(() => ({
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    switchTenant,
    createTenant,
    updateTenant,
    deleteTenant,
    switchUserRole,
    switchUser,
    isGcpArchitectureModalOpen,
    setIsGcpArchitectureModalOpen,
  }), [
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    switchTenant,
    createTenant,
    updateTenant,
    deleteTenant,
    switchUserRole,
    switchUser,
    isGcpArchitectureModalOpen,
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
