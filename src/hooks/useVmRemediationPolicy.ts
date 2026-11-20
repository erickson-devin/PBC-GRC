import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import type { VmRemediationPolicy } from '../data/vmRemediation';
import type { VmPolicyEvent, VmPolicySaveResult, VmRemediationPolicyResponse, VmRemediationSummary } from '../types/vmRemediation';

/** Any failure is 'error': the server's own text is never shown, and nothing is cached or logged. */
export type VmPolicyLoad =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; offline: boolean }
  | { status: 'ready'; data: VmRemediationPolicyResponse };

export type VmSummaryLoad =
  | { status: 'unsupported' | 'idle' | 'loading' }
  | { status: 'error'; offline: boolean }
  | { status: 'ready'; data: VmRemediationSummary };

const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;

/**
 * The organization's vulnerability remediation policy (server-backed organizations only), tenant-wide: it applies to every program, so no program is
 * involved. React state only. `save` throws the ApiError so the panel can map it; `reload` never throws and keeps the data on screen while it runs.
 */
export function useVmRemediationPolicy({ enabled }: { enabled: boolean }): {
  load: VmPolicyLoad;
  reload: () => Promise<VmRemediationPolicyResponse | null>;
  save: (p: VmRemediationPolicy, expectedUpdatedAt: string | null) => Promise<VmPolicySaveResult>;
  loadEvents: () => Promise<VmPolicyEvent[]>;
} {
  const { currentTenant } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const [state, setState] = useState<{ tenantId: string; load: VmPolicyLoad }>({ tenantId, load: { status: 'idle' } });
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<VmRemediationPolicyResponse | null> => {
    const mine = ++seq.current;
    if (!supported || !enabled) {
      setState({ tenantId, load: { status: supported ? 'idle' : 'unsupported' } });
      return null;
    }
    setState((prev) => (prev.tenantId === tenantId && prev.load.status === 'ready' ? prev : { tenantId, load: { status: 'loading' } }));
    try {
      const data = await ApiClient.getVmRemediationPolicy(tenantId);
      if (seq.current !== mine) return null;
      setState({ tenantId, load: { status: 'ready', data } });
      return data;
    } catch (err: unknown) {
      if (seq.current !== mine) return null;
      setState((prev) => (prev.tenantId === tenantId && prev.load.status === 'ready' ? prev : { tenantId, load: { status: 'error', offline: isOffline(err) } }));
      return null;
    }
  }, [tenantId, supported, enabled]);

  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
    };
  }, [reload]);

  const save = useCallback((p: VmRemediationPolicy, expectedUpdatedAt: string | null) => ApiClient.saveVmRemediationPolicy(tenantId, p, expectedUpdatedAt), [tenantId]);
  const loadEvents = useCallback(() => ApiClient.getVmRemediationPolicyEvents(tenantId), [tenantId]);

  const load: VmPolicyLoad = state.tenantId === tenantId ? state.load : { status: supported ? 'idle' : 'unsupported' };
  return { load: supported ? load : { status: 'unsupported' }, reload, save, loadEvents };
}

/** The open-vulnerability counts per remediation tier for the whole organization (GET .../vm/remediation/summary). */
export function useVmRemediationSummary({ enabled }: { enabled: boolean }): { load: VmSummaryLoad; reload: () => void } {
  const { currentTenant } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const [state, setState] = useState<{ tenantId: string; load: VmSummaryLoad }>({ tenantId, load: { status: 'idle' } });
  const seq = useRef(0);

  const run = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    if (!supported || !enabled) {
      setState({ tenantId, load: { status: supported ? 'idle' : 'unsupported' } });
      return;
    }
    setState((prev) => (prev.tenantId === tenantId && prev.load.status === 'ready' ? prev : { tenantId, load: { status: 'loading' } }));
    try {
      const data = await ApiClient.getVmRemediationSummary(tenantId);
      if (seq.current !== mine) return;
      setState({ tenantId, load: { status: 'ready', data } });
    } catch (err: unknown) {
      if (seq.current !== mine) return;
      setState((prev) => (prev.tenantId === tenantId && prev.load.status === 'ready' ? prev : { tenantId, load: { status: 'error', offline: isOffline(err) } }));
    }
  }, [tenantId, supported, enabled]);

  useEffect(() => {
    void run();
    return () => {
      seq.current++;
    };
  }, [run]);

  const reload = useCallback(() => {
    void run();
  }, [run]);

  const load: VmSummaryLoad = state.tenantId === tenantId ? state.load : { status: supported ? 'idle' : 'unsupported' };
  return { load: supported ? load : { status: 'unsupported' }, reload };
}
