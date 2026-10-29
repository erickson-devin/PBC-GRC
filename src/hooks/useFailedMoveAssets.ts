import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { unmatchedLocalAssets } from '../services/browserStorageScrub';
import { failedMovesFor, setFailedMoveAssets } from '../services/failedMoves';
import { pushAssetsToServer } from '../services/assetMove';
import { clearLocalEnclaveAssets, getEnclaveAssets, isDemoSeedAsset } from '../data/telemetry/assetRegistry';
import { notifyAssetsChanged } from '../services/assetService';
import type { EnclaveAsset } from '../types/telemetry';

export interface FailedMoveAssets {
  pending: number;
  status: 'idle' | 'checking' | 'retrying';
  error: string | null;
  lastResult: { moved: number; stillLocal: number } | null;
  retry: () => Promise<void>;
}

/**
 * Assets that did not reach the server when a browser-only tenant was moved stay in this browser under the OLD tenant id, and a small
 * record (ids and a count) links them to the new tenant. This hook reconciles that record once per tenant per session (a list the
 * server already holds is removed), and offers a retry. Logs counts only.
 */
export function useFailedMoveAssets(): FailedMoveAssets {
  const { currentTenant } = useTenant();
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<FailedMoveAssets['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FailedMoveAssets['lastResult']>(null);
  // The count found for each tenant this session, so switching away and back shows it again without another check
  const counts = useRef<Map<string, number>>(new Map());
  const busy = useRef(false);
  const activeTenant = useRef(currentTenant.id);
  activeTenant.current = currentTenant.id;

  /** Re-counts what is still only in this browser for one old tenant id; clears the local list when the server holds it all. */
  const reconcileOne = useCallback(async (tenantId: string, fromTenantId: string, token: string): Promise<{ stillLocal: number; unmatched: EnclaveAsset[] }> => {
    const local = getEnclaveAssets(fromTenantId).filter(a => !isDemoSeedAsset(a, fromTenantId));
    if (local.length === 0) {
      setFailedMoveAssets(localStorage, fromTenantId, 0);
      return { stillLocal: 0, unmatched: [] };
    }
    const server = await ApiClient.listAssets(tenantId, token);
    const unmatched = unmatchedLocalAssets(local, server.assets, fromTenantId);
    if (unmatched.length === 0) clearLocalEnclaveAssets(fromTenantId);
    setFailedMoveAssets(localStorage, fromTenantId, unmatched.length);
    return { stillLocal: unmatched.length, unmatched };
  }, []);

  useEffect(() => {
    setPending(0);
    setError(null);
    setLastResult(null);
    if (!currentTenant.serverBacked) return;
    const token = ApiClient.getToken();
    if (!token) return;
    const tenantId = currentTenant.id;
    const known = counts.current.get(tenantId);
    if (known !== undefined) {
      setPending(known);
      return;
    }
    counts.current.set(tenantId, 0);
    if (failedMovesFor(localStorage, tenantId).length === 0) return;
    void (async () => {
      setStatus('checking');
      try {
        let total = 0;
        for (const rec of failedMovesFor(localStorage, tenantId)) {
          total += (await reconcileOne(tenantId, rec.fromTenantId, token)).stillLocal;
        }
        counts.current.set(tenantId, total);
        if (activeTenant.current === tenantId) setPending(total);
      } catch {
        // the server could not be reached: the record and the local list stay and the next session tries again
        counts.current.delete(tenantId);
      } finally {
        setStatus('idle');
      }
    })();
  }, [currentTenant.id, currentTenant.serverBacked, reconcileOne]);

  const retry = useCallback(async () => {
    if (busy.current || !currentTenant.serverBacked) return;
    const token = ApiClient.getToken();
    if (!token) return;
    const tenantId = currentTenant.id;
    busy.current = true;
    setStatus('retrying');
    setError(null);
    try {
      let sent = 0;
      let moved = 0;
      let failed = 0;
      let stillLocal = 0;
      for (const rec of failedMovesFor(localStorage, tenantId)) {
        const before = await reconcileOne(tenantId, rec.fromTenantId, token);
        if (before.unmatched.length > 0) {
          sent += before.unmatched.length;
          const res = await pushAssetsToServer(
            { bulk: (t, i) => ApiClient.createAssetsBulk(t, i, token), single: (t, i) => ApiClient.createAsset(t, i, token) },
            tenantId,
            before.unmatched
          );
          moved += res.moved;
          failed += res.failed;
        }
        stillLocal += (await reconcileOne(tenantId, rec.fromTenantId, token)).stillLocal;
      }
      notifyAssetsChanged(tenantId);
      console.info(`[asset-move-retry] sent ${sent}, moved ${moved}, failed ${failed}, still local ${stillLocal}`);
      counts.current.set(tenantId, stillLocal);
      if (activeTenant.current === tenantId) setPending(stillLocal);
      setLastResult({ moved, stillLocal });
    } catch {
      setError('The server could not be reached. Nothing was removed from this browser.');
    } finally {
      busy.current = false;
      setStatus('idle');
    }
  }, [currentTenant.id, currentTenant.serverBacked, reconcileOne]);

  return { pending, status, error, lastResult, retry };
}
