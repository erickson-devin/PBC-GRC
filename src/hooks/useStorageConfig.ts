import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  fetchStorageConfig,
  getStorageConfig,
  getServerStorageConfig,
  subscribeStorageConfig,
  StorageConfig,
} from '../data/audit/storageDriver';

/**
 * Evidence storage configuration as reported by the server.
 * Fetches once per tenant switch; until the server answers, the safe on-prem default ('local') is returned.
 */
export function useStorageConfig(tenantId: string | undefined): StorageConfig & { loaded: boolean } {
  const config = useSyncExternalStore(subscribeStorageConfig, getStorageConfig);

  useEffect(() => {
    if (!tenantId || getServerStorageConfig()) return;
    void fetchStorageConfig(tenantId);
  }, [tenantId]);

  const loaded = getServerStorageConfig() !== null;
  return useMemo(() => ({ ...config, loaded }), [config, loaded]);
}
