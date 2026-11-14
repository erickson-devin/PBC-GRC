import React from 'react';
import { Check, CheckCircle2, Filter, ListChecks } from 'lucide-react';
import { metMismatchNoticeCopy } from '../../data/cmmcGuide/controlStatusView';

interface MetMismatchNoticeProps {
  count: number;
  canEdit: boolean;
  filterOn: boolean;
  onToggleFilter: () => void;
}

/**
 * Tells the user which controls are recorded as Met while their objectives do not add up to Met (#292), with the filter that lists them.
 * A region, not an alert, and it never takes focus on load. It cannot be dismissed while mismatches exist: the scores stay as recorded
 * until a person acts. It says what is recorded and what the objectives say, and nothing about an error. Presentational: the screen owns the state.
 */
export const MetMismatchNotice: React.FC<MetMismatchNoticeProps> = ({ count, canEdit, filterOn, onToggleFilter }) => {
  if (count === 0 && !filterOn) return null;
  const copy = metMismatchNoticeCopy(count, { canEdit });
  const done = count === 0;
  return (
    <div role="region" aria-label="Met controls with open objectives" className={`rounded-2xl border p-3.5 text-xs ${done ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" /> : <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />}
          <div className="min-w-0 space-y-1 leading-relaxed text-slate-300">
            <p><strong className={done ? 'text-emerald-200' : 'text-amber-200'}>{copy.heading}</strong>{' '}{copy.count}</p>
            {!done && <p>{copy.explain} {copy.action}</p>}
          </div>
        </div>
        <button type="button" aria-pressed={filterOn} onClick={onToggleFilter}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${filterOn ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'bg-slate-900/60 text-slate-200 border-slate-700 hover:bg-slate-800'}`}>
          {filterOn ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Filter className="h-3.5 w-3.5" aria-hidden="true" />}<span>Show only these controls</span>
        </button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{filterOn ? 'Showing only the controls recorded as Met with open objectives.' : ''}</p>
    </div>
  );
};

export default MetMismatchNotice;
