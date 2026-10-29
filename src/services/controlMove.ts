/**
 * Retry for control answers that did not reach the server when a browser-only tenant was moved (#113). Pure: the two server
 * calls are injected, no storage and no console. An answer is never pushed over a different one the server already holds.
 */

import type { ControlState } from '../types/cmmc';
import type { PendingControlAnswer } from './failedMoves';

export interface ControlRetryDeps {
  getServerControls(): Promise<ControlState[]>;
  pushControl(id: string, answer: PendingControlAnswer): Promise<ControlState>;
}

export interface ControlRetryResult {
  /** Answers actually pushed. */
  sent: number;
  /** Ids the server now holds exactly as the local copy has them. */
  confirmed: string[];
  /** Ids where the server holds a different answer: nothing was sent. */
  conflicts: string[];
  /** Ids that could not be saved. */
  failed: string[];
}

/** A conflict: the server has non-empty notes that differ, or a status other than NOT_STARTED that differs. */
export function isControlConflict(server: Pick<ControlState, 'status' | 'implementationNotes'>, local: PendingControlAnswer): boolean {
  const serverNotes = server.implementationNotes || '';
  if (serverNotes.trim() !== '' && serverNotes !== local.implementationNotes) return true;
  return server.status !== 'NOT_STARTED' && server.status !== local.status;
}

export async function retryPendingControls(deps: ControlRetryDeps, answers: Record<string, PendingControlAnswer>): Promise<ControlRetryResult> {
  const result: ControlRetryResult = { sent: 0, confirmed: [], conflicts: [], failed: [] };
  const ids = Object.keys(answers);
  if (ids.length === 0) return result;
  // A rejection here propagates: nothing has been sent yet
  const server = new Map((await deps.getServerControls()).map(c => [c.id, c]));
  for (const id of ids) {
    const local = answers[id];
    const current = server.get(id);
    if (current) {
      if (isControlConflict(current, local)) {
        result.conflicts.push(id);
        continue;
      }
      if ((current.implementationNotes || '') === local.implementationNotes && current.status === local.status) {
        result.confirmed.push(id);
        continue;
      }
    }
    result.sent++;
    try {
      const saved = await deps.pushControl(id, local);
      if ((saved.implementationNotes || '') === local.implementationNotes && saved.status === local.status) result.confirmed.push(id);
      else result.failed.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}
