import type { ComplianceFramework } from '../types/framework';
import { NIST_800_53_CONTROLS } from './frameworks/nist80053Controls';
import { CMMC_LEVEL_2_CONTROLS } from './frameworks/cmmcLevel2Controls';
import { crosswalkRequirements, crosswalkFor171, cmmcIdsForRequirement } from './frameworks/nist80053/crosswalk';

/**
 * The read-only SP 800-53 reference behind the "AC-1" buttons of the policy views: the catalog entry for a policy control,
 * and, for a CMMC program, the practices SP 800-171 Appendix D maps into the control's family. Pure: it never switches programs.
 */
const catalog = new Map(NIST_800_53_CONTROLS.map((c) => [c.id.toUpperCase(), c]));
const cmmcTitles = new Map(CMMC_LEVEL_2_CONTROLS.map((c) => [c.id, c.title]));

export interface PolicyReferencePractice { id: string; requirement: string; title: string; via: string[]; inProgram: boolean }
export interface PolicyControlReference {
  controlId: string;
  family: string;
  found: boolean;
  title: string;
  summary: string;
  statement: string;
  /** The active NIST program records this control: it can be opened in the matrix without switching programs. */
  openInMatrix: boolean;
  /** CMMC programs only: the practices SP 800-171 Appendix D maps into this control's family. */
  practices: PolicyReferencePractice[];
}

export function familyOf(controlId: string): string {
  const m = /^([A-Z]{2})-/i.exec(controlId.trim());
  return m ? m[1].toUpperCase() : '';
}

export function policyControlReference(controlId: string, framework: ComplianceFramework | string, programControlIds: ReadonlySet<string>): PolicyControlReference {
  const id = controlId.trim().toUpperCase();
  const def = catalog.get(id);
  const family = familyOf(id);
  const fw = String(framework).toUpperCase().replace('-', '_');
  const practices: PolicyReferencePractice[] = [];
  if ((fw === 'CMMC_L1' || fw === 'CMMC_L2') && family) {
    for (const req of crosswalkRequirements()) {
      const via = crosswalkFor171(req).map((c) => c.control).filter((c) => familyOf(c) === family);
      if (via.length === 0) continue;
      for (const cmmcId of cmmcIdsForRequirement(req)) {
        if (fw === 'CMMC_L1' && !/\.L1-/.test(cmmcId)) continue;
        practices.push({ id: cmmcId, requirement: req, title: cmmcTitles.get(cmmcId) ?? `SP 800-171 ${req}`, via, inProgram: programControlIds.has(cmmcId) });
      }
    }
  }
  return {
    controlId: def?.id ?? id,
    family,
    found: Boolean(def),
    title: def?.title ?? '',
    summary: def?.plainEnglishSummary ?? '',
    statement: def?.statement ?? '',
    openInMatrix: fw === 'NIST_800_53_REV5' && def ? programControlIds.has(def.id) : false,
    practices,
  };
}
