import React, { useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface DialogOverlayProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  /** The dialog's accessible name (what a screen reader announces on opening). */
  label: string;
  /**
   * Called when Escape is pressed. Omit it for a dialog that must not be dismissed (a mandatory setup step, or an operation
   * that is running): Escape then does nothing, and the dialog still traps focus.
   */
  onClose?: () => void;
  role?: 'dialog' | 'alertdialog';
}

/**
 * The full-screen overlay every modal renders: the same `fixed inset-0` backdrop as before, now with dialog semantics
 * (role, aria-modal, name), Escape to close (top-most dialog only), a focus trap, and focus restored on close.
 * Mount it only while the dialog is open: it takes focus when it mounts and gives it back when it unmounts.
 */
export const DialogOverlay: React.FC<DialogOverlayProps> = ({ label, onClose, role = 'dialog', className = '', children, ...rest }) => {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEscapeKey(onClose);
  return (
    <div {...rest} className={`${className} outline-none`} ref={ref} role={role} aria-modal="true" aria-label={label} tabIndex={-1} data-dialog-overlay="">
      {children}
    </div>
  );
};

export default DialogOverlay;
