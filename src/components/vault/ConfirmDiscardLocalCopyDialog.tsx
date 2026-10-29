import React, { useId, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import type { LocalEvidenceCopy } from '../../services/localEvidenceCopies';

interface ConfirmDiscardLocalCopyDialogProps {
  copy: LocalEvidenceCopy;
  /** Deletes the browser copy. A rejection keeps the dialog open with an error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** After a successful discard, once the dialog is gone: move focus somewhere that still exists. */
  onDiscarded?: () => void;
}

/**
 * Confirmation before a file that exists only in this browser is discarded: it was never saved to the server, so this is final.
 * Stays open (and ignores Escape) while the discard runs, and closes afterwards.
 */
export const ConfirmDiscardLocalCopyDialog: React.FC<ConfirmDiscardLocalCopyDialogProps> = ({ copy, onConfirm, onClose, onDiscarded }) => {
  const descId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  // Always passed to DialogOverlay: an undefined onClose would drop this dialog from the Escape stack
  const handleCancel = () => {
    if (busyRef.current) return;
    onClose();
  };

  const handleConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch {
      busyRef.current = false;
      setBusy(false);
      setError('The file could not be discarded. Try again, or cancel.');
      return;
    }
    busyRef.current = false;
    onClose();
    onDiscarded?.();
  };

  return (
    <DialogOverlay
      role="alertdialog"
      onClose={handleCancel}
      aria-describedby={descId}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
    >
      <div aria-busy={busy} className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-rose-400" aria-hidden="true" />
          <span>Discard this browser copy?</span>
        </DialogTitle>
        <div id={descId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
          <p>
            <span className="font-semibold text-white break-all">{copy.name}</span> is stored only in this browser and was never saved to the server.
            Discarding deletes it from this browser. <strong className="text-rose-300">This cannot be undone.</strong>
          </p>
        </div>
        <ErrorNotice message={error} />
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            autoFocus
            onClick={handleCancel}
            disabled={busy}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            {busy ? 'Discarding…' : 'Discard file'}
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ConfirmDiscardLocalCopyDialog;
