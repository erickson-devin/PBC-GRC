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
  /** The overlays this summary was computed from: sent back as expectedScoping so a stale save is refused. */
  seen: OverlayFilters;
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
  return { key, turningOn, before: beforeIds.length, after: afterIds.length, changedIds, sampleIds, moreCount: changedIds.length - sampleIds.length, seen: current };
}

export interface OverlayRemoval { key: OverlayKey; title: string; short: string; removed: number }
/** What the overlays that are on take out of the control list, each one alone and all together. Counts only. */
export function overlayRemovals(
  controlsFor: (o: OverlayFilters) => ReadonlyArray<{ id: string }>, current: OverlayFilters
): { overlays: OverlayRemoval[]; before: number; after: number; totalRemoved: number } {
  const none: OverlayFilters = { nonNetworkedOnly: false, noWireless: false, noMobileDevices: false, noPiiProcessing: false };
  const before = controlsFor(none).length;
  const overlays = OVERLAY_KEYS.filter((k) => current[k]).map((k) => ({
    key: k, title: OVERLAY_TITLES[k], short: OVERLAY_SHORT[k], removed: before - controlsFor({ ...none, [k]: true }).length,
  }));
  const after = controlsFor(current).length;
  return { overlays, before, after, totalRemoved: before - after };
}
/** The words of the matrix banner. */
export function overlayBannerText(
  r: { overlays: ReadonlyArray<{ removed: number }>; before: number; after: number; totalRemoved: number },
  lock: ReturnType<typeof menuLockReason>
): { heading: string; summary: string; overlap: string | null; pointer: string } {
  const n = r.overlays.length;
  const ctl = (k: number) => (k === 1 ? 'control' : 'controls');
  const heading = n === 1 ? '1 operational overlay is active' : `${n} operational overlays are active`;
  const summary = r.totalRemoved === 0
    ? `No control of this program depends on ${n === 1 ? 'it' : 'them'}: it keeps ${r.before} ${ctl(r.before)}.`
    : `${r.totalRemoved} of ${r.before} ${ctl(r.before)} are out of scope: this program assesses ${r.after} ${ctl(r.after)}.`;
  const overlap = n > 1 && r.overlays.reduce((s, o) => s + o.removed, 0) > r.totalRemoved
    ? 'Some controls are removed by more than one overlay, so the counts above add up to more than the total.'
    : null;
  const pointer = lock === null ? 'Change them from the Overlays menu in the header.'
    : lock === 'cannot_manage' ? 'They are listed in the Overlays menu in the header. Only a Tenant Owner or MSP Admin can change them.'
    : lock === 'archived' ? 'This program is archived and read-only, so its overlays cannot be changed. They are listed in the Overlays menu in the header.'
    : 'They are listed in the Overlays menu in the header.';
  return { heading, summary, overlap, pointer };
}
export function describeOverlayChange(s: Pick<OverlayChangeSummary, 'turningOn' | 'before' | 'after' | 'changedIds'>): string {
  const n = s.changedIds.length;
  const word = (k: number) => (k === 1 ? 'control' : 'controls');
  if (n === 0) return `No control of this program depends on this overlay: it keeps ${s.before} ${word(s.before)}.`;
  return s.turningOn
    ? `${n} ${word(n)} ${n === 1 ? 'leaves' : 'leave'} the scope of this program: it goes from ${s.before} to ${s.after} ${word(s.after)}.`
    : `${n} ${word(n)} ${n === 1 ? 'returns' : 'return'} to the scope of this program: it goes from ${s.before} to ${s.after} ${word(s.after)}.`;
}
/** The program's overlays were changed by someone else while the confirmation was open (409 scoping_conflict). */
export function isOverlayConflict(err: unknown): boolean {
  const e = (err ?? {}) as { reason?: unknown; code?: unknown };
  return e.reason === 'scoping_conflict' || e.code === 'scoping_conflict';
}
/** Never echoes the server's text (the programs route sends `code`, which apiErrorFromResponse copies into `reason`; match on the status too). */
export function overlaySaveErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown; code?: unknown };
  const code = typeof e.reason === 'string' ? e.reason : typeof e.code === 'string' ? e.code : '';
  if (code === 'overlay_locked') return 'Overlays cannot be changed for this program right now. Nothing was saved.';
  if (code === 'scoping_conflict') return "Someone else changed this program's overlays while this was open. Nothing was saved. The program has been reloaded: review its overlays in the Overlays menu, and make the change again if it is still needed.";
  if (code === 'program_archived' || e.status === 409) return 'This program was archived meanwhile, so its overlays can no longer be changed. Nothing was saved.';
  if (code === 'invalid_scoping' || e.status === 400) return 'The server did not accept this overlay for this program. Nothing was saved. Reload the page to see the program as it is saved now.';
  if (e.status === 403) return "Your role cannot change this program's overlays. Nothing was saved.";
  if (e.status === 401) return 'Your session has expired. Sign in again; nothing was saved.';
  if (e.status === 0) return 'The server could not be reached. Nothing was saved. Try again, or cancel.';
  return 'The overlay change could not be saved. Try again, or cancel.';
}
