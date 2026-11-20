import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, ApiError } from '../services/apiClient';
import type { NoticeKind } from '../services/apiClient';
import { useAuth } from '../context/AuthContext';
import { applyRead, markReadErrorMessage, nextNoticesState, noticeKey, shouldReloadNotices } from '../data/whatsNewView';
import type { WhatsNewState } from '../data/whatsNewView';

export interface UseWhatsNew {
  state: WhatsNewState;
  reload: () => void;
  markRead: (kind: NoticeKind, ref: string) => Promise<boolean>;
  /** The notice key (`kind:ref`) being saved right now, if any. */
  markBusy: string | null;
  markError: { key: string; message: string } | null;
}

/**
 * The release notes and announcements of the signed-in person (issue #260). React state only: what is read is kept by the server,
 * nothing is written to browser storage. It loads when the session is confirmed, when the panel opens, and when a tab that was
 * hidden for more than five minutes becomes visible again. There is no timer.
 */
export function useWhatsNew(): UseWhatsNew {
  const { isAuthenticated, sessionCheck } = useAuth();
  const canLoad = isAuthenticated && sessionCheck !== 'offline' && sessionCheck !== 'verifying';
  const [state, setState] = useState<WhatsNewState>({ kind: 'idle' });
  const [markBusy, setMarkBusy] = useState<string | null>(null);
  const [markError, setMarkError] = useState<{ key: string; message: string } | null>(null);
  const seq = useRef(0);
  const lastLoadedAt = useRef<number | null>(null);
  const canLoadRef = useRef(canLoad);
  canLoadRef.current = canLoad;

  const load = useCallback(() => {
    if (!canLoadRef.current) return;
    const mine = ++seq.current;
    setState((p) => (p.kind === 'loaded' ? p : { kind: 'loading' }));
    ApiClient.getNotices().then(
      (snapshot) => {
        if (mine !== seq.current) return;
        lastLoadedAt.current = Date.now();
        setState((p) => nextNoticesState(p, { ok: true, snapshot }));
      },
      (err: unknown) => {
        if (mine !== seq.current) return;
        const status = err instanceof ApiError ? err.status : -1;
        setState((p) => nextNoticesState(p, { ok: false, status }));
      }
    );
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      seq.current++;
      lastLoadedAt.current = null;
      setState({ kind: 'idle' });
      return;
    }
    if (sessionCheck === 'offline') {
      seq.current++;
      setState((p) => nextNoticesState(p, { ok: false, status: 0 }));
      return;
    }
    load();
  }, [isAuthenticated, sessionCheck, load]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && shouldReloadNotices(lastLoadedAt.current, Date.now())) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const markRead = useCallback(
    async (kind: NoticeKind, ref: string): Promise<boolean> => {
      const key = noticeKey(kind, ref);
      setMarkBusy(key);
      setMarkError(null);
      try {
        await ApiClient.markNoticeRead(kind, ref);
        setState((p) => applyRead(p, kind, ref));
        return true;
      } catch (err: unknown) {
        setMarkError({ key, message: markReadErrorMessage(err) });
        if (err instanceof ApiError && err.status === 404) load();
        return false;
      } finally {
        setMarkBusy(null);
      }
    },
    [load]
  );

  return { state, reload: load, markRead, markBusy, markError };
}
