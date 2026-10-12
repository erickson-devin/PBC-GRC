import React, { createContext, useContext, useEffect, useId, useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useScrollLock } from '../../hooks/useScrollLock';

interface DialogContextValue {
  /** The id the dialog's visible title must carry; the dialog points at it with aria-labelledby. */
  titleId: string;
}
const DialogContext = createContext<DialogContextValue | null>(null);

interface DialogOverlayProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  /**
   * A static accessible name, for a dialog that has no visible title. Normally leave it out and render the heading with
   * <DialogTitle>: the dialog is then named by that heading's actual text. An explicit `aria-labelledby` wins over both.
   */
  label?: string;
  /**
   * Called when Escape is pressed. Omit it for a dialog that must not be dismissed (a mandatory setup step, or an operation
   * that is running): Escape then does nothing, and the dialog still traps focus.
   */
  onClose?: () => void;
  role?: 'dialog' | 'alertdialog';
}

/**
 * The full-screen overlay every modal renders: the same `fixed inset-0` backdrop as before, now with dialog semantics
 * (role, aria-modal, a name taken from its title), Escape to close (top-most dialog only), a focus trap, focus restored on
 * close, and the page behind it locked against scrolling. Mount it only while the dialog is open.
 */
export const DialogOverlay: React.FC<DialogOverlayProps> = ({ label, onClose, role = 'dialog', className = '', children, ...rest }) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref);
  useEscapeKey(onClose);
  useScrollLock();

  const explicitLabelledBy = rest['aria-labelledby'];
  const labelledBy = explicitLabelledBy ?? (label ? undefined : titleId);

  // A dialog that points at a title nobody rendered has no accessible name: say so in development
  useEffect(() => {
    if (!import.meta.env.DEV || label || explicitLabelledBy) return;
    if (!document.getElementById(titleId)) console.warn('[DialogOverlay] no <DialogTitle> was rendered and no label was given: the dialog has no accessible name.');
  }, [label, titleId, explicitLabelledBy]);

  return (
    <DialogContext.Provider value={{ titleId }}>
      <div
        {...rest}
        className={`${className} outline-none`}
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-dialog-overlay=""
      >
        {children}
      </div>
    </DialogContext.Provider>
  );
};

type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4';
interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  as?: HeadingLevel;
}

/** The visible title of the surrounding <DialogOverlay>: a heading that carries the id the dialog is named by. */
export const DialogTitle: React.FC<DialogTitleProps> = ({ as: Tag = 'h2', children, ...rest }) => {
  const ctx = useContext(DialogContext);
  return (
    <Tag {...rest} id={rest.id ?? ctx?.titleId}>
      {children}
    </Tag>
  );
};

export default DialogOverlay;
