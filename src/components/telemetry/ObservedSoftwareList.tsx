import React, { useId, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import {
  ADD_ACTION_ROW_LIMIT,
  OBSERVED_COPY,
  SOFTWARE_MAX_LIMIT,
  SOFTWARE_PAGE_LIMIT,
  addActionsShown,
  filterObservedSoftware,
  isHotfix,
  observedSoftwareCaption,
  prefillFromObserved,
  softwareListIndex,
  softwareListMatch,
  softwareListState,
  truncationNotice,
} from '../../data/telemetry/observedInventoryView';
import type { SoftwareTypeFilter } from '../../data/telemetry/observedInventoryView';
import { APPROVAL_LABELS, approvalChoice } from '../../data/softwareInventoryView';
import { useObservedSoftware } from '../../hooks/useObservedInventory';
import type { UseSoftwareItems } from '../../hooks/useSoftwareItems';
import { ApiClient } from '../../services/apiClient';
import { notifySoftwareChanged } from '../../services/softwareService';
import type { SoftwareItemInput } from '../../types/software';
import type { EnclaveAsset } from '../../types/telemetry';
import { SoftwareItemDialog } from './SoftwareItemDialog';

interface ObservedSoftwareListProps {
  tenantId: string;
  assetId: string;
  /** The tenant's software list, used to show which packages it already records. */
  softwareList: Pick<UseSoftwareItems, 'items' | 'loading' | 'error' | 'reload' | 'supported'>;
  /** A Tenant Owner or MSP Admin: rows can be copied to the software list. */
  canAdd: boolean;
  assets: EnclaveAsset[];
  assetsLoading: boolean;
}

const TYPE_OPTIONS: { value: SoftwareTypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'packages', label: 'Packages' },
  { value: 'hotfixes', label: 'Hotfixes' },
];

const FIELD_CLASS = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';

const dateOnly = (iso: string | null): string | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

/**
 * The software the scanners report for one asset, read-only: loaded on request of the dialog that shows it, searched and filtered here,
 * never kept in the browser. Every name, version and vendor is rendered as a text node.
 */
export const ObservedSoftwareList: React.FC<ObservedSoftwareListProps> = ({ tenantId, assetId, softwareList, canAdd, assets, assetsLoading }) => {
  const [limit, setLimit] = useState<number>(SOFTWARE_PAGE_LIMIT);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<SoftwareTypeFilter>('all');
  const software = useObservedSoftware(tenantId, assetId, limit, true);
  const idBase = useId();
  const searchId = `${idBase}-search`;
  const typeId = `${idBase}-type`;

  const shown = useMemo(() => filterObservedSoftware(software.items, query, type), [software.items, query, type]);
  const sources = useMemo(() => new Set(software.items.map((i) => i.sourceId)), [software.items]);
  const showSource = sources.size > 1;
  const notice = software.status === 'ready' ? truncationNotice(software.items.length, software.totalCount) : null;

  const [adding, setAdding] = useState<{ prefill: SoftwareItemInput; key: number } | null>(null);
  const addKey = useRef(0);
  const added = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [addedMsg, setAddedMsg] = useState('');
  const listState = softwareListState({ supported: softwareList.supported, loading: softwareList.loading, error: softwareList.error, count: softwareList.items.length });
  const index = useMemo(() => softwareListIndex(softwareList.items), [softwareList.items]);
  const showAdd = canAdd && listState === 'ready' && addActionsShown(shown.length);
  const showListColumn = listState !== 'hidden';
  const columnCount = (showSource ? 6 : 5) + (showListColumn ? 1 : 0);

  const saveFromScanner = async (input: SoftwareItemInput): Promise<void> => {
    await ApiClient.createSoftwareItem(tenantId, input); // a refusal rejects: the dialog shows softwareErrorMessage and stays open
    added.current = true;
    notifySoftwareChanged(tenantId);
    setAddedMsg(OBSERVED_COPY.softwareAdded);
  };
  const closeAdd = (): void => {
    setAdding(null);
    if (added.current) {
      added.current = false;
      setTimeout(() => searchRef.current?.focus(), 0); // the row's Add button is gone once the package is listed
    }
  };

  return (
    <section aria-labelledby={`${idBase}-heading`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3 text-xs">
      <div>
        <h3 id={`${idBase}-heading`} className="text-xs font-bold text-cyan-300">Installed software</h3>
        <p className="text-slate-400 mt-1">{canAdd ? OBSERVED_COPY.softwareNote : OBSERVED_COPY.softwareNoteReadOnly}</p>
      </div>

      {software.status === 'idle' || (software.status === 'loading' && software.items.length === 0) ? (
        <p role="status" className="text-slate-400">{OBSERVED_COPY.softwareLoading}</p>
      ) : software.status === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
          <span>{OBSERVED_COPY.softwareError}</span>
          <button type="button" onClick={software.reload} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0">{OBSERVED_COPY.retry}</button>
        </div>
      ) : software.status === 'gone' ? (
        <p role="status" className="text-slate-300">{OBSERVED_COPY.gone}</p>
      ) : software.items.length === 0 ? (
        <p className="text-slate-400">{OBSERVED_COPY.softwareEmpty}</p>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <label htmlFor={searchId} className="block font-semibold text-slate-300 mb-1">Search software</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                <input
                  id={searchId}
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Name, version or vendor"
                  className={`${FIELD_CLASS} w-full pl-9`}
                />
              </div>
            </div>
            <div>
              <label htmlFor={typeId} className="block font-semibold text-slate-300 mb-1">Type</label>
              <select id={typeId} value={type} onChange={(e) => setType(e.target.value as SoftwareTypeFilter)} className={FIELD_CLASS}>
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {showListColumn && listState === 'error' ? (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
              <span>{OBSERVED_COPY.listError}</span>
              <button type="button" onClick={() => void softwareList.reload()} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0">{OBSERVED_COPY.retry}</button>
            </div>
          ) : (
            showListColumn && (
              <p role="status" className="text-slate-400">
                {listState === 'loading'
                  ? OBSERVED_COPY.listChecking
                  : listState === 'full' && canAdd
                    ? OBSERVED_COPY.listFull
                    : canAdd && listState === 'ready' && shown.length > ADD_ACTION_ROW_LIMIT
                      ? OBSERVED_COPY.listNarrow
                      : addedMsg}
              </p>
            )
          )}
          <p role="status" className="text-slate-400">{observedSoftwareCaption(shown.length, software.items.length)}</p>
          {notice && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">
              <span>{notice}</span>
              {limit < SOFTWARE_MAX_LIMIT && (
                <button type="button" onClick={() => setLimit(SOFTWARE_MAX_LIMIT)} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0">{OBSERVED_COPY.loadMore}</button>
              )}
            </div>
          )}

          <div className="overflow-x-auto max-h-80 overflow-y-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-xs border-collapse">
              <caption className="sr-only">Installed software reported by the scanner</caption>
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                  <th scope="col" className="py-2 px-3">Name</th>
                  <th scope="col" className="py-2 px-3">Version</th>
                  <th scope="col" className="py-2 px-3">Vendor</th>
                  <th scope="col" className="py-2 px-3">Architecture</th>
                  <th scope="col" className="py-2 px-3">Installed</th>
                  {showSource && <th scope="col" className="py-2 px-3">Source</th>}
                  {showListColumn && <th scope="col" className="py-2 px-3">Software list</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="py-4 text-center text-slate-400">No software matches the search and filter.</td>
                  </tr>
                ) : (
                  shown.map((it, i) => (
                    <tr key={`${it.sourceId}|${it.name}|${it.version}|${i}`}>
                      <td className="py-2 px-3 text-slate-200 break-words">
                        <span>{it.name}</span>
                        {isHotfix(it) && <span className="badge ml-1.5 px-1.5 py-0.5 rounded text-xs font-mono font-bold bg-violet-500/15 text-violet-300 border border-violet-500/30">HOTFIX</span>}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-300 break-words">{it.version || '—'}</td>
                      <td className="py-2 px-3 text-slate-300 break-words">{it.vendor || '—'}</td>
                      <td className="py-2 px-3 font-mono text-slate-300">{it.architecture || '—'}</td>
                      <td className="py-2 px-3 text-slate-300 whitespace-nowrap">{dateOnly(it.installedAt) ?? '—'}</td>
                      {showSource && <td className="py-2 px-3 font-mono text-slate-400 break-words">{it.sourceId}</td>}
                      {showListColumn && (
                        <td className="py-2 px-3 whitespace-nowrap">
                          {isHotfix(it) ? (
                            <span className="text-slate-500" title="Hotfixes are patch state, not applications">—</span>
                          ) : (
                            (() => {
                              const m = listState === 'ready' || listState === 'full' ? softwareListMatch(it, index, assetId) : null;
                              if (m) {
                                const c = approvalChoice(m.item.approved);
                                return (
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${c === 'APPROVED' ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300' : c === 'NOT_APPROVED' ? 'bg-rose-500/15 border border-rose-500/30 text-rose-300' : 'border border-dashed border-slate-600 text-slate-300'}`}>
                                    On list: {APPROVAL_LABELS[c]}{m.count > 1 ? ` (${m.count} entries)` : ''}
                                  </span>
                                );
                              }
                              if (showAdd) {
                                return (
                                  <button
                                    type="button"
                                    onClick={() => setAdding({ prefill: prefillFromObserved(it), key: ++addKey.current })}
                                    aria-label={`Add ${it.name}${it.version ? ` ${it.version}` : ''} to the software list`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/40 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                  >
                                    <Plus className="w-3 h-3" aria-hidden="true" />
                                    <span>Add</span>
                                  </button>
                                );
                              }
                              return <span className="text-slate-400">{listState === 'loading' ? '…' : OBSERVED_COPY.notOnList}</span>;
                            })()
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {adding && <SoftwareItemDialog key={adding.key} stacked initial={null} prefill={adding.prefill} assets={assets} assetsLoading={assetsLoading} onSave={saveFromScanner} onClose={closeAdd} />}
    </section>
  );
};
