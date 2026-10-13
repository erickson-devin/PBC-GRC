import { Request, Response } from 'express';
import { getTenantProgram, TenantProgram } from '../db';
import { getFrameworkControls } from '../../src/data/frameworks';
import type { ComplianceFramework } from '../../src/types/framework';

/**
 * Framework segregation. A tenant belongs to one assessment program (its primary framework plus any others a platform
 * administrator enabled for it) and the API only serves what is inside that program: a tenant provisioned for CMMC Level 2
 * cannot read, score or attach evidence to NIST SP 800-53 (or SOC 2, HIPAA, ...) controls just by asking for them.
 *
 * A tenant with no tenant record (development fallback / unknown id) has no program to enforce and is left alone.
 */
const PROGRAM_FRAMEWORKS: readonly ComplianceFramework[] = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'];

let controlIndex: Map<string, Set<string>> | null = null;

/** Which frameworks define a control id. An id can sit in several (CMMC Level 2 includes the Level 1 practices). */
export function frameworksDefiningControl(controlId: string): Set<string> {
  if (!controlIndex) {
    controlIndex = new Map();
    for (const fw of PROGRAM_FRAMEWORKS) {
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

export const programOf = (tenantId: string): Promise<TenantProgram | null> => getTenantProgram(tenantId);

const refusal = (what: string, program: TenantProgram): string =>
  `Forbidden: ${what} is not part of this tenant's assessment program (enabled: ${program.enabledFrameworks.join(', ')}). A platform administrator can change the program.`;

/** True when the request may use `framework`; otherwise writes the 403 and returns false. */
export async function ensureFrameworkEnabled(req: Request, res: Response, framework: string, program?: TenantProgram | null): Promise<boolean> {
  const p = program === undefined ? await getTenantProgram(req.tenantId!) : program;
  if (!p || p.enabledFrameworks.includes(framework)) return true;
  res.status(403).json({ error: refusal(`framework ${framework}`, p), code: 'framework_not_enabled', framework });
  return false;
}

/** True when the control belongs to at least one enabled framework (or is unknown to every framework); otherwise 403. */
export async function ensureControlInProgram(req: Request, res: Response, controlId: string): Promise<boolean> {
  const program = await getTenantProgram(req.tenantId!);
  if (!program) return true;
  const defining = frameworksDefiningControl(controlId);
  if (defining.size === 0 || [...defining].some((fw) => program.enabledFrameworks.includes(fw))) return true;
  res.status(403).json({ error: refusal(`control ${controlId}`, program), code: 'framework_not_enabled', controlId });
  return false;
}
