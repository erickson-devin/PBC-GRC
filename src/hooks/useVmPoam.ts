import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import { VM_POAM_FETCH_LIMIT, VM_POAM_UPCOMING_LIMIT, type VmPoamLoad } from '../data/reports/vmPoamView';

export interface UseVmPoam {
  load: VmPoamLoad;
  reload: () => Promise<void>;
}

/**
 * The active program's vulnerability POA&M items and the findings coming due (#274), server-backed organizations only. Does nothing
 * until `enabled`. React state only: the weakness text names hosts and packages, so it is never cached in browser storage or logged.
 */
export function useVmPoam({ enabled = true }: { enabled?: boolean } = {}): UseVmPoam {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked);

  const [load, setLoad] = useState<VmPoamLoad>(() => (!supported ? { status: 'unsupported' } : enabled ? { status: 'loading' } : { status: 'idle' }));
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported) {
      setLoad({ status: 'unsupported' });
      return;
    }
    if (!enabled) {
      setLoad({ status: 'idle' });
      return;
    }
    setLoad({ status: 'loading' }); // another program's items never stay on screen
    try {
      const data = await ApiClient.getVmPoam(tenantId, { status: 'open', limit: VM_POAM_FETCH_LIMIT, upcomingLimit: VM_POAM_UPCOMING_LIMIT }, programId);
      if (request !== latest.current) return; // a newer request (or another program) superseded this one
      setLoad({ status: 'ready', data });
    } catch (err: unknown) {
      if (request !== latest.current) return;
      // Fixed states only: the server's message is never shown or logged
      setLoad(err instanceof ApiError && err.status === 409 ? { status: 'no_program' } : { status: 'error' });
    }
  }, [tenantId, programId, supported, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { load, reload };
}