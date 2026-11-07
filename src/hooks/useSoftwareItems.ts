import { useCallback, useEffect, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { subscribeSoftware } from '../services/softwareService';
import { errorMessage } from '../utils/errors';
import type { SoftwareItem } from '../types/software';

export interface UseSoftwareItems {
  items: SoftwareItem[];
  loading: boolean;
  /** Set when the inventory could not be loaded; the previous list stays on screen. */
  error: string | null;
  reload: () => Promise<void>;
  /** The software inventory lives on the server: a tenant stored only in this browser has none. */
  supported: boolean;
  /** TENANT_OWNER / MSP_ADMIN: the only roles whose changes the server accepts. */
  canEdit: boolean;
}

/**
 * The active tenant's software inventory (server-backed tenants only). Does nothing until `enabled`, and for a browser-only
 * tenant. Held in React state only: names, vendors and notes may be CUI and are never cached in browser storage.
 */
export function useSoftwareItems({ enabled = true }: { enabled?: boolean } = {}): UseSoftwareItems {
  const { currentTenant, canEdit } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [items, setItems] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState<boolean>(active);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const list = await ApiClient.listSoftwareItems(tenantId);
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setItems(list);
      setError(null);
    } catch (err: unknown) {
      if (request !== latest.current) return;
      setError(errorMessage(err) || 'Could not load the software inventory.');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [tenantId, active]);

  useEffect(() => {
    // Another tenant's software must never flash on screen while this one loads
    setItems([]);
    setLoading(active);
    void reload();
    if (!active) return undefined;
    return subscribeSoftware((changed) => {
      if (changed === tenantId) void reload();
    });
  }, [tenantId, active, reload]);

  return { items, loading, error, reload, supported, canEdit };
}
