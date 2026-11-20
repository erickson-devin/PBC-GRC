import React from 'react';
import { Boxes } from 'lucide-react';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import type { SspInventorySnapshot } from '../../data/inventory/sspInventory';
import { SYSTEM_DETAILS_HEADERS } from '../../data/inventory/sspInventory';
import { NOT_RECORDED } from '../../data/reports/documentDefaults';
import { missingItemsLine } from '../../data/ssp/sspBuilderView';
import { SSP_INVENTORY_TEXT, systemDetailsRows } from '../../data/ssp/sspInventoryView';
import { ErrorNotice } from '../common/ErrorNotice';

interface SspSystemDetailsSectionProps {
  status: 'unsupported' | 'loading' | 'ready' | 'error';
  snapshot: SspInventorySnapshot;
  section?: SspSectionStatus;
  onOpenRegister: () => void;
  onRetry: () => void;
}

const BUTTON = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5';

const Cell: React.FC<{ value: string }> = ({ value }) =>
  value === NOT_RECORDED ? <span className="text-amber-300">{value}</span> : <>{value}</>;

/** 1.3 System Details (1.3.1 end users and privileged users): read-only, built from the Tools and Services register; the tools are edited there. */
export const SspSystemDetailsSection: React.FC<SspSystemDetailsSectionProps> = ({ status, snapshot, section, onOpenRegister, onRetry }) => {
  const missingLine = missingItemsLine(section);
  const rows = status === 'ready' ? systemDetailsRows(snapshot) : [];

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.detailsIntro}</p>
      {status === 'ready' && missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}

      {status === 'unsupported' && (
        <p role="note" className="p-3 rounded-xl bg-slate-800/60 border border-slate-700 text-xs text-slate-300">{SSP_INVENTORY_TEXT.unsupported}</p>
      )}
      {status === 'loading' && <p role="status" className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.detailsLoading}</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message={SSP_INVENTORY_TEXT.detailsFailed} />
          <button type="button" onClick={onRetry} className={BUTTON}>Try again</button>
        </div>
      )}

      {status === 'ready' && rows.length === 0 && <p className="text-xs text-slate-400">{SSP_INVENTORY_TEXT.detailsEmpty}</p>}
      {status === 'ready' && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
          <table className="w-full text-left text-xs border-collapse min-w-[36rem]">
            <caption className="sr-only">1.3.1 Number of end users and privileged users</caption>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                {SYSTEM_DETAILS_HEADERS.map((h) => (
                  <th key={h} scope="col" className="py-2.5 px-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row" className="py-2 px-3 font-semibold text-white">{r.name}</th>
                  <td className="py-2 px-3 text-slate-300"><Cell value={r.deployment} /></td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={r.category} /></td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={r.endUsers} /></td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={r.privileged} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status !== 'unsupported' && (
        <button type="button" onClick={onOpenRegister} className={BUTTON}>
          <Boxes className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Open Tools &amp; Services</span>
        </button>
      )}
    </div>
  );
};
