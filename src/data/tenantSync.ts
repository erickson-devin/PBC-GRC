import type { ComplianceFramework } from '../types/framework';
import type { EnclaveStackProfile, SamStatus, Tenant, TenantRole } from '../types/tenant';
import { validateStackProfile } from './stackProfileSchema';
import { isTenantRole } from '../utils/roles';

/**
 * Pure logic for synchronising the browser's tenant list with GET /api/v1/tenants. The server is the source of
 * truth for WHICH tenants a user belongs to and WHAT they may do in each; the browser only caches it.
 * Kept free of React so it can be unit tested.
 */

/** One entry of the GET /api/v1/tenants response. */
export interface ServerTenant {
  id: string;
  name: string;
  cageCode: string | null;
  samStatus: string;
  systemName: string;
  systemOwner: string;
  industry: string;
  enabledFrameworks: string[];
  primaryFramework: string;
  createdAt: string | null;
  role: TenantRole;
  /** The enclave stack survey the server holds (null: none yet, or one that failed validation). */
  stackProfile: EnclaveStackProfile | null;
  /** 'claim' entries come from the token only and carry no tenant details. */
  source: 'membership' | 'claim';
}

const FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];
const SAM_STATUSES: readonly SamStatus[] = ['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED'];

const isFramework = (v: unknown): v is ComplianceFramework => FRAMEWORKS.includes(v as ComplianceFramework);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** A stack profile that passes the server's own validation, else null: never trusted unchecked. */
const validProfile = (v: unknown): EnclaveStackProfile | null => {
  if (v === null || v === undefined) return null;
  const checked = validateStackProfile(v);
  return checked.ok ? checked.value : null;
};

/** Defensive parse of the HTTP response: anything malformed (or with an unknown role) is dropped, never trusted. */
export function parseServerTenants(raw: unknown): ServerTenant[] {
  const list = (raw as { tenants?: unknown } | null)?.tenants;
  if (!Array.isArray(list)) return [];
  const out: ServerTenant[] = [];
  for (const item of list) {
    const t = item as Record<string, unknown>;
    if (!t || typeof t.id !== 'string' || !t.id || !isTenantRole(t.role)) continue;
    out.push({
      id: t.id,
      name: str(t.name, t.id),
      cageCode: typeof t.cageCode === 'string' ? t.cageCode : null,
      samStatus: str(t.samStatus, 'ACTIVE'),
      systemName: str(t.systemName),
      systemOwner: str(t.systemOwner),
      industry: str(t.industry),
      enabledFrameworks: Array.isArray(t.enabledFrameworks) ? t.enabledFrameworks.filter((f): f is string => typeof f === 'string') : [],
      primaryFramework: str(t.primaryFramework, 'CMMC_L1'),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : null,
      role: t.role,
      stackProfile: validProfile(t.stackProfile),
      source: t.source === 'claim' ? 'claim' : 'membership',
    });
  }
  return out;
}

export interface TenantSyncResult {
  /** The new live tenant list. */
  tenants: Tenant[];
  /** Server-dictated roles to write onto the user, keyed by tenant id. */
  roleUpdates: Record<string, TenantRole>;
  /** Tenants that used to come from the server but no longer do (access revoked): drop them and their roles. */
  removedTenantIds: string[];
  /** Ids of every tenant the server lists, in server order. */
  serverTenantIds: string[];
}

/** Builds the UI's Tenant from a server record, layering server-owned fields over whatever is already cached. */
export function serverTenantToTenant(server: ServerTenant, existing: Tenant | undefined, nowIso: string): Tenant {
  const hasDetails = server.source === 'membership';
  const primary: ComplianceFramework = isFramework(server.primaryFramework) ? server.primaryFramework : existing?.primaryFramework ?? 'CMMC_L1';
  const frameworks = server.enabledFrameworks.filter(isFramework);
  const enabled = frameworks.length > 0 ? frameworks : existing?.enabledFrameworks ?? [primary];

  // Server-owned fields always win. For claim-only entries the server has no details, so keep whatever we cached.
  const authoritative = hasDetails
    ? {
        name: server.name || existing?.name || server.id,
        cageCode: server.cageCode ?? '',
        samStatus: (SAM_STATUSES.includes(server.samStatus as SamStatus) ? server.samStatus : 'ACTIVE') as SamStatus,
        systemName: server.systemName || existing?.systemName || '',
        systemOwner: server.systemOwner || existing?.systemOwner || '',
        industry: server.industry || existing?.industry || '',
        primaryFramework: primary,
        enabledFrameworks: enabled.includes(primary) ? enabled : [primary, ...enabled],
      }
    : {};

  return {
    // Fields the browser owns (stack survey, boundary text, domain, ...) survive; only server-owned fields are replaced.
    ...(existing ?? {
      id: server.id,
      name: server.name || server.id,
      cageCode: '',
      samStatus: 'ACTIVE' as SamStatus,
      systemName: '',
      systemOwner: '',
      industry: '',
      createdAt: server.createdAt ?? nowIso,
      updatedAt: nowIso,
      primaryFramework: primary,
      enabledFrameworks: enabled,
    }),
    ...authoritative,
    id: server.id,
    // The server's stack profile wins once it holds one; until then the browser's copy stays (and is uploaded once, planStackProfileUpload).
    ...(server.stackProfile ? { stackProfile: server.stackProfile } : {}),
    isConfigured: existing?.isConfigured ?? true, // a tenant that exists on the server must not trigger first-run onboarding
    serverBacked: true,
  };
}

/**
 * Merges the server's tenant list into the cached one.
 *  - Every server tenant is created/updated and marked `serverBacked`; its role is the SERVER's role.
 *  - Previously server-backed tenants the server no longer lists are removed (membership revoked, or another
 *    user signed in on this browser): their cached roles are dropped too.
 *  - Tenants that never came from the server (legacy, created only in this browser) are left alone, EXCEPT unfinished
 *    drafts: once the server lists real tenants, an unconfigured browser-only draft (the first-login placeholder, or a
 *    blank tenant from an older version) is dropped, because it would only be noise next to the user's real tenants.
 */
export function mergeServerTenants(
  localTenants: readonly Tenant[],
  serverTenants: readonly ServerTenant[],
  now: Date = new Date(),
  options: { placeholderIds?: readonly string[] } = {}
): TenantSyncResult {
  const nowIso = now.toISOString();
  const serverIds = new Set(serverTenants.map((s) => s.id));
  const localById = new Map(localTenants.map((t) => [t.id, t]));

  const placeholders = new Set(options.placeholderIds ?? []);
  const isUnfinishedDraft = (t: Tenant) => !t.serverBacked && (placeholders.has(t.id) || t.isConfigured === false);
  const removedTenantIds = localTenants
    .filter((t) => (t.serverBacked && !serverIds.has(t.id)) || (serverTenants.length > 0 && isUnfinishedDraft(t)))
    .map((t) => t.id);
  const kept = localTenants.filter((t) => !removedTenantIds.includes(t.id));

  const updated = new Map<string, Tenant>();
  for (const s of serverTenants) updated.set(s.id, serverTenantToTenant(s, localById.get(s.id), nowIso));

  const tenants: Tenant[] = [];
  const placed = new Set<string>();
  for (const t of kept) {
    tenants.push(updated.get(t.id) ?? t);
    placed.add(t.id);
  }
  for (const s of serverTenants) {
    if (!placed.has(s.id)) tenants.push(updated.get(s.id)!);
  }

  const roleUpdates: Record<string, TenantRole> = {};
  for (const s of serverTenants) roleUpdates[s.id] = s.role;

  return { tenants, roleUpdates, removedTenantIds, serverTenantIds: serverTenants.map((s) => s.id) };
}

/** Applies a sync result to a user's cached role map: server roles overwrite, revoked tenants are removed. */
export function applyRoleSync(roles: Record<string, TenantRole>, result: Pick<TenantSyncResult, 'roleUpdates' | 'removedTenantIds'>): Record<string, TenantRole> {
  const next: Record<string, TenantRole> = { ...roles, ...result.roleUpdates };
  for (const id of result.removedTenantIds) delete next[id];
  return next;
}

/**
 * Which tenant should be active after a sync: keep the current one if it still exists and is not the empty
 * placeholder; otherwise the first tenant the server lists; otherwise the first remaining tenant.
 */
export function pickActiveTenantId(
  currentActiveId: string,
  tenants: readonly Tenant[],
  serverTenantIds: readonly string[],
  placeholderIds: readonly string[] = []
): string {
  const stillThere = tenants.some((t) => t.id === currentActiveId);
  if (stillThere && !placeholderIds.includes(currentActiveId)) return currentActiveId;
  return serverTenantIds.find((id) => tenants.some((t) => t.id === id)) ?? tenants[0]?.id ?? currentActiveId;
}

/** The tenant settings the server accepts in PATCH /api/v1/tenants/:id (everything else stays in the browser). */
export interface ServerTenantPatch {
  name?: string;
  cageCode?: string;
  samStatus?: string;
  systemName?: string;
  systemOwner?: string;
  industry?: string;
  primaryFramework?: string;
  enabledFrameworks?: string[];
  stackProfile?: EnclaveStackProfile;
}

const CAGE_CODE = /^[A-Za-z0-9]{5}$/;

/** True for a CAGE code the server accepts (the UI uses the word "PENDING" as a placeholder, which it does not). */
export const isValidCageCode = (value: unknown): value is string => typeof value === 'string' && CAGE_CODE.test(value.trim());

/**
 * Picks the server-owned fields out of a local tenant edit and normalises them. Browser-only fields (domain,
 * boundary text, licence tier, ...) are never sent. Empty strings and placeholder CAGE codes are dropped
 * rather than overwriting good server values.
 */
export function toServerPatch(updates: Partial<Tenant>): ServerTenantPatch {
  const patch: ServerTenantPatch = {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  const name = text(updates.name);
  if (name && name.length >= 2) patch.name = name;
  if (isValidCageCode(updates.cageCode)) patch.cageCode = updates.cageCode.trim().toUpperCase();
  if (updates.samStatus && SAM_STATUSES.includes(updates.samStatus)) patch.samStatus = updates.samStatus;
  const systemName = text(updates.systemName);
  if (systemName) patch.systemName = systemName;
  const systemOwner = text(updates.systemOwner);
  if (systemOwner) patch.systemOwner = systemOwner;
  const industry = text(updates.industry);
  if (industry) patch.industry = industry;
  if (updates.primaryFramework && isFramework(updates.primaryFramework)) patch.primaryFramework = updates.primaryFramework;
  const frameworks = updates.enabledFrameworks?.filter(isFramework);
  if (frameworks && frameworks.length > 0) patch.enabledFrameworks = frameworks;
  const profile = validProfile(updates.stackProfile);
  if (profile) patch.stackProfile = profile;
  return patch;
}

/** The browser's stack profile to upload once: only when it is valid and the server holds none. Otherwise null. */
export function planStackProfileUpload(server: Pick<ServerTenant, 'stackProfile'>, cached: unknown): EnclaveStackProfile | null {
  if (server.stackProfile) return null;
  return validProfile(cached);
}

/** True for assessor-style email domains (audit / C3PAO / assessor firms). */
const isAssessorDomain = (emailDomain: string): boolean => {
  const d = emailDomain.toLowerCase();
  return d.includes('audit') || d.includes('c3pao') || d.includes('assessor');
};

/**
 * The role shown BEFORE the server has answered (sign-in, or a reload with a cached tenant list). Least privilege:
 * a tenant that exists on the server starts read-only until the sync writes the server's real role; only a draft
 * that lives in this browser (first-run onboarding) is the user's own, so they own it.
 */
export function provisionalRoleForTenant(tenant: Pick<Tenant, 'serverBacked'>, emailDomain: string): TenantRole {
  if (tenant.serverBacked) return 'VIEWER';
  return isAssessorDomain(emailDomain) ? 'ASSESSOR' : 'TENANT_OWNER';
}

/**
 * The server answers every request except the password change itself with 403 + reason 'password_change_required'
 * while an account carries a temporary password. That is "not yet", not a failure.
 */
export function isPasswordChangeRequired(status: number, body: unknown): boolean {
  return status === 403 && (body as { reason?: unknown } | null)?.reason === 'password_change_required';
}
