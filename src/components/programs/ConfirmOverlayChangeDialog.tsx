import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Sliders } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { OVERLAY_TITLES, describeOverlayChange, isOverlayConflict, overlaySaveErrorMessage } from '../../data/overlayScoping';
import type { OverlayChangeSummary } from '../../data/overlayScoping';
import type { OverlayFilters } from '../../types/framework';

interface ConfirmOverlayChangeDialogProps {
  summary: OverlayChangeSummary;
  serverBacked: boolean;
  /** Saves the change. A rejection keeps the dialog open with an error. */
  onConfirm: (seen: OverlayFilters) => Promise<void>;
  onClose: () => void;
  /** After a successful save, once the dialog is closing. */
  onSaved?: (turnedOn: boolean) => void;
}

/**
 * Confirmation before an operational overlay is turned on or off: it changes the control count and readiness score of the
 * program for everyone in it (server-backed) or for this organization in this browser. Ids and counts only. Stays open (and
 * ignores Escape) while the save runs. Opened over the header menu (z-50), hence z-[60].
 */
export const ConfirmOverlayChangeDialog: React.FC<ConfirmOverlayChangeDialogProps> = ({ summary: initial, serverBacked, onConfirm, onClose, onSaved }) => {
  const descId = useId();
  // Taken once: the counts change under the dialog when the save lands
  const [summary] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Someone else changed the overlays meanwhile: the question is moot, so only the error and Close remain
  const [conflict, setConflict] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (conflict) closeRef.current?.focus(); }, [conflict]);
  const title = OVERLAY_TITLES[summary.key];

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
      await onConfirm(summary.seen);
    } catch (err: unknown) {
      busyRef.current = false;
      setBusy(false);
      setConflict(isOverlayConflict(err));
      setError(overlaySaveErrorMessage(err));
      return;
    }
    busyRef.current = false;
    onClose();
    onSaved?.(summary.turningOn);
  };

  return (
    <DialogOverlay role="alertdialog" onClose={handleCancel} aria-describedby={conflict ? undefined : descId}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-busy={busy} className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
          <Sliders className="w-4 h-4 text-cyan-400" aria-hidden="true" />
          <span>{conflict ? `The ${title} overlay was not changed` : `${summary.turningOn ? 'Turn on' : 'Turn off'} the ${title} overlay?`}</span>
        </DialogTitle>
        {!conflict && (
          <div id={descId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
            <p>{describeOverlayChange(summary)}</p>
            {summary.sampleIds.length > 0 && (
              <p className="font-mono text-slate-400 break-words">
                {summary.sampleIds.join(', ')}{summary.moreCount > 0 ? ` and ${summary.moreCount} more` : ''}
              </p>
            )}
            {summary.turningOn && summary.changedIds.length > 0 && (
              <p>Answers, notes and evidence already recorded on these controls are kept. They return if the overlay is turned off.</p>
            )}
            <p>
              {serverBacked
                ? "This is saved with the program: it applies to everyone who works in it, changes its control count and readiness score, and is recorded in the program's change history."
                : 'This is saved in this browser for this organization only, and changes its control count and readiness score here.'}
            </p>
          </div>
        )}
        <ErrorNotice message={error} />
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button type="button" ref={closeRef} autoFocus onClick={handleCancel} disabled={busy}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50">
            {conflict ? 'Close' : 'Cancel'}
          </button>
          {!conflict && (
            <button type="button" onClick={handleConfirm} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Sliders className="w-3.5 h-3.5" aria-hidden="true" />}
              {busy ? 'Saving…' : summary.turningOn ? 'Turn on overlay' : 'Turn off overlay'}
            </button>
          )}
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ConfirmOverlayChangeDialog;
