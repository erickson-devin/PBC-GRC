import { isParameterOpen, resolveParameters } from './frameworks/parameters';
import { cmmcNumberOf } from './cmmcGuide/guide';
import { cmmcGuideParameters } from './cmmcGuide/parameters';
import { statusDisplayLabel } from './statusLabels';
import type { ControlParameter, FrameworkControlDefinition } from '../types/framework';
import type { ControlStatus } from '../types/cmmc';

/**
 * What the control dialog tells a person around the objectives: the organization-defined parameters still open, the POA&M
 * a control is on, the read-only note and the assessment-method banner. Pure: no React, no logging.
 */

/** The parameters the SSP tab's panel lists for a control (the same expression as OdpPanel). */
export function controlCatalogParameters(control: Pick<FrameworkControlDefinition, 'id' | 'statement' | 'parameters'>): ControlParameter[] {
  return cmmcNumberOf(control.id) ? cmmcGuideParameters(control.id) : resolveParameters(control);
}

export interface ParameterCounts { total: number; set: number; open: number }

export function parameterCounts(params: ControlParameter[], notes: string): ParameterCounts {
  const open = params.filter((p) => isParameterOpen(p, notes)).length;
  return { total: params.length, set: params.length - open, open };
}

/** One line on the Objectives tab: how many parameters the control has and how many are set. null when it has none. */
export function parameterSummaryText(c: ParameterCounts, loaded: boolean): string | null {
  if (c.total === 0) return null;
  const noun = c.total === 1 ? 'parameter' : 'parameters';
  if (!loaded) return `${c.total} ${noun} (${c.total === 1 ? 'value' : 'values'} not loaded yet).`;
  if (c.total === 1) return c.open > 0 ? '1 parameter, not set yet.' : '1 parameter, set.';
  if (c.open === 0) return `${c.total} parameters, all set.`;
  if (c.set === 0) return `${c.total} parameters, none set yet.`;
  return `${c.total} parameters, ${c.set} set.`;
}

export function parameterLinkLabel(c: ParameterCounts): string {
  const it = c.total === 1 ? 'it' : 'them';
  return c.open > 0 ? `Set ${it} on the SSP tab` : `See ${it} on the SSP tab`;
}

/** A control recorded as Met while parameters are still open: a warning, never a block. */
export function metWithOpenParametersWarning(stored: ControlStatus, c: ParameterCounts): string | null {
  if (stored !== 'MET' || c.open <= 0) return null;
  const noun = c.total === 1 ? 'parameter is' : 'parameters are';
  return `Recorded as Met, but ${c.open} of ${c.total} ${noun} still open. An assessor expects a value for each one.`;
}

/** Where a Not met or In progress control is tracked. null for any other status. */
export function poamPointerText(stored: ControlStatus, poamPermitted: boolean): string | null {
  if (stored !== 'NOT_MET' && stored !== 'IN_PROGRESS') return null;
  const base = `This control is ${statusDisplayLabel(stored)}, so it is on the POA&M.`;
  return poamPermitted ? base : `${base} This framework allows no open POA&M items at assessment.`;
}

export const CONTROL_READ_ONLY_NOTE = 'Your role can read this control but not change it. A Tenant Owner or Admin can make changes.';

const GENERIC_TITLE = 'Assessment method: all objectives must be satisfied for overall control compliance.';

/** The assessment-method banner follows the program's framework (#326), not one fixed Level 2 wording. */
export function assessmentMethodBanner(controlFramework: string | undefined, programFramework: string): { title: string; body: string } {
  const fw = programFramework === 'CMMC_L1' || programFramework === 'CMMC_L2' ? programFramework : (controlFramework || programFramework);
  if (fw === 'CMMC_L1') {
    return {
      title: 'Self-assessment: every objective must be Met or Not applicable for the requirement to be Met.',
      body: 'Under the CMMC Assessment Guide Level 1, each determination statement [a], [b], [c]... is assessed and recorded as Met or Not applicable. Any objective that is Not met makes the requirement Not met.',
    };
  }
  if (fw === 'CMMC_L2') {
    return {
      title: GENERIC_TITLE,
      body: 'Under DoD CMMC Assessment Guide Level 2 and NIST SP 800-171A, each determination statement [a], [b], [c]... must be evaluated and verified as Met or Not applicable. Any objective that is Not met drops the parent control to Not met.',
    };
  }
  if (fw === 'NIST_800_53_REV5') {
    return {
      title: GENERIC_TITLE,
      body: 'Under NIST SP 800-53A, each determination statement of the control must be evaluated and verified as Met or Not applicable. Any objective that is Not met drops the parent control to Not met.',
    };
  }
  if (fw === 'NIST_800_171_R3') {
    return {
      title: 'Assessment method: all objectives must be satisfied for overall control compliance.',
      body: 'Under NIST SP 800-171A Rev. 3, each determination statement of the requirement must be evaluated and recorded as Met or Not applicable. Any objective that is Not met drops the requirement to Not met.',
    };
  }
  return {
    title: GENERIC_TITLE,
    body: 'Each determination statement of the control must be evaluated and recorded as Met or Not applicable. Any objective that is Not met drops the control to Not met.',
  };
}
