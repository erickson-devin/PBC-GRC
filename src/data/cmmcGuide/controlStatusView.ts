import type { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import type { ControlStatus } from '../../types/cmmc';
import { calculateControlRollup } from '../frameworks/assessmentObjectives';
import { statusDisplayLabel } from '../statusLabels';
import { checkControlStatusWrite, metRefusalMessage } from './controlStatusGuard';
import type { refusedMetControls } from './controlStatusGuard';

/**
 * The words and rules the control dialog, the matrix notice, the JSON import result and the move result show for #292 / #294.
 * Pure: no React, no storage, no logging. Counts and ids only: an objective's narrative is never read here.
 */
export interface ControlHeaderView {
  /** Why Met cannot be chosen now; null = it can. */
  metRefusal: string | null;
  note: { tone: 'warn' | 'info'; text: string; fixTo: ControlStatus | null } | null;
}

export function controlHeaderView(i: {
  controlId: string;
  framework: string;
  stored: ControlStatus;
  objectives: ReadonlyArray<{ id: string; status: ObjectiveStatus }>;
}): ControlHeaderView {
  const statusMap: Record<string, ObjectiveStatus> = {};
  for (const o of i.objectives) statusMap[o.id] = o.status;
  const d = checkControlStatusWrite(i.controlId, 'MET', statusMap, i.framework);
  const metRefusal = d.allowed ? null : metRefusalMessage(d);
  const rollup = calculateControlRollup(i.objectives as unknown as AssessmentObjective[]).calculatedStatus;
  if (i.stored === 'MET' && !d.allowed) {
    return {
      metRefusal,
      note: {
        tone: 'warn',
        fixTo: d.rolledUp,
        text: `Recorded as Met, but ${d.open} of ${d.total} objectives are not Met or Not applicable. They add up to ${statusDisplayLabel(d.rolledUp)}.`,
      },
    };
  }
  if (i.objectives.length > 0 && i.stored !== rollup) {
    return {
      metRefusal,
      note: { tone: 'info', fixTo: null, text: `Recorded as ${statusDisplayLabel(i.stored)}. The objectives add up to ${statusDisplayLabel(rollup)}.` },
    };
  }
  return { metRefusal, note: null };
}

/** Keeps the refused-Met controls that are in the program's baseline. */
export function metMismatchesInView(
  list: ReturnType<typeof refusedMetControls>,
  ids: ReadonlySet<string>
): ReturnType<typeof refusedMetControls> {
  return list.filter((m) => ids.has(m.controlId));
}

export function metMismatchNoticeCopy(count: number, o: { canEdit: boolean }): { heading: string; count: string; explain: string; action: string } {
  return {
    heading: 'Met controls with open objectives.',
    count:
      count <= 0
        ? 'None left: every control recorded as Met now has its objectives Met or Not applicable.'
        : count === 1
          ? '1 control is recorded as Met, but not every objective is Met or Not applicable.'
          : `${count} controls are recorded as Met, but not every objective is Met or Not applicable.`,
    explain: 'They count as Met in the scores, the Met count and the SSP until their status matches their objectives. Nothing was changed automatically.',
    action: o.canEdit
      ? 'Open each one to answer its objectives, or set it to the status its objectives add up to.'
      : 'A Tenant Owner or MSP Admin can update them.',
  };
}

export function importResultMessage(orgName: string, lowered: number): string {
  if (lowered <= 0) return `Assessment data successfully imported for ${orgName}!`;
  const n = lowered;
  return `Assessment data imported for ${orgName}. ${n} control${n === 1 ? ' was' : 's were'} marked Met in the file without every objective Met or Not applicable, so ${n === 1 ? 'it was' : 'they were'} imported at ${n === 1 ? 'its' : 'their'} objectives' status.`;
}

export function movedLoweredNote(n: number): string {
  if (n <= 0) return '';
  return ` Note: ${n} control${n === 1 ? ' was' : 's were'} Met without every objective Met or Not applicable and ${n === 1 ? 'was' : 'were'} moved at ${n === 1 ? 'its' : 'their'} objectives' status.`;
}
