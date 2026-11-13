/**
 * The organization-defined parameters of the CMMC requirements, placed on the guide objective each one belongs to (#286).
 *
 * The platform's parameter registry (src/data/frameworks/assessmentObjectives.ts, frozen) put some of them on the wrong
 * requirement: the patch SLAs sit on 3.1.1, the session limits on 3.1.3. The registry is left as it is; this file says where each
 * id belongs in the guide. The label and the default value are the registry's, because a recorded value is stored in the control's
 * notes as "Parameter: <label> = <value>" and is found again by that label.
 */
import { NIST_800_171A_REGISTRY } from '../frameworks/assessmentObjectives';
import type { ControlParameter } from '../../types/framework';
import { cmmcNumberOf } from './guide';

/** Each registry ODP id and the 800-171 requirement and guide objective letter it belongs to. `null` would drop it (none is dropped). */
export const CMMC_PARAMETER_PLACEMENT: Record<string, { number: string; letter: string } | null> = {
  ac_3_1_8_attempts: { number: '3.1.8', letter: 'a' },
  ac_3_1_8_lockout: { number: '3.1.8', letter: 'a' },
  ac_3_1_8_window: { number: '3.1.8', letter: 'a' },
  ac_3_1_10_timeout: { number: '3.1.10', letter: 'a' },
  ac_3_1_11_max_duration: { number: '3.1.11', letter: 'a' },
  ac_3_1_11_idle: { number: '3.1.11', letter: 'a' },
  au_3_3_1_retention: { number: '3.3.1', letter: 'e' },
  si_3_14_1_crit: { number: '3.14.1', letter: 'e' },
  si_3_14_1_high: { number: '3.14.1', letter: 'e' },
};

/** The first registry definition of an ODP id (the same label and default wherever the registry repeats it). */
function registryOdp(id: string): { id: string; label: string; defaultValue: string } | undefined {
  for (const entry of Object.values(NIST_800_171A_REGISTRY)) {
    for (const o of entry.objectives) {
      const hit = o.odpParameters?.find((p) => p.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The parameters of a CMMC control, each on the guide objective it belongs to. Any other id gives none. */
export function cmmcGuideParameters(controlId: string): ControlParameter[] {
  const number = cmmcNumberOf(controlId);
  if (!number) return [];
  const out: ControlParameter[] = [];
  for (const [id, place] of Object.entries(CMMC_PARAMETER_PLACEMENT)) {
    if (!place || place.number !== number) continue;
    const odp = registryOdp(id);
    if (!odp) continue;
    out.push({ id, kind: 'ASSIGNMENT', label: odp.label, prompt: odp.label, source: 'OBJECTIVE', defaultValue: odp.defaultValue, objectiveLetter: place.letter });
  }
  return out;
}

/** The parameter ids placed on one objective of a CMMC control. */
export function cmmcObjectiveParameterIds(controlId: string, letter: string): Set<string> {
  return new Set(cmmcGuideParameters(controlId).filter((p) => p.objectiveLetter === letter).map((p) => p.id));
}
