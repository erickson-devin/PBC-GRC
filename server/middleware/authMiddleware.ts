import { Request, Response, NextFunction } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getTenantRole, isTenantMember } from '../db';
import { isTenantRole } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';
import type { TenantRole } from '../../src/types/tenant';
import { LocalAuthConfigError, isLocalAuthMode, verifyLocalToken } from '../auth/localAuth';

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
      /** The authenticated user's role in `tenantId`; drives the write guard. */
      tenantRole?: TenantRole;
    }
  }
}

// Firebase Admin is only needed when verifying Firebase ID tokens. In AUTH_MODE=local nothing may reach Google.
if (!isLocalAuthMode() && !getApps().length) {
  try {
    initializeApp({
      projectId: process.env.VITE_FIREBASE_PROJECT_ID || 'grc-tool-507203',
    });
    console.log('[Firebase Admin] Initialized successfully');
  } catch (err: unknown) {
    console.warn('[Firebase Admin] Initialization notice:', errorMessage(err));
  }
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEV_FALLBACK_TENANT_ID = 'tenant-vanguard-01';

/**
 * Mock / unsigned-token support exists only for local development and automated tests.
 * It is never honoured when NODE_ENV === 'production'.
 */
function isMockAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
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
 * choose a tenant via the header; it is always false for real (Firebase / local) tokens.
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
  /** True for dev/test mock or unsigned tokens (never produced in production). */
  devMock: boolean;
}

/**
 * Turns a bearer token into an identity. Throws on any invalid token (callers answer 401).
 * Order: dev mock tokens (non-production only) -> local JWT (AUTH_MODE=local) -> Firebase ID token.
 */
async function authenticateToken(token: string): Promise<Authenticated> {
  const mockAllowed = isMockAuthAllowed();

  // 1. Development / test mock tokens. Never accepted in production.
  if (mockAllowed && isMockToken(token)) {
    return { identity: decodeMockToken(token), devMock: true };
  }

  // 2. Air-gapped local identity: verified with the local secret only, never contacting Google.
  if (isLocalAuthMode()) {
    const claims = verifyLocalToken(token);
    return {
      identity: identityFromClaims(claims as unknown as Record<string, unknown>, {
        uid: claims.sub,
        email: claims.email,
        name: claims.name,
      }),
      devMock: false,
    };
  }

  // 3. Production Firebase ID Token verification
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    const identity = identityFromClaims(decodedToken as unknown as Record<string, unknown>, {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      name: decodedToken.name || (decodedToken.email ? decodedToken.email.split('@')[0] : 'Assessor'),
    });
    // The verified uid / email always win over any custom claim of the same name.
    identity.user.uid = decodedToken.uid;
    identity.user.email = decodedToken.email;
    return { identity, devMock: false };
  } catch (err: unknown) {
    // Local dev without live GCP credentials: accept an unsigned JWT payload. Never in production.
    if (mockAllowed && token.includes('.')) {
      const payload = readJwtPayload(token);
      if (payload) {
        return {
          identity: identityFromClaims(payload, {
            uid: 'user-dev-local',
            email: 'assessor@vanguard-defense.us',
            name: 'Compliance Assessor',
          }),
          devMock: true,
        };
      }
    }
    throw err;
  }
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
    console.error('[AuthMiddleware] Token verification failed:', errorMessage(err));
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  const { identity, devMock } = authenticated;
  req.user = identity.user;

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
 * Validates incoming Authorization Bearer tokens (Firebase ID token, or a local JWT when AUTH_MODE=local) and
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
