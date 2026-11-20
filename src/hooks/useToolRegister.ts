import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { notifyInventoryChanged, subscribeInventory } from '../services/inventoryService';
import type { ToolInputWithSeed } from '../data/inventory/inventorySchema';
import { MAX_TOOLS_PER_TENANT, type InventoryTool, type ToolBatchResult, type ToolInput, type ToolUsage } from '../types/inventory';

/** 'unsupported': a tenant stored only in this browser (the register lives on the server). */
export type ToolRegisterStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseToolRegister {
  /** The register lives on the server: a tenant stored only in this browser has none. */
  supported: boolean;
  status: ToolRegisterStatus;
  tools: InventoryTool[];
  /** The most tools the register holds (1,000). */
  limit: number;
  /** The write roles (TENANT_OWNER, TENANT_ADMIN, MSP_ADMIN): the only roles whose changes the server accepts. */
  canEdit: boolean;
  /** Annual cost is shown to the write roles only (the server leaves `annualCostCents` out for the others: an absent key is "not available", never zero). */
  showCost: boolean;
  reload: () => Promise<void>;
  /** Every mutator rejects with the ApiError unchanged; after a 404 or 409 the list has been reloaded first. */
  create: (input: ToolInput) => Promise<InventoryTool>;
  createBatch: (items: ToolInputWithSeed[]) => Promise<ToolBatchResult>;
  update: (id: string, input: ToolInput, expectedUpdatedAt: string) => Promise<{ tool: InventoryTool; changed: boolean }>;
  remove: (id: string) => Promise<void>;
  usage: (id: string) => Promise<ToolUsage>;
  /** Ranks these tool ids 1..n (tools not listed become unranked); `expectedOrder` is the order the caller last saw. */
  setOrder: (order: string[], expectedOrder: string[]) => Promise<void>;
}

interface Loaded {
  tenantId: string;
  tools: InventoryTool[];
  limit: number;
}

const NO_TOOLS: InventoryTool[] = [];

/** The refusals after which what is on screen is out of date: the tool is gone, or someone else changed it or the order. */
const isOutOfDate = (err: unknown): boolean => {
  const status = ((err ?? {}) as { status?: unknown }).status;
  return status === 404 || status === 409;
};

/**
 * The active tenant's Tools and Services register (server-backed tenants only). Does nothing until `enabled`, and for a browser-only tenant.
 * Held in React state only: names, vendors, missions, notes and cost may be CUI and are never cached in browser storage, logged or sent anywhere
 * but the server. Reloads when any other instance (the panel, the SSP builder, the export modal) changes the register.
 */
export function useToolRegister(options?: { enabled?: boolean }): UseToolRegister {
  const enabled = options?.enabled ?? true;
  const { currentTenant, canEdit } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);
  const origin = useRef(Symbol('toolRegister'));

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) return;
    try {
      const res = await ApiClient.listInventoryTools(tenantId);
      if (request !== latest.current) return; // a newer request (or another tenant) superseded this one
      setLoaded({ tenantId, tools: res.tools, limit: res.limit });
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
      if (c.tenantId === tenantId && c.kind === 'tools' && c.origin !== origin.current) void reload();
    });
  }, [tenantId, active, reload]);

  // One call goes through here: the list is reloaded after a change (and after a refusal that means it is out of date), then the others are told
  const change = useCallback(
    async <T>(run: () => Promise<T>): Promise<T> => {
      if (!active) throw new Error('The Tools and Services register is not available.');
      let result: T;
      try {
        result = await run();
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
      await reload();
      notifyInventoryChanged(tenantId, 'tools', null, origin.current);
      return result;
    },
    [active, tenantId, reload]
  );

  const create = useCallback((input: ToolInput) => change(() => ApiClient.createInventoryTool(tenantId, input)), [change, tenantId]);
  const createBatch = useCallback((items: ToolInputWithSeed[]) => change(() => ApiClient.createInventoryToolsBatch(tenantId, items)), [change, tenantId]);
  const update = useCallback(
    (id: string, input: ToolInput, expectedUpdatedAt: string) => change(() => ApiClient.updateInventoryTool(tenantId, id, input, expectedUpdatedAt)),
    [change, tenantId]
  );
  const remove = useCallback((id: string) => change(() => ApiClient.deleteInventoryTool(tenantId, id)), [change, tenantId]);
  const setOrder = useCallback(
    async (order: string[], expectedOrder: string[]): Promise<void> => {
      await change(() => ApiClient.setToolRecoveryOrder(tenantId, order, expectedOrder));
    },
    [change, tenantId]
  );
  const usage = useCallback(
    async (id: string): Promise<ToolUsage> => {
      if (!active) throw new Error('The Tools and Services register is not available.');
      try {
        return await ApiClient.getInventoryToolUsage(tenantId, id);
      } catch (err: unknown) {
        if (isOutOfDate(err)) await reload();
        throw err;
      }
    },
    [active, tenantId, reload]
  );

  // Another tenant's tools never show while this one loads
  const mine = loaded && loaded.tenantId === tenantId ? loaded : null;
  const status: ToolRegisterStatus = !supported ? 'unsupported' : !active ? 'loading' : failedFor === tenantId ? 'error' : mine ? 'ready' : 'loading';
  return useMemo<UseToolRegister>(
    () => ({
      supported,
      status,
      tools: active && mine ? mine.tools : NO_TOOLS,
      limit: mine?.limit ?? MAX_TOOLS_PER_TENANT,
      canEdit,
      showCost: canEdit,
      reload,
      create,
      createBatch,
      update,
      remove,
      usage,
      setOrder,
    }),
    [supported, status, active, mine, canEdit, reload, create, createBatch, update, remove, usage, setOrder]
  );
}
