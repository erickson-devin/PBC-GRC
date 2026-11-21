import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient, ApiError } from '../services/apiClient';
import type { VmDecisionAction } from '../data/telemetry/vmRemediationView';
import type { VmDecision } from '../types/vmRemediation';

/** Any failure is 'error': the server's own text is never shown, and nothing is cached or logged. Justification text lives in React state only. */
export type VmDecisionsLoad =
  | { status: 'unsupported' | 'idle' | 'loading' }
  | { status: 'error'; offline: boolean }
  | { status: 'ready'; decisions: VmDecision[] };

const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;

function runAction(tenantId: string, id: string, a: VmDecisionAction): Promise<VmDecision> {
  if (a === 'approve') return ApiClient.approveVmDecision(tenantId, id);
  if (a === 'reject') return ApiClient.rejectVmDecision(tenantId, id);
  if (a === 'withdraw') return ApiClient.withdrawVmDecision(tenantId, id);
  return ApiClient.revokeVmDecision(tenantId, id);
}

/** Loads decisions with `fetcher`, keeping the list on screen while it reloads and guarding against a stale answer. */
function useDecisionList(key: string, supported: boolean, enabled: boolean, fetcher: (tenantId: string) => Promise<VmDecision[]>) {
  const { currentTenant } = useTenant();
  const tenantId = currentTenant.id;
  const [state, setState] = useState<{ key: string; load: VmDecisionsLoad }>({ key: `${tenantId}|${key}`, load: { status: 'idle' } });
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const stateKey = `${tenantId}|${key}`;

  const run = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    if (!supported || !enabled) {
      setState({ key: stateKey, load: { status: supported ? 'idle' : 'unsupported' } });
      return;
    }
    setState((prev) => (prev.key === stateKey && prev.load.status === 'ready' ? prev : { key: stateKey, load: { status: 'loading' } }));
    try {
      const decisions = await fetchRef.current(tenantId);
      if (seq.current !== mine) return;
      setState({ key: stateKey, load: { status: 'ready', decisions } });
    } catch (err: unknown) {
      if (seq.current !== mine) return;
      setState({ key: stateKey, load: { status: 'error', offline: isOffline(err) } });
    }
  }, [tenantId, stateKey, supported, enabled]);

  useEffect(() => {
    void run();
    return () => {
      seq.current++;
    };
  }, [run]);

  const reload = useCallback(() => {
    void run();
  }, [run]);

  const load: VmDecisionsLoad = !supported ? { status: 'unsupported' } : state.key === stateKey ? state.load : { status: 'idle' };
  return { load, reload, tenantId };
}

/** The organization's decisions waiting for approval, or in force and expiring within 30 days. `act` throws the ApiError; the caller reloads. */
export function useVmDecisions(filter: 'pending' | 'expiring', enabled: boolean): {
  load: VmDecisionsLoad;
  reload: () => void;
  act: (id: string, a: VmDecisionAction) => Promise<VmDecision>;
} {
  const { currentTenant } = useTenant();
  const { load, reload, tenantId } = useDecisionList(filter, Boolean(currentTenant.serverBacked), enabled, (t) => ApiClient.listVmDecisions(t, filter));
  const act = useCallback((id: string, a: VmDecisionAction) => runAction(tenantId, id, a), [tenantId]);
  return { load, reload, act };
}

/** One finding's decisions, with the request and the actions. `request` and `act` throw the ApiError; the caller reloads. */
export function useVmFindingDecisions(findingId: string, enabled: boolean): {
  load: VmDecisionsLoad;
  reload: () => void;
  request: (b: { kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE'; justification: string; expiresAt: string }) => Promise<VmDecision>;
  act: (id: string, a: VmDecisionAction) => Promise<VmDecision>;
} {
  const { currentTenant } = useTenant();
  const { load, reload, tenantId } = useDecisionList(`finding:${findingId}`, Boolean(currentTenant.serverBacked), enabled, (t) => ApiClient.listVmFindingDecisions(t, findingId));
  const request = useCallback(
    (b: { kind: 'RISK_ACCEPTED' | 'FALSE_POSITIVE'; justification: string; expiresAt: string }) => ApiClient.requestVmFindingDecision(tenantId, findingId, b),
    [tenantId, findingId],
  );
  const act = useCallback((id: string, a: VmDecisionAction) => runAction(tenantId, id, a), [tenantId]);
  return { load, reload, request, act };
}
