import React, { useState } from 'react';
import {
  Lock,
  Mail,
  Key,
  X,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { useAuth } from '../../context/AuthContext';
import { MfaChallengeForm } from './MfaChallengeForm';
import { MfaEnrolmentPanel } from './MfaEnrolmentPanel';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface AuthModalProps {
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onOpenLegal }) => {
  const {
    isAuthModalOpen,
    closeAuthModal,
    loginWithEmailPassword,
    sendPasswordReset,
    loading,
    authError,
    clearAuthError,
    mfaChallenge,
    startEnrolment,
    confirmEnrolment,
    finishMfa,
    cancelMfa,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isForgotPassword, setIsForgotPassword] = useState(false);

  if (!isAuthModalOpen) return null;

  const handleEmailChange = (val: string) => {
    setEmail(val);
    clearAuthError();
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    if (isForgotPassword) {
      await sendPasswordReset(email.trim());
      setIsForgotPassword(false);
      return;
    }

    const outcome = await loginWithEmailPassword(email.trim(), password);
    // Step one is done (or a second step follows): the password is not needed any more, so it does not stay in state
    if (outcome !== 'failed') setPassword('');
  };

  return (
    <DialogOverlay onClose={closeAuthModal} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/85 backdrop-blur-xl animate-fadeIn overflow-y-auto">
      {/* Outer Chassis Shell (Double-Bezel) */}
      <div className="relative w-full max-w-lg my-8 p-1.5 sm:p-2 rounded-[2rem] bg-gradient-to-b from-brand-500/25 via-slate-800/40 to-slate-950/85 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
        
        {/* Inner Core Container */}
        <div className="relative p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
          
          {/* Close Button */}
          <button
            onClick={closeAuthModal}
            className="absolute top-5 right-5 w-8 h-8 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close authentication modal"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Header */}
          <div className="text-center space-y-2 mb-6">
            <div className="flex justify-center mb-2">
              <BrandLogo size="lg" showText={false} />
            </div>
            
            <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-xs font-bold uppercase tracking-widest text-cyan-300">
              <Lock className="w-3 h-3 text-cyan-400" />
              Event Horizon: Singularity Enclave
            </div>

            <DialogTitle as="h3" className="text-xl sm:text-2xl font-black text-white tracking-tight">
              {mfaChallenge ? (mfaChallenge.stage === 'enrol' ? 'Set Up Two-Step Verification' : 'Two-Step Verification') : 'Sign In to Defense Enclave'}
            </DialogTitle>
            <p className="text-xs text-slate-400">
              Event Horizon: Singularity • Central Governance & Compliance Engine
            </p>
          </div>

          {/* Error Banner */}
          {authError && (
            <div className="mb-4 p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs flex items-start gap-2.5 animate-shake">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-xs leading-relaxed">{authError}</div>
              <button onClick={clearAuthError} className="text-rose-400 hover:text-white">✕</button>
            </div>
          )}

          {/* Second step: a code, or setting up an authenticator */}
          {mfaChallenge?.stage === 'verify' && <MfaChallengeForm />}
          {mfaChallenge?.stage === 'enrol' && (
            <MfaEnrolmentPanel
              onStart={startEnrolment}
              onConfirm={confirmEnrolment}
              onDone={finishMfa}
              onCancel={cancelMfa}
              cancelLabel="Cancel and sign in again"
            />
          )}

          {/* Local credentials */}
          {!mfaChallenge && (
          <form onSubmit={handlePasswordSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Work Email</label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => handleEmailChange(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            {!isForgotPassword && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300">Password</label>
                  <button
                    type="button"
                    onClick={() => setIsForgotPassword(true)}
                    className="text-xs text-brand-400 hover:text-brand-300"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Key className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md shadow-brand-500/20 transition-all flex items-center justify-center gap-2"
            >
              <span>
                {loading
                  ? 'Authenticating...'
                  : isForgotPassword
                  ? 'Request Password Reset'
                  : 'Sign In'}
              </span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            {isForgotPassword && (
              <button
                type="button"
                onClick={() => setIsForgotPassword(false)}
                className="w-full text-center text-xs text-slate-400 hover:text-slate-200 mt-1"
              >
                Back to Sign In
              </button>
            )}
          </form>
          )}

          {/* Legal Links */}
          <div className="mt-3 text-center text-xs text-slate-400">
            <span>By proceeding, you agree to our </span>
            <button
              type="button"
              onClick={() => onOpenLegal && onOpenLegal('terms')}
              className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
            >
              Terms of Service
            </button>
            <span> and </span>
            <button
              type="button"
              onClick={() => onOpenLegal && onOpenLegal('privacy')}
              className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
            >
              Privacy Policy
            </button>
            <span>.</span>
          </div>

        </div>
      </div>
    </DialogOverlay>
  );
};
