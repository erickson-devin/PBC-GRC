import React, { useState } from 'react';
import {
  Lock,
  Mail,
  Key,
  X,
  ArrowRight,
  AlertCircle,
  Building2,
  CheckCircle2,
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { useAuth } from '../../context/AuthContext';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
interface AuthModalProps {
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onOpenLegal }) => {
  const {
    isAuthModalOpen,
    closeAuthModal,
    authModalMode,
    authMode,
    loginWithMicrosoft,
    loginWithGoogle,
    loginWithEmailPassword,
    sendMagicLink,
    sendPasswordReset,
    loading,
    authError,
    clearAuthError,
  } = useAuth();

  const [selectedTab, setActiveTab] = useState<'sso' | 'magiclink' | 'password'>(
    authModalMode === 'magiclink' ? 'magiclink' : 'sso'
  );
  // Air-gapped installs have no SSO or magic links: only local credentials work.
  const isLocalAuth = authMode === 'local';
  const activeTab = isLocalAuth ? 'password' : selectedTab;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [detectedDomain, setDetectedDomain] = useState<string | null>(null);

  React.useEffect(() => {
    if (authModalMode === 'magiclink') {
      setActiveTab('magiclink');
    }
  }, [authModalMode]);

  if (!isAuthModalOpen) return null;

  const handleEmailChange = (val: string) => {
    setEmail(val);
    clearAuthError();
    const parts = val.split('@');
    if (parts.length === 2 && parts[1].includes('.')) {
      const domainName = parts[1].split('.')[0];
      setDetectedDomain(domainName.charAt(0).toUpperCase() + domainName.slice(1));
    } else {
      setDetectedDomain(null);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    if (isForgotPassword) {
      await sendPasswordReset(email.trim());
      setIsForgotPassword(false);
      return;
    }

    await loginWithEmailPassword(email.trim(), password);
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await sendMagicLink(email.trim());
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
              Sign In to Defense Enclave
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

          {/* Authentication Mode Tabs */}
          <div className={`${isLocalAuth ? 'hidden ' : ''}flex rounded-xl bg-slate-900 p-1 border border-slate-800 mb-5`}>
            <button
              onClick={() => { setActiveTab('sso'); clearAuthError(); }}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'sso'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Enterprise SSO
            </button>
            <button
              onClick={() => { setActiveTab('magiclink'); clearAuthError(); }}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'magiclink'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Magic Link
            </button>
            <button
              onClick={() => { setActiveTab('password'); clearAuthError(); }}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'password'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Email & Password
            </button>
          </div>

          {/* TAB 1: Enterprise SSO */}
          {activeTab === 'sso' && (
            <div className="space-y-3">
              {/* Microsoft 365 / Entra ID SSO Button */}
              <button
                type="button"
                onClick={loginWithMicrosoft}
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl bg-[#2F2F2F] hover:bg-[#3B3B3B] text-white border border-slate-700 font-semibold text-xs transition-all flex items-center justify-between group shadow-md"
              >
                <div className="flex items-center gap-3">
                  {/* Official Microsoft 4-square SVG Icon */}
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 21 21">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                  <span className="font-bold">Sign in with Microsoft 365</span>
                </div>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-black/40 text-slate-300 border border-white/10">
                  Entra ID
                </span>
              </button>

              {/* Google Workspace / Cloud Identity SSO Button */}
              <button
                type="button"
                onClick={loginWithGoogle}
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-850 text-white border border-slate-700 font-semibold text-xs transition-all flex items-center justify-between group shadow-md"
              >
                <div className="flex items-center gap-3">
                  {/* Official Google 'G' SVG Icon */}
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span className="font-bold">Sign in with Google Workspace</span>
                </div>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-black/40 text-slate-300 border border-white/10">
                  GCP Identity
                </span>
              </button>

              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-400 space-y-1">
                <p className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-brand-400" />
                  Automatic Domain-Based Enclave Routing:
                </p>
                <p>
                  Logging in with your company email automatically routes you to your organization's isolated boundary.
                </p>
              </div>
            </div>
          )}

          {/* TAB 2: Passwordless Magic Link */}
          {activeTab === 'magiclink' && (
            <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Defense Assessor or External Auditor Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => handleEmailChange(e.target.value)}
                    placeholder="auditor@defense-audit.org"
                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                  />
                </div>
                {detectedDomain && (
                  <p className="text-xs text-brand-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Auto-resolving enclave: {detectedDomain}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md shadow-brand-500/20 transition-all flex items-center justify-center gap-2"
              >
                <span>{loading ? 'Dispatching Link...' : 'Send Secure Passwordless Link'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <p className="text-xs text-slate-400 text-center">
                Temporary access code valid for 15 minutes. No passwords required.
              </p>
            </form>
          )}

          {/* TAB 3: Email & Password */}
          {activeTab === 'password' && (
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
                    ? 'Send Password Reset Link'
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
