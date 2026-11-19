import { Request, Response } from 'express';
import { canRoleWrite, isOwnerLevel, isTenantRole, ROLE_LABELS } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';

/** The tenant in the URL must be the tenant the caller authenticated against (x-tenant-id / token claims). */
export function ensureActiveTenant(req: Request, res: Response): boolean {
  if (req.params.tenantId !== req.tenantId) {
    res.status(403).json({ error: 'Forbidden: the tenant in the URL does not match your active tenant' });
    return false;
  }
  return true;
}

/** For reads that expose administrative data (e.g. pending invitations): the write roles (Owner, Admin, MSP Admin). */
export function ensureTenantAdmin(req: Request, res: Response): boolean {
  if (!canRoleWrite(req.tenantRole)) {
    res.status(403).json({ error: 'Forbidden: only a Tenant Owner, Admin or MSP Admin can do that', role: req.tenantRole ?? null });
    return false;
  }
  return true;
}

/** For actions kept to the owner level (e.g. deleting a program): a Tenant Owner or MSP Admin, not a plain Admin. */
export function ensureOwnerRole(req: Request, res: Response): boolean {
  if (!isOwnerLevel(req.tenantRole)) {
    res.status(403).json({
      error: 'Forbidden: only a Tenant Owner or MSP Admin can do that',
      code: 'owner_required',
      role: req.tenantRole ?? null,
    });
    return false;
  }
  return true;
}

/** "an Admin", "a Tenant Owner": the article follows the label's first letter ("MSP" is read letter by letter: "an MSP Admin"). */
function withArticle(role: TenantRole): string {
  const label = ROLE_LABELS[role];
  return (/^(?:[AEIOU]|MSP\b)/i.test(label) ? 'an ' : 'a ') + label;
}

/** Refusal for a member or invitation change the caller's role may not make (the 403 body; the caller sends it). */
export function roleNotGrantableBody(actor: TenantRole | null | undefined, target: TenantRole) {
  const who = actor != null && isTenantRole(actor) ? withArticle(actor) : 'your role';
  return {
    error: `Forbidden: ${who} cannot grant, change or remove ${withArticle(target)} role`,
    code: 'role_not_grantable',
    role: actor ?? null,
  };
}
