/**
 * Record of assets that did not reach the server when a browser-only tenant was moved to it (#92).
 *
 * The leftover asset list stays under the OLD tenant id, so nothing else links it to the new tenant. This record does:
 * ids, a timestamp and a count only, never a host name, address or note. Pure module: the storage is injected (a
 * Map-backed fake satisfies it in tests). Every function is defensive and never throws.
 */

import type { ScrubStorage } from './browserStorageScrub';

export const FAILED_MOVES_KEY = 'pbc_failed_moves_v1';

export interface FailedMoveRecord {
  fromTenantId: string;
  toTenantId: string;
  at: string;
  assetsFailed: number;
}

function isRecord(x: unknown): x is FailedMoveRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.fromTenantId === 'string' && r.fromTenantId !== ''
    && typeof r.toTenantId === 'string' && r.toTenantId !== ''
    && typeof r.at === 'string'
    && typeof r.assetsFailed === 'number' && Number.isInteger(r.assetsFailed) && r.assetsFailed >= 0;
}

/** Whitelist: only these four fields are ever stored. */
function clean(r: FailedMoveRecord): FailedMoveRecord {
  return { fromTenantId: r.fromTenantId, toTenantId: r.toTenantId, at: r.at, assetsFailed: r.assetsFailed };
}

export function readFailedMoves(storage: ScrubStorage): FailedMoveRecord[] {
  try {
    const raw = storage.getItem(FAILED_MOVES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map(clean);
  } catch {
    return [];
  }
}

function write(storage: ScrubStorage, list: FailedMoveRecord[]): void {
  try {
    if (list.length === 0) storage.removeItem(FAILED_MOVES_KEY);
    else storage.setItem(FAILED_MOVES_KEY, JSON.stringify(list.map(clean)));
  } catch {
    // storage full or blocked: the leftover list is still scrubbed by the start-up check, nothing else to do
  }
}

/** Adds the record, replacing any earlier one for the same old tenant id. */
export function recordFailedMove(storage: ScrubStorage, rec: FailedMoveRecord): void {
  try {
    if (!isRecord(rec)) return;
    const rest = readFailedMoves(storage).filter(r => r.fromTenantId !== rec.fromTenantId);
    write(storage, [...rest, clean(rec)]);
  } catch {
    // never throws
  }
}

export function failedMovesFor(storage: ScrubStorage, toTenantId: string): FailedMoveRecord[] {
  return readFailedMoves(storage).filter(r => r.toTenantId === toTenantId);
}

/** Sets the number of assets still local for an old tenant id; 0 removes the entry (and the key once the list is empty). */
export function setFailedMoveAssets(storage: ScrubStorage, fromTenantId: string, n: number): void {
  try {
    const list = readFailedMoves(storage);
    const next = n > 0
      ? list.map(r => (r.fromTenantId === fromTenantId ? { ...r, assetsFailed: Math.floor(n) } : r))
      : list.filter(r => r.fromTenantId !== fromTenantId);
    write(storage, next);
  } catch {
    // never throws
  }
}

/**
 * Control answers that did not reach the server when a browser-only tenant was moved (#113). Kept apart from the asset record:
 * `setFailedMoveAssets(..., 0)` deletes that whole entry, and these ids must outlive it. This record holds ids only; the answers
 * themselves (including the notes) sit under a separate per-old-tenant key that the start-up cache scrub does not touch.
 */

export const FAILED_CONTROL_MOVES_KEY = 'pbc_failed_control_moves_v1';
export const FAILED_MOVE_NOTES_KEY_PREFIX = 'pbc_failed_move_notes_v1_';

export interface FailedControlMoveRecord {
  fromTenantId: string;
  toTenantId: string;
  at: string;
  controlIds: string[];
}

export interface PendingControlAnswer {
  status: string;
  implementationNotes: string;
  responsibleRole: string;
  updatedBy?: string;
}

const cleanIds = (ids: unknown): string[] =>
  Array.isArray(ids) ? Array.from(new Set(ids.filter((i): i is string => typeof i === 'string' && i !== ''))) : [];

function isControlRecord(x: unknown): x is FailedControlMoveRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.fromTenantId === 'string' && r.fromTenantId !== ''
    && typeof r.toTenantId === 'string' && r.toTenantId !== ''
    && typeof r.at === 'string'
    && Array.isArray(r.controlIds);
}

/** Whitelist: only these four fields are ever stored, and only non-empty string ids, once each. */
function cleanControlRecord(r: FailedControlMoveRecord): FailedControlMoveRecord {
  return { fromTenantId: r.fromTenantId, toTenantId: r.toTenantId, at: r.at, controlIds: cleanIds(r.controlIds) };
}

/** Whitelist: only these fields of an answer are ever stored. */
function cleanAnswer(a: PendingControlAnswer): PendingControlAnswer {
  const out: PendingControlAnswer = {
    status: String(a.status),
    implementationNotes: typeof a.implementationNotes === 'string' ? a.implementationNotes : '',
    responsibleRole: typeof a.responsibleRole === 'string' ? a.responsibleRole : '',
  };
  if (typeof a.updatedBy === 'string') out.updatedBy = a.updatedBy;
  return out;
}

export function readFailedControlMoves(storage: ScrubStorage): FailedControlMoveRecord[] {
  try {
    const raw = storage.getItem(FAILED_CONTROL_MOVES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isControlRecord).map(cleanControlRecord);
  } catch {
    return [];
  }
}

export function failedControlMovesFor(storage: ScrubStorage, toTenantId: string): FailedControlMoveRecord[] {
  return readFailedControlMoves(storage).filter(r => r.toTenantId === toTenantId);
}

function writeControlRecords(storage: ScrubStorage, list: FailedControlMoveRecord[]): void {
  if (list.length === 0) storage.removeItem(FAILED_CONTROL_MOVES_KEY);
  else storage.setItem(FAILED_CONTROL_MOVES_KEY, JSON.stringify(list.map(cleanControlRecord)));
}

/** The answers kept for an old tenant id. {} when absent or malformed. */
export function readPendingControlAnswers(storage: ScrubStorage, fromTenantId: string): Record<string, PendingControlAnswer> {
  try {
    const raw = storage.getItem(FAILED_MOVE_NOTES_KEY_PREFIX + fromTenantId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, PendingControlAnswer> = {};
    for (const [id, a] of Object.entries(parsed as Record<string, unknown>)) {
      if (!a || typeof a !== 'object') continue;
      const v = a as Record<string, unknown>;
      if (typeof v.status !== 'string' || typeof v.implementationNotes !== 'string') continue;
      out[id] = cleanAnswer({
        status: v.status,
        implementationNotes: v.implementationNotes,
        responsibleRole: typeof v.responsibleRole === 'string' ? v.responsibleRole : '',
        updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : undefined,
      });
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Keeps the answers (only for the ids in the record) and then the record. A record for the same old tenant id is replaced.
 * Returns false when any write fails, so the caller knows the answers are not safe here.
 */
export function recordFailedControlMove(storage: ScrubStorage, rec: FailedControlMoveRecord, answers: Record<string, PendingControlAnswer>): boolean {
  try {
    if (!isControlRecord(rec)) return false;
    const clean = cleanControlRecord(rec);
    const kept: Record<string, PendingControlAnswer> = {};
    for (const id of clean.controlIds) {
      const a = answers[id];
      if (a && typeof a === 'object') kept[id] = cleanAnswer(a);
    }
    storage.setItem(FAILED_MOVE_NOTES_KEY_PREFIX + clean.fromTenantId, JSON.stringify(kept));
    const rest = readFailedControlMoves(storage).filter(r => r.fromTenantId !== clean.fromTenantId);
    writeControlRecords(storage, [...rest, clean]);
    return true;
  } catch {
    return false;
  }
}

/** Removes settled ids from the record and the answers; empty entries (and the keys) go away. */
export function settleFailedControls(storage: ScrubStorage, fromTenantId: string, ids: string[]): void {
  try {
    const drop = new Set(ids);
    const answers = readPendingControlAnswers(storage, fromTenantId);
    for (const id of drop) delete answers[id];
    const notesKey = FAILED_MOVE_NOTES_KEY_PREFIX + fromTenantId;
    if (Object.keys(answers).length === 0) storage.removeItem(notesKey);
    else storage.setItem(notesKey, JSON.stringify(answers));
    const next = readFailedControlMoves(storage)
      .map(r => (r.fromTenantId === fromTenantId ? { ...r, controlIds: r.controlIds.filter(i => !drop.has(i)) } : r))
      .filter(r => r.controlIds.length > 0);
    writeControlRecords(storage, next);
  } catch {
    // never throws: whatever stays is retried or scrubbed later
  }
}

/** Removes answer maps whose old tenant id no record points to any more. */
export function pruneOrphanControlNotes(storage: ScrubStorage): void {
  try {
    const live = new Set(readFailedControlMoves(storage).map(r => FAILED_MOVE_NOTES_KEY_PREFIX + r.fromTenantId));
    const orphans: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(FAILED_MOVE_NOTES_KEY_PREFIX) && !live.has(k)) orphans.push(k);
    }
    for (const k of orphans) storage.removeItem(k);
  } catch {
    // never throws
  }
}
