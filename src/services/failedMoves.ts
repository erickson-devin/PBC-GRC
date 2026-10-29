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
