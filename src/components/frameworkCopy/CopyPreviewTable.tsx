import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FrameworkCopyItem, FrameworkCopyPreview, FrameworkCopySummary } from '../../types/frameworkCopy';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { formatCopyBytes, relationLabel, summaryRows, type CopyInclude } from '../../data/frameworkCopy/copyView';

const CHANGED_TITLE = 'The Rev. 2 content changed after it was copied. It is not copied again: compare the two programs yourself.';
const countCell = 'py-2 px-3 text-right font-mono text-slate-200 whitespace-nowrap align-top';

const Count: React.FC<{ on: boolean; n: number }> = ({ on, n }) => {
  if (!on) return <span className="text-slate-500">Off</span>;
  if (n === 0) return <><span aria-hidden="true" className="text-slate-500">—</span><span className="sr-only">None</span></>;
  return <>{n}</>;
};

interface CopyPreviewTableProps {
  rows: readonly FrameworkCopyItem[];
  include: CopyInclude;
}

/** What a copy would append to each Rev. 3 control. Presentational: ids, counts and sizes only, never any text from the Rev. 2 program. */
export const CopyPreviewTable: React.FC<CopyPreviewTableProps> = ({ rows, include }) => {
  const captionId = useId();
  return (
    <div role="region" aria-labelledby={captionId} tabIndex={0} className="max-h-[45vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
      <table className="w-full text-left text-xs">
        <caption id={captionId} className="sr-only">Rev. 3 controls and what would be appended to each</caption>
        <thead className="sticky top-0 z-10 bg-slate-950 text-slate-400 uppercase font-mono text-[11px] tracking-wider">
          <tr>
            <th scope="col" className="py-2 px-3">Rev. 3 control</th>
            <th scope="col" className="py-2 px-3">From Rev. 2</th>
            <th scope="col" className="py-2 px-3 text-right">Notes</th>
            <th scope="col" className="py-2 px-3 text-right">Objectives</th>
            <th scope="col" className="py-2 px-3 text-right">Evidence</th>
            <th scope="col" className="py-2 px-3 text-right">Tools</th>
            <th scope="col" className="py-2 px-3 text-right">Documents</th>
            <th scope="col" className="py-2 px-3">Earlier copies</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {rows.map((it) => (
            <tr key={it.targetControlId}>
              <th scope="row" className="py-2 px-3 font-mono font-bold text-cyan-300 whitespace-nowrap align-top text-left">{it.targetControlId}</th>
              <td className="py-2 px-3 align-top">
                <ul className="space-y-1">
                  {it.sources.map((s) => (
                    <li key={s.controlId} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-slate-200">{cmmcDisplayId(s.controlId, 'CMMC_L2')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-300">{relationLabel(s.relation)}</span>
                    </li>
                  ))}
                </ul>
              </td>
              <td className={countCell}><Count on={include.notes} n={it.notes.count} /></td>
              <td className={countCell}><Count on={include.objectives} n={it.objectives.count} /></td>
              <td className={countCell}>
                {include.evidence && it.evidence.count > 0 ? (
                  <>
                    {it.evidence.count}
                    <span className="block text-slate-400">{formatCopyBytes(it.evidence.bytes)}</span>
                  </>
                ) : <Count on={include.evidence} n={0} />}
                {include.evidence && it.evidence.unavailable > 0 && <span className="block text-amber-300">{`${it.evidence.unavailable} unavailable`}</span>}
              </td>
              <td className={countCell}><Count on={include.tools} n={it.tools} /></td>
              <td className={countCell}><Count on={include.documents} n={it.documents} /></td>
              <td className="py-2 px-3 align-top space-y-1">
                {it.alreadyCopied > 0 && <span className="block text-slate-300">{`${it.alreadyCopied} already copied`}</span>}
                {it.changedSinceCopy > 0 && (
                  <span title={CHANGED_TITLE} className="inline-block px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                    {`${it.changedSinceCopy} changed since copy`}
                    <span className="sr-only">. {CHANGED_TITLE}</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Disclosure: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">
        {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
        {title}
      </button>
      {open && <ul id={bodyId} className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/60 p-2 space-y-0.5 font-mono text-[11px] text-slate-300">{children}</ul>}
    </div>
  );
};

/** The three lists under the preview: what is new in Rev. 3, what was withdrawn without a successor, and what was merged. */
export const CopyPreviewLists: React.FC<{ plan: Pick<FrameworkCopyPreview, 'newInR3' | 'notCarried' | 'mergedInto'> }> = ({ plan }) => (
  <div className="space-y-2">
    <Disclosure title={`New in Rev. 3 (${plan.newInR3.length}): nothing to copy`}>
      {plan.newInR3.map((id) => <li key={id}>{id}</li>)}
    </Disclosure>
    <Disclosure title={`Not carried into Rev. 3 (${plan.notCarried.length}): withdrawn with no successor`}>
      {plan.notCarried.map((n) => <li key={n.cmmcId}>{cmmcDisplayId(n.cmmcId, 'CMMC_L2')}</li>)}
    </Disclosure>
    <Disclosure title={`Merged in Rev. 3 (${plan.mergedInto.length})`}>
      {plan.mergedInto.map((m) => <li key={m.cmmcId}>{`${cmmcDisplayId(m.cmmcId, 'CMMC_L2')} → ${m.targets.join(', ')}`}</li>)}
    </Disclosure>
  </div>
);

/** The counts of a finished copy, one card each; the cards that need attention say why. */
export const CopySummaryView: React.FC<{ summary: FrameworkCopySummary }> = ({ summary }) => (
  <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
    {summaryRows(summary).map((r) => (
      <div key={r.key} className={`rounded-xl border p-3 ${r.tone === 'warn' ? 'border-amber-800/40 bg-amber-950/20 text-amber-200' : 'border-slate-800 bg-slate-950/60 text-slate-200'}`}>
        <dt className="text-[11px] text-slate-400">{r.label}</dt>
        <dd className="text-lg font-bold font-mono">{r.value}</dd>
        {r.note && <dd className="mt-1 text-[11px]">{r.note}</dd>}
      </div>
    ))}
  </dl>
);
