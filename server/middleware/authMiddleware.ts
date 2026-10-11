import { Request, Response, NextFunction } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getTenantRole, isTenantMember } from '../db';
import { isTenantRole } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';

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

// Initialize Firebase Admin SDK if not already initialized
if (!getApps().length) {
  try {
    initializeApp({
      projectId: process.env.VITE_FIREBASE_PROJECT_ID || 'grc-tool-507203',
    });
    console.log('[Firebase Admin] Initialized successfully');
  } catch (err: unknown) {
    console.warn('[Firebase Admin] Initialization notice:', err instanceof Error ? err.message : err);
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
 * choose a tenant via the header; it is always false for real Firebase tokens.
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

/**
 * Validates incoming Firebase Authorization Bearer tokens (req.headers.authorization)
 * and attaches verified req.user and req.tenantId to the request.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
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

  const rawTenantHeader = req.headers['x-tenant-id'];
  const requestedTenantId = (Array.isArray(rawTenantHeader) ? rawTenantHeader[0] : rawTenantHeader)?.trim() || undefined;

  const mockAllowed = isMockAuthAllowed();

  try {
    // 1. Development / test mock tokens. Never accepted in production.
    if (mockAllowed && isMockToken(token)) {
      const identity = decodeMockToken(token);
      const tenantId = await resolveTenantId(res, identity, requestedTenantId, true);
      if (!tenantId) return;
      req.user = identity.user;
      req.tenantId = tenantId;
      req.tenantRole = await resolveTenantRole(identity, tenantId, true);
      return next();
    }

    // 2. Production Firebase ID Token verification
    const decodedToken = await getAuth().verifyIdToken(token);
    const identity = identityFromClaims(decodedToken as unknown as Record<string, unknown>, {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      name: decodedToken.name || (decodedToken.email ? decodedToken.email.split('@')[0] : 'Assessor'),
    });
    // The verified uid / email always win over any custom claim of the same name.
    identity.user.uid = decodedToken.uid;
    identity.user.email = decodedToken.email;

    const tenantId = await resolveTenantId(res, identity, requestedTenantId, false);
    if (!tenantId) return;

    req.user = identity.user;
    req.tenantId = tenantId;
    req.tenantRole = await resolveTenantRole(identity, tenantId, false);
    return next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Local dev without live GCP credentials: accept an unsigned JWT payload. Never in production.
    if (mockAllowed && token.includes('.')) {
      const payload = readJwtPayload(token);
      if (payload) {
        const identity = identityFromClaims(payload, {
          uid: 'user-dev-local',
          email: 'assessor@vanguard-defense.us',
          name: 'Compliance Assessor',
        });
        const tenantId = await resolveTenantId(res, identity, requestedTenantId, true);
        if (!tenantId) return;
        req.user = identity.user;
        req.tenantId = tenantId;
        req.tenantRole = await resolveTenantRole(identity, tenantId, true);
        return next();
      }
    }

    console.error('[AuthMiddleware] Token verification failed:', message);
    res.status(401).json({
      error: 'Unauthorized: Invalid or expired Firebase ID token',
    });
  }
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
