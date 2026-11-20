// The global search's request logic (#254) without React: debounce, one request in the end for a burst of typing, stale answers ignored, fixed error states.
// The query lives only in this object's memory (to ask for more of one group): it is never written to browser storage, a URL or the console, and an
// error carries a fixed code, never the server's text. The delay and the clock are injected so a test needs no waiting.

import { SEARCH_PER_KIND_DEFAULT, SEARCH_PER_KIND_MAX, type SearchKind, type SearchResponse } from '../../types/search';
import { normalizeQuery } from './searchMatch';

/** too_many: the server's rate limit (429); invalid: the server refused the text or options (400); failed: anything else; unsupported: a browser-only organization. */
export type SearchErrorCode = 'too_many' | 'invalid' | 'failed' | 'unsupported';

export interface SearchState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  response: SearchResponse | null;
  error: SearchErrorCode | null;
}

export const SEARCH_DEBOUNCE_MS = 250;

export const IDLE_SEARCH_STATE: SearchState = { status: 'idle', response: null, error: null };

export interface SearchControllerDeps {
  /** One request. Rejects with an object carrying a numeric `status` for an HTTP failure. */
  run: (body: { q: string; kinds?: SearchKind[]; perKind?: number }) => Promise<SearchResponse>;
  onState: (state: SearchState) => void;
  debounceMs?: number;
  /** Injectable timer, so tests need no waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SearchController {
  /** A burst of calls sends one request, for the last text. Text shorter than the minimum (or invalid) sends nothing and clears the results. */
  search: (raw: string) => void;
  /** Asks again, for one group only, with the largest page. */
  loadMore: (kind: SearchKind) => void;
  /** Forgets the results and the query; an answer still on its way is ignored. */
  clear: () => void;
}

export function searchErrorOf(err: unknown): SearchErrorCode {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 429) return 'too_many';
  if (status === 400) return 'invalid';
  return 'failed';
}

export function createSearchController(deps: SearchControllerDeps): SearchController {
  const delay = deps.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let seq = 0;
  let timer: unknown = null;
  let query: string | null = null;
  let current: SearchState = IDLE_SEARCH_STATE;

  const emit = (next: SearchState): void => {
    current = next;
    deps.onState(next);
  };
  const cancelTimer = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const send = (body: { q: string; kinds?: SearchKind[]; perKind?: number }, merge: boolean): void => {
    const mine = ++seq;
    emit({ status: 'loading', response: current.response, error: null });
    deps.run(body).then(
      (response) => {
        if (mine !== seq) return;
        if (merge && current.response) {
          // Only the asked group is replaced; the others stay as they were
          const fresh = new Map(response.groups.map((g) => [g.kind, g]));
          emit({ status: 'ready', error: null, response: { ...current.response, groups: current.response.groups.map((g) => fresh.get(g.kind) ?? g) } });
        } else emit({ status: 'ready', response, error: null });
      },
      (err: unknown) => {
        if (mine !== seq) return;
        emit({ status: 'error', response: merge ? current.response : null, error: searchErrorOf(err) });
      }
    );
  };

  return {
    search(raw) {
      cancelTimer();
      const q = normalizeQuery(raw);
      if (!q.ok) {
        seq += 1;
        query = null;
        emit(IDLE_SEARCH_STATE);
        return;
      }
      query = q.q;
      seq += 1; // an answer for the previous text is stale from now on
      const text = q.q;
      emit({ status: 'loading', response: current.response, error: null });
      timer = setTimer(() => {
        timer = null;
        send({ q: text }, false);
      }, delay);
    },
    loadMore(kind) {
      if (query === null || current.status !== 'ready') return;
      const group = current.response?.groups.find((g) => g.kind === kind);
      if (!group || !group.truncated || group.results.length >= SEARCH_PER_KIND_MAX) return;
      cancelTimer();
      send({ q: query, kinds: [kind], perKind: SEARCH_PER_KIND_MAX }, true);
    },
    clear() {
      cancelTimer();
      seq += 1;
      query = null;
      emit(IDLE_SEARCH_STATE);
    },
  };
}

/** The page size a plain search asks for (the server's default), for a caller that wants to say how many are shown. */
export const SEARCH_PAGE_SIZE = SEARCH_PER_KIND_DEFAULT;
