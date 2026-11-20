// The SPRS goal of a CMMC Level 2 program (#252): the score the program aims for, a per-program value. Nothing stored shows the default, 110 (the
// maximum). Pure: the score range and the score result type only.

import type { SprsScoreResult } from '../../types/audit';
import { SPRS_MAX_SCORE, SPRS_MIN_SCORE } from '../reports/sprsCompiler';

export const SPRS_DEFAULT_GOAL = SPRS_MAX_SCORE;

export const SPRS_GOAL_ERROR_TEXT = `Enter a whole number from ${SPRS_MIN_SCORE} to ${SPRS_MAX_SCORE}`;

/** A whole number within the SPRS range, or null (no goal stored: the default shows). Anything else, a numeric string included, is refused. */
export function validateSprsGoal(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < SPRS_MIN_SCORE || v > SPRS_MAX_SCORE) return { ok: false };
  return { ok: true, value: v };
}

const points = (n: number): string => (n === 1 ? '1 point' : `${n} points`);

/**
 * The goal as the card shows it. `gap` is goal minus score: positive when the score is below the goal, negative above it, null while the score is
 * not available (the SSP gate is closed). `text` always says which goal applies.
 */
export function sprsGoalView(r: Pick<SprsScoreResult, 'score' | 'scoreStatus'>, goal: number | null): { goal: number; isDefault: boolean; gap: number | null; text: string } {
  const isDefault = goal === null;
  const g = goal ?? SPRS_DEFAULT_GOAL;
  const label = `Goal: ${g}${isDefault ? ' (default)' : ''}`;
  if (r.score === null || r.scoreStatus !== 'SCORED') return { goal: g, isDefault, gap: null, text: `${label}. Not scored: SSP required` };
  const gap = g - r.score;
  const tail = gap === 0 ? 'goal reached' : gap > 0 ? `${points(gap)} to goal` : `${points(-gap)} above goal`;
  return { goal: g, isDefault, gap, text: `${label}. ${tail}` };
}
