import type { ControlState } from '../types/cmmc';
import { errorMessage } from '../utils/errors';

// A server-backed tenant's control edits (status, notes, role) are saved with one PUT each. When the server refuses one or cannot be
// reached, the screen must not keep showing it as saved. These helpers are pure so the rules can be tested without a browser.

const FIELD_LABELS: Array<[keyof ControlState, string]> = [
  ['status', 'status'],
  ['implementationNotes', 'implementation notes'],
  ['responsibleRole', 'responsible role'],
];

/** True for the server's 409 `stale_write`: the row changed since this browser last read it. (`program_archived` is another 409.) */
export function isStaleWriteError(err: unknown): boolean {
  const e = err as { name?: unknown; status?: unknown; reason?: unknown } | null;
  return Boolean(e) && e!.name === 'ApiError' && e!.status === 409 && e!.reason === 'stale_write';
}

/** The notice for a refused stale write. Never repeats the text: it may contain CUI. */
export function staleWriteMessage(kind: 'control' | 'objective', id: string): string {
  return `Someone else saved ${kind} ${id} while you were editing. Your text is still in the field and was not saved: copy it, then reload the page to see theirs.`;
}

/**
 * The text for the "not saved" banner, or null when none is needed (a 401: the session signal already signs the user out).
 * Names the fields from the keys of `sent` only: never a value, because the notes may contain CUI.
 */
export function controlSaveFailureMessage(controlId: string, sent: Partial<ControlState>, err: unknown): string | null {
  const e = err as { name?: unknown; status?: unknown } | null;
  if (e && e.name === 'ApiError' && e.status === 401) return null;
  if (isStaleWriteError(err)) return staleWriteMessage('control', controlId);
  const fields = FIELD_LABELS.filter(([key]) => key in sent).map(([, label]) => label);
  const what = fields.length > 0 ? fields.join(' and ') : 'control';
  return `The change to the ${what} of ${controlId} was not saved: ${errorMessage(err) || 'unknown error'}`;
}

/**
 * After a failed save: puts the server's status / role back, but only where the screen still shows the value that was sent (a newer
 * local edit wins). Notes are never reverted: the browser holds no other copy for a server tenant, so the text stays on screen.
 * Returns the same object when nothing changes.
 */
export function revertFailedControlFields(
  local: ControlState,
  server: ControlState | undefined,
  sent: Partial<ControlState>
): ControlState {
  if (!server) return local;
  let next = local;
  if ('status' in sent && local.status === sent.status && server.status !== local.status) {
    next = { ...next, status: server.status };
  }
  if ('responsibleRole' in sent && local.responsibleRole === sent.responsibleRole && server.responsibleRole !== local.responsibleRole) {
    next = { ...next, responsibleRole: server.responsibleRole };
  }
  return next;
}

export interface ControlSaveFailure {
  message: string;
  /** How many saves have failed since the notice was last dismissed. */
  count: number;
}

/** Folds a new failure into the notice on screen: the newest message, and how many changes were not saved. */
export function coalesceSaveFailure(prev: ControlSaveFailure | null | undefined, message: string): ControlSaveFailure {
  return { message, count: (prev?.count ?? 0) + 1 };
}
