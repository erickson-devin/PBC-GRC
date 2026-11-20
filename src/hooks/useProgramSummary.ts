import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAssessment } from '../context/AssessmentContext';
import { useTenant } from '../context/TenantContext';
import {
  BLANK_PROGRAM_SUMMARY,
  getProgramSummaryEntry,
  invalidateProgramSummary,
  reloadProgramSummary,
  subscribeProgramSummary,
  watchProgramSummary,
} from '../services/programSummaryService';
import type { ProgramSummary } from '../types/programSummary';

/** 'unsupported': an organization stored only in this browser (the server holds no summary); 'no_program': the organization has no open program. */
export type ProgramSummaryHookStatus = 'unsupported' | 'no_program' | 'loading' | 'ready' | 'error';

export interface UseProgramSummary {
  /** False for a browser-only organization: no request is made and `summary` stays null. */
  supported: boolean;
  status: ProgramSummaryHookStatus;
  /** The server's counts for the active program (an archived program is readable); after a failed refresh the last good summary stays with status 'error'. */
  summary: ProgramSummary | null;
  /** Fetches again now. Never rejects. */
  reload: () => Promise<void>;
}

/**
 * The active program's summary (GET /program-summary), shared by every screen that shows it (the journey bar, the dashboard): one request per program,
 * held in memory only. It refreshes when the register, the program's boundary or documents change, when the member list changes and when the tab changes
 * (which covers sign-offs and POA&M saves made on another tab).
 */
export function useProgramSummary(): UseProgramSummary {
  const { currentTenant, activeProgram, programsStatus, teamMembers } = useTenant();
  const { activeTab } = useAssessment();
  const tenantId = currentTenant.id;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported';
  const programId = activeProgram?.id ?? null;
  const live = supported && programId !== null;

  const getSnapshot = useCallback(() => (live && programId ? getProgramSummaryEntry(tenantId, programId) : BLANK_PROGRAM_SUMMARY), [live, tenantId, programId]);
  const entry = useSyncExternalStore(subscribeProgramSummary, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!live || !programId) return undefined;
    return watchProgramSummary(tenantId, programId);
  }, [live, tenantId, programId]);

  // People and the tab: no notification exists for member changes, sign-offs or POA&M saves, so these ask again (the first run is the load above)
  const members = teamMembers[tenantId];
  const seen = useRef<{ scope: string; members: unknown; tab: string } | null>(null);
  useEffect(() => {
    if (!live || !programId) {
      seen.current = null;
      return;
    }
    const scope = `${tenantId}::${programId}`;
    const prev = seen.current;
    seen.current = { scope, members, tab: activeTab };
    if (prev && prev.scope === scope && (prev.members !== members || prev.tab !== activeTab)) invalidateProgramSummary(tenantId, programId);
  }, [live, tenantId, programId, members, activeTab]);

  const reload = useCallback(async (): Promise<void> => {
    if (!live || !programId) return;
    await reloadProgramSummary(tenantId, programId);
  }, [live, tenantId, programId]);

  const status: ProgramSummaryHookStatus = !supported ? 'unsupported' : programId === null ? 'no_program' : entry.status;
  return useMemo<UseProgramSummary>(() => ({ supported, status, summary: live ? entry.summary : null, reload }), [supported, status, live, entry.summary, reload]);
}
