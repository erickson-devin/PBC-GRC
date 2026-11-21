import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import type { FrameworkCopyRun, FrameworkCopySuggestions } from '../types/frameworkCopy';

export type Rev3SuggestionsLoad =
  | { status: 'off' } // not a Rev. 3 program, a browser-only organization, or no active program
  | { status: 'loading' }
  | { status: 'ready'; data: FrameworkCopySuggestions }
  | { status: 'error' };

export type FrameworkCopyRunsLoad =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; runs: FrameworkCopyRun[] }
  | { status: 'error' };

/** What the Rev. 2 program the active Rev. 3 program was copied from suggests for each control (#255), read once per mount and again on a tenant or program change. Every role reads. React state only: nothing is stored or logged, and nothing here changes a control. */
export function useRev3Suggestions(enabled: boolean): { load: Rev3SuggestionsLoad; reload: () => Promise<void> } {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = enabled && Boolean(currentTenant.serverBacked) && programId !== null;
  const [load, setLoad] = useState<Rev3SuggestionsLoad>(() => (supported ? { status: 'loading' } : { status: 'off' }));
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported || !programId) {
      setLoad({ status: 'off' });
      return;
    }
    setLoad({ status: 'loading' }); // another program's suggestions never stay on screen
    try {
      const data = await ApiClient.getFrameworkCopySuggestions(tenantId, programId);
      if (request !== latest.current) return;
      setLoad({ status: 'ready', data });
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

/** The copies already made into the active Rev. 3 program (newest first), for the line on the matrix. */
export function useFrameworkCopyRuns(enabled: boolean): { load: FrameworkCopyRunsLoad; reload: () => Promise<void> } {
  const { currentTenant, activeProgram } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = enabled && Boolean(currentTenant.serverBacked) && programId !== null;
  const [load, setLoad] = useState<FrameworkCopyRunsLoad>(() => (supported ? { status: 'loading' } : { status: 'off' }));
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!supported || !programId) {
      setLoad({ status: 'off' });
      return;
    }
    setLoad({ status: 'loading' });
    try {
      const runs = await ApiClient.getFrameworkCopyRuns(tenantId, programId);
      if (request !== latest.current) return;
      setLoad({ status: 'ready', runs });
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
