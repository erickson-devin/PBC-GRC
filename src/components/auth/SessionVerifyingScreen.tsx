import React from 'react';
import { Loader2, Lock, ShieldCheck } from 'lucide-react';

/**
 * Shown after a reload while the server confirms the stored session (the first tenant sync). Nothing from the cache is
 * rendered until it answers, so a session the server already ended never flashes the workspace. It gives way to the app,
 * the sign-in page, or (after SESSION_VERIFY_TIMEOUT_MS) the app with an offline notice.
 */
export const SessionVerifyingScreen: React.FC = () => (
  <main aria-busy="true" className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center text-slate-100">
    <div className="relative mb-6" aria-hidden="true">
      <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center shadow-xl shadow-brand-500/25 ring-1 ring-white/20 animate-pulse motion-reduce:animate-none">
        <ShieldCheck className="w-8 h-8 text-white" />
      </div>
      <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center">
        <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin motion-reduce:animate-none" />
      </div>
    </div>
    <div role="status" aria-live="polite" className="space-y-2 max-w-sm">
      <p className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-mono uppercase tracking-wider text-brand-300">
        <Lock className="w-3 h-3 text-brand-400" aria-hidden="true" />
        Verifying your session
      </p>
      <h1 className="text-lg font-bold text-white tracking-tight">Checking your session with the server…</h1>
      <p className="text-xs text-slate-400">
        Your workspace opens as soon as the server confirms you are still signed in. If it does not answer within a few seconds, the data saved in this browser opens instead.
      </p>
    </div>
  </main>
);

export default SessionVerifyingScreen;
