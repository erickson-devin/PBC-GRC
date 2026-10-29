import React, { useId, useRef, useState } from 'react';
import { Loader2, MinusCircle, PlusCircle } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { boundaryErrorMessage, describeBoundaryChange, type BoundaryChangePlan } from '../../data/boundaryView';

interface ConfirmBoundaryChangeDialogProps {
  plan: BoundaryChangePlan;
  programName: string;
  /** Saves the change (one PATCH with the delta). A rejection keeps the dialog open with an error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** After a successful save, once the dialog is closing. */
  onSaved?: (plan: BoundaryChangePlan) => void;
}

/**
 * Confirmation before assets are added to or removed from a program's boundary: it changes what the program's SSP export,
 * FIPS module list and handover package state, for everyone who works in it. Counts and host names on screen only, nothing
 * logged. Stays open (and ignores Escape) while the save runs.
 */
export const ConfirmBoundaryChangeDialog: React.FC<ConfirmBoundaryChangeDialogProps> = ({ plan: initial, programName, onConfirm, onClose, onSaved }) => {
  const descId = useId();
  // Taken once: the memberships reload under the dialog when the save lands
  const [plan] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const adding = plan.direction === 'add';
  const what = `${plan.ids.length} ${plan.ids.length === 1 ? 'asset' : 'assets'}`;

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
    } catch (err: unknown) {
      busyRef.current = false;
      setBusy(false);
      setError(boundaryErrorMessage(err));
      return;
    }
    busyRef.current = false;
    onClose();
    onSaved?.(plan);
  };

  return (
    <DialogOverlay role="alertdialog" onClose={handleCancel} aria-describedby={descId}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-busy={busy} className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
          {adding ? <PlusCircle className="w-4 h-4 text-cyan-400" aria-hidden="true" /> : <MinusCircle className="w-4 h-4 text-amber-400" aria-hidden="true" />}
          <span>{adding ? `Add ${what} to ${programName}?` : `Remove ${what} from ${programName}?`}</span>
        </DialogTitle>
        <div id={descId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
          <p>{describeBoundaryChange(plan, programName)}</p>
          {plan.sampleNames.length > 0 && (
            <p className="font-mono text-slate-400 break-words">
              {plan.sampleNames.join(', ')}{plan.moreCount > 0 ? ` and ${plan.moreCount} more` : ''}
            </p>
          )}
          <p>The assets stay in the inventory and in any other program. This applies to everyone who works in {programName} and is recorded in the program's change history.</p>
        </div>
        <ErrorNotice message={error} />
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button type="button" autoFocus onClick={handleCancel} disabled={busy}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${adding ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30' : 'bg-amber-500/15 text-amber-200 border-amber-500/40 hover:bg-amber-500/25'}`}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : adding ? <PlusCircle className="w-3.5 h-3.5" aria-hidden="true" /> : <MinusCircle className="w-3.5 h-3.5" aria-hidden="true" />}
            {busy ? 'Saving…' : adding ? 'Add to boundary' : 'Remove from boundary'}
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ConfirmBoundaryChangeDialog;
