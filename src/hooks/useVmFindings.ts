import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient } from '../services/apiClient';
import { FINDINGS_FETCH_LIMIT } from '../data/telemetry/vmFindingsView';
import type { FindingStatusFilter } from '../data/telemetry/vmFindingsView';
import type { VmFinding } from '../types/vm';

/** Any failure is 'error': the server's own text is never shown, and nothing is cached or logged. */
export type VmFindingsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseVmFindings {
  status: VmFindingsStatus;
  findings: VmFinding[];
  reload: () => void;
}

/** The vulnerability findings the scanners report for one asset (GET .../vm/findings), filtered by status on the server, up to the server maximum. */
export function useVmFindings(tenantId: string, assetId: string | null, statusFilter: FindingStatusFilter, enabled: boolean): UseVmFindings {
  const [state, setState] = useState<{ status: VmFindingsStatus; findings: VmFinding[] }>({ status: 'idle', findings: [] });
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    if (!enabled || !assetId) {
      setState({ status: 'idle', findings: [] });
      return;
    }
    // Cleared first so findings of the previous status filter never show under the new one.
    setState({ status: 'loading', findings: [] });
    try {
      const r = await ApiClient.listVmFindings(tenantId, {
        assetId,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        limit: FINDINGS_FETCH_LIMIT,
      });
      if (seq.current !== mine) return;
      setState({ status: 'ready', findings: r.findings });
    } catch {
      if (seq.current !== mine) return;
      setState({ status: 'error', findings: [] });
    }
  }, [tenantId, assetId, statusFilter, enabled]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { status: state.status, findings: state.findings, reload };
}
