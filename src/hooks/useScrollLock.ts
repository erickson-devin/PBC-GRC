import { useEffect } from 'react';

/**
 * Locks page scrolling while a dialog is open.
 *
 * - Sets `overflow: hidden` on <body>, and adds the width of the scrollbar that disappears to the body's right padding so
 *   the page does not shift sideways when it goes away (and back).
 * - Reference-counted: with a dialog opened over another, the page stays locked until the LAST one closes.
 * - Restores exactly what was there before (inline overflow and padding), not a guessed default.
 */
let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

function lock(): void {
  if (locks++ > 0) return;
  const body = document.body;
  saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
  // Width of the vertical scrollbar that is about to disappear (0 for overlay scrollbars and when the page does not scroll)
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbar > 0) {
    const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + scrollbar}px`;
  }
  body.style.overflow = 'hidden';
}

function unlock(): void {
  if (locks === 0 || --locks > 0) return;
  if (saved) {
    document.body.style.overflow = saved.overflow;
    document.body.style.paddingRight = saved.paddingRight;
    saved = null;
  }
}

export function useScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    lock();
    return unlock;
  }, [enabled]);
}
