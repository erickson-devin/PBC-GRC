// The POA&M target completion date of the dashboard (#252): the latest scheduled completion among the OPEN entries, with the number of open entries that
// have no date, so a date is never shown as if it covered them. Open entries are every control not recorded as Met plus the open vulnerability items
// (the same set the exported POA&M lists). Pure: types only; `today` is injected (YYYY-MM-DD).

import type { ControlStatus } from '../../types/cmmc';
import type { PoamTargetSummary } from '../../types/programSummary';

/** The vulnerability items' aggregate the server computes (`open` and `dated` count the open items; `overdue` those dated before today). */
export interface VmPoamDates {
  open: number;
  dated: number;
  latest: string | null;
  overdue: number;
}

const hasDate = (d: string | null | undefined): d is string => typeof d === 'string' && d !== '';

export function poamTargetSummary(controls: { status: ControlStatus; scheduledCompletion: string | null }[], vm: VmPoamDates, today: string): PoamTargetSummary {
  const open = controls.filter((c) => c.status !== 'MET');
  const dated = open.filter((c) => hasDate(c.scheduledCompletion));
  const controlLatest = dated.reduce<string | null>((max, c) => (max === null || (c.scheduledCompletion as string) > max ? (c.scheduledCompletion as string) : max), null);
  const vmLatest = hasDate(vm.latest) ? vm.latest : null;
  let latestDate: string | null = null;
  let latestSource: PoamTargetSummary['latestSource'] = null;
  if (controlLatest !== null && (vmLatest === null || controlLatest >= vmLatest)) {
    latestDate = controlLatest;
    latestSource = 'control';
  } else if (vmLatest !== null) {
    latestDate = vmLatest;
    latestSource = 'vulnerability';
  }
  const openCount = open.length + vm.open;
  const datedCount = dated.length + vm.dated;
  return {
    openCount,
    datedCount,
    undatedCount: openCount - datedCount,
    latestDate,
    latestSource,
    overdueCount: dated.filter((c) => (c.scheduledCompletion as string) < today).length + vm.overdue,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "30 Jun 2027" from YYYY-MM-DD; any other text comes back unchanged. */
export function formatPoamDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return ymd;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const entries = (n: number): string => (n === 1 ? '1 open entry' : `${n} open entries`);

/** The card's two lines. Without any open entry there is no detail; without any date the headline says so rather than showing a date. */
export function poamTargetText(s: PoamTargetSummary): { headline: string; detail: string } {
  if (s.openCount === 0) return { headline: 'No open POA&M entries', detail: '' };
  const undated = s.undatedCount === 1 ? '1 has no date' : `${s.undatedCount} have no date`;
  const detail = `${s.datedCount} of ${s.openCount} open entries are dated; ${undated}`;
  if (s.latestDate === null) return { headline: `No open entry has a date (${entries(s.openCount)})`, detail };
  return { headline: `Target completion: ${formatPoamDate(s.latestDate)} (latest due date of open entries)`, detail };
}
