import React, { useEffect, useId, useRef, useState } from 'react';
import {
  X,
  Key,
  KeyRound,
  Lock,
  ShieldCheck,
  Clock,
  Server,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { VM_TOKENS_COPY, tokenCloseGuard } from '../../data/telemetry/vmTokensView';
import { VmServiceTokensSection } from './VmServiceTokensSection';
import { ConnectedScannersPanel } from './ConnectedScannersPanel';
import { ExporterSetupPanel } from './ExporterSetupPanel';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface ApiTokensModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ApiTokensModal: React.FC<ApiTokensModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { currentTenant, canEdit } = useTenant();
  const serverBacked = Boolean(currentTenant.serverBacked);
  const tokensHeadingId = useId();
  const [revealing, setRevealing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const closeConfirmId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  const footerCloseRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const guard = tokenCloseGuard({ creating, revealing });

  // The question only makes sense while a new token is on screen.
  useEffect(() => { if (guard !== 'confirm') setConfirmClose(false); }, [guard]);

  if (!isOpen) return null;

  const focusLater = (target: () => HTMLElement | null | undefined) => {
    requestAnimationFrame(() => target()?.focus());
  };

  const requestClose = () => {
    if (guard === 'busy') return;
    if (guard === 'confirm') {
      if (!confirmClose) returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmClose(true);
      focusLater(() => keepRef.current);
      return;
    }
    onClose();
  };
  const keepToken = () => {
    setConfirmClose(false);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    focusLater(() => (back && document.contains(back) ? back : footerCloseRef.current));
  };
  const closeAnyway = () => {
    setConfirmClose(false);
    returnFocusRef.current = null;
    onClose();
  };

  return (
    <DialogOverlay onClose={guard === 'busy' ? undefined : confirmClose ? keepToken : requestClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-2xl p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
        <div className="max-h-[calc(94vh-0.75rem)] overflow-y-auto p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-5">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <DialogTitle as="h2" className="text-sm font-bold text-white">API Keys & Service Tokens</DialogTitle>
                <p className="text-xs text-slate-400">Your browser session, and the service tokens scanners push with</p>
              </div>
            </div>
            <button aria-label="Close"
              onClick={requestClose}
              disabled={guard === 'busy'}
              className="w-7 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Browser session */}
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                Your browser session
              </span>
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Clock className="w-3 h-3 text-brand-400" />
                <span>Expires 8 hours after sign-in, or sooner if your password is changed or your account is reset</span>
              </div>
            </div>

            <p className="text-slate-400 leading-relaxed">
              Your browser session is kept in an HttpOnly cookie, so it cannot be copied or read by scripts.{' '}
              {!serverBacked ? (
                <>Scripts and scanners push to <code className="text-cyan-400">POST /api/v1/vm/ingest</code> with a VM service token, which needs a server-backed organization.</>
              ) : canEdit ? (
                <>For scripts and scanners, create a VM service token below and send it to <code className="text-cyan-400">POST /api/v1/vm/ingest</code> (see the vulnerability-management guide).</>
              ) : (
                <>For scripts and scanners, a Tenant Owner or Admin creates a VM service token here; it is sent to <code className="text-cyan-400">POST /api/v1/vm/ingest</code> (see the vulnerability-management guide).</>
              )}
            </p>
          </div>

          {/* VM service tokens */}
          {serverBacked && canEdit ? (
            <VmServiceTokensSection key={currentTenant.id} tenantId={currentTenant.id} tenantName={currentTenant.name} onRevealChange={setRevealing} onCreatingChange={setCreating} />
          ) : (
            <section aria-labelledby={tokensHeadingId} className="space-y-2 text-xs pt-4 border-t border-slate-800">
              <h3 id={tokensHeadingId} className="text-sm font-bold text-white flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />{VM_TOKENS_COPY.heading}
              </h3>
              <p role="note" className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-slate-300">
                <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{serverBacked ? VM_TOKENS_COPY.notOwner : VM_TOKENS_COPY.browserOnly}</span>
              </p>
            </section>
          )}

          {/* Connected scanners (read-only; any member of a server-backed organization) */}
          {serverBacked && <ConnectedScannersPanel key={`scanners-${currentTenant.id}`} tenantId={currentTenant.id} canManageTokens={canEdit} />}

          {/* Exporter setup: the env file and commands. The token is never part of this text. Hidden while the new-token reveal shows its own copy. */}
          {serverBacked && canEdit && !revealing && <ExporterSetupPanel />}

          {/* Direct API use */}
          <p className="text-xs text-slate-400 leading-relaxed">
            Calling the API without the exporter: send the token in the header <code className="text-cyan-400">{'-H "Authorization: Bearer <SERVICE_TOKEN>"'}</code> with a JSON body (see the vulnerability-management guide).
          </p>

          {/* Multi-tenant note */}
          <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 text-xs text-slate-400 flex items-start gap-2">
            <Server className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
            <span>
              A service token belongs to one organization: everything pushed with it is stored for <strong className="text-slate-300">{currentTenant.name}</strong> only.
            </span>
          </div>

          {confirmClose ? (
            <div
              role="group"
              aria-labelledby={closeConfirmId}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keepToken(); } }}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2.5 text-xs"
            >
              <p id={closeConfirmId} className="text-amber-100 leading-relaxed">{VM_TOKENS_COPY.closeConfirm}</p>
              <div className="flex items-center justify-end gap-2">
                <button ref={keepRef} type="button" onClick={keepToken} className="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all">{VM_TOKENS_COPY.keepToken}</button>
                <button type="button" onClick={closeAnyway} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 hover:bg-rose-900/50">{VM_TOKENS_COPY.closeAnyway}</button>
              </div>
            </div>
          ) : (
            <div className="pt-2 flex justify-end">
              <button
                ref={footerCloseRef}
                type="button"
                onClick={requestClose}
                disabled={guard === 'busy'}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Close
              </button>
            </div>
          )}

        </div>
      </div>
    </DialogOverlay>
  );
};
