import React, { useId } from 'react';
import { Gauge } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import type { VmSummaryLoad } from '../../hooks/useVmRemediationPolicy';
import { REMEDIATION_COPY as C, loadErrorText, pendingText, summaryBreakdown } from '../../data/telemetry/vmRemediationView';

interface VmRemediationSummaryPanelProps {
  load: VmSummaryLoad;
  onRetry: () => void;
}

const RETRY_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** How many open vulnerabilities are on track, warnings, gaps or accepted under the organization's policy, with the pending decisions. Counts only. */
export const VmRemediationSummaryPanel: React.FC<VmRemediationSummaryPanelProps> = ({ load, onRetry }) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2 text-xs">
      <h3 id={headingId} className="text-sm font-bold text-white flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
        {C.summaryHeading}
      </h3>
      {load.status === 'idle' || load.status === 'loading' ? (
        <p role="status" className="text-slate-400">{C.summaryLoading}</p>
      ) : load.status === 'error' ? (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={loadErrorText('summary', load.offline)} className="flex-1" />
          <button type="button" aria-label="Retry loading the remediation summary" onClick={onRetry} className={RETRY_CLASS}>{C.retry}</button>
        </div>
      ) : load.status === 'ready' ? (
        <Ready data={load.data} />
      ) : null}
    </section>
  );
};

const Ready: React.FC<{ data: Extract<VmSummaryLoad, { status: 'ready' }>['data'] }> = ({ data }) => {
  const c = data.counts;
  if (c.gap + c.warning + c.onTrack + c.accepted === 0) {
    return <p className="rounded-xl border border-slate-800 bg-slate-950/60 py-6 text-center text-slate-400">{C.summaryEmpty}</p>;
  }
  const tiles = [
    { n: c.gap, label: C.tileGap, note: C.tileGapNote, tone: 'border-rose-500/30 bg-rose-500/10' },
    { n: c.warning, label: C.tileWarning, note: C.tileWarningNote, tone: 'border-amber-500/30 bg-amber-500/10' },
    { n: c.onTrack, label: C.tileOnTrack, note: C.tileOnTrackNote, tone: 'border-emerald-500/30 bg-emerald-500/10' },
    { n: c.accepted, label: C.tileAccepted, note: C.tileAcceptedNote, tone: 'border-violet-500/30 bg-violet-500/10' },
  ];
  const b = summaryBreakdown(data);
  const pending = pendingText(data.pendingDecisions ?? 0);
  return (
    <>
      <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map((t) => (
          <li key={t.label} className={`rounded-xl border p-3 ${t.tone}`}>
            <p className="text-2xl font-mono font-black text-white">{t.n}</p>
            <p className="font-semibold text-slate-200">{t.label}</p>
            <p className="text-slate-400">{t.note}</p>
          </li>
        ))}
      </ul>
      {b.gaps && <p className="text-slate-300">{b.gaps}</p>}
      {b.warnings && <p className="text-slate-300">{b.warnings}</p>}
      {pending && <p className="text-amber-200">{pending}</p>}
    </>
  );
};
