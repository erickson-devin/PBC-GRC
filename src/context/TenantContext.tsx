import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Tenant,
  TenantRole,
  User,
  SamStatus,
  TenantInvitation,
  TeamMember,
  AuthProviderType,
  EnclaveStackProfile,
} from '../types/tenant';
import { errorMessage } from '../utils/errors';
import { canRoleWrite, isTenantRole } from '../utils/roles';
import {
  applyRoleSync,
  isValidCageCode,
  mergeServerTenants,
  parseServerTenants,
  pickActiveTenantId,
  provisionalRoleForTenant,
  serverTenantToTenant,
  toServerPatch,
  ServerTenantPatch,
} from '../data/tenantSync';
import { EvidenceVault } from '../services/evidenceVault';
import { StorageService, createInitialState } from '../services/storageService';
import { stripTenantRegistryForCache } from '../services/browserStorageScrub';
import { ControlState, EvidenceItem } from '../types/cmmc';
import { clearLocalEnclaveAssets, getEnclaveAssets, isDemoSeedAsset } from '../data/telemetry/assetRegistry';
import type { AssetInput } from '../data/telemetry/assetScope';
import { notifyAssetsChanged } from '../services/assetService';
import type { EnclaveAsset } from '../types/telemetry';
import { ApiClient, ApiError, InvitePreview, UploadUrlResponse } from '../services/apiClient';
import type { Program, ProgramBaseline, ProgramInput, ProgramUpdate } from '../types/program';
import {
  activeProgramStorageKey,
  isCurrentResponse,
  pickActiveProgramId,
  programScopeKey,
} from '../data/programSync';
import { programBaselineToCia } from '../data/programScope';
import {
  ServerInvitation,
  buildTeam,
  mergeServerInvitations,
  toTenantInvitation,
} from '../data/teamSync';
import { findControlDefinition, getFrameworkControls } from '../data/frameworks';
import { MAX_OBJECTIVE_BULK, MAX_OBJECTIVE_IMPORT, type ObjectiveImportResult, type ObjectiveInput, type ObjectiveRecord } from '../types/controlObjectives';
import { OBJECTIVE_CASCADE_EVENT, applyImportResult, chunkItems, objectivesToUpload, stackCascadeFill } from '../data/objectiveSync';
import {
  ComplianceFramework,
  BaselineTier,
  OverlayFilters,
  OverlayParameter,
  CiaTriadSelection,
  ImpactLevel,
} from '../types/framework';

// Storage Version 4 Keys
const LIVE_TENANTS_STORAGE_KEY = 'pbc_live_tenants_v4';
const LIVE_ACTIVE_TENANT_ID_KEY = 'pbc_live_active_tenant_v4';
const CURRENT_USER_KEY = 'pbc_active_user_v4';
const TEAM_MEMBERS_STORAGE_KEY = 'pbc_tenant_team_members_v4';
// Overlays stay per browser (a program setting later); the framework, baseline tier and CIA triad now come from the active program
const ACTIVE_OVERLAY_FILTERS_KEY = 'pbc_active_overlay_filters_v1';

// Legacy keys to purge on initialization
const LEGACY_STORAGE_KEYS = [
  'pbc_active_framework_v1', // per-browser framework / baseline / CIA choices: derived from the active program now
  'pbc_active_baseline_tier_v1',
  'pbc_active_cia_triad',
  'pbc_license_requests_v4', // lead capture of the removed public site
  'pbc_demo_tenants_v4', // the removed demo sandbox
  'pbc_demo_active_tenant_v4',
  'pbc_tenant_invitations_v4', // invitations are issued and held by the server
  'pbc_tenants',
  'pbc_active_tenant',
  'pbc_tenants_registry_v1',
  'pbc_tenants_registry_v2',
  'pbc_tenants_registry_v3',
  'pbc_active_tenant_id_v3',
  'pbc_active_user_v3',
];

/**
 * Right after a sign-in the session token is saved to localStorage by an effect, a moment after the sign-in promise
 * resolves. Wait briefly for it instead of failing a claim that is made straight away.
 */
async function waitForSessionToken(timeoutMs = 3000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = ApiClient.getToken();
    if (token) return token;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Constructs the canonical invitation acceptance URL
 */
export function buildInviteUrl(token: string): string {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    return `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
  }
  return `/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Platform administrator (the super-admin console). In a live installation this flag comes from the SERVER (GET /api/v1/me,
 * the PLATFORM_ADMIN_EMAILS list) after every sign-in, so the console is only shown to people the server will let use it.
 */
export function isSuperAdminUser(user?: User | null): boolean {
  return user?.isSuperAdmin === true;
}

/**
 * Normalized string helper for deduplication
 * Removes legal entity suffixes (LLC, Inc, Corp, Co) and symbols to compare true entity identity
 */
function normalizeOrgName(name: string): string {
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
function deduplicateTenants(tenantList: Tenant[]): Tenant[] {
  const seenIds = new Set<string>();
  const seenEntities = new Map<string, Tenant>();
  const result: Tenant[] = [];

  for (const t of tenantList) {
    if (!t || !t.id) continue;
    if (seenIds.has(t.id)) continue;

    // Use normalized domain or normalized company name as entity identity
    const domainKey = t.domain && t.domain.trim() ? t.domain.toLowerCase().trim() : '';
    const nameKey = normalizeOrgName(t.name);
    // Tenants confirmed by the server are distinct by id: two real organisations can normalise to the same name.
    const entityKey = t.serverBacked ? `id:${t.id}` : domainKey ? `dom:${domainKey}` : `name:${nameKey}`;

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

/** The user before anyone has signed in: no identity and no access to any tenant. */
export const ANONYMOUS_USER: User = {
  id: 'anonymous',
  name: '',
  email: '',
  organization: '',
  authProvider: 'password',
  roles: {},
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
  isConfigured: false,
  primaryFramework: 'CMMC_L1',
  enabledFrameworks: ['CMMC_L1'],
};

export interface TenantSyncState {
  status: 'idle' | 'syncing' | 'synced' | 'error';
  lastSyncedAt: string | null;
  error: string | null;
}

/** 'unsupported': a browser-only tenant has no server, so no programs (one implicit default boundary). */
export type ProgramsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

interface ProgramsState {
  tenantId: string;
  programs: Program[];
  status: ProgramsStatus;
  activeId: string | null;
}

const NO_PROGRAMS: Program[] = [];

/** The tier a program's baseline stands for (the tier the live controls request and the matrix label use). */
function baselineToTier(baseline: ProgramBaseline | null | undefined): BaselineTier {
  if (baseline === 'MODERATE') return 'MOD_MOD_MOD';
  if (baseline === 'HIGH') return 'HIGH_HIGH_HIGH';
  return 'LOW_LOW_LOW';
}

interface TenantContextType {
  tenants: Tenant[];
  currentTenant: Tenant;
  currentUser: User;
  currentRole: TenantRole;
  canEdit: boolean;
  canManageTenant: boolean;
  isMspUser: boolean;
  isSuperAdmin: boolean;
  needsOnboarding: boolean;
  isOnboardingModalOpen: boolean;
  setIsOnboardingModalOpen: (open: boolean) => void;
  isTeamModalOpen: boolean;
  setIsTeamModalOpen: (open: boolean) => void;
  isStigModalOpen: boolean;
  setIsStigModalOpen: (open: boolean) => void;
  isStackSurveyModalOpen: boolean;
  setIsStackSurveyModalOpen: (open: boolean) => void;
  updateStackProfile: (profile: EnclaveStackProfile) => void;
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
    isConfigured?: boolean;
    enabledFrameworks?: ComplianceFramework[];
    primaryFramework?: ComplianceFramework;
  }) => Promise<Tenant>;
  provisionTenant: (data: {
    companyName: string;
    cageCode?: string;
    systemBoundaryName?: string;
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
    userCredentials: { id?: string; name: string; email: string; authProvider: AuthProviderType; idToken?: string }
  ) => Promise<{ success: boolean; tenant?: Tenant; role?: TenantRole; error?: string }>;
  inviteStaffMember: (
    tenantId: string,
    email: string,
    role: 'ASSESSOR' | 'VIEWER'
  ) => Promise<{ invitation: TenantInvitation; inviteUrl: string }>;
  revokeInvitation: (invitationId: string) => Promise<void>;
  resendInvitation: (invitationId: string) => Promise<{ inviteUrl: string }>;
  updateInvitation: (invitationId: string, updates: Partial<TenantInvitation>) => Promise<void>;
  updateMemberRole: (tenantId: string, memberId: string, newRole: TenantRole) => Promise<void>;
  removeMember: (tenantId: string, memberId: string) => Promise<void>;
  getTenantMembers: (tenantId: string) => TeamMember[];
  /** Re-fetches the members and invitations of a server-backed tenant (default: the active one). */
  refreshTeam: (tenantId?: string) => Promise<void>;
  /** Same for every server-backed tenant the user administers (used by the super-admin console). */
  refreshAllTeams: () => Promise<void>;
  /** The last team / invitation loading error, or null. */
  teamError: string | null;
  /** What the accept-invite page shows before sign-in; resolves null for an unknown token. */
  previewInvitation: (token: string) => Promise<InvitePreview | null>;
  /**
   * Moves a tenant that only exists in this browser to the server: creates it there, then ports its assessment and
   * evidence files to the new server-generated id. Browser-only team members and invitations are not carried over.
   */
  migrateLocalTenantToServer: (tenantId: string) => Promise<{ tenantId: string; evidenceFilesMoved: number; controlsFailed: number; objectivesFailed: number; assetsMoved: number; assetsFailed: number }>;

  initializeBlankTenant: (email: string, domain?: string, orgName?: string) => Tenant;
  completeTenantOnboarding: (tenantId: string, data: {
    organizationName: string;
    cageCode?: string;
    samStatus?: SamStatus;
    systemName: string;
    systemOwner: string;
    systemBoundaryScope?: string;
    cloudServiceProviders?: string;
  }) => Promise<string>; // resolves the final tenant id (a browser-only tenant gets a NEW, server-assigned id)
  updateTenant: (tenantId: string, updates: Partial<Tenant>) => void;
  suspendTenant: (tenantId: string, suspend?: boolean) => void;
  updateTenantOwner: (tenantId: string, newOwnerEmail: string, newOwnerName?: string) => void;
  extendInvitationExpiration: (invitationId: string, days?: number) => Promise<{ expiresAt: string }>;
  deleteTenant: (tenantId: string) => void;
  switchUserRole: (role: TenantRole) => void;
  switchUser: (user: User) => void;
  /** `skipServerSync`: only adopt the profile (the forced password change is pending; the change re-syncs). */
  syncAuthUser: (user: User, preferredTenantId?: string, options?: { skipServerSync?: boolean }) => void;
  /** Sign-out: forgets the cached tenants, roles, team and programs so the next sign-in starts empty. */
  resetForSignOut: () => void;
  resolveTenantForEmail: (email: string) => { tenant: Tenant; role: TenantRole };
  // Live Sync Engine (PostgreSQL)
  liveControls: Record<string, ControlState> | null;
  /**
   * What the live controls were last loaded for: the tenant id, or `tenant::program` while a program is active (compare it with
   * programScopeKey). Null before the first successful load, on a failure, and from the moment a program switch starts.
   */
  liveScopeKey: string | null;
  liveEvidence: EvidenceItem[] | null;
  /** The program's objective records from the server (by objective id), loaded with the controls for the same `liveScopeKey`. */
  liveObjectives: Record<string, ObjectiveRecord> | null;
  // Programs (authorization boundaries) of the active tenant
  /** The tenant's programs, archived ones included (empty for a browser-only tenant). */
  programs: Program[];
  /** The program being shown; null for a browser-only tenant, before the list loads, or when it cannot be loaded (the server then serves the default program). */
  activeProgram: Program | null;
  programsStatus: ProgramsStatus;
  /** Switches the active program (refused: unknown, archived, or a browser-only tenant). Clears the live data at once and reloads it for the new program. */
  switchProgram: (programId: string) => boolean;
  /** Re-fetches the program list of the active tenant (or `tenantId`). */
  refreshPrograms: (tenantId?: string) => Promise<void>;
  createProgram: (input: ProgramInput) => Promise<Program>;
  updateProgram: (programId: string, updates: ProgramUpdate) => Promise<Program>;
  archiveProgram: (programId: string) => Promise<void>;
  unarchiveProgram: (programId: string) => Promise<void>;
  deleteProgram: (programId: string) => Promise<void>;
  /** Who may create, edit, archive and delete programs (TENANT_OWNER and MSP_ADMIN). */
  canManagePrograms: boolean;
  isSyncing: boolean;
  syncError: string | null;
  /** State of the last sync of the tenant list (and the user's roles in it) with GET /api/v1/tenants. */
  tenantSync: TenantSyncState;
  /**
   * Re-fetches the tenants this user belongs to, and their roles, from the server. Resolves the new tenant list,
   * or null if there is nothing to sync (not signed in, or the session was rejected). `force` waits for a
   * sync already in flight and then runs a fresh one.
   */
  syncTenantsFromServer: (token?: string, options?: { force?: boolean }) => Promise<Tenant[] | null>;
  refreshLiveData: (
    tenantToFetch?: string,
    frameworkToFetch?: ComplianceFramework,
    baselineToFetch?: BaselineTier,
    overlayToFetch?: OverlayParameter,
    /** The program to load (default: the active one; null: the tenant's default program). */
    programToFetch?: string | null
  ) => Promise<void>;
  updateLiveControl: (controlId: string, updates: Partial<ControlState>) => Promise<ControlState>;
  /** Saves one objective (status, narrative, evidence links) to the program that is on screen when the call starts. Rejects when the server refuses or is unreachable. */
  updateLiveObjective: (objectiveId: string, controlId: string, patch: Omit<ObjectiveInput, 'objectiveId' | 'controlId'>) => Promise<ObjectiveRecord>;
  /** Saves many objectives (500 per request, each request all-or-nothing). Rejects when a request fails. */
  updateLiveObjectivesBulk: (items: ObjectiveInput[]) => Promise<void>;
  /** Moves browser-cached objectives to the server (5000 per request, insert-only); resolves with every id's result, rejects when a request fails. */
  importLiveObjectives: (items: ObjectiveInput[]) => Promise<{ results: { objectiveId: string; result: ObjectiveImportResult }[]; records: Record<string, ObjectiveRecord> }>;
  createLiveEvidenceUploadUrl: (payload: {
    controlId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileHash: string;
    description?: string;
  }, programId?: string | null) => Promise<UploadUrlResponse | null>;
  /** Deletes an evidence record (and its cross-framework copies) on the server and drops them from the list. Rejects on failure. */
  deleteLiveEvidence: (evidenceId: string, programId?: string | null) => Promise<{ removedIds: string[]; fileRemoved: boolean }>;
  // Multi-Framework & Baseline Architecture (framework, baseline and CIA triad are derived from the active program)
  /** The active program's framework, else the tenant's primary framework. */
  activeFramework: ComplianceFramework;
  /** Switches to a program that has this framework (the default one first); a no-op when there is none. */
  setActiveFramework: (framework: ComplianceFramework) => void;
  /** The active program's baseline as a tier (LOW / MODERATE / HIGH; LOW_LOW_LOW without one). */
  activeBaselineTier: BaselineTier;
  activeOverlayFilters: OverlayFilters;
  setActiveOverlayFilters: React.Dispatch<React.SetStateAction<OverlayFilters>>;
  toggleNonNetworkedOverlay: () => void;
  toggleOverlayFilter: (key: keyof OverlayFilters) => void;
  /** The active program's baseline as a triad (all controls without a baseline). Read-only: the baseline is fixed when the program is created. */
  ciaTriad: CiaTriadSelection;
  /** @deprecated No effect: the CIA triad follows the program's baseline. Removed with the CIA editor of the old framework menu. */
  setCiaImpact: (dimension: 'confidentiality' | 'integrity' | 'availability', level: ImpactLevel) => void;
  /** @deprecated No effect (see setCiaImpact). */
  toggleAllControlsApplied: () => void;
}

const TenantContext = createContext<TenantContextType | undefined>(undefined);

export const TenantProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Tenants known to this browser: the cache of what the server says (see syncTenantsFromServer), plus drafts and
  // legacy browser-only tenants that have not been moved to the server yet.
  const [liveTenants, setLiveTenants] = useState<Tenant[]>(() => {
    try {
      // Check v4 key
      const savedLive = localStorage.getItem(LIVE_TENANTS_STORAGE_KEY);
      if (savedLive) {
        const parsed = JSON.parse(savedLive) as Tenant[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const clean = parsed
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

      // Migration: tenants from legacy storage
      const legacySaved = localStorage.getItem('pbc_tenants_registry_v3');
      if (legacySaved) {
        const parsed = JSON.parse(legacySaved) as Tenant[];
        if (Array.isArray(parsed)) {
          const legacyTenants = parsed
            .map(t => ({
              ...t,
              primaryFramework: t.primaryFramework || 'CMMC_L1',
              enabledFrameworks: (t.enabledFrameworks && t.enabledFrameworks.length > 0) ? t.enabledFrameworks : [t.primaryFramework || 'CMMC_L1'],
            }));
          const deduplicated = deduplicateTenants(legacyTenants);
          if (deduplicated.length > 0) {
            return deduplicated;
          }
        }
      }
    } catch {
      // live tenants initialization fallback
    } finally {
      // Purge legacy storage keys
      LEGACY_STORAGE_KEYS.forEach(k => {
        try { localStorage.removeItem(k); } catch {}
      });
    }

    return [DEFAULT_BLANK_TENANT];
  });

  // Active tenant
  const [liveActiveTenantId, setLiveActiveTenantId] = useState<string>(() => {
    const saved = localStorage.getItem(LIVE_ACTIVE_TENANT_ID_KEY);
    if (saved && liveTenants.some(t => t.id === saved)) {
      return saved;
    }
    return liveTenants[0]?.id || DEFAULT_BLANK_TENANT.id;
  });

  // Active User Profile
  const [currentUser, setCurrentUser] = useState<User>(() => {
    try {
      const saved = localStorage.getItem(CURRENT_USER_KEY);
      if (saved) {
        return JSON.parse(saved) as User;
      }
    } catch {
      // storage user load fallback
    }
    return ANONYMOUS_USER;
  });

  // The server issues and holds invitations (their tokens are secrets): this is only the list last loaded from it.
  const [invitations, setInvitations] = useState<TenantInvitation[]>([]);

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
    } catch {
      // team members storage load fallback
    }
    return {};
  });

  const [isOnboardingModalOpen, setIsOnboardingModalOpen] = useState<boolean>(false);
  const [isTeamModalOpen, setIsTeamModalOpen] = useState<boolean>(false);
  const [isStigModalOpen, setIsStigModalOpen] = useState<boolean>(false);
  const [isStackSurveyModalOpen, setIsStackSurveyModalOpen] = useState<boolean>(false);

  // Sync storage
  useEffect(() => {
    localStorage.setItem(LIVE_TENANTS_STORAGE_KEY, JSON.stringify(stripTenantRegistryForCache(deduplicateTenants(liveTenants))));
  }, [liveTenants]);

  useEffect(() => {
    localStorage.setItem(LIVE_ACTIVE_TENANT_ID_KEY, liveActiveTenantId);
  }, [liveActiveTenantId]);

  useEffect(() => {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
  }, [currentUser]);

  useEffect(() => {
    // Teams of server-backed tenants come from the server on every load; only browser-only tenants keep a local copy
    const serverBackedIds = new Set(liveTenantsRef.current.filter(t => t.serverBacked).map(t => t.id));
    localStorage.setItem(
      TEAM_MEMBERS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(teamMembers).filter(([tenantId]) => !serverBackedIds.has(tenantId))))
    );
  }, [teamMembers]);


  const tenants = liveTenants;

  const currentTenant = useMemo(
    () => liveTenants.find(t => t.id === liveActiveTenantId) || liveTenants[0] || DEFAULT_BLANK_TENANT,
    [liveTenants, liveActiveTenantId]
  );

  // Does the active user hold an MSP role or have multi-tenant management rights: an MSP_ADMIN role, a platform
  // administrator, or access to more than one enclave
  const isMspUser = useMemo(() => {
    const roleInCurrent = currentUser.roles?.[currentTenant.id];
    const hasMspRole =
      roleInCurrent === 'MSP_ADMIN' ||
      Object.values(currentUser.roles || {}).includes('MSP_ADMIN');

    return Boolean(hasMspRole || isSuperAdminUser(currentUser) || liveTenants.length > 1);
  }, [currentUser, currentTenant, liveTenants.length]);

  const isSuperAdmin = useMemo(() => {
    return isSuperAdminUser(currentUser);
  }, [currentUser]);

  // ── Server → client tenant synchronisation ─────────────────────────────────────────────────────────────
  // The server decides which tenants a user belongs to and what role they hold. localStorage is only a cache:
  // after every sign-in (and on reload of a signed-in session) it is reconciled with GET /api/v1/tenants.
  const [tenantSync, setTenantSync] = useState<TenantSyncState>({ status: 'idle', lastSyncedAt: null, error: null });
  const liveTenantsRef = useRef(liveTenants);
  liveTenantsRef.current = liveTenants;
  const syncInFlight = useRef<Promise<Tenant[] | null> | null>(null);
  // Latest values for async callbacks (avoid stale closures after an await)
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const currentTenantIdRef = useRef(currentTenant.id);
  currentTenantIdRef.current = currentTenant.id;
  // Plaintext invitation tokens exist ONLY here, in memory, from creation/resend until the page closes.
  // The server keeps just a hash, so a link cannot be recovered later: use Resend to issue a fresh one.
  const inviteTokensRef = useRef<Record<string, string>>({});
  const [teamError, setTeamError] = useState<string | null>(null);

  const syncTenantsFromServer = useCallback(async (tokenOverride?: string, options?: { force?: boolean }): Promise<Tenant[] | null> => {
    const token = tokenOverride ?? ApiClient.getToken();
    if (!token) return null;
    if (syncInFlight.current) {
      // Coalesce overlapping triggers (login + mount), unless the caller needs a sync that starts AFTER now
      // (e.g. right after creating a tenant, when an older in-flight listing would not include it).
      if (!options?.force) return syncInFlight.current;
      await syncInFlight.current.catch(() => null);
    }

    const run = (async (): Promise<Tenant[] | null> => {
      setTenantSync((prev) => ({ ...prev, status: 'syncing', error: null }));
      try {
        const [server, platform] = await Promise.all([ApiClient.listMyTenants(token), ApiClient.getPlatformStatus(token)]);
        // The server decides who administers this platform; an unknown answer never grants rights
        if (platform) setCurrentUser((prev) => (prev.isSuperAdmin === platform.isPlatformAdmin ? prev : { ...prev, isSuperAdmin: platform.isPlatformAdmin }));
        if (server === null) {
          // The session was not accepted: nothing to reconcile, and nothing server-backed may be trusted.
          setTenantSync((prev) => ({ ...prev, status: 'idle' }));
          return null;
        }

        const result = mergeServerTenants(liveTenantsRef.current, server, new Date(), { placeholderIds: [DEFAULT_BLANK_TENANT.id] });
        setLiveTenants(result.tenants);
        setCurrentUser((prev) => ({ ...prev, roles: applyRoleSync(prev.roles ?? {}, result) }));
        setLiveActiveTenantId((prev) => pickActiveTenantId(prev, result.tenants, result.serverTenantIds, [DEFAULT_BLANK_TENANT.id]));
        // A user who already has tenants on the server does not need the first-run wizard
        if (server.length > 0) setIsOnboardingModalOpen(false);
        setTenantSync({ status: 'synced', lastSyncedAt: new Date().toISOString(), error: null });
        return result.tenants;
      } catch (err: unknown) {
        // Offline or server error: keep the cache, but say so. The server still enforces every request.
        console.warn('[Tenants] Could not sync tenants from the server:', errorMessage(err));
        setTenantSync((prev) => ({ ...prev, status: 'error', error: errorMessage(err) || 'Tenant sync failed' }));
        return null;
      }
    })();

    syncInFlight.current = run;
    try {
      return await run;
    } finally {
      if (syncInFlight.current === run) syncInFlight.current = null;
    }
  }, []);

  // Reload with an existing session: refresh the cache from the server straight away.
  useEffect(() => {
    if (ApiClient.getToken()) {
      void syncTenantsFromServer();
    }
  }, [syncTenantsFromServer]);

  /**
   * Creates a tenant ON THE SERVER (POST /api/v1/tenants) and then pulls the authoritative record back with the
   * tenant sync, so the UI shows exactly what the server stored, with the caller's server-assigned role.
   * Throws ApiError (401 / 403 / 400 / 5xx / network) for the caller to show. The id is generated by the server.
   *
   * `browserOnly` fields are not part of the server record and are applied locally afterwards.
   */
  const createTenantOnServer = useCallback(async (
    input: ServerTenantPatch & { name: string },
    browserOnly: Partial<Pick<Tenant, 'domain' | 'isConfigured'>> & { activate?: boolean } = {}
  ): Promise<Tenant> => {
    const token = ApiClient.getToken() ?? undefined;
    const created = await ApiClient.createTenant(input, token);
    const createdId = created.tenant.id;

    // Pull the authoritative record (and our role) from the server.
    const synced = await syncTenantsFromServer(token, { force: true });
    let tenant = synced?.find((t) => t.id === createdId);

    if (!tenant) {
      // Created, but the follow-up listing failed (e.g. a network blip): build the tenant from the POST response so
      // the UI is not stuck. The next successful sync reconciles it.
      const record = parseServerTenants({ tenants: [{ ...created.tenant, role: 'TENANT_OWNER', source: 'membership' }] })[0];
      const built = serverTenantToTenant(record, undefined, new Date().toISOString());
      tenant = built;
      setLiveTenants((prev) => (prev.some((t) => t.id === createdId) ? prev : [...prev.filter((t) => t.id !== DEFAULT_BLANK_TENANT.id), built]));
      setCurrentUser((prev) => ({ ...prev, roles: { ...prev.roles, [createdId]: 'TENANT_OWNER' } }));
    }

    const { activate = true, ...extras } = browserOnly;
    const defined = Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)) as Partial<Tenant>;
    if (Object.keys(defined).length > 0) {
      tenant = { ...tenant, ...defined };
      setLiveTenants((prev) => prev.map((t) => (t.id === createdId ? { ...t, ...defined } : t)));
    }
    if (activate) setLiveActiveTenantId(createdId);
    return tenant;
  }, [syncTenantsFromServer]);

  /**
   * Loads a server-backed tenant's members and (for owners / MSP admins) pending invitations from the server and shows
   * them in the team list. Anyone may see who is on the team; invitations are administrative, so only admins fetch them.
   */
  const refreshTeam = useCallback(async (tenantIdArg?: string, options: { asAdmin?: boolean } = {}): Promise<void> => {
    const tenantId = tenantIdArg ?? currentTenantIdRef.current;
    const tenant = liveTenantsRef.current.find(t => t.id === tenantId);
    if (!tenant?.serverBacked) return;

    try {
      const isAdmin = options.asAdmin || canRoleWrite(currentUserRef.current.roles?.[tenantId]);
      const [members, invites] = await Promise.all([
        ApiClient.listMembers(tenantId),
        isAdmin ? ApiClient.listInvites(tenantId) : Promise.resolve<ServerInvitation[]>([]),
      ]);
      setTeamMembers(prev => ({ ...prev, [tenantId]: buildTeam(tenantId, members, invites, inviteTokensRef.current) }));
      if (isAdmin) {
        const mapped = invites.map(i => toTenantInvitation(i, tenant, inviteTokensRef.current[i.id]));
        setInvitations(prev => mergeServerInvitations(prev, tenantId, mapped));
      }
      setTeamError(null);
    } catch (err: unknown) {
      console.warn('[Team] Could not load the team from the server:', errorMessage(err));
      setTeamError(errorMessage(err) || 'Could not load the team');
    }
  }, []);

  const refreshAllTeams = useCallback(async (): Promise<void> => {
    for (const t of liveTenantsRef.current) {
      if (t.serverBacked && canRoleWrite(currentUserRef.current.roles?.[t.id])) await refreshTeam(t.id);
    }
  }, [refreshTeam]);

  /**
   * Moves a browser-only tenant to the server: creates it there (the server assigns the id), ports its assessment and
   * evidence files to that id, and removes the local copy. Browser-only team members and invitations cannot be honoured
   * by the server, so they are dropped with the old record: re-invite people from the migrated tenant.
   */
  const migrateTenantToServer = useCallback(async (
    target: Tenant,
    override: ServerTenantPatch = {},
    activate = true
  ): Promise<{ tenant: Tenant; evidenceFilesMoved: number; controlsFailed: number; objectivesFailed: number; assetsMoved: number; assetsFailed: number }> => {
    const base = toServerPatch(target);
    const created = await createTenantOnServer(
      { ...base, ...override, name: (override.name ?? target.name).trim() },
      { domain: target.domain, isConfigured: target.isConfigured ?? true, activate }
    );
    // In live mode the server is the source of truth for control answers, so carry over everything the user filled in
    // (otherwise the new tenant's defaults would replace it on the next sync).
    const legacyControls = Object.values(StorageService.loadAssessment(target).controls).filter(
      c => c.status !== 'NOT_STARTED' || (c.implementationNotes || '').trim() !== ''
    );
    const pushed = await Promise.allSettled(
      legacyControls.map(c =>
        ApiClient.updateControl(created.id, c.id, {
          status: c.status,
          implementationNotes: c.implementationNotes,
          responsibleRole: c.responsibleRole,
          updatedBy: c.updatedBy,
        })
      )
    );
    const controlsFailed = pushed.filter(r => r.status === 'rejected').length;

    // The objective narratives, status and evidence links of the default program move too (insert-only: a new tenant holds none yet)
    const legacyState = StorageService.loadAssessment(target);
    const objectiveUpload = objectivesToUpload(legacyState.objectives, controlId => Boolean(findControlDefinition(controlId)));
    const objectiveResults: { objectiveId: string; result: ObjectiveImportResult }[] = [];
    let objectivesFailed = 0;
    for (const chunk of chunkItems(objectiveUpload.items, MAX_OBJECTIVE_IMPORT)) {
      try {
        objectiveResults.push(...(await ApiClient.importObjectives(created.id, chunk, null)));
      } catch {
        objectivesFailed += chunk.length;
      }
    }

    // The CMMC asset inventory is server-owned too. A demo fleet that an older version seeded into this browser is never
    // carried over (it is not this tenant's data).
    const legacyAssets = getEnclaveAssets(target.id).filter(a => !isDemoSeedAsset(a, target.id));
    let assetsMoved = 0;
    let assetsFailed = 0;
    const toInput = (a: EnclaveAsset): AssetInput => ({
      hostName: a.hostName, ipAddress: a.ipAddress, macAddress: a.macAddress, osProfile: a.osProfile,
      cmmcAssetCategory: a.cmmcAssetCategory, status: a.status, sourceOrigin: a.sourceOrigin,
      discoveryStatus: a.discoveryStatus, accretionMetadata: a.accretionMetadata, lastScannedAt: a.lastScannedAt,
      complianceScore: a.complianceScore, notes: a.notes, owner: a.owner ?? '',
      fipsValidationStatus: a.fipsValidationStatus, fipsCertificateNumber: a.fipsCertificateNumber,
      fipsModuleName: a.fipsModuleName, fipsStandard: a.fipsStandard,
    });
    for (let i = 0; i < legacyAssets.length; i += 500) {
      const chunk = legacyAssets.slice(i, i + 500);
      try {
        const res = await ApiClient.createAssetsBulk(created.id, chunk.map(toInput));
        assetsMoved += res.created.length;
        assetsFailed += res.skipped.length;
      } catch {
        // one malformed row rejects the whole request: retry one by one so the good ones still move
        for (const a of chunk) {
          try {
            await ApiClient.createAsset(created.id, toInput(a));
            assetsMoved++;
          } catch {
            assetsFailed++;
          }
        }
      }
    }
    if (assetsFailed === 0) clearLocalEnclaveAssets(target.id);
    // The new tenant may already be active and showing its (still empty) inventory: tell every asset view to reload
    notifyAssetsChanged(created.id);
    const migratedState = StorageService.migrateAssessment(target, created.id);
    // Only a complete upload marks the cache: until then (and for any failure) the cached narratives stay and the next load retries
    if (objectivesFailed === 0) {
      StorageService.saveAssessment(created.id, applyImportResult(migratedState, objectiveResults, new Date().toISOString(), objectiveUpload.unsendable));
    }
    const evidenceFilesMoved = await EvidenceVault.moveTenant(target.id, created.id);
    setLiveTenants(prev => prev.filter(t => t.id !== target.id));
    setInvitations(prev => prev.filter(i => i.tenantId !== target.id));
    setTeamMembers(prev => {
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    setCurrentUser(prev => {
      const roles = { ...prev.roles };
      delete roles[target.id];
      return { ...prev, roles };
    });
    return { tenant: created, evidenceFilesMoved, controlsFailed, objectivesFailed, assetsMoved, assetsFailed };
  }, [createTenantOnServer]);

  /** "Move to server": the user-facing action for tenants that only exist in this browser. */
  const migrateLocalTenantToServer = useCallback(async (tenantId: string): Promise<{ tenantId: string; evidenceFilesMoved: number; controlsFailed: number; objectivesFailed: number; assetsMoved: number; assetsFailed: number }> => {
    const target = liveTenantsRef.current.find(t => t.id === tenantId);
    if (!target) throw new ApiError(404, 'That tenant was not found.');
    if (target.serverBacked) return { tenantId, evidenceFilesMoved: 0, controlsFailed: 0, objectivesFailed: 0, assetsMoved: 0, assetsFailed: 0 };
    if (target.isConfigured === false) throw new ApiError(409, 'Finish this tenant\'s setup wizard first; it creates the tenant on the server.');
    const moved = await migrateTenantToServer(target, {}, target.id === currentTenantIdRef.current);
    return { tenantId: moved.tenant.id, evidenceFilesMoved: moved.evidenceFilesMoved, controlsFailed: moved.controlsFailed, objectivesFailed: moved.objectivesFailed, assetsMoved: moved.assetsMoved, assetsFailed: moved.assetsFailed };
  }, [migrateTenantToServer]);


  // ============================================================================
  // Programs (authorization boundaries): one framework, baseline and set of control answers each
  // ============================================================================
  // The live data (controls + evidence) the Express API returned for the active scope. `liveScopeKey` names that scope
  // (tenant, or tenant::program): nothing may be merged, shown as loaded or saved unless it matches the scope on screen.
  const [liveControls, setLiveControls] = useState<Record<string, ControlState> | null>(null);
  const [liveEvidence, setLiveEvidence] = useState<EvidenceItem[] | null>(null);
  const [liveObjectives, setLiveObjectives] = useState<Record<string, ObjectiveRecord> | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [liveScopeKey, setLiveScopeKey] = useState<string | null>(null);
  // Request sequence of the live data: every load takes a number and its answer is dropped unless it is still the newest, so a
  // slow response for one program (or tenant) can never land in another. A program switch bumps it too.
  const liveSeq = useRef(0);

  // The programs of the active tenant (server-backed tenants only). `programsRef` is what async code reads: a render lags a commit.
  const [programsState, setProgramsState] = useState<ProgramsState>({ tenantId: '', programs: NO_PROGRAMS, status: 'idle', activeId: null });
  const programsRef = useRef(programsState);
  const programsSeq = useRef(0);
  const commitPrograms = useCallback((next: ProgramsState) => {
    programsRef.current = next;
    setProgramsState(next);
  }, []);
  /** Forgets the live data of the previous scope at once and invalidates every load still in flight. */
  const dropLiveData = useCallback(() => {
    liveSeq.current++;
    setLiveControls(null);
    setLiveEvidence(null);
    setLiveObjectives(null);
    setLiveScopeKey(null);
  }, []);
  /** The program a tenant's requests go to right now (null: none known yet, the server serves its default program). */
  const programIdFor = useCallback((tenantId: string): string | null => {
    const ps = programsRef.current;
    return ps.tenantId === tenantId ? ps.activeId : null;
  }, []);

  const programsForTenant = programsState.tenantId === currentTenant.id && Boolean(currentTenant.serverBacked);
  const programs = programsForTenant ? programsState.programs : NO_PROGRAMS;
  const activeProgram = useMemo(
    () => programs.find(p => p.id === programsState.activeId && !p.archived) ?? null,
    [programs, programsState.activeId]
  );
  const activeProgramId = activeProgram?.id ?? null;
  const programsStatus: ProgramsStatus = !currentTenant.serverBacked ? 'unsupported' : programsForTenant ? programsState.status : 'idle';

  const refreshPrograms = useCallback(async (tenantIdArg?: string): Promise<void> => {
    const tenantId = tenantIdArg ?? currentTenantIdRef.current;
    if (!liveTenantsRef.current.find(t => t.id === tenantId)?.serverBacked) return;
    const seq = ++programsSeq.current;
    const before = programsRef.current;
    const sameTenant = before.tenantId === tenantId;
    if (!sameTenant || before.status === 'idle') {
      commitPrograms({ tenantId, programs: sameTenant ? before.programs : NO_PROGRAMS, status: 'loading', activeId: sameTenant ? before.activeId : null });
    }
    try {
      const list = await ApiClient.listPrograms(tenantId, { includeArchived: true });
      // Dropped when a newer refresh started or the user moved to another tenant meanwhile
      if (!isCurrentResponse(seq, programsSeq.current) || tenantId !== currentTenantIdRef.current) return;
      const prev = programsRef.current;
      const prevActive = prev.tenantId === tenantId ? prev.activeId : null;
      let stored: string | null = null;
      try { stored = localStorage.getItem(activeProgramStorageKey(tenantId)); } catch {}
      const activeId = pickActiveProgramId(prevActive ?? stored, list);
      // The active program changed under the screen (first load, archived, deleted): the live data of the old one must go
      if (activeId !== prevActive) dropLiveData();
      commitPrograms({ tenantId, programs: list, status: 'ready', activeId });
    } catch (err: unknown) {
      if (!isCurrentResponse(seq, programsSeq.current) || tenantId !== currentTenantIdRef.current) return;
      console.warn('[Programs] Could not load the programs from the server:', errorMessage(err));
      const prev = programsRef.current;
      const same = prev.tenantId === tenantId;
      commitPrograms({ tenantId, programs: same ? prev.programs : NO_PROGRAMS, status: 'error', activeId: same ? prev.activeId : null });
    }
  }, [commitPrograms, dropLiveData]);

  // Programs follow the active tenant: loaded from the server, or none for a tenant that only exists in this browser
  useEffect(() => {
    if (!currentTenant.serverBacked) {
      programsSeq.current++;
      commitPrograms({ tenantId: currentTenant.id, programs: NO_PROGRAMS, status: 'unsupported', activeId: null });
      return;
    }
    if (ApiClient.getToken()) void refreshPrograms(currentTenant.id);
  }, [currentTenant.id, currentTenant.serverBacked, refreshPrograms, commitPrograms]);

  /**
   * Switch sequence: validate the program (it must exist, not be archived), remember the choice, bump the request sequence and
   * clear the live controls / evidence / scope key in the same render, then the live-data effect loads the new program (and
   * AssessmentContext reloads its cache from the new program's key). Nothing of the old program is shown, merged or saved after it.
   */
  const switchProgram = useCallback((programId: string): boolean => {
    const tenantId = currentTenantIdRef.current;
    const ps = programsRef.current;
    if (ps.tenantId !== tenantId || !liveTenantsRef.current.find(t => t.id === tenantId)?.serverBacked) return false;
    const target = ps.programs.find(p => p.id === programId);
    if (!target || target.archived) return false;
    if (ps.activeId === programId) return true;
    try {
      localStorage.setItem(activeProgramStorageKey(tenantId), programId);
    } catch {
      // storage unavailable: the choice only lasts for this session
    }
    dropLiveData();
    commitPrograms({ ...ps, activeId: programId });
    return true;
  }, [commitPrograms, dropLiveData]);

  const createProgram = useCallback(async (input: ProgramInput): Promise<Program> => {
    const tenantId = currentTenantIdRef.current;
    const created = await ApiClient.createProgram(tenantId, input);
    await refreshPrograms(tenantId);
    return created;
  }, [refreshPrograms]);

  const updateProgram = useCallback(async (programId: string, updates: ProgramUpdate): Promise<Program> => {
    const tenantId = currentTenantIdRef.current;
    const updated = await ApiClient.updateProgram(tenantId, programId, updates);
    await refreshPrograms(tenantId);
    return updated;
  }, [refreshPrograms]);

  const archiveProgram = useCallback(async (programId: string): Promise<void> => {
    const tenantId = currentTenantIdRef.current;
    await ApiClient.archiveProgram(tenantId, programId);
    // The refresh moves the screen to another program when the archived one was showing (see refreshPrograms)
    await refreshPrograms(tenantId);
  }, [refreshPrograms]);

  const unarchiveProgram = useCallback(async (programId: string): Promise<void> => {
    const tenantId = currentTenantIdRef.current;
    await ApiClient.unarchiveProgram(tenantId, programId);
    await refreshPrograms(tenantId);
  }, [refreshPrograms]);

  const deleteProgram = useCallback(async (programId: string): Promise<void> => {
    const tenantId = currentTenantIdRef.current;
    await ApiClient.deleteProgram(tenantId, programId);
    // Its browser cache goes with it; a stored choice of it is forgotten
    try {
      localStorage.removeItem(StorageService.getAssessmentKey(tenantId, programId));
      if (localStorage.getItem(activeProgramStorageKey(tenantId)) === programId) localStorage.removeItem(activeProgramStorageKey(tenantId));
    } catch {}
    const ps = programsRef.current;
    if (ps.tenantId === tenantId && ps.activeId === programId) commitPrograms({ ...ps, activeId: null });
    await refreshPrograms(tenantId);
  }, [refreshPrograms, commitPrograms]);

  // Framework, baseline and CIA triad belong to the active program (fixed when it is created); a tenant without one uses its primary framework
  const activeFramework: ComplianceFramework = activeProgram?.framework ?? currentTenant.primaryFramework ?? 'CMMC_L1';
  const activeBaselineTier: BaselineTier = baselineToTier(activeProgram?.baseline);
  const ciaTriad = useMemo<CiaTriadSelection>(() => programBaselineToCia(activeProgram?.baseline), [activeProgram?.baseline]);

  const setActiveFramework = useCallback((framework: ComplianceFramework) => {
    const ps = programsRef.current;
    if (ps.tenantId !== currentTenantIdRef.current) return;
    const current = ps.programs.find(p => p.id === ps.activeId);
    if (current && current.framework === framework) return;
    const matching = ps.programs.filter(p => !p.archived && p.framework === framework);
    const target = matching.find(p => p.isDefault) ?? matching[0];
    if (target) switchProgram(target.id);
  }, [switchProgram]);

  // Overlays stay per browser until they become a program setting
  const [storedOverlayFilters, setActiveOverlayFilters] = useState<OverlayFilters>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_OVERLAY_FILTERS_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // overlay filters storage load fallback
    }
    return { nonNetworkedOnly: false };
  });
  // A program that applies the privacy baseline processes PII: "No PII processing" does not apply to it, whatever this browser saved
  const activeOverlayFilters = useMemo<OverlayFilters>(
    () => (activeProgram?.privacyBaseline && storedOverlayFilters.noPiiProcessing ? { ...storedOverlayFilters, noPiiProcessing: false } : storedOverlayFilters),
    [storedOverlayFilters, activeProgram?.privacyBaseline]
  );

  // The CIA triad follows the program's baseline: the old per-browser editor has no effect any more
  const setCiaImpact = useCallback((_dimension: 'confidentiality' | 'integrity' | 'availability', _level: ImpactLevel) => {}, []);
  const toggleAllControlsApplied = useCallback(() => {}, []);

  const toggleOverlayFilter = useCallback((key: keyof OverlayFilters) => {
    setActiveOverlayFilters(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(ACTIVE_OVERLAY_FILTERS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const toggleNonNetworkedOverlay = useCallback(() => {
    toggleOverlayFilter('nonNetworkedOnly');
  }, [toggleOverlayFilter]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_OVERLAY_FILTERS_KEY, JSON.stringify(storedOverlayFilters));
    } catch {}
  }, [storedOverlayFilters]);

  // ============================================================================
  // Express API Live Sync Engine (Row-Level Security Tenant Isolation)
  // ============================================================================
  /** The scope (tenant, or tenant::program) the requests of `tenantId` belong to right now. */
  const scopeNow = useCallback((tenantId: string): string => programScopeKey(tenantId, programIdFor(tenantId)), [programIdFor]);

  /**
   * Pull live control states and evidence artifacts from PostgreSQL via /api/v1
   * Operates with dynamic framework, baseline, overlay and program parameters. The latest request wins: an answer that
   * is no longer the newest (another program, another tenant, a newer refresh) is dropped, never shown or merged.
   */
  const refreshLiveData = useCallback(async (
    tenantToFetch?: string,
    frameworkToFetch?: ComplianceFramework,
    baselineToFetch?: BaselineTier,
    overlayToFetch?: OverlayParameter,
    programToFetch?: string | null
  ) => {
    const targetTenantId = tenantToFetch || currentTenant.id;
    const seq = ++liveSeq.current;

    // A tenant that exists only in this browser (a draft, or legacy data) has nothing on the server to load
    const serverTenant = liveTenantsRef.current.find(t => t.id === targetTenantId);
    if (serverTenant && !serverTenant.serverBacked) {
      setLiveControls(null);
      setLiveEvidence(null);
      setLiveObjectives(null);
      setLiveScopeKey(null);
      return;
    }

    const token = ApiClient.getToken();
    if (!token) {
      // Unauthenticated fallback
      setLiveScopeKey(null);
      return;
    }

    // The program: the one asked for, else the active one of that tenant (null: the server's default program)
    const ps = programsRef.current;
    const programId = programToFetch !== undefined ? programToFetch : ps.tenantId === targetTenantId ? ps.activeId : null;
    const program = programId && ps.tenantId === targetTenantId ? ps.programs.find(p => p.id === programId) : undefined;
    const scope = programScopeKey(targetTenantId, programId);

    setIsSyncing(true);
    setSyncError(null);
    // A switch to another tenant or program must not keep showing the previous one's notes as loaded
    setLiveScopeKey(prev => (prev === scope ? prev : null));

    const fw = frameworkToFetch || program?.framework || activeFramework;
    const bl = baselineToFetch || (program ? baselineToTier(program.baseline) : activeBaselineTier);
    const ov = overlayToFetch || (activeOverlayFilters.nonNetworkedOnly ? 'NON_NETWORKED' : 'NONE');

    try {
      const [controlsList, evidenceList, objectivesList] = await Promise.all([
        ApiClient.getControls(targetTenantId, { framework: fw, baseline: bl, overlay: ov }, programId),
        ApiClient.getEvidence(targetTenantId, programId),
        ApiClient.getObjectives(targetTenantId, undefined, programId),
      ]);
      if (!isCurrentResponse(seq, liveSeq.current)) return;

      const controlsMap: Record<string, ControlState> = {};
      for (const ctrl of controlsList) {
        controlsMap[ctrl.id] = ctrl;
      }
      const objectivesMap: Record<string, ObjectiveRecord> = {};
      for (const obj of objectivesList) {
        objectivesMap[obj.objectiveId] = obj;
      }

      setLiveControls(controlsMap);
      setLiveEvidence(evidenceList);
      setLiveObjectives(objectivesMap);
      setLiveScopeKey(scope);
    } catch (err: unknown) {
      if (!isCurrentResponse(seq, liveSeq.current)) return;
      setLiveScopeKey(null);
      setSyncError(errorMessage(err) || 'Sync error');
    } finally {
      if (isCurrentResponse(seq, liveSeq.current)) setIsSyncing(false);
    }
  }, [currentTenant.id, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly]);

  // A server-backed tenant's data is not requested before its programs are known (or known to be unavailable): the first
  // request would otherwise go to the default program and be thrown away when the active program turns out to be another.
  const programsReady = programsStatus === 'ready' || programsStatus === 'error' || programsStatus === 'unsupported';

  // Automatically pull live controls & evidence when tenant, program, framework, or overlay changes
  useEffect(() => {
    if (ApiClient.getToken() && programsReady) {
      refreshLiveData(currentTenant.id, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly ? 'NON_NETWORKED' : 'NONE', activeProgramId);
    } else {
      liveSeq.current++;
      setLiveControls(null);
      setLiveEvidence(null);
      setLiveObjectives(null);
      setLiveScopeKey(null);
      setIsSyncing(false);
    }
  }, [currentTenant.id, activeProgramId, programsReady, activeFramework, activeBaselineTier, activeOverlayFilters.nonNetworkedOnly, refreshLiveData]);

  const updateLiveControl = useCallback(async (
    controlId: string,
    updates: Partial<ControlState>
  ): Promise<ControlState> => {
    // The program (and so the scope) is fixed when the edit starts: an answer arriving after a switch is not applied to the new program
    const scope = scopeNow(currentTenant.id);
    // Rejects when the server refuses or cannot be reached: the caller (AssessmentContext.saveControl) tells the user the edit was not saved
    const updated = await ApiClient.updateControl(currentTenant.id, controlId, updates, programIdFor(currentTenant.id));
    if (scopeNow(currentTenant.id) === scope) {
      setLiveControls(prev => ({
        ...prev,
        [controlId]: updated,
      }));
    }
    return updated;
  },[currentTenant.id, scopeNow, programIdFor]);

  /** Re-reads the objectives of `scope` and shows them, unless the scope on screen has changed meanwhile. */
  const reloadLiveObjectives = useCallback(async (scope: string, programId: string | null): Promise<Record<string, ObjectiveRecord>> => {
    const list = await ApiClient.getObjectives(currentTenant.id, undefined, programId);
    const map: Record<string, ObjectiveRecord> = {};
    for (const o of list) map[o.objectiveId] = o;
    if (scopeNow(currentTenant.id) === scope) setLiveObjectives(map);
    return map;
  }, [currentTenant.id, scopeNow]);

  // Like updateLiveControl, the objective writers reject: the narrative is only on the server, so the UI must be able to say it was not saved
  const updateLiveObjective = useCallback(async (
    objectiveId: string,
    controlId: string,
    patch: Omit<ObjectiveInput, 'objectiveId' | 'controlId'>
  ): Promise<ObjectiveRecord> => {
    // The program (and so the scope) is fixed when the edit starts
    const scope = scopeNow(currentTenant.id);
    const programId = programIdFor(currentTenant.id);
    const { objective } = await ApiClient.putObjective(currentTenant.id, { objectiveId, controlId, ...patch }, programId);
    if (scopeNow(currentTenant.id) === scope) {
      setLiveObjectives(prev => ({ ...(prev ?? {}), [objectiveId]: objective }));
    }
    return objective;
  }, [currentTenant.id, scopeNow, programIdFor]);

  const updateLiveObjectivesBulk = useCallback(async (items: ObjectiveInput[]): Promise<void> => {
    if (items.length === 0) return;
    const scope = scopeNow(currentTenant.id);
    const programId = programIdFor(currentTenant.id);
    for (const chunk of chunkItems(items, MAX_OBJECTIVE_BULK)) {
      await ApiClient.putObjectivesBulk(currentTenant.id, chunk, programId);
    }
    // The bulk answer carries counts only: read the program's records back
    await reloadLiveObjectives(scope, programId);
  }, [currentTenant.id, scopeNow, programIdFor, reloadLiveObjectives]);

  const importLiveObjectives = useCallback(async (
    items: ObjectiveInput[]
  ): Promise<{ results: { objectiveId: string; result: ObjectiveImportResult }[]; records: Record<string, ObjectiveRecord> }> => {
    const scope = scopeNow(currentTenant.id);
    const programId = programIdFor(currentTenant.id);
    const results: { objectiveId: string; result: ObjectiveImportResult }[] = [];
    for (const chunk of chunkItems(items, MAX_OBJECTIVE_IMPORT)) {
      results.push(...(await ApiClient.importObjectives(currentTenant.id, chunk, programId)));
    }
    // What the import created is on the server now: show it (the caller's marker keeps it out of this browser's cache). The records
    // also tell the caller which conflicts are about the narrative text; a failed read rejects, and the next load retries.
    const records = await reloadLiveObjectives(scope, programId);
    return { results, records };
  }, [currentTenant.id, scopeNow, programIdFor, reloadLiveObjectives]);

  const createLiveEvidenceUploadUrl = useCallback(async (payload: {
    controlId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    fileHash: string;
    description?: string;
  }, programId?: string | null): Promise<UploadUrlResponse | null> => {
    // `programId` is the program the caller started the upload for (default: the active one now)
    const program = programId !== undefined ? programId : programIdFor(currentTenant.id);
    const scope = programScopeKey(currentTenant.id, program);
    try {
      const resp = await ApiClient.requestUploadUrl(currentTenant.id, payload, program);
      if (scopeNow(currentTenant.id) === scope) setLiveEvidence(prev => [resp.evidence, ...(prev || [])]);
      return resp;
    } catch {
      return null;
    }
  }, [currentTenant.id, scopeNow, programIdFor]);

  const deleteLiveEvidence = useCallback(async (evidenceId: string, programId?: string | null): Promise<{ removedIds: string[]; fileRemoved: boolean }> => {
    // `programId` is the program the caller started the delete for (default: the active one now)
    const program = programId !== undefined ? programId : programIdFor(currentTenant.id);
    const scope = programScopeKey(currentTenant.id, program);
    const result = await ApiClient.deleteEvidence(currentTenant.id, evidenceId, program);
    const gone = new Set(result.removedIds);
    if (scopeNow(currentTenant.id) === scope) setLiveEvidence(prev => prev ? prev.filter(e => !gone.has(e.id)) : prev);
    return result;
  }, [currentTenant.id, scopeNow, programIdFor]);

  // Check if active tenant requires initial setup wizard
  const needsOnboarding = useMemo(() => currentTenant.isConfigured === false, [currentTenant.isConfigured]);

  // Automatically trigger onboarding modal if active live tenant requires setup
  useEffect(() => {
    if (needsOnboarding) {
      setIsOnboardingModalOpen(true);
    }
  }, [needsOnboarding]);

  // Current role in active tenant
  // Fail closed: a user with no explicit role in this tenant is a read-only VIEWER.
  // (Platform super admins keep owner-level access to every enclave.)
  const currentRole: TenantRole = useMemo(() => {
    const explicitRole = currentUser.roles?.[currentTenant.id];
    if (isTenantRole(explicitRole)) return explicitRole;
    return isSuperAdminUser(currentUser) ? 'TENANT_OWNER' : 'VIEWER';
  }, [currentUser, currentTenant.id]);

  // Only TENANT_OWNER and MSP_ADMIN may edit; ASSESSOR and VIEWER are read-only.
  const canEdit = useMemo(() => canRoleWrite(currentRole), [currentRole]);

  // Creating, editing, archiving and deleting programs: TENANT_OWNER and MSP_ADMIN (the server enforces it)
  const canManagePrograms = canEdit;

  const canManageTenant = useMemo(() => {
    return currentRole === 'TENANT_OWNER' || currentRole === 'MSP_ADMIN';
  }, [currentRole]);

  // A server-backed tenant's team and invitations live on the server: load them when it becomes active (or the role changes)
  useEffect(() => {
    if (currentTenant.serverBacked) void refreshTeam(currentTenant.id);
  }, [currentTenant.id, currentTenant.serverBacked, currentRole, refreshTeam]);

  const switchTenant = useCallback((tenantId: string) => {
    if (liveTenants.some(t => t.id === tenantId)) {
      setLiveActiveTenantId(tenantId);
    }
  }, [liveTenants]);

  /**
   * Create a new organization with strict deduplication
   */
  const createTenant = useCallback(async (data: {
    name: string;
    cageCode: string;
    samStatus: SamStatus;
    systemName: string;
    systemOwner: string;
    industry: string;
    domain?: string;
    isConfigured?: boolean;
    enabledFrameworks?: ComplianceFramework[];
    primaryFramework?: ComplianceFramework;
  }): Promise<Tenant> => {
    // The server creates the tenant and assigns the caller as TENANT_OWNER. There is no local fallback.
    // (Failures surface to the caller as ApiError; a tenant that exists only in this browser could not be used.)
    const cage = data.cageCode.trim().toUpperCase();
    const primFw = data.primaryFramework || 'CMMC_L1';
    const enFw = data.enabledFrameworks && data.enabledFrameworks.length > 0 ? data.enabledFrameworks : [primFw];
    return createTenantOnServer(
      {
        name: data.name.trim(),
        cageCode: isValidCageCode(cage) ? cage : undefined,
        samStatus: data.samStatus,
        systemName: data.systemName.trim() || undefined,
        systemOwner: data.systemOwner.trim() || undefined,
        industry: data.industry || undefined,
        primaryFramework: primFw,
        enabledFrameworks: enFw,
      },
      { domain: data.domain }
    );
  }, [createTenantOnServer]);

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
          // A tenant that exists on the server starts read-only until the sync brings the real role
          [existing.id]: existing.serverBacked ? 'VIEWER' : (prevUser.roles[existing.id] || 'TENANT_OWNER'),
        },
      }));
      return existing;
    }

    // 2. First sign-in with no tenant anywhere: show the setup wizard for a DRAFT. The draft has no generated id of
    //    its own (it reuses the fixed placeholder id) and is never stored as a real tenant: completing the wizard
    //    creates the tenant on the server (see completeTenantOnboarding).
    const draft: Tenant = {
      ...DEFAULT_BLANK_TENANT,
      name: formattedTitle,
      cageCode: '',
      samStatus: 'NOT_REGISTERED',
      systemName: `${formattedTitle} Operations Boundary`,
      systemOwner: email,
      domain: emailDomain,
      isConfigured: false,
      serverBacked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setLiveTenants(prev => [draft, ...prev.filter(t => t.id !== DEFAULT_BLANK_TENANT.id)]);
    setLiveActiveTenantId(DEFAULT_BLANK_TENANT.id);
    // Local-only role so the wizard is usable; the server assigns the real role when the tenant is created.
    setCurrentUser(prevUser => ({
      ...prevUser,
      roles: { ...prevUser.roles, [DEFAULT_BLANK_TENANT.id]: 'TENANT_OWNER' },
    }));

    setIsOnboardingModalOpen(true);
    return draft;
  }, [liveTenants]);

  /**
   * Complete 2-step onboarding wizard and finalize tenant configuration
   */
  const completeTenantOnboarding = useCallback(async (tenantId: string, data: {
    organizationName: string;
    cageCode?: string;
    samStatus?: SamStatus;
    systemName: string;
    systemOwner: string;
    systemBoundaryScope?: string;
    cloudServiceProviders?: string;
  }): Promise<string> => {
    const target = liveTenantsRef.current.find(t => t.id === tenantId);
    const settings = toServerPatch({
      name: data.organizationName,
      cageCode: data.cageCode,
      samStatus: data.samStatus,
      systemName: data.systemName,
      systemOwner: data.systemOwner,
    });
    let finalId = tenantId;

    if (target && !target.serverBacked) {
      // A first-run draft, or a tenant that only ever existed in this browser: create the real tenant on the server and
      // move its local data under the server-assigned id (see migrateTenantToServer).
      const migrated = await migrateTenantToServer(target, { ...settings, name: data.organizationName.trim() });
      finalId = migrated.tenant.id;
    } else if (target?.serverBacked) {
      // Already on the server: persist the changes there first, so a refused update (403 etc.) is reported
      await ApiClient.updateTenant(tenantId, settings);
    }

    // Browser-side details (system boundary text) and the local copy of the settings
    const applyLocal = (list: Tenant[]) => list.map(t => (t.id === finalId ? {
      ...t,
      name: data.organizationName.trim(),
      cageCode: (data.cageCode || 'PENDING').trim().toUpperCase(),
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName.trim(),
      systemOwner: data.systemOwner.trim(),
      systemBoundaryScope: data.systemBoundaryScope?.trim(),
      isConfigured: true,
      updatedAt: new Date().toISOString(),
    } : t));
    setLiveTenants(prev => deduplicateTenants(applyLocal(prev)));

    // Update the assessment's SSP metadata in storage
    const currentAssessment = StorageService.loadAssessment({
      id: finalId,
      name: data.organizationName,
      cageCode: data.cageCode || '',
      samStatus: data.samStatus || 'ACTIVE',
      systemName: data.systemName,
      systemOwner: data.systemOwner,
      industry: 'Defense Industrial Base (DIB)',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      cloudServiceProviders: data.cloudServiceProviders?.trim() || currentAssessment.sspMetadata.cloudServiceProviders,
      lastUpdated: new Date().toISOString(),
    };

    StorageService.saveAssessment(finalId, currentAssessment);
    setIsOnboardingModalOpen(false);
    return finalId;
  }, [migrateTenantToServer]);

  const updateTenant = useCallback((tenantId: string, updates: Partial<Tenant>) => {
    // Optimistic local update...
    setLiveTenants(prev => prev.map(t => (t.id === tenantId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t)));

    // ...and for a tenant the server owns, persist the server-owned fields there. If the server refuses (e.g. 403 for a
    // non-owner) or is unreachable, re-sync so the UI snaps back to the authoritative values instead of drifting.
    const target = liveTenantsRef.current.find(t => t.id === tenantId);
    if (target?.serverBacked) {
      const patch = toServerPatch(updates);
      if (Object.keys(patch).length > 0) {
        ApiClient.updateTenant(tenantId, patch).catch((err: unknown) => {
          console.warn('[Tenants] Server rejected the tenant update; restoring server values:', errorMessage(err));
          setTenantSync((prev) => ({ ...prev, status: 'error', error: errorMessage(err) || 'Update was not saved' }));
          void syncTenantsFromServer(undefined, { force: true });
        });
      }
    }
  }, [syncTenantsFromServer]);

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
    // The framework shown is the active program's (or the tenant's primary one without a program): nothing else to switch
  }, [updateTenant]);

  const updateStackProfile = useCallback((profile: EnclaveStackProfile) => {
    updateTenant(currentTenant.id, { stackProfile: profile });

    // Cascade tailored stack narratives to the objectives of the active program's framework, filling only the empty ones: a narrative
    // somebody wrote is never overwritten. (SP 800-53 programs have their own objective ids and no stack templates: nothing to cascade.)
    if (activeFramework === 'NIST_800_53_REV5' || activeFramework === 'nist-800-53-r5') return;
    const scope = scopeNow(currentTenant.id);
    if (!currentTenant.serverBacked) {
      // Browser-only: the assessment state owns the cache, so it applies the cascade itself
      window.dispatchEvent(new CustomEvent(OBJECTIVE_CASCADE_EVENT, { detail: { scope, profile } }));
      return;
    }
    // Server-backed: the server's narratives decide what is empty; without them loaded (or without write access) nothing is touched
    if (!canEdit || !liveObjectives || liveScopeKey !== scope) return;
    const controlIds = getFrameworkControls(activeFramework, activeBaselineTier, activeOverlayFilters).map(c => c.id);
    const items = stackCascadeFill(controlIds, profile, id => liveObjectives[id]?.narrative ?? '');
    if (items.length === 0) return;
    updateLiveObjectivesBulk(items).catch((e: unknown) => {
      console.warn('[Stack cascade] Could not save the generated objective narratives:', errorMessage(e));
    });
  }, [currentTenant.id, currentTenant.serverBacked, canEdit, activeFramework, activeBaselineTier, activeOverlayFilters, liveObjectives, liveScopeKey, scopeNow, updateLiveObjectivesBulk, updateTenant]);

  const suspendTenant = useCallback((tenantId: string, suspend?: boolean) => {
    setLiveTenants(prev =>
      prev.map(t => {
        if (t.id === tenantId) {
          const nextSuspended = suspend !== undefined ? suspend : !t.isSuspended;
          return {
            ...t,
            isSuspended: nextSuspended,
            updatedAt: new Date().toISOString(),
          };
        }
        return t;
      })
    );
  }, []);

  const updateTenantOwner = useCallback((tenantId: string, newOwnerEmail: string, newOwnerName?: string) => {
    const cleanEmail = newOwnerEmail.trim().toLowerCase();
    const cleanName = newOwnerName?.trim() || cleanEmail.split('@')[0].replace('.', ' ').replace(/\b\w/g, c => c.toUpperCase());

    // 1. Update tenant systemOwner
    updateTenant(tenantId, {
      systemOwner: `${cleanName} (${cleanEmail})`,
      updatedAt: new Date().toISOString(),
    });

    // A server-backed tenant's team and roles belong to the server: a local rewrite would only show roles nobody holds
    if (liveTenantsRef.current.find(t => t.id === tenantId)?.serverBacked) return;

    // 2. Reassign team member roles for this tenant
    setTeamMembers(prev => {
      const list = prev[tenantId] || [];
      const updated = list.map(m => {
        if (m.role === 'TENANT_OWNER' && m.email.toLowerCase() !== cleanEmail) {
          return { ...m, role: 'ASSESSOR' as TenantRole };
        }
        if (m.email.toLowerCase() === cleanEmail) {
          return { ...m, name: cleanName, role: 'TENANT_OWNER' as TenantRole, status: 'ACTIVE' as const };
        }
        return m;
      });

      if (!updated.some(m => m.email.toLowerCase() === cleanEmail)) {
        updated.unshift({
          id: `mem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          tenantId,
          email: cleanEmail,
          name: cleanName,
          role: 'TENANT_OWNER',
          status: 'ACTIVE',
          joinedAt: new Date().toISOString(),
        });
      }

      return {
        ...prev,
        [tenantId]: updated,
      };
    });

    // 3. Update current user role if active user is this new owner
    if (currentUser.email.toLowerCase() === cleanEmail) {
      setCurrentUser(prev => ({
        ...prev,
        roles: {
          ...prev.roles,
          [tenantId]: 'TENANT_OWNER',
        },
      }));
    }
  }, [updateTenant, currentUser.email]);

  const deleteTenant = useCallback((tenantId: string) => {
    // 1. Clean up invitations associated with this tenant
    setInvitations(prev => prev.filter(inv => inv.tenantId !== tenantId));

    // 2. Clean up team members
    setTeamMembers(prev => {
      const next = { ...prev };
      delete next[tenantId];
      return next;
    });

    // 3. Clean up tenant localStorage data
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(`pbc_cmmc_assessment_v3_${tenantId}`);
        window.localStorage.removeItem(`pbc_assessment_${tenantId}`);
        window.localStorage.removeItem(`pbc_audit_ledger_${tenantId}`);
        // every other program's assessment cache (pbc_cmmc_assessment_v3_<tenant>::<program>) and the active-program choice
        StorageService.listProgramKeys(tenantId).forEach(key => window.localStorage.removeItem(key));
      } catch {}
    }
    // evidence files live in IndexedDB, not localStorage
    void EvidenceVault.clearTenant(tenantId);

    // 4. Remove the tenant from the list
    const filtered = liveTenants.filter(t => t.id !== tenantId);
    const nextLive = filtered.length > 0 ? filtered : [DEFAULT_BLANK_TENANT];
    setLiveTenants(nextLive);
    if (liveActiveTenantId === tenantId) {
      setLiveActiveTenantId(nextLive[0].id);
    }
  }, [liveTenants, liveActiveTenantId]);

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
      setLiveActiveTenantId(accessibleTenants[0]);
    }
  }, []);

  /**
   * Sign-out: the tenant list, roles, team and programs in this browser belong to the person who just left. Per-tenant
   * assessment caches and the audit ledger stay (offline caches, keyed by tenant and program).
   */
  const resetForSignOut = useCallback(() => {
    syncInFlight.current = null;
    programsSeq.current++;
    dropLiveData();
    commitPrograms({ tenantId: '', programs: NO_PROGRAMS, status: 'idle', activeId: null });
    setLiveTenants([DEFAULT_BLANK_TENANT]);
    setLiveActiveTenantId(DEFAULT_BLANK_TENANT.id);
    setCurrentUser(ANONYMOUS_USER);
    setTeamMembers({});
    setInvitations([]);
    setIsOnboardingModalOpen(false);
    setTenantSync({ status: 'idle', lastSyncedAt: null, error: null });
    try {
      [LIVE_TENANTS_STORAGE_KEY, LIVE_ACTIVE_TENANT_ID_KEY, CURRENT_USER_KEY, TEAM_MEMBERS_STORAGE_KEY].forEach(k => localStorage.removeItem(k));
      const programPrefix = activeProgramStorageKey('');
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(programPrefix)) localStorage.removeItem(k);
      }
    } catch {
      // storage unavailable: nothing was cached
    }
  }, [commitPrograms, dropLiveData]);

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

    // 1. Match existing tenants by the exact email domain only (a name that merely contains it proves nothing)
    const matchedLive = liveTenants.find(t => t.domain && t.domain.toLowerCase() === domain);

    if (matchedLive) {
      setLiveActiveTenantId(matchedLive.id);
      return { tenant: matchedLive, role: provisionalRoleForTenant(matchedLive, domain) };
    }

    // 2. Initialize single blank tenant enclave for first-time defense contractor domain
    const formattedTitle = domainPrefix.charAt(0).toUpperCase() + domainPrefix.slice(1) + ' LLC';
    const newBlankTenant = initializeBlankTenant(email, domain, formattedTitle);

    return { tenant: newBlankTenant, role: provisionalRoleForTenant(newBlankTenant, domain) };
  }, [liveTenants, currentTenant, currentRole, initializeBlankTenant]);

  /**
   * Synchronize authenticated user with Tenant state
   */
  const syncAuthUser = useCallback((user: User, preferredTenantId?: string, options: { skipServerSync?: boolean } = {}) => {
    setCurrentUser(user);
    if (preferredTenantId && liveTenants.some(t => t.id === preferredTenantId)) {
      setLiveActiveTenantId(preferredTenantId);
    } else {
      const matched = Object.keys(user.roles || {}).find(id => liveTenants.some(t => t.id === id));
      if (matched) setLiveActiveTenantId(matched);
    }

    // Reconcile tenants and roles with the server, then load live data for the active tenant
    if (!options.skipServerSync && (user.idToken || ApiClient.getToken())) {
      void syncTenantsFromServer(user.idToken || undefined)
        .then(() => refreshPrograms(preferredTenantId))
        .then(() => refreshLiveData(preferredTenantId));
    }
  }, [liveTenants, refreshLiveData, refreshPrograms, syncTenantsFromServer]);

  /**
   * Provision a brand-new defense enclave with isolated database boundary and onboarding token
   */
  const provisionTenant = useCallback(async (data: {
    companyName: string;
    cageCode?: string;
    systemBoundaryName?: string;
    tenantOwnerEmail: string;
    primaryFramework?: ComplianceFramework;
    enabledFrameworks?: ComplianceFramework[];
  }): Promise<{ tenant: Tenant; invitation: TenantInvitation; inviteUrl: string }> => {
    const emailDomain = data.tenantOwnerEmail.split('@')[1] || 'defense.us';
    const primFw = data.primaryFramework || 'CMMC_L1';
    const enFw = data.enabledFrameworks && data.enabledFrameworks.length > 0 ? data.enabledFrameworks : [primFw];
    const cage = (data.cageCode || '').trim().toUpperCase();

    // The server creates the tenant (and generates its id). The provisioning admin becomes its server-side owner;
    // the browser-only fields below mark it for first-run setup by the invited owner. The admin's active tenant is
    // left alone.
    const newTenant = await createTenantOnServer(
      {
        name: data.companyName.trim(),
        cageCode: isValidCageCode(cage) ? cage : undefined,
        systemName: (data.systemBoundaryName || '').trim() || undefined,
        systemOwner: data.tenantOwnerEmail.trim(),
        primaryFramework: primFw,
        enabledFrameworks: enFw,
      },
      { domain: emailDomain, isConfigured: false, activate: false }
    );
    const newTenantId = newTenant.id;

    // Initialize 100% blank assessment state in storage
    const blankState = createInitialState(newTenant);
    StorageService.saveAssessment(newTenantId, blankState);

    // The owner hand-over is a SERVER invitation: the token is hashed there, bound to the owner's email, single-use and
    // expiring. (The provisioning admin is already the server-side owner, so can issue it.)
    let issued: { invitation: ServerInvitation; token: string };
    try {
      issued = await ApiClient.createInvite(newTenantId, { email: data.tenantOwnerEmail.trim(), role: 'TENANT_OWNER' });
    } catch (err: unknown) {
      throw new ApiError(
        err instanceof ApiError ? err.status : 500,
        'The tenant was created, but the owner invitation could not be issued: ' + errorMessage(err) + ' Invite the owner from the tenant\'s Team settings.'
      );
    }
    inviteTokensRef.current[issued.invitation.id] = issued.token;
    const invitation = toTenantInvitation(issued.invitation, newTenant, issued.token);
    await refreshTeam(newTenantId, { asAdmin: true });

    return { tenant: newTenant, invitation, inviteUrl: buildInviteUrl(issued.token) };
  }, [createTenantOnServer, refreshTeam]);


  /**
   * Claim and bind an invitation token to an authenticated or new user
   */
  const claimInviteToken = useCallback(async (
    token: string,
    userCredentials: { id?: string; name: string; email: string; authProvider: AuthProviderType; idToken?: string }
  ): Promise<{ success: boolean; tenant?: Tenant; role?: TenantRole; error?: string }> => {
    // The server consumes the token and adds the signed-in user to the tenant.
    const bearer = userCredentials.idToken ?? (await waitForSessionToken());
    if (!bearer) return { success: false, error: 'Please sign in first, then open the invitation link again.' };
    try {
      const accepted = await ApiClient.acceptInvite(token, bearer);
      const synced = await syncTenantsFromServer(bearer, { force: true });
      const tenant = synced?.find(t => t.id === accepted.tenantId);
      setLiveActiveTenantId(accepted.tenantId);
      return { success: true, tenant, role: accepted.role };
    } catch (err: unknown) {
      return { success: false, error: errorMessage(err) || 'Could not accept the invitation.' };
    }
  }, [syncTenantsFromServer]);

  /**
   * Invite an assessor or viewer staff member to the specified tenant enclave
   */
  const inviteStaffMember = useCallback(async (
    tenantId: string,
    email: string,
    role: 'ASSESSOR' | 'VIEWER'
  ): Promise<{ invitation: TenantInvitation; inviteUrl: string }> => {
    // Invitations are issued and verified by the server. A browser-only tenant must be moved to the server first.
    const target = liveTenantsRef.current.find(t => t.id === tenantId);
    if (!target?.serverBacked) {
      throw new ApiError(409, 'Move this tenant to the server before inviting people: invitations are issued and verified by the server.');
    }
    const issued = await ApiClient.createInvite(tenantId, { email: email.trim(), role });
    inviteTokensRef.current[issued.invitation.id] = issued.token;
    await refreshTeam(tenantId, { asAdmin: true });
    return { invitation: toTenantInvitation(issued.invitation, target, issued.token), inviteUrl: buildInviteUrl(issued.token) };
  }, [refreshTeam]);

  /**
   * Revoke an active or pending invitation
   */
  const revokeInvitation = useCallback(async (invitationId: string): Promise<void> => {
    const serverInvite = invitations.find(i => i.id === invitationId && i.serverBacked);
    if (serverInvite) {
      await ApiClient.revokeInvite(serverInvite.tenantId, invitationId);
      delete inviteTokensRef.current[invitationId];
      await refreshTeam(serverInvite.tenantId);
      return;
    }

    throw new ApiError(404, 'That invitation no longer exists. Refresh the team list and try again.');
  }, [invitations, refreshTeam]);

  /**
   * Resend / refresh invitation with extended expiration
   */
  const resendInvitation = useCallback(async (invitationId: string): Promise<{ inviteUrl: string }> => {
    // Server invitations: issue a NEW token (the old link stops working) and restart the expiry clock
    const serverInvite = invitations.find(i => i.id === invitationId && i.serverBacked);
    if (serverInvite) {
      const reissued = await ApiClient.resendInvite(serverInvite.tenantId, invitationId);
      inviteTokensRef.current[invitationId] = reissued.token;
      await refreshTeam(serverInvite.tenantId);
      return { inviteUrl: buildInviteUrl(reissued.token) };
    }

    throw new ApiError(404, 'That invitation no longer exists. Refresh the team list and try again.');
  }, [invitations, refreshTeam]);

  /**
   * Extend invitation expiration by specified number of days (default 7 days)
   */
  const extendInvitationExpiration = useCallback(async (invitationId: string, days: number = 7): Promise<{ expiresAt: string }> => {
    const serverInvite = invitations.find(i => i.id === invitationId && i.serverBacked);
    if (serverInvite) {
      const extended = await ApiClient.extendInvite(serverInvite.tenantId, invitationId, days);
      await refreshTeam(serverInvite.tenantId);
      return { expiresAt: extended.expiresAt };
    }

    throw new ApiError(404, 'That invitation no longer exists. Refresh the team list and try again.');
  }, [invitations, refreshTeam]);

  /**
   * Update details of an existing pending or active invitation
   */
  const updateInvitation = useCallback(async (invitationId: string, updates: Partial<TenantInvitation>): Promise<void> => {
    const serverInvite = invitations.find(i => i.id === invitationId && i.serverBacked);
    if (serverInvite) {
      if (updates.tenantId && updates.tenantId !== serverInvite.tenantId) {
        throw new ApiError(400, 'An invitation cannot be moved to another tenant. Revoke it and issue a new one there.');
      }
      await ApiClient.updateInvite(serverInvite.tenantId, invitationId, { email: updates.email, role: updates.role });
      await refreshTeam(serverInvite.tenantId);
      return;
    }

    throw new ApiError(404, 'That invitation no longer exists. Refresh the team list and try again.');
  }, [invitations, refreshTeam]);

  /**
   * Update role for an active team member
   */
  const updateMemberRole = useCallback(async (tenantId: string, memberId: string, newRole: TenantRole): Promise<void> => {
    const tenant = liveTenantsRef.current.find(t => t.id === tenantId);
    if (tenant?.serverBacked) {
      const member = teamMembers[tenantId]?.find(m => m.id === memberId);
      if (!member?.userId) throw new ApiError(400, 'This member\'s role cannot be changed.');
      await ApiClient.setMemberRole(tenantId, { userId: member.userId, email: member.email, name: member.name, role: newRole });
      await refreshTeam(tenantId);
      return;
    }

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
  }, [refreshTeam, teamMembers, currentUser.email]);

  /**
   * Remove a member from the organization
   */
  const removeMember = useCallback(async (tenantId: string, memberId: string): Promise<void> => {
    const tenant = liveTenantsRef.current.find(t => t.id === tenantId);
    if (tenant?.serverBacked) {
      const member = teamMembers[tenantId]?.find(m => m.id === memberId);
      if (member?.invitationId) {
        // A pending row is an invitation: removing it revokes it
        await ApiClient.revokeInvite(tenantId, member.invitationId);
        delete inviteTokensRef.current[member.invitationId];
      } else if (member?.userId) {
        await ApiClient.removeMember(tenantId, member.userId);
      } else {
        throw new ApiError(400, 'This member cannot be removed.');
      }
      await refreshTeam(tenantId);
      return;
    }

    setTeamMembers(prev => {
      const list = prev[tenantId] || [];
      return {
        ...prev,
        [tenantId]: list.filter(m => m.id !== memberId),
      };
    });
  }, [refreshTeam, teamMembers]);

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

  const previewInvitation = useCallback((token: string): Promise<InvitePreview | null> => ApiClient.previewInvite(token), []);

  const value = useMemo(() => ({
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isMspUser,
    isSuperAdmin,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
    isStackSurveyModalOpen,
    setIsStackSurveyModalOpen,
    updateStackProfile,
    invitations,
    teamMembers,
    switchTenant,
    createTenant,
    provisionTenant,
    claimInviteToken,
    inviteStaffMember,
    revokeInvitation,
    resendInvitation,
    extendInvitationExpiration,
    updateInvitation,
    updateMemberRole,
    removeMember,
    getTenantMembers,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    suspendTenant,
    updateTenantOwner,
    updateTenantFrameworkScope,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resetForSignOut,
    resolveTenantForEmail,
    liveControls,
    liveScopeKey,
    liveEvidence,
    liveObjectives,
    programs,
    activeProgram,
    programsStatus,
    switchProgram,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    unarchiveProgram,
    deleteProgram,
    canManagePrograms,
    isSyncing,
    syncError,
    tenantSync,
    syncTenantsFromServer,
    refreshTeam,
    refreshAllTeams,
    teamError,
    previewInvitation,
    migrateLocalTenantToServer,
    refreshLiveData,
    updateLiveControl,
    updateLiveObjective,
    updateLiveObjectivesBulk,
    importLiveObjectives,
    createLiveEvidenceUploadUrl,
    deleteLiveEvidence,
    activeFramework,
    setActiveFramework,
    activeBaselineTier,
    activeOverlayFilters,
    setActiveOverlayFilters,
    toggleNonNetworkedOverlay,
    toggleOverlayFilter,
    ciaTriad,
    setCiaImpact,
    toggleAllControlsApplied,
  }), [
    tenants,
    currentTenant,
    currentUser,
    currentRole,
    canEdit,
    canManageTenant,
    isMspUser,
    isSuperAdmin,
    needsOnboarding,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
    isStackSurveyModalOpen,
    setIsStackSurveyModalOpen,
    updateStackProfile,
    invitations,
    teamMembers,
    switchTenant,
    createTenant,
    provisionTenant,
    claimInviteToken,
    inviteStaffMember,
    revokeInvitation,
    resendInvitation,
    extendInvitationExpiration,
    updateInvitation,
    updateMemberRole,
    removeMember,
    getTenantMembers,
    initializeBlankTenant,
    completeTenantOnboarding,
    updateTenant,
    suspendTenant,
    updateTenantOwner,
    updateTenantFrameworkScope,
    deleteTenant,
    switchUserRole,
    switchUser,
    syncAuthUser,
    resetForSignOut,
    resolveTenantForEmail,
    liveControls,
    liveScopeKey,
    liveEvidence,
    liveObjectives,
    programs,
    activeProgram,
    programsStatus,
    switchProgram,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    unarchiveProgram,
    deleteProgram,
    canManagePrograms,
    isSyncing,
    syncError,
    tenantSync,
    syncTenantsFromServer,
    refreshTeam,
    refreshAllTeams,
    teamError,
    previewInvitation,
    migrateLocalTenantToServer,
    refreshLiveData,
    updateLiveControl,
    updateLiveObjective,
    updateLiveObjectivesBulk,
    importLiveObjectives,
    createLiveEvidenceUploadUrl,
    deleteLiveEvidence,
    activeFramework,
    setActiveFramework,
    activeBaselineTier,
    activeOverlayFilters,
    setActiveOverlayFilters,
    toggleNonNetworkedOverlay,
    toggleOverlayFilter,
    ciaTriad,
    setCiaImpact,
    toggleAllControlsApplied,
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
