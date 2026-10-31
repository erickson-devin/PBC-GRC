import { Request, Response, NextFunction } from 'express';
import { getTenantRole, isTenantMember } from '../db';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import type { TenantRole } from '../../src/types/tenant';
import type { Program } from '../programs';
import { LocalAuthConfigError, LocalTokenError, getMfaRequirement, getSessionIdleMinutes, verifyLocalToken } from '../auth/localAuth';
import { adoptSession, getSessionAuthState, getTouchedLastSeen, revokeSession, sessionNowMs, touchSession } from '../auth/sessionStore';
import { accountLogRef } from '../auth/loginThrottle';
import { recordAccountEventBestEffort } from '../auth/accountEvents';
import { mfaRequiredNow } from '../auth/mfaEnforcement';
import { CSRF_REJECTED, SESSION_MISMATCH, clearSessionCookie, hasSessionMarker, isCrossSiteRequest, markerMatchesSession, readSessionCookie, readSessionMarker } from '../auth/session';
import { isNonProductionEnv } from '../runtimeEnv';

// Extend Express Request interface with authenticated user & tenant context
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        name?: string;
        roles?: Record<string, string>;
      };
      tenantId?: string;
      /** Every tenant id the token itself grants access to (tenant_id / tenantId / tenant_ids / roles keys). */
      claimedTenantIds?: string[];
      /** The authenticated user's role in `tenantId`; drives the write guard. */
      tenantRole?: TenantRole;
      /** The program (authorization boundary) the request runs in; set by the program-context middleware, not by authentication. */
      programId?: string;
      program?: Program;
    }
  }
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEV_FALLBACK_TENANT_ID = 'tenant-vanguard-01';
/** The one request a session flagged must_change_password may make (compared with req.baseUrl + req.path). */
const PASSWORD_CHANGE_PATH = '/api/v1/auth/password';

/**
 * Mock-token support exists only for local development and automated tests: it needs ALLOW_DEV_MOCK_TOKENS=true
 * and is honoured only when NODE_ENV is development or test (an unset or unknown NODE_ENV counts as production; startup also
 * refuses that combination). Read per request.
 */
function isMockAuthAllowed(): boolean {
  return isNonProductionEnv() && process.env.ALLOW_DEV_MOCK_TOKENS === 'true';
}

function isMockToken(token: string): boolean {
  return token.startsWith('mock-test-jwt-') || token.includes('mock_pbc_signature');
}

interface TokenIdentity {
  user: NonNullable<Request['user']>;
  /** Tenant IDs the token itself asserts membership of (claims). */
  claimedTenantIds: Set<string>;
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Collects every tenant ID asserted by token claims (tenant_id, tenantId, tenant_ids, roles map keys). */
function extractTenantClaims(claims: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && TENANT_ID_PATTERN.test(value)) ids.add(value);
  };

  add(claims.tenant_id);
  add(claims.tenantId);
  for (const key of ['tenant_ids', 'tenantIds']) {
    const list = claims[key];
    if (Array.isArray(list)) list.forEach(add);
  }
  if (claims.roles && typeof claims.roles === 'object' && !Array.isArray(claims.roles)) {
    Object.keys(claims.roles as Record<string, unknown>).forEach(add);
  }
  return ids;
}

function rolesFromClaims(claims: Record<string, unknown>): Record<string, string> {
  if (!claims.roles || typeof claims.roles !== 'object' || Array.isArray(claims.roles)) return {};
  const out: Record<string, string> = {};
  for (const [tenant, role] of Object.entries(claims.roles as Record<string, unknown>)) {
    if (typeof role === 'string') out[tenant] = role;
  }
  return out;
}

function identityFromClaims(
  claims: Record<string, unknown>,
  defaults: { uid: string; email: string; name: string }
): TokenIdentity {
  return {
    user: {
      uid: (typeof claims.sub === 'string' && claims.sub) || (typeof claims.uid === 'string' && claims.uid) || defaults.uid,
      email: typeof claims.email === 'string' ? claims.email : defaults.email,
      name: typeof claims.name === 'string' ? claims.name : defaults.name,
      roles: rolesFromClaims(claims),
    },
    claimedTenantIds: extractTenantClaims(claims),
  };
}

/**
 * Resolves the tenant for this request. The x-tenant-id header is only a *selector*:
 * the authenticated user must actually belong to the tenant, via a token claim or a
 * tenant_users membership row. Returns null (after writing the error response) on failure.
 *
 * `allowUnscopedDev` lets dev-only mock tokens that carry no tenant claims at all
 * choose a tenant via the header; it is always false for real (local) tokens.
 */
async function resolveTenantId(
  res: Response,
  identity: TokenIdentity,
  requestedTenantId: string | undefined,
  allowUnscopedDev: boolean
): Promise<string | null> {
  const { claimedTenantIds, user } = identity;

  if (requestedTenantId) {
    if (!TENANT_ID_PATTERN.test(requestedTenantId)) {
      res.status(400).json({ error: 'Invalid x-tenant-id header format' });
      return null;
    }
    const permitted =
      claimedTenantIds.has(requestedTenantId) ||
      (allowUnscopedDev && claimedTenantIds.size === 0) ||
      (await isTenantMember(user.uid, requestedTenantId));

    if (!permitted) {
      console.warn(`[AuthMiddleware] Denied: user ${user.uid} is not a member of tenant ${requestedTenantId}`);
      res.status(403).json({ error: 'Forbidden: authenticated user does not belong to the requested tenant' });
      return null;
    }
    return requestedTenantId;
  }

  if (claimedTenantIds.size === 1) {
    return [...claimedTenantIds][0];
  }
  if (claimedTenantIds.size === 0 && allowUnscopedDev) {
    return DEV_FALLBACK_TENANT_ID;
  }

  res.status(400).json({
    error: 'Tenant context required: Please provide x-tenant-id header or sign in with tenant assignment',
  });
  return null;
}

/**
 * Resolves the user's role in the active tenant. Order: token `roles` claim, then tenant_users row.
 * Fails closed to read-only VIEWER. The one exception is dev/test mock tokens (never in production),
 * which carry no role claim and default to TENANT_OWNER so local development keeps working.
 */
async function resolveTenantRole(identity: TokenIdentity, tenantId: string, devMockToken: boolean): Promise<TenantRole> {
  const claimed = identity.user.roles?.[tenantId];
  if (isTenantRole(claimed)) return claimed;

  const stored = await getTenantRole(identity.user.uid, tenantId);
  if (stored) return stored;

  return devMockToken && isMockAuthAllowed() ? 'TENANT_OWNER' : 'VIEWER';
}

/** 401 body for an account that vanished, was disabled or had its sessions revoked after the token passed verification. */
export const SESSION_REVOKED = { error: 'Unauthorized: Invalid or expired token', reason: 'session_revoked' } as const;

interface Authenticated {
  identity: TokenIdentity;
  /** True for dev/test mock tokens (never produced in production). */
  devMock: boolean;
  /** The account is flagged to change its password before doing anything else (never true for mock tokens). */
  mustChangePassword: boolean;
  /** The token's session id (the sessionRef the SPA sends as its marker); absent for mock tokens. */
  sid?: string;
  /** The token's authentication methods (['pwd'] or ['pwd', 'otp']); absent for mock tokens. */
  amr?: string[];
}

/** 401 body for a session that ended because it was idle for longer than SESSION_IDLE_MINUTES. */
export const SESSION_IDLE = { error: 'Unauthorized: the session ended after a period of inactivity', reason: 'session_idle' } as const;

/** 401 body for a session without a second factor whose account now needs one (a role was raised after sign-in). */
export const MFA_REQUIRED_NOW = { error: 'Unauthorized: your role now requires two-step verification. Sign in again.', reason: 'mfa_required' } as const;

/**
 * Turns a bearer token into an identity. Throws on any invalid token (callers answer 401).
 * Order: dev mock tokens (non-production, opt-in only) -> local JWT.
 */
async function authenticateToken(token: string): Promise<Authenticated> {
  const mockAllowed = isMockAuthAllowed();

  // 1. Development / test mock tokens. Never accepted in production.
  if (mockAllowed && isMockToken(token)) {
    return { identity: decodeMockToken(token), devMock: true, mustChangePassword: false };
  }

  // 2. Local identity: verified with the local secret only, never contacting any external service.
  const claims = verifyLocalToken(token);
  // One joined read per request (the account and its session row): a password change, a disable and an MFA reset bump token_version, which
  // ends every older session; a sign-out and the idle timeout end a single session. Tokens minted before the upgrade carry no `ver` and count as version 0.
  const state = await getSessionAuthState(claims.sub, claims.sid);
  if (!state || state.disabled || (claims.ver ?? 0) !== state.tokenVersion) {
    throw new LocalTokenError('Session is no longer valid', 'revoked');
  }
  if (!claims.sid) throw new LocalTokenError('Session is no longer valid', 'revoked');
  const now = sessionNowMs();
  const amr = claims.amr ?? [];
  if (state.session === null) {
    // A validly signed token with no row (issued before sessions were recorded): adopt it, counted as active now.
    await adoptSession({ sid: claims.sid, userId: claims.sub, issuedAt: claims.iat, expiresAt: claims.exp, mfaVerified: amr.includes('otp') });
  } else {
    if (state.session.revokedReason !== null) {
      throw new LocalTokenError('Session is no longer valid', state.session.revokedReason === 'idle' ? 'idle' : 'revoked');
    }
    const idleMinutes = getSessionIdleMinutes();
    const lastSeen = Math.max(state.session.lastSeenMs, getTouchedLastSeen(claims.sid) ?? 0);
    if (idleMinutes > 0 && now - lastSeen > idleMinutes * 60_000) {
      await revokeSession(claims.sid, 'idle');
      throw new LocalTokenError('Session is no longer valid', 'idle');
    }
  }
  try {
    await touchSession(claims.sid, now);
  } catch {
    // The in-process time is already current; a failed write only means the database value is older until the next request.
    console.error('[AuthMiddleware] Session touch failed');
  }
  return {
    identity: identityFromClaims(claims as unknown as Record<string, unknown>, {
      uid: claims.sub,
      email: claims.email,
      name: claims.name,
    }),
    devMock: false,
    mustChangePassword: state.mustChangePassword,
    sid: claims.sid,
    amr: claims.amr,
  };
}

async function handle(req: Request, res: Response, next: NextFunction, requireTenant: boolean): Promise<void> {
  const authHeader = req.headers.authorization;
  const viaCookie = authHeader === undefined;
  let token: string | null | undefined;

  if (authHeader !== undefined) {
    // An Authorization header means a script or integration: the cookie is not consulted at all.
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized: Missing or invalid Authorization Bearer header',
        reason: 'session_missing',
      });
      return;
    }

    token = authHeader.split('Bearer ')[1]?.trim();

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Empty bearer token', reason: 'session_missing' });
      return;
    }
  } else {
    token = readSessionCookie(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: no session', reason: 'session_missing' });
      return;
    }
    // A browser attaches the cookie to any request it is made to send: the marker header and Sec-Fetch-Site prove this one came from the SPA.
    if (!hasSessionMarker(req) || isCrossSiteRequest(req)) {
      res.status(403).json(CSRF_REJECTED);
      return;
    }
  }

  let authenticated: Authenticated;
  try {
    authenticated = await authenticateToken(token);
  } catch (err: unknown) {
    if (err instanceof LocalAuthConfigError) {
      console.error('[AuthMiddleware] Local auth is misconfigured:', err.message);
      res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
      return;
    }
    if (!(err instanceof LocalTokenError)) {
      // The token was fine but the account lookup failed (database error): 503, so an outage does not sign everyone out.
      console.error('[AuthMiddleware] Account lookup failed:', errorMessage(err));
      res.status(503).json({ error: 'Authentication is temporarily unavailable' });
      return;
    }
    const reason =
      err.code === 'expired' ? 'session_expired' : err.code === 'revoked' ? 'session_revoked' : err.code === 'idle' ? 'session_idle' : 'session_invalid';
    if (reason === 'session_idle' || reason === 'session_revoked') {
      // Never a session id, email or cookie value: the reason code says everything a reader of the log needs.
      console.error(`[AuthMiddleware] Session refused (${reason})`);
      if (viaCookie) clearSessionCookie(req, res);
      res.status(401).json(reason === 'session_idle' ? SESSION_IDLE : SESSION_REVOKED);
      return;
    }
    console.error('[AuthMiddleware] Token verification failed:', errorMessage(err));
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token', reason });
    return;
  }

  // The marker must name the session the cookie holds: a tab whose session was replaced by another sign-in in this browser is refused.
  // This runs after authentication, so a revoked or expired cookie keeps its own reason. Dev mock tokens carry no sid and are exempt.
  if (viaCookie && !authenticated.devMock && !markerMatchesSession(readSessionMarker(req), authenticated.sid)) {
    res.status(401).json(SESSION_MISMATCH);
    return;
  }

  // Privilege raised mid-session (issue #39): a session that passed with the password only is refused once the account needs a second
  // factor (a role was raised after sign-in). Applies in any MFA mode except off; the person signs in again and is walked through enrolment.
  if (!authenticated.devMock && authenticated.sid) {
    let refuse = false;
    try {
      const email = authenticated.identity.user.email ?? '';
      if (getMfaRequirement() !== 'off' && !(authenticated.amr ?? []).includes('otp')) {
        refuse = await mfaRequiredNow({ id: authenticated.identity.user.uid, email });
      }
    } catch (err: unknown) {
      if (err instanceof LocalAuthConfigError) {
        console.error('[AuthMiddleware] Local auth is misconfigured:', err.message);
        res.status(503).json({ error: 'Authentication is not available: server is misconfigured' });
        return;
      }
      console.error('[AuthMiddleware] Account lookup failed:', errorMessage(err));
      res.status(503).json({ error: 'Authentication is temporarily unavailable' });
      return;
    }
    if (refuse) {
      const uid = authenticated.identity.user.uid;
      try {
        await revokeSession(authenticated.sid, 'mfa_required');
      } catch {
        console.error('[AuthMiddleware] Session revoke failed');
      }
      await recordAccountEventBestEffort({ actorKind: 'system', actorUserId: null, targetUserId: uid, action: 'session_revoked', details: { reason: 'mfa_required' } });
      console.error(`[AuthMiddleware] Session refused (mfa_required): account ${accountLogRef(authenticated.identity.user.email ?? '')}`);
      if (viaCookie) clearSessionCookie(req, res);
      res.status(401).json(MFA_REQUIRED_NOW);
      return;
    }
  }

  // A forced password change (temporary password after an admin reset or a CLI-created account) leaves exactly one
  // request open: POST /api/v1/auth/password.
  if (authenticated.mustChangePassword && !(req.method === 'POST' && req.baseUrl + req.path === PASSWORD_CHANGE_PATH)) {
    res.status(403).json({ error: 'You must change your password before continuing', reason: 'password_change_required' });
    return;
  }

  const { identity, devMock } = authenticated;
  req.user = identity.user;
  req.claimedTenantIds = [...identity.claimedTenantIds];

  // Authenticate-only routes (e.g. creating the first tenant): the caller has no tenant yet.
  if (!requireTenant) {
    next();
    return;
  }

  const rawTenantHeader = req.headers['x-tenant-id'];
  const requestedTenantId = (Array.isArray(rawTenantHeader) ? rawTenantHeader[0] : rawTenantHeader)?.trim() || undefined;

  try {
    const tenantId = await resolveTenantId(res, identity, requestedTenantId, devMock);
    if (!tenantId) return;

    req.tenantId = tenantId;
    req.tenantRole = await resolveTenantRole(identity, tenantId, devMock);
    next();
  } catch (err: unknown) {
    console.error('[AuthMiddleware] Tenant resolution failed:', errorMessage(err));
    res.status(500).json({ error: 'Failed to resolve tenant context' });
  }
}

/**
 * Validates the session (a locally signed JWT) from the Authorization Bearer header, or, when there is no Authorization header,
 * from the HttpOnly session cookie (which also needs the X-PBC-Session marker, equal to the cookie session's sid, and a same-origin Sec-Fetch-Site), and
 * attaches the verified req.user, plus req.tenantId / req.tenantRole after checking tenant membership.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(req, res, next, true);
}

/** Authenticates the caller but does not require or resolve a tenant. */
export function authOnlyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  return handle(req, res, next, false);
}

function decodeMockToken(token: string): TokenIdentity {
  const defaults = {
    uid: 'user-alex-lead',
    email: 'alex.mercer@vanguard-defense.us',
    name: 'Alex Mercer, CMMC CCA',
  };
  const payload = readJwtPayload(token);
  if (!payload) {
    return { user: { ...defaults, roles: {} }, claimedTenantIds: new Set() };
  }
  return identityFromClaims(payload, defaults);
}
