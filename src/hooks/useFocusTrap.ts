import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visibleFocusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true');

/**
 * Modal focus handling for the element in `ref`:
 *  - on open, focus moves into it (unless something inside already took focus, e.g. an autoFocus field);
 *  - Tab and Shift+Tab cycle inside it instead of reaching the page behind;
 *  - on close, focus returns to what had it before, so keyboard users are not dropped at the top of the page.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  // Taken on the first render, before the dialog is in the DOM: by the time the effect runs an autoFocus element inside
  // the dialog already has focus, and returning focus to it on close would drop the user at the top of the page
  const previousRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const previous = previousRef.current && !root.contains(previousRef.current) ? previousRef.current : null;
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = visibleFocusables(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}
