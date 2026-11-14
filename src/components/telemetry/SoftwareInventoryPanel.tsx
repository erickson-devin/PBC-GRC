import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, Clock, Edit2, FileDown, Lock, Package, Plus, Search, Trash2 } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useEnclaveAssets } from '../../hooks/useEnclaveAssets';
import { useSoftwareItems } from '../../hooks/useSoftwareItems';
import { ApiClient } from '../../services/apiClient';
import { notifySoftwareChanged } from '../../services/softwareService';
import {
  APPROVAL_LABELS,
  ApprovalChoice,
  ApprovalFilter,
  approvalChoice,
  filterSoftware,
  hostNameMap,
  installedOnLabel,
  softwareCountCaption,
  softwareEmptyMessage,
  softwareErrorMessage,
} from '../../data/softwareInventoryView';
import type { SoftwareItem, SoftwareItemInput } from '../../types/software';
import { ErrorNotice } from '../common/ErrorNotice';
import { SoftwareItemDialog } from './SoftwareItemDialog';

const APPROVAL_BADGE: Record<ApprovalChoice, { cls: string; Icon: typeof CheckCircle2 }> = {
  APPROVED: { cls: 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300', Icon: CheckCircle2 },
  NOT_APPROVED: { cls: 'bg-rose-500/15 border border-rose-500/30 text-rose-300', Icon: Ban },
  NOT_REVIEWED: { cls: 'border border-dashed border-slate-600 text-slate-300', Icon: Clock },
};

/**
 * The tenant's software inventory (issue #229, phase 1b), under the asset inventory: applications in the enclave and whether
 * each is approved for use. Server-backed organizations only. Names, vendors and notes may be CUI: notifications use fixed
 * text, and nothing is cached in browser storage.
 */
export const SoftwareInventoryPanel: React.FC = () => {
  const { currentTenant, canEdit } = useTenant();
  const { openExportModal } = useAssessment();
  const tenantId = currentTenant.id;
  const { items, loading, error: loadError, reload, supported } = useSoftwareItems({ enabled: true });
  const { assets, loading: assetsLoading, reload: reloadAssets } = useEnclaveAssets();
  const headingId = useId();

  const [query, setQuery] = useState('');
  const [approval, setApproval] = useState<ApprovalFilter>('ALL');
  const [dialog, setDialog] = useState<{ initial: SoftwareItem | null; key: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const dialogCounter = useRef(0);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editorsReady = canEdit && !loading && loadError === null;
  const columnCount = canEdit ? 7 : 6;

  const hosts = useMemo(() => hostNameMap(assets), [assets]);
  const shownItems = useMemo(() => filterSoftware(items, { query, approval }, hosts), [items, query, approval, hosts]);

  // Another organization's dialog, confirmation and messages must not carry over
  useEffect(() => {
    setDialog(null);
    setPendingDelete(null);
    setActionError(null);
    setNotification(null);
  }, [tenantId]);
  useEffect(() => () => {
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
  }, []);

  const showNotification = (msg: string): void => {
    setNotification(msg);
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotification(null), 4000);
  };

  const afterFailure = async (err: unknown): Promise<void> => {
    const reason = (err as { reason?: unknown } | null)?.reason;
    if (reason === 'not_found') await reload();
    if (reason === 'asset_not_found') await reloadAssets();
  };

  const saveEntry = async (input: SoftwareItemInput): Promise<void> => {
    setActionError(null);
    const editing = dialog?.initial ?? null;
    try {
      if (editing) await ApiClient.updateSoftwareItem(tenantId, editing.id, input);
      else await ApiClient.createSoftwareItem(tenantId, input);
    } catch (err: unknown) {
      await afterFailure(err);
      throw err;
    }
    notifySoftwareChanged(tenantId);
    await reload();
    showNotification(editing ? 'Software entry updated.' : 'Software entry added.');
  };

  const confirmDelete = async (item: SoftwareItem): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await ApiClient.deleteSoftwareItem(tenantId, item.id);
      setPendingDelete(null);
      notifySoftwareChanged(tenantId);
      await reload();
      showNotification('Software entry removed.');
      searchRef.current?.focus();
    } catch (err: unknown) {
      setActionError(softwareErrorMessage(err, 'delete'));
      if ((err as { reason?: unknown } | null)?.reason === 'not_found') setPendingDelete(null);
      await afterFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const cancelDelete = (id: string): void => {
    setPendingDelete(null);
    // Back to the button that opened the confirmation
    setTimeout(() => removeButtons.current.get(id)?.focus(), 0);
  };

  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
            <Package className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id={headingId} className="text-base font-bold text-white">Software Inventory</h2>
              {supported && (
                <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-300">{items.length}</span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
              Applications in the enclave and whether each is approved for use (CMMC CM.L2-3.4.1 inventory, CM.L2-3.4.8 authorized software). Shared by every program in this organization.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => openExportModal('SOFTWARE_INVENTORY')}
            title="Opens the Export Center with the Software Inventory document (CM.L2-3.4.8) selected"
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            <FileDown className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>Export software inventory</span>
          </button>
          {canEdit && supported && (
            <button
              type="button"
              disabled={!editorsReady}
              onClick={() => setDialog({ initial: null, key: ++dialogCounter.current })}
              className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add Software</span>
            </button>
          )}
        </div>
      </div>

      {!supported ? (
        <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <span>
            The software inventory is kept on the server, so it needs a server-backed organization. This organization is stored only in this browser
            {canEdit ? ': move it to the server from the notice above the asset inventory' : ''}. The exported Software Inventory document still lists each asset's operating system: use Export software inventory above.
          </span>
        </div>
      ) : (
        <>
          {!canEdit && (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <span>Read-only: only a Tenant Owner or MSP Admin can change the software inventory.</span>
            </div>
          )}

          <ErrorNotice message={actionError} />
          {loadError && (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={loadError} className="flex-1" />
              <button type="button" onClick={() => void reload()} className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700">Retry</button>
            </div>
          )}

          {notification && (
            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{notification}</span>
            </div>
          )}
          <p role="status" className="sr-only">{notification ?? ''}</p>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search software"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by software, version, vendor, asset or notes..."
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <select
              aria-label="Approval filter"
              value={approval}
              onChange={(e) => setApproval(e.target.value as ApprovalFilter)}
              className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
            >
              <option value="ALL">All approval states</option>
              <option value="APPROVED">Approved</option>
              <option value="NOT_APPROVED">Not approved</option>
              <option value="NOT_REVIEWED">Not reviewed</option>
            </select>
          </div>

          <p className="text-xs text-slate-400" aria-live="polite">{loading ? '' : softwareCountCaption(shownItems.length, items.length)}</p>

          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table aria-busy={loading || busy || undefined} className="w-full text-left text-xs border-collapse">
              <caption className="sr-only">Software inventory</caption>
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                  <th scope="col" className="py-2.5 px-3">Software</th>
                  <th scope="col" className="py-2.5 px-3">Version</th>
                  <th scope="col" className="py-2.5 px-3">Vendor</th>
                  <th scope="col" className="py-2.5 px-3">Approved</th>
                  <th scope="col" className="py-2.5 px-3">Installed on</th>
                  <th scope="col" className="py-2.5 px-3">Notes</th>
                  {canEdit && <th scope="col" className="py-2.5 px-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading ? (
                  <tr>
                    <td colSpan={columnCount} className="py-8 text-center text-slate-400" role="status">Loading the software inventory…</td>
                  </tr>
                ) : shownItems.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="py-8 text-center text-slate-400">
                      {softwareEmptyMessage({ total: items.length, shown: shownItems.length, canEdit })}
                    </td>
                  </tr>
                ) : (
                  shownItems.map((item) => {
                    const choice = approvalChoice(item.approved);
                    const { cls, Icon } = APPROVAL_BADGE[choice];
                    const installedOn = installedOnLabel(item.assetId, hosts, assetsLoading);
                    return (
                      <tr key={item.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-3 font-semibold text-white">{item.name}</td>
                        <td className="py-3 px-3 font-mono text-slate-300">{item.version}</td>
                        <td className="py-3 px-3 text-slate-300">{item.vendor}</td>
                        <td className="py-3 px-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
                            <Icon className="w-3 h-3" aria-hidden="true" />
                            {APPROVAL_LABELS[choice]}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          {item.assetId === null ? (
                            <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[11px] font-semibold">{installedOn}</span>
                          ) : (
                            <span className="font-mono text-slate-300">{installedOn}</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-slate-400 max-w-[220px] truncate" title={item.notes || undefined}>{item.notes}</td>
                        {canEdit && (
                          <td className="py-3 px-3 text-right">
                            {pendingDelete === item.id ? (
                              <div
                                role="group"
                                aria-label="Remove this entry?"
                                className="inline-flex items-center gap-2"
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.stopPropagation();
                                    cancelDelete(item.id);
                                  }
                                }}
                              >
                                <span className="text-slate-300">Remove this entry?</span>
                                <button
                                  type="button"
                                  autoFocus
                                  disabled={busy}
                                  onClick={() => void confirmDelete(item)}
                                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50"
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => cancelDelete(item.id)}
                                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={!editorsReady}
                                  aria-label={`Edit ${item.name}`}
                                  onClick={() => setDialog({ initial: item, key: ++dialogCounter.current })}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
                                >
                                  <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  disabled={!editorsReady}
                                  aria-label={`Remove ${item.name}`}
                                  ref={(el) => {
                                    if (el) removeButtons.current.set(item.id, el);
                                    else removeButtons.current.delete(item.id);
                                  }}
                                  onClick={() => setPendingDelete(item.id)}
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors disabled:opacity-50"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {dialog && (
        <SoftwareItemDialog
          key={dialog.key}
          initial={dialog.initial}
          assets={assets}
          assetsLoading={assetsLoading}
          onSave={saveEntry}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
};

export default SoftwareInventoryPanel;
