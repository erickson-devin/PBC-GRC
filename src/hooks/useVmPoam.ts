import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import { VM_POAM_FETCH_LIMIT, VM_POAM_UPCOMING_LIMIT, applyVmPoamRowUpdate, type VmPoamLoad } from '../data/reports/vmPoamView';
import type { VmPoamItemEvent, VmPoamItemPatch, VmPoamResponse, VmPoamRow } from '../types/vm';

export interface VmPoamItemApi {
  save: (itemId: string, patch: VmPoamItemPatch, expectedUpdatedAt: string) => Promise<{ item: VmPoamRow; changed: boolean }>;
  loadEvents: (itemId: string) => Promise<VmPoamItemEvent[]>;
  /** The item's current row, read again from the server (it may be closed and no longer in the open list). row null = the item no longer exists. */
  refreshItem: (itemId: string) => Promise<{ ok: true; row: VmPoamRow | null } | { ok: false }>;
}

export interface UseVmPoam {
  load: VmPoamLoad;
  /** quiet: keep the items on screen while the same tenant and program reload (closed-items toggle, after a save). Resolves true when this request's data was applied. */
  reload: (quiet?: boolean) => Promise<boolean>;
  /** Also load the completed and risk-accepted items (the exports still list open items only). */
  includeClosed: boolean;
  setIncludeClosed: (on: boolean) => void;
  /** A quiet reload is running. */
  refreshing: boolean;
  /** The last quiet reload failed: the items on screen may be out of date. */
  refreshFailed: boolean;
  /** Puts a saved row into the items on screen, then reads the list again. */
  applySaved: (row: VmPoamRow) => void;
  itemApi: VmPoamItemApi;
}

/**
 * The active program's vulnerability POA&M items and the findings coming due (#274), server-backed organizations only. Does nothing
 * until `enabled`. React state only: the weakness text names hosts and packages, and the owner and plan of an item are user text, so
 * none of it is ever cached in browser storage or logged.
 */
export function useVmPoam({ enabled = true }: { enabled?: boolean } = {}): UseVmPoam {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked);

  const [load, setLoad] = useState<VmPoamLoad>(() => (!supported ? { status: 'unsupported' } : enabled ? { status: 'loading' } : { status: 'idle' }));
  const [includeClosed, setIncludeClosed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useRef(0);
  const shown = useRef<{ scope: string; data: VmPoamResponse } | null>(null);
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
    setRefreshing(keep);
    setRefreshFailed(false);
    if (!keep) {
      shown.current = null;
      setLoad({ status: 'loading' }); // another program's items never stay on screen
    }
    try {
      const data = await ApiClient.getVmPoam(tenantId, { status: includeClosed ? 'all' : 'open', limit: VM_POAM_FETCH_LIMIT, upcomingLimit: VM_POAM_UPCOMING_LIMIT }, programId);
      if (request !== latest.current) return false; // a newer request (or another program) superseded this one
      shown.current = { scope, data };
      setLoad({ status: 'ready', data });
      return true;
    } catch (err: unknown) {
      if (request !== latest.current) return false;
      // Fixed states only: the server's message is never shown or logged
      if (keep) setRefreshFailed(true);
      else setLoad(err instanceof ApiError && err.status === 409 ? { status: 'no_program' } : { status: 'error' });
      return false;
    } finally {
      if (request === latest.current) setRefreshing(false);
    }
  }, [tenantId, programId, supported, enabled, includeClosed]);

  useEffect(() => {
    void reload(true); // quiet only takes effect for the scope already on screen
  }, [reload]);

  const applySaved = useCallback((row: VmPoamRow): void => {
    const current = shown.current;
    if (current) {
      const data = applyVmPoamRowUpdate(current.data, row, includeClosed);
      shown.current = { scope: current.scope, data };
      setLoad({ status: 'ready', data });
    }
    void reload(true);
  }, [includeClosed, reload]);

  const itemApi = useMemo<VmPoamItemApi>(() => ({
    save: (itemId, patch, expectedUpdatedAt) => ApiClient.updateVmPoamItem(tenantId, itemId, patch, expectedUpdatedAt, programId),
    loadEvents: (itemId) => ApiClient.getVmPoamItemEvents(tenantId, itemId, programId),
    refreshItem: async (itemId) => {
      try {
        return { ok: true, row: await ApiClient.getVmPoamItem(tenantId, itemId, programId) };
      } catch (err: unknown) {
        // A missing or foreign item is a plain 404: it is gone from this program. Anything else could not be checked.
        return err instanceof ApiError && err.status === 404 ? { ok: true, row: null } : { ok: false };
      }
    },
  }), [tenantId, programId]);

  return { load, reload, includeClosed, setIncludeClosed, refreshing, refreshFailed, applySaved, itemApi };
}
