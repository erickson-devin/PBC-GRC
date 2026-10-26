import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  fetchStorageConfig,
  getStorageConfig,
  getServerStorageConfig,
  subscribeStorageConfig,
  StorageConfig,
} from '../data/audit/storageDriver';
import { useAuth } from '../context/AuthContext';

/**
 * Evidence storage configuration as reported by the server.
 * Fetches once per tenant switch; until the server answers, the safe on-prem default ('local') is returned.
 */
export function useStorageConfig(tenantId: string | undefined): StorageConfig & { loaded: boolean } {
  const config = useSyncExternalStore(subscribeStorageConfig, getStorageConfig);
  const { idToken } = useAuth();

  // Wait for the sign-in token and pass it along: it is not in browser storage yet when the first request would go out.
  useEffect(() => {
    if (!tenantId || !idToken || getServerStorageConfig()) return;
    void fetchStorageConfig(tenantId, idToken);
  }, [tenantId, idToken]);

  const loaded = getServerStorageConfig() !== null;
  return useMemo(() => ({ ...config, loaded }), [config, loaded]);
}
