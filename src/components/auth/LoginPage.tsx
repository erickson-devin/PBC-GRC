import React, { useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  ArrowLeft,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { PRESET_USERS } from '../../context/TenantContext';

interface LoginPageProps {
  onSuccessRedirect?: (path?: string) => void;
  onExitToLanding?: () => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onSuccessRedirect,
  onExitToLanding,
  onOpenLegal,
}) => {
  const {
    isAuthenticated,
    loginWithMicrosoft,
    loginWithGoogle,
    loginWithEmailPassword,
    sendMagicLink,
    loginAsPreset,
    openLicenseModal,
    loading,
    authError,
    clearAuthError,
  } = useAuth();

  const [activeTab, setActiveTab] = React.useState<'sso' | 'magiclink' | 'password'>('sso');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  // Extract redirectUrl from URL query params
  const redirectUrl = React.useMemo(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('redirectUrl') || '/app';
    }
    return '/app';
  }, []);

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
    await loginWithEmailPassword(email.trim(), password);
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await sendMagicLink(email.trim());
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-brand-500 selection:text-white relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-brand-600/10 blur-3xl pointer-events-none rounded-full" />

      {/* Top Bar */}
      <header className="px-6 py-4 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md flex items-center justify-between z-10">
        <div 
          onClick={onExitToLanding}
          className="flex items-center gap-2.5 cursor-pointer group"
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center shadow-md shadow-brand-500/20 group-hover:scale-105 transition-transform">
            <ShieldCheck className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="font-extrabold text-sm text-white tracking-tight">PBC-GRC</span>
            <span className="text-[10px] text-slate-400 block font-medium">Pitch Black Cyber</span>
          </div>
        </div>

        {onExitToLanding && (
          <button
            onClick={onExitToLanding}
            className="text-xs font-semibold text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Public Site & Pricing</span>
          </button>
        )}
      </header>

      {/* Main Authentication Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 z-10">
        <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
            
            {/* Badge & Title */}
            <div className="text-center space-y-2 mb-6">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-500/10 border border-brand-500/30 text-[10px] font-bold uppercase tracking-widest text-brand-300">
                <Lock className="w-3 h-3 text-brand-400" />
                CMMC 2.0 Level 1 Enclave
              </div>
              <h2 className="text-2xl font-black text-white tracking-tight">
                Enterprise Sign In
              </h2>
              <p className="text-xs text-slate-400">
                Google Cloud Identity Platform & Microsoft Entra ID
              </p>
            </div>

            {/* Error Banner */}
            {authError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs flex items-center justify-between">
                <span>{authError}</span>
                <button onClick={clearAuthError} className="text-rose-400 hover:text-white">✕</button>
              </div>
            )}

            {/* Tabs */}
            <div className="flex rounded-xl bg-slate-900 p-1 border border-slate-800 mb-5 text-xs">
              <button
                onClick={() => { setActiveTab('sso'); clearAuthError(); }}
                className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${
                  activeTab === 'sso' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                SSO Providers
              </button>
              <button
                onClick={() => { setActiveTab('magiclink'); clearAuthError(); }}
                className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${
                  activeTab === 'magiclink' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                Magic Link
              </button>
              <button
                onClick={() => { setActiveTab('password'); clearAuthError(); }}
                className={`flex-1 py-1.5 rounded-lg font-semibold transition-all ${
                  activeTab === 'password' ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                Credentials
              </button>
            </div>

            {/* Tab 1: SSO */}
            {activeTab === 'sso' && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={loginWithMicrosoft}
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl bg-[#2F2F2F] hover:bg-[#3B3B3B] text-white border border-slate-700 font-semibold text-xs transition-all flex items-center justify-between shadow-md"
                >
                  <div className="flex items-center gap-3">
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 21 21">
                      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                    </svg>
                    <span className="font-bold">Sign in with Microsoft 365</span>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-slate-300 border border-white/10">
                    Entra ID
                  </span>
                </button>

                <button
                  type="button"
                  onClick={loginWithGoogle}
                  disabled={loading}
                  className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-850 text-white border border-slate-700 font-semibold text-xs transition-all flex items-center justify-between shadow-md"
                >
                  <div className="flex items-center gap-3">
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                    <span className="font-bold">Sign in with Google Workspace</span>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-slate-300 border border-white/10">
                    SSO
                  </span>
                </button>
              </div>
            )}

            {/* Tab 2: Magic Link */}
            {activeTab === 'magiclink' && (
              <form onSubmit={handleMagicLinkSubmit} className="space-y-3">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="auditor@defense-audit.org"
                  className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
                >
                  Send Passwordless Magic Link
                </button>
              </form>
            )}

            {/* Tab 3: Password */}
            {activeTab === 'password' && (
              <form onSubmit={handlePasswordSubmit} className="space-y-3">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="contractor@defense.com"
                  className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
                >
                  Sign In
                </button>
              </form>
            )}

            {/* License Request / Sales Call Onboarding Card */}
            <div className="mt-6 pt-5 border-t border-slate-800 text-xs">
              <div className="p-3 rounded-2xl bg-brand-950/30 border border-brand-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-brand-300 font-bold uppercase tracking-wider text-[10px]">
                    Need Enclave Licensing?
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400 font-semibold">
                    From $1,000 / yr
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Acquire an enclave license for your team and schedule an onboarding session with our defense CISO architects.
                </p>
                <button
                  type="button"
                  onClick={() => openLicenseModal('single-org')}
                  className="w-full py-2 px-3 rounded-xl bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/40 font-bold text-xs transition-colors"
                >
                  Request License & Schedule Call
                </button>
              </div>
            </div>

            {/* Demo Presets */}
            <div className="mt-4 pt-3 border-t border-slate-800 text-[10px]">
              <span className="text-slate-500 block mb-1 font-mono">1-Click Test Personas:</span>
              <div className="grid grid-cols-3 gap-1">
                {PRESET_USERS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => loginAsPreset(p)}
                    className="p-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-medium truncate"
                  >
                    {p.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>

          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 text-center text-xs text-slate-500 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-3 max-w-5xl mx-auto w-full">
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
