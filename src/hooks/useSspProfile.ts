import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssessment } from '../context/AssessmentContext';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { systemOwnerMirror } from '../data/ssp/sspSections';
import { createStampedSaveChain } from '../data/notesAutosave';
import { createDebouncedSave } from '../data/sspMetadataSync';
import { registerBeforeLock } from '../services/idleLock';
import type { SspProfile } from '../types/sspProfile';

/** 'stale': the profile changed on the server after this screen loaded it; reload before saving again. */
export type SspProfileStatus = 'loading' | 'ready' | 'error' | 'stale';

/** Why the last save did not reach the server: 5xx or network failure, archived program, the server refused the profile, or a read-only role. */
export type SspProfileSaveError = 'failed' | 'archived' | 'invalid' | 'forbidden';

export interface UseSspProfile {
  /** 'server': saved to the program on the server; 'browser': kept in this browser's cache (a browser-only organization). */
  mode: 'server' | 'browser';
  status: SspProfileStatus;
  /** What is on screen: optimistic, the last value passed to save() as soon as it is passed. */
  profile: SspProfile | null;
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
  /** True while a save is waiting to be sent or in flight. */
  saving: boolean;
  /** Set when the last save failed; cleared by the next successful save. A stale write is a status, not a saveError. */
  saveError: SspProfileSaveError | null;
  /** Replaces the whole profile. Never rejects: a failure shows in saveError (or status 'stale'). */
  save: (next: SspProfile) => Promise<void>;
  reload: () => Promise<void>;
}

interface Entry {
  profile: SspProfile | null;
  updatedAt: string | null;
  updatedBy: string | null;
  status: SspProfileStatus;
  saving: boolean;
  saveError: SspProfileSaveError | null;
}

interface Snapshot {
  tenantId: string;
  programId: string;
  profile: SspProfile;
  /** Keeps the legacy System Owner field in step once the profile is saved. */
  mirror: (profile: SspProfile) => void;
}

const BLANK: Entry = { profile: null, updatedAt: null, updatedBy: null, status: 'loading', saving: false, saveError: null };

// One entry per tenant and program, shared by every mounted instance (the builder, the always-mounted export modal). Memory only: the
// profile can be CUI and is never written to browser storage for a server-backed organization.
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

const saveErrorOf = (err: unknown): SspProfileSaveError => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  if (e.status === 403) return 'forbidden';
  if (e.reason === 'program_archived') return 'archived';
  if (e.status === 400 || e.reason === 'invalid_ssp_profile') return 'invalid';
  return 'failed';
};

const isStaleWrite = (err: unknown): boolean => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  return e.status === 409 && e.reason === 'stale_write';
};

const debounced = createDebouncedSave<Snapshot>((scope, snap) => {
  const run = saveChain
    .run(scope, () => entryOf(scope).updatedAt, (expected) => ApiClient.putSspProfile(snap.tenantId, snap.profile, expected ?? null, snap.programId))
    .then((record) => {
      patchEntry(scope, { updatedAt: record.updatedAt, updatedBy: record.updatedBy, saveError: null, saving: debounced.has(scope) || saveChain.busy(scope) });
      snap.mirror(snap.profile);
    })
    .catch((err: unknown) => {
      if (isStaleWrite(err)) patchEntry(scope, { status: 'stale', saving: debounced.has(scope) || saveChain.busy(scope) });
      else patchEntry(scope, { saveError: saveErrorOf(err), saving: debounced.has(scope) || saveChain.busy(scope) });
    });
  inflight.set(scope, run);
});

// Before the screen locks every pending profile change is sent (one registration for every scope: the builder and the export modal share it)
registerBeforeLock('ssp-profile', async () => {
  debounced.flushAll();
  await Promise.allSettled([...inflight.values()]);
});

/**
 * The program's SSP profile (identifier, categorization, roles, maintenance; #238, #241, #242, #246). A server-backed organization saves it to
 * the program (a debounced PUT with the last stamp, so a change made by someone else answers 409 and sets `stale`); a browser-only one keeps it
 * in its cache. After a save that changes the System Owner role, the legacy `systemOwner` SSP metadata field is brought in step.
 */
export function useSspProfile(): UseSspProfile {
  const { currentTenant, activeProgram, canEdit: roleCanEdit } = useTenant();
  const { state, setBrowserSspProfile, updateSSPMetadata, sspMetadataEditable } = useAssessment();
  const tenantId = currentTenant.id;
  const serverBacked = Boolean(currentTenant.serverBacked);
  const programId = activeProgram?.id ?? null;
  const canEdit = roleCanEdit && !activeProgram?.archived;
  const scope = serverBacked && programId ? scopeOf(tenantId, programId) : null;

  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Read at the moment a save finishes, not when it was queued
  const latest = useRef({ owner: state.sspMetadata?.systemOwner ?? '', sspMetadataEditable, updateSSPMetadata });
  latest.current = { owner: state.sspMetadata?.systemOwner ?? '', sspMetadataEditable, updateSSPMetadata };
  const mirror = useCallback((profile: SspProfile) => {
    const owner = systemOwnerMirror(profile, latest.current.owner);
    if (owner !== null && latest.current.sspMetadataEditable) latest.current.updateSSPMetadata({ systemOwner: owner });
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (!scope || !programId) return;
    const request = (latestLoad.get(scope) ?? 0) + 1;
    latestLoad.set(scope, request);
    try {
      const record = await ApiClient.getSspProfile(tenantId, programId);
      if (latestLoad.get(scope) !== request) return;
      // A change still on its way would be overwritten by an older copy; it will update the stamp itself
      if (debounced.has(scope) || saveChain.busy(scope)) return;
      patchEntry(scope, { profile: record.profile, updatedAt: record.updatedAt, updatedBy: record.updatedBy, status: 'ready', saveError: null });
    } catch {
      if (latestLoad.get(scope) !== request) return;
      patchEntry(scope, { status: 'error' });
    }
  }, [scope, tenantId, programId]);

  // Each scope has its own entry, so another program's or organization's profile never shows while this one loads
  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async (next: SspProfile): Promise<void> => {
    if (!canEdit) return;
    if (!serverBacked) {
      setBrowserSspProfile(next);
      mirror(next);
      return;
    }
    if (!scope || !programId) return;
    if (entryOf(scope).status === 'stale') return;
    patchEntry(scope, { profile: next, saving: true });
    debounced.push(scope, { tenantId, programId, profile: next, mirror });
  }, [canEdit, serverBacked, scope, tenantId, programId, setBrowserSspProfile, mirror]);

  const entry = scope ? entryOf(scope) : BLANK;
  const browserProfile = state.sspProfile ?? null;
  return useMemo<UseSspProfile>(
    () => serverBacked
      ? {
          mode: 'server',
          status: scope ? entry.status : 'loading',
          profile: entry.profile,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          canEdit,
          saving: entry.saving,
          saveError: entry.saveError,
          save,
          reload,
        }
      : { mode: 'browser', status: 'ready', profile: browserProfile, updatedAt: null, updatedBy: null, canEdit, saving: false, saveError: null, save, reload },
    [serverBacked, scope, entry, browserProfile, canEdit, save, reload]
  );
}
