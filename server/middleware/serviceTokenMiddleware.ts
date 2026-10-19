import { Request, Response, NextFunction } from 'express';
import { lookupVmTokenByHash, sha256Hex, VM_TOKEN_PATTERN } from '../vm/tokens';
import { errorMessage } from '../../src/utils/errors';
import type { VmTokenScope } from '../../src/types/vm';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by serviceTokenMiddleware: the machine credential that authenticated this request (never a user session). */
      serviceToken?: { id: string; tenantId: string; scopes: VmTokenScope[] };
    }
  }
}

const UNAUTHORIZED = { error: 'Unauthorized: invalid service token' };

/**
 * Authenticates a machine caller (scanner exporter) by a `pbcvm_` bearer token and requires `requiredScope`.
 * Every failure before the scope check returns the same constant 401, so a caller cannot tell a malformed token from an
 * unknown, revoked or expired one. It sets req.tenantId and req.serviceToken, never req.user or req.tenantRole.
 */
export function serviceTokenMiddleware(requiredScope: VmTokenScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    if (!VM_TOKEN_PATTERN.test(token)) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    let record;
    try {
      record = await lookupVmTokenByHash(sha256Hex(token));
    } catch (err: unknown) {
      console.error('[VM Token] lookup failed:', errorMessage(err));
      res.status(500).json({ error: 'Failed to verify the service token' });
      return;
    }
    if (!record || record.revokedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }
    if (!record.scopes.includes(requiredScope)) {
      res.status(403).json({ error: 'insufficient_scope' });
      return;
    }

    req.tenantId = record.tenantId;
    req.serviceToken = { id: record.id, tenantId: record.tenantId, scopes: record.scopes };
    next();
  };
}
