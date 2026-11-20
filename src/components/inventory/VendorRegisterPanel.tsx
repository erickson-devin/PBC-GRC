import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Building2, CheckCircle2, Edit2, FileDown, Lock, Plus, Search, Trash2 } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useVendorRegister } from '../../hooks/useVendorRegister';
import { useToolRegister } from '../../hooks/useToolRegister';
import { useProgramInventory } from '../../hooks/useProgramInventory';
import { FEDRAMP_LABELS, INVENTORY_UI_TEXT, localDateIso, renewalBadge, triLabel } from '../../data/inventory/inventoryUiView';
import {
  VENDOR_KIND_LABELS,
  VENDOR_UI_TEXT,
  filterVendors,
  removeVendorConfirmText,
  reviewAge,
  toolsByVendor,
  vendorCountCaption,
  vendorEmptyMessage,
  vendorErrorMessage,
} from '../../data/inventory/vendorRegisterView';
import type { VendorInput } from '../../data/inventory/inventorySchema';
import { vendorRegisterCsv } from '../../data/reports/inventoryRegisterCsv';
import { VENDOR_KINDS, type InventoryVendor, type VendorKind } from '../../types/inventory';
import { ErrorNotice } from '../common/ErrorNotice';
import { downloadCsv } from './downloadCsv';
import { VendorDialog } from './VendorDialog';
import { VendorDocumentsDialog } from './VendorDocumentsDialog';

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const fieldClass = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const confirmButton = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50';
const pillTone = { rose: 'bg-rose-500/15 border-rose-500/30 text-rose-300', amber: 'bg-amber-500/15 border-amber-500/30 text-amber-300', slate: 'bg-slate-800 border-slate-700 text-slate-300' } as const;

/**
 * The organization's vendors and external service providers (#248): contracts, FedRAMP status, the CRM on file and review dates, with the
 * documents linked in the open program. Server-backed organizations only. Names, services and notes may be CUI: notifications use fixed text,
 * and nothing is cached in browser storage or logged.
 */
export const VendorRegisterPanel: React.FC = () => {
  const { currentTenant, canEdit, activeProgram, activeFramework } = useTenant();
  const tenantId = currentTenant.id;
  const headingId = useId();
  const baseId = useId();

  const reg = useVendorRegister();
  const tools = useToolRegister();
  const inv = useProgramInventory();

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<VendorKind | 'ALL'>('ALL');
  const [dialog, setDialog] = useState<{ initial: InventoryVendor | null; key: number } | null>(null);
  const [docsFor, setDocsFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const docButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogCounter = useRef(0);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const programReady = inv.status === 'ready' && Boolean(activeProgram);
  const programName = activeProgram?.name ?? '';
  const archived = Boolean(activeProgram?.archived);
  const today = localDateIso(new Date());
  const editorsReady = canEdit && reg.status === 'ready';
  const limitReached = reg.vendors.length >= reg.limit;

  const byVendor = useMemo(() => toolsByVendor(tools.tools), [tools.tools]);
  const shown = useMemo(() => filterVendors(reg.vendors, query, kind), [reg.vendors, query, kind]);
  const docCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of inv.vendorDocuments) out[d.vendorId] = (out[d.vendorId] ?? 0) + 1;
    return out;
  }, [inv.vendorDocuments]);
  const docsVendor = docsFor ? reg.vendors.find((v) => v.id === docsFor) ?? null : null;

  // Another organization's or program's dialogs, confirmations and messages must not carry over
  useEffect(() => {
    setQuery('');
    setKind('ALL');
    setDialog(null);
    setDocsFor(null);
    setPendingDelete(null);
    setActionError(null);
    setNotification(null);
  }, [tenantId, activeProgram?.id]);
  useEffect(() => () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
  }, []);
  // A vendor removed elsewhere closes its documents window
  useEffect(() => {
    if (docsFor && reg.status === 'ready' && !docsVendor) setDocsFor(null);
  }, [docsFor, docsVendor, reg.status]);

  const showNotification = (msg: string): void => {
    setNotification(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(null), 4000);
  };

  const exportCsv = (): void => {
    const fileName = `vendors-and-service-providers-${today}.csv`;
    downloadCsv(fileName, vendorRegisterCsv(shown, byVendor));
    showNotification(`Exported ${shown.length} ${shown.length === 1 ? 'vendor' : 'vendors'} to ${fileName}.`);
  };

  const saveVendor = async (input: VendorInput, expectedUpdatedAt?: string): Promise<void> => {
    setActionError(null);
    const editing = dialog?.initial ?? null;
    if (editing) {
      await reg.update(editing.id, input, expectedUpdatedAt ?? editing.updatedAt);
      showNotification('Vendor updated.');
      return;
    }
    await reg.create(input);
    showNotification('Vendor added.');
  };

  const cancelDelete = (id: string): void => {
    setPendingDelete(null);
    setTimeout(() => removeButtons.current.get(id)?.focus(), 0);
  };

  const confirmDelete = async (v: InventoryVendor): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await reg.remove(v.id);
      setPendingDelete(null);
      showNotification('Vendor removed.');
      searchRef.current?.focus();
    } catch (err: unknown) {
      setActionError(vendorErrorMessage(err, 'delete'));
      if ((err as { status?: unknown } | null)?.status === 404) setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const columnCount = 8 + (programReady ? 1 : 0) + (canEdit ? 1 : 0);

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
            <Building2 className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id={headingId} className="text-base font-bold text-white">{VENDOR_UI_TEXT.title}</h2>
              {reg.supported && (
                <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-300">{reg.vendors.length}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">{VENDOR_UI_TEXT.intro}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" disabled={shown.length === 0 || reg.status !== 'ready'} onClick={exportCsv} title="Exports the vendors currently shown" className={secondaryButton}>
            <FileDown className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>{`Export CSV (${shown.length})`}</span>
          </button>
          {canEdit && reg.supported && (
            <button
              type="button"
              disabled={!editorsReady || limitReached}
              onClick={() => setDialog({ initial: null, key: ++dialogCounter.current })}
              className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add vendor</span>
            </button>
          )}
        </div>
      </div>

      {!reg.supported ? (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <span>{VENDOR_UI_TEXT.unsupported}</span>
        </div>
      ) : (
        <>
          {!canEdit && (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <span>{VENDOR_UI_TEXT.readOnly}</span>
            </div>
          )}

          <ErrorNotice message={actionError} />
          {reg.status === 'error' && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={VENDOR_UI_TEXT.loadFailed} className="flex-1" />
              <button type="button" onClick={() => void reg.reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
            </div>
          )}
          {!programReady && inv.status !== 'loading' && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              {inv.status === 'error' ? INVENTORY_UI_TEXT.programFailed : VENDOR_UI_TEXT.docsNoProgram}
            </div>
          )}

          {notification && (
            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{notification}</span>
            </div>
          )}
          <p role="status" className="sr-only">{notification ?? ''}</p>

          <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search vendors"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by vendor or service…"
                className={`${fieldClass} w-full pl-9 pr-3`}
              />
            </div>
            <select aria-label="Kind filter" value={kind} onChange={(e) => setKind(e.target.value as VendorKind | 'ALL')} className={fieldClass}>
              <option value="ALL">All kinds</option>
              {VENDOR_KINDS.map((k) => (
                <option key={k} value={k}>{VENDOR_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>

          <p className="text-xs text-slate-400" aria-live="polite">{reg.status === 'loading' ? '' : vendorCountCaption(shown.length, reg.vendors.length)}</p>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table aria-busy={reg.status === 'loading' || busy || undefined} className="table w-full min-w-[56rem] text-left text-xs border-collapse">
              <caption className="sr-only">Vendor and service provider register</caption>
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                  <th scope="col" className="py-2.5 px-3 sticky left-0 z-10 bg-slate-900">Vendor</th>
                  <th scope="col" className="py-2.5 px-3">Kind</th>
                  <th scope="col" className="py-2.5 px-3">FedRAMP</th>
                  <th scope="col" className="py-2.5 px-3">CRM on file</th>
                  <th scope="col" className="py-2.5 px-3">Contract</th>
                  <th scope="col" className="py-2.5 px-3">Renewal</th>
                  <th scope="col" className="py-2.5 px-3">Last review</th>
                  <th scope="col" className="py-2.5 px-3">Tools</th>
                  {programReady && <th scope="col" className="py-2.5 px-3">{`Documents in ${programName}`}</th>}
                  {canEdit && <th scope="col" className="py-2.5 px-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {reg.status === 'loading' ? (
                  <tr>
                    <td colSpan={columnCount} className="py-8 text-center text-slate-400" role="status">{VENDOR_UI_TEXT.loading}</td>
                  </tr>
                ) : shown.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="py-8 text-center text-slate-400">{vendorEmptyMessage({ total: reg.vendors.length, canEdit })}</td>
                  </tr>
                ) : (
                  shown.map((v) => {
                    const names = byVendor[v.id] ?? [];
                    const docs = docCounts[v.id] ?? 0;
                    const renewal = renewalBadge(v.renewalDate, today);
                    const review = reviewAge(v.lastReviewDate, today);
                    return (
                      <React.Fragment key={v.id}>
                        <tr className="hover:bg-slate-800/40 transition-colors">
                          <td className="py-3 px-3 sticky left-0 z-10 bg-slate-950 min-w-[14rem]">
                            <span className="font-semibold text-white">{v.name}</span>
                            {v.services && <div className="text-slate-400 truncate max-w-xs" title={v.services}>{v.services}</div>}
                          </td>
                          <td className="py-3 px-3 text-slate-300">{VENDOR_KIND_LABELS[v.kind]}</td>
                          <td className="py-3 px-3 text-slate-300">
                            {FEDRAMP_LABELS[v.fedrampStatus]}
                            {v.fedrampReference && <div className="font-mono text-[11px] text-slate-400">{v.fedrampReference}</div>}
                            {v.fedrampVerifiedOn && <div className="text-[11px] text-slate-400">{`Checked ${v.fedrampVerifiedOn}`}</div>}
                          </td>
                          <td className="py-3 px-3 text-slate-300">{triLabel(v.crmOnFile)}</td>
                          <td className="py-3 px-3 text-slate-300">{`${v.contractStart ?? '—'} to ${v.contractEnd ?? '—'}`}</td>
                          <td className="py-3 px-3 text-slate-300">
                            {v.renewalDate ?? '—'}
                            {renewal && <span className={`ml-2 px-1.5 py-0.5 rounded-full border text-[11px] font-semibold ${pillTone[renewal.tone]}`}>{renewal.text}</span>}
                          </td>
                          <td className="py-3 px-3 text-slate-300">
                            {v.lastReviewDate ?? '—'}
                            {review && <div><span className={`inline-flex mt-1 px-1.5 py-0.5 rounded-full border text-[11px] font-semibold ${pillTone[review.tone]}`}>{review.text}</span></div>}
                          </td>
                          <td className="py-3 px-3 font-mono text-slate-300" title={names.join(', ') || undefined}>{names.length}</td>
                          {programReady && (
                            <td className="py-3 px-3">
                              <button
                                type="button"
                                ref={(el) => {
                                  if (el) docButtons.current.set(v.id, el);
                                  else docButtons.current.delete(v.id);
                                }}
                                onClick={() => setDocsFor(v.id)}
                                aria-label={`${docs} ${docs === 1 ? 'document' : 'documents'} for ${v.name} in ${programName}; open`}
                                className="px-2 py-0.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 font-mono text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                              >
                                {docs}
                              </button>
                            </td>
                          )}
                          {canEdit && (
                            <td className="py-3 px-3 text-right">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={!editorsReady}
                                  aria-label={`Edit ${v.name}`}
                                  onClick={() => setDialog({ initial: v, key: ++dialogCounter.current })}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                >
                                  <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  disabled={!editorsReady}
                                  aria-label={`Remove ${v.name}`}
                                  aria-expanded={pendingDelete === v.id}
                                  aria-controls={pendingDelete === v.id ? `${baseId}-confirm-${v.id}` : undefined}
                                  ref={(el) => {
                                    if (el) removeButtons.current.set(v.id, el);
                                    else removeButtons.current.delete(v.id);
                                  }}
                                  onClick={() => setPendingDelete(v.id)}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                        {pendingDelete === v.id && (
                          <tr id={`${baseId}-confirm-${v.id}`} className="bg-slate-900/70">
                            <td colSpan={columnCount} className="py-3 px-3">
                              <div
                                role="group"
                                aria-label="Remove this vendor?"
                                className="flex flex-wrap items-center gap-3 text-xs"
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.stopPropagation();
                                    cancelDelete(v.id);
                                  }
                                }}
                              >
                                <p className="flex-1 min-w-[16rem] text-slate-200">{removeVendorConfirmText(names.length, docs)}</p>
                                <button type="button" autoFocus disabled={busy} onClick={() => void confirmDelete(v)} className="btn-danger px-3 py-1 rounded-lg text-xs disabled:opacity-50">
                                  Remove vendor
                                </button>
                                <button type="button" disabled={busy} onClick={() => cancelDelete(v.id)} className={confirmButton}>Cancel</button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {dialog && (
        <VendorDialog
          key={dialog.key}
          initial={dialog.initial}
          toolNames={dialog.initial ? byVendor[dialog.initial.id] ?? [] : []}
          onSave={saveVendor}
          latest={(id) => reg.vendors.find((v) => v.id === id) ?? null}
          onClose={() => setDialog(null)}
        />
      )}
      {docsFor && docsVendor && activeProgram && programReady && (
        <VendorDocumentsDialog
          vendor={docsVendor}
          programName={activeProgram.name}
          framework={activeFramework}
          links={inv.vendorDocuments}
          canEdit={canEdit && !archived}
          onClose={() => {
            const id = docsVendor.id;
            setDocsFor(null);
            setTimeout(() => docButtons.current.get(id)?.focus(), 0);
          }}
        />
      )}
    </section>
  );
};

export default VendorRegisterPanel;
