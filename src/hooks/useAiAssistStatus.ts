import { useEffect, useState } from 'react';
import { ApiClient } from '../services/apiClient';
import { useTenant } from '../context/TenantContext';
import type { AiAssistStatus } from '../types/aiAssist';

// One status request per tenant for all panels on the page (an SSP with twelve items would otherwise ask twelve times)
const statusCache = new Map<string, Promise<AiAssistStatus>>();
function loadStatus(tenantId: string): Promise<AiAssistStatus> {
  let p = statusCache.get(tenantId);
  if (!p) {
    p = ApiClient.aiAssistStatus(tenantId).catch((): AiAssistStatus => ({ enabled: false, available: false, model: '', canUse: false, reason: 'The AI helper status could not be read.' }));
    statusCache.set(tenantId, p);
    setTimeout(() => statusCache.delete(tenantId), 30_000); // the model may be started or stopped meanwhile
  }
  return p;
}

/** The local AI helper's status for this tenant (null while it is being read, or when `enabled` is false). */
export function useAiAssistStatus(tenantId: string, enabled: boolean): AiAssistStatus | null {
  const [status, setStatus] = useState<AiAssistStatus | null>(null);
  useEffect(() => {
    if (!enabled || status) return;
    let alive = true;
    loadStatus(tenantId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [enabled, status, tenantId]);
  return status;
}

/**
 * May this person be told how to switch the AI on (an administrator hint)? False outside a TenantProvider, so components that
 * show it can still be rendered on their own (server-side tests). useTenant calls one hook and then throws, so the order of
 * hooks is the same on every render.
 */
export function useIsAiAdmin(): boolean {
  try {
    const t = useTenant();
    return t.isSuperAdmin || t.canManagePrograms;
  } catch {
    return false;
  }
}
