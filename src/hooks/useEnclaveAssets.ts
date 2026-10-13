import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { AssetBackend, AssetBackendMode, assetBackendMode, getAssetBackend, subscribeAssets } from '../services/assetService';
import { AssetScopeSummary, summarizeScope } from '../data/telemetry/assetScope';
import { errorMessage } from '../utils/errors';
import type { EnclaveAsset } from '../types/telemetry';

export interface UseEnclaveAssets {
  assets: EnclaveAsset[];
  /** The CMMC scope counts for the current assets (what the SSP boundary summary states). */
  summary: AssetScopeSummary;
  loading: boolean;
  /** Set when the inventory could not be loaded; the previous list stays on screen. */
  error: string | null;
  reload: () => Promise<void>;
  backend: AssetBackend;
  mode: AssetBackendMode;
  /** TENANT_OWNER / MSP_ADMIN: the only roles whose changes the server accepts. */
  canEdit: boolean;
}

/**
 * The active tenant's asset inventory, from the server (server-backed tenants) or the local store (tenants not yet moved
 * to the server). Refreshes when the tenant changes and whenever any component changes an asset.
 */
export function useEnclaveAssets(): UseEnclaveAssets {
  const { currentTenant, canEdit } = useTenant();
  const tenantId = currentTenant.id;
  const mode = assetBackendMode({ serverBacked: currentTenant.serverBacked });
  const backend = useMemo(() => getAssetBackend(tenantId, mode), [tenantId, mode]);

  const [assets, setAssets] = useState<EnclaveAsset[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    try {
      const list = await backend.list();
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setAssets(list);
      setError(null);
    } catch (err: unknown) {
      if (request !== latest.current) return;
      setError(errorMessage(err) || 'Could not load the asset inventory.');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    // Another tenant's assets must never flash on screen while this one loads
    setAssets([]);
    setLoading(true);
    void reload();
    return subscribeAssets((changed) => {
      if (changed === tenantId) void reload();
    });
  }, [tenantId, reload]);

  const summary = useMemo(() => summarizeScope(assets), [assets]);
  return { assets, summary, loading, error, reload, backend, mode, canEdit };
}
