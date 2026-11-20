import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { notifyInventoryChanged, subscribeInventory } from '../services/inventoryService';
import type { VendorInput } from '../data/inventory/inventorySchema';
import { MAX_VENDORS_PER_TENANT, type InventoryVendor } from '../types/inventory';

/** 'unsupported': a tenant stored only in this browser (the vendor register lives on the server). */
export type VendorRegisterStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseVendorRegister {
  supported: boolean;
  status: VendorRegisterStatus;
  vendors: InventoryVendor[];
  /** The most vendors the register holds (500). */
  limit: number;
  /** The write roles (TENANT_OWNER, TENANT_ADMIN, MSP_ADMIN). */
  canEdit: boolean;
  reload: () => Promise<void>;
  /** Every mutator rejects with the ApiError unchanged; after a 404 or 409 the list has been reloaded first. */
  create: (input: VendorInput) => Promise<InventoryVendor>;
  update: (id: string, input: VendorInput, expectedUpdatedAt: string) => Promise<{ vendor: InventoryVendor; changed: boolean }>;
  remove: (id: string) => Promise<void>;
}

interface Loaded {
  tenantId: string;
  vendors: InventoryVendor[];
  limit: number;
}

const NO_VENDORS: InventoryVendor[] = [];

const isOutOfDate = (err: unknown): boolean => {
  const status = ((err ?? {}) as { status?: unknown }).status;
  return status === 404 || status === 409;
};

/**
 * The active tenant's vendors and external service providers (server-backed tenants only). Does nothing until `enabled`, and for a browser-only
 * tenant. Held in React state only: names, services and notes may be CUI and are never cached in browser storage or logged.
 */
export function useVendorRegister(options?: { enabled?: boolean }): UseVendorRegister {
  const enabled = options?.enabled ?? true;
  const { currentTenant, canEdit } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('vendorRegister'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) return;
    try {
      const res = await ApiClient.listInventoryVendors(tenantId);
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setLoaded({ tenantId, vendors: res.vendors, limit: res.limit });
      setFailedFor(null);
    } catch {
      if (request !== latest.current) return;
      setFailedFor(tenantId);
    }
  }, [tenantId, active]);

  useEffect(() => {
    void reload();
    if (!active) return undefined;
    return subscribeInventory((c) => {
      if (c.tenantId === tenantId && c.kind === 'vendors' && c.origin !== origin.current) void reload();
    });
  }, [tenantId, active, reload]);

  const change = useCallback(
    async <T>(run: () => Promise<T>, alsoTools = false): Promise<T> => {
      if (!active) throw new Error('The vendor register is not available.');
      let result: T;
      try {
        result = await run();
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
      await reload();
      notifyInventoryChanged(tenantId, 'vendors', null, origin.current);
      // Deleting a vendor clears the vendor of its tools and removes its document links in every program
      if (alsoTools) {
        notifyInventoryChanged(tenantId, 'tools', null, origin.current);
        notifyInventoryChanged(tenantId, 'program', null, origin.current);
      }
      return result;
    },
    [active, tenantId, reload]
  );

  const create = useCallback((input: VendorInput) => change(() => ApiClient.createInventoryVendor(tenantId, input)), [change, tenantId]);
  const update = useCallback(
    (id: string, input: VendorInput, expectedUpdatedAt: string) => change(() => ApiClient.updateInventoryVendor(tenantId, id, input, expectedUpdatedAt)),
    [change, tenantId]
  );
  const remove = useCallback(
    async (id: string): Promise<void> => {
      await change(() => ApiClient.deleteInventoryVendor(tenantId, id), true);
    },
    [change, tenantId]
  );

  // Another tenant's vendors never show while this one loads
  const mine = loaded && loaded.tenantId === tenantId ? loaded : null;
  const status: VendorRegisterStatus = !supported ? 'unsupported' : !active ? 'loading' : failedFor === tenantId ? 'error' : mine ? 'ready' : 'loading';
  return useMemo<UseVendorRegister>(
    () => ({ supported, status, vendors: active && mine ? mine.vendors : NO_VENDORS, limit: mine?.limit ?? MAX_VENDORS_PER_TENANT, canEdit, reload, create, update, remove }),
    [supported, status, active, mine, canEdit, reload, create, update, remove]
  );
}
