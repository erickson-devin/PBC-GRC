import React, { useEffect } from 'react';
import { ShieldCheck, Lock, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  onRedirectToLogin?: (targetUrl: string) => void;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  onRedirectToLogin,
}) => {
  const { isAuthenticated, loading, openAuthModal } = useAuth();

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      const currentPath = typeof window !== 'undefined'
        ? window.location.pathname + window.location.search + window.location.hash
        : '/app';

      if (onRedirectToLogin) {
        onRedirectToLogin(currentPath);
      } else {
        openAuthModal('signin', currentPath);
      }
    }
  }, [loading, isAuthenticated, onRedirectToLogin, openAuthModal]);

  // Loading screen while verifying credentials
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center text-slate-100">
        <div className="relative mb-6">
          <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center shadow-xl shadow-brand-500/25 ring-1 ring-white/20 animate-pulse motion-reduce:animate-none">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center">
            <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin motion-reduce:animate-none" />
          </div>
        </div>

        <div className="space-y-2 max-w-sm">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-mono uppercase tracking-wider text-brand-300">
            <Lock className="w-3 h-3 text-brand-400" />
            Verifying Identity Credentials
          </div>
          <h2 className="text-lg font-bold text-white tracking-tight">
            Connecting to Defense Enclave...
          </h2>
          <p className="text-xs text-slate-400">
            Validating Google Cloud Identity Platform session and tenant boundary permissions.
          </p>
        </div>
      </div>
    );
  }

  // If not authenticated, render placeholder while redirecting
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center text-slate-100">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-400 flex items-center justify-center mb-4">
          <Lock className="w-6 h-6" />
        </div>
        <h3 className="text-base font-bold text-white mb-1">
          Authentication Required
        </h3>
        <p className="text-xs text-slate-400 mb-4 max-w-xs">
          Please sign in with your enterprise credentials to access the CMMC assessment enclave.
        </p>
        <button
          onClick={() => openAuthModal('signin', '/app')}
          className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
        >
          Sign In to Enclave
        </button>
      </div>
    );
  }

  return <>{children}</>;
};
