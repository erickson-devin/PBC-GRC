import React, { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Clock, ExternalLink, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  CATALOG_LIST_PAGE,
  catalogRevLabel,
  groupByControl,
  objectiveStatusLabel,
  rowsForView,
  toCheckSnapshot,
  type CatalogUpdateRow,
  type CatalogUpdateSummary,
} from '../../data/cmmcGuide/catalogUpdateReview';
import type { UseCatalogUpdateChanges } from '../../hooks/useCatalogUpdateChanges';

const dateOnly = (iso: string | null): string | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

interface CatalogUpdateListBodyProps {
  status: UseCatalogUpdateChanges['status'];
  rows: CatalogUpdateRow[];
  summary: CatalogUpdateSummary;
  truncated: boolean;
  /** The answers that were still to check when the list opened (a row stays listed after it is reviewed). */
  snapshot: Set<string>;
  mode: 'check' | 'all';
  onModeChange: (mode: 'check' | 'all') => void;
  shownGroups: number;
  onShowMore: () => void;
  titles: Map<string, string>;
  onOpen: (row: CatalogUpdateRow) => void;
  onRetry: () => void;
}

const StatusLine: React.FC<{ row: CatalogUpdateRow }> = ({ row }) => (
  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
    <div className="flex gap-1"><dt>Before:</dt><dd className="text-slate-200">{objectiveStatusLabel(row.previousStatus)}</dd></div>
    <div className="flex gap-1"><dt>Set to:</dt><dd className="text-slate-200">{objectiveStatusLabel(row.setTo)}</dd></div>
    <div className="flex gap-1"><dt>Now:</dt><dd className="text-slate-200">{row.currentStatus ? objectiveStatusLabel(row.currentStatus) : 'No answer recorded'}</dd></div>
  </dl>
);

const EarlierWording: React.FC<{ text: string | null }> = ({ text }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
    <p className="text-slate-400">Earlier wording</p>
    <p className="mt-0.5 text-slate-400">{text ?? 'Not available.'}</p>
  </div>
);

/** The list itself, without the dialog around it (so it can be rendered on its own). */
export const CatalogUpdateListBody: React.FC<CatalogUpdateListBodyProps> = ({
  status, rows, summary, truncated, snapshot, mode, onModeChange, shownGroups, onShowMore, titles, onOpen, onRetry,
}) => {
  const baseId = useId();
  if (status === 'loading') return <p role="status" className="text-slate-400">Loading the changed answers…</p>;
  if (status === 'error') {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ErrorNotice message="The list of changed answers could not be loaded. The control matrix is not affected." className="flex-1" />
        <button type="button" onClick={onRetry} className={`px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 shrink-0 ${FOCUS_RING}`}>Retry</button>
      </div>
    );
  }

  const groups = groupByControl(rowsForView(rows, mode, snapshot));
  const shown = groups.slice(0, shownGroups);
  const rest = groups.length - shown.length;
  const orphans = rows.filter((r) => r.orphan);
  const toggle = (value: 'check' | 'all', label: string) => (
    <button type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)}
      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${FOCUS_RING} ${mode === value ? 'bg-slate-200 text-slate-900 font-bold shadow-sm' : 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'}`}>
      {label}
    </button>
  );

  return (
    <>
      <div role="group" aria-label="Which answers to list" className="flex items-center gap-1.5">
        {toggle('check', `To check (${summary.unreviewedAnswers})`)}
        {toggle('all', `All (${summary.answers})`)}
      </div>

      {truncated && (
        <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">Only the first 1000 changed answers are listed.</p>
      )}

      {mode === 'check' && groups.length === 0 && (
        <p className="text-slate-400">Nothing left to check. Choose All to see every changed answer.</p>
      )}

      {shown.length > 0 && (
        <ul aria-label="Controls" className="space-y-3">
          {shown.map((g) => {
            const gid = `${baseId}-${g.controlId}`;
            return (
              <li key={g.controlId}>
                <section aria-labelledby={gid} className="rounded-xl border border-slate-800 bg-slate-950/40">
                  <h3 id={gid} className="px-3 py-2 border-b border-slate-800 flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold text-cyan-300">{g.controlDisplayId}</span>
                    <span className="text-slate-200 font-semibold">{titles.get(g.controlId) ?? ''}</span>
                  </h3>
                  <ul className="divide-y divide-slate-800/60">
                    {g.rows.map((row) => (
                      <li key={row.objectiveId} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-bold text-cyan-300">{row.displayId}</span>
                            {row.reviewed ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"><CheckCircle2 className="w-3 h-3" aria-hidden="true" />Updated since</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border border-dashed border-amber-500/50 text-amber-200"><Clock className="w-3 h-3" aria-hidden="true" />To check</span>
                            )}
                          </div>
                          <button type="button" onClick={() => onOpen(row)} aria-label={`Open objective ${row.displayId}`}
                            className={`px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold flex items-center gap-1.5 ${FOCUS_RING}`}>
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /><span>Open objective</span>
                          </button>
                        </div>
                        <StatusLine row={row} />
                        <div className="grid gap-2 md:grid-cols-2">
                          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                            <p className="font-semibold text-slate-300">Guide wording</p>
                            <p className="mt-0.5 text-slate-200 leading-relaxed">{row.newText}</p>
                          </div>
                          <EarlierWording text={row.oldText} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </li>
            );
          })}
        </ul>
      )}

      {rest > 0 && (
        <div role="status" className="flex flex-col items-center gap-1">
          <p className="text-slate-400">Showing {shownGroups} of {groups.length} controls</p>
          <button type="button" className={`btn-secondary text-xs px-3.5 py-2 ${FOCUS_RING}`} onClick={onShowMore}>Show {Math.min(CATALOG_LIST_PAGE, rest)} more controls</button>
        </div>
      )}

      {orphans.length > 0 && (
        <section aria-labelledby={`${baseId}-orphans`} className="rounded-xl border border-slate-800 bg-slate-950/40">
          <div className="px-3 py-2 border-b border-slate-800 space-y-1">
            <h3 id={`${baseId}-orphans`} className="font-semibold text-slate-200">Kept, no longer an objective in the guide ({orphans.length})</h3>
            <p className="text-slate-400">The guide has no objective with these letters. These answers were set to In progress and kept with their narratives, but the checklist does not show them. They are not counted in the answers to check.</p>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {orphans.map((row) => (
              <li key={row.objectiveId} className="p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-bold text-cyan-300">{row.displayId}</span>
                  <button type="button" onClick={() => onOpen(row)} aria-label={`Open control ${row.controlDisplayId}`}
                    className={`px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold flex items-center gap-1.5 ${FOCUS_RING}`}>
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /><span>Open control</span>
                  </button>
                </div>
                <StatusLine row={row} />
                <EarlierWording text={row.oldText} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
};

interface CatalogUpdateListProps {
  view: UseCatalogUpdateChanges;
  /** Control id -> title, for the group headings. */
  titles: Map<string, string>;
  programName: string;
  onOpen: (row: CatalogUpdateRow) => void;
  onClose: () => void;
}

/**
 * The answers the objective update set back to In progress, grouped by control (#287). A dialog: a bounded, scrollable surface that gives focus back
 * to what opened it, and a control opened from it stacks above. The "to check" rows are a snapshot taken when the view opens, so an answer stays
 * listed (and keeps the button the control's dialog returns focus to) after the user sets its status.
 */
export const CatalogUpdateList: React.FC<CatalogUpdateListProps> = ({ view, titles, programName, onOpen, onClose }) => {
  const [mode, setMode] = useState<'check' | 'all'>('check');
  const [snapshot, setSnapshot] = useState<Set<string>>(() => toCheckSnapshot(view.rows));
  const taken = useRef(view.status === 'ready');
  const [shownGroups, setShownGroups] = useState(CATALOG_LIST_PAGE);
  // Opened while the answers were still loading: take the snapshot once they arrive
  useEffect(() => {
    if (view.status === 'ready' && !taken.current) {
      taken.current = true;
      setSnapshot(toCheckSnapshot(view.rows));
    }
  }, [view.status, view.rows]);
  const changeMode = (m: 'check' | 'all') => {
    setMode(m);
    setShownGroups(CATALOG_LIST_PAGE);
    if (m === 'check') setSnapshot(toCheckSnapshot(view.rows));
  };
  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl text-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <DialogTitle as="h2" className="text-base font-bold text-white">Answers changed by the objective update</DialogTitle>
            <p className="text-xs text-slate-400 mt-1">{programName}: {catalogRevLabel(view.rev)}{dateOnly(view.changedAt) ? `, applied ${dateOnly(view.changedAt)}` : ''}. Narratives and evidence were kept.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors ${FOCUS_RING}`}><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          <CatalogUpdateListBody status={view.status} rows={view.rows} summary={view.summary} truncated={view.truncated} snapshot={snapshot}
            mode={mode} onModeChange={changeMode} shownGroups={shownGroups} onShowMore={() => setShownGroups((n) => n + CATALOG_LIST_PAGE)}
            titles={titles} onOpen={onOpen} onRetry={view.reload} />
        </div>
        <div className="px-5 py-3 border-t border-slate-800 flex justify-end shrink-0">
          <button type="button" onClick={onClose} className={`px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold ${FOCUS_RING}`}>Close</button>
        </div>
      </div>
    </DialogOverlay>
  );
};
