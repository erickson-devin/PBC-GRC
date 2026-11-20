import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import type { VmConfigSuggestionsResponse } from '../types/vm';

export type ConfigSuggestionsLoad =
  | { status: 'unsupported' } // browser-only organization, or no active program
  | { status: 'loading' }
  | { status: 'ready'; data: VmConfigSuggestionsResponse }
  | { status: 'error' };

/** What the latest configuration scans suggest for the active program (#205), read once per mount and again on a tenant or program change. Every role reads. React state only: nothing is stored or logged, and nothing here changes a control. */
export function useConfigSuggestions(): { load: ConfigSuggestionsLoad; reload: () => Promise<void> } {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked) && programId !== null;
  const [load, setLoad] = useState<ConfigSuggestionsLoad>(() => (supported ? { status: 'loading' } : { status: 'unsupported' }));
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported || !programId) {
      setLoad({ status: 'unsupported' });
      return;
    }
    setLoad({ status: 'loading' }); // another program's suggestions never stay on screen
    try {
      const data = await ApiClient.getConfigSuggestions(tenantId, programId);
      if (request !== latest.current) return;
      setLoad(data.programId === programId ? { status: 'ready', data } : { status: 'error' });
    } catch {
      if (request !== latest.current) return;
      setLoad({ status: 'error' });
    }
  }, [tenantId, programId, supported]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { load, reload };
}
