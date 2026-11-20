import React from 'react';
import { AlertTriangle, ArrowRight, CalendarClock, Info } from 'lucide-react';
import type { PoamTargetSummary } from '../../types/programSummary';
import { poamTargetText } from '../../data/dashboard/poamTarget';
import { overdueText, poamSourceText, undatedText } from '../../data/dashboard/dashboardUiView';
import { ErrorNotice } from '../common/ErrorNotice';

interface PoamTargetCardProps {
  status: 'loading' | 'ready' | 'error' | 'local';
  summary: PoamTargetSummary | null;
  poamPermitted: boolean;
  frameworkTitle: string;
  onOpenPoam: () => void;
  onRetry: () => void;
}

/** The target completion date of the open POA&M entries (#252): the latest due date, and always how many open entries have none. */
export const PoamTargetCard: React.FC<PoamTargetCardProps> = ({ status, summary, poamPermitted, frameworkTitle, onOpenPoam, onRetry }) => {
  const text = summary ? poamTargetText(summary) : null;
  const source = summary ? poamSourceText(summary.latestSource) : null;
  return (
    <section className="stitch-card p-6 shadow-xl border-slate-800 space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
          <CalendarClock className="w-4 h-4" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white tracking-tight">POA&amp;M target completion</h3>
          <p className="text-xs text-slate-400">The latest due date of the open POA&amp;M entries</p>
        </div>
      </div>

      {!poamPermitted ? (
        <>
          <p className="text-sm font-semibold text-white">POA&amp;M not permitted for {frameworkTitle}</p>
          <p className="text-xs text-slate-400">Every requirement has to be met; there is no target completion date.</p>
        </>
      ) : (
        <>
          {status === 'loading' && <p role="status" className="text-xs text-slate-400">Loading POA&amp;M dates…</p>}
          {status === 'error' && (
            <>
              <ErrorNotice message={'POA&M dates could not be loaded.'} />
              <button type="button" onClick={onRetry} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                Try again
              </button>
            </>
          )}
          {(status === 'ready' || status === 'local') && summary && text && (
            <>
              <p className="text-sm font-semibold text-white">{text.headline}</p>
              {text.detail && <p className="text-xs text-slate-400">{text.detail}</p>}
              {source && <p className="text-[11px] text-slate-400">{source}</p>}
              <div className="flex flex-wrap gap-2">
                {summary.overdueCount > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                    {overdueText(summary.overdueCount)}
                  </span>
                )}
                {summary.undatedCount > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                    {undatedText(summary.undatedCount)}
                  </span>
                )}
              </div>
              {status === 'local' && (
                <p className="text-[11px] text-slate-400">Due dates are kept on the server; this organization keeps its data in this browser only, so no entry has a date.</p>
              )}
            </>
          )}
          <button type="button" onClick={onOpenPoam} className="text-cyan-400 hover:text-cyan-300 font-semibold text-xs flex items-center gap-1">
            Open POA&amp;M
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </>
      )}
    </section>
  );
};

export default PoamTargetCard;
