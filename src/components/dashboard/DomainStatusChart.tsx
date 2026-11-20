import React, { useId } from 'react';
import { Info } from 'lucide-react';
import { statusDisplayLabel } from '../../data/statusLabels';
import type { DomainChartRow, DomainChartStatus } from '../../data/dashboard/domainChart';

interface DomainStatusChartProps {
  rows: DomainChartRow[];
  summary: string;
  onOpenDomain: (code: string) => void;
}

const ORDER: DomainChartStatus[] = ['MET', 'IN_PROGRESS', 'NOT_MET', 'NOT_STARTED'];

// Colour is never the only cue: each status has its own pattern as well (solid, diagonal stripes, vertical bars, plain)
const SEGMENT_STYLE: Record<DomainChartStatus, React.CSSProperties> = {
  MET: { backgroundColor: '#10b981' },
  IN_PROGRESS: { backgroundImage: 'repeating-linear-gradient(45deg,#f59e0b 0 4px,#b45309 4px 8px)' },
  NOT_MET: { backgroundImage: 'repeating-linear-gradient(90deg,#f43f5e 0 3px,#881337 3px 5px)' },
  NOT_STARTED: { backgroundColor: '#334155' },
};

const countOf = (r: DomainChartRow, s: DomainChartStatus): number => r.segments.find((x) => x.status === s)?.count ?? 0;

/** Controls per domain by status (#252): stacked bars in plain HTML and CSS, each row with its text, and the same numbers as a table. */
export const DomainStatusChart: React.FC<DomainStatusChartProps> = ({ rows, summary, onOpenDomain }) => {
  const capId = useId();
  return (
    <figure aria-labelledby={capId} className="stitch-card p-5 sm:p-6 shadow-xl border-slate-800 space-y-4">
      <figcaption id={capId}>
        <span className="block text-sm font-bold text-white tracking-tight">Status per domain</span>
        <span className="block text-xs text-slate-400">{summary}</span>
      </figcaption>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {ORDER.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block w-4 h-3 rounded-sm" style={SEGMENT_STYLE[s]} />
            {statusDisplayLabel(s)}
          </li>
        ))}
      </ul>
      <ul className="space-y-1.5">
        {rows.map((r) =>
          r.total === 0 ? (
            <li key={r.code} className="grid grid-cols-[minmax(0,12rem)_1fr] items-center gap-3 px-2 py-1.5 text-xs text-slate-500">
              <span className="truncate"><span className="font-mono mr-1.5">{r.code}</span>{r.name}</span>
              <span>No controls in this program</span>
            </li>
          ) : (
            <li key={r.code}>
              <button
                type="button"
                onClick={() => onOpenDomain(r.code)}
                aria-label={`${r.name}: ${r.text}. Show these controls in the matrix`}
                className="w-full grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 px-2 py-1.5 rounded-lg text-left hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <span className="truncate text-xs text-slate-200"><span className="font-mono text-slate-400 mr-1.5">{r.code}</span>{r.name}</span>
                <span aria-hidden="true" className="flex h-3.5 w-full gap-px overflow-hidden rounded bg-slate-800 forced-colors:border">
                  {r.segments.filter((s) => s.count > 0).map((s) => (
                    <span key={s.status} className="h-full" style={{ ...SEGMENT_STYLE[s.status], width: `${s.pct}%` }} />
                  ))}
                </span>
                <span aria-hidden="true" className="text-xs font-mono text-slate-300 whitespace-nowrap">{countOf(r, 'MET')}/{r.total} met</span>
              </button>
            </li>
          )
        )}
      </ul>
      <details className="text-xs text-slate-300">
        <summary className="cursor-pointer select-none font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">Show as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Controls per domain and status</caption>
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th scope="col" className="py-1.5 pr-3">Domain</th>
                {ORDER.map((s) => <th key={s} scope="col" className="py-1.5 pr-3">{statusDisplayLabel(s)}</th>)}
                <th scope="col" className="py-1.5">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-b border-slate-800/60">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-slate-200">{r.code} {r.name}</th>
                  {ORDER.map((s) => <td key={s} className="py-1.5 pr-3 font-mono">{countOf(r, s)}</td>)}
                  <td className="py-1.5 font-mono">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p role="note" className="flex items-start gap-2 text-[11px] text-slate-400">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
        Inheritance breakdown (inherited, shared or your own) is not available yet: the app does not record which controls a service provider covers. Evidence copied between frameworks is not inheritance and is not counted.
      </p>
    </figure>
  );
};

export default DomainStatusChart;
