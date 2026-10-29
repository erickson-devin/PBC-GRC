import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { subscribeAssets } from '../services/assetService';
import { errorMessage } from '../utils/errors';

/** 'unsupported': a browser-only tenant, which has no programs. */
export type ProgramAssetsStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseProgramAssets {
  /** False for a tenant that only exists in this browser: it has no programs, so there is nothing to declare. */
  supported: boolean;
  status: ProgramAssetsStatus;
  /** The assets each program declares, by program id (archived programs included). */
  memberships: Readonly<Record<string, readonly string[]>>;
  /** The assets the active program declares inside its boundary (empty when there is no active program). */
  activeIds: ReadonlySet<string>;
  /** False while the active program names no asset: its boundary is then the whole inventory. */
  declared: boolean;
  loading: boolean;
  /** Set when the programs or the memberships could not be loaded. */
  error: string | null;
  /** Declare these assets inside the active program's boundary. Rejects with the ApiError when the server refuses. */
  add: (ids: string[]) => Promise<void>;
  /** Take these assets out of the active program's boundary. Rejects with the ApiError when the server refuses. */
  remove: (ids: string[]) => Promise<void>;
  reload: () => Promise<void>;
}

const NO_MEMBERSHIPS: Record<string, string[]> = {};
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// Every mounted instance (the inventory, the always-mounted SSP export) follows a change made by any other one
type Listener = (tenantId: string, origin: symbol) => void;
const listeners = new Set<Listener>();
export function subscribeProgramAssets(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const notifyProgramAssets = (tenantId: string, origin: symbol): void => listeners.forEach((l) => l(tenantId, origin));

/** The refusals after which what is on screen is out of date: the program or an asset is gone, or the program was archived. */
const isStale = (err: unknown): boolean => {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  return e.status === 409 || e.reason === 'unknown_assets' || e.reason === 'program_not_found';
};

/**
 * Boundary asset membership (issue #26) for the active tenant and program. Server-backed tenants only. Reloads when the tenant
 * changes and whenever an asset changes (a deleted asset leaves every program). With `enabled: false` nothing is loaded.
 */
export function useProgramAssets(options?: { enabled?: boolean }): UseProgramAssets {
  const enabled = options?.enabled ?? true;
  const { currentTenant, activeProgram, programsStatus, refreshPrograms } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const activeId = activeProgram?.id ?? null;

  const [memberships, setMemberships] = useState<Record<string, string[]>>(NO_MEMBERSHIPS);
  const [loading, setLoading] = useState<boolean>(supported && enabled);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('programAssets'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported || !enabled) {
      setMemberships(NO_MEMBERSHIPS);
      setLoading(false);
      return;
    }
    try {
      const next = await ApiClient.listProgramAssetMemberships(tenantId);
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setMemberships(next);
      setError(null);
    } catch (err: unknown) {
      if (request !== latest.current) return;
      setError(errorMessage(err) || 'Could not load the boundary assets.');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [tenantId, supported, enabled]);

  useEffect(() => {
    // Another tenant's membership must never flash on screen while this one loads
    setMemberships(NO_MEMBERSHIPS);
    setLoading(supported && enabled);
    void reload();
    const offAssets = subscribeAssets((changed) => {
      if (changed === tenantId) void reload();
    });
    const offMemberships = subscribeProgramAssets((changed, from) => {
      if (changed === tenantId && from !== origin.current) void reload();
    });
    return () => {
      offAssets();
      offMemberships();
    };
  }, [tenantId, supported, enabled, reload]);

  const change = useCallback(
    async (delta: { add?: string[]; remove?: string[] }): Promise<void> => {
      if (!supported || !activeId) throw new Error('No program is active.');
      if (!delta.add?.length && !delta.remove?.length) return;
      try {
        await ApiClient.updateProgramAssets(tenantId, activeId, delta);
      } catch (err: unknown) {
        if (isStale(err)) {
          await reload();
          void refreshPrograms(tenantId);
        }
        throw err;
      }
      await reload();
      notifyProgramAssets(tenantId, origin.current);
    },
    [supported, activeId, tenantId, reload, refreshPrograms]
  );

  const add = useCallback((ids: string[]) => change({ add: ids }), [change]);
  const remove = useCallback((ids: string[]) => change({ remove: ids }), [change]);

  const activeIds = useMemo<ReadonlySet<string>>(() => (activeId && memberships[activeId] ? new Set(memberships[activeId]) : EMPTY_SET), [activeId, memberships]);
  const declared = activeIds.size > 0;
  const status: ProgramAssetsStatus = !supported
    ? 'unsupported'
    : programsStatus === 'error' || error !== null
    ? 'error'
    : programsStatus === 'ready' && !loading
    ? 'ready'
    : 'loading';
  return useMemo(
    () => ({ supported, status, memberships, activeIds, declared, loading, error, add, remove, reload }),
    [supported, status, memberships, activeIds, declared, loading, error, add, remove, reload]
  );
}
