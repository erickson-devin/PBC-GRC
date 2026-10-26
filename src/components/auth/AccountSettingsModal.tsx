import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  User,
  Shield,
  Building,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';
import { ApiClient, MfaStatus } from '../../services/apiClient';
import { ErrorNotice } from '../common/ErrorNotice';
import { errorMessage } from '../../utils/errors';
import { ROLE_LABELS } from '../../utils/roles';
import { MfaEnrolmentPanel, RecoveryCodesNotice } from './MfaEnrolmentPanel';
import { PasswordChangeForm } from './PasswordChangeForm';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface AccountSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AccountSettingsModal: React.FC<AccountSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { currentUser, startEnrolment, confirmEnrolment } = useAuth();
  const { currentTenant, currentRole } = useTenant();

  // Security section: second-factor status, enrolment, recovery codes and the password
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [securityView, setSecurityView] = useState<'idle' | 'enrol' | 'regenerate' | 'password'>('idle');
  const [regenCode, setRegenCode] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  const loadMfaStatus = useCallback(async () => {
    try {
      setMfa(await ApiClient.getMfaStatus());
      setSecurityError(null);
    } catch (err: unknown) {
      setSecurityError(errorMessage(err) || 'Could not load the two-step verification status.');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setSecurityView('idle');
    setSecurityNotice(null);
    setNewRecoveryCodes(null);
    setRegenCode('');
    void loadMfaStatus();
  }, [isOpen, loadMfaStatus]);

  if (!isOpen) return null;

  const regenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = regenCode.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setSecurityError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setRegenBusy(true);
    setSecurityError(null);
    try {
      const fresh = await ApiClient.regenerateRecoveryCodes(digits);
      setNewRecoveryCodes(fresh.recoveryCodes);
      setRegenCode('');
    } catch (err: unknown) {
      setSecurityError(errorMessage(err) || 'Could not generate new recovery codes.');
      setRegenCode('');
    } finally {
      setRegenBusy(false);
    }
  };

  const finishSecurityAction = (notice: string | null) => {
    setSecurityView('idle');
    setNewRecoveryCodes(null);
    setSecurityNotice(notice);
    void loadMfaStatus();
  };

  const providerLabel = 'Local account';

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl">
        <div className="p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-5 max-h-[90vh] overflow-y-auto">
          
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
                  <span>{ROLE_LABELS[currentRole] ?? currentRole}</span>
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
                User ID
              </label>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-xs text-slate-400 truncate">
                {currentUser.id}
              </div>
            </div>
          </div>

          {/* Security */}
          <section aria-labelledby="account-security-heading" className="space-y-3 pt-4 border-t border-slate-800 text-xs">
            <h4 id="account-security-heading" className="flex items-center gap-2 text-slate-300 uppercase font-bold text-xs tracking-wider">
              <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" /> Security
            </h4>

            <ErrorNotice message={securityError} />
            {securityNotice && (
              <div role="status" className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">{securityNotice}</div>
            )}

            <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-semibold">Two-step verification</span>
                {mfa === null ? (
                  <span className="text-slate-400">Checking…</span>
                ) : mfa.enrolled ? (
                  <span className="text-emerald-400 font-semibold">On</span>
                ) : (
                  <span className="text-amber-300 font-semibold">Not set up</span>
                )}
              </div>
              {mfa?.enrolled && (
                <p className="text-slate-400">
                  Enrolled {mfa.enrolledAt ? new Date(mfa.enrolledAt).toLocaleDateString() : ''}. Recovery codes remaining:{' '}
                  <strong className="text-slate-200">{mfa.recoveryCodesRemaining}</strong>
                </p>
              )}
              {mfa && !mfa.enrolled && mfa.required && (
                <p className="text-amber-300">Your administrator requires two-step verification for this account.</p>
              )}
            </div>

            {securityView === 'idle' && (
              <div className="flex flex-wrap gap-2">
                {mfa && !mfa.enrolled && (
                  <button type="button" onClick={() => { setSecurityNotice(null); setSecurityView('enrol'); }} className="btn-base btn-secondary px-3 py-1.5 text-xs">
                    <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" /> Set up two-step verification
                  </button>
                )}
                {mfa?.enrolled && (
                  <button type="button" onClick={() => { setSecurityNotice(null); setSecurityError(null); setSecurityView('regenerate'); }} className="btn-base btn-secondary px-3 py-1.5 text-xs">
                    New recovery codes
                  </button>
                )}
                <button type="button" onClick={() => { setSecurityNotice(null); setSecurityError(null); setSecurityView('password'); }} className="btn-base btn-secondary px-3 py-1.5 text-xs">
                  <KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Change password
                </button>
              </div>
            )}

            {securityView === 'enrol' && (
              <MfaEnrolmentPanel
                onStart={startEnrolment}
                onConfirm={confirmEnrolment}
                onDone={() => finishSecurityAction('Two-step verification is on. You will be asked for a code at your next sign-in.')}
                onCancel={() => finishSecurityAction(null)}
              />
            )}

            {securityView === 'regenerate' && (
              newRecoveryCodes ? (
                <RecoveryCodesNotice codes={newRecoveryCodes} doneLabel="Done" onDone={() => finishSecurityAction('Your new recovery codes are active. The old ones no longer work.')} />
              ) : (
                <form onSubmit={regenerate} className="space-y-2">
                  <p className="text-slate-400">Generating a new set replaces the old codes. Enter a current code from your authenticator app to continue.</p>
                  <label htmlFor="regen-code" className="block text-xs font-semibold text-slate-300">Code from your authenticator app</label>
                  <input
                    id="regen-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    value={regenCode}
                    onChange={e => setRegenCode(e.target.value)}
                    placeholder="123456"
                    className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 font-mono tracking-widest"
                  />
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => finishSecurityAction(null)} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors">Cancel</button>
                    <button type="submit" disabled={regenBusy || !regenCode.trim()} className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all">
                      {regenBusy ? 'Generating…' : 'Generate new codes'}
                    </button>
                  </div>
                </form>
              )
            )}

            {securityView === 'password' && (
              <PasswordChangeForm
                intro="Changing your password signs you out everywhere else. Your current session stays signed in."
                onChanged={() => finishSecurityAction('Your password was changed. Your other sessions were signed out.')}
                onCancel={() => finishSecurityAction(null)}
              />
            )}
          </section>

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
