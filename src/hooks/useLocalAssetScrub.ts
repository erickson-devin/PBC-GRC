import { useEffect, useRef } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { planLocalAssetCleanup } from '../services/browserStorageScrub';
import { clearLocalEnclaveAssets, getEnclaveAssets } from '../data/telemetry/assetRegistry';

/**
 * For a server-backed tenant the server is the only home of the asset inventory, so a browser-local list left by an older version is
 * removed, but only once the server holds every real asset in it (matched by host name or MAC). Runs once per tenant per session.
 * Logs counts only.
 */
export function useLocalAssetScrub(): void {
  const { currentTenant } = useTenant();
  const done = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!currentTenant.serverBacked) return;
    const sessionRef = ApiClient.getSessionRef();
    if (!sessionRef) return;
    const tenantId = currentTenant.id;
    if (done.current.has(tenantId)) return;
    done.current.add(tenantId);
    void (async () => {
      try {
        const local = getEnclaveAssets(tenantId);
        if (local.length === 0) return;
        const server = await ApiClient.listAssets(tenantId, sessionRef);
        const plan = planLocalAssetCleanup(local, server.assets, tenantId);
        if (plan.removable) clearLocalEnclaveAssets(tenantId);
        console.info(`[asset-cache-scrub] local asset list ${plan.removable ? 'removed' : 'kept'}, local ${local.length}, unmatched ${plan.unmatched}`);
      } catch {
        // the server could not be reached: the local list stays and the next session tries again
      }
    })();
  }, [currentTenant.id, currentTenant.serverBacked]);
}
