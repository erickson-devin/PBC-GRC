import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { subscribeInventory } from '../services/inventoryService';
import { registerBeforeLock } from '../services/idleLock';
import { createStampedSaveChain } from '../data/notesAutosave';
import { createDebouncedSave } from '../data/sspMetadataSync';
import type { DataInventoryRecord } from '../types/inventory';

/** 'unsupported': a tenant stored only in this browser; 'stale': the data inventory changed on the server after this screen loaded it (reload before saving again); 'loading' also covers a disabled hook. */
export type DataInventoryStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error' | 'stale';

/** Why the last save did not reach the server (a stale write is a status, not a saveError). */
export type DataInventorySaveError = 'failed' | 'archived' | 'invalid' | 'forbidden' | 'not_in_boundary' | 'unknown_category';

export interface UseDataInventory {
  supported: boolean;
  status: DataInventoryStatus;
  /** What is on screen: optimistic, the last value passed to save() as soon as it is passed. */
  record: DataInventoryRecord;
  /** True while a save is waiting to be sent or in flight. */
  saving: boolean;
  /** Set when the last save failed; cleared by the next successful save. */
  saveError: DataInventorySaveError | null;
  /** Replaces the whole data inventory (debounced 600 ms, one send for a burst of changes). Never rejects: a failure shows in saveError (or status 'stale'). */
  save: (next: DataInventoryRecord) => void;
  reload: () => Promise<void>;
}

interface Entry {
  record: DataInventoryRecord;
  status: DataInventoryStatus;
  saving: boolean;
  saveError: DataInventorySaveError | null;
}

interface Snapshot {
  tenantId: string;
  programId: string;
  record: DataInventoryRecord;
}

export const DATA_INVENTORY_SAVE_DELAY_MS = 600;

const blankRecord = (): DataInventoryRecord => ({ handlesFci: null, categories: [], updatedAt: null, updatedBy: null });
const BLANK_RECORD: DataInventoryRecord = blankRecord();
const BLANK: Entry = { record: BLANK_RECORD, status: 'loading', saving: false, saveError: null };

// One entry per tenant and program, shared by every mounted instance (the builder, the always-mounted export modal). Memory only: the data
// inventory names CUI categories and tools and is never written to browser storage.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();
const latestLoad = new Map<string, number>();
const saveChain = createStampedSaveChain();

const scopeOf = (tenantId: string, programId: string): string => `${tenantId}::${programId}`;
const entryOf = (scope: string): Entry => entries.get(scope) ?? BLANK;
function patchEntry(scope: string, patch: Partial<Entry>): void {
  entries.set(scope, { ...entryOf(scope), ...patch });
  listeners.forEach((l) => l());
}

const saveErrorOf = (err: unknown): DataInventorySaveError => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  if (e.status === 403) return 'forbidden';
  if (e.reason === 'program_archived') return 'archived';
  if (e.reason === 'tool_not_in_boundary' || e.reason === 'tool_not_found') return 'not_in_boundary';
  if (e.reason === 'unknown_cui_category') return 'unknown_category';
  if (e.status === 400 || e.reason === 'invalid') return 'invalid';
  return 'failed';
};

const isStaleWrite = (err: unknown): boolean => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  return e.status === 409 && e.reason === 'stale_write';
};

const debounced = createDebouncedSave<Snapshot>(
  (scope, snap) => {
    const run = saveChain
      .run(scope, () => entryOf(scope).record.updatedAt, (expected) =>
        ApiClient.putDataInventory(snap.tenantId, { handlesFci: snap.record.handlesFci, categories: snap.record.categories }, expected ?? null, snap.programId)
      )
      .then((saved) => {
        const pending = debounced.has(scope) || saveChain.busy(scope);
        const current = entryOf(scope).record;
        // Keep what is on screen (a newer change may already be waiting); only the stamp moves forward
        patchEntry(scope, { record: { ...current, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, saveError: null, saving: pending });
      })
      .catch((err: unknown) => {
        const pending = debounced.has(scope) || saveChain.busy(scope);
        if (isStaleWrite(err)) patchEntry(scope, { status: 'stale', saving: pending });
        else patchEntry(scope, { saveError: saveErrorOf(err), saving: pending });
      });
    inflight.set(scope, run);
  },
  { delayMs: DATA_INVENTORY_SAVE_DELAY_MS }
);

// Before the screen locks every pending change is sent (one registration for every scope)
registerBeforeLock('data-inventory', async () => {
  debounced.flushAll();
  await Promise.allSettled([...inflight.values()]);
});

/**
 * The active program's data inventory (SSP 1.4: whether it handles FCI, its CUI categories and the tools that store, process or transmit each).
 * A server-backed organization saves it to the program (a debounced whole-record PUT with the last stamp, so a change made by someone else answers
 * 409 and sets `stale`). Does nothing until `enabled` and for a browser-only organization.
 */
export function useDataInventory(options?: { enabled?: boolean }): UseDataInventory {
  const enabled = options?.enabled ?? true;
  const { currentTenant, activeProgram, programsStatus, canEdit: roleCanEdit } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const programId = activeProgram?.id ?? null;
  const canEdit = roleCanEdit && !activeProgram?.archived;
  const scope = supported && programId && enabled ? scopeOf(tenantId, programId) : null;

  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (!scope || !programId) return;
    const request = (latestLoad.get(scope) ?? 0) + 1;
    latestLoad.set(scope, request);
    try {
      const record = await ApiClient.getDataInventory(tenantId, programId);
      if (latestLoad.get(scope) !== request) return;
      // A change still on its way would be overwritten by an older copy; it will update the stamp itself
      if (debounced.has(scope) || saveChain.busy(scope)) return;
      patchEntry(scope, { record, status: 'ready', saveError: null });
    } catch {
      if (latestLoad.get(scope) !== request) return;
      patchEntry(scope, { status: 'error' });
    }
  }, [scope, tenantId, programId]);

  // Each scope has its own entry, so another program's data inventory never shows while this one loads
  useEffect(() => {
    void reload();
    if (!scope) return undefined;
    // A tool taken out of the boundary (or deleted) leaves its category rows on the server: follow it
    return subscribeInventory((c) => {
      if (c.tenantId === tenantId && (c.kind === 'tools' || (c.kind === 'program' && (c.programId === null || c.programId === programId)))) void reload();
    });
  }, [reload, scope, tenantId, programId]);

  const save = useCallback(
    (next: DataInventoryRecord): void => {
      if (!canEdit || !scope || !programId) return;
      if (entryOf(scope).status === 'stale') return;
      patchEntry(scope, { record: next, saving: true });
      debounced.push(scope, { tenantId, programId, record: next });
    },
    [canEdit, scope, tenantId, programId]
  );

  const entry = scope ? entryOf(scope) : BLANK;
  const status: DataInventoryStatus = !supported ? 'unsupported' : programsStatus === 'ready' && !activeProgram ? 'no_program' : !scope ? 'loading' : entry.status;
  return useMemo<UseDataInventory>(
    () => ({ supported, status, record: scope ? entry.record : BLANK_RECORD, saving: scope ? entry.saving : false, saveError: scope ? entry.saveError : null, save, reload }),
    [supported, status, scope, entry, save, reload]
  );
}
