import React, { useId } from 'react';
import { ErrorNotice } from '../common/ErrorNotice';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import { INVENTORY_UI_TEXT, formatUsd } from '../../data/inventory/inventoryUiView';
import type { CostRollup } from '../../data/inventory/costRollup';

interface ToolCostSummaryProps {
  total: CostRollup;
  program: { name: string; rollup: CostRollup } | null;
  renewals: { id: string; name: string; renewalDate: string; daysLeft: number }[];
  perProgram: {
    status: 'loading' | 'ready' | 'error' | 'unsupported';
    rows: { programId: string; name: string; archived: boolean; declared: boolean; toolCount: number; totalCents: number }[];
  };
  onRetry: () => void;
}

const card = 'rounded-xl border border-slate-800 bg-slate-950/60 p-3';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

const withoutCaption = (r: CostRollup): string => `${r.withCost} with a cost, ${r.missingCost} without`;

/** Annual cost and renewals of the register. Rendered only for the write roles; a missing cost is never counted as zero. Presentational. */
export const ToolCostSummary: React.FC<ToolCostSummaryProps> = ({ total, program, renewals, perProgram, onRetry }) => {
  const hId = useId();
  return (
    <section aria-labelledby={hId} className="space-y-4">
      <h3 id={hId} className="text-sm font-bold text-white">Costs and renewals</h3>
      <p className="text-xs text-slate-400">{INVENTORY_UI_TEXT.costsIntro}</p>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className={card}>
          <p className="text-[11px] text-slate-400">Annual cost, whole register</p>
          <p className="text-lg font-bold text-white">{formatUsd(total.totalCents)}</p>
          <p className="text-[11px] text-slate-400">{withoutCaption(total)}</p>
        </div>
        {program && (
          <div className={card}>
            <p className="text-[11px] text-slate-400">{`In ${program.name}`}</p>
            <p className="text-lg font-bold text-white">{formatUsd(program.rollup.totalCents)}</p>
            <p className="text-[11px] text-slate-400">{withoutCaption(program.rollup)}</p>
          </div>
        )}
        {CMMC_ASSET_CATEGORIES.filter((c) => c !== 'OUT_OF_SCOPE').map((c) => (
          <div key={c} className={card}>
            <p className="text-[11px] text-slate-400">{CATEGORY_INFO[c].label}</p>
            <p className="text-lg font-bold text-white">{formatUsd(total.byCategory[c])}</p>
          </div>
        ))}
        <div className={card}>
          <p className="text-[11px] text-slate-400">Not classified</p>
          <p className="text-lg font-bold text-white">{formatUsd(total.byCategory.UNCLASSIFIED)}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-slate-300">Renewals in the next 60 days</h4>
        {renewals.length === 0 ? (
          <p className="text-xs text-slate-400">No renewals in the next 60 days.</p>
        ) : (
          <ul className="space-y-1">
            {renewals.map((r) => (
              <li key={r.id} className="text-xs text-slate-300">
                <span className="font-semibold text-white">{r.name}</span>
                {' · '}
                <span className="font-mono">{r.renewalDate}</span>
                {' · '}
                {r.daysLeft === 0 ? 'Renews today' : `Renews in ${r.daysLeft} ${r.daysLeft === 1 ? 'day' : 'days'}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-slate-300">By program</h4>
        {perProgram.status === 'loading' && <p role="status" className="text-xs text-slate-400">Loading the program totals…</p>}
        {perProgram.status === 'error' && (
          <div className="flex items-center justify-between gap-3">
            <ErrorNotice message={INVENTORY_UI_TEXT.membershipsFailed} className="flex-1" />
            <button type="button" onClick={onRetry} className={secondaryButton}>Retry</button>
          </div>
        )}
        {perProgram.status === 'ready' && (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table className="table w-full text-left text-xs border-collapse">
              <caption className="sr-only">Annual cost by program</caption>
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                  <th scope="col" className="py-2.5 px-3">Program</th>
                  <th scope="col" className="py-2.5 px-3">Tools</th>
                  <th scope="col" className="py-2.5 px-3">Annual cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {perProgram.rows.map((r) => (
                  <tr key={r.programId}>
                    <td className="py-2.5 px-3 text-white">{r.name}{r.archived ? ' (archived)' : ''}</td>
                    <td className="py-2.5 px-3 text-slate-300">{r.declared ? r.toolCount : `Whole register (${r.toolCount})`}</td>
                    <td className="py-2.5 px-3 font-mono text-slate-200">{formatUsd(r.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export default ToolCostSummary;
