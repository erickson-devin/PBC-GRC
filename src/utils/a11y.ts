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
