import React, { useId, useState } from 'react';
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
import { VM_TOKENS_COPY } from '../../data/telemetry/vmTokensView';
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

  if (!isOpen) return null;

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
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
              onClick={onClose}
              className="w-7 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white"
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
                <>For scripts and scanners, a Tenant Owner or MSP Admin creates a VM service token here; it is sent to <code className="text-cyan-400">POST /api/v1/vm/ingest</code> (see the vulnerability-management guide).</>
              )}
            </p>
          </div>

          {/* VM service tokens */}
          {serverBacked && canEdit ? (
            <VmServiceTokensSection key={currentTenant.id} tenantId={currentTenant.id} tenantName={currentTenant.name} onRevealChange={setRevealing} />
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

          <div className="pt-2 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
            >
              Close
            </button>
          </div>

        </div>
      </div>
    </DialogOverlay>
  );
};
