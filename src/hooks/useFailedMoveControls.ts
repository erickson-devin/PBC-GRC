import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import {
  failedControlMovesFor,
  pruneOrphanControlNotes,
  readPendingControlAnswers,
  settleFailedControls,
} from '../services/failedMoves';
import { retryPendingControls } from '../services/controlMove';
import type { ControlStatus } from '../types/cmmc';

export interface FailedMoveControls {
  pending: number;
  status: 'idle' | 'retrying';
  error: string | null;
  lastResult: {
    saved: number;
    conflicts: number;
    stillLocal: number;
    /** The conflicting control ids per old tenant id (ids only), for "Keep the server's version". */
    conflictIds: { fromTenantId: string; ids: string[] }[];
  } | null;
  retry: () => Promise<void>;
  /** Discards this browser's copy of the conflicting answers found by the last retry (the server's version stays). */
  keepServerVersion: () => Promise<void>;
}

const countPending = (tenantId: string): number =>
  failedControlMovesFor(localStorage, tenantId).reduce((n, r) => n + r.controlIds.length, 0);

/**
 * Control answers that did not reach the server when a browser-only tenant was moved stay in this browser under the OLD tenant id
 * (a small record of ids links them to the new tenant). This hook counts them without any network call and offers a retry that
 * checks the server's copy first. Logs counts only.
 */
export function useFailedMoveControls(): FailedMoveControls {
  const { currentTenant, refreshLiveData } = useTenant();
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<FailedMoveControls['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FailedMoveControls['lastResult']>(null);
  const busy = useRef(false);
  const activeTenant = useRef(currentTenant.id);
  activeTenant.current = currentTenant.id;

  useEffect(() => {
    setPending(0);
    setError(null);
    setLastResult(null);
    if (!currentTenant.serverBacked) return;
    if (!ApiClient.getSessionRef()) return;
    pruneOrphanControlNotes(localStorage);
    setPending(countPending(currentTenant.id));
  }, [currentTenant.id, currentTenant.serverBacked]);

  const retry = useCallback(async () => {
    if (busy.current || !currentTenant.serverBacked) return;
    if (!ApiClient.getSessionRef()) return;
    const tenantId = currentTenant.id;
    busy.current = true;
    setStatus('retrying');
    setError(null);
    try {
      let sent = 0;
      let saved = 0;
      let conflicts = 0;
      const conflictIds: { fromTenantId: string; ids: string[] }[] = [];
      for (const rec of failedControlMovesFor(localStorage, tenantId)) {
        const stored = readPendingControlAnswers(localStorage, rec.fromTenantId);
        const answers: typeof stored = {};
        for (const id of rec.controlIds) if (stored[id]) answers[id] = stored[id];
        const res = await retryPendingControls(
          {
            getServerControls: () => ApiClient.getControls(tenantId, undefined, null),
            pushControl: (id, a) => ApiClient.updateControl(
              tenantId,
              id,
              { status: a.status as ControlStatus, implementationNotes: a.implementationNotes, responsibleRole: a.responsibleRole, updatedBy: a.updatedBy },
              null
            ),
          },
          answers
        );
        settleFailedControls(localStorage, rec.fromTenantId, res.confirmed);
        sent += res.sent;
        saved += res.confirmed.length;
        conflicts += res.conflicts.length;
        if (res.conflicts.length > 0) conflictIds.push({ fromTenantId: rec.fromTenantId, ids: res.conflicts });
      }
      const stillLocal = countPending(tenantId);
      if (saved > 0) await refreshLiveData().catch(() => undefined);
      console.info(`[control-move-retry] sent ${sent}, saved ${saved}, conflicts ${conflicts}, still local ${stillLocal}`);
      if (activeTenant.current === tenantId) setPending(stillLocal);
      setLastResult({ saved, conflicts, stillLocal, conflictIds });
    } catch {
      setError('The server could not be reached. Nothing was removed from this browser.');
    } finally {
      busy.current = false;
      setStatus('idle');
    }
  }, [currentTenant.id, currentTenant.serverBacked, refreshLiveData]);

  const keepServerVersion = useCallback(async () => {
    const tenantId = currentTenant.id;
    const found = lastResult?.conflictIds ?? [];
    for (const c of found) settleFailedControls(localStorage, c.fromTenantId, c.ids);
    const stillLocal = countPending(tenantId);
    if (activeTenant.current === tenantId) setPending(stillLocal);
    setLastResult(prev => (prev ? { ...prev, conflicts: 0, stillLocal, conflictIds: [] } : prev));
  }, [currentTenant.id, lastResult]);

  return { pending, status, error, lastResult, retry, keepServerVersion };
}
