import { Request, Response, NextFunction } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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
  } catch (err: any) {
    console.warn('[Firebase Admin] Initialization notice:', err.message);
  }
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

  // Determine requested tenant ID from x-tenant-id header
  const requestedTenantId = (req.headers['x-tenant-id'] as string)?.trim();

  try {
    // 1. Check for development / mock token support (for testing and local dev)
    if (token.startsWith('mock-test-jwt-') || token.includes('mock_pbc_signature')) {
      const parsedUser = decodeMockToken(token);
      req.user = parsedUser;
      req.tenantId = requestedTenantId || (parsedUser as any).tenantId || 'tenant-vanguard-01';
      return next();
    }

    // 2. Production Firebase ID Token verification
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      name: decodedToken.name || (decodedToken.email ? decodedToken.email.split('@')[0] : 'Assessor'),
      roles: (decodedToken.roles as Record<string, string>) || {},
    };

    // Resolve tenant ID: header takes precedence, then token claims
    const tenantId = requestedTenantId || (decodedToken.tenant_id as string) || (decodedToken.tenantId as string);

    if (!tenantId) {
      res.status(400).json({
        error: 'Tenant context required: Please provide x-tenant-id header or sign in with tenant assignment',
      });
      return;
    }

    req.tenantId = tenantId;
    return next();
  } catch (err: any) {
    // In local dev without live GCP credentials, decode payload gracefully if valid JWT structure
    if (process.env.NODE_ENV !== 'production' && token.includes('.')) {
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          req.user = {
            uid: payload.sub || payload.uid || 'user-dev-local',
            email: payload.email || 'assessor@vanguard-defense.us',
            name: payload.name || 'Compliance Assessor',
          };
          req.tenantId = requestedTenantId || payload.tenantId || 'tenant-vanguard-01';
          return next();
        }
      } catch (parseErr) {
        // Fall through to 401
      }
    }

    console.error('[AuthMiddleware] Token verification failed:', err.message);
    res.status(401).json({
      error: 'Unauthorized: Invalid or expired Firebase ID token',
      details: err.message,
    });
  }
}

function decodeMockToken(token: string) {
  if (token.includes('mock_pbc_signature')) {
    try {
      const payloadPart = token.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf8'));
      return {
        uid: payload.sub || 'user-alex-lead',
        email: payload.email || 'alex.mercer@vanguard-defense.us',
        name: 'Alex Mercer, CMMC CCA',
      };
    } catch {
      // Fallback
    }
  }

  return {
    uid: 'user-alex-lead',
    email: 'alex.mercer@vanguard-defense.us',
    name: 'Alex Mercer, CMMC CCA',
  };
}
