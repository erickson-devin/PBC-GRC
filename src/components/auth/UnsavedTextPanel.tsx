import React, { useId } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Eye, Lock, Sparkles, Trash2 } from 'lucide-react';
import type { UnsavedTextEntry } from '../../services/unsavedText';

/** "1 unsaved field", "3 unsaved fields". */
export function unsavedFieldCount(count: number): string {
  return `${count} unsaved field${count === 1 ? '' : 's'}`;
}

/** An edit of an AI suggestion from the SSP import (label "SSP import edit, <id>"): still untrusted, so it is marked. */
export function isAiDraftEntry(entry: Pick<UnsavedTextEntry, 'label'>): boolean {
  return entry.label.startsWith('SSP import edit');
}

interface UnsavedTextSummaryProps {
  entries: UnsavedTextEntry[];
  /** True only when the same user is signed in again (canRevealRescued). The summary never shows the text itself. */
  revealed: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onReview: () => void;
  onDiscard: () => void;
}

/** The floating summary: counts and field labels (ids only), Discard, and (once revealed) "Review and copy". */
export const UnsavedTextSummary: React.FC<UnsavedTextSummaryProps> = ({ entries, revealed, expanded, onToggleExpanded, onReview, onDiscard }) => {
  const titleId = useId();
  const detailsId = useId();
  const count = unsavedFieldCount(entries.length);
  return (
    <section
      aria-labelledby={titleId}
      className="no-print fixed inset-x-0 bottom-0 z-40 p-3 sm:left-auto sm:right-4 sm:bottom-4 sm:w-[28rem] sm:p-0"
    >
      <div className="max-h-[60vh] overflow-y-auto rounded-2xl border border-amber-500/40 bg-slate-900/95 backdrop-blur-md shadow-2xl shadow-slate-950 p-4 space-y-3 text-xs">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <span>{revealed ? 'Unsaved text from your last session' : 'Unsaved text was kept'} ({entries.length})</span>
          </h2>
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className="btn-base btn-ghost shrink-0 px-2 py-1 text-xs"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{expanded ? 'Hide details' : 'Show details'}</span>
          </button>
        </div>

        <div id={detailsId} hidden={!expanded} className="space-y-3">
          {revealed ? (
            <p className="text-slate-300 leading-relaxed">
              {count} could not be saved when your session ended. Copy the text and paste it back where it belongs. Nothing here is saved automatically.
            </p>
          ) : (
            <>
              <p className="text-slate-300 leading-relaxed">
                Your session ended before {count} could be saved. The text is held only in this tab&apos;s memory: it was not saved to the server or to this browser&apos;s storage.
              </p>
              <p className="flex items-start gap-2 text-slate-400">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Sign in again as the same user to see and copy it. Reloading this page, or signing in as someone else, deletes it.</span>
              </p>
            </>
          )}
          <ul aria-label="Unsaved fields" className="max-h-32 overflow-y-auto space-y-1 rounded-xl border border-slate-800 bg-slate-950/60 p-2 font-mono text-slate-300">
            {entries.map((entry) => (
              <li key={entry.key} className="flex items-center gap-2 break-all">
                {isAiDraftEntry(entry) && (
                  <>
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
                    <span className="sr-only">AI draft: </span>
                  </>
                )}
                <span>{entry.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {revealed && (
            <button type="button" onClick={onReview} className="btn-base btn-primary px-3 py-1.5 text-xs">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Review and copy</span>
            </button>
          )}
          <button
            type="button"
            onClick={onDiscard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Discard</span>
          </button>
        </div>
      </div>
    </section>
  );
};

interface UnsavedTextEntriesProps {
  entries: UnsavedTextEntry[];
  copiedKey: string | null;
  onCopy: (entry: UnsavedTextEntry) => void;
  fieldRef: (key: string, el: HTMLTextAreaElement | null) => void;
}

/** The revealed text: one read-only field per entry (no name, autocomplete off), each with its own Copy button. */
export const UnsavedTextEntries: React.FC<UnsavedTextEntriesProps> = ({ entries, copiedKey, onCopy, fieldRef }) => {
  const baseId = useId();
  return (
    <ul className="space-y-4">
      {entries.map((entry, i) => {
        const fieldId = `${baseId}-field-${i}`;
        const ai = isAiDraftEntry(entry);
        const copied = copiedKey === entry.key;
        return (
          <li key={entry.key} className={`rounded-xl border p-3 space-y-2 ${ai ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-slate-950/60'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={fieldId} className="font-mono text-xs font-semibold text-slate-200 break-all">{entry.label}</label>
              <button
                type="button"
                onClick={() => onCopy(entry)}
                aria-label={copied ? `Copied ${entry.label}` : `Copy ${entry.label}`}
                className="btn-base btn-secondary px-2.5 py-1 text-xs"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            {ai && (
              <p role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>AI draft, not reviewed. This is your edit of a suggestion from the SSP import. Copying it does not accept it: paste it back into the import review and accept it there.</span>
              </p>
            )}
            <textarea
              id={fieldId}
              ref={(el) => { fieldRef(entry.key, el); }}
              readOnly
              autoComplete="off"
              spellCheck={false}
              rows={Math.min(10, Math.max(3, entry.text.split('\n').length))}
              value={entry.text}
              className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
            />
          </li>
        );
      })}
    </ul>
  );
};
