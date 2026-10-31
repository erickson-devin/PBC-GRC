import React, { useEffect } from 'react';
import {
  Lock,
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { useAuth } from '../../context/AuthContext';
import { MfaChallengeForm } from './MfaChallengeForm';
import { MfaEnrolmentPanel } from './MfaEnrolmentPanel';
import { SIGNED_IN_DEFAULT, redirectFromLocation } from '../../utils/appRoute';

interface LoginPageProps {
  onSuccessRedirect?: (path?: string) => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onSuccessRedirect,
  onOpenLegal,
}) => {
  const {
    isAuthenticated,
    loginWithEmailPassword,
    loading,
    authError,
    clearAuthError,
    mfaChallenge,
    startEnrolment,
    confirmEnrolment,
    finishMfa,
    cancelMfa,
  } = useAuth();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const alertId = React.useId();
  const emailId = React.useId();
  const passwordId = React.useId();
  const emailRef = React.useRef<HTMLInputElement>(null);
  const dismissError = () => { clearAuthError(); emailRef.current?.focus(); };

  // Where to go after sign-in: the redirectUrl in the hash (or query), if it is a safe app address
  const redirectUrl = React.useMemo(
    () => (typeof window !== 'undefined'
      ? redirectFromLocation({ hash: window.location.hash, search: window.location.search })
      : SIGNED_IN_DEFAULT),
    []
  );

  // If already authenticated, redirect immediately
  useEffect(() => {
    if (isAuthenticated) {
      if (onSuccessRedirect) {
        onSuccessRedirect(redirectUrl);
      } else if (typeof window !== 'undefined') {
        window.location.hash = 'app';
      }
    }
  }, [isAuthenticated, onSuccessRedirect, redirectUrl]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    const outcome = await loginWithEmailPassword(email.trim(), password);
    // Step one is done (or a second step follows): the password is not needed any more, so it does not stay in state
    if (outcome !== 'failed') setPassword('');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-brand-500 selection:text-white relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-brand-600/10 blur-3xl pointer-events-none rounded-full" />

      {/* Top Bar */}
      <header className="px-6 py-4 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md flex items-center justify-between z-10">
        <div className="text-left flex items-center gap-2.5">
          <BrandLogo size="sm" />
          <div>
            <span className="font-extrabold text-sm text-white tracking-tight">Event Horizon: Singularity</span>
            <span className="text-xs text-cyan-400 block font-mono">Pitch Black Cyber</span>
          </div>
        </div>
      </header>

      {/* Main Authentication Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 z-10">
        <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
            
            {/* Badge & Title */}
            <div className="text-center space-y-2 mb-6">
              <div className="flex justify-center mb-2">
                <BrandLogo size="lg" showText={false} />
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-xs font-bold uppercase tracking-widest text-cyan-300">
                <Lock className="w-3 h-3 text-cyan-400" />
                CMMC 2.0 Level 1 Enclave
              </div>
              <h2 className="text-2xl font-black text-white tracking-tight">
                {mfaChallenge ? (mfaChallenge.stage === 'enrol' ? 'Set Up Two-Step Verification' : 'Two-Step Verification') : 'Enterprise Sign In'}
              </h2>
            </div>

            {/* Error Banner */}
            {authError && (
              <div role="alert" id={alertId} className="mb-4 p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs flex items-center justify-between gap-3">
                <span>{authError}</span>
                <button type="button" onClick={dismissError} aria-label="Dismiss this message" className="shrink-0 rounded text-rose-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"><span aria-hidden="true">✕</span></button>
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
                <label htmlFor={emailId} className="sr-only">Work email</label>
                <input
                  id={emailId}
                  ref={emailRef}
                  type="email"
                  required
                  autoFocus
                  autoComplete="username"
                  aria-describedby={authError ? alertId : undefined}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="contractor@defense.com"
                  className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label htmlFor={passwordId} className="sr-only">Password</label>
                <input
                  id={passwordId}
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
              >
                Sign In
              </button>
            </form>
            )}

          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 text-center text-xs text-slate-400 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-3 max-w-5xl mx-auto w-full">
        <span>© {new Date().getFullYear()} Pitch Black Cyber LLC • CMMC 2.0 Level 1 Enclave</span>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <button
            onClick={() => onOpenLegal && onOpenLegal('privacy')}
            className="hover:text-white transition-colors hover:underline"
          >
            Privacy Policy
          </button>
          <span>•</span>
          <button
            onClick={() => onOpenLegal && onOpenLegal('terms')}
            className="hover:text-white transition-colors hover:underline"
          >
            Terms of Service
          </button>
        </div>
      </footer>
    </div>
  );
};
