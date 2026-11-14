import type { ObjectiveStatus } from '../types/assessment';
import { isStaleWriteError } from './controlSave';

/**
 * The save state of each objective answer (#294): ids, statuses and times only. A narrative is never stored here, only whether one was
 * part of the failed save. Pure: reducers never mutate their input and return the same reference when nothing changes.
 */
export type ObjectiveSaveFailure = 'failed' | 'unreachable' | 'stale' | 'archived' | 'session';
export type ObjectiveSaveEntry =
  | { state: 'saving'; token: number }
  | { state: 'saved'; token: number; at: string }
  | { state: 'failed'; token: number; reason: ObjectiveSaveFailure; status?: ObjectiveStatus; narrative: boolean };
export type ObjectiveSaveMap = Readonly<Record<string, ObjectiveSaveEntry>>;
type SaveInput = { objectiveId: string; status?: ObjectiveStatus; narrative?: unknown };

/** Every input becomes "saving" under this token. */
export function markObjectiveSaves(m: ObjectiveSaveMap, inputs: readonly SaveInput[], token: number): ObjectiveSaveMap {
  if (inputs.length === 0) return m;
  const next: Record<string, ObjectiveSaveEntry> = { ...m };
  for (const i of inputs) next[i.objectiveId] = { state: 'saving', token };
  return next;
}

/** Settles the inputs whose entry still has this token (a newer save of the same objective owns its entry). */
export function settleObjectiveSaves(
  m: ObjectiveSaveMap,
  inputs: readonly SaveInput[],
  token: number,
  outcome: { state: 'saved'; at: string } | { state: 'failed'; reason: ObjectiveSaveFailure }
): ObjectiveSaveMap {
  let next: Record<string, ObjectiveSaveEntry> | null = null;
  for (const i of inputs) {
    if (m[i.objectiveId]?.token !== token) continue;
    next ??= { ...m };
    if (outcome.state === 'saved') {
      next[i.objectiveId] = { state: 'saved', token, at: outcome.at };
    } else {
      const failed: ObjectiveSaveEntry = { state: 'failed', token, reason: outcome.reason, narrative: i.narrative !== undefined };
      if (i.status !== undefined) failed.status = i.status;
      next[i.objectiveId] = failed;
    }
  }
  return next ?? m;
}

export function objectiveSaveFailureOf(err: unknown): ObjectiveSaveFailure {
  if (isStaleWriteError(err)) return 'stale';
  const e = err as { status?: unknown; reason?: unknown } | null;
  if (e?.status === 401) return 'session';
  if (e?.reason === 'program_archived') return 'archived';
  if (e?.status === 0) return 'unreachable';
  return 'failed';
}

export function objectiveNotSavedNotice(n: number): string {
  return n === 1
    ? 'An objective answer was not saved to the server. It is marked "Not saved" in its control.'
    : `${n} objective answers were not saved to the server. They are marked "Not saved" in their control.`;
}

export function objectiveSaveView(
  e: ObjectiveSaveEntry | undefined,
  o: { serverBacked: boolean; canEdit: boolean; hasDraft: boolean; locale?: string; timeZone?: string }
): { tone: 'muted' | 'ok' | 'warn'; text: string; retry: boolean } | null {
  if (!o.canEdit || !e) return null;
  if (e.state === 'saving') return { tone: 'muted', text: 'Saving…', retry: false };
  if (e.state === 'saved') {
    const text = o.serverBacked
      ? `Saved at ${new Date(e.at).toLocaleTimeString(o.locale, { hour: '2-digit', minute: '2-digit', timeZone: o.timeZone })}`
      : 'Saved in this browser';
    return { tone: 'ok', text, retry: false };
  }
  if (e.reason === 'stale') {
    return { tone: 'warn', text: 'Not saved: someone else saved this objective while you were editing. Copy your text, then reload to see theirs.', retry: false };
  }
  if (e.reason === 'archived') return { tone: 'warn', text: 'Not saved: this program is archived and read-only.', retry: false };
  if (e.reason === 'session') return { tone: 'warn', text: 'Not saved: your session ended. Sign in again, then repeat the change.', retry: false };
  const retryable = e.narrative ? o.hasDraft : e.status !== undefined;
  const base = e.reason === 'unreachable' ? 'Not saved: the server could not be reached.' : 'Not saved.';
  return { tone: 'warn', text: retryable ? base : `${base} Repeat the change to try again.`, retry: retryable };
}

/** The polite live-region text for entries that just settled. Letters only, never text. */
export function objectiveSaveAnnouncement(
  prev: ObjectiveSaveMap,
  next: ObjectiveSaveMap,
  ids: ReadonlyArray<{ id: string; label: string }>,
  o: { serverBacked: boolean }
): string {
  const failed: string[] = [];
  const saved: string[] = [];
  for (const { id, label } of ids) {
    const n = next[id];
    if (!n || (n.state !== 'saved' && n.state !== 'failed')) continue;
    const p = prev[id];
    if (p && p.state === n.state && p.token === n.token) continue;
    (n.state === 'failed' ? failed : saved).push(label);
  }
  if (failed.length > 0) return failed.length === 1 ? `Objective [${failed[0]}] not saved.` : `${failed.length} objectives not saved.`;
  const where = o.serverBacked ? '' : ' in this browser';
  if (saved.length > 0) return saved.length === 1 ? `Objective [${saved[0]}] saved${where}.` : `${saved.length} objectives saved${where}.`;
  return '';
}
