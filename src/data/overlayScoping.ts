import { programFrameworkControls } from './programScope';
import type { OverlayFilters } from '../types/framework';
import type { Program } from '../types/program';

/**
 * The four operational overlays of a program (issue #22): labels, who may change them and why not, what a change does to the
 * control count, and the text of a failed save. Pure. Control ids and counts only, never program names or notes.
 */
export type OverlayKey = 'nonNetworkedOnly' | 'noWireless' | 'noMobileDevices' | 'noPiiProcessing';
export const OVERLAY_KEYS: readonly OverlayKey[] = ['nonNetworkedOnly', 'noWireless', 'noMobileDevices', 'noPiiProcessing'];
export const OVERLAY_TITLES: Record<OverlayKey, string> = {
  nonNetworkedOnly: 'Stand-Alone / Air-Gapped',
  noWireless: 'No Wireless Capabilities',
  noMobileDevices: 'No Mobile Devices',
  noPiiProcessing: 'No PII Processing',
};
export const OVERLAY_DETAILS: Record<OverlayKey, string> = {
  nonNetworkedOnly: 'Excludes SC-7, AC-17, SC-8',
  noWireless: 'Excludes AC-18 wireless access',
  noMobileDevices: 'Excludes AC-19, MP-7 mobile controls',
  noPiiProcessing: 'Excludes PT family & privacy safeguards',
};
export const OVERLAY_SHORT: Record<OverlayKey, string> = {
  nonNetworkedOnly: 'Air-gapped', noWireless: 'No wireless', noMobileDevices: 'No mobile', noPiiProcessing: 'No PII',
};
/** Short labels of the overlays that are on, in menu order. */
export function programOverlayLabels(scoping: Partial<Record<OverlayKey, boolean>> | null | undefined): string[] {
  if (!scoping) return [];
  return OVERLAY_KEYS.filter((k) => scoping[k] === true).map((k) => OVERLAY_SHORT[k]);
}

export type OverlayLock = 'loading' | 'unavailable' | 'archived' | 'not_nist' | 'privacy' | 'cannot_manage';
export interface OverlayLockContext {
  serverBacked: boolean;
  programsStatus: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  canManagePrograms: boolean;
  /** The active framework (the program's, or a browser-only tenant's primary framework). */
  framework: string;
  program: Pick<Program, 'framework' | 'privacyBaseline' | 'archived'> | null;
}
const isNist = (f: string | null | undefined) => f === 'NIST_800_53_REV5' || f === 'nist-800-53-r5';

/** Why none of the four can be changed (order: not loaded, archived, not NIST, role); null when they can. */
export function menuLockReason(ctx: OverlayLockContext): Exclude<OverlayLock, 'privacy'> | null {
  if (ctx.serverBacked) {
    if (ctx.programsStatus === 'idle' || ctx.programsStatus === 'loading') return 'loading';
    if (ctx.programsStatus !== 'ready' || !ctx.program) return 'unavailable';
    if (ctx.program.archived) return 'archived';
  }
  if (!isNist(ctx.serverBacked && ctx.program ? ctx.program.framework : ctx.framework)) return 'not_nist';
  if (!ctx.canManagePrograms) return 'cannot_manage';
  return null;
}
/** The menu reason, except that No PII on a privacy program says "privacy" (before the role, since it is permanent). */
export function overlayLockReason(key: OverlayKey, ctx: OverlayLockContext): OverlayLock | null {
  const menu = menuLockReason(ctx);
  if (menu && menu !== 'cannot_manage') return menu;
  if (key === 'noPiiProcessing' && ctx.serverBacked && ctx.program?.privacyBaseline) return 'privacy';
  return menu;
}
export function overlayLockText(lock: OverlayLock, framework: string): string {
  switch (lock) {
    case 'loading': return 'Loading the program. Its overlays can be changed once it has loaded.';
    case 'unavailable': return 'The program could not be loaded from the server, so its overlays cannot be changed right now. Reload the page to try again.';
    case 'archived': return 'This program is archived and read-only. Restore it on the Programs page to change its overlays.';
    case 'not_nist':
      return framework === 'CMMC_L1' || framework === 'CMMC_L2'
        ? 'Overlays apply to NIST SP 800-53 programs only. CMMC assesses every requirement: if one does not apply, mark its assessment objectives N/A on the control instead.'
        : 'Overlays apply to NIST SP 800-53 programs only. If a control does not apply, record that on the control instead.';
    case 'privacy': return 'Not available: this program applies the SP 800-53B privacy baseline, so it processes PII.';
    case 'cannot_manage': return 'Only a Tenant Owner or MSP Admin can change the overlays. The ones marked Active are applied to the control list and the score.';
  }
}
export function overlayScopeNote(serverBacked: boolean): string {
  return serverBacked
    ? 'Saved with this program and shared with everyone who works in it. Turning one on or off adds or removes controls and changes the readiness score.'
    : 'Saved in this browser for this organization only. Turning one on or off adds or removes controls and changes the readiness score.';
}

export interface OverlayChangeSummary {
  key: OverlayKey; turningOn: boolean; before: number; after: number;
  /** Ids leaving (turning on) or returning (turning off), catalog order. */
  changedIds: string[]; sampleIds: string[]; moreCount: number;
}
export function summarizeOverlayChange(
  program: Pick<Program, 'framework' | 'baseline'> & { privacyBaseline?: boolean },
  current: OverlayFilters, key: OverlayKey, sampleSize = 5
): OverlayChangeSummary {
  const turningOn = !current[key];
  const next: OverlayFilters = { ...current, [key]: turningOn };
  const beforeIds = programFrameworkControls(program, current).map((c) => c.id);
  const afterIds = programFrameworkControls(program, next).map((c) => c.id);
  const beforeSet = new Set(beforeIds); const afterSet = new Set(afterIds);
  const changedIds = turningOn ? beforeIds.filter((id) => !afterSet.has(id)) : afterIds.filter((id) => !beforeSet.has(id));
  const sampleIds = changedIds.slice(0, sampleSize);
  return { key, turningOn, before: beforeIds.length, after: afterIds.length, changedIds, sampleIds, moreCount: changedIds.length - sampleIds.length };
}
export function describeOverlayChange(s: Pick<OverlayChangeSummary, 'turningOn' | 'before' | 'after' | 'changedIds'>): string {
  const n = s.changedIds.length;
  const word = (k: number) => (k === 1 ? 'control' : 'controls');
  if (n === 0) return `No control of this program depends on this overlay: it keeps ${s.before} ${word(s.before)}.`;
  return s.turningOn
    ? `${n} ${word(n)} ${n === 1 ? 'leaves' : 'leave'} the scope of this program: it goes from ${s.before} to ${s.after} ${word(s.after)}.`
    : `${n} ${word(n)} ${n === 1 ? 'returns' : 'return'} to the scope of this program: it goes from ${s.before} to ${s.after} ${word(s.after)}.`;
}
/** Never echoes the server's text (the programs route sends `code`, which ApiError drops today, so match on the status too). */
export function overlaySaveErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown; code?: unknown };
  const code = typeof e.reason === 'string' ? e.reason : typeof e.code === 'string' ? e.code : '';
  if (code === 'overlay_locked') return 'Overlays cannot be changed for this program right now. Nothing was saved.';
  if (code === 'program_archived' || e.status === 409) return 'This program was archived meanwhile, so its overlays can no longer be changed. Nothing was saved.';
  if (code === 'invalid_scoping' || e.status === 400) return 'The server did not accept this overlay for this program. Nothing was saved. Reload the page to see the program as it is saved now.';
  if (e.status === 403) return "Your role cannot change this program's overlays. Nothing was saved.";
  if (e.status === 401) return 'Your session has expired. Sign in again; nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved. Try again, or cancel.';
  return 'The overlay change could not be saved. Try again, or cancel.';
}
