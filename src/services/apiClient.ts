import { ControlState, EvidenceItem } from '../types/cmmc';
import type { ObjectiveEvent, ObjectiveImportResult, ObjectiveInput, ObjectiveRecord } from '../types/controlObjectives';
import { ComplianceFramework, BaselineTier, OverlayParameter, ControlMapping, FrameworkSummary } from '../types/framework';

const SESSION_REF_KEY = 'pbc_session_ref_v3';
const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || (typeof process !== 'undefined' && process.env?.VITE_API_URL) || '';

export interface UploadUrlResponse {
  message: string;
  uploadUrl: string;
  gcsPath: string;
  evidenceId: string;
  evidence: EvidenceItem;
}

import { ServerTenant, isPasswordChangeRequired, parseServerTenants } from '../data/tenantSync';
import {
  ServerInvitation,
  ServerMember,
  parseServerInvitation,
  parseServerInvitations,
  parseServerMembers,
} from '../data/teamSync';
import type { TenantRole } from '../types/tenant';
import type { AiAssistStatus, WordingSuggestionRequest, WordingSuggestions } from '../types/aiAssist';
import type { SspAnalysisMode, SspCapabilities, SspBaseline, SspCommitOutcome, SspImportFramework, SspImportJob, SspReviewState, StagedControl, StagedControlView } from '../types/sspImport';
import type { AccretionDiscoveryItem, EnclaveAsset } from '../types/telemetry';
import type { Program, ProgramInput, ProgramMetrics, ProgramUpdate } from '../types/program';
import { parseProgramList, parseProgramMetrics, parseProgramResponse, programCreateBody, validateProgramInput } from '../data/programSync';
import { parseAssetMemberships, parseProgramAssets } from '../data/programAssets';
import type { ProgramAssets } from '../data/programAssets';
import { AssetInput, AssetScopeSummary, parseServerAssets, summarizeScope } from '../data/telemetry/assetScope';
import { SESSION_MARKER_HEADER, sessionRefFromHeaders, isSessionRejection, reportResponseStatus } from './sessionSignal';

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
  /** The server's machine-readable `reason` (e.g. 'invalid_code', 'password_change_required'), when it sent one. */
  reason?: string;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const bodyReason = (body: unknown): string | undefined => {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && reason ? reason : undefined;
};

/**
 * A plain-language message for a failed sign-in step, password change or account-administration call, chosen by the server's
 * `reason` code first and the HTTP status second. A wrong code is never reported as an expired session.
 */
export function mfaErrorMessage(status: number, body: unknown): string {
  const serverMessage = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  switch (bodyReason(body)) {
    case 'invalid_code':
      return 'That code is not correct. Check the current code in your authenticator app (or use a recovery code) and try again.';
    case 'mfa_token_invalid':
      return 'This sign-in step has timed out or is no longer valid. Sign in again.';
    case 'password_change_required':
      return 'You must change your password before you can continue.';
    case 'mfa_unavailable':
      return 'Your second factor cannot be read right now. Contact your administrator.';
    case 'code_required':
      return 'Enter the 6-digit code from your authenticator app.';
    case 'invalid_current_password':
      return 'The current password is not correct.';
    case 'weak_password':
      return serverMessage || 'The new password does not meet the requirements.';
    case 'mfa_already_enrolled':
      return 'A second factor is already set up for this account.';
    case 'mfa_not_started':
      return 'Start the setup again to get a new secret.';
    case 'mfa_not_enrolled':
      return 'Set up two-step verification on your own account first (account settings), then try again.';
    case 'self':
      return 'You cannot do that to your own account here.';
    default:
      break;
  }
  if (status === 429) return 'Too many attempts, or the account is temporarily locked. Wait a few minutes and try again.';
  if (status === 401) return serverMessage || 'Your session has expired or is not valid. Please sign in again.';
  if (status === 503) return 'Sign-in is not available right now. Contact your administrator.';
  return serverMessage || (status >= 500 ? 'The server could not complete the request. Please try again.' : 'The request was not accepted.');
}

/** Turns a failed response into an ApiError carrying the server's `reason` (when it sent one). */
function apiErrorFromResponse(status: number, body: unknown): ApiError {
  const err = baseApiError(status, body);
  // The programs routes send their machine-readable code as `code`
  const code = (body as { code?: unknown } | null)?.code;
  const reason = bodyReason(body) ?? (typeof code === 'string' && code ? code : undefined);
  if (reason) err.reason = reason;
  return err;
}

/** The message mapping for the common cases (401 / 403 / 400 / 5xx). */
function baseApiError(status: number, body: unknown): ApiError {
  const serverMessage = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  if (status === 403 && bodyReason(body) === 'password_change_required') return new ApiError(403, mfaErrorMessage(status, body));
  if (status === 401) return new ApiError(401, 'Your session has expired or is not valid. Please sign in again.');
  if (status === 403) return new ApiError(403, serverMessage || 'You do not have permission to do that.');
  if (status === 400 || status === 404 || status === 409 || status === 410) return new ApiError(status, serverMessage || 'The request was not accepted.');
  if (status === 429) return new ApiError(429, 'Too many requests. Please wait a moment and try again.');
  return new ApiError(status, 'The server could not complete the request. Please try again.');
}

/** fetch() wrapper: network failures become ApiError(0) so the UI can say "cannot reach the server". */
async function apiFetch(input: string, init: RequestInit): Promise<Response> {
  let res: Response;
  init = { credentials: 'same-origin', ...init };
  try {
    res = await fetch(input, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  // A 401 on a request carrying the stored session's own reference means the server ended the session: tell the app (see sessionSignal.ts)
  const sent = sessionRefFromHeaders(init.headers);
  const current = ApiClient.getToken();
  let reason: string | null = null;
  if (isSessionRejection(res.status, sent, current) && typeof res.clone === 'function') {
    reason = bodyReason(await res.clone().json().catch(() => null)) ?? null;
  }
  void reportResponseStatus(res.status, sent, current, reason);
  return res;
}

/** What GET /api/v1/tenants answered (see ApiClient.listMyTenantsResult). */
export type ListMyTenantsResult =
  | { kind: 'ok'; tenants: ServerTenant[] }
  | { kind: 'rejected' }
  | { kind: 'password_change_required' };

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
  options: { token?: string | null; tenantId?: string; programId?: string | null; body?: unknown } = {}
): Promise<T> {
  const bearer = options.token ?? ApiClient.getToken();
  if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
  const headers: Record<string, string> = { [SESSION_MARKER_HEADER]: bearer };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.tenantId) headers['x-tenant-id'] = options.tenantId;
  if (options.programId) headers['x-program-id'] = options.programId;
  const res = await apiFetch(`${API_BASE_URL}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiErrorFromResponse(res.status, data);
  return data as T;
}

/** A signed-in session as the server returns it. */
export interface LocalLoginResponse {
  /** The session reference: a marker, not a credential. The session itself is an HttpOnly cookie. */
  sessionRef: string;
  expiresAt: string;
  expiresIn: number;
  user: { id: string; email: string; name: string };
  /** True while the account must set a new password before anything else works. */
  mustChangePassword: boolean;
  mfaEnrolled: boolean;
  /** Only after a recovery code was used. */
  recoveryCodesRemaining?: number;
}

export type MfaStage = 'verify' | 'enrol';

/** Sign-in is not finished: a second step follows ('verify' a code, or 'enrol' a new factor). The token is proof of step one, not a session. */
export interface MfaPendingInfo {
  stage: MfaStage;
  mfaToken: string;
  expiresAt: string;
  methods?: string[];
}

export type LocalLoginResult = ({ kind: 'session' } & LocalLoginResponse) | ({ kind: 'mfa' } & MfaPendingInfo);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads the body of POST /auth/login, /auth/register-with-invite, /setup and /auth/mfa/* into a session or a pending second step.
 * Anything else is a 502: the server sent something this version of the app does not understand.
 */
export function parseLocalLoginResult(body: unknown): LocalLoginResult {
  const bad = () => new ApiError(502, 'The server sent back a sign-in response this version of the app does not understand.');
  if (!isRecord(body)) throw bad();
  if (body.mfa === 'verify' || body.mfa === 'enrol') {
    if (typeof body.mfaToken !== 'string' || !body.mfaToken || typeof body.expiresAt !== 'string') throw bad();
    const methods = Array.isArray(body.methods) ? body.methods.filter((m): m is string => typeof m === 'string') : undefined;
    return { kind: 'mfa', stage: body.mfa, mfaToken: body.mfaToken, expiresAt: body.expiresAt, ...(methods ? { methods } : {}) };
  }
  const user = body.user;
  if (typeof body.sessionRef !== 'string' || !body.sessionRef || !isRecord(user) || typeof user.email !== 'string' || !user.email) throw bad();
  return {
    kind: 'session',
    sessionRef: body.sessionRef,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
    expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 0,
    user: { id: typeof user.id === 'string' ? user.id : '', email: user.email, name: typeof user.name === 'string' ? user.name : '' },
    mustChangePassword: body.mustChangePassword === true,
    mfaEnrolled: body.mfaEnrolled === true,
    ...(typeof body.recoveryCodesRemaining === 'number' ? { recoveryCodesRemaining: body.recoveryCodesRemaining } : {}),
  };
}

/** What POST /auth/mfa/enrol/start returns: the new secret, shown once. */
export interface MfaEnrolmentStart {
  secret: string;
  otpauthUri: string;
  issuer: string;
  accountName: string;
  algorithm: string;
  digits: number;
  period: number;
}

/** POST /auth/mfa/enrol/confirm: the one-time recovery codes, plus the session when enrolment finished a sign-in. */
export interface MfaEnrolmentConfirm {
  recoveryCodes: string[];
  enrolledAt: string;
  session: LocalLoginResponse | null;
}

export interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  mode: string;
}

/** One local account as the platform-administration console lists it. */
export interface LocalAccount {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  mfaEnrolled: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * JSON request for the sign-in, second-factor, password and local-account calls. Failures become an ApiError whose message
 * comes from mfaErrorMessage and whose `reason` is the server's code. Without `token` it uses the stored session, unless
 * `anonymous` is set (the pending-token calls carry their proof in the body).
 */
async function accountJson<T>(method: string, path: string, options: { body?: unknown; token?: string | null; anonymous?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (!options.anonymous) {
    const bearer = options.token ?? ApiClient.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
    headers[SESSION_MARKER_HEADER] = bearer;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await apiFetch(`${API_BASE_URL}/api/v1${path}`, {
    method,
    headers,
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, mfaErrorMessage(res.status, data));
    const reason = bodyReason(data);
    if (reason) err.reason = reason;
    throw err;
  }
  return data as T;
}

const parseEnrolmentStart = (data: unknown): MfaEnrolmentStart => {
  if (!isRecord(data) || typeof data.secret !== 'string' || typeof data.otpauthUri !== 'string') {
    throw new ApiError(502, 'The server sent back an enrolment response this version of the app does not understand.');
  }
  return {
    secret: data.secret,
    otpauthUri: data.otpauthUri,
    issuer: typeof data.issuer === 'string' ? data.issuer : '',
    accountName: typeof data.accountName === 'string' ? data.accountName : '',
    algorithm: typeof data.algorithm === 'string' ? data.algorithm : 'SHA1',
    digits: typeof data.digits === 'number' ? data.digits : 6,
    period: typeof data.period === 'number' ? data.period : 30,
  };
};

const parseRecoveryCodes = (data: unknown): string[] => {
  const codes = isRecord(data) ? data.recoveryCodes : undefined;
  if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) {
    throw new ApiError(502, 'The server sent back recovery codes this version of the app does not understand.');
  }
  return codes as string[];
};

const parseAccount = (raw: unknown): LocalAccount => {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.email !== 'string') {
    throw new ApiError(502, 'The server sent back an account this version of the app does not understand.');
  }
  return {
    id: raw.id,
    email: raw.email,
    name: typeof raw.name === 'string' ? raw.name : '',
    disabled: raw.disabled === true,
    mfaEnrolled: raw.mfaEnrolled === true,
    mustChangePassword: raw.mustChangePassword === true,
    lockedUntil: typeof raw.lockedUntil === 'string' ? raw.lockedUntil : null,
    lastLoginAt: typeof raw.lastLoginAt === 'string' ? raw.lastLoginAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
};

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

/** What the setup wizard created. The sign-in outcome (a session, or an enrolment step first) is `login`. */
export interface SetupResult {
  user: { id: string; email: string; name: string };
  tenant: { id: string; name: string };
  invites: Array<{ email: string; role: TenantRole; token?: string; expiresAt?: string; error?: string }>;
}

export interface SetupOutcome {
  login: LocalLoginResult;
  setup: SetupResult;
}

export interface RegisterOutcome {
  login: LocalLoginResult;
  tenantId: string;
  role: TenantRole;
}

export const ApiClient = {
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
  async runSetup(input: SetupInput): Promise<SetupOutcome> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    const login = parseLocalLoginResult(data);
    const body = data as { user?: SetupResult['user']; tenant?: SetupResult['tenant']; invites?: SetupResult['invites'] };
    if (!body.user || !body.tenant || !Array.isArray(body.invites)) {
      throw new ApiError(502, 'The server sent back a setup response this version of the app does not understand.');
    }
    return { login, setup: { user: body.user, tenant: body.tenant, invites: body.invites } };
  },

  // ---------------------------------------------------------------- AI wording helper

  /** GET /api/v1/tenants/:id/ai-assist/status */
  async aiAssistStatus(tenantId: string): Promise<AiAssistStatus> {
    return authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/ai-assist/status`, { tenantId });
  },

  /** POST /api/v1/tenants/:id/ai-assist/parameter-wording. Suggestions only: nothing is saved. */
  async suggestParameterWording(tenantId: string, body: WordingSuggestionRequest): Promise<WordingSuggestions> {
    return authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/ai-assist/parameter-wording`, { tenantId, body });
  },

  // ---------------------------------------------------------------- SSP import

  /** GET /api/v1/tenants/:id/ssp-imports/capabilities */
  async sspCapabilities(tenantId: string, programId?: string | null): Promise<SspCapabilities> {
    return authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/capabilities`, { tenantId, programId });
  },

  /** GET /api/v1/tenants/:id/ssp-imports */
  async sspListJobs(tenantId: string, programId?: string | null): Promise<SspImportJob[]> {
    const data = await authedJson<{ jobs?: SspImportJob[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports`, { tenantId, programId });
    return Array.isArray(data?.jobs) ? data.jobs : [];
  },

  /** POST /api/v1/tenants/:id/ssp-imports (multipart). Owner / MSP admin only. */
  async sspUpload(tenantId: string, file: File, framework: SspImportFramework, analysis: SspAnalysisMode = 'rules', baseline?: SspBaseline, programId?: string | null): Promise<SspImportJob> {
    const bearer = ApiClient.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
    const uploadHeaders: Record<string, string> = { [SESSION_MARKER_HEADER]: bearer, 'x-tenant-id': tenantId }; // no Content-Type: the browser sets the multipart boundary
    if (programId) uploadHeaders['x-program-id'] = programId;
    const form = new FormData();
    form.append('framework', framework);
    form.append('analysis', analysis);
    if (baseline) form.append('baseline', baseline); // NIST SP 800-53 imports only
    form.append('file', file, file.name);
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}/ssp-imports`, {
      method: 'POST',
      headers: uploadHeaders,
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return (data as { job: SspImportJob }).job;
  },

  /** GET /api/v1/tenants/:id/ssp-imports/:jobId/staged: the suggestions next to the controls' current answers. */
  async sspGetStaged(tenantId: string, jobId: string, programId?: string | null): Promise<{ job: SspImportJob; staged: StagedControlView[] }> {
    return authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/staged`, { tenantId, programId });
  },

  /** GET /api/v1/tenants/:id/ssp-imports/:jobId */
  async sspGetJob(tenantId: string, jobId: string, programId?: string | null): Promise<SspImportJob> {
    const data = await authedJson<{ job: SspImportJob }>('GET', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}`, { tenantId, programId });
    return data.job;
  },

  /** PATCH .../staged/:id: records a review decision. Nothing is written to the controls until the commit. */
  async sspReview(tenantId: string, jobId: string, stagedId: string, decision: { reviewState: SspReviewState; editedNotes?: string }, programId?: string | null): Promise<StagedControl> {
    const data = await authedJson<{ staged: StagedControl }>(
      'PATCH',
      `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/staged/${encodeURIComponent(stagedId)}`,
      { tenantId, programId, body: decision }
    );
    return data.staged;
  },

  /** POST .../commit: applies the accepted and edited suggestions to the controls. */
  async sspCommit(tenantId: string, jobId: string, programId?: string | null): Promise<SspCommitOutcome> {
    return authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/commit`, { tenantId, programId, body: {} });
  },

  /** POST .../:jobId/cancel: stops an import that has not finished. */
  async sspCancel(tenantId: string, jobId: string, programId?: string | null): Promise<void> {
    await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/cancel`, { tenantId, programId, body: {} });
  },

  /** DELETE .../:jobId */
  async sspDelete(tenantId: string, jobId: string, programId?: string | null): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}`, { tenantId, programId });
  },

  /** The uploaded document, as a blob URL the caller must revoke. */
  async sspDownloadUrl(tenantId: string, jobId: string, programId?: string | null): Promise<string> {
    const bearer = ApiClient.getToken();
    if (!bearer) throw new ApiError(401, 'You need to be signed in to do that.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/file`, {
      method: 'GET',
      headers: { [SESSION_MARKER_HEADER]: bearer, 'x-tenant-id': tenantId, ...(programId ? { 'x-program-id': programId } : {}) },
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
    return URL.createObjectURL(await res.blob());
  },

  // ---------------------------------------------------------------- programs (authorization boundaries)

  /** GET /api/v1/tenants/:id/programs. Archived programs are included only when asked for. */
  async listPrograms(tenantId: string, options: { includeArchived?: boolean } = {}): Promise<Program[]> {
    const query = options.includeArchived ? '?includeArchived=true' : '';
    return parseProgramList(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/programs${query}`, { tenantId }));
  },

  /** POST /api/v1/tenants/:id/programs. Owner / MSP admin only. Framework and baseline cannot be changed afterwards. */
  async createProgram(tenantId: string, input: ProgramInput): Promise<Program> {
    const checked = validateProgramInput(input, { tenantFrameworks: [String(input.framework)], existing: [] });
    const body = programCreateBody(checked.value);
    const program = parseProgramResponse(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/programs`, { tenantId, body }));
    if (!program) throw new ApiError(502, 'The server sent back a program this version of the app does not understand.');
    return program;
  },

  /** PUT /api/v1/tenants/:id/programs/:programId: name, description and boundary summary. */
  async updateProgram(tenantId: string, programId: string, updates: ProgramUpdate): Promise<Program> {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.boundarySummary !== undefined) body.systemBoundarySummary = updates.boundarySummary;
    if (updates.scoping !== undefined) body.scoping = updates.scoping;
    if (updates.expectedScoping !== undefined) body.expectedScoping = updates.expectedScoping;
    const program = parseProgramResponse(await authedJson('PUT', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}`, { tenantId, body }));
    if (!program) throw new ApiError(502, 'The server sent back a program this version of the app does not understand.');
    return program;
  },

  /** POST .../programs/:programId/archive (archived programs stay readable, writes are refused). */
  async archiveProgram(tenantId: string, programId: string): Promise<Program | null> {
    return parseProgramResponse(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/archive`, { tenantId, body: {} }));
  },

  /** POST .../programs/:programId/unarchive */
  async unarchiveProgram(tenantId: string, programId: string): Promise<Program | null> {
    return parseProgramResponse(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/unarchive`, { tenantId, body: {} }));
  },

  /** DELETE .../programs/:programId. Only a non-default program with no evidence, imports or POA&M items. */
  async deleteProgram(tenantId: string, programId: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}`, { tenantId });
  },

  /** GET .../programs/:programId/metrics */
  async getProgramMetrics(tenantId: string, programId: string): Promise<ProgramMetrics> {
    return parseProgramMetrics(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/metrics`, { tenantId }));
  },

  /** GET .../programs/asset-memberships: { programId: assetIds } for every program, archived ones included. */
  async listProgramAssetMemberships(tenantId: string): Promise<Record<string, string[]>> {
    return parseAssetMemberships(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/programs/asset-memberships`, { tenantId }));
  },

  /** GET .../programs/:programId/assets: the assets the program declares inside its boundary (none declared means the whole inventory). */
  async getProgramAssets(tenantId: string, programId: string): Promise<ProgramAssets> {
    return parseProgramAssets(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/assets`, { tenantId }));
  },

  /** PATCH .../programs/:programId/assets with ids to add and remove. Owner / MSP admin only; an archived program refuses it. */
  async updateProgramAssets(tenantId: string, programId: string, change: { add?: string[]; remove?: string[] }): Promise<ProgramAssets> {
    const body: { add?: string[]; remove?: string[] } = {};
    if (change.add?.length) body.add = change.add;
    if (change.remove?.length) body.remove = change.remove;
    return parseProgramAssets(await authedJson('PATCH', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/assets`, { tenantId, body }));
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
  async registerWithInvite(input: { token: string; password: string; name?: string }): Promise<RegisterOutcome> {
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
    const login = parseLocalLoginResult(data);
    const { tenantId, role } = data as { tenantId: string; role: TenantRole };
    return { login, tenantId, role };
  },

  /**
   * GET /api/v1/tenants
   * The tenants the signed-in user belongs to, each with the user's role. Resolves null when the session is not
   * accepted (401), so callers can treat "not signed in" differently from a real failure (which throws).
   */
  async listMyTenants(token?: string): Promise<ServerTenant[] | null> {
    const result = await this.listMyTenantsResult(token);
    return result.kind === 'ok' ? result.tenants : null;
  },

  /**
   * Same request as listMyTenants, but says WHY there is nothing to load: 'rejected' (401, the session is dead) or
   * 'password_change_required' (the session is alive). Any other failure throws an ApiError that keeps its status
   * (0 = cannot reach the server), so the caller can tell an outage from a dead session.
   */
  async listMyTenantsResult(token?: string): Promise<ListMyTenantsResult> {
    const bearer = token ?? this.getToken();
    if (!bearer) return { kind: 'rejected' };
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants`, {
      headers: { [SESSION_MARKER_HEADER]: bearer },
    });
    if (res.status === 401) return { kind: 'rejected' };
    const body = res.ok ? null : await res.json().catch(() => null);
    // A temporary password must be changed first: nothing to load yet, and not an error (the change triggers a new sync)
    if (res.status === 403 && isPasswordChangeRequired(res.status, body)) return { kind: 'password_change_required' };
    if (!res.ok) throw apiErrorFromResponse(res.status, body);
    return { kind: 'ok', tenants: parseServerTenants(await res.json()) };
  },

  /**
   * GET /api/v1/me: whether the signed-in user is a platform administrator of THIS installation (decided by the server's
   * PLATFORM_ADMIN_EMAILS list). Resolves null when it cannot be determined, so the UI never assumes administrator rights.
   */
  async getPlatformStatus(token?: string): Promise<{ isPlatformAdmin: boolean } | null> {
    const bearer = token ?? this.getToken();
    if (!bearer) return null;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/v1/me`, { headers: { [SESSION_MARKER_HEADER]: bearer } });
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
      const res = await apiFetch(`${API_BASE_URL}/api/v1/platform/admins`, { headers: { [SESSION_MARKER_HEADER]: bearer } });
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
      headers: { 'Content-Type': 'application/json', [SESSION_MARKER_HEADER]: bearer },
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
      headers: { 'Content-Type': 'application/json', [SESSION_MARKER_HEADER]: bearer, 'x-tenant-id': tenantId },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
  },

  /**
   * POST /api/v1/auth/login  (air-gapped installs, AUTH_MODE=local)
   * Resolves a session, or `{ kind: 'mfa' }` when a second step (a code, or enrolling a factor) comes next.
   * Throws an ApiError carrying the server's message (e.g. invalid credentials, account locked).
   */
  async localLogin(email: string, password: string): Promise<LocalLoginResult> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new ApiError(res.status, (data as { error?: string }).error || `Sign-in failed (HTTP ${res.status})`);
      const reason = bodyReason(data);
      if (reason) err.reason = reason;
      throw err;
    }
    return parseLocalLoginResult(data);
  },

  /** POST /api/v1/auth/mfa/verify: the second step of a sign-in. Send either a 6-digit `code` or a `recoveryCode`. */
  async verifyMfa(mfaToken: string, input: { code?: string; recoveryCode?: string }): Promise<LocalLoginResponse> {
    const body = input.recoveryCode !== undefined ? { mfaToken, recoveryCode: input.recoveryCode } : { mfaToken, code: input.code ?? '' };
    const result = parseLocalLoginResult(await accountJson<unknown>('POST', '/auth/mfa/verify', { body, anonymous: true }));
    if (result.kind !== 'session') throw new ApiError(502, 'The server sent back a sign-in response this version of the app does not understand.');
    const { kind: _kind, ...session } = result;
    return session;
  },

  /** POST /api/v1/auth/mfa/enrol/start: a new secret (shown once). With `mfaToken` it is the pending sign-in's enrolment, else the session's. */
  async startMfaEnrolment(mfaToken?: string): Promise<MfaEnrolmentStart> {
    const data = await accountJson<unknown>('POST', '/auth/mfa/enrol/start', mfaToken ? { body: { mfaToken }, anonymous: true } : { body: {} });
    return parseEnrolmentStart(data);
  },

  /** POST /api/v1/auth/mfa/enrol/confirm: proves the app works and returns the one-time recovery codes (plus the session on the pending path). */
  async confirmMfaEnrolment(code: string, mfaToken?: string): Promise<MfaEnrolmentConfirm> {
    const data = await accountJson<unknown>('POST', '/auth/mfa/enrol/confirm', mfaToken ? { body: { code, mfaToken }, anonymous: true } : { body: { code } });
    const recoveryCodes = parseRecoveryCodes(data);
    const enrolledAt = isRecord(data) && typeof data.enrolledAt === 'string' ? data.enrolledAt : '';
    let session: LocalLoginResponse | null = null;
    if (mfaToken) {
      const result = parseLocalLoginResult(data);
      if (result.kind === 'session') {
        const { kind: _kind, ...rest } = result;
        session = rest;
      }
    }
    return { recoveryCodes, enrolledAt, session };
  },

  /** GET /api/v1/auth/mfa */
  async getMfaStatus(): Promise<MfaStatus> {
    const data = await accountJson<Record<string, unknown>>('GET', '/auth/mfa');
    return {
      enrolled: data.enrolled === true,
      enrolledAt: typeof data.enrolledAt === 'string' ? data.enrolledAt : null,
      recoveryCodesRemaining: typeof data.recoveryCodesRemaining === 'number' ? data.recoveryCodesRemaining : 0,
      required: data.required === true,
      mode: typeof data.mode === 'string' ? data.mode : '',
    };
  },

  /** POST /api/v1/auth/mfa/recovery-codes: a fresh set (the old ones stop working). Needs a current authenticator code. */
  async regenerateRecoveryCodes(code: string): Promise<{ recoveryCodes: string[]; recoveryCodesRemaining: number }> {
    const data = await accountJson<unknown>('POST', '/auth/mfa/recovery-codes', { body: { code } });
    const recoveryCodes = parseRecoveryCodes(data);
    const remaining = isRecord(data) && typeof data.recoveryCodesRemaining === 'number' ? data.recoveryCodesRemaining : recoveryCodes.length;
    return { recoveryCodes, recoveryCodesRemaining: remaining };
  },

  /**
   * POST /api/v1/auth/password: needs the current password and, for an enrolled account, a fresh code. Every other session of the
   * account ends; the response is the new session, which the caller must store.
   */
  async changePassword(currentPassword: string, newPassword: string, code?: string, token?: string): Promise<LocalLoginResponse> {
    const body: Record<string, string> = { currentPassword, newPassword };
    if (code) body.code = code;
    const result = parseLocalLoginResult(await accountJson<unknown>('POST', '/auth/password', { body, token }));
    if (result.kind !== 'session') throw new ApiError(502, 'The server sent back a sign-in response this version of the app does not understand.');
    const { kind: _kind, ...session } = result;
    return session;
  },

  // ---------------------------------------------------------------- local account administration (platform administrators)

  /** GET /api/v1/platform/users */
  async listLocalUsers(): Promise<LocalAccount[]> {
    const data = await accountJson<{ users?: unknown }>('GET', '/platform/users');
    return Array.isArray(data?.users) ? data.users.map(parseAccount) : [];
  },

  /** POST /api/v1/platform/users/:id/reset-password: sets a temporary password the person must change at their next sign-in. */
  async adminResetPassword(userId: string, newPassword: string, code: string): Promise<{ user: LocalAccount; message: string }> {
    const data = await accountJson<{ user?: unknown; message?: unknown }>('POST', `/platform/users/${encodeURIComponent(userId)}/reset-password`, { body: { newPassword, code } });
    return { user: parseAccount(data?.user), message: typeof data?.message === 'string' ? data.message : '' };
  },

  /** POST /api/v1/platform/users/:id/reset-mfa */
  async adminResetMfa(userId: string, code: string): Promise<LocalAccount> {
    const data = await accountJson<{ user?: unknown }>('POST', `/platform/users/${encodeURIComponent(userId)}/reset-mfa`, { body: { code } });
    return parseAccount(data?.user);
  },

  /** POST /api/v1/platform/users/:id/disable */
  async disableUser(userId: string, code: string): Promise<LocalAccount> {
    const data = await accountJson<{ user?: unknown }>('POST', `/platform/users/${encodeURIComponent(userId)}/disable`, { body: { code } });
    return parseAccount(data?.user);
  },

  /** POST /api/v1/platform/users/:id/enable */
  async enableUser(userId: string, code: string): Promise<LocalAccount> {
    const data = await accountJson<{ user?: unknown }>('POST', `/platform/users/${encodeURIComponent(userId)}/enable`, { body: { code } });
    return parseAccount(data?.user);
  },

  /** POST /api/v1/auth/logout: asks the server to end the session and clear the cookie. Never throws; sends no marker, so it never signals. */
  async signOut(): Promise<void> {
    try {
      await apiFetch(`${API_BASE_URL}/api/v1/auth/logout`, { method: 'POST', cache: 'no-store' });
    } catch {
      // best effort: the browser state is cleared by the caller either way
    }
  },

  /**
   * Retrieve the session reference from localStorage: a marker, not a credential; the session itself is an HttpOnly cookie
   */
  getToken(): string | null {
    try {
      return localStorage.getItem(SESSION_REF_KEY);
    } catch {
      return null;
    }
  },

  /**
   * Constructs authorization and tenant context headers
   */
  getHeaders(tenantId: string, extraHeaders?: HeadersInit, programId?: string | null): HeadersInit {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };
    if (programId) headers['x-program-id'] = programId;

    if (token) {
      headers[SESSION_MARKER_HEADER] = token;
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
    },
    programId?: string | null
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
    const res = await apiFetch(`${API_BASE_URL}/api/v1/controls${queryString}`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });

    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));

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
    updates: Partial<ControlState>,
    programId?: string | null
  ): Promise<ControlState> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/controls/${encodeURIComponent(controlId)}`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({
        status: updates.status,
        implementationNotes: updates.implementationNotes,
        responsibleRole: updates.responsibleRole,
        updatedBy: updates.updatedBy,
      }),
    });

    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));

    const data = await res.json();
    return data.control;
  },

  /**
   * GET /api/v1/objectives
   * The program's objective records (status, narrative, evidence links); every role may read them
   */
  async getObjectives(tenantId: string, controlId?: string, programId?: string | null): Promise<ObjectiveRecord[]> {
    const query = controlId ? `?controlId=${encodeURIComponent(controlId)}` : '';
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives${query}`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    const data = await res.json();
    return Array.isArray(data.objectives) ? data.objectives : [];
  },

  /**
   * PUT /api/v1/objectives/:objectiveId
   * Saves one objective (owner / MSP only); a field left out keeps its stored value, an empty narrative clears it
   */
  async putObjective(tenantId: string, input: ObjectiveInput, programId?: string | null): Promise<{ objective: ObjectiveRecord; changed: boolean }> {
    const { objectiveId, ...body } = input;
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives/${encodeURIComponent(objectiveId)}`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * PUT /api/v1/objectives
   * Saves up to 500 objectives, all or none
   */
  async putObjectivesBulk(tenantId: string, objectives: ObjectiveInput[], programId?: string | null): Promise<{ total: number; changed: number }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ objectives }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * POST /api/v1/objectives/import
   * Moves what a browser kept to the server (up to 5000): insert-only, an id the server already holds differently is a conflict
   */
  async importObjectives(tenantId: string, objectives: ObjectiveInput[], programId?: string | null): Promise<{ objectiveId: string; result: ObjectiveImportResult }[]> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives/import`, {
      method: 'POST',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ objectives }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  },

  /**
   * GET /api/v1/objectives/:objectiveId/history
   * Who changed the objective and when (the narrative's SHA-256 and length, never its text)
   */
  async getObjectiveHistory(tenantId: string, objectiveId: string, programId?: string | null): Promise<ObjectiveEvent[]> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives/${encodeURIComponent(objectiveId)}/history`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  },

  /**
   * GET /api/v1/evidence
   * Retrieves all evidence artifacts for the active tenant
   */
  async getEvidence(tenantId: string, programId?: string | null): Promise<EvidenceItem[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error('Not authenticated: ID token not found');
    }

    const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch evidence: ${res.status}`);
    }

    const data = await res.json();
    return data.evidence || [];
  },

  /**
   * GET /api/v1/evidence/:id/file
   * The evidence file itself. For a server-backed tenant the server is the only home of the file, so it is fetched on demand
   * and never cached by the browser. The caller must treat the type as untrusted (see previewKind) and revoke any object URL.
   */
  async getEvidenceFileBlob(tenantId: string, evidenceId: string, programId?: string | null): Promise<{ blob: Blob; contentType: string }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence/${encodeURIComponent(evidenceId)}/file`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
      cache: 'no-store',
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
    const blob = await res.blob();
    return { blob, contentType: res.headers.get('content-type') || blob.type || '' };
  },

  /**
   * GET /api/v1/evidence/:id/verify-integrity
   * Never throws: status 0 means the server could not be reached. 404 means the file is not on the server's disk.
   */
  async verifyEvidenceIntegrity(
    tenantId: string,
    evidenceId: string,
    programId?: string | null
  ): Promise<{ status: number; verified?: boolean; currentHash?: string }> {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence/${encodeURIComponent(evidenceId)}/verify-integrity`, {
        method: 'GET',
        headers: this.getHeaders(tenantId, undefined, programId),
        cache: 'no-store',
      });
      if (!res.ok) return { status: res.status };
      const data = await res.json().catch(() => null) as { verified?: unknown; currentHash?: unknown } | null;
      return {
        status: res.status,
        verified: typeof data?.verified === 'boolean' ? data.verified : undefined,
        currentHash: typeof data?.currentHash === 'string' ? data.currentHash : undefined,
      };
    } catch {
      return { status: 0 };
    }
  },

  /**
   * DELETE /api/v1/evidence/:id
   * Removes the record (and, for a base record, its cross-framework copies) and the file when nothing else uses it.
   * Rejects with the server's reason (403 read-only role, 404 unknown, 409 archived program or system-managed evidence).
   */
  async deleteEvidence(tenantId: string, evidenceId: string, programId?: string | null): Promise<{ removedIds: string[]; fileRemoved: boolean }> {
    const data = await authedJson<{ removedIds?: unknown; fileRemoved?: unknown }>(
      'DELETE',
      `/evidence/${encodeURIComponent(evidenceId)}`,
      { tenantId, programId }
    );
    const removedIds = Array.isArray(data?.removedIds) ? data.removedIds.filter((id): id is string => typeof id === 'string') : [evidenceId];
    return { removedIds, fileRemoved: data?.fileRemoved === true };
  },

  /**
   * GET /api/v1/evidence/config/storage-info
   * Reports the server's active evidence storage provider (local disk).
   */
  async getStorageInfo(
    tenantId: string,
    token?: string | null
  ): Promise<{ provider: string; localStoragePath: string; isAirGapped: boolean } | null> {
    // The caller can pass the session token itself: right after sign-in it is not in browser storage yet.
    const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence/config/storage-info`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, token ? { [SESSION_MARKER_HEADER]: token } : undefined),
    });
    if (!res.ok) return null;
    return await res.json();
  },

  /**
   * POST /api/v1/evidence/upload-url
   * Registers evidence metadata and returns the server-relative upload URL
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
    },
    programId?: string | null
  ): Promise<UploadUrlResponse> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence/upload-url`, {
      method: 'POST',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to generate upload URL: ${res.status}`);
    }

    return await res.json();
  },

  /**
   * Uploads a binary file to the local evidence vault through the server-relative URL returned by requestUploadUrl.
   * Only our own API receives the file and credentials, so any other URL is refused.
   */
  async uploadEvidenceFile(uploadUrl: string, file: File | Blob, mimeType: string, tenantId?: string, programId?: string | null): Promise<void> {
    if (!uploadUrl.startsWith('/') || uploadUrl.startsWith('//')) {
      throw new Error('Evidence upload URL must be a server-relative path.');
    }
    const targetUrl = API_BASE_URL ? `${API_BASE_URL}${uploadUrl}` : uploadUrl;
    const headers: Record<string, string> = {
      'Content-Type': mimeType || 'application/octet-stream',
    };
    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }
    if (programId) {
      headers['x-program-id'] = programId;
    }
    const token = this.getToken();
    if (token) {
      headers[SESSION_MARKER_HEADER] = token;
    }

    const res = await apiFetch(targetUrl, {
      method: 'PUT',
      headers,
      body: file,
    });

    if (!res.ok) {
      throw new Error(`Evidence upload failed with status ${res.status}: ${res.statusText}`);
    }
  },
};
