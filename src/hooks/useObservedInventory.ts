import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, ApiError } from '../services/apiClient';
import type { VmObservedHost, VmObservedSoftware } from '../types/vm';

/** 'gone': the server says the asset does not exist (404). Other failures are 'error'; the server's own text is never shown. */
export type ObservedStatus = 'idle' | 'loading' | 'ready' | 'error' | 'gone';

const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

export interface UseObservedInventory {
  status: ObservedStatus;
  hosts: VmObservedHost[];
  reload: () => void;
}

/**
 * What the scanners last reported for one asset (GET .../vm/assets/:assetId/inventory). Loads while `enabled` and an asset id is given;
 * a newer request (another asset, another tenant, Retry) makes an older answer ignored. The answer is held in state only: never cached
 * in the browser, never logged.
 */
export function useObservedInventory(tenantId: string, assetId: string | null, enabled: boolean): UseObservedInventory {
  const [state, setState] = useState<{ status: ObservedStatus; hosts: VmObservedHost[] }>({ status: 'idle', hosts: [] });
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    if (!enabled || !assetId) {
      setState({ status: 'idle', hosts: [] });
      return;
    }
    setState({ status: 'loading', hosts: [] });
    try {
      const r = await ApiClient.getObservedInventory(tenantId, assetId);
      if (seq.current !== mine) return;
      setState({ status: 'ready', hosts: r.observed });
    } catch (err: unknown) {
      if (seq.current !== mine) return;
      setState({ status: isNotFound(err) ? 'gone' : 'error', hosts: [] });
    }
  }, [tenantId, assetId, enabled]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { status: state.status, hosts: state.hosts, reload };
}

export interface UseObservedSoftware {
  status: ObservedStatus;
  items: VmObservedSoftware[];
  /** How many items the server holds for the asset (more than `items.length` when the list was cut at `limit`). */
  totalCount: number;
  reload: () => void;
}

/** The installed software the scanners report for one asset (GET .../vm/assets/:assetId/software), up to `limit` items. Same rules as above. */
export function useObservedSoftware(tenantId: string, assetId: string | null, limit: number, enabled: boolean): UseObservedSoftware {
  const [state, setState] = useState<{ status: ObservedStatus; items: VmObservedSoftware[]; totalCount: number }>({ status: 'idle', items: [], totalCount: 0 });
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    if (!enabled || !assetId) {
      setState({ status: 'idle', items: [], totalCount: 0 });
      return;
    }
    setState((st) => ({ ...st, status: 'loading' }));
    try {
      const r = await ApiClient.listObservedSoftware(tenantId, assetId, { limit });
      if (seq.current !== mine) return;
      setState({ status: 'ready', items: r.items, totalCount: r.totalCount });
    } catch (err: unknown) {
      if (seq.current !== mine) return;
      setState({ status: isNotFound(err) ? 'gone' : 'error', items: [], totalCount: 0 });
    }
  }, [tenantId, assetId, limit, enabled]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { status: state.status, items: state.items, totalCount: state.totalCount, reload };
}
