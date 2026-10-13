import { ControlState, EvidenceItem } from '../types/cmmc';
import { ComplianceFramework, BaselineTier, OverlayParameter, ControlMapping, FrameworkSummary } from '../types/framework';

const AUTH_TOKEN_KEY = 'pbc_session_id_token_v2';
const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || (typeof process !== 'undefined' && process.env?.VITE_API_URL) || '';

export interface UploadUrlResponse {
  message: string;
  uploadUrl: string;
  gcsPath: string;
  evidenceId: string;
  evidence: EvidenceItem;
}

import { ServerTenant, parseServerTenants } from '../data/tenantSync';
import {
  ServerInvitation,
  ServerMember,
  parseServerInvitation,
  parseServerInvitations,
  parseServerMembers,
} from '../data/teamSync';
import type { TenantRole } from '../types/tenant';
import type { SspAnalysisMode, SspCapabilities, SspCommitOutcome, SspImportFramework, SspImportJob, SspReviewState, StagedControl, StagedControlView } from '../types/sspImport';
import type { AccretionDiscoveryItem, EnclaveAsset } from '../types/telemetry';
import { AssetInput, AssetScopeSummary, parseServerAssets, summarizeScope } from '../data/telemetry/assetScope';

function requireAsset(raw: unknown): EnclaveAsset {
  const [asset] = parseServerAssets([raw]);
  if (!asset) throw new ApiError(502, 'The server sent back an asset this version of the app does not understand.');
  return asset;
}

/**
 * A failed API call with an HTTP status and a message that is safe to show to the user.
 * status 0 means the server could not be reached at all.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Turns a failed response into an ApiError with a clear message for the common cases (401 / 403 / 400 / 5xx). */
function apiErrorFromResponse(status: number, body: unknown): ApiError {
  const serverMessage = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  if (status === 401) return new ApiError(401, 'Your session has expired or is not valid. Please sign in again.');
  if (status === 403) return new ApiError(403, serverMessage || 'You do not have permission to do that.');
  if (status === 400 || status === 404 || status === 409 || status === 410) return new ApiError(status, serverMessage || 'The request was not accepted.');
  if (status === 429) return new ApiError(429, 'Too many requests. Please wait a moment and try again.');
  return new ApiError(status, 'The server could not complete the request. Please try again.');
}

/** fetch() wrapper: network failures become ApiError(0) so the UI can say "cannot reach the server". */
async function apiFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
}

/** Settings accepted when creating or updating a tenant (the license tier is never client-controlled). */
export interface TenantSettingsInput {
  name?: string;
  cageCode?: string;
  samStatus?: string;
  systemName?: string;
  systemOwner?: string;
  industry?: string;
  primaryFramework?: string;
  enabledFrameworks?: string[];
}

/** What the accept page shows before the invitee signs in. */
export interface InvitePreview {
  tenantId: string;
  tenantName: string;
  email: string;
  role: TenantRole;
  expiresAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  createdBy: string;
  /** The tenant's assessment program as the server holds it. */
  primaryFramework: string;
  enabledFrameworks: string[];
}

/** Authenticated JSON request that throws ApiError (with a user-safe message) on any failure. */
async function authedJson<T>(
  method: string,
  path: string,
  options: { token?: string | null; tenantId?: string; body?: unknown } = {}
): Promise<T> {
  const bearer = options.token ?? ApiClient.getToken();
  if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.tenantId) headers['x-tenant-id'] = options.tenantId;
  const res = await apiFetch(`${API_BASE_URL}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiErrorFromResponse(res.status, data);
  return data as T;
}

export type AuthMode = 'firebase' | 'local';

export interface LocalLoginResponse {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string;
  expiresIn: number;
  user: { id: string; email: string; name: string };
}

export interface SetupStatus {
  setupRequired: boolean;
  tokenRequired: boolean;
}

export interface SetupInput {
  companyName: string;
  adminName?: string;
  email: string;
  password: string;
  invites?: string[];
  inviteRole?: TenantRole;
  setupToken?: string;
}

export interface SetupResult extends LocalLoginResponse {
  tenant: { id: string; name: string };
  invites: Array<{ email: string; role: TenantRole; token?: string; expiresAt?: string; error?: string }>;
}

export const ApiClient = {
  /**
   * GET /api/v1/auth/config
   * Which identity provider the server uses. Returns null if the server cannot be reached.
   */
  async getAuthMode(): Promise<AuthMode | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/config`);
      if (!res.ok) return null;
      const data = (await res.json()) as { mode?: string };
      return data.mode === 'local' ? 'local' : 'firebase';
    } catch {
      return null;
    }
  },

  /**
   * GET /api/v1/setup/status
   * Does this installation still need its first administrator? Resolves null when the server cannot be reached, which
   * callers treat as "no": an unreachable server must never send people to the setup wizard.
   */
  async getSetupStatus(): Promise<SetupStatus | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/setup/status`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = (await res.json()) as { setupRequired?: unknown; tokenRequired?: unknown };
      return { setupRequired: data.setupRequired === true, tokenRequired: data.tokenRequired === true };
    } catch {
      return null;
    }
  },

  /** POST /api/v1/setup: the first-time setup wizard. Throws ApiError (409 once setup has been completed). */
  async runSetup(input: SetupInput): Promise<SetupResult> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return data as SetupResult;
  },

  // ---------------------------------------------------------------- SSP import

  /** GET /api/v1/tenants/:id/ssp-imports/capabilities */
  async sspCapabilities(tenantId: string): Promise<SspCapabilities> {
    return authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/capabilities`, { tenantId });
  },

  /** GET /api/v1/tenants/:id/ssp-imports */
  async sspListJobs(tenantId: string): Promise<SspImportJob[]> {
    const data = await authedJson<{ jobs?: SspImportJob[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports`, { tenantId });
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },

  /** POST /api/v1/tenants/:id/ssp-imports (multipart). Owner / MSP admin only. */
  async sspUpload(tenantId: string, file: File, framework: SspImportFramework, analysis: SspAnalysisMode = 'rules'): Promise<SspImportJob> {
    const bearer = ApiClient.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
    const form = new FormData();
    form.append('framework', framework);
    form.append('analysis', analysis);
    form.append('file', file, file.name);
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}/ssp-imports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'x-tenant-id': tenantId }, // no Content-Type: the browser sets the multipart boundary
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return (data as { job: SspImportJob }).job;
  },

  /** GET /api/v1/tenants/:id/ssp-imports/:jobId/staged: the suggestions next to the controls' current answers. */
  async sspGetStaged(tenantId: string, jobId: string): Promise<{ job: SspImportJob; staged: StagedControlView[] }> {
    return authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/staged`, { tenantId });
  },

  /** GET /api/v1/tenants/:id/ssp-imports/:jobId */
  async sspGetJob(tenantId: string, jobId: string): Promise<SspImportJob> {
    const data = await authedJson<{ job: SspImportJob }>('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}`, { tenantId });
    return data.job;
  },

  /** PATCH .../staged/:id: records a review decision. Nothing is written to the controls until the commit. */
  async sspReview(tenantId: string, jobId: string, stagedId: string, decision: { reviewState: SspReviewState; editedNotes?: string }): Promise<StagedControl> {
    const data = await authedJson<{ staged: StagedControl }>(
      'PATCH',
      `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/staged/${encodeURIComponent(stagedId)}`,
      { tenantId, body: decision }
    );
    return data.staged;
  },

  /** POST .../commit: applies the accepted and edited suggestions to the controls. */
  async sspCommit(tenantId: string, jobId: string): Promise<SspCommitOutcome> {
    return authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/commit`, { tenantId, body: {} });
  },

  /** POST .../:jobId/cancel: stops an import that has not finished. */
  async sspCancel(tenantId: string, jobId: string): Promise<void> {
    await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/cancel`, { tenantId, body: {} });
  },

  /** DELETE .../:jobId */
  async sspDelete(tenantId: string, jobId: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}`, { tenantId });
  },

  /** The uploaded document, as a blob URL the caller must revoke. */
  async sspDownloadUrl(tenantId: string, jobId: string): Promise<string> {
    const bearer = ApiClient.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/file`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}`, 'x-tenant-id': tenantId },
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
    return URL.createObjectURL(await res.blob());
  },

  // ---------------------------------------------------------------- team: members and invitations

  /** GET /api/v1/tenants/:id/members */
  async listMembers(tenantId: string, token?: string): Promise<ServerMember[]> {
    return parseServerMembers(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/members`, { token, tenantId }));
  },

  /** POST /api/v1/tenants/:id/members: sets (or changes) an existing person's role. Owner / MSP admin only. */
  async setMemberRole(tenantId: string, member: { userId: string; email: string; name?: string; role: TenantRole }, token?: string): Promise<void> {
    await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/members`, { token, tenantId, body: member });
  },

  /** DELETE /api/v1/tenants/:id/members/:userId */
  async removeMember(tenantId: string, userId: string, token?: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`, { token, tenantId });
  },

  // ----------------------------------------------------------------------------------------- CMMC asset scoping

  /** GET /api/v1/tenants/:id/assets: the enclave's assets and the scope summary (any member). */
  async listAssets(tenantId: string, token?: string): Promise<{ assets: EnclaveAsset[]; summary: AssetScopeSummary }> {
    const data = await authedJson<{ assets?: unknown; summary?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/assets`, { token, tenantId });
    const assets = parseServerAssets(data?.assets);
    return { assets, summary: summarizeScope(assets) };
  },

  /** POST /api/v1/tenants/:id/assets (owner / MSP admin). */
  async createAsset(tenantId: string, asset: AssetInput, token?: string): Promise<EnclaveAsset> {
    const data = await authedJson<{ asset?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/assets`, { token, tenantId, body: asset });
    return requireAsset(data?.asset);
  },

  /** PUT /api/v1/tenants/:id/assets/:assetId. Only the fields given change. */
  async updateAsset(tenantId: string, assetId: string, patch: AssetInput, token?: string): Promise<EnclaveAsset> {
    const data = await authedJson<{ asset?: unknown }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}`, { token, tenantId, body: patch });
    return requireAsset(data?.asset);
  },

  /** DELETE /api/v1/tenants/:id/assets/:assetId. */
  async deleteAsset(tenantId: string, assetId: string, token?: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}`, { token, tenantId });
  },

  /** POST /api/v1/tenants/:id/assets/bulk: up to 500 at a time; rows whose name already exists come back in `skipped`. */
  async createAssetsBulk(
    tenantId: string,
    assets: AssetInput[],
    token?: string
  ): Promise<{ created: EnclaveAsset[]; skipped: Array<{ index: number; hostName: string; reason: string }> }> {
    const data = await authedJson<{ created?: unknown; skipped?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/assets/bulk`, { token, tenantId, body: { assets } });
    return {
      created: parseServerAssets(data?.created),
      skipped: Array.isArray(data?.skipped) ? (data.skipped as Array<{ index: number; hostName: string; reason: string }>) : [],
    };
  },

  /** POST /api/v1/tenants/:id/assets/discovery: network-sensor findings, deduplicated by MAC / IP on the server. */
  async ingestDiscovery(
    tenantId: string,
    items: AccretionDiscoveryItem[],
    token?: string
  ): Promise<{ totalProcessed: number; newDiscoveredCount: number; updatedExistingCount: number; created: EnclaveAsset[] }> {
    const data = await authedJson<{ totalProcessed?: number; newDiscoveredCount?: number; updatedExistingCount?: number; created?: unknown }>(
      'POST',
      `/tenants/${encodeURIComponent(tenantId)}/assets/discovery`,
      { token, tenantId, body: { items } }
    );
    return {
      totalProcessed: Number(data?.totalProcessed ?? items.length),
      newDiscoveredCount: Number(data?.newDiscoveredCount ?? 0),
      updatedExistingCount: Number(data?.updatedExistingCount ?? 0),
      created: parseServerAssets(data?.created),
    };
  },

  /** GET /api/v1/tenants/:id/invites (owner / MSP admin). Never includes tokens. */
  async listInvites(tenantId: string, token?: string): Promise<ServerInvitation[]> {
    return parseServerInvitations(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/invites`, { token, tenantId }));
  },

  /** POST /api/v1/tenants/:id/invites. The returned `token` is shown ONCE: the server keeps only its hash. */
  async createInvite(
    tenantId: string,
    input: { email: string; role: TenantRole; expiresInDays?: number },
    token?: string
  ): Promise<{ invitation: ServerInvitation; token: string }> {
    return this.invitationWithToken(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites`, { token, tenantId, body: input }));
  },

  /** POST .../invites/:id/resend: a NEW token (the old link stops working) and a fresh expiry. */
  async resendInvite(tenantId: string, invitationId: string, expiresInDays?: number, token?: string): Promise<{ invitation: ServerInvitation; token: string }> {
    return this.invitationWithToken(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}/resend`, { token, tenantId, body: expiresInDays ? { expiresInDays } : {} }));
  },

  /** POST .../invites/:id/extend: pushes the expiry out; the link stays the same. */
  async extendInvite(tenantId: string, invitationId: string, days: number, token?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}/extend`, { token, tenantId, body: { days } }));
  },

  /** PATCH .../invites/:id: edits the email or role of an unused invitation. */
  async updateInvite(tenantId: string, invitationId: string, patch: { email?: string; role?: TenantRole }, token?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('PATCH', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}`, { token, tenantId, body: patch }));
  },

  /** DELETE .../invites/:id: revokes. */
  async revokeInvite(tenantId: string, invitationId: string, token?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}`, { token, tenantId }));
  },

  singleInvitation(data: unknown): ServerInvitation {
    const invitation = parseServerInvitation((data as { invitation?: unknown } | null)?.invitation);
    if (!invitation) throw new ApiError(502, 'The server returned an unexpected response.');
    return invitation;
  },

  invitationWithToken(data: unknown): { invitation: ServerInvitation; token: string } {
    const token = (data as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !token) throw new ApiError(502, 'The server returned an unexpected response.');
    return { invitation: this.singleInvitation(data), token };
  },

  /**
   * POST /api/v1/invites/preview (public). Resolves null for an unknown or malformed token; other failures throw.
   * The token goes in the body, never the URL.
   */
  async previewInvite(inviteToken: string): Promise<InvitePreview | null> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/invites/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
    });
    if (res.status === 404) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return ((data as { invitation?: InvitePreview } | null)?.invitation) ?? null;
  },

  /** POST /api/v1/invites/accept: consumes the token for the signed-in user. Throws ApiError with the reason. */
  async acceptInvite(inviteToken: string, token?: string): Promise<{ tenantId: string; role: TenantRole; previousRole: TenantRole | null }> {
    return authedJson('POST', '/invites/accept', { token, body: { token: inviteToken } });
  },

  /**
   * POST /api/v1/auth/register-with-invite (air-gapped installs). Creates the account for the INVITED email, consumes
   * the invitation and signs the person in. 409 `account_exists` means: sign in instead.
   */
  async registerWithInvite(input: { token: string; password: string; name?: string }): Promise<LocalLoginResponse & { tenantId: string; role: TenantRole }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/auth/register-with-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = apiErrorFromResponse(res.status, data);
      throw Object.assign(err, { reason: (data as { reason?: string } | null)?.reason });
    }
    return data as LocalLoginResponse & { tenantId: string; role: TenantRole };
  },

  /**
   * GET /api/v1/tenants
   * The tenants the signed-in user belongs to, each with the user's role. Resolves null when the session is not
   * accepted (401), so callers can treat "not signed in" differently from a real failure (which throws).
   */
  async listMyTenants(token?: string): Promise<ServerTenant[] | null> {
    const bearer = token ?? this.getToken();
    if (!bearer) return null;
    const res = await fetch(`${API_BASE_URL}/api/v1/tenants`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`Failed to load your tenants (HTTP ${res.status})`);
    return parseServerTenants(await res.json());
  },

  /**
   * GET /api/v1/me: whether the signed-in user is a platform administrator of THIS installation (decided by the server's
   * PLATFORM_ADMIN_EMAILS list). Resolves null when it cannot be determined, so the UI never assumes administrator rights.
   */
  async getPlatformStatus(token?: string): Promise<{ isPlatformAdmin: boolean } | null> {
    const bearer = token ?? this.getToken();
    if (!bearer) return null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: { Authorization: `Bearer ${bearer}` } });
      if (!res.ok) return null;
      const data = (await res.json()) as { isPlatformAdmin?: unknown };
      return { isPlatformAdmin: data.isPlatformAdmin === true };
    } catch {
      return null;
    }
  },

  /** GET /api/v1/platform/admins (platform administrators only): the addresses configured on the server. Null if refused. */
  async listPlatformAdmins(token?: string): Promise<string[] | null> {
    const bearer = token ?? this.getToken();
    if (!bearer) return null;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/platform/admins`, { headers: { Authorization: `Bearer ${bearer}` } });
      if (!res.ok) return null;
      const data = (await res.json()) as { admins?: Array<{ email?: unknown }> };
      return (data.admins ?? []).map((a) => String(a.email ?? '')).filter(Boolean);
    } catch {
      return null;
    }
  },

  /**
   * POST /api/v1/tenants
   * Creates a tenant; the caller becomes its first TENANT_OWNER. Throws ApiError (401 / 403 / 400 / 5xx / 0).
   */
  async createTenant(
    input: TenantSettingsInput & { name: string },
    token?: string
  ): Promise<{ tenant: { id: string; name: string } & Record<string, unknown>; role: string }> {
    const bearer = token ?? this.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to create a tenant.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return data as { tenant: { id: string; name: string } & Record<string, unknown>; role: string };
  },

  /**
   * PATCH /api/v1/tenants/:tenantId
   * Updates tenant settings. Owner / MSP admin only. Throws ApiError.
   */
  async updateTenant(tenantId: string, patch: TenantSettingsInput, token?: string): Promise<void> {
    const bearer = token ?? this.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to change tenant settings.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'x-tenant-id': tenantId },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
  },

  /**
   * POST /api/v1/auth/login  (air-gapped installs, AUTH_MODE=local)
   * Throws an Error carrying the server's message (e.g. invalid credentials, account locked).
   */
  async localLogin(email: string, password: string): Promise<LocalLoginResponse> {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `Sign-in failed (HTTP ${res.status})`);
    }
    return data as LocalLoginResponse;
  },

  /**
   * Retrieve active Firebase ID Token from localStorage
   */
  getToken(): string | null {
    try {
      return localStorage.getItem(AUTH_TOKEN_KEY);
    } catch {
      return null;
    }
  },

  /**
   * Constructs authorization and tenant context headers
   */
  getHeaders(tenantId: string, extraHeaders?: HeadersInit): HeadersInit {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return {
      ...headers,
      ...(extraHeaders as Record<string, string>),
    };
  },

  /**
   * Verify API backend health
   */
  async checkHealth(): Promise<{ status: string; database?: string } | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/health`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * GET /api/v1/controls
   * Fetches controls for the active tenant dynamically based on framework, baseline, and overlay
   */
  async getControls(
    tenantId: string,
    options?: {
      framework?: ComplianceFramework;
      baseline?: BaselineTier;
      overlay?: OverlayParameter;
    }
  ): Promise<ControlState[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error('Not authenticated: ID token not found');
    }

    const query = new URLSearchParams();
    if (options?.framework) query.set('framework_id', options.framework);
    if (options?.baseline) query.set('baseline', options.baseline);
    if (options?.overlay && options.overlay !== 'NONE') query.set('overlay', options.overlay);

    const queryString = query.toString() ? `?${query.toString()}` : '';
    const res = await fetch(`${API_BASE_URL}/api/v1/controls${queryString}`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch controls: ${res.status}`);
    }

    const data = await res.json();
    return data.controls || [];
  },

  /**
   * GET /api/v1/controls/frameworks
   * Fetches all supported compliance framework metadata
   */
  async getFrameworks(): Promise<FrameworkSummary[]> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/controls/frameworks`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.frameworks || [];
    } catch {
      return [];
    }
  },

  /**
   * GET /api/v1/controls/mappings
   * Fetches cross-framework control mappings
   */
  async getControlMappings(controlId?: string): Promise<ControlMapping[]> {
    try {
      const url = controlId
        ? `${API_BASE_URL}/api/v1/controls/mappings?control_id=${encodeURIComponent(controlId)}`
        : `${API_BASE_URL}/api/v1/controls/mappings`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return data.mappings || [];
    } catch {
      return [];
    }
  },

  /**
   * PUT /api/v1/controls/:controlId
   * Updates control implementation statement, status, role, and last updated time
   */
  async updateControl(
    tenantId: string,
    controlId: string,
    updates: Partial<ControlState>
  ): Promise<ControlState> {
    const res = await fetch(`${API_BASE_URL}/api/v1/controls/${encodeURIComponent(controlId)}`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify({
        status: updates.status,
        implementationNotes: updates.implementationNotes,
        responsibleRole: updates.responsibleRole,
        updatedBy: updates.updatedBy,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to update control: ${res.status}`);
    }

    const data = await res.json();
    return data.control;
  },

  /**
   * GET /api/v1/evidence
   * Retrieves all evidence artifacts for the active tenant
   */
  async getEvidence(tenantId: string): Promise<EvidenceItem[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error('Not authenticated: ID token not found');
    }

    const res = await fetch(`${API_BASE_URL}/api/v1/evidence`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch evidence: ${res.status}`);
    }

    const data = await res.json();
    return data.evidence || [];
  },

  /**
   * GET /api/v1/evidence/config/storage-info
   * Reports the server's active evidence storage provider (local disk or GCS).
   */
  async getStorageInfo(
    tenantId: string
  ): Promise<{ provider: string; localStoragePath: string; isAirGapped: boolean } | null> {
    const res = await fetch(`${API_BASE_URL}/api/v1/evidence/config/storage-info`, {
      method: 'GET',
      headers: this.getHeaders(tenantId),
    });
    if (!res.ok) return null;
    return await res.json();
  },

  /**
   * POST /api/v1/evidence/upload-url
   * Requests a GCS Signed URL and registers evidence metadata in Cloud SQL
   */
  async requestUploadUrl(
    tenantId: string,
    payload: {
      controlId: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileHash: string; // SHA-256
      description?: string;
    }
  ): Promise<UploadUrlResponse> {
    const res = await fetch(`${API_BASE_URL}/api/v1/evidence/upload-url`, {
      method: 'POST',
      headers: this.getHeaders(tenantId),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to generate upload URL: ${res.status}`);
    }

    return await res.json();
  },

  /**
   * Uploads binary file directly to Local Enclave Storage or GCS via Signed URL
   */
  async uploadFileToGcs(signedUrl: string, file: File | Blob, mimeType: string, tenantId?: string): Promise<void> {
    const isServerRelative = signedUrl.startsWith('/');
    const targetUrl = isServerRelative && API_BASE_URL ? `${API_BASE_URL}${signedUrl}` : signedUrl;
    const headers: Record<string, string> = {
      'Content-Type': mimeType || 'application/octet-stream',
    };
    // Only our own API receives credentials; a GCS signed URL carries its own signature.
    if (isServerRelative) {
      if (tenantId) {
        headers['x-tenant-id'] = tenantId;
      }
      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const res = await fetch(targetUrl, {
      method: 'PUT',
      headers,
      body: file,
    });

    if (!res.ok) {
      throw new Error(`Evidence upload failed with status ${res.status}: ${res.statusText}`);
    }
  },
};
