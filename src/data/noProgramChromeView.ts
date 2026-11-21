import type { ProgramGate } from './programDefaultChoice';

/** What the header and sidebar show about the program: its numbers, or a neutral label before there is one. */
export type ChromeProgramState = 'program' | 'loading' | 'none' | 'all-archived';

/**
 * 'program' in the browser-only mode or with an active program; otherwise why there are no program numbers to show: the programs are
 * still loading (no gate yet), the tenant has none, or every program is archived.
 */
export function chromeProgramState(i: { serverBacked: boolean; hasActiveProgram: boolean; gate: ProgramGate | null }): ChromeProgramState {
  if (!i.serverBacked || i.hasActiveProgram) return 'program';
  return i.gate ? i.gate.kind : 'loading';
}

/** The neutral label the header and sidebar show in place of the control counts and the readiness figure. */
export function noProgramChromeLabel(s: Exclude<ChromeProgramState, 'program'>): string {
  if (s === 'none') return 'No program yet';
  if (s === 'all-archived') return 'No open program';
  return 'Loading programs…';
}
