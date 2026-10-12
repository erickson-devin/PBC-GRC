import React from 'react';
import {
  X,
  User,
  Shield,
  Building,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface AccountSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AccountSettingsModal: React.FC<AccountSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { currentUser, firebaseUser } = useAuth();
  const { currentTenant, currentRole } = useTenant();

  if (!isOpen) return null;

  const providerLabel = currentUser.authProvider === 'microsoft.com'
    ? 'Microsoft 365 / Entra ID'
    : currentUser.authProvider === 'google.com'
    ? 'Google Workspace / Cloud Identity'
    : currentUser.authProvider === 'emailLink'
    ? 'Passwordless Magic Link (Auditor)'
    : 'Enterprise Password Credentials';

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl">
        <div className="p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-5">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400">
                <User className="w-4 h-4" />
              </div>
              <div>
                <DialogTitle as="h3" className="text-sm font-bold text-white">Account & Identity Settings</DialogTitle>
                <p className="text-xs text-slate-400">Defense Enclave User Profile</p>
              </div>
            </div>
            <button aria-label="Close"
              onClick={onClose}
              className="w-7 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* User Details */}
          <div className="space-y-3 text-xs">
            <div>
              <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                Full Name
              </label>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-white font-semibold">
                {currentUser.name}
              </div>
            </div>

            <div>
              <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                Work Email (Enclave Principal)
              </label>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-white font-mono flex items-center justify-between">
                <span>{currentUser.email}</span>
                <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                  <CheckCircle2 className="w-3 h-3" /> Verified
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                  Identity Provider
                </label>
                <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-white font-medium text-xs truncate">
                  {providerLabel}
                </div>
              </div>

              <div>
                <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                  Assigned CMMC Role
                </label>
                <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-brand-300 font-semibold text-xs flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <span>{currentRole}</span>
                </div>
              </div>
            </div>

            <div>
              <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                Active Tenant Enclave
              </label>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2 truncate">
                  <Building className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <span className="truncate">{currentTenant.name}</span>
                </div>
                <span className="font-mono text-xs text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded shrink-0">
                  {currentTenant.cageCode || 'CAGE'}
                </span>
              </div>
            </div>

            <div>
              <label className="text-slate-400 text-xs uppercase font-bold block mb-1">
                User UID (Cloud Identity)
              </label>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-xs text-slate-400 truncate">
                {firebaseUser?.uid || currentUser.id}
              </div>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors"
            >
              Done
            </button>
          </div>

        </div>
      </div>
    </DialogOverlay>
  );
};
