import { Request, Response, NextFunction } from 'express';
import { getTenantRole, isTenantMember } from '../db';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import type { TenantRole } from '../../src/types/tenant';
import type { Program } from '../programs';
import { LocalAuthConfigError, LocalTokenError, verifyLocalToken } from '../auth/localAuth';
import { getLocalUserAuthState } from '../auth/localUsers';

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
 * and is never honoured when NODE_ENV === 'production' (startup also refuses that combination). Read per request.
 */
function isMockAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_MOCK_TOKENS === 'true';
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

interface Authenticated {
  identity: TokenIdentity;
  /** True for dev/test mock tokens (never produced in production). */
  devMock: boolean;
  /** The account is flagged to change its password before doing anything else (never true for mock tokens). */
  mustChangePassword: boolean;
}

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
  // One primary-key read per request: a password change, a disable and an MFA reset bump token_version, which ends every older session.
  // Tokens minted before the upgrade carry no `ver` and count as version 0.
  const state = await getLocalUserAuthState(claims.sub);
  if (!state || state.disabled || (claims.ver ?? 0) !== state.tokenVersion) {
    throw new LocalTokenError('Session is no longer valid');
  }
  return {
    identity: identityFromClaims(claims as unknown as Record<string, unknown>, {
      uid: claims.sub,
      email: claims.email,
      name: claims.name,
    }),
    devMock: false,
    mustChangePassword: state.mustChangePassword,
  };
}

async function handle(req: Request, res: Response, next: NextFunction, requireTenant: boolean): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized: Missing or invalid Authorization Bearer header',
    });
    return;
  }

  const token = authHeader.split('Bearer ')[1]?.trim();

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Empty bearer token' });
    return;
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
    console.error('[AuthMiddleware] Token verification failed:', errorMessage(err));
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
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
 * Validates incoming Authorization Bearer tokens (locally signed JWTs) and
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
