import React, { useId, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { DialogOverlay, DialogTitle } from './DialogOverlay';
import { ErrorNotice } from './ErrorNotice';
import type { EvidenceItem } from '../../types/cmmc';

/** What a delete removes, from ids only (never names): is the row itself a cross-framework copy, and how many copies go or stay with it. */
export interface EvidenceDeletionSummary {
  isCopy: boolean;
  copiesRemoved: number;
  copiesKept: number;
}

export function summarizeEvidenceDeletion(
  itemId: string,
  evidenceIndex: ReadonlyArray<Pick<EvidenceItem, 'id'>>,
  serverBacked: boolean
): EvidenceDeletionSummary {
  if (itemId.includes('__inh_')) return { isCopy: true, copiesRemoved: 0, copiesKept: 0 };
  const prefix = `${itemId}__inh_`;
  const copies = evidenceIndex.filter((e) => e.id.startsWith(prefix)).length;
  // The server deletes a base record with its copies; the browser-only vault removes the exact row only
  return serverBacked ? { isCopy: false, copiesRemoved: copies, copiesKept: 0 } : { isCopy: false, copiesRemoved: 0, copiesKept: copies };
}

export const copiesPhrase = (n: number): string => `${n} cross-framework ${n === 1 ? 'copy' : 'copies'}`;

interface ConfirmDeleteEvidenceDialogProps {
  item: EvidenceItem;
  evidenceIndex: ReadonlyArray<Pick<EvidenceItem, 'id'>>;
  serverBacked: boolean;
  /** Runs the delete. `false` = refused (the caller already told the user); anything else = removed. */
  onConfirm: () => Promise<boolean | void>;
  onClose: () => void;
  /** After a successful delete, once the dialog is gone: move focus somewhere that still exists. */
  onDeleted?: () => void;
}

/**
 * Confirmation before an evidence file is deleted: says which control loses it and what else goes, stays open (and
 * ignores Escape) while the delete runs, and closes afterwards. Opened over the control inspector too, hence z-[60].
 */
export const ConfirmDeleteEvidenceDialog: React.FC<ConfirmDeleteEvidenceDialogProps> = ({ item, evidenceIndex, serverBacked, onConfirm, onClose, onDeleted }) => {
  const descId = useId();
  // Taken once: the row (and its copies) leave the index while the delete runs, and the text must not change under the user
  const [summary] = useState(() => summarizeEvidenceDeletion(item.id, evidenceIndex, serverBacked));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  // Always passed to DialogOverlay: an undefined onClose would drop this dialog from the Escape stack and let Escape close the inspector beneath
  const handleCancel = () => {
    if (busyRef.current) return;
    onClose();
  };

  const handleConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let removed: boolean;
    try {
      removed = (await onConfirm()) !== false;
    } catch {
      busyRef.current = false;
      setBusy(false);
      setError('The evidence could not be deleted. Try again, or cancel.');
      return;
    }
    busyRef.current = false;
    onClose();
    if (removed) onDeleted?.();
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
          <span>Delete this evidence file?</span>
        </DialogTitle>
        <div id={descId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
          <p>
            <span className="font-semibold text-white break-all">{item.name}</span> will be removed from control{' '}
            <span className="font-mono text-slate-200">{item.controlId}</span>.
          </p>
          {item.fileHash && (
            <p className="font-mono text-slate-400">SHA-256 {item.fileHash.slice(0, 12)}…</p>
          )}
          {summary.isCopy && (
            <p>This is a cross-framework copy of a file attached to another control. Only this copy is removed; the original stays.</p>
          )}
          {summary.copiesRemoved > 0 && (
            <p>Its {copiesPhrase(summary.copiesRemoved)} on mapped controls will be removed too.</p>
          )}
          {summary.copiesKept > 0 && (
            <p>Its {copiesPhrase(summary.copiesKept)} on mapped controls stay in the vault.</p>
          )}
          <p>
            {serverBacked
              ? 'The stored file is deleted from the server vault once no other evidence record in this program uses it.'
              : "The record is deleted from this browser's local vault."}{' '}
            <strong className="text-rose-300">This cannot be undone.</strong>
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
            {busy ? 'Deleting…' : 'Delete evidence'}
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ConfirmDeleteEvidenceDialog;
