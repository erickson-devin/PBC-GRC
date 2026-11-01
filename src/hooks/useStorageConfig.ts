import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  fetchStorageConfig,
  getStorageConfig,
  mayFetchStorageConfig,
  getServerStorageConfig,
  subscribeStorageConfig,
  StorageConfig,
} from '../data/audit/storageDriver';
import { useAuth } from '../context/AuthContext';
import { useTenant } from '../context/TenantContext';

/**
 * Evidence storage configuration as reported by the server.
 * Fetches once the active tenant is a server-backed one the server has verified (never for a browser-only tenant, never before the
 * tenant list has synced); until the server answers, the safe on-prem default ('local') is returned.
 */
export function useStorageConfig(tenant: { id: string; serverBacked?: boolean } | undefined): StorageConfig & { loaded: boolean } {
  const config = useSyncExternalStore(subscribeStorageConfig, getStorageConfig);
  const { sessionRef } = useAuth();
  const { tenantSync } = useTenant();

  // Wait for the session reference and pass it along: it is not in browser storage yet when the first request would go out.
  useEffect(() => {
    if (!mayFetchStorageConfig({ tenantId: tenant?.id, serverBacked: tenant?.serverBacked, sessionRef, tenantsSynced: tenantSync.status === 'synced', loaded: getServerStorageConfig() !== null })) return;
    void fetchStorageConfig(tenant!.id, sessionRef);
  }, [tenant?.id, tenant?.serverBacked, sessionRef, tenantSync.status]);

  const loaded = getServerStorageConfig() !== null;
  return useMemo(() => ({ ...config, loaded }), [config, loaded]);
}
