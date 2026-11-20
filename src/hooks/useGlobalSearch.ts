import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenant } from '../context/TenantContext';
import { ApiClient } from '../services/apiClient';
import { IDLE_SEARCH_STATE, createSearchController, type SearchErrorCode, type SearchState } from '../data/search/searchController';
import type { SearchKind, SearchResponse } from '../types/search';

export interface UseGlobalSearch {
  /** False for a browser-only organization or one with no open program: search() sends nothing and the state is 'error' with the code 'unsupported'. */
  supported: boolean;
  status: SearchState['status'];
  /** The groups of the last answer, one per result kind in the server's order (empty groups included); each says whether more matched than are shown. The server sends no total. */
  response: SearchResponse | null;
  /** A fixed code, never the server's text: too_many (429), invalid (400), failed, unsupported. */
  error: SearchErrorCode | null;
  /** Searches the active program after a short pause; a burst of calls sends one request. Text under the minimum length clears the results and sends nothing. */
  search: (q: string) => void;
  /** Asks again for the largest page of one group (only when that group is cut off). */
  loadMore: (kind: SearchKind) => void;
  /** Empties the results (close the dialog); an answer still on its way is ignored. */
  clear: () => void;
}

/**
 * Global search over the active program (POST /search). React state only: the query and the results are never written to browser storage, a URL or the
 * console, are cleared when the dialog is closed, the program or organization changes, or the screen unmounts, and an answer to an older query is ignored.
 * `debounceMs` (default 250) exists so a test can pass 0.
 */
export function useGlobalSearch(options?: { debounceMs?: number }): UseGlobalSearch {
  const { currentTenant, activeProgram, programsStatus } = useTenant();
  const tenantId = currentTenant.id;
  const programId = activeProgram?.id ?? null;
  const supported = Boolean(currentTenant.serverBacked) && programsStatus !== 'unsupported' && programId !== null;
  const debounceMs = options?.debounceMs;

  const [state, setState] = useState<SearchState>(IDLE_SEARCH_STATE);
  const controller = useMemo(
    () => (supported && programId ? createSearchController({ run: (body) => ApiClient.searchProgram(tenantId, body, programId), onState: setState, debounceMs }) : null),
    [supported, tenantId, programId, debounceMs]
  );
  // A program or organization switch (or leaving the screen) drops the results of the previous one
  useEffect(() => () => controller?.clear(), [controller]);

  const search = useCallback((q: string): void => {
    if (!controller) {
      setState(q.trim() === '' ? IDLE_SEARCH_STATE : { status: 'error', response: null, error: 'unsupported' });
      return;
    }
    controller.search(q);
  }, [controller]);
  const loadMore = useCallback((kind: SearchKind): void => controller?.loadMore(kind), [controller]);
  const clear = useCallback((): void => {
    if (controller) controller.clear();
    else setState(IDLE_SEARCH_STATE);
  }, [controller]);

  return useMemo<UseGlobalSearch>(() => ({ supported, status: state.status, response: state.response, error: state.error, search, loadMore, clear }), [supported, state, search, loadMore, clear]);
}
