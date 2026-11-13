import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { useAssessment } from '../context/AssessmentContext';
import { ApiClient } from '../services/apiClient';
import {
  catalogUpdateDismissKey,
  catalogUpdateFromBrowserRecord,
  catalogUpdateRows,
  catalogUpdateSummary,
  type CatalogUpdateRow,
  type CatalogUpdateSummary,
} from '../data/cmmcGuide/catalogUpdateReview';
import type { CatalogUpdateChanges } from '../types/controlObjectives';

export interface UseCatalogUpdateChanges {
  /** 'off': not a CMMC program (or no program yet); 'error': the listing could not be loaded (the notice then stays hidden). */
  status: 'off' | 'loading' | 'error' | 'ready';
  rev: string | null;
  /** ISO time the update ran (the first answer it changed). */
  changedAt: string | null;
  rows: CatalogUpdateRow[];
  summary: CatalogUpdateSummary;
  truncated: boolean;
  /** This person has dismissed the notice for this revision. */
  dismissed: boolean;
  dismiss: () => void;
  reload: () => void;
}

const NO_ROWS: CatalogUpdateRow[] = [];

/**
 * The answers the CMMC Assessment Guide update set back to In progress, for the program on screen (#287). A server-backed tenant asks the server
 * (held in React state only); a browser-only tenant reads the record its cache kept. The dismissal is the only thing stored: per user, in browser
 * storage under a key of ids and a revision, or in the cache record for a browser-only tenant.
 */
export function useCatalogUpdateChanges(): UseCatalogUpdateChanges {
  const { currentTenant, currentUser, activeProgram, activeFramework } = useTenant();
  const { state, dismissCatalogUpdate } = useAssessment();
  const tenantId = currentTenant.id;
  const serverBacked = Boolean(currentTenant.serverBacked);
  const programId = activeProgram?.id ?? null;
  const cmmc = activeFramework === 'CMMC_L1' || activeFramework === 'CMMC_L2';
  const serverActive = cmmc && serverBacked && programId !== null;
  const scope = `${tenantId}::${programId ?? ''}`;

  const [fetched, setFetched] = useState<{ scope: string; changes: CatalogUpdateChanges | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [dismissTick, setDismissTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!serverActive) return;
    const request = ++latest.current;
    ApiClient.getCatalogUpdateChanges(tenantId, programId)
      .then((changes) => {
        if (request === latest.current) setFetched({ scope, changes });
      })
      .catch(() => {
        if (request === latest.current) setFetched({ scope, changes: null });
      });
  }, [serverActive, tenantId, programId, scope, tick]);

  const reload = useCallback(() => {
    setFetched(null);
    setTick((t) => t + 1);
  }, []);

  // A server-backed tenant ignores the cache record (a cache moved to the server may still carry it): the server's answer is the one that counts
  const browserChanges = useMemo(
    () => (cmmc && !serverBacked && state.catalogUpdate ? catalogUpdateFromBrowserRecord(state.catalogUpdate) : null),
    [cmmc, serverBacked, state.catalogUpdate]
  );

  let status: UseCatalogUpdateChanges['status'] = 'off';
  let changes: CatalogUpdateChanges | null = null;
  if (cmmc && !serverBacked) {
    status = 'ready';
    changes = browserChanges;
  } else if (serverActive) {
    if (!fetched || fetched.scope !== scope) status = 'loading';
    else if (!fetched.changes) status = 'error';
    else {
      status = 'ready';
      changes = fetched.changes;
    }
  }

  const rows = useMemo(
    () => (changes ? catalogUpdateRows(changes, activeFramework, state.objectives) : NO_ROWS),
    [changes, activeFramework, state.objectives]
  );
  const summary = useMemo(() => catalogUpdateSummary(rows), [rows]);

  const rev = changes?.catalogRev ?? null;
  const changedAt = useMemo(() => {
    const times = [...(changes?.objectives ?? []), ...(changes?.controls ?? [])].map((c) => c.changedAt).filter(Boolean).sort();
    return times[0] ?? null;
  }, [changes]);

  const dismissKey = serverBacked && rev ? catalogUpdateDismissKey(tenantId, programId, rev, currentUser.id) : null;
  const dismissed = useMemo(() => {
    if (!serverBacked) return Boolean(state.catalogUpdate?.dismissedAt);
    if (!dismissKey) return false;
    try {
      return Boolean(window.localStorage.getItem(dismissKey));
    } catch {
      return false;
    }
    // dismissTick: re-read after this hook's own dismiss
  }, [serverBacked, state.catalogUpdate?.dismissedAt, dismissKey, dismissTick]);

  const dismiss = useCallback(() => {
    if (!serverBacked) {
      dismissCatalogUpdate();
      return;
    }
    if (dismissKey) {
      try {
        window.localStorage.setItem(dismissKey, new Date().toISOString());
      } catch {
        // storage refused: nothing is kept, and the notice shows again on the next load
      }
    }
    setDismissTick((t) => t + 1);
  }, [serverBacked, dismissKey, dismissCatalogUpdate]);

  return { status, rev, changedAt, rows, summary, truncated: changes?.truncated ?? false, dismissed, dismiss, reload };
}
