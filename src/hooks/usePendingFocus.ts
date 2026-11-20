import { useEffect, useRef, useState } from 'react';
import { usePendingFocusContext, type PendingFocusKind } from '../context/AssessmentContext';

/** The note a screen shows when a search result asked for a row it does not list (filtered out, or outside the loaded page). */
export const PENDING_FOCUS_MISSED = 'That item is not in the list as shown. Clear the search or filters to find it.';

/** The element carrying `data-<attr>="<id>"`, compared as text (an id is never put in a selector). */
export function findByDataId(attr: string, id: string): HTMLElement | null {
  const name = `data-${attr}`;
  const all = document.querySelectorAll<HTMLElement>(`[${name}]`);
  for (const el of Array.from(all)) if (el.getAttribute(name) === id) return el;
  return null;
}

/** Scrolls an element to the middle of the view (without motion when the person asked for less) and focuses it. */
export function scrollAndFocus(el: HTMLElement): void {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
}

/**
 * A screen's side of the global search hand-off (#254): once the screen is `ready`, a pending focus request of its `kind` is handed to `focus(id)`, which
 * scrolls to and focuses the row (or opens its dialog) and returns whether it could. The request is always cleared; a false answer sets `missed`.
 * `highlightId` is the id to ring until the row loses focus (`clearHighlight`). Ids only: nothing is stored or logged.
 */
export function usePendingFocus(kind: PendingFocusKind, ready: boolean, focus: (id: string) => boolean): {
  missed: boolean;
  highlightId: string | null;
  clearHighlight: () => void;
} {
  const ctx = usePendingFocusContext();
  const pendingFocus = ctx?.pendingFocus ?? null;
  const [missed, setMissed] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const seq = pendingFocus?.seq;

  useEffect(() => {
    if (!pendingFocus || pendingFocus.kind !== kind || !ready) return;
    const ok = focusRef.current(pendingFocus.id);
    ctx?.clearPendingFocus(pendingFocus.seq);
    setMissed(!ok);
    setHighlightId(ok ? pendingFocus.id : null);
    // Only a new request (seq) or the screen becoming ready triggers it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, ready]);

  return { missed, highlightId, clearHighlight: () => setHighlightId(null) };
}
