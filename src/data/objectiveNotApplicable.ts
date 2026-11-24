import type { AssessmentObjective } from '../types/assessment';

/**
 * The reason an objective does not apply (#324). It is the objective's narrative, which the SSP prints as `[b] Not applicable: <reason>`.
 * Pure: a reason may contain CUI, so it is compared here and never logged or copied into a message.
 */

/** What the reason box starts with: the typed draft, else the saved narrative, and nothing when that is only starter text. */
export function notApplicableReasonDraft(
  o: Pick<AssessmentObjective, 'implementationNarrative' | 'prefilledTemplate'>,
  draft?: string,
  starters: readonly string[] = []
): string {
  const text = draft ?? o.implementationNarrative ?? '';
  const t = text.trim();
  if (t === (o.prefilledTemplate ?? '').trim() || starters.some((s) => s.trim() === t)) return '';
  return text;
}

/** Why a reason cannot be saved, or null when it can. */
export function notApplicableReasonError(text: string, starters: readonly string[]): string | null {
  const t = text.trim();
  if (t === '') return 'Write a short reason before marking the objective Not applicable.';
  if (starters.some((s) => s.trim() === t)) return 'The starter template is not a reason. Write why this objective does not apply.';
  return null;
}
