import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { subscribeInventory } from '../services/inventoryService';
import type { ToolMembership } from '../types/inventory';

/** 'unsupported': a tenant stored only in this browser (no programs); 'loading' also covers a disabled hook. */
export type ToolMembershipsStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseToolMemberships {
  status: ToolMembershipsStatus;
  /** The declared tools of every program, archived ones included (an undeclared program lists none and uses the whole register). */
  memberships: ToolMembership[];
  reload: () => Promise<void>;
}

interface Loaded {
  tenantId: string;
  memberships: ToolMembership[];
}

const NONE: ToolMembership[] = [];

/**
 * Which tools each program declares: feeds the per-program cost totals. Server-backed tenants only; nothing is loaded until `enabled`. Held in React
 * state only. Reloads when the register or any program's boundary changes.
 */
export function useToolMemberships(options?: { enabled?: boolean }): UseToolMemberships {
  const enabled = options?.enabled ?? true;
  const { currentTenant } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked);
  const active = supported && enabled;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) return;
    try {
      const memberships = await ApiClient.listToolMemberships(tenantId);
      if (request !== latest.current) return;
      setLoaded({ tenantId, memberships });
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
      if (c.tenantId === tenantId && (c.kind === 'tools' || c.kind === 'program')) void reload();
    });
  }, [tenantId, active, reload]);

  const mine = loaded && loaded.tenantId === tenantId ? loaded : null;
  const status: ToolMembershipsStatus = !supported ? 'unsupported' : !active ? 'loading' : failedFor === tenantId ? 'error' : mine ? 'ready' : 'loading';
  return useMemo<UseToolMemberships>(() => ({ status, memberships: active && mine ? mine.memberships : NONE, reload }), [status, active, mine, reload]);
}
