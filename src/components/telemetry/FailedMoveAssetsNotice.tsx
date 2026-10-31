import React, { useEffect, useId, useRef, useState } from 'react';
import { CloudUpload, Inbox, Loader2, Trash2 } from 'lucide-react';
import { useFailedMoveAssets } from '../../hooks/useFailedMoveAssets';
import { useTenant } from '../../context/TenantContext';
import { ErrorNotice } from '../common/ErrorNotice';

type OrphanAction = 'claim' | 'discard';

/**
 * Offers a retry for assets that did not reach the server when a browser-only tenant was moved (#92), and, for a Tenant Owner or
 * MSP Admin, a claim or discard for asset lists an earlier move left under an unregistered tenant id (#112). Both orphan actions
 * need an inline confirmation; only the old id and a count are shown, never an asset's fields. Renders nothing when there is nothing to show.
 */
export const FailedMoveAssetsNotice: React.FC = () => {
  const { pending, status, error, lastResult, retry, orphans, claim, discard } = useFailedMoveAssets();
  const { currentTenant } = useTenant();
  const confirmId = useId();
  const [confirm, setConfirm] = useState<{ action: OrphanAction; tenantId: string } | null>(null);
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const [orphanResult, setOrphanResult] = useState('');
  const busyRef = useRef(false);
  const orphanRegionRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<string | null>(null);

  // A tenant switch drops any open confirmation and the previous tenant's result line
  useEffect(() => {
    setConfirm(null);
    setOrphanError(null);
    setOrphanResult('');
  }, [currentTenant.id]);

  // Cancel (button or Escape) returns focus to the Claim / Discard button that opened the confirmation
  useEffect(() => {
    if (confirm || !restoreFocus.current) return;
    const key = restoreFocus.current;
    restoreFocus.current = null;
    (triggerRefs.current.get(key) ?? orphanRegionRef.current)?.focus();
  }, [confirm]);

  const openConfirm = (action: OrphanAction, tenantId: string) => {
    setOrphanError(null);
    setOrphanResult('');
    setConfirm({ action, tenantId });
  };

  const cancelConfirm = () => {
    if (busyRef.current || !confirm) return;
    restoreFocus.current = `${confirm.action}:${confirm.tenantId}`;
    setOrphanError(null);
    setConfirm(null);
  };

  const runOrphanAction = async (action: OrphanAction, tenantId: string, assetCount: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOrphanBusy(true);
    setOrphanError(null);
    setOrphanResult('');
    const noun = assetCount === 1 ? 'asset' : 'assets';
    try {
      await (action === 'claim' ? claim(tenantId) : discard(tenantId));
      setOrphanResult(action === 'claim'
        ? `Claimed ${assetCount} ${noun} from ${tenantId}. Retry moving ${assetCount === 1 ? 'it' : 'them'} in the notice above.`
        : `Discarded ${assetCount} ${noun} from ${tenantId}. ${assetCount === 1 ? 'It was' : 'They were'} deleted from this browser.`);
      setConfirm(null);
      orphanRegionRef.current?.focus();
    } catch {
      setOrphanError(action === 'claim'
        ? 'The list could not be claimed. The assets are still in this browser; try again or cancel.'
        : 'The list could not be discarded. The assets are still in this browser; try again or cancel.');
    } finally {
      busyRef.current = false;
      setOrphanBusy(false);
    }
  };

  const onConfirmKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    cancelConfirm();
  };

  if (pending === 0 && orphans.length === 0 && !orphanResult) return null;
  const orphanActionsDisabled = orphanBusy || status !== 'idle';

  return (
    <>
      {pending > 0 && (
        <div role="region" aria-label="Assets not yet moved to the server" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 leading-relaxed text-slate-300">
              <strong className="text-amber-200">{pending} asset{pending === 1 ? ' is' : 's are'} still only in this browser.</strong>{' '}
              They were not saved when this tenant was moved to the server. Retry to add them to the inventory; this browser&apos;s copy is removed once the server holds them.
            </p>
            <button type="button" onClick={() => void retry()} disabled={status !== 'idle' || orphanBusy} className="btn-primary px-4 py-2 text-xs shrink-0 disabled:opacity-50">
              {status === 'retrying' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{status === 'retrying' ? 'Retrying…' : `Retry moving ${pending} asset${pending === 1 ? '' : 's'}`}</span>
            </button>
          </div>
          <ErrorNotice message={error} className="mt-3" />
          <p role="status" aria-live="polite" className="mt-2 text-amber-200">{lastResult ? `${lastResult.moved} moved, ${lastResult.stillLocal} still in this browser.` : ''}</p>
        </div>
      )}
      {(orphans.length > 0 || orphanResult) && (
        <div ref={orphanRegionRef} tabIndex={-1} role="region" aria-label="Asset lists left in this browser by an earlier move" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs focus:outline-none">
          {orphans.length > 0 && (
            <>
              <p className="leading-relaxed text-slate-300">
                <strong className="text-amber-200">{orphans.length} asset list{orphans.length === 1 ? ' from an earlier move is' : 's from earlier moves are'} still in this browser.</strong>{' '}
                They were left under a browser-only tenant id that is no longer registered here, so they did not move with it. Claim a list only if you recognise it as this organisation&apos;s; otherwise discard it.
              </p>
              <ul aria-label="Asset lists left in this browser" className="mt-3 space-y-2">
                {orphans.map(o => {
                  const open = confirm?.tenantId === o.tenantId ? confirm : null;
                  const noun = o.assetCount === 1 ? 'asset' : 'assets';
                  return (
                    <li key={o.tenantId} className="rounded-xl border border-amber-500/30 bg-slate-950/40 p-2.5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="min-w-0 text-slate-300">
                          <span className="font-mono text-slate-200 break-all">{o.tenantId}</span>
                          <span className="text-slate-400"> · {o.assetCount} {noun}</span>
                        </p>
                        {!open && (
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              ref={el => { if (el) triggerRefs.current.set(`claim:${o.tenantId}`, el); else triggerRefs.current.delete(`claim:${o.tenantId}`); }}
                              onClick={() => openConfirm('claim', o.tenantId)}
                              disabled={orphanActionsDisabled}
                              aria-label={`Claim ${o.assetCount} ${noun} from ${o.tenantId}`}
                              className="btn-secondary px-3 py-1.5 text-xs"
                            >
                              <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Claim</span>
                            </button>
                            <button
                              type="button"
                              ref={el => { if (el) triggerRefs.current.set(`discard:${o.tenantId}`, el); else triggerRefs.current.delete(`discard:${o.tenantId}`); }}
                              onClick={() => openConfirm('discard', o.tenantId)}
                              disabled={orphanActionsDisabled}
                              aria-label={`Discard ${o.assetCount} ${noun} from ${o.tenantId}`}
                              className="btn-ghost px-3 py-1.5 text-xs text-rose-300 hover:text-rose-200"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Discard</span>
                            </button>
                          </div>
                        )}
                      </div>
                      {open && (
                        <div role="group" aria-label={open.action === 'claim' ? 'Confirm claim' : 'Confirm discard'} aria-describedby={confirmId} aria-busy={orphanBusy} onKeyDown={onConfirmKeyDown} className="mt-2.5 space-y-2.5 border-t border-amber-500/20 pt-2.5">
                          <p id={confirmId} className="leading-relaxed text-slate-300">
                            {open.action === 'claim' ? (
                              <>
                                Claiming adds {o.assetCount} {noun} from <span className="font-mono">{o.tenantId}</span> to this tenant&apos;s retry, which moves {o.assetCount === 1 ? 'it' : 'them'} into this tenant&apos;s inventory.{' '}
                                <strong className="text-amber-200">If that id belonged to another organisation, its assets will become part of this tenant.</strong>
                              </>
                            ) : (
                              <>
                                Discarding deletes {o.assetCount} {noun} from <span className="font-mono">{o.tenantId}</span> from this browser and <strong className="text-rose-300">cannot be undone.</strong>
                              </>
                            )}
                          </p>
                          <ErrorNotice message={orphanError} />
                          <div className="flex items-center justify-end gap-2">
                            <button type="button" autoFocus onClick={cancelConfirm} disabled={orphanBusy} className="btn-ghost px-3 py-1.5 text-xs">
                              Cancel
                            </button>
                            <button type="button" onClick={() => void runOrphanAction(open.action, o.tenantId, o.assetCount)} disabled={orphanBusy || status !== 'idle'} className={`${open.action === 'claim' ? 'btn-primary' : 'btn-danger'} px-3 py-1.5 text-xs`}>
                              {orphanBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : open.action === 'claim' ? <Inbox className="h-3.5 w-3.5" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                              <span>{orphanBusy ? (open.action === 'claim' ? 'Claiming…' : 'Discarding…') : `${open.action === 'claim' ? 'Claim' : 'Discard'} ${o.assetCount} ${noun}`}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <p role="status" aria-live="polite" className="mt-2 text-amber-200">{orphanResult}</p>
        </div>
      )}
    </>
  );
};
