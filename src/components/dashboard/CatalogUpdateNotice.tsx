import React from 'react';
import { Check, CheckCircle2, Filter, ListChecks, RefreshCw, X } from 'lucide-react';
import type { CatalogNoticeMode, catalogUpdateNoticeCopy } from '../../data/cmmcGuide/catalogUpdateReview';

interface CatalogUpdateNoticeProps {
  mode: CatalogNoticeMode;
  copy: ReturnType<typeof catalogUpdateNoticeCopy>;
  filterOn: boolean;
  onToggleFilter: () => void;
  onOpenList: () => void;
  onDismiss: () => void;
}

/**
 * Tells the user which answers the CMMC Assessment Guide update set back to In progress (#287), with the filter and the list that review them.
 * A region, not an alert, and it never takes focus on load: only the filter toggle is announced. Presentational: the screen owns the state.
 */
export const CatalogUpdateNotice: React.FC<CatalogUpdateNoticeProps> = ({ mode, copy, filterOn, onToggleFilter, onOpenList, onDismiss }) => {
  if (mode === 'hidden') return null;
  const done = mode === 'done';
  return (
    <div role="region" aria-label="Objective update" className={`rounded-2xl border p-3.5 text-xs ${done ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" /> : <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />}
          <div className="min-w-0 space-y-1 leading-relaxed text-slate-300">
            <p><strong className={done ? 'text-emerald-200' : 'text-amber-200'}>{copy.heading}</strong>{' '}{done ? copy.allDone : copy.count}</p>
            {!done && <p>{copy.explain} {copy.action}</p>}
            {copy.orphanNote && <p className="text-slate-400">{copy.orphanNote}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!done && (
            <button type="button" aria-pressed={filterOn} onClick={onToggleFilter}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${filterOn ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'bg-slate-900/60 text-slate-200 border-slate-700 hover:bg-slate-800'}`}>
              {filterOn ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Filter className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>Show only these controls</span>
            </button>
          )}
          <button type="button" onClick={onOpenList} className="btn-primary px-3 py-1.5 text-xs shrink-0">
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" /><span>Review the list</span>
          </button>
          <button type="button" onClick={onDismiss} aria-label="Dismiss the objective update notice" title="Dismiss"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{filterOn ? 'Showing only the controls with answers to check.' : ''}</p>
    </div>
  );
};

/** The one-line pointer on the overview, where the score that dropped is shown. */
export const CatalogUpdateOverviewNotice: React.FC<{ text: string; onOpenMatrix: () => void }> = ({ text, onOpenMatrix }) => (
  <div role="region" aria-label="Objective update" className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
    <div className="flex items-start gap-3 min-w-0"><RefreshCw className="w-5 h-5 text-amber-400 shrink-0" aria-hidden="true" /><p className="text-slate-300 leading-relaxed">{text}</p></div>
    <button type="button" onClick={onOpenMatrix} className="btn-secondary text-xs px-3.5 py-2 shrink-0">Review in the control matrix</button>
  </div>
);
