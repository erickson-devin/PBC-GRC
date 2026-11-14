import { useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import type { InventoryObserved } from '../data/reports/inventoryDocuments';

/** The most package groups the export asks for (the server's own cap). */
export const OBSERVED_EXPORT_LIMIT = 20000;

export interface UseProgramObservedInventory {
  /** 'loading' until the first answer for the current tenant and program; 'unsupported' for a tenant stored only in this browser. */
  status: 'loading' | 'ready' | 'error' | 'unsupported';
  observed: InventoryObserved;
}

const EMPTY: InventoryObserved = { status: 'unsupported', hosts: [], software: [], totalGroups: 0, truncated: false };

/**
 * What the scanners report for the active program (GET /vm/inventory/hosts and /vm/inventory/software), for the two inventory
 * documents of the export modal. Loads only while `enabled` for a server-backed tenant; reloads when the tenant or program changes,
 * and an older answer is ignored. Held in React state only: host names, serial numbers and package names may be CUI and are never
 * cached in the browser or logged. A failure is 'error' (the document says so); the server's own text is never shown.
 */
export function useProgramObservedInventory({ enabled }: { enabled: boolean }): UseProgramObservedInventory {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; observed: InventoryObserved }>({
    status: 'loading',
    observed: { ...EMPTY, status: 'ready' },
  });
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!active) return undefined;
    // Another tenant's or program's data must never flash while this one loads
    setState({ status: 'loading', observed: { ...EMPTY, status: 'ready' } });
    void (async () => {
      try {
        const [h, s] = await Promise.all([
          ApiClient.getProgramObservedHosts(tenantId, programId),
          ApiClient.listProgramObservedSoftware(tenantId, { limit: OBSERVED_EXPORT_LIMIT }, programId),
        ]);
        if (seq.current !== mine) return;
        setState({ status: 'ready', observed: { status: 'ready', hosts: h.hosts, software: s.items, totalGroups: s.totalGroups, truncated: s.truncated } });
      } catch {
        if (seq.current !== mine) return;
        setState({ status: 'error', observed: { status: 'error', hosts: [], software: [], totalGroups: 0, truncated: false } });
      }
    })();
    return () => {
      seq.current++;
    };
  }, [tenantId, programId, active]);

  if (!supported) return { status: 'unsupported', observed: EMPTY };
  return state;
}
