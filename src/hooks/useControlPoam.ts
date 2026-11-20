import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import { applyControlPoamEntry, controlPoamExportFor, type ControlPoamLoad } from '../data/reports/controlPoamView';
import type { ControlPoamEvent, ControlPoamPatch, ControlPoamRecord } from '../types/controlPoam';

export interface ControlPoamApi {
  /** Saves one control's fields. `expectedUpdatedAt` is the entry's updatedAt as loaded, or null when the control has no entry yet. entry null = nothing was stored. */
  save: (controlId: string, patch: ControlPoamPatch, expectedUpdatedAt: string | null) => Promise<{ entry: ControlPoamRecord | null; changed: boolean }>;
  loadEvents: (controlId: string) => Promise<ControlPoamEvent[]>;
  /** Reads one control's stored entry again (for the merge after a stale write). ok false = the read failed; record null = the control has no entry. */
  refreshRecord: (controlId: string) => Promise<{ ok: true; record: ControlPoamRecord | null } | { ok: false }>;
}

export interface UseControlPoam {
  load: ControlPoamLoad;
  /** The records by control id once loaded (what the exports take as `extras.controlPoam`); undefined while loading, after an error and for a browser-only organization. */
  byControl: Record<string, ControlPoamRecord> | undefined;
  /** quiet: keep the entries on screen while the same tenant and program reload. Resolves true when this request's data was applied. */
  reload: (quiet?: boolean) => Promise<boolean>;
  /** Puts a saved entry into the entries on screen (an edit that stored nothing passes null: nothing changes), then reads the list again. */
  applySaved: (entry: ControlPoamRecord | null) => void;
  api: ControlPoamApi;
}

/**
 * The active program's recorded control POA&M fields (#304: owner, scheduled completion, resources, plan, milestones), server-backed organizations
 * only. Does nothing until `enabled`. React state only: every text is user text and may be CUI, so none of it is cached in browser storage or logged.
 */
export function useControlPoam({ enabled = true }: { enabled?: boolean } = {}): UseControlPoam {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked);

  const [load, setLoad] = useState<ControlPoamLoad>(() => (!supported ? { status: 'unsupported' } : enabled ? { status: 'loading' } : { status: 'idle' }));
  const latest = useRef(0);
  const shown = useRef<{ scope: string; entries: ControlPoamRecord[] } | null>(null);
  const scope = `${tenantId}|${programId ?? ''}`;

  const reload = useCallback(async (quiet = false): Promise<boolean> => {
    const request = ++latest.current;
    if (!supported) {
      shown.current = null;
      setLoad({ status: 'unsupported' });
      return false;
    }
    if (!enabled) {
      shown.current = null;
      setLoad({ status: 'idle' });
      return false;
    }
    const keep = quiet && shown.current?.scope === scope;
    if (!keep) {
      shown.current = null;
      setLoad({ status: 'loading' }); // another program's entries never stay on screen
    }
    try {
      const { entries } = await ApiClient.listControlPoam(tenantId, programId);
      if (request !== latest.current) return false; // a newer request (or another program) superseded this one
      shown.current = { scope, entries };
      setLoad({ status: 'ready', entries });
      return true;
    } catch (err: unknown) {
      if (request !== latest.current) return false;
      // Fixed states only: the server's message is never shown or logged. A failed quiet reload keeps the entries on screen.
      if (!keep) setLoad(err instanceof ApiError && err.status === 409 ? { status: 'no_program' } : { status: 'error' });
      return false;
    }
  }, [tenantId, programId, supported, enabled, scope]);

  useEffect(() => {
    void reload(true); // quiet only takes effect for the scope already on screen
  }, [reload]);

  const applySaved = useCallback((entry: ControlPoamRecord | null): void => {
    const current = shown.current;
    if (current && entry) {
      const entries = applyControlPoamEntry(current.entries, entry);
      shown.current = { scope: current.scope, entries };
      setLoad({ status: 'ready', entries });
    }
    void reload(true);
  }, [reload]);

  const api = useMemo<ControlPoamApi>(() => ({
    save: (controlId, patch, expectedUpdatedAt) => ApiClient.updateControlPoam(tenantId, controlId, patch, expectedUpdatedAt, programId),
    loadEvents: (controlId) => ApiClient.getControlPoamEvents(tenantId, controlId, programId),
    refreshRecord: async (controlId) => {
      try {
        const { entries } = await ApiClient.listControlPoam(tenantId, programId);
        return { ok: true, record: entries.find((e) => e.controlId === controlId) ?? null };
      } catch {
        return { ok: false };
      }
    },
  }), [tenantId, programId]);

  const byControl = useMemo(() => controlPoamExportFor(load), [load]);

  return { load, byControl, reload, applySaved, api };
}
