import { Request, Response } from 'express';
import { canRoleWrite } from '../../src/utils/roles';

/** The tenant in the URL must be the tenant the caller authenticated against (x-tenant-id / token claims). */
export function ensureActiveTenant(req: Request, res: Response): boolean {
  if (req.params.tenantId !== req.tenantId) {
    res.status(403).json({ error: 'Forbidden: the tenant in the URL does not match your active tenant' });
    return false;
  }
  return true;
}

/** For reads that expose administrative data (e.g. pending invitations): only owners / MSP admins. */
export function ensureTenantAdmin(req: Request, res: Response): boolean {
  if (!canRoleWrite(req.tenantRole)) {
    res.status(403).json({ error: 'Forbidden: only a Tenant Owner or MSP Admin can do that', role: req.tenantRole ?? null });
    return false;
  }
  return true;
}
