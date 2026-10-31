// Pure logic for moving a program's SSP metadata from the browser cache to the server (#84). The server is the only home of the
// text once `sspMetadataMigratedAt` is set. Nothing here touches storage, the network or the console: the values can be CUI, so
// no message or result names one (only field names). Callers do the I/O and set the marker after a successful upload.

import type { AssessmentState, SSPMetadata } from '../types/cmmc';
import { SSP_METADATA_FIELDS, type SspField, type SspMetadataFields, type SspMetadataRecord } from '../types/sspMetadata';
import { NOTES_AUTOSAVE_DELAY_MS, browserScheduler, type AutosaveScheduler } from './notesAutosave';

export { stripSspMetadataForCache } from '../services/browserStorageScrub';

/** Shown (through the save-error notice) when the server's copy changed under an edit: fixed text, never the SSP text. */
export const SSP_METADATA_STALE_MESSAGE =
  'The SSP details changed on the server after this page loaded, so your edit was not saved. Reload the page to see the server copy.';

/** Shown when this browser holds SSP details that the server does not and the signed-in role cannot save them. */
export const SSP_METADATA_NEED_OWNER_MESSAGE =
  'This browser holds SSP details that are not on the server yet. An owner or MSP administrator must open this program once to save them.';

/** Fields that never count as something a person typed: the date defaults to today and is refreshed on every load. */
const NON_CONTENT_FIELDS: readonly SspField[] = ['assessmentDate'];

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The 11 text fields of the metadata that are strings (empty ones included), as the server stores them. */
export function pickSspFields(meta: Partial<SSPMetadata> | null | undefined): SspMetadataFields {
  const out: SspMetadataFields = {};
  if (!meta) return out;
  for (const field of SSP_METADATA_FIELDS) {
    const value = (meta as Record<string, unknown>)[field];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
}

/** True when a field holds text that a person typed: non-empty and different from the default (the date never counts). */
function isUserField(meta: Partial<SSPMetadata>, defaults: Partial<SSPMetadata>, field: SspField): boolean {
  if (NON_CONTENT_FIELDS.includes(field)) return false;
  const value = asText((meta as Record<string, unknown>)[field]);
  return value !== '' && value !== asText((defaults as Record<string, unknown>)[field]);
}

/** True when the cached metadata holds anything a person typed (everything except the date, compared with the defaults). */
export function hasUserSspContent(meta: Partial<SSPMetadata> | null | undefined, defaults: Partial<SSPMetadata>): boolean {
  if (!meta) return false;
  return SSP_METADATA_FIELDS.some((field) => isUserField(meta, defaults, field));
}

/** The defaults with the server's fields laid over them; `lastUpdated` is the server's stamp. A null record changes nothing. */
export function mergeServerSspMetadata(defaults: SSPMetadata, record: SspMetadataRecord | null | undefined): SSPMetadata {
  const merged: SSPMetadata = { ...defaults };
  const fields = record?.metadata;
  if (fields) {
    for (const field of SSP_METADATA_FIELDS) {
      const value = fields[field];
      if (typeof value === 'string') (merged as unknown as Record<string, string>)[field] = value;
    }
  }
  if (record?.updatedAt) merged.lastUpdated = record.updatedAt;
  return merged;
}

export type SspReconcileOutcome = 'merged' | 'marked' | 'upload' | 'conflict' | 'blocked';

export interface SspReconcileResult {
  outcome: SspReconcileOutcome;
  /** The state to apply: the same object when nothing changes (upload, conflict, blocked). */
  state: AssessmentState;
  /** upload: the full field set to PUT. */
  upload?: SspMetadataFields;
  /** upload: the stamp to send as expectedUpdatedAt (null: the server holds no row yet). */
  expected?: string | null;
  /** conflict: the fields that are non-empty on both sides and differ (names only). */
  conflictFields?: SspField[];
}

/**
 * Decides what to do with a loaded server record and the cached state of one program:
 *  - marker set: the server copy is shown ('merged').
 *  - nothing typed in the cache: take the server copy and set the marker ('marked').
 *  - cache holds text, the role cannot write: 'blocked' (nothing changes, an owner has to open it).
 *  - server has no row: 'upload' the cache (expected null).
 *  - server row exists: cache text only fills fields the server has empty ('upload' with the server's stamp, or 'marked' when
 *    there is nothing to add); a field set on both sides to different text is a 'conflict' (nothing changes).
 * The marker is set by the caller once an upload (or a conflict choice) succeeded.
 */
export function reconcileSspMetadata(
  state: AssessmentState,
  record: SspMetadataRecord,
  opts: { canWrite: boolean; now: string; defaults: SSPMetadata }
): SspReconcileResult {
  const { canWrite, now, defaults } = opts;
  const withServer = (marker: string | undefined): AssessmentState => ({
    ...state,
    sspMetadata: mergeServerSspMetadata(defaults, record),
    ...(marker ? { sspMetadataMigratedAt: marker } : {}),
  });
  if (state.sspMetadataMigratedAt) return { outcome: 'merged', state: withServer(undefined) };

  const cache = state.sspMetadata;
  if (!hasUserSspContent(cache, defaults)) return { outcome: 'marked', state: withServer(now) };
  if (!canWrite) return { outcome: 'blocked', state };

  const server = record.metadata;
  if (server === null || server === undefined) {
    return { outcome: 'upload', state, upload: pickSspFields(cache), expected: null };
  }

  const fill: SspMetadataFields = {};
  const conflictFields: SspField[] = [];
  for (const field of SSP_METADATA_FIELDS) {
    if (!isUserField(cache, defaults, field)) continue;
    const cached = asText((cache as unknown as Record<string, unknown>)[field]);
    const onServer = asText(server[field]);
    if (cached === onServer) continue;
    if (onServer === '') fill[field] = cached;
    else conflictFields.push(field);
  }
  if (conflictFields.length > 0) return { outcome: 'conflict', state, conflictFields };
  if (Object.keys(fill).length === 0) return { outcome: 'marked', state: withServer(now) };
  return { outcome: 'upload', state, upload: { ...pickSspFields(server), ...fill }, expected: record.updatedAt ?? null };
}

export interface DebouncedSave<T> {
  /** Keeps `value` as the one pending snapshot of `key` and restarts its timer. */
  push(key: string, value: T): void;
  /** Sends the pending snapshot of `key` now. True when there was one. */
  flush(key: string): boolean;
  /** Sends every pending snapshot now. Returns how many were sent. */
  flushAll(): number;
  /** Drops the pending snapshot of `key` without sending it. */
  cancel(key: string): void;
  has(key: string): boolean;
}

/** A debounce that keeps one pending snapshot per key (a burst of keystrokes becomes one send with the last snapshot). */
export function createDebouncedSave<T>(
  send: (key: string, value: T) => void,
  opts: { delayMs?: number; scheduler?: AutosaveScheduler } = {}
): DebouncedSave<T> {
  const delayMs = opts.delayMs ?? NOTES_AUTOSAVE_DELAY_MS;
  const scheduler = opts.scheduler ?? browserScheduler;
  const pending = new Map<string, { value: T; handle: unknown }>();

  const fire = (key: string): boolean => {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    scheduler.clear(entry.handle);
    send(key, entry.value);
    return true;
  };

  return {
    push(key, value) {
      const existing = pending.get(key);
      if (existing) scheduler.clear(existing.handle);
      const handle = scheduler.set(() => { fire(key); }, delayMs);
      pending.set(key, { value, handle });
    },
    flush: fire,
    flushAll() {
      let sent = 0;
      for (const key of Array.from(pending.keys())) {
        if (fire(key)) sent++;
      }
      return sent;
    },
    cancel(key) {
      const entry = pending.get(key);
      if (!entry) return;
      scheduler.clear(entry.handle);
      pending.delete(key);
    },
    has: (key) => pending.has(key),
  };
}
