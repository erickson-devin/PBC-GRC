import { FrameworkControlDefinition } from '../../types/framework';
import { ControlState } from '../../types/cmmc';
import { getSprsPointDeduction } from './sprsCompiler';

/** One entry of the dashboard's remediation list. `weight` is the SPRS point deduction, only meaningful (and only set) for CMMC Level 2. */
export interface RemediationPriority {
  control: FrameworkControlDefinition;
  weight: number | null;
  status: string;
}

const STATUS_RANK: Record<string, number> = { NOT_MET: 0, IN_PROGRESS: 1, NOT_STARTED: 2 };

/**
 * The top unmet controls of the active framework. CMMC Level 2 is ranked by SPRS point impact (the SSP requirement, 3.12.4, has
 * weight 0 but blocks scoring entirely, so it ranks first). Every other framework has no SPRS points: it is ranked NOT_MET, then
 * IN_PROGRESS, then NOT_STARTED, in catalog order within each, and carries no weight.
 */
export function remediationPriorities(
  framework: string,
  controls: FrameworkControlDefinition[],
  states: Record<string, ControlState>,
  limit = 3
): RemediationPriority[] {
  const unmet = controls
    .filter((c) => states[c.id]?.status !== 'MET')
    .map((c) => ({ control: c, status: (states[c.id]?.status || 'NOT_STARTED') as string }));
  if (framework === 'CMMC_L2') {
    return unmet
      .map((u) => ({ ...u, weight: getSprsPointDeduction(u.control.id) as number | null }))
      .sort((a, b) => ((b.weight as number) === 0 ? 100 : (b.weight as number)) - ((a.weight as number) === 0 ? 100 : (a.weight as number)))
      .slice(0, limit);
  }
  return unmet
    .map((u) => ({ ...u, weight: null as number | null }))
    .sort((a, b) => (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2))
    .slice(0, limit);
}
