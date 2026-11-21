// The words and numbers behind the dashboard's goal and deadline cards (#252): parsing the goal field, the error texts, the position on the score scale,
// the POA&M count lines. The rules (the goal range, the target date) are in sprsGoal.ts and poamTarget.ts. Pure: types and those rules only.

import { SPRS_MAX_SCORE, SPRS_MIN_SCORE } from '../reports/sprsCompiler';
import { validateSprsGoal } from './sprsGoal';

// U+2212, the minus sign the screens print
export const GOAL_RANGE_TEXT = 'Enter a whole number from −203 to 110.';

/** The goal field: empty means no goal (the default shows); a minus sign typed as U+2212 is accepted; anything but a whole number in range is refused. */
export function parseGoalInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const s = raw.trim().replace(/−/g, '-');
  if (s === '') return { ok: true, value: null };
  if (!/^-?\d{1,3}$/.test(s)) return { ok: false };
  return validateSprsGoal(Number(s));
}

/** The text for a failed goal save. It never echoes what was typed or what the server said. */
export function sprsGoalErrorMessage(err: unknown): string {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: unknown; reason?: unknown };
  if (e.reason === 'invalid_sprs_goal') return GOAL_RANGE_TEXT;
  if (e.reason === 'program_archived') return 'This program is archived. Restore it to change the goal.';
  if (e.status === 403) return 'Only a Tenant Owner or Admin can change the goal.';
  return 'The goal was not saved. Try again.';
}

/** Where a score sits on the scale of the card's marker line, 0 to 100 (percent). */
export function scalePosition(score: number): number {
  const p = ((score - SPRS_MIN_SCORE) / (SPRS_MAX_SCORE - SPRS_MIN_SCORE)) * 100;
  return Math.min(100, Math.max(0, p));
}

/** The goal line without its own "Goal: n" lead (the card shows the goal beside it): "22 points to goal", "Not scored: SSP required". */
export function goalGapText(text: string): string {
  return text.replace(/^Goal: -?\d+( \(default\))?\. /, '');
}

export function undatedText(n: number): string {
  return n === 1 ? '1 entry has no date' : `${n} entries have no date`;
}

export function overdueText(n: number): string {
  return `${n} overdue`;
}

export function poamSourceText(s: 'control' | 'vulnerability' | null): string | null {
  if (s === 'control') return "Latest date is on a control's POA&M entry";
  if (s === 'vulnerability') return 'Latest date is on a vulnerability POA&M item';
  return null;
}

/** Today as YYYY-MM-DD in UTC (the clock is passed in). */
export function utcToday(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The text alternative of the hero progress bar. */
export function heroBarLabel(m: { met: number; inProgress: number; notMet: number; notStarted: number; total: number }): string {
  return `${m.met} met, ${m.inProgress} in progress, ${m.notMet} not met, ${m.notStarted} not started, of ${m.total} controls`;
}
