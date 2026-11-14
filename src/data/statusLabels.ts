import type { ObjectiveStatus } from '../types/assessment';
import type { ControlStatus } from '../types/cmmc';

/** The one display label per status, so a screen, an export and a notice cannot word the same status two ways (#294). Pure. */
const LABELS: Record<ObjectiveStatus, string> = {
  MET: 'Met',
  NOT_MET: 'Not met',
  IN_PROGRESS: 'In progress',
  NOT_STARTED: 'Not started',
  NOT_APPLICABLE: 'Not applicable',
};

/** One display label per status, everywhere a person reads it. null/undefined is a control with no record: Not started. Unknown values come back unchanged. */
export function statusDisplayLabel(s: ControlStatus | ObjectiveStatus | null | undefined): string {
  if (s === null || s === undefined) return LABELS.NOT_STARTED;
  return Object.prototype.hasOwnProperty.call(LABELS, s) ? LABELS[s as ObjectiveStatus] : s;
}
