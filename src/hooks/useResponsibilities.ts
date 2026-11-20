import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import type { ResponsibilitiesResponse } from '../types/assignments';

/** 'unsupported': an organization stored only in this browser. */
export type ResponsibilitiesStatus = 'unsupported' | 'loading' | 'ready' | 'error';

export interface UseResponsibilities {
  supported: boolean;
  status: ResponsibilitiesStatus;
  /** The programs with what is assigned in each (programs with nothing are left out; `truncated` when the list was cut at 2000 items). Null until loaded. */
  data: ResponsibilitiesResponse | null;
  reload: () => Promise<void>;
}

export interface ResponsibilitiesOptions {
  /** 'me': what the signed-in person is responsible for, directly and through teams (default); 'team': one team's (needs `teamId`). */
  view?: 'me' | 'team';
  teamId?: string;
  includeArchived?: boolean;
}

interface Loaded {
  key: string;
  data: ResponsibilitiesResponse;
}

/**
 * The responsibilities of the signed-in person or of a team across the organization's programs (#253). Tenant-wide (no program header). React state only:
 * the answer of an older request, or one for other options or another organization, is never shown. A team view without a team asks nothing.
 */
export function useResponsibilities(options: ResponsibilitiesOptions = {}): UseResponsibilities {
  const { currentTenant, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const view = options.view === 'team' ? 'team' : 'me';
  const teamId = view === 'team' ? options.teamId ?? '' : '';
  const includeArchived = options.includeArchived === true;
  const active = supported && (view === 'me' || teamId !== '');
  const key = `${tenantId}|${view}|${teamId}|${includeArchived ? 1 : 0}`;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    if (!active) return;
    try {
      const data = await ApiClient.getResponsibilities(tenantId, { view, teamId: teamId || undefined, includeArchived });
      if (request !== latest.current) return;
      setLoaded({ key, data });
      setFailedFor(null);
    } catch {
      if (request !== latest.current) return;
      setFailedFor(key);
    }
  }, [active, tenantId, view, teamId, includeArchived, key]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1; // an answer still on its way is for something no longer shown
    };
  }, [reload]);

  const data = loaded && loaded.key === key ? loaded.data : null;
  const status: ResponsibilitiesStatus = !supported ? 'unsupported' : !active ? 'ready' : data ? 'ready' : failedFor === key ? 'error' : 'loading';
  return useMemo<UseResponsibilities>(() => ({ supported, status, data: active ? data : null, reload }), [supported, status, active, data, reload]);
}
