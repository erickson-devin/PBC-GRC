import { useEffect, useRef } from 'react';

/**
 * Closes the top-most dialog when Escape is pressed.
 *
 * Every mounted handler sits on one stack and only the last one registered (the dialog opened most recently) reacts, so a
 * dialog opened on top of another closes first and Escape never tears down both. A key press that another component
 * already handled (preventDefault) or that belongs to an IME composition is ignored.
 */
const stack: Array<() => void> = [];
let listening = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top();
}

export function useEscapeKey(onEscape: (() => void) | undefined, enabled = true): void {
  // The latest callback without re-registering (and so without moving to the top of the stack) on every render
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    if (!enabled || !onEscape) return undefined;
    const handler = () => latest.current?.();
    stack.push(handler);
    if (!listening) {
      document.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    return () => {
      const i = stack.lastIndexOf(handler);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && listening) {
        document.removeEventListener('keydown', onKeyDown);
        listening = false;
      }
    };
    // `onEscape` only matters for whether there is a handler at all; the callback itself is read through the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Boolean(onEscape)]);
}
