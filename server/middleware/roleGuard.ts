import { Request, Response, NextFunction } from 'express';
import { canRoleWrite } from '../../src/utils/roles';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects every state-changing request (POST / PUT / PATCH / DELETE) with 403 unless the
 * authenticated user's role in the active tenant is TENANT_OWNER or MSP_ADMIN.
 * Must run after authMiddleware, which sets req.tenantRole. A missing role is treated as read-only.
 */
export function requireWriteRole(req: Request, res: Response, next: NextFunction): void {
  if (READ_ONLY_METHODS.has(req.method)) {
    next();
    return;
  }

  if (!canRoleWrite(req.tenantRole)) {
    console.warn(
      `[RoleGuard] Denied ${req.method} ${req.originalUrl}: role ${req.tenantRole ?? 'none'} is read-only in tenant ${req.tenantId}`
    );
    res.status(403).json({
      error: 'Forbidden: your role in this tenant is read-only. Only a Tenant Owner or MSP Admin can modify data.',
      role: req.tenantRole ?? null,
    });
    return;
  }

  next();
}
