import React, { useState } from 'react';
import {
  X,
  Key,
  Copy,
  Check,
  ShieldCheck,
  Clock,
  Terminal,
  Server,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';
import { buildDevMockIdToken } from '../../config/devAuthToken';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyToClipboard } from '../../utils/clipboard';
interface ApiTokensModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ApiTokensModal: React.FC<ApiTokensModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { idToken, currentUser } = useAuth();
  const { currentTenant } = useTenant();
  const [isCopied, setIsCopied] = useState(false);

  if (!isOpen) return null;

  const displayToken =
    idToken ||
    buildDevMockIdToken({
      aud: 'grc-tool-507203',
      sub: currentUser.id,
      email: currentUser.email,
      tenant_id: currentTenant.id,
    }) ||
    '';

  const curlExample = `curl -X GET "https://grc.pitchblackcyber.com/api/v1/assessments" \\
  -H "Authorization: Bearer ${displayToken ? `${displayToken.slice(0, 24)}...` : '<ID_TOKEN>'}" \\
  -H "X-Tenant-ID: ${currentTenant.id}"`;

  const handleCopy = () => {
    if (!displayToken) return;
    copyToClipboard(displayToken);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-lg p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl">
        <div className="p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-5">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <DialogTitle as="h3" className="text-sm font-bold text-white">API Keys & Cloud Identity Tokens</DialogTitle>
                <p className="text-xs text-slate-400">Google Cloud Identity & Cloud Run Authentication</p>
              </div>
            </div>
            <button aria-label="Close"
              onClick={onClose}
              className="w-7 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Active JWT Section */}
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                Active Identity Platform JWT (Bearer Token)
              </span>
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Clock className="w-3 h-3 text-brand-400" />
                <span>Expires in 1 hr</span>
              </div>
            </div>

            <div className="relative p-3 rounded-xl bg-slate-900 border border-slate-800 font-mono text-xs text-slate-300 break-all select-all">
              {displayToken || 'No active session token. Sign in with a verified identity provider to obtain one.'}
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleCopy}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                {isCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Copied to Clipboard</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-400" />
                    <span>Copy Token</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* cURL Usage snippet */}
          <div className="space-y-2 text-xs">
            <span className="text-slate-300 font-semibold flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-brand-400" />
              Microservice Authorization Header
            </span>
            <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 font-mono text-xs text-brand-300 overflow-x-auto whitespace-pre">
              {curlExample}
            </div>
          </div>

          {/* Cloud SQL Multi-Tenant note */}
          <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 text-xs text-slate-400 flex items-start gap-2">
            <Server className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
            <span>
              Calls with this token automatically resolve PostgreSQL Row-Level Security (RLS) for tenant enclave: <strong className="text-slate-300">{currentTenant.name}</strong>.
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
