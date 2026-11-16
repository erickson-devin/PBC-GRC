import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import type { ControlStatus } from '../../types/cmmc';
import { calculateControlRollup } from '../frameworks/assessmentObjectives';
import { cmmcNumberOf, guideObjectives } from './guide';

/**
 * The rule behind "a control cannot be Met while its objectives are not all Met or Not applicable" (#292). Pure and shared by the
 * client (the status buttons, the JSON import, the move to the server) and the server (PUT /controls/:id): it reads no store,
 * logs nothing and never mutates its input. A refusal carries counts only, never objective text or a narrative.
 *
 * Two product decisions live here and nowhere else:
 *  - GUARDED_FRAMEWORKS (D2): the frameworks the rule applies to. NIST 800-53, SOC 2 and HIPAA keep their manual status.
 *  - REFUSE_MET_WITHOUT_ANSWERS (D1): true = strict, a Met with no stored objective answer is refused; false = the catalog-update
 *    precedent (rule C), a Met is allowed while the control has no stored objective answer at all.
 */
export const GUARDED_FRAMEWORKS: readonly string[] = ['CMMC_L1', 'CMMC_L2'];
export const REFUSE_MET_WITHOUT_ANSWERS = true;

export type ControlStatusDecision =
  | { allowed: true }
  | { allowed: false; reason: 'objectives_not_met'; total: number; open: number; rolledUp: ControlStatus };

export type ControlStatusRefusal = Extract<ControlStatusDecision, { allowed: false }>;

type ObjectiveStatuses = Readonly<Record<string, ObjectiveStatus | undefined>>;

/** Whether a guarded CMMC control may be written as Met, given the stored status of each objective keyed by objective id. */
export function checkControlStatusWrite(
  controlId: string,
  requested: ControlStatus,
  objectiveStatuses: ObjectiveStatuses,
  framework: string
): ControlStatusDecision {
  if (requested !== 'MET') return { allowed: true };
  if (!GUARDED_FRAMEWORKS.includes(framework)) return { allowed: true };
  const number = cmmcNumberOf(controlId);
  if (number === null) return { allowed: true };
  const letters = guideObjectives(number, framework).map((g) => g.letter);
  if (letters.length === 0) return { allowed: true };
  // Stored letters that are not in the guide are ignored, as in the catalog update (migration.ts).
  const answered = letters.filter((l) => objectiveStatuses[`${controlId}[${l}]`] !== undefined);
  if (!REFUSE_MET_WITHOUT_ANSWERS && answered.length === 0) return { allowed: true };
  const rows = letters.map(
    (l) => ({ controlId, status: objectiveStatuses[`${controlId}[${l}]`] ?? 'NOT_STARTED' }) as AssessmentObjective
  );
  const rollup = calculateControlRollup(rows);
  if (rollup.calculatedStatus === 'MET') return { allowed: true };
  const total = letters.length;
  return {
    allowed: false,
    reason: 'objectives_not_met',
    total,
    open: total - rollup.metCount - rollup.notApplicableCount,
    rolledUp: rollup.calculatedStatus,
  };
}

/** The sentence shown for a refusal: counts only. */
export function metRefusalMessage(d: ControlStatusRefusal): string {
  return `Met needs every objective Met or Not applicable: ${d.open} of ${d.total} are not.`;
}

const statusesOf = (objectives: Record<string, { status: ObjectiveStatus }> | undefined): ObjectiveStatuses => {
  const out: Record<string, ObjectiveStatus> = {};
  for (const [id, o] of Object.entries(objectives ?? {})) if (o) out[id] = o.status;
  return out;
};

/** The Met controls of a state that the rule would refuse today, with what their objectives roll up to. */
export function refusedMetControls(
  controls: Record<string, { status: ControlStatus }>,
  objectives: Record<string, { status: ObjectiveStatus }> | undefined,
  framework: string
): Array<{ controlId: string; total: number; open: number; rolledUp: ControlStatus }> {
  const statuses = statusesOf(objectives);
  const out: Array<{ controlId: string; total: number; open: number; rolledUp: ControlStatus }> = [];
  for (const [controlId, c] of Object.entries(controls ?? {})) {
    if (c?.status !== 'MET') continue;
    const d = checkControlStatusWrite(controlId, 'MET', statuses, framework);
    if (!d.allowed) out.push({ controlId, total: d.total, open: d.open, rolledUp: d.rolledUp });
  }
  return out;
}

/** A copy of the state with every refused Met control set to its objectives' rolled-up status. Never mutates its input. */
export function lowerRefusedMet<S extends { controls: Record<string, { status: ControlStatus }>; objectives?: Record<string, { status: ObjectiveStatus }> }>(
  state: S,
  framework: string
): { state: S; lowered: string[] } {
  const refused = refusedMetControls(state.controls, state.objectives, framework);
  if (refused.length === 0) return { state, lowered: [] };
  const controls = { ...state.controls };
  for (const r of refused) controls[r.controlId] = { ...controls[r.controlId], status: r.rolledUp };
  return { state: { ...state, controls }, lowered: refused.map((r) => r.controlId) };
}
