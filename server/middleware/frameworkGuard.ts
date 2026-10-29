import { Request, Response } from 'express';
import { getTenantFrameworkPolicy, TenantFrameworkPolicy } from '../db';
import { getFrameworkControls } from '../../src/data/frameworks';
import type { ComplianceFramework } from '../../src/types/framework';

/**
 * Framework segregation. A tenant has a framework policy (its primary framework plus any others a platform
 * administrator enabled for it) and the API only serves what is inside that policy: a tenant provisioned for CMMC Level 2
 * cannot read, score or attach evidence to NIST SP 800-53 (or SOC 2, HIPAA, ...) controls just by asking for them.
 *
 * A tenant with no tenant record (development fallback / unknown id) has no policy to enforce and is left alone.
 */
const INDEXED_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];

let controlIndex: Map<string, Set<string>> | null = null;

/** Which frameworks define a control id. An id can sit in several (CMMC Level 2 includes the Level 1 practices). */
export function frameworksDefiningControl(controlId: string): Set<string> {
  if (!controlIndex) {
    controlIndex = new Map();
    for (const fw of INDEXED_FRAMEWORKS) {
      // The whole catalog, whatever baseline a tenant has chosen: a control outside it is still a known control
      for (const c of getFrameworkControls(fw)) {
        const key = c.id.toUpperCase();
        if (!controlIndex.has(key)) controlIndex.set(key, new Set());
        controlIndex.get(key)!.add(fw);
      }
    }
  }
  return controlIndex.get(controlId.trim().toUpperCase()) ?? new Set();
}

const refusal = (what: string, policy: TenantFrameworkPolicy): string =>
  `Forbidden: ${what} is not part of this tenant's assessment program (enabled: ${policy.enabledFrameworks.join(', ')}). A platform administrator can change the program.`;

/** True when the request may use `framework`; otherwise writes the 403 and returns false. */
export async function ensureFrameworkEnabled(req: Request, res: Response, framework: string, policy?: TenantFrameworkPolicy | null): Promise<boolean> {
  const p = policy === undefined ? await getTenantFrameworkPolicy(req.tenantId!) : policy;
  if (!p || p.enabledFrameworks.includes(framework)) return true;
  res.status(403).json({ error: refusal(`framework ${framework}`, p), code: 'framework_not_enabled', framework });
  return false;
}

/** True when the control belongs to at least one enabled framework (or is unknown to every framework); otherwise 403. */
export async function ensureControlInFrameworkPolicy(req: Request, res: Response, controlId: string): Promise<boolean> {
  const policy = await getTenantFrameworkPolicy(req.tenantId!);
  if (!policy) return true;
  const defining = frameworksDefiningControl(controlId);
  if (defining.size === 0 || [...defining].some((fw) => policy.enabledFrameworks.includes(fw))) return true;
  res.status(403).json({ error: refusal(`control ${controlId}`, policy), code: 'framework_not_enabled', controlId });
  return false;
}
