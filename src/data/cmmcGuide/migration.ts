/**
 * Reconciling answers given against the platform's older CMMC objectives with the CMMC Assessment Guide's objectives.
 * Pure functions: no storage, no network, no React. Nothing here reads or changes a narrative or an evidence link, and no
 * answer is deleted: an answer whose meaning changed is re-flagged for review.
 *
 * Rule R (per objective): the objective keeps its answer if the old objective at the same letter says the same thing as the
 * guide's. If not, Met and Not applicable become In progress ("answered, needs a second look"); Not met, In progress and Not
 * started are kept. Letters are never re-keyed.
 *
 * Rule C (per control): a Met control that has stored objective answers is re-rolled up over the guide's letters (a letter
 * with no answer counts as Not started). The result can only be lower than Met, never higher.
 */
import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import type { AssessmentState, ControlStatus } from '../../types/cmmc';
import { calculateControlRollup } from '../frameworks/assessmentObjectives';
import { CMMC_OBJECTIVE_CATALOG_REV, cmmcNumberOf, guideObjectives } from './guide';
import { legacyObjectives } from './objectives';
import { normalizeObjectiveText } from './validate';

export interface ObjectiveStatusChange {
  id: string;
  from: ObjectiveStatus;
  to: ObjectiveStatus;
}

export interface ControlStatusChange {
  id: string;
  from: ControlStatus;
  to: ControlStatus;
}

const OBJECTIVE_ID = /^(.+)\[([a-z0-9]+)\]$/;

/** Rule R. Ids that are not CMMC objectives come back unchanged. */
export function objectiveStatusAfterCatalogUpdate(objectiveId: string, status: ObjectiveStatus, framework: string): ObjectiveStatus {
  const m = OBJECTIVE_ID.exec(objectiveId);
  const number = m ? cmmcNumberOf(m[1]) : null;
  if (!m || !number) return status;
  if (status !== 'MET' && status !== 'NOT_APPLICABLE') return status;
  const old = legacyObjectives(m[1], framework).find((o) => o.letter === m[2]);
  const now = guideObjectives(number, framework).find((o) => o.letter === m[2]);
  const kept = Boolean(old && now && normalizeObjectiveText(old.text) === normalizeObjectiveText(now.text));
  return kept ? status : 'IN_PROGRESS';
}

/** Rule C. Only a Met control with at least one stored objective answer is looked at, and the answer is never higher than the one given. */
export function controlStatusAfterCatalogUpdate(
  controlId: string,
  controlStatus: ControlStatus,
  postStatusesByObjectiveId: Record<string, ObjectiveStatus>,
  framework: string
): ControlStatus {
  const number = cmmcNumberOf(controlId);
  if (!number || controlStatus !== 'MET') return controlStatus;
  const prefix = `${controlId}[`;
  if (!Object.keys(postStatusesByObjectiveId).some((id) => id.startsWith(prefix))) return controlStatus;
  const objectives = guideObjectives(number, framework).map((g) => ({
    id: `${prefix}${g.letter}]`,
    controlId,
    letter: g.letter,
    text: g.text,
    status: postStatusesByObjectiveId[`${prefix}${g.letter}]`] ?? ('NOT_STARTED' as ObjectiveStatus),
    prefilledTemplate: '',
    implementationNarrative: '',
    linkedEvidenceIds: [],
    isAutoVerifiedByTelemetry: false,
  })) as AssessmentObjective[];
  const rolled = calculateControlRollup(objectives).calculatedStatus;
  return rolled === 'MET' ? controlStatus : rolled;
}

/**
 * Brings a cached assessment state up to the guide's objectives: rule R over its objectives, then rule C over its Met controls.
 * Idempotent (the state is stamped with the catalog revision), never mutates its input, and reports ids and statuses only.
 * Only a CMMC program's state is touched.
 */
export function migrateCachedObjectives(
  state: AssessmentState,
  framework: string
): { state: AssessmentState; changedObjectives: ObjectiveStatusChange[]; changedControls: ControlStatusChange[] } {
  const unchanged = { state, changedObjectives: [] as ObjectiveStatusChange[], changedControls: [] as ControlStatusChange[] };
  if (framework !== 'CMMC_L1' && framework !== 'CMMC_L2') return unchanged;
  if (state.objectivesCatalogRev === CMMC_OBJECTIVE_CATALOG_REV) return unchanged;

  const changedObjectives: ObjectiveStatusChange[] = [];
  let objectives = state.objectives;
  if (objectives) {
    const next: Record<string, AssessmentObjective> = {};
    for (const [id, o] of Object.entries(objectives)) {
      const to = objectiveStatusAfterCatalogUpdate(o.id ?? id, o.status, framework);
      if (to !== o.status) {
        changedObjectives.push({ id: o.id ?? id, from: o.status, to });
        next[id] = { ...o, status: to };
      } else {
        next[id] = o;
      }
    }
    objectives = next;
  }

  const post: Record<string, ObjectiveStatus> = {};
  for (const [id, o] of Object.entries(objectives ?? {})) post[o.id ?? id] = o.status;
  const changedControls: ControlStatusChange[] = [];
  const controls: AssessmentState['controls'] = {};
  for (const [id, c] of Object.entries(state.controls ?? {})) {
    const to = controlStatusAfterCatalogUpdate(c.id ?? id, c.status, post, framework);
    if (to !== c.status) {
      changedControls.push({ id: c.id ?? id, from: c.status, to });
      controls[id] = { ...c, status: to };
    } else {
      controls[id] = c;
    }
  }

  const next: AssessmentState = { ...state, controls, objectivesCatalogRev: CMMC_OBJECTIVE_CATALOG_REV };
  if (objectives) next.objectives = objectives;
  return { state: next, changedObjectives, changedControls };
}
