import { ControlState, EvidenceItem } from '../types/cmmc';
import type { SspMetadataFields, SspMetadataRecord } from '../types/sspMetadata';
import type { ControlPoamEvent, ControlPoamPatch, ControlPoamRecord } from '../types/controlPoam';
import type { SspProfile, SspProfileRecord, SspReviewsResponse, SspSectionReview, SspSectionReviewState } from '../types/sspProfile';
import type { CatalogUpdateChanges, LoweredControl, ObjectiveEvent, ObjectiveImportResult, ObjectiveInput, ObjectiveRecord } from '../types/controlObjectives';
import type { FrameworkCopyCommitBody, FrameworkCopyCommitResult, FrameworkCopyPreview, FrameworkCopyPreviewBody, FrameworkCopyRun, FrameworkCopySuggestions } from '../types/frameworkCopy';
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

import { ServerTenant, ExpiredMembership, isPasswordChangeRequired, parseExpiredTenants, parseServerTenants } from '../data/tenantSync';
import type { MemberProfilePatch } from '../data/membershipView';
import {
  ServerInvitation,
  ServerMember,
  parseServerInvitation,
  parseServerInvitations,
  parseServerMembers,
} from '../data/teamSync';
import type { TenantRole } from '../types/tenant';
import type { InviteMfaMode } from '../utils/invitePreview';
import type { AiAssistStatus, WordingSuggestionRequest, WordingSuggestions } from '../types/aiAssist';
import type { SspAnalysisMode, SspCapabilities, SspBaseline, SspCommitOutcome, SspImportFramework, SspImportJob, SspReviewState, StagedControl, StagedControlView } from '../types/sspImport';
import type { AccretionDiscoveryItem, EnclaveAsset } from '../types/telemetry';
import type { VmAssetConfigSummary, VmConfigResult, VmConfigRuleResult, VmConfigScan, VmConfigSuggestionsResponse, VmFinding, VmFindingStatus, VmObservedHost, VmObservedHostWithAsset, VmObservedSoftware, VmObservedSoftwareGroup, VmPoamItemEvent, VmPoamItemPatch, VmPoamResponse, VmPoamRow, VmRun, VmServiceToken, VmSeverity, VmSource, VmTargetPreview } from '../types/vm';
import { parseObservedHosts, parseObservedSoftware, parseObservedSoftwareGroups, parseProgramObservedHosts } from '../data/telemetry/observedInventory';
import { parseVmFindings } from '../data/telemetry/vmFindingsView';
import type { VmRemediationPolicy } from '../data/vmRemediation';
import type { VmDecision, VmPolicyEvent, VmPolicySaveResult, VmRemediationPolicyResponse, VmRemediationSummary } from '../types/vmRemediation';
import type { Program, ProgramInput, ProgramMetrics, ProgramUpdate } from '../types/program';
import { parseProgramList, parseProgramMetrics, parseProgramResponse, programCreateBody, validateProgramInput } from '../data/programSync';
import { parseAssetMemberships, parseProgramAssets } from '../data/programAssets';
import type { ProgramAssets } from '../data/programAssets';
import type { SoftwareItem, SoftwareItemInput } from '../types/software';
import type { ProgramSummary } from '../types/programSummary';
import type { Assignment, AssignmentChange, ResponsibilitiesResponse, ResponsibilityItem, Team } from '../types/assignments';
import type { SearchKind, SearchResponse } from '../types/search';
import { MAX_TOOLS_PER_TENANT, MAX_VENDORS_PER_TENANT } from '../types/inventory';
import type { DataInventoryRecord, InventoryEvent, InventoryTool, InventoryVendor, ProgramInventory, ProgramInventoryEvent, ToolBatchResult, ToolControlLink, ToolInput, ToolMembership, ToolUsage, VendorDocumentKind, VendorDocumentLink } from '../types/inventory';
import type { ToolInputWithSeed, VendorInput } from '../data/inventory/inventorySchema';
import { MAX_DOCUMENTS_PER_TENANT, type DocumentAttachment, type DocumentInput, type DocumentOrigin, type GovernanceDocument, type ProgramDocuments } from '../types/documents';
import { parseServerSoftwareItems } from '../data/telemetry/softwareItems';
import { AssetInput, AssetScopeSummary, parseServerAssets, summarizeScope } from '../data/telemetry/assetScope';
import { SESSION_MARKER_HEADER, SESSION_IDLE_MESSAGE, MFA_REQUIRED_MESSAGE, sessionRefFromHeaders, isSessionRejection, reportResponseStatus, reportCrossTabEnd, isCrossTabReason, sessionEndedMessage } from './sessionSignal';
import { tabSessionState, tabSessionPin } from './tabSession';
import { acknowledgedSystemUseNotice } from './systemUseNoticeAck';
import { parseSystemUseNotice, type SystemUseNotice } from '../data/systemUseNotice';
import { parseDormantDays, parseDisabledReason, type DisabledReason } from '../data/dormancyView';
import { isTabLocked, parseIdleSeconds } from './idleLock';

function requireAsset(raw: unknown): EnclaveAsset {
  const [asset] = parseServerAssets([raw]);
  if (!asset) throw new ApiError(502, 'The server sent back an asset this version of the app does not understand.');
  return asset;
}

function requireVmDecision(raw: unknown): VmDecision {
  const r = raw as { id?: unknown; kind?: unknown; state?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.state !== 'string') throw new ApiError(502, 'The server returned an unexpected response.');
  return raw as VmDecision;
}

function requireSoftwareItem(raw: unknown): SoftwareItem {
  const [item] = parseServerSoftwareItems([raw]);
  if (!item) throw new ApiError(502, 'The server sent back a software entry this version of the app does not understand.');
  return item;
}

/**
 * A failed API call with an HTTP status and a message that is safe to show to the user.
 * status 0 means the server could not be reached at all.
 */
export class ApiError extends Error {
  readonly status: number;
  /** The server's machine-readable `reason` (e.g. 'invalid_code', 'password_change_required'), when it sent one. */
  reason?: string;
  /** Only on a 409 `tool_in_use` (removing a tool from a program's boundary): how many control links and CUI category assignments would go with it. Numbers only. */
  inUse?: { controlLinks: number; cuiLinks?: number; attachments?: number; expectations?: number };
  /** Only on a 400 `invalid` / `invalid_location` from the document register: the name of the field the server refused (an identifier, never a value). */
  field?: string;
  /** Only on a 409 `duplicate_seed` (a generated draft already registered): the id of the existing document. */
  documentId?: string;
  /** Only on an assignment batch refusal (400 / 404 / 409): the position of the item in the request that was refused. A number only. */
  index?: number;
  /** Only on a 409 `team_in_use`: how many assignments and programs name the team. Numbers only. */
  teamUse?: { assignments: number; programs: number };
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
    case 'password_reused':
      return 'That password was used recently. Choose one you have not used before.';
    case 'mfa_already_enrolled':
      return 'A second factor is already set up for this account.';
    case 'mfa_not_started':
      return 'Start the setup again to get a new secret.';
    case 'mfa_not_enrolled':
      return 'Set up two-step verification on your own account first (account settings), then try again.';
    case 'self':
      return 'You cannot do that to your own account here.';
    case 'session_idle':
      return SESSION_IDLE_MESSAGE;
    case 'mfa_required':
      return MFA_REQUIRED_MESSAGE;
    default:
      break;
  }
  if (status === 429) return 'Too many attempts, or the account is temporarily locked. Wait a few minutes and try again.';
  if (status === 401) return serverMessage || 'Your session has expired or is not valid. Please sign in again.';
  if (status === 503) return 'Sign-in is not available right now. Contact your administrator.';
  return serverMessage || (status >= 500 ? 'The server could not complete the request. Please try again.' : 'The request was not accepted.');
}

/** Callers that want to know when the server says the organization has no active program (409 program_required). Returns the unsubscribe. */
const programRequiredListeners = new Set<() => void>();
export function onProgramRequired(listener: () => void): () => void {
  programRequiredListeners.add(listener);
  return () => { programRequiredListeners.delete(listener); };
}

/** Callers that want to know when the server says the signed-in person's access to an organization has ended (403 membership_expired, #258). Returns the unsubscribe. */
const membershipExpiredListeners = new Set<(e: { tenantId: string | null; expiredOn: string | null }) => void>();
export function onMembershipExpired(listener: (e: { tenantId: string | null; expiredOn: string | null }) => void): () => void {
  membershipExpiredListeners.add(listener);
  return () => { membershipExpiredListeners.delete(listener); };
}

/** Turns a failed response into an ApiError carrying the server's `reason` (when it sent one). */
function apiErrorFromResponse(status: number, body: unknown, tenantId?: string): ApiError {
  const err = baseApiError(status, body);
  // The programs routes send their machine-readable code as `code`
  const code = (body as { code?: unknown } | null)?.code;
  const reason = bodyReason(body) ?? (typeof code === 'string' && code ? code : undefined);
  if (reason) err.reason = reason;
  if (reason === 'tool_in_use') {
    const counts = (body ?? {}) as { controlLinks?: unknown; cuiLinks?: unknown };
    err.inUse = { controlLinks: typeof counts.controlLinks === 'number' ? counts.controlLinks : 0, cuiLinks: typeof counts.cuiLinks === 'number' ? counts.cuiLinks : 0 };
  }
  // The document register's extras: a field name, counts and an id only, never a title, owner, location or note
  if (reason === 'document_in_use') {
    const counts = (body ?? {}) as { controlLinks?: unknown; attachments?: unknown; expectations?: unknown };
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    err.inUse = { controlLinks: n(counts.controlLinks), attachments: n(counts.attachments), expectations: n(counts.expectations) };
  }
  if ((reason === 'invalid' || reason === 'invalid_location') && typeof (body as { field?: unknown } | null)?.field === 'string') {
    const field = (body as { field: string }).field;
    if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(field)) err.field = field;
  }
  if (typeof (body as { index?: unknown } | null)?.index === 'number' && Number.isInteger((body as { index: number }).index) && (body as { index: number }).index >= 0) err.index = (body as { index: number }).index;
  if (reason === 'team_in_use') {
    const counts = (body ?? {}) as { assignments?: unknown; programs?: unknown };
    err.teamUse = { assignments: typeof counts.assignments === 'number' ? counts.assignments : 0, programs: typeof counts.programs === 'number' ? counts.programs : 0 };
  }
  if (reason === 'duplicate_seed' && typeof (body as { documentId?: unknown } | null)?.documentId === 'string') {
    const id = (body as { documentId: string }).documentId;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) err.documentId = id;
  }
  // A program-scoped call with no active program in the organization: whoever shows the programs refreshes them so the screen can take over
  if (status === 409 && reason === 'program_required') for (const listener of [...programRequiredListeners]) listener();
  // The signed-in person's own access end date has passed: whoever shows the organizations refreshes them and says so
  if (status === 403 && reason === 'membership_expired') {
    const on = (body as { expiredOn?: unknown } | null)?.expiredOn;
    const expiredOn = typeof on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : null;
    for (const listener of [...membershipExpiredListeners]) listener({ tenantId: tenantId ?? null, expiredOn });
  }
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

let lastRequestAt = 0;

/** When this tab last sent a request to the server (epoch ms, 0 before the first): the idle lock sends a heartbeat when it has been quiet too long. */
export function getLastRequestAt(): number {
  return lastRequestAt;
}

/** fetch() wrapper: network failures become ApiError(0) so the UI can say "cannot reach the server". */
async function apiFetch(input: string, init: RequestInit): Promise<Response> {
  let res: Response;
  init = { credentials: 'same-origin', ...init };
  const sent = sessionRefFromHeaders(init.headers);
  // A request with the session marker from a tab whose session another tab ended or replaced is never sent (#32)
  const tabState = tabSessionState();
  if (sent && isCrossTabReason(tabState)) {
    reportCrossTabEnd(tabSessionPin()?.ref, tabState);
    const err = new ApiError(401, sessionEndedMessage(tabState));
    err.reason = tabState;
    throw err;
  }
  // While this tab's screen is locked (#163) the server session is already ended: a request with the marker is refused here, without a
  // round trip and without telling the app the session died (the lock screen is already up)
  if (sent && isTabLocked()) {
    const err = new ApiError(401, SESSION_IDLE_MESSAGE);
    err.reason = 'session_locked';
    throw err;
  }
  lastRequestAt = Date.now();
  try {
    res = await fetch(input, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  // A 401 on a request carrying the stored session's own reference means the server ended the session: tell the app (see sessionSignal.ts)
  const current = ApiClient.getSessionRef();
  let reason: string | null = null;
  if (isSessionRejection(res.status, sent, current) && typeof res.clone === 'function') {
    reason = bodyReason(await res.clone().json().catch(() => null)) ?? null;
  }
  void reportResponseStatus(res.status, sent, current, reason);
  return res;
}

/** What GET /api/v1/tenants answered (see ApiClient.listMyTenantsResult). */
export type ListMyTenantsResult =
  | { kind: 'ok'; tenants: ServerTenant[]; expiredTenants?: ExpiredMembership[] }
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
  /** Which of the tenant's sign-ins this invitation requires a second factor for (the server's preview route returns it). */
  mfaMode?: InviteMfaMode;
}

/** PATCH /program-inventory/tools: the boundary after the change, and how many links went with a forced removal. */
export interface ProgramToolsResult {
  programId: string;
  declared: boolean;
  toolIds: string[];
  added: number;
  removed: number;
  linksRemoved: number;
  cuiLinksRemoved: number;
}

/** PUT /program-inventory/tools/:toolId/controls: the whole set now stored for the tool in this program (sorted by control id). */
export interface ToolControlsResult {
  toolId: string;
  controls: Pick<ToolControlLink, 'controlId' | 'evidenceSource'>[];
  changed: boolean;
}

/** Authenticated JSON request that throws ApiError (with a user-safe message) on any failure. */
async function authedJson<T>(
  method: string,
  path: string,
  options: { sessionRef?: string | null; tenantId?: string; programId?: string | null; body?: unknown } = {}
): Promise<T> {
  const ref = options.sessionRef ?? ApiClient.getSessionRef();
  if (!ref) throw new ApiError(401, 'You need to be signed in to do that.');
  const headers: Record<string, string> = { [SESSION_MARKER_HEADER]: ref };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.tenantId) headers['x-tenant-id'] = options.tenantId;
  if (options.programId) headers['x-program-id'] = options.programId;
  const res = await apiFetch(`${API_BASE_URL}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw apiErrorFromResponse(res.status, data, options.tenantId);
  return data as T;
}

/** The fields PATCH /tenants/:id/members/:userId accepts (#258, #259); send only what changes. Defined with the pure member view logic. */
export type { MemberProfilePatch };

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
  /** Why the account is disabled (#257): by an administrator or by the inactivity check; null when enabled or not reported. */
  disabledReason: DisabledReason | null;
  disabledAt: string | null;
}

/** One entry of the platform account-event trail (#40). `id` is the server's numeric event id as a string; `details` holds ids and codes only. */
export interface AccountEvent {
  id: string;
  at: string;
  actorKind: string;
  actorUserId: string | null;
  targetUserId: string;
  action: string;
  tenantId: string | null;
  details: Record<string, unknown>;
}

/** Narrows GET /platform/account-events (#194): one account (user id) and / or one action code; empty values mean no filter. */
export interface AccountEventFilter {
  target?: string | null;
  action?: string | null;
}

const parseAccountEvent = (raw: unknown): AccountEvent | null => {
  if (!isRecord(raw) || (typeof raw.id !== 'string' && typeof raw.id !== 'number') || typeof raw.action !== 'string') return null;
  return {
    id: String(raw.id),
    at: typeof raw.at === 'string' ? raw.at : '',
    actorKind: typeof raw.actorKind === 'string' ? raw.actorKind : '',
    actorUserId: typeof raw.actorUserId === 'string' ? raw.actorUserId : null,
    targetUserId: typeof raw.targetUserId === 'string' ? raw.targetUserId : '',
    action: raw.action,
    tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : null,
    details: isRecord(raw.details) ? raw.details : {},
  };
};

/** The system use notice as a platform administrator edits it (issue #256). */
export interface PlatformSystemUseNotice extends SystemUseNotice {
  updatedAt: string | null;
  updatedByUserId: string | null;
  defaultText: string;
  maxLength: number;
}

const parsePlatformSystemUseNotice = (data: unknown): PlatformSystemUseNotice => {
  const base = parseSystemUseNotice(data);
  if (!base || !isRecord(data) || typeof data.defaultText !== 'string' || typeof data.maxLength !== 'number') {
    throw new ApiError(502, 'The server sent back a system use notice this version of the app does not understand.');
  }
  return {
    ...base,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    updatedByUserId: typeof data.updatedByUserId === 'string' ? data.updatedByUserId : null,
    defaultText: data.defaultText,
    maxLength: data.maxLength,
  };
};

/** How loud an announcement is: a warning is also shown as a banner (issue #260). */
export type NoticeSeverity = 'info' | 'warning';
export type NoticeKind = 'release' | 'announcement';

/** One announcement as a signed-in person sees it in What's new. */
export interface NoticeAnnouncement {
  id: string;
  title: string;
  body: string;
  severity: NoticeSeverity;
  createdAt: string;
  expiresAt: string | null;
  read: boolean;
}

/** GET /api/v1/me/notices: the running version, which versions this person marked as read, and the active announcements. */
export interface NoticesSnapshot {
  currentVersion: string;
  notesAvailable: boolean;
  releaseReads: string[];
  announcements: NoticeAnnouncement[];
}

/** One announcement as a platform administrator sees it (adds who posted or withdrew it). */
export interface AdminAnnouncement {
  id: string;
  title: string;
  body: string;
  severity: NoticeSeverity;
  createdAt: string;
  expiresAt: string | null;
  createdByUserId: string;
  withdrawnAt: string | null;
  withdrawnByUserId: string | null;
}

export interface AnnouncementLimits {
  titleMax: number;
  bodyMax: number;
  maxActive: number;
  maxExpiryDays: number;
}

/** The server's limits, used until it answers (and for any key it leaves out). */
export const DEFAULT_ANNOUNCEMENT_LIMITS: AnnouncementLimits = { titleMax: 120, bodyMax: 2000, maxActive: 5, maxExpiryDays: 365 };

const parseNoticeAnnouncement = (raw: unknown): NoticeAnnouncement | null => {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    severity: raw.severity === 'warning' ? 'warning' : 'info',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    read: raw.read === true,
  };
};

/** Reads GET /me/notices; throws ApiError(502) when the version is missing or malformed. Unusable announcements are dropped. */
export function parseNotices(raw: unknown): NoticesSnapshot {
  if (!isRecord(raw) || typeof raw.currentVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.currentVersion)) {
    throw new ApiError(502, 'The server sent back notices this version of the app does not understand.');
  }
  return {
    currentVersion: raw.currentVersion,
    notesAvailable: raw.notesAvailable === true,
    releaseReads: Array.isArray(raw.releaseReads) ? raw.releaseReads.filter((v): v is string => typeof v === 'string') : [],
    announcements: Array.isArray(raw.announcements)
      ? raw.announcements.map(parseNoticeAnnouncement).filter((a): a is NoticeAnnouncement => a !== null)
      : [],
  };
}

export function parseAdminAnnouncement(raw: unknown): AdminAnnouncement | null {
  const base = parseNoticeAnnouncement(raw);
  if (!base || !isRecord(raw)) return null;
  return {
    id: base.id,
    title: base.title,
    body: base.body,
    severity: base.severity,
    createdAt: base.createdAt,
    expiresAt: base.expiresAt,
    createdByUserId: typeof raw.createdByUserId === 'string' ? raw.createdByUserId : '',
    withdrawnAt: typeof raw.withdrawnAt === 'string' ? raw.withdrawnAt : null,
    withdrawnByUserId: typeof raw.withdrawnByUserId === 'string' ? raw.withdrawnByUserId : null,
  };
}

/** Each limit must be a positive whole number, else the default for that key is used. */
export function parseAnnouncementLimits(raw: unknown): AnnouncementLimits {
  const r = isRecord(raw) ? raw : {};
  const pick = (key: keyof AnnouncementLimits): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_ANNOUNCEMENT_LIMITS[key];
  };
  return { titleMax: pick('titleMax'), bodyMax: pick('bodyMax'), maxActive: pick('maxActive'), maxExpiryDays: pick('maxExpiryDays') };
}

const parseAdminAnnouncementOrThrow = (raw: unknown): AdminAnnouncement => {
  const a = parseAdminAnnouncement(isRecord(raw) ? raw.announcement : null);
  if (!a) throw new ApiError(502, 'The server sent back an announcement this version of the app does not understand.');
  return a;
};

/**
 * JSON request for the sign-in, second-factor, password and local-account calls. Failures become an ApiError whose message
 * comes from mfaErrorMessage and whose `reason` is the server's code. Without `sessionRef` it uses the stored session, unless
 * `anonymous` is set (the pending-token calls carry their proof in the body).
 */
async function accountJson<T>(method: string, path: string, options: { body?: unknown; sessionRef?: string | null; anonymous?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (!options.anonymous) {
    const ref = options.sessionRef ?? ApiClient.getSessionRef();
    if (!ref) throw new ApiError(401, 'You need to be signed in to do that.');
    headers[SESSION_MARKER_HEADER] = ref;
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
    disabledReason: parseDisabledReason(raw.disabledReason),
    disabledAt: typeof raw.disabledAt === 'string' ? raw.disabledAt : null,
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
  /** Licensed frameworks, ids from SETUP_FRAMEWORKS; the first is the primary. Omit for CMMC Level 1 only. */
  frameworks?: ComplianceFramework[];
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

/** One rule result of a configuration scan with the controls the rule maps to (null when it maps to none). */
export interface VmConfigRuleResultRow extends VmConfigRuleResult {
  controls: { cmmc: string | null; nist80053: string | null } | null;
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

  /** POST /api/v1/tenants/:id/ssp-imports (multipart). Write roles only (Tenant Owner, Admin, MSP Admin). */
  async sspUpload(tenantId: string, file: File, framework: SspImportFramework, analysis: SspAnalysisMode = 'rules', baseline?: SspBaseline, programId?: string | null): Promise<SspImportJob> {
    const ref = ApiClient.getSessionRef();
    if (!ref) throw new ApiError(401, 'You need to be signed in to do that.');
    const uploadHeaders: Record<string, string> = { [SESSION_MARKER_HEADER]: ref, 'x-tenant-id': tenantId }; // no Content-Type: the browser sets the multipart boundary
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
    const ref = ApiClient.getSessionRef();
    if (!ref) throw new ApiError(401, 'You need to be signed in to do that.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}/ssp-imports/${encodeURIComponent(jobId)}/file`, {
      method: 'GET',
      headers: { [SESSION_MARKER_HEADER]: ref, 'x-tenant-id': tenantId, ...(programId ? { 'x-program-id': programId } : {}) },
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
    return URL.createObjectURL(await res.blob());
  },

  // ----------------------------------------------------------------------------------------- experience (#251-#254)
  // Program summary, assignments, teams, responsibilities and global search. Scoped methods end with `programId?`; the team and responsibility calls are tenant-wide.

  /** GET /api/v1/program-summary (any member): the counts the journey bar and the dashboard need from the server. Never cached by the server. */
  async getProgramSummary(tenantId: string, programId?: string | null): Promise<ProgramSummary> {
    const data = await authedJson<Partial<ProgramSummary>>('GET', '/program-summary', { tenantId, programId });
    if (!data || typeof data.programId !== 'string' || !data.people || !data.inventory || !data.reviews || !data.poam) throw new ApiError(502, 'The server returned an unexpected response.');
    return data as ProgramSummary;
  },

  /** GET /api/v1/assignments (any member): every assignment of the program. */
  async listAssignments(tenantId: string, programId?: string | null): Promise<Assignment[]> {
    const data = await authedJson<{ assignments?: unknown }>('GET', '/assignments', { tenantId, programId });
    if (!Array.isArray(data?.assignments)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.assignments as Assignment[];
  },

  /** PUT /api/v1/assignments (write roles): one to 500 changes, all or nothing. 409 stale_write names the item (`index`) that changed under the caller. */
  async putAssignments(tenantId: string, items: AssignmentChange[], programId?: string | null): Promise<{ assignments: Assignment[]; changed: number }> {
    const data = await authedJson<{ assignments?: unknown; changed?: unknown }>('PUT', '/assignments', { tenantId, programId, body: { items } });
    if (!Array.isArray(data?.assignments) || typeof data.changed !== 'number') throw new ApiError(502, 'The server returned an unexpected response.');
    return { assignments: data.assignments as Assignment[], changed: data.changed };
  },

  /** GET /api/v1/assignments/mine (any member): what the signed-in person is responsible for in this program, directly and through teams. */
  async listMyAssignments(tenantId: string, programId?: string | null): Promise<ResponsibilityItem[]> {
    const data = await authedJson<{ items?: unknown }>('GET', '/assignments/mine', { tenantId, programId });
    if (!Array.isArray(data?.items)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.items as ResponsibilityItem[];
  },

  /** POST /api/v1/framework-copy/preview (write roles): what copying a CMMC program into this Rev. 3 program would append. Writes nothing; ids, counts and lengths only. */
  async previewFrameworkCopy(tenantId: string, body: FrameworkCopyPreviewBody, programId?: string | null): Promise<FrameworkCopyPreview> {
    const data = await authedJson<Partial<FrameworkCopyPreview>>('POST', '/framework-copy/preview', { tenantId, programId, body });
    if (!Array.isArray(data?.items) || typeof data.planDigest !== 'string') throw new ApiError(502, 'The server returned an unexpected response.');
    return data as FrameworkCopyPreview;
  },

  /** POST /api/v1/framework-copy/commit (write roles): applies the previewed plan; 409 copy_plan_stale when the rows changed since the preview. */
  async commitFrameworkCopy(tenantId: string, body: FrameworkCopyCommitBody, programId?: string | null): Promise<FrameworkCopyCommitResult> {
    const data = await authedJson<Partial<FrameworkCopyCommitResult>>('POST', '/framework-copy/commit', { tenantId, programId, body });
    if (typeof data?.runId !== 'string' || !data.summary || typeof data.summary !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data as FrameworkCopyCommitResult;
  },

  /** GET /api/v1/framework-copy/runs (any member): the copy runs of this program, newest first (counts only). */
  async getFrameworkCopyRuns(tenantId: string, programId?: string | null): Promise<FrameworkCopyRun[]> {
    const data = await authedJson<{ runs?: unknown }>('GET', '/framework-copy/runs', { tenantId, programId });
    if (!Array.isArray(data?.runs)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.runs as FrameworkCopyRun[];
  },

  /** GET /api/v1/framework-copy/suggestions (any member): a suggested status per Rev. 3 control from its Rev. 2 sources. Never stored. */
  async getFrameworkCopySuggestions(tenantId: string, programId?: string | null): Promise<FrameworkCopySuggestions> {
    const data = await authedJson<Partial<FrameworkCopySuggestions>>('GET', '/framework-copy/suggestions', { tenantId, programId });
    if (typeof data?.applies !== 'boolean' || !Array.isArray(data.suggestions)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { applies: data.applies, sourceProgramId: typeof data.sourceProgramId === 'string' ? data.sourceProgramId : null, suggestions: data.suggestions };
  },

  /** GET /api/v1/tenants/:id/teams (any member). */
  async listTeams(tenantId: string): Promise<Team[]> {
    const data = await authedJson<{ teams?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/teams`, { tenantId });
    if (!Array.isArray(data?.teams)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.teams as Team[];
  },

  /** POST /api/v1/tenants/:id/teams (write roles). 409 duplicate_name, 429 limit. */
  async createTeam(tenantId: string, input: { name: string; description?: string }): Promise<Team> {
    const data = await authedJson<{ team?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/teams`, { tenantId, body: input });
    if (!data?.team || typeof data.team !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.team as Team;
  },

  /** PUT /api/v1/tenants/:id/teams/:teamId (write roles): `expectedUpdatedAt` is the stamp the caller loaded; a change since answers 409 stale_write. */
  async updateTeam(tenantId: string, teamId: string, changes: { name?: string; description?: string; expectedUpdatedAt: string }): Promise<{ team: Team; changed: boolean }> {
    const data = await authedJson<{ team?: unknown; changed?: unknown }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}`, { tenantId, body: changes });
    if (!data?.team || typeof data.team !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return { team: data.team as Team, changed: data.changed === true };
  },

  /** PATCH /api/v1/tenants/:id/teams/:teamId/members (write roles): people to add (current members only) and to remove. */
  async patchTeamMembers(tenantId: string, teamId: string, change: { add?: string[]; remove?: string[] }): Promise<{ team: Team; added: number; removed: number }> {
    const data = await authedJson<{ team?: unknown; added?: unknown; removed?: unknown }>('PATCH', `/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/members`, { tenantId, body: change });
    if (!data?.team || typeof data.team !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return { team: data.team as Team, added: typeof data.added === 'number' ? data.added : 0, removed: typeof data.removed === 'number' ? data.removed : 0 };
  },

  /** GET /api/v1/tenants/:id/teams/:teamId/usage (any member): the programs whose assignments name the team (archived ones included). */
  async getTeamUsage(tenantId: string, teamId: string): Promise<{ programId: string; assignments: number }[]> {
    const data = await authedJson<{ programs?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}/usage`, { tenantId });
    if (!Array.isArray(data?.programs)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.programs as { programId: string; assignments: number }[];
  },

  /** DELETE /api/v1/tenants/:id/teams/:teamId (write roles). 409 team_in_use (counts on the error) unless `force` removes the team's assignments too. */
  async deleteTeam(tenantId: string, teamId: string, force?: boolean): Promise<{ removed: string; assignmentsRemoved: number }> {
    const query = force ? '?force=true' : '';
    const data = await authedJson<{ removed?: unknown; assignmentsRemoved?: unknown }>('DELETE', `/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}${query}`, { tenantId });
    if (typeof data?.removed !== 'string') throw new ApiError(502, 'The server returned an unexpected response.');
    return { removed: data.removed, assignmentsRemoved: typeof data.assignmentsRemoved === 'number' ? data.assignmentsRemoved : 0 };
  },

  /** GET /api/v1/tenants/:id/responsibilities (any member): the caller's responsibilities (`me`) or a team's (`team`, with `teamId`) across the programs. */
  async getResponsibilities(tenantId: string, options: { view?: 'me' | 'team'; teamId?: string; includeArchived?: boolean } = {}): Promise<ResponsibilitiesResponse> {
    const params: string[] = [`view=${options.view === 'team' ? 'team' : 'me'}`];
    if (options.view === 'team' && options.teamId) params.push(`teamId=${encodeURIComponent(options.teamId)}`);
    if (options.includeArchived) params.push('includeArchived=true');
    const data = await authedJson<Partial<ResponsibilitiesResponse>>('GET', `/tenants/${encodeURIComponent(tenantId)}/responsibilities?${params.join('&')}`, { tenantId });
    if (!Array.isArray(data?.programs)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { programs: data.programs, truncated: data.truncated === true };
  },

  /** POST /api/v1/search (any member): the query travels in the body, never in the URL. The answer is never cached (the server sends no-store). 400 invalid_query, 429 when asked too often. */
  async searchProgram(tenantId: string, body: { q: string; kinds?: SearchKind[]; perKind?: number }, programId?: string | null): Promise<SearchResponse> {
    const data = await authedJson<Partial<SearchResponse>>('POST', '/search', { tenantId, programId, body });
    if (!Array.isArray(data?.groups)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { programId: typeof data.programId === 'string' ? data.programId : '', groups: data.groups };
  },

  // ---------------------------------------------------------------- programs (authorization boundaries)

  /** GET /api/v1/tenants/:id/programs. Archived programs are included only when asked for. */
  async listPrograms(tenantId: string, options: { includeArchived?: boolean } = {}): Promise<Program[]> {
    const query = options.includeArchived ? '?includeArchived=true' : '';
    return parseProgramList(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/programs${query}`, { tenantId }));
  },

  /** POST /api/v1/tenants/:id/programs. Write roles only (Tenant Owner, Admin, MSP Admin). Framework and baseline cannot be changed afterwards. */
  async createProgram(tenantId: string, input: ProgramInput): Promise<Program> {
    const checked = validateProgramInput(input, { tenantFrameworks: [String(input.framework)], existing: [] });
    const body = programCreateBody(checked.value);
    const program = parseProgramResponse(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/programs`, { tenantId, body }));
    if (!program) throw new ApiError(502, 'The server sent back a program this version of the app does not understand.');
    return program;
  },

  /** PUT /api/v1/tenants/:id/programs/:programId: name, description, boundary summary, overlays and enclave stack profile (null clears it). */
  async updateProgram(tenantId: string, programId: string, updates: ProgramUpdate): Promise<Program> {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.boundarySummary !== undefined) body.systemBoundarySummary = updates.boundarySummary;
    if (updates.scoping !== undefined) body.scoping = updates.scoping;
    if (updates.expectedScoping !== undefined) body.expectedScoping = updates.expectedScoping;
    if (updates.stackProfile !== undefined) body.stackProfile = updates.stackProfile;
    if (updates.sprsGoal !== undefined) body.sprsGoal = updates.sprsGoal;
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

  /** PUT /api/v1/me/default-program: the signed-in user's own landing program (null clears it). Any role; not program-scoped. */
  async setMyDefaultProgram(tenantId: string, programId: string | null): Promise<void> {
    await authedJson('PUT', '/me/default-program', { tenantId, body: { programId } });
  },

  /** PUT .../programs/:programId/default: the organization default. Write roles only (Tenant Owner, Admin, MSP Admin); an archived program is refused. */
  async setOrganizationDefaultProgram(tenantId: string, programId: string): Promise<void> {
    await authedJson('PUT', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/default`, { tenantId, body: {} });
  },

  /** GET .../programs/:programId/vm-target/preview (every role): what making the program the VM target would mean (the current target, its open POA&M items, how many overdue findings have no item here). Changes nothing. */
  async getVmTargetProgramPreview(tenantId: string, programId: string): Promise<VmTargetPreview> {
    const data = await authedJson<VmTargetPreview>('GET', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/vm-target/preview`, { tenantId });
    if (!data || typeof data.programId !== 'string' || typeof data.eligible !== 'boolean' || typeof data.overdueWithoutItem !== 'number') throw new ApiError(502, 'The server returned an unexpected response.');
    return data;
  },

  /** PUT .../programs/:programId/vm-target (write roles: Tenant Owner, Admin, MSP Admin): makes the program the VM target. Existing items stay in the previous target (`openPoamInPrevious`). Refresh the programs after success. */
  async setVmTargetProgram(tenantId: string, programId: string): Promise<{ previousId: string | null; openPoamInPrevious: number }> {
    const data = await authedJson<{ previousId?: string | null; openPoamInPrevious?: number }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/vm-target`, { tenantId, body: {} });
    return { previousId: typeof data?.previousId === 'string' ? data.previousId : null, openPoamInPrevious: typeof data?.openPoamInPrevious === 'number' ? data.openPoamInPrevious : 0 };
  },

  /** DELETE .../programs/:programId. Only an empty program that is not the VM target (no evidence, imports or POA&M items). */
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

  /** PATCH .../programs/:programId/assets with ids to add and remove. Write roles only (Tenant Owner, Admin, MSP Admin); an archived program refuses it. */
  async updateProgramAssets(tenantId: string, programId: string, change: { add?: string[]; remove?: string[] }): Promise<ProgramAssets> {
    const body: { add?: string[]; remove?: string[] } = {};
    if (change.add?.length) body.add = change.add;
    if (change.remove?.length) body.remove = change.remove;
    return parseProgramAssets(await authedJson('PATCH', `/tenants/${encodeURIComponent(tenantId)}/programs/${encodeURIComponent(programId)}/assets`, { tenantId, body }));
  },

  // ---------------------------------------------------------------- team: members and invitations

  /** GET /api/v1/tenants/:id/members with the install's inactivity period (#257). */
  async listMembersWithPolicy(tenantId: string, sessionRef?: string): Promise<{ members: ServerMember[]; dormantDays: number | null }> {
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/members`, { sessionRef, tenantId });
    return { members: parseServerMembers(data), dormantDays: parseDormantDays((data as { dormantDays?: unknown } | null)?.dormantDays) };
  },

  /** GET /api/v1/tenants/:id/members */
  async listMembers(tenantId: string, sessionRef?: string): Promise<ServerMember[]> {
    return (await ApiClient.listMembersWithPolicy(tenantId, sessionRef)).members;
  },

  /** POST /api/v1/tenants/:id/members: sets (or changes) an existing person's role. Write roles may call it; the server limits which roles each caller may grant or change (an Admin only Assessor and Viewer). */
  async setMemberRole(tenantId: string, member: { userId: string; email: string; name?: string; role: TenantRole }, sessionRef?: string): Promise<void> {
    await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/members`, { sessionRef, tenantId, body: member });
  },

  /** DELETE /api/v1/tenants/:id/members/:userId */
  async removeMember(tenantId: string, userId: string, sessionRef?: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`, { sessionRef, tenantId });
  },

  /** PATCH /api/v1/tenants/:id/members/:userId (#258, #259): the access end date, affiliation, US-person status and primary contact; `changed` names the fields that changed. */
  async updateMemberProfile(tenantId: string, userId: string, patch: MemberProfilePatch, sessionRef?: string): Promise<{ changed: string[] }> {
    const data = await authedJson<{ changed?: unknown }>('PATCH', `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`, { sessionRef, tenantId, body: patch });
    return { changed: Array.isArray(data?.changed) ? data.changed.filter((c): c is string => typeof c === 'string') : [] };
  },

  /** POST /api/v1/tenants/:id/members/:userId/restore (#257): an MSP Admin or a Tenant Owner restores a member the inactivity check disabled, with their own authenticator code. */
  async restoreMember(tenantId: string, userId: string, code: string, sessionRef?: string): Promise<{ restored: boolean; userId: string }> {
    const data = await authedJson<{ restored?: unknown; userId?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}/restore`, { sessionRef, tenantId, body: { code } });
    return { restored: data?.restored === true, userId: typeof data?.userId === 'string' ? data.userId : userId };
  },

  // ----------------------------------------------------------------------------------------- CMMC asset scoping

  /** GET /api/v1/tenants/:id/assets: the enclave's assets and the scope summary (any member). */
  async listAssets(tenantId: string, sessionRef?: string): Promise<{ assets: EnclaveAsset[]; summary: AssetScopeSummary }> {
    const data = await authedJson<{ assets?: unknown; summary?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/assets`, { sessionRef, tenantId });
    const assets = parseServerAssets(data?.assets);
    return { assets, summary: summarizeScope(assets) };
  },

  /** POST /api/v1/tenants/:id/assets (write roles: Tenant Owner, Admin, MSP Admin). */
  async createAsset(tenantId: string, asset: AssetInput, sessionRef?: string): Promise<EnclaveAsset> {
    const data = await authedJson<{ asset?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/assets`, { sessionRef, tenantId, body: asset });
    return requireAsset(data?.asset);
  },

  /** PUT /api/v1/tenants/:id/assets/:assetId. Only the fields given change. */
  async updateAsset(tenantId: string, assetId: string, patch: AssetInput, sessionRef?: string): Promise<EnclaveAsset> {
    const data = await authedJson<{ asset?: unknown }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}`, { sessionRef, tenantId, body: patch });
    return requireAsset(data?.asset);
  },

  /** DELETE /api/v1/tenants/:id/assets/:assetId. */
  async deleteAsset(tenantId: string, assetId: string, sessionRef?: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(assetId)}`, { sessionRef, tenantId });
  },

  /** GET /api/v1/tenants/:id/software: the tenant's software inventory (any member; shared by every program). */
  async listSoftwareItems(tenantId: string, sessionRef?: string): Promise<SoftwareItem[]> {
    const data = await authedJson<{ items?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/software`, { sessionRef, tenantId });
    return parseServerSoftwareItems(data?.items);
  },

  /** POST /api/v1/tenants/:id/software (write roles: Tenant Owner, Admin, MSP Admin). */
  async createSoftwareItem(tenantId: string, input: SoftwareItemInput, sessionRef?: string): Promise<SoftwareItem> {
    const data = await authedJson<{ item?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/software`, { sessionRef, tenantId, body: input });
    return requireSoftwareItem(data?.item);
  },

  /** PUT /api/v1/tenants/:id/software/:itemId. Only the fields given change. */
  async updateSoftwareItem(tenantId: string, itemId: string, patch: SoftwareItemInput, sessionRef?: string): Promise<SoftwareItem> {
    const data = await authedJson<{ item?: unknown }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/software/${encodeURIComponent(itemId)}`, { sessionRef, tenantId, body: patch });
    return requireSoftwareItem(data?.item);
  },

  /** DELETE /api/v1/tenants/:id/software/:itemId. */
  async deleteSoftwareItem(tenantId: string, itemId: string, sessionRef?: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/software/${encodeURIComponent(itemId)}`, { sessionRef, tenantId });
  },

  // ------------------------------------------------------------------------------------------------ tools and services register
  // Tenant-wide (shared by every program): these take no programId. Names, vendors, missions, notes and cost may be CUI: nothing here logs a value.

  /** GET /api/v1/tenants/:id/inventory/tools (any member). `annualCostCents` is absent for read roles: an absent key means "not available", never zero. */
  async listInventoryTools(tenantId: string): Promise<{ tools: InventoryTool[]; limit: number }> {
    const data = await authedJson<{ tools?: InventoryTool[]; limit?: number }>('GET', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools`, { tenantId });
    if (!Array.isArray(data?.tools)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { tools: data.tools, limit: typeof data.limit === 'number' ? data.limit : MAX_TOOLS_PER_TENANT };
  },

  /** POST /api/v1/tenants/:id/inventory/tools (write roles). 409 duplicate_name, 429 limit. */
  async createInventoryTool(tenantId: string, input: ToolInput): Promise<InventoryTool> {
    const data = await authedJson<{ tool?: InventoryTool }>('POST', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools`, { tenantId, body: input });
    if (!data?.tool || typeof data.tool !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.tool;
  },

  /** POST /api/v1/tenants/:id/inventory/tools/batch (write roles): 1 to 200 items; duplicates come back in `skipped` by position. */
  async createInventoryToolsBatch(tenantId: string, items: ToolInputWithSeed[]): Promise<ToolBatchResult> {
    const data = await authedJson<Partial<ToolBatchResult>>('POST', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools/batch`, { tenantId, body: { items } });
    if (!Array.isArray(data?.created) || !Array.isArray(data?.skipped)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { created: data.created, skipped: data.skipped };
  },

  /** PUT /api/v1/tenants/:id/inventory/tools/:toolId (write roles): the fields given change; expectedUpdatedAt is the stamp last read (409 stale_write). */
  async updateInventoryTool(tenantId: string, toolId: string, input: ToolInput, expectedUpdatedAt: string): Promise<{ tool: InventoryTool; changed: boolean }> {
    const data = await authedJson<{ tool?: InventoryTool; changed?: boolean }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools/${encodeURIComponent(toolId)}`, { tenantId, body: { ...input, expectedUpdatedAt } });
    if (!data?.tool || typeof data.tool !== 'object' || typeof data.changed !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { tool: data.tool, changed: data.changed };
  },

  /** DELETE /api/v1/tenants/:id/inventory/tools/:toolId (write roles): its links in every program go with it. */
  async deleteInventoryTool(tenantId: string, toolId: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools/${encodeURIComponent(toolId)}`, { tenantId });
  },

  /** GET /api/v1/tenants/:id/inventory/tools/:toolId/usage: in how many programs the tool is used (shown before a delete). */
  async getInventoryToolUsage(tenantId: string, toolId: string): Promise<ToolUsage> {
    const data = await authedJson<Partial<ToolUsage>>('GET', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools/${encodeURIComponent(toolId)}/usage`, { tenantId });
    if (typeof data?.programs !== 'number' || typeof data.controlLinks !== 'number' || typeof data.cuiLinks !== 'number') throw new ApiError(502, 'The server returned an unexpected response.');
    return { programs: data.programs, controlLinks: data.controlLinks, cuiLinks: data.cuiLinks };
  },

  /** PUT /api/v1/tenants/:id/inventory/tools/recovery-order (write roles): the ids ranked 1..n (tools not listed become unranked); expectedOrder is the order last read (409 stale_order). */
  async setToolRecoveryOrder(tenantId: string, order: string[], expectedOrder: string[]): Promise<string[]> {
    const data = await authedJson<{ order?: string[] }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/inventory/tools/recovery-order`, { tenantId, body: { order, expectedOrder } });
    if (!Array.isArray(data?.order)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.order;
  },

  /** GET /api/v1/tenants/:id/inventory/tool-memberships: the declared tools of every program, archived ones included (an undeclared program lists none and uses the whole register). */
  async listToolMemberships(tenantId: string): Promise<ToolMembership[]> {
    const data = await authedJson<{ memberships?: ToolMembership[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/inventory/tool-memberships`, { tenantId });
    if (!Array.isArray(data?.memberships)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.memberships;
  },

  /** GET /api/v1/tenants/:id/inventory/vendors (any member). */
  async listInventoryVendors(tenantId: string): Promise<{ vendors: InventoryVendor[]; limit: number }> {
    const data = await authedJson<{ vendors?: InventoryVendor[]; limit?: number }>('GET', `/tenants/${encodeURIComponent(tenantId)}/inventory/vendors`, { tenantId });
    if (!Array.isArray(data?.vendors)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { vendors: data.vendors, limit: typeof data.limit === 'number' ? data.limit : MAX_VENDORS_PER_TENANT };
  },

  /** POST /api/v1/tenants/:id/inventory/vendors (write roles). */
  async createInventoryVendor(tenantId: string, input: VendorInput): Promise<InventoryVendor> {
    const data = await authedJson<{ vendor?: InventoryVendor }>('POST', `/tenants/${encodeURIComponent(tenantId)}/inventory/vendors`, { tenantId, body: input });
    if (!data?.vendor || typeof data.vendor !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.vendor;
  },

  /** PUT /api/v1/tenants/:id/inventory/vendors/:vendorId (write roles): expectedUpdatedAt is the stamp last read (409 stale_write). */
  async updateInventoryVendor(tenantId: string, vendorId: string, input: VendorInput, expectedUpdatedAt: string): Promise<{ vendor: InventoryVendor; changed: boolean }> {
    const data = await authedJson<{ vendor?: InventoryVendor; changed?: boolean }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/inventory/vendors/${encodeURIComponent(vendorId)}`, { tenantId, body: { ...input, expectedUpdatedAt } });
    if (!data?.vendor || typeof data.vendor !== 'object' || typeof data.changed !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { vendor: data.vendor, changed: data.changed };
  },

  /** DELETE /api/v1/tenants/:id/inventory/vendors/:vendorId (write roles): tools keep their row with no vendor; document links go in every program. */
  async deleteInventoryVendor(tenantId: string, vendorId: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/inventory/vendors/${encodeURIComponent(vendorId)}`, { tenantId });
  },

  /** GET /api/v1/tenants/:id/inventory/events: the register history, newest first (digests and ids only; cost digests only for write roles). */
  async listInventoryEvents(tenantId: string, options?: { entityId?: string; limit?: number }): Promise<InventoryEvent[]> {
    const qs = new URLSearchParams();
    if (options?.entityId) qs.set('entityId', options.entityId);
    if (options?.limit) qs.set('limit', String(options.limit));
    const data = await authedJson<{ events?: InventoryEvent[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/inventory/events${qs.toString() ? `?${qs.toString()}` : ''}`, { tenantId });
    if (!Array.isArray(data?.events)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.events;
  },

  // ----------------------------------------------------------------------------------------- program inventory (x-program-id)
  // The program's boundary, control links, data inventory and vendor documents: each takes the optional trailing programId like the other scoped calls.

  /** GET /api/v1/program-inventory (any member): the boundary (`declared`: false means the whole register), control links and vendor documents of the program. */
  async getProgramInventory(tenantId: string, programId?: string | null): Promise<ProgramInventory> {
    const data = await authedJson<Partial<ProgramInventory>>('GET', '/program-inventory', { tenantId, programId });
    if (!Array.isArray(data?.toolIds) || !Array.isArray(data.controlLinks) || !Array.isArray(data.vendorDocuments) || typeof data.declared !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { programId: typeof data.programId === 'string' ? data.programId : '', declared: data.declared, toolIds: data.toolIds, controlLinks: data.controlLinks, vendorDocuments: data.vendorDocuments };
  },

  /** PATCH /api/v1/program-inventory/tools (write roles): tools to add to and remove from the boundary. 409 tool_in_use carries `inUse` unless `force` is true (which deletes the links too). */
  async patchProgramTools(tenantId: string, change: { add?: string[]; remove?: string[]; force?: boolean }, programId?: string | null): Promise<ProgramToolsResult> {
    const data = await authedJson<Partial<ProgramToolsResult>>('PATCH', '/program-inventory/tools', { tenantId, programId, body: change });
    if (!Array.isArray(data?.toolIds) || typeof data.declared !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return {
      programId: typeof data.programId === 'string' ? data.programId : '',
      declared: data.declared,
      toolIds: data.toolIds,
      added: typeof data.added === 'number' ? data.added : 0,
      removed: typeof data.removed === 'number' ? data.removed : 0,
      linksRemoved: typeof data.linksRemoved === 'number' ? data.linksRemoved : 0,
      cuiLinksRemoved: typeof data.cuiLinksRemoved === 'number' ? data.cuiLinksRemoved : 0,
    };
  },

  /** PUT /api/v1/program-inventory/tools/:toolId/controls (write roles): replaces the tool's control links in this program; expectedControlIds is the set last read (409 stale_write). */
  async putToolControls(tenantId: string, toolId: string, controls: Pick<ToolControlLink, 'controlId' | 'evidenceSource'>[], expectedControlIds: string[], programId?: string | null): Promise<ToolControlsResult> {
    const data = await authedJson<Partial<ToolControlsResult>>('PUT', `/program-inventory/tools/${encodeURIComponent(toolId)}/controls`, { tenantId, programId, body: { controls, expectedControlIds } });
    if (!Array.isArray(data?.controls)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { toolId: typeof data.toolId === 'string' ? data.toolId : toolId, controls: data.controls, changed: data.changed === true };
  },

  /** GET /api/v1/program-inventory/data-inventory (any member): FCI answer and CUI categories with the tools that store, process or transmit them. */
  async getDataInventory(tenantId: string, programId?: string | null): Promise<DataInventoryRecord> {
    const data = await authedJson<Partial<DataInventoryRecord>>('GET', '/program-inventory/data-inventory', { tenantId, programId });
    if (!Array.isArray(data?.categories)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { handlesFci: typeof data.handlesFci === 'boolean' ? data.handlesFci : null, categories: data.categories, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null, updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null };
  },

  /** PUT /api/v1/program-inventory/data-inventory (write roles): replaces the whole data inventory; expectedUpdatedAt is null for the first write, else the stamp last read (409 stale_write). */
  async putDataInventory(tenantId: string, input: Pick<DataInventoryRecord, 'handlesFci' | 'categories'>, expectedUpdatedAt: string | null, programId?: string | null): Promise<DataInventoryRecord & { changed: boolean }> {
    const data = await authedJson<Partial<DataInventoryRecord> & { changed?: boolean }>('PUT', '/program-inventory/data-inventory', { tenantId, programId, body: { handlesFci: input.handlesFci, categories: input.categories, expectedUpdatedAt } });
    if (!Array.isArray(data?.categories)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { handlesFci: typeof data.handlesFci === 'boolean' ? data.handlesFci : null, categories: data.categories, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null, updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null, changed: data.changed === true };
  },

  /** POST /api/v1/program-inventory/vendor-documents (write roles): links an evidence file of this program to a vendor as a CRM, SRM, contract or other document. */
  async linkVendorDocument(tenantId: string, link: { vendorId: string; evidenceId: string; docKind: VendorDocumentKind }, programId?: string | null): Promise<{ document: VendorDocumentLink; changed: boolean }> {
    const data = await authedJson<{ document?: VendorDocumentLink; changed?: boolean }>('POST', '/program-inventory/vendor-documents', { tenantId, programId, body: link });
    if (!data?.document || typeof data.document !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return { document: data.document, changed: data.changed === true };
  },

  /** DELETE /api/v1/program-inventory/vendor-documents/:vendorId/:evidenceId (write roles): removes the link only, never the evidence file. */
  async unlinkVendorDocument(tenantId: string, vendorId: string, evidenceId: string, programId?: string | null): Promise<void> {
    await authedJson('DELETE', `/program-inventory/vendor-documents/${encodeURIComponent(vendorId)}/${encodeURIComponent(evidenceId)}`, { tenantId, programId });
  },

  /** GET /api/v1/program-inventory/events: boundary, control-link, data-inventory and vendor-document history of the program (ids, counts and flags only), newest first. */
  async getProgramInventoryEvents(tenantId: string, limit?: number | null, programId?: string | null): Promise<ProgramInventoryEvent[]> {
    const data = await authedJson<{ events?: ProgramInventoryEvent[] }>('GET', `/program-inventory/events${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`, { tenantId, programId });
    if (!Array.isArray(data?.events)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.events;
  },

  // ------------------------------------------------------------------------------------------------------- document register
  // Tenant-wide (shared by every program): these take no programId. Titles, owners, locations and notes may be CUI: nothing here logs a value.

  /** GET /api/v1/tenants/:id/documents (any member). */
  async listDocuments(tenantId: string): Promise<{ documents: GovernanceDocument[]; limit: number }> {
    const data = await authedJson<{ documents?: GovernanceDocument[]; limit?: number }>('GET', `/tenants/${encodeURIComponent(tenantId)}/documents`, { tenantId });
    if (!Array.isArray(data?.documents)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { documents: data.documents, limit: typeof data.limit === 'number' ? data.limit : MAX_DOCUMENTS_PER_TENANT };
  },

  /** POST /api/v1/tenants/:id/documents (write roles): always a DRAFT. A generated draft carries origin 'GENERATED' and its seedKey (409 duplicate_seed names the existing document). 409 duplicate_title, 400 invalid_location, 429 limit. */
  async createDocument(tenantId: string, input: DocumentInput & { origin?: DocumentOrigin; seedKey?: string }): Promise<GovernanceDocument> {
    const data = await authedJson<{ document?: GovernanceDocument }>('POST', `/tenants/${encodeURIComponent(tenantId)}/documents`, { tenantId, body: input });
    if (!data?.document || typeof data.document !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.document;
  },

  /** PUT /api/v1/tenants/:id/documents/:documentId (write roles): the fields given change; expectedUpdatedAt is the stamp last read (409 stale_write). `approvalCleared` is true when the change withdrew the approval. */
  async updateDocument(tenantId: string, documentId: string, input: DocumentInput, expectedUpdatedAt: string): Promise<{ document: GovernanceDocument; changed: boolean; approvalCleared: boolean }> {
    const data = await authedJson<{ document?: GovernanceDocument; changed?: boolean; approvalCleared?: boolean }>('PUT', `/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(documentId)}`, { tenantId, body: { ...input, expectedUpdatedAt } });
    if (!data?.document || typeof data.document !== 'object' || typeof data.changed !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { document: data.document, changed: data.changed, approvalCleared: data.approvalCleared === true };
  },

  /** POST /api/v1/tenants/:id/documents/:documentId/approve (write roles): the approver is the signed-in person. 409 not_reviewed (generated or AI-assisted without confirmReviewed), retired, stale_write. */
  async approveDocument(tenantId: string, documentId: string, approval: { version: string; approvalDate: string; reviewBy?: string | null; confirmReviewed?: true }, expectedUpdatedAt: string): Promise<GovernanceDocument> {
    const data = await authedJson<{ document?: GovernanceDocument }>('POST', `/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(documentId)}/approve`, { tenantId, body: { ...approval, expectedUpdatedAt } });
    if (!data?.document || typeof data.document !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.document;
  },

  /** POST /api/v1/tenants/:id/documents/:documentId/status (write roles): DRAFT withdraws an approval (or reinstates a retired document); RETIRED retires it. */
  async setDocumentStatus(tenantId: string, documentId: string, status: 'DRAFT' | 'RETIRED', expectedUpdatedAt: string): Promise<GovernanceDocument> {
    const data = await authedJson<{ document?: GovernanceDocument }>('POST', `/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(documentId)}/status`, { tenantId, body: { status, expectedUpdatedAt } });
    if (!data?.document || typeof data.document !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.document;
  },

  /** DELETE /api/v1/tenants/:id/documents/:documentId (write roles): its links and attachments in every program go with it (the evidence files stay). */
  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(documentId)}`, { tenantId });
  },

  /** GET /api/v1/tenants/:id/documents/:documentId/usage: in how many programs the document is used and what goes with it (shown before a delete). */
  async getDocumentUsage(tenantId: string, documentId: string): Promise<{ programs: number; controlLinks: number; attachments: number; expectations: number }> {
    const data = await authedJson<{ programs?: number; controlLinks?: number; attachments?: number; expectations?: number }>('GET', `/tenants/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(documentId)}/usage`, { tenantId });
    if (typeof data?.programs !== 'number' || typeof data.controlLinks !== 'number' || typeof data.attachments !== 'number' || typeof data.expectations !== 'number') throw new ApiError(502, 'The server returned an unexpected response.');
    return { programs: data.programs, controlLinks: data.controlLinks, attachments: data.attachments, expectations: data.expectations };
  },

  // ------------------------------------------------------------------------------------------ program documents (x-program-id)
  // The program's document set, control links, attachments and expected-document links: each takes the optional trailing programId like the other scoped calls.

  /** GET /api/v1/program-documents (any member): the program's set (`declared`: false means every register document), control links, attachments and expected-document links. */
  async getProgramDocuments(tenantId: string, programId?: string | null): Promise<ProgramDocuments> {
    const data = await authedJson<Partial<ProgramDocuments>>('GET', '/program-documents', { tenantId, programId });
    if (!Array.isArray(data?.documentIds) || !Array.isArray(data.controlLinks) || !Array.isArray(data.attachments) || !Array.isArray(data.expectations) || typeof data.declared !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { programId: typeof data.programId === 'string' ? data.programId : '', declared: data.declared, documentIds: data.documentIds, controlLinks: data.controlLinks, attachments: data.attachments, expectations: data.expectations };
  },

  /** PATCH /api/v1/program-documents/documents (write roles): documents to add to and remove from the program's set. 409 document_in_use carries `inUse` unless `force` is true (which deletes the links too). */
  async patchProgramDocuments(tenantId: string, change: { add?: string[]; remove?: string[]; force?: boolean }, programId?: string | null): Promise<{ programId: string; declared: boolean; documentIds: string[]; added: number; removed: number }> {
    const data = await authedJson<{ programId?: string; declared?: boolean; documentIds?: string[]; added?: number; removed?: number }>('PATCH', '/program-documents/documents', { tenantId, programId, body: change });
    if (!Array.isArray(data?.documentIds) || typeof data.declared !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { programId: typeof data.programId === 'string' ? data.programId : '', declared: data.declared, documentIds: data.documentIds, added: typeof data.added === 'number' ? data.added : 0, removed: typeof data.removed === 'number' ? data.removed : 0 };
  },

  /** PUT /api/v1/program-documents/documents/:documentId/controls (write roles): replaces the document's control links in this program; expectedControlIds is the set last read (409 stale_write). */
  async putDocumentControls(tenantId: string, documentId: string, controlIds: string[], expectedControlIds: string[], programId?: string | null): Promise<{ documentId: string; controlIds: string[]; changed: boolean }> {
    const data = await authedJson<{ documentId?: string; controlIds?: string[]; changed?: boolean }>('PUT', `/program-documents/documents/${encodeURIComponent(documentId)}/controls`, { tenantId, programId, body: { controlIds, expectedControlIds } });
    if (!Array.isArray(data?.controlIds)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { documentId: typeof data.documentId === 'string' ? data.documentId : documentId, controlIds: data.controlIds, changed: data.changed === true };
  },

  /** POST /api/v1/program-documents/documents/:documentId/attachments (write roles): attaches an evidence file of this program; `primary` makes it the primary copy (the old one is demoted). Never uploads or copies the file. */
  async linkDocumentAttachment(tenantId: string, documentId: string, link: { evidenceId: string; primary?: boolean }, programId?: string | null): Promise<{ attachment: DocumentAttachment | null; changed: boolean }> {
    const data = await authedJson<{ attachment?: DocumentAttachment; changed?: boolean }>('POST', `/program-documents/documents/${encodeURIComponent(documentId)}/attachments`, { tenantId, programId, body: link });
    if (!data || typeof data !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return { attachment: data.attachment && typeof data.attachment === 'object' ? data.attachment : null, changed: data.changed === true };
  },

  /** PATCH /api/v1/program-documents/documents/:documentId/attachments/:evidenceId (write roles): makes the attachment the primary copy, or not. Resolves to the document's attachments. */
  async setDocumentAttachmentPrimary(tenantId: string, documentId: string, evidenceId: string, primary: boolean, programId?: string | null): Promise<DocumentAttachment[]> {
    const data = await authedJson<{ attachments?: DocumentAttachment[] }>('PATCH', `/program-documents/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(evidenceId)}`, { tenantId, programId, body: { primary } });
    if (!Array.isArray(data?.attachments)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.attachments;
  },

  /** DELETE /api/v1/program-documents/documents/:documentId/attachments/:evidenceId (write roles): removes the link only, never the evidence file. */
  async unlinkDocumentAttachment(tenantId: string, documentId: string, evidenceId: string, programId?: string | null): Promise<void> {
    await authedJson('DELETE', `/program-documents/documents/${encodeURIComponent(documentId)}/attachments/${encodeURIComponent(evidenceId)}`, { tenantId, programId });
  },

  /** PUT /api/v1/program-documents/expectations/:expectedId (write roles): replaces the documents a person says satisfy an expected document; expectedDocumentIds is the set last read (409 stale_write). */
  async putDocumentExpectation(tenantId: string, expectedId: string, documentIds: string[], expectedDocumentIds: string[], programId?: string | null): Promise<{ expectedId: string; documentIds: string[]; changed: boolean }> {
    const data = await authedJson<{ expectedId?: string; documentIds?: string[]; changed?: boolean }>('PUT', `/program-documents/expectations/${encodeURIComponent(expectedId)}`, { tenantId, programId, body: { documentIds, expectedDocumentIds } });
    if (!Array.isArray(data?.documentIds)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { expectedId: typeof data.expectedId === 'string' ? data.expectedId : expectedId, documentIds: data.documentIds, changed: data.changed === true };
  },

  /** POST /api/v1/tenants/:id/assets/bulk: up to 500 at a time; rows whose name already exists come back in `skipped`. */
  async createAssetsBulk(
    tenantId: string,
    assets: AssetInput[],
    sessionRef?: string
  ): Promise<{ created: EnclaveAsset[]; skipped: Array<{ index: number; hostName: string; reason: string }> }> {
    const data = await authedJson<{ created?: unknown; skipped?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/assets/bulk`, { sessionRef, tenantId, body: { assets } });
    return {
      created: parseServerAssets(data?.created),
      skipped: Array.isArray(data?.skipped) ? (data.skipped as Array<{ index: number; hostName: string; reason: string }>) : [],
    };
  },

  /** POST /api/v1/tenants/:id/assets/discovery: network-sensor findings, deduplicated by MAC / IP on the server. */
  async ingestDiscovery(
    tenantId: string,
    items: AccretionDiscoveryItem[],
    sessionRef?: string
  ): Promise<{ totalProcessed: number; newDiscoveredCount: number; updatedExistingCount: number; created: EnclaveAsset[] }> {
    const data = await authedJson<{ totalProcessed?: number; newDiscoveredCount?: number; updatedExistingCount?: number; created?: unknown }>(
      'POST',
      `/tenants/${encodeURIComponent(tenantId)}/assets/discovery`,
      { sessionRef, tenantId, body: { items } }
    );
    return {
      totalProcessed: Number(data?.totalProcessed ?? items.length),
      newDiscoveredCount: Number(data?.newDiscoveredCount ?? 0),
      updatedExistingCount: Number(data?.updatedExistingCount ?? 0),
      created: parseServerAssets(data?.created),
    };
  },

  /** GET /api/v1/tenants/:id/vm/config/scans (#103): configuration scans, tenant-wide (every role reads). `latest` keeps the newest scan per asset, source, benchmark and profile. */
  async listConfigScans(tenantId: string, options?: { assetId?: string; latest?: boolean; limit?: number }): Promise<{ totalCount: number; scans: VmConfigScan[] }> {
    const q = new URLSearchParams();
    if (options?.assetId) q.set('assetId', options.assetId);
    if (options?.latest) q.set('latest', 'true');
    if (options?.limit !== undefined) q.set('limit', String(options.limit));
    const qs = q.toString();
    const data = await authedJson<{ totalCount?: unknown; scans?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/config/scans${qs ? `?${qs}` : ''}`, { tenantId });
    return { totalCount: typeof data?.totalCount === 'number' ? data.totalCount : 0, scans: Array.isArray(data?.scans) ? (data.scans as VmConfigScan[]) : [] };
  },

  /** GET /api/v1/tenants/:id/vm/config/asset-summaries (#215): each asset's latest configuration scans summed and scored by the server, tenant-wide. */
  async listConfigAssetSummaries(tenantId: string, options?: { assetId?: string }): Promise<{ totalCount: number; summaries: VmAssetConfigSummary[] }> {
    const q = new URLSearchParams();
    if (options?.assetId) q.set('assetId', options.assetId);
    const qs = q.toString();
    const data = await authedJson<{ totalCount?: unknown; summaries?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/config/asset-summaries${qs ? `?${qs}` : ''}`, { tenantId });
    const summaries = Array.isArray(data?.summaries) ? (data.summaries as VmAssetConfigSummary[]) : [];
    return { totalCount: typeof data?.totalCount === 'number' ? data.totalCount : summaries.length, summaries };
  },

  /** GET /api/v1/tenants/:id/vm/config/scans/:scanId/results: the rule results of one scan, tenant-wide. */
  async getConfigScanResults(tenantId: string, scanId: string, options?: { result?: VmConfigResult; limit?: number }): Promise<{ totalCount: number; results: VmConfigRuleResultRow[] }> {
    const q = new URLSearchParams();
    if (options?.result) q.set('result', options.result);
    if (options?.limit !== undefined) q.set('limit', String(options.limit));
    const qs = q.toString();
    const data = await authedJson<{ totalCount?: unknown; results?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/config/scans/${encodeURIComponent(scanId)}/results${qs ? `?${qs}` : ''}`, { tenantId });
    return { totalCount: typeof data?.totalCount === 'number' ? data.totalCount : 0, results: Array.isArray(data?.results) ? (data.results as VmConfigRuleResultRow[]) : [] };
  },

  /** GET /api/v1/tenants/:id/vm/assets/:assetId/inventory: what each scanner currently reports about the asset. Tenant-wide; never cached in the browser. */
  async getObservedInventory(tenantId: string, assetId: string): Promise<{ observed: VmObservedHost[] }> {
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/assets/${encodeURIComponent(assetId)}/inventory`, { tenantId });
    return { observed: parseObservedHosts(data) };
  },

  /** GET /api/v1/tenants/:id/vm/assets/:assetId/software: the packages the scanners report for the asset, by name. Tenant-wide; never cached in the browser. */
  async listObservedSoftware(tenantId: string, assetId: string, options?: { sourceId?: string; limit?: number }): Promise<{ totalCount: number; items: VmObservedSoftware[] }> {
    const q = new URLSearchParams();
    if (options?.sourceId) q.set('sourceId', options.sourceId);
    if (options?.limit !== undefined) q.set('limit', String(options.limit));
    const qs = q.toString();
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/assets/${encodeURIComponent(assetId)}/software${qs ? `?${qs}` : ''}`, { tenantId });
    return parseObservedSoftware(data);
  },

  /** GET /api/v1/tenants/:id/vm/findings: vulnerability findings, tenant-wide (every role reads), most severe first. totalCount is the number returned: the server does not count past `limit` (max 1000). */
  async listVmFindings(tenantId: string, options?: { assetId?: string; severity?: VmSeverity; status?: VmFindingStatus; limit?: number }): Promise<{ totalCount: number; findings: VmFinding[] }> {
    const q = new URLSearchParams();
    if (options?.assetId) q.set('assetId', options.assetId);
    if (options?.severity) q.set('severity', options.severity);
    if (options?.status) q.set('status', options.status);
    if (options?.limit !== undefined) q.set('limit', String(options.limit));
    const qs = q.toString();
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/findings${qs ? `?${qs}` : ''}`, { tenantId });
    return parseVmFindings(data);
  },

  /** GET /api/v1/tenants/:id/vm/inventory/hosts for the program (x-program-id): what the scanners report for each asset of its boundary. Never cached in the browser. */
  async getProgramObservedHosts(tenantId: string, programId?: string | null): Promise<{ hosts: VmObservedHostWithAsset[] }> {
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/inventory/hosts`, { tenantId, programId });
    return { hosts: parseProgramObservedHosts(data) };
  },

  /** GET /api/v1/tenants/:id/vm/inventory/software for the program (x-program-id): the distinct packages the scanners report across its boundary (limit 1 to 20000). Never cached in the browser. */
  async listProgramObservedSoftware(tenantId: string, options?: { limit?: number }, programId?: string | null): Promise<{ totalGroups: number; truncated: boolean; items: VmObservedSoftwareGroup[] }> {
    const qs = options?.limit !== undefined ? `?limit=${encodeURIComponent(String(options.limit))}` : '';
    const data = await authedJson<unknown>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/inventory/software${qs}`, { tenantId, programId });
    return parseObservedSoftwareGroups(data);
  },

  /** GET /api/v1/tenants/:id/vm/config/suggestions for the program (x-program-id): computed on read, never written to a control. */
  async getConfigSuggestions(tenantId: string, programId?: string | null): Promise<VmConfigSuggestionsResponse> {
    return authedJson<VmConfigSuggestionsResponse>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/config/suggestions`, { tenantId, programId });
  },

  /** GET /api/v1/tenants/:id/vm/poam for the program (x-program-id): its POA&M items with their findings, and for the VM target program the upcoming deadlines. Every role reads; never cached in browser storage. */
  async getVmPoam(tenantId: string, options?: { status?: 'open' | 'all'; limit?: number; offset?: number; upcomingLimit?: number }, programId?: string | null): Promise<VmPoamResponse> {
    const q = new URLSearchParams();
    if (options?.status) q.set('status', options.status);
    if (options?.limit !== undefined) q.set('limit', String(options.limit));
    if (options?.offset !== undefined) q.set('offset', String(options.offset));
    if (options?.upcomingLimit !== undefined) q.set('upcomingLimit', String(options.upcomingLimit));
    const qs = q.toString();
    const data = await authedJson<VmPoamResponse>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/poam${qs ? `?${qs}` : ''}`, { tenantId, programId });
    if (!Array.isArray(data?.items) || !Array.isArray(data?.upcoming)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data;
  },

  /** GET /api/v1/tenants/:id/vm/poam/:itemId for the program (x-program-id): one item as a row of getVmPoam, whatever its status. Every role reads; 404 when it is not in that program. Never cached in browser storage. */
  async getVmPoamItem(tenantId: string, itemId: string, programId?: string | null): Promise<VmPoamRow> {
    const data = await authedJson<{ item?: VmPoamRow }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/poam/${encodeURIComponent(itemId)}`, { tenantId, programId });
    if (!data?.item || typeof data.item !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.item;
  },

  /** PATCH /api/v1/tenants/:id/vm/poam/:itemId for the program (x-program-id), write roles (Tenant Owner, Admin, MSP Admin): edits owner, mitigation, scheduled completion or status. `expectedUpdatedAt` is the item's updatedAt as loaded (409 reason `stale_write` when it changed). Other reasons: `finding_still_open`, `mitigation_required`, `invalid_poam_patch`, `program_archived`. Never cached in browser storage. */
  async updateVmPoamItem(tenantId: string, itemId: string, patch: VmPoamItemPatch, expectedUpdatedAt: string, programId?: string | null): Promise<{ item: VmPoamRow; changed: boolean }> {
    const data = await authedJson<{ item?: VmPoamRow; changed?: boolean }>('PATCH', `/tenants/${encodeURIComponent(tenantId)}/vm/poam/${encodeURIComponent(itemId)}`, { tenantId, programId, body: { ...patch, expectedUpdatedAt } });
    if (!data?.item || typeof data.item !== 'object' || typeof data.changed !== 'boolean') throw new ApiError(502, 'The server returned an unexpected response.');
    return { item: data.item, changed: data.changed };
  },

  /** GET /api/v1/tenants/:id/vm/poam/:itemId/events for the program (x-program-id): the item's history, newest first. Every role reads; statuses, dates and changed flags only. */
  async getVmPoamItemEvents(tenantId: string, itemId: string, programId?: string | null): Promise<VmPoamItemEvent[]> {
    const data = await authedJson<{ events?: VmPoamItemEvent[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/poam/${encodeURIComponent(itemId)}/events`, { tenantId, programId });
    if (!Array.isArray(data?.events)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.events;
  },

  /** GET /api/v1/tenants/:id/vm/remediation-policy (#268), tenant-wide, every role: the policy in force, where it comes from, the defaults and the fixed known-exploited rule. */
  async getVmRemediationPolicy(tenantId: string): Promise<VmRemediationPolicyResponse> {
    const data = await authedJson<VmRemediationPolicyResponse>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/remediation-policy`, { tenantId });
    if (typeof data?.policy !== 'object' || data.policy === null || typeof data.source !== 'string') throw new ApiError(502, 'The server returned an unexpected response.');
    return data;
  },

  /**
   * PUT /api/v1/tenants/:id/vm/remediation-policy (#268), owner-level access (Tenant Owner, MSP Admin). `expectedUpdatedAt` is the policy's updatedAt as loaded, or null while none is stored
   * (409 reason `stale_write` when it changed). Other reasons: `invalid_policy`, `owner_required`. Tenant-wide: the policy applies to every program.
   */
  async saveVmRemediationPolicy(tenantId: string, policy: VmRemediationPolicy, expectedUpdatedAt: string | null): Promise<VmPolicySaveResult> {
    const data = await authedJson<VmPolicySaveResult>('PUT', `/tenants/${encodeURIComponent(tenantId)}/vm/remediation-policy`, { tenantId, body: { ...policy, expectedUpdatedAt } });
    if (typeof data?.changed !== 'boolean' || typeof data.impact !== 'object' || data.impact === null) throw new ApiError(502, 'The server returned an unexpected response.');
    return data;
  },

  /** GET /api/v1/tenants/:id/vm/remediation-policy/events (#268), every role: the policy's change history, newest first (limit 1 to 100). */
  async getVmRemediationPolicyEvents(tenantId: string, limit = 50): Promise<VmPolicyEvent[]> {
    const data = await authedJson<{ events?: VmPolicyEvent[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/remediation-policy/events?limit=${encodeURIComponent(String(limit))}`, { tenantId });
    if (!Array.isArray(data?.events)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.events;
  },

  /** GET /api/v1/tenants/:id/vm/remediation/summary (#268), every role: counts of open findings per remediation tier, with the pending and expiring decisions. */
  async getVmRemediationSummary(tenantId: string): Promise<VmRemediationSummary> {
    const data = await authedJson<VmRemediationSummary>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/remediation/summary`, { tenantId });
    if (typeof data?.counts !== 'object' || data.counts === null) throw new ApiError(502, 'The server returned an unexpected response.');
    return data;
  },

  /**
   * POST /api/v1/tenants/:id/vm/findings/:findingId/decisions (#268), write roles: asks for a risk acceptance or a false-positive decision (state PENDING until an owner-level person approves it).
   * The justification is CUI-adjacent text: it is only sent, never cached or logged. Reasons: `invalid_decision`, `decision_pending`, `finding_not_open`, `not_found`.
   */
  async requestVmFindingDecision(tenantId: string, findingId: string, body: { kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE'; justification: string; expiresAt: string }): Promise<VmDecision> {
    const data = await authedJson<{ decision?: VmDecision }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/findings/${encodeURIComponent(findingId)}/decisions`, { tenantId, body });
    return requireVmDecision(data?.decision);
  },

  /** GET /api/v1/tenants/:id/vm/findings/:findingId/decisions (#268), every role: the finding's decisions, newest first (the justification is null for a Viewer). */
  async listVmFindingDecisions(tenantId: string, findingId: string): Promise<VmDecision[]> {
    const data = await authedJson<{ decisions?: VmDecision[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/findings/${encodeURIComponent(findingId)}/decisions`, { tenantId });
    if (!Array.isArray(data?.decisions)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.decisions;
  },

  /** GET /api/v1/tenants/:id/vm/decisions?state= (#268), every role: the organization's decisions, newest first, at most 500. */
  async listVmDecisions(tenantId: string, state: 'pending' | 'active' | 'expiring' | 'all'): Promise<VmDecision[]> {
    const data = await authedJson<{ decisions?: VmDecision[] }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/decisions?state=${encodeURIComponent(state)}`, { tenantId });
    if (!Array.isArray(data?.decisions)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.decisions;
  },

  /** POST /api/v1/tenants/:id/vm/decisions/:id/approve (#268): owner-level access, never the requester (reasons `self_approval_forbidden`, `owner_required`, `decision_not_pending`, `decision_expired`). */
  async approveVmDecision(tenantId: string, decisionId: string): Promise<VmDecision> {
    const data = await authedJson<{ decision?: VmDecision }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/decisions/${encodeURIComponent(decisionId)}/approve`, { tenantId });
    return requireVmDecision(data?.decision);
  },

  /** POST /api/v1/tenants/:id/vm/decisions/:id/reject (#268): owner-level access. */
  async rejectVmDecision(tenantId: string, decisionId: string): Promise<VmDecision> {
    const data = await authedJson<{ decision?: VmDecision }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/decisions/${encodeURIComponent(decisionId)}/reject`, { tenantId });
    return requireVmDecision(data?.decision);
  },

  /** POST /api/v1/tenants/:id/vm/decisions/:id/withdraw (#268): only the person who requested it (reason `not_requester`). */
  async withdrawVmDecision(tenantId: string, decisionId: string): Promise<VmDecision> {
    const data = await authedJson<{ decision?: VmDecision }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/decisions/${encodeURIComponent(decisionId)}/withdraw`, { tenantId });
    return requireVmDecision(data?.decision);
  },

  /** POST /api/v1/tenants/:id/vm/decisions/:id/revoke (#268): owner-level access, for a decision in force (reason `decision_not_active` otherwise). */
  async revokeVmDecision(tenantId: string, decisionId: string): Promise<VmDecision> {
    const data = await authedJson<{ decision?: VmDecision }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/decisions/${encodeURIComponent(decisionId)}/revoke`, { tenantId });
    return requireVmDecision(data?.decision);
  },

  /** GET /api/v1/control-poam for the program (x-program-id): the POA&M fields recorded for its controls (only controls with a stored entry). Every role reads; never cached in browser storage. */
  async listControlPoam(tenantId: string, programId?: string | null): Promise<{ entries: ControlPoamRecord[] }> {
    const data = await authedJson<{ entries?: ControlPoamRecord[] }>('GET', '/control-poam', { tenantId, programId });
    if (!Array.isArray(data?.entries)) throw new ApiError(502, 'The server returned an unexpected response.');
    return { entries: data.entries };
  },

  /**
   * PATCH /api/v1/control-poam/:controlId for the program (x-program-id), write roles (Tenant Owner, Admin, MSP Admin): records the owner, scheduled completion, required resources, plan
   * or milestones of a control. `expectedUpdatedAt` is the entry's updatedAt as loaded, or null when it has no entry yet (409 reason `stale_write` when it changed). Other reasons:
   * `invalid_control_poam_patch` (with the field name), `framework_not_enabled`, `program_archived`. `entry` is null when nothing was stored. Never cached in browser storage.
   */
  async updateControlPoam(tenantId: string, controlId: string, patch: ControlPoamPatch, expectedUpdatedAt: string | null, programId?: string | null): Promise<{ entry: ControlPoamRecord | null; changed: boolean }> {
    const data = await authedJson<{ entry?: ControlPoamRecord | null; changed?: boolean }>('PATCH', `/control-poam/${encodeURIComponent(controlId)}`, { tenantId, programId, body: { ...patch, expectedUpdatedAt } });
    if (typeof data?.changed !== 'boolean' || (data.entry !== null && (typeof data.entry !== 'object' || data.entry === undefined))) throw new ApiError(502, 'The server returned an unexpected response.');
    return { entry: data.entry, changed: data.changed };
  },

  /** GET /api/v1/control-poam/:controlId/events for the program (x-program-id): the control's POA&M history, newest first. Every role reads; flags, dates, counts and the control's status only. */
  async getControlPoamEvents(tenantId: string, controlId: string, programId?: string | null): Promise<ControlPoamEvent[]> {
    const data = await authedJson<{ events?: ControlPoamEvent[] }>('GET', `/control-poam/${encodeURIComponent(controlId)}/events`, { tenantId, programId });
    if (!Array.isArray(data?.events)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.events;
  },

  /** GET /api/v1/tenants/:id/vm/tokens (write roles: Tenant Owner, Admin, MSP Admin): the organization's service tokens, newest first. Never includes a token value. */
  async listVmTokens(tenantId: string): Promise<VmServiceToken[]> {
    const data = await authedJson<{ tokens?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/tokens`, { tenantId });
    if (!Array.isArray(data?.tokens)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.tokens as VmServiceToken[];
  },

  /** POST .../vm/tokens. The returned `token` is shown ONCE: the server keeps only its hash. */
  async createVmToken(tenantId: string, input: { name: string; expiresInDays: number }): Promise<{ token: string; record: VmServiceToken }> {
    const data = await authedJson<{ token?: unknown; record?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/tokens`, { tenantId, body: { name: input.name, scopes: ['vm:ingest'], expiresInDays: input.expiresInDays } });
    if (typeof data?.token !== 'string' || !data.token || !data.record || typeof data.record !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return { token: data.token, record: data.record as VmServiceToken };
  },

  /** POST .../vm/tokens/:id/revoke: idempotent; returns the revoked record. */
  async revokeVmToken(tenantId: string, tokenId: string): Promise<VmServiceToken> {
    const data = await authedJson<{ token?: unknown }>('POST', `/tenants/${encodeURIComponent(tenantId)}/vm/tokens/${encodeURIComponent(tokenId)}/revoke`, { tenantId, body: {} });
    if (!data?.token || typeof data.token !== 'object') throw new ApiError(502, 'The server returned an unexpected response.');
    return data.token as VmServiceToken;
  },

  /** GET /api/v1/tenants/:id/vm/sources: the scanners that have pushed (or been configured), tenant-wide. */
  async listVmSources(tenantId: string): Promise<VmSource[]> {
    const data = await authedJson<{ sources?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/sources`, { tenantId });
    if (!Array.isArray(data?.sources)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.sources as VmSource[];
  },

  /** GET /api/v1/tenants/:id/vm/runs?limit= (1 to 500): received runs, newest first, tenant-wide. The storage path is never served. */
  async listVmRuns(tenantId: string, limit: number): Promise<VmRun[]> {
    const data = await authedJson<{ runs?: unknown }>('GET', `/tenants/${encodeURIComponent(tenantId)}/vm/runs?limit=${encodeURIComponent(String(Math.min(500, Math.max(1, Math.trunc(limit) || 1))))}`, { tenantId });
    if (!Array.isArray(data?.runs)) throw new ApiError(502, 'The server returned an unexpected response.');
    return data.runs as VmRun[];
  },

  /** GET /api/v1/tenants/:id/invites (write roles: Tenant Owner, Admin, MSP Admin; the server limits which roles each caller may grant or manage). Never includes tokens. */
  async listInvites(tenantId: string, sessionRef?: string): Promise<ServerInvitation[]> {
    return parseServerInvitations(await authedJson('GET', `/tenants/${encodeURIComponent(tenantId)}/invites`, { sessionRef, tenantId }));
  },

  /** POST /api/v1/tenants/:id/invites. The returned `token` is shown ONCE: the server keeps only its hash. */
  async createInvite(
    tenantId: string,
    input: { email: string; role: TenantRole; expiresInDays?: number },
    sessionRef?: string
  ): Promise<{ invitation: ServerInvitation; token: string }> {
    return this.invitationWithToken(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites`, { sessionRef, tenantId, body: input }));
  },

  /** POST .../invites/:id/resend: a NEW token (the old link stops working) and a fresh expiry. */
  async resendInvite(tenantId: string, invitationId: string, expiresInDays?: number, sessionRef?: string): Promise<{ invitation: ServerInvitation; token: string }> {
    return this.invitationWithToken(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}/resend`, { sessionRef, tenantId, body: expiresInDays ? { expiresInDays } : {} }));
  },

  /** POST .../invites/:id/extend: pushes the expiry out; the link stays the same. */
  async extendInvite(tenantId: string, invitationId: string, days: number, sessionRef?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('POST', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}/extend`, { sessionRef, tenantId, body: { days } }));
  },

  /** PATCH .../invites/:id: edits the email or role of an unused invitation. */
  async updateInvite(tenantId: string, invitationId: string, patch: { email?: string; role?: TenantRole }, sessionRef?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('PATCH', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}`, { sessionRef, tenantId, body: patch }));
  },

  /** DELETE .../invites/:id: revokes. */
  async revokeInvite(tenantId: string, invitationId: string, sessionRef?: string): Promise<ServerInvitation> {
    return this.singleInvitation(await authedJson('DELETE', `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(invitationId)}`, { sessionRef, tenantId }));
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
  async acceptInvite(inviteToken: string, sessionRef?: string): Promise<{ tenantId: string; role: TenantRole; previousRole: TenantRole | null }> {
    return authedJson('POST', '/invites/accept', { sessionRef, body: { token: inviteToken } });
  },

  /**
   * POST /api/v1/auth/register-with-invite (air-gapped installs). Creates the account for the INVITED email, consumes
   * the invitation and signs the person in. 409 `account_exists` means: sign in instead. `systemUseAck` (the notice version read
   * on the sign-up screen) defaults to the one acknowledged in this tab; the server requires it while the system use notice is on.
   */
  async registerWithInvite(input: { token: string; password: string; name?: string; systemUseAck?: number }): Promise<RegisterOutcome> {
    const systemUseAck = input.systemUseAck ?? acknowledgedSystemUseNotice() ?? undefined;
    const res = await apiFetch(`${API_BASE_URL}/api/v1/auth/register-with-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(systemUseAck === undefined ? input : { ...input, systemUseAck }),
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
  async listMyTenants(sessionRef?: string): Promise<ServerTenant[] | null> {
    const result = await this.listMyTenantsResult(sessionRef);
    return result.kind === 'ok' ? result.tenants : null;
  },

  /**
   * Same request as listMyTenants, but says WHY there is nothing to load: 'rejected' (401, the session is dead) or
   * 'password_change_required' (the session is alive). Any other failure throws an ApiError that keeps its status
   * (0 = cannot reach the server), so the caller can tell an outage from a dead session.
   */
  async listMyTenantsResult(sessionRef?: string): Promise<ListMyTenantsResult> {
    const ref = sessionRef ?? this.getSessionRef();
    if (!ref) return { kind: 'rejected' };
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants`, {
      headers: { [SESSION_MARKER_HEADER]: ref },
    });
    if (res.status === 401) return { kind: 'rejected' };
    const body = res.ok ? null : await res.json().catch(() => null);
    // A temporary password must be changed first: nothing to load yet, and not an error (the change triggers a new sync)
    if (res.status === 403 && isPasswordChangeRequired(res.status, body)) return { kind: 'password_change_required' };
    if (!res.ok) throw apiErrorFromResponse(res.status, body);
    const listBody = await res.json();
    const expired = parseExpiredTenants(listBody);
    return { kind: 'ok', tenants: parseServerTenants(listBody), ...(expired.length ? { expiredTenants: expired } : {}) };
  },

  /**
   * GET /api/v1/me: whether the signed-in user is a platform administrator of THIS installation (decided by the server's
   * PLATFORM_ADMIN_EMAILS list). Resolves null when it cannot be determined, so the UI never assumes administrator rights.
   */
  async getPlatformStatus(sessionRef?: string): Promise<{ isPlatformAdmin: boolean } | null> {
    const ref = sessionRef ?? this.getSessionRef();
    if (!ref) return null;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/v1/me`, { headers: { [SESSION_MARKER_HEADER]: ref } });
      if (!res.ok) return null;
      const data = (await res.json()) as { isPlatformAdmin?: unknown };
      return { isPlatformAdmin: data.isPlatformAdmin === true };
    } catch {
      return null;
    }
  },

  /** GET /api/v1/platform/admins (platform administrators only): the addresses configured on the server. Null if refused. */
  async listPlatformAdmins(sessionRef?: string): Promise<string[] | null> {
    const ref = sessionRef ?? this.getSessionRef();
    if (!ref) return null;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/v1/platform/admins`, { headers: { [SESSION_MARKER_HEADER]: ref } });
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
    sessionRef?: string
  ): Promise<{ tenant: { id: string; name: string } & Record<string, unknown>; role: string }> {
    const ref = sessionRef ?? this.getSessionRef();
    if (!ref) throw new ApiError(401, 'You need to be signed in to create a tenant.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SESSION_MARKER_HEADER]: ref },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw apiErrorFromResponse(res.status, data);
    return data as { tenant: { id: string; name: string } & Record<string, unknown>; role: string };
  },

  /**
   * PATCH /api/v1/tenants/:tenantId
   * Updates tenant settings. Write roles only (Tenant Owner, Admin, MSP Admin); the licensed frameworks only a platform administrator may change. Throws ApiError.
   */
  async updateTenant(tenantId: string, patch: TenantSettingsInput, sessionRef?: string): Promise<void> {
    const ref = sessionRef ?? this.getSessionRef();
    if (!ref) throw new ApiError(401, 'You need to be signed in to change tenant settings.');
    const res = await apiFetch(`${API_BASE_URL}/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', [SESSION_MARKER_HEADER]: ref, 'x-tenant-id': tenantId },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => null));
  },

  /**
   * POST /api/v1/auth/login  (air-gapped installs, AUTH_MODE=local)
   * Resolves a session, or `{ kind: 'mfa' }` when a second step (a code, or enrolling a factor) comes next.
   * Throws an ApiError carrying the server's message (e.g. invalid credentials, account locked).
   * `systemUseAck` is the system use notice version the person read (issue #256); it defaults to the one acknowledged in this tab
   * (memory only), which is also what the session lock screen's password sign-in sends. Left out of the body when there is none.
   */
  async localLogin(email: string, password: string, systemUseAck: number | undefined = acknowledgedSystemUseNotice() ?? undefined): Promise<LocalLoginResult> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(systemUseAck === undefined ? { email, password } : { email, password, systemUseAck }),
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
    // From a session the server also replaces the session (the old one ends), so a session body is read on both paths
    if (mfaToken || (isRecord(data) && typeof data.sessionRef === 'string')) {
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
  async changePassword(currentPassword: string, newPassword: string, code?: string, sessionRef?: string): Promise<LocalLoginResponse> {
    const body: Record<string, string> = { currentPassword, newPassword };
    if (code) body.code = code;
    const result = parseLocalLoginResult(await accountJson<unknown>('POST', '/auth/password', { body, sessionRef }));
    if (result.kind !== 'session') throw new ApiError(502, 'The server sent back a sign-in response this version of the app does not understand.');
    const { kind: _kind, ...session } = result;
    return session;
  },

  // ---------------------------------------------------------------- local account administration (platform administrators)

  /** GET /api/v1/platform/users: the accounts and the inactivity period (#257; 0 = off, null when the server does not report it). */
  async listLocalUsersWithPolicy(): Promise<{ users: LocalAccount[]; dormantDays: number | null }> {
    const data = await accountJson<{ users?: unknown; dormantDays?: unknown }>('GET', '/platform/users');
    return { users: Array.isArray(data?.users) ? data.users.map(parseAccount) : [], dormantDays: parseDormantDays(data?.dormantDays) };
  },

  /** GET /api/v1/platform/users */
  async listLocalUsers(): Promise<LocalAccount[]> {
    return (await ApiClient.listLocalUsersWithPolicy()).users;
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

  /** GET /api/v1/platform/account-events (platform administrators): security changes to local accounts, newest first. `before` is the previous page's `nextBefore`. */
  async listAccountEvents(limit?: number, before?: string, filter?: AccountEventFilter): Promise<{ events: AccountEvent[]; nextBefore: string | null }> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (before) query.set('before', before);
    if (filter?.target) query.set('target', filter.target);
    if (filter?.action) query.set('action', filter.action);
    const qs = query.toString();
    const data = await accountJson<{ events?: unknown; nextBefore?: unknown }>('GET', `/platform/account-events${qs ? `?${qs}` : ''}`);
    const events = Array.isArray(data?.events) ? data.events.map(parseAccountEvent).filter((e): e is AccountEvent => e !== null) : [];
    const next = data?.nextBefore;
    return { events, nextBefore: typeof next === 'string' || typeof next === 'number' ? String(next) : null };
  },

  /** GET /api/v1/auth/system-use-notice: the notice shown before sign-in, { enabled, text, version }. Needs no session; throws when the answer is not understood. */
  async getSystemUseNotice(): Promise<SystemUseNotice> {
    const notice = parseSystemUseNotice(await accountJson<unknown>('GET', '/auth/system-use-notice', { anonymous: true }));
    if (!notice) throw new ApiError(502, 'The server sent back a system use notice this version of the app does not understand.');
    return notice;
  },

  /** GET /api/v1/platform/system-use-notice (platform administrators): the notice with its editing details. */
  async getPlatformSystemUseNotice(): Promise<PlatformSystemUseNotice> {
    return parsePlatformSystemUseNotice(await accountJson<unknown>('GET', '/platform/system-use-notice'));
  },

  /** PUT /api/v1/platform/system-use-notice (platform administrators, needs a fresh authenticator `code`): saves the notice and returns it. */
  async updatePlatformSystemUseNotice(input: { enabled: boolean; text: string; code: string }): Promise<PlatformSystemUseNotice> {
    return parsePlatformSystemUseNotice(await accountJson<unknown>('PUT', '/platform/system-use-notice', { body: input }));
  },

  /** GET /api/v1/me/notices: release notes read state and the active announcements for the signed-in person (account-level, no organization). */
  async getNotices(): Promise<NoticesSnapshot> {
    return parseNotices(await accountJson<unknown>('GET', '/me/notices'));
  },

  /** POST /api/v1/me/notices/read: marks a release version or an announcement as read for the signed-in person. */
  async markNoticeRead(kind: NoticeKind, ref: string): Promise<void> {
    await accountJson('POST', '/me/notices/read', { body: { kind, ref } });
  },

  /** GET /api/v1/platform/announcements (platform administrators): every announcement, with the limits the server enforces. */
  async listAnnouncementsAdmin(): Promise<{ announcements: AdminAnnouncement[]; limits: AnnouncementLimits }> {
    const data = await accountJson<unknown>('GET', '/platform/announcements');
    const rec = isRecord(data) ? data : {};
    return {
      announcements: Array.isArray(rec.announcements) ? rec.announcements.map(parseAdminAnnouncement).filter((a): a is AdminAnnouncement => a !== null) : [],
      limits: parseAnnouncementLimits(rec.limits),
    };
  },

  /** POST /api/v1/platform/announcements (platform administrators, needs a fresh authenticator `code`). */
  async postAnnouncement(input: { title: string; body: string; severity: NoticeSeverity; expiresAt: string | null }, code: string): Promise<AdminAnnouncement> {
    const body = { title: input.title, body: input.body, severity: input.severity, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), code };
    return parseAdminAnnouncementOrThrow(await accountJson<unknown>('POST', '/platform/announcements', { body }));
  },

  /** POST /api/v1/platform/announcements/:id/withdraw (platform administrators, needs a fresh authenticator `code`). */
  async withdrawAnnouncement(id: string, code: string): Promise<AdminAnnouncement> {
    return parseAdminAnnouncementOrThrow(await accountJson<unknown>('POST', `/platform/announcements/${encodeURIComponent(id)}/withdraw`, { body: { code } }));
  },

  /** GET /api/v1/auth/config: how long a session may sit idle, in seconds (0 = no limit), so the browser locks after the same period. Needs no session. */
  async getAuthConfig(): Promise<{ sessionIdleSeconds: number }> {
    const data = await accountJson<unknown>('GET', '/auth/config', { anonymous: true });
    return { sessionIdleSeconds: parseIdleSeconds(isRecord(data) ? data.sessionIdleSeconds : undefined) };
  },

  /** GET /api/v1/auth/me: a cheap authenticated request that keeps the server session from going idle while the person works. Never throws. */
  async heartbeat(): Promise<void> {
    try {
      await accountJson<unknown>('GET', '/auth/me');
    } catch {
      // a dead session is reported by the response signal; an outage is retried at the next beat
    }
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
  getSessionRef(): string | null {
    try {
      const ref = localStorage.getItem(SESSION_REF_KEY);
      // Another tab ended or replaced this tab's session: there is no reference to send (#32)
      const state = tabSessionState();
      if (isCrossTabReason(state)) {
        reportCrossTabEnd(tabSessionPin()?.ref, state);
        return null;
      }
      return ref;
    } catch {
      return null;
    }
  },

  /**
   * Constructs authorization and tenant context headers
   */
  getHeaders(tenantId: string, extraHeaders?: HeadersInit, programId?: string | null): HeadersInit {
    const sessionRef = this.getSessionRef();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
    };
    if (programId) headers['x-program-id'] = programId;

    if (sessionRef) {
      headers[SESSION_MARKER_HEADER] = sessionRef;
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
    const sessionRef = this.getSessionRef();
    if (!sessionRef) {
      throw new Error('Not authenticated: no active session');
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
    updates: Partial<ControlState> & { expectedUpdatedAt?: string | null },
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
        expectedUpdatedAt: updates.expectedUpdatedAt,
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
   * GET /api/v1/ssp-metadata
   * The program's SSP metadata (metadata null when no row yet); every role may read it
   */
  async getSspMetadata(tenantId: string, programId?: string | null): Promise<SspMetadataRecord> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * PUT /api/v1/ssp-metadata
   * Replaces the program's SSP metadata (write roles only: Tenant Owner, Admin, MSP Admin); expectedUpdatedAt is null for the first write, else the stamp last read
   */
  async putSspMetadata(tenantId: string, metadata: SspMetadataFields, expectedUpdatedAt: string | null, programId?: string | null): Promise<SspMetadataRecord & { changed: boolean }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ metadata, expectedUpdatedAt }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * GET /api/v1/ssp-metadata/profile
   * The program's SSP profile (categorization, system identifier, roles, maintenance; profile null when no row yet); every role may read it
   */
  async getSspProfile(tenantId: string, programId?: string | null): Promise<SspProfileRecord> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata/profile`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * PUT /api/v1/ssp-metadata/profile
   * Replaces the program's SSP profile (write roles only); expectedUpdatedAt is null for the first write, else the stamp last read
   */
  async putSspProfile(tenantId: string, profile: SspProfile, expectedUpdatedAt: string | null, programId?: string | null): Promise<SspProfileRecord & { changed: boolean }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata/profile`, {
      method: 'PUT',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ profile, expectedUpdatedAt }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * GET /api/v1/ssp-metadata/reviews
   * The sign-off state of each SSP section and the review history (newest first); every role may read it
   */
  async getSspReviews(tenantId: string, programId?: string | null): Promise<SspReviewsResponse> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata/reviews`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * POST /api/v1/ssp-metadata/reviews
   * Signs off one SSP section as the caller (write roles only); expectedDigest is the section digest last read, a changed section answers 409
   */
  async postSspReview(tenantId: string, sectionId: string, expectedDigest: string, programId?: string | null): Promise<{ review: SspSectionReview; section: SspSectionReviewState; changed: boolean }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/ssp-metadata/reviews`, {
      method: 'POST',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ sectionId, expectedDigest }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return res.json();
  },

  /**
   * PUT /api/v1/objectives/:objectiveId
   * Saves one objective (write roles only: Tenant Owner, Admin, MSP Admin); a field left out keeps its stored value, an empty narrative clears it
   */
  async putObjective(tenantId: string, input: ObjectiveInput & { expectedUpdatedAt?: string | null }, programId?: string | null): Promise<{ objective: ObjectiveRecord; changed: boolean; controls?: LoweredControl[] }> {
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
  async putObjectivesBulk(tenantId: string, objectives: ObjectiveInput[], programId?: string | null): Promise<{ total: number; changed: number; controls?: LoweredControl[] }> {
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
  async importObjectives(tenantId: string, objectives: ObjectiveInput[], programId?: string | null): Promise<{ objectiveId: string; result: ObjectiveImportResult }[] & { controls?: LoweredControl[] }> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives/import`, {
      method: 'POST',
      headers: this.getHeaders(tenantId, undefined, programId),
      body: JSON.stringify({ objectives }),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    const data = await res.json();
    // the per-id results stay a plain list; the Met controls the import lowered ride along as `controls` (#307)
    const results: { objectiveId: string; result: ObjectiveImportResult }[] = Array.isArray(data.results) ? data.results : [];
    return Array.isArray(data.controls) ? Object.assign(results, { controls: data.controls as LoweredControl[] }) : results;
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
   * GET /api/v1/objectives/catalog-update
   * The objective answers the CMMC Assessment Guide update set back to In progress (ids and statuses only, never narrative text)
   */
  async getCatalogUpdateChanges(tenantId: string, programId?: string | null): Promise<CatalogUpdateChanges> {
    const res = await apiFetch(`${API_BASE_URL}/api/v1/objectives/catalog-update`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, undefined, programId),
    });
    if (!res.ok) throw apiErrorFromResponse(res.status, await res.json().catch(() => ({ error: res.statusText })));
    return await res.json();
  },

  /**
   * GET /api/v1/evidence
   * Retrieves all evidence artifacts for the active tenant
   */
  async getEvidence(tenantId: string, programId?: string | null): Promise<EvidenceItem[]> {
    const sessionRef = this.getSessionRef();
    if (!sessionRef) {
      throw new Error('Not authenticated: no active session');
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
    sessionRef?: string | null
  ): Promise<{ provider: string; localStoragePath?: string; isAirGapped: boolean } | null> {
    // The caller can pass the session reference itself: right after sign-in it is not in browser storage yet.
    const res = await apiFetch(`${API_BASE_URL}/api/v1/evidence/config/storage-info`, {
      method: 'GET',
      headers: this.getHeaders(tenantId, sessionRef ? { [SESSION_MARKER_HEADER]: sessionRef } : undefined),
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
    const sessionRef = this.getSessionRef();
    if (sessionRef) {
      headers[SESSION_MARKER_HEADER] = sessionRef;
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
