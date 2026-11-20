import React, { useId, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { VmDecisionsSection } from './VmDecisionsSection';
import { VmFindingDecisionDialog } from './VmFindingDecisionDialog';
import { VmRemediationPolicyPanel } from './VmRemediationPolicyPanel';
import { VmRemediationSummaryPanel } from './VmRemediationSummaryPanel';
import { useTenant } from '../../context/TenantContext';
import { useVmDecisions } from '../../hooks/useVmDecisions';
import { useVmRemediationPolicy, useVmRemediationSummary } from '../../hooks/useVmRemediationPolicy';
import { REMEDIATION_COPY as C, approverNote, ownerLevelCount, roleNote } from '../../data/telemetry/vmRemediationView';
import type { VmDecisionTarget } from '../../data/telemetry/vmRemediationView';
import { canRoleWrite } from '../../utils/roles';

/**
 * The vulnerability remediation window, opened from the profile menu: the organization's counts per remediation tier, the requests waiting for approval,
 * the decisions to re-review, and the policy with its history. Tenant-wide: it covers every program. Mount it only while open.
 */
export const VmRemediationModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { currentTenant, currentRole, isOwnerLevel, teamMembers } = useTenant();
  const serverBacked = Boolean(currentTenant.serverBacked);
  const policy = useVmRemediationPolicy({ enabled: serverBacked });
  const summary = useVmRemediationSummary({ enabled: serverBacked });
  const pending = useVmDecisions('pending', serverBacked);
  const expiring = useVmDecisions('expiring', serverBacked);
  const [requestFor, setRequestFor] = useState<VmDecisionTarget | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const footerCloseRef = useRef<HTMLButtonElement>(null);
  const closeConfirmId = useId();

  const reloadAll = () => {
    pending.reload();
    expiring.reload();
    summary.reload();
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setConfirmClose(true);
      requestAnimationFrame(() => keepRef.current?.focus());
      return;
    }
    onClose();
  };

  const keepEditing = () => {
    setConfirmClose(false);
    requestAnimationFrame(() => footerCloseRef.current?.focus());
  };

  const note = roleNote(currentRole);
  const approver = isOwnerLevel ? approverNote({ role: currentRole, ownerLevelCount: ownerLevelCount(teamMembers[currentTenant.id]) }) : null;
  const canRequest = canRoleWrite(currentRole);

  return (
    <DialogOverlay onClose={busy ? undefined : confirmClose ? keepEditing : requestClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-3xl rounded-3xl bg-slate-900 border border-slate-800 p-5 sm:p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <ShieldAlert className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle as="h2" className="text-sm font-bold text-white">{C.title}</DialogTitle>
              <p className="text-xs text-slate-400 break-words">{C.subtitle(currentTenant.name)}</p>
              {note && <p role="note" className="text-xs text-slate-400">{note}</p>}
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={requestClose} disabled={busy} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!serverBacked ? (
          <p role="note" className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">{C.browserOnly}</p>
        ) : (
          <>
            <VmRemediationSummaryPanel load={summary.load} onRetry={summary.reload} />
            <VmDecisionsSection kind="pending" load={pending.load} role={currentRole} nowMs={openedAt} onRetry={pending.reload} onAct={pending.act} onChanged={reloadAll} />
            {approver && <p role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{approver}</p>}
            <VmDecisionsSection
              kind="expiring"
              load={expiring.load}
              role={currentRole}
              nowMs={openedAt}
              onRetry={expiring.reload}
              onAct={expiring.act}
              onChanged={reloadAll}
              onRequestNew={
                canRequest
                  ? (d) => setRequestFor({ findingId: d.findingId ?? '', vulnId: d.vulnId ?? '', assetName: d.assetName ?? null, severity: null, findingStatus: null, tier: null })
                  : undefined
              }
            />
            <VmRemediationPolicyPanel
              load={policy.load}
              canEdit={isOwnerLevel}
              onRetry={() => { void policy.reload(); }}
              onSave={policy.save}
              onReload={policy.reload}
              loadEvents={policy.loadEvents}
              onSaved={summary.reload}
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
            />
          </>
        )}

        {confirmClose ? (
          <div
            role="group"
            aria-labelledby={closeConfirmId}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keepEditing(); } }}
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2.5 text-xs"
          >
            <p id={closeConfirmId} className="text-amber-100 leading-relaxed">{C.discardQuestion}</p>
            <div className="flex items-center justify-end gap-2">
              <button ref={keepRef} type="button" onClick={keepEditing} className="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all">{C.keepEditing}</button>
              <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 hover:bg-rose-900/50">{C.discard}</button>
            </div>
          </div>
        ) : (
          <div className="pt-2 flex justify-end">
            <button
              ref={footerCloseRef}
              type="button"
              onClick={requestClose}
              disabled={busy}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {C.close}
            </button>
          </div>
        )}
      </div>

      {requestFor && (
        <VmFindingDecisionDialog
          target={requestFor}
          onClose={(changed) => {
            setRequestFor(null);
            if (changed) reloadAll();
          }}
        />
      )}
    </DialogOverlay>
  );
};
