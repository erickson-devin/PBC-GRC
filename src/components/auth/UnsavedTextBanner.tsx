import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Trash2, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAuth } from '../../context/AuthContext';
import { canRevealRescued, discardRescuedText, formatRescuedText, getRescuedText, subscribeRescuedText, type UnsavedTextEntry } from '../../services/unsavedText';
import { copyToClipboard } from '../../utils/clipboard';
import { UnsavedTextEntries, UnsavedTextSummary, unsavedFieldCount } from './UnsavedTextPanel';

const COPY_ALL = '__all__';
const COPIED_FEEDBACK_MS = 2000;
const COPY_FAILED = 'Could not copy automatically. Select the text in the field and press Ctrl+C (Cmd+C on a Mac).';

/** After a discard both dialogs and the banner are gone: put focus on the page's main region instead of <body>. */
const focusMain = () => {
  const main = document.querySelector<HTMLElement>('main');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
};

/**
 * Text that could not be saved when the server ended the session, held in memory only (services/unsavedText). Before the
 * same user signs in again it shows only the count and field labels; afterwards the text can be reviewed and copied.
 * It is cleared by Discard, a reload, or another user's sign-in, never by copying. It writes nothing anywhere.
 */
export const UnsavedTextBanner: React.FC = () => {
  const rescue = useSyncExternalStore(subscribeRescuedText, getRescuedText, getRescuedText);
  const { isAuthenticated, currentUser } = useAuth();
  const revealed = canRevealRescued(rescue, isAuthenticated, currentUser.id);
  const entries: UnsavedTextEntry[] = rescue?.entries ?? [];

  const descId = useId();
  const [expanded, setExpanded] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const copiedTimer = useRef<number | undefined>(undefined);
  const hadRescue = useRef(false);
  const wasRevealed = useRef(false);

  useEffect(() => {
    if (rescue && !hadRescue.current && !revealed) {
      setAnnouncement(`${unsavedFieldCount(rescue.entries.length)} kept from your session. Sign in again as the same user to copy ${rescue.entries.length === 1 ? 'it' : 'them'}.`);
    }
    if (revealed && !wasRevealed.current) setAnnouncement('Your unsaved text is ready to copy.');
    if (!revealed) setReviewOpen(false);
    if (!rescue) {
      setConfirmOpen(false);
      setExpanded(true);
    }
    hadRescue.current = Boolean(rescue);
    wasRevealed.current = revealed;
  }, [rescue, revealed]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const fieldRef = useCallback((key: string, el: HTMLTextAreaElement | null) => {
    if (el) fields.current.set(key, el);
    else fields.current.delete(key);
  }, []);

  // copyToClipboard is the first call, with no await before it: its plain-http fallback needs the click's user gesture
  const copy = (key: string, label: string, text: string) => {
    copyToClipboard(text).then(
      () => {
        setCopyError(null);
        setCopiedKey(key);
        setAnnouncement(`Copied ${label}.`);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), COPIED_FEEDBACK_MS);
      },
      () => {
        setCopiedKey(null);
        setCopyError(COPY_FAILED);
        const field = fields.current.get(key);
        if (field) {
          field.focus();
          field.select();
        }
      }
    );
  };

  const discard = () => {
    discardRescuedText();
    setConfirmOpen(false);
    setReviewOpen(false);
    setCopiedKey(null);
    setCopyError(null);
    setAnnouncement('Unsaved text discarded.');
    requestAnimationFrame(focusMain);
  };

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>

      {rescue && entries.length > 0 && (
        <UnsavedTextSummary
          entries={entries}
          revealed={revealed}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((v) => !v)}
          onReview={() => { setCopyError(null); setReviewOpen(true); }}
          onDiscard={() => setConfirmOpen(true)}
        />
      )}

      {rescue && revealed && reviewOpen && (
        <DialogOverlay onClose={() => setReviewOpen(false)} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <DialogTitle as="h2" className="text-sm font-bold text-white">Unsaved text from your last session</DialogTitle>
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                aria-label="Close"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              These fields were not saved. Copy each one and paste it back into its field, then discard this list. Copying does not delete anything.
            </p>
            <ErrorNotice message={copyError} />
            <UnsavedTextEntries entries={entries} copiedKey={copiedKey} onCopy={(e) => copy(e.key, e.label, e.text)} fieldRef={fieldRef} />
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Discard all</span>
              </button>
              {entries.length > 1 && (
                <button type="button" onClick={() => copy(COPY_ALL, 'all fields', formatRescuedText(entries))} className="btn-base btn-primary px-3 py-1.5 text-xs">
                  {copiedKey === COPY_ALL ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  <span>{copiedKey === COPY_ALL ? 'Copied' : 'Copy all'}</span>
                </button>
              )}
              <button type="button" onClick={() => setReviewOpen(false)} className="btn-base btn-ghost px-3 py-1.5 text-xs">Close</button>
            </div>
          </div>
        </DialogOverlay>
      )}

      {rescue && confirmOpen && (
        <DialogOverlay
          role="alertdialog"
          onClose={() => setConfirmOpen(false)}
          aria-describedby={descId}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
        >
          <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-rose-400" aria-hidden="true" />
              <span>Discard the unsaved text?</span>
            </DialogTitle>
            <div id={descId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <p>
                This deletes {unsavedFieldCount(entries.length)} from this tab&apos;s memory.{revealed ? '' : ' You have not seen this text yet.'} It was never saved to the server,
                and <strong className="text-rose-300">it cannot be recovered afterwards.</strong>
              </p>
              <ul className="max-h-32 overflow-y-auto list-disc pl-5 font-mono text-slate-400">
                {entries.map((e) => <li key={e.key} className="break-all">{e.label}</li>)}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button type="button" autoFocus onClick={() => setConfirmOpen(false)} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">
                Cancel
              </button>
              <button
                type="button"
                onClick={discard}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                Discard text
              </button>
            </div>
          </div>
        </DialogOverlay>
      )}
    </>
  );
};

export default UnsavedTextBanner;
