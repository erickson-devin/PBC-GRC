import type { KeyboardEvent } from 'react';

/**
 * onKeyDown for an element that acts as a button but cannot be a real <button> (it contains other interactive
 * elements, which HTML forbids inside a button). Together with role="button" and tabIndex={0} it makes the element
 * operable with Enter and Space, exactly like a native button: it simply triggers the element's own click handler.
 * A key pressed on a control nested inside it is left alone.
 */
export function activateOnKey(e: KeyboardEvent<HTMLElement>): void {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.currentTarget.click();
  }
}

/**
 * Arrow-key navigation for a role="radiogroup" (put on the group element's onKeyDown). Each option is a role="radio" with
 * aria-checked and tabIndex 0 only on the checked one (roving tabindex), so the group is a single Tab stop. Arrow keys
 * move to the next / previous option and select it, wrapping at the ends, as native radio buttons do.
 */
export function radioGroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  if (!forward && !backward) return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
  const current = radios.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
  if (radios.length === 0 || current < 0) return;
  e.preventDefault();
  const next = radios[(current + (forward ? 1 : -1) + radios.length) % radios.length];
  next.focus();
  next.click();
}
