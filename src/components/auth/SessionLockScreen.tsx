import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Lock, LogOut } from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { useAuth } from '../../context/AuthContext';
import { collectUnsavedText, rescueUnsavedText } from '../../services/unsavedText';
import { MfaChallengeForm } from './MfaChallengeForm';
import { MfaEnrolmentPanel } from './MfaEnrolmentPanel';
import { ENROL_REQUIRED_TEXT, IDLE_WARNING_ANNOUNCEMENT, formatCountdown, lockHeading, lockReasonText, signOutWarning } from '../../utils/sessionLock';

// Escape must not dismiss the lock: a no-op handler keeps this overlay on top of the global Escape stack
const ignoreEscape = () => {};
// Fully opaque and pattern-hiding: a solid background, no blur, no fade
const LOCK_OVERLAY_CLASS = 'fixed inset-0 z-[200] flex items-start sm:items-center justify-center p-4 sm:p-6 bg-slate-950 overflow-y-auto';
const inputClass =
  'w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500';

/** Everything on the page except the lock layers becomes inert, hidden from assistive technology and from printing. */
function useHidePageBehind(): void {
  useLayoutEffect(() => {
    const changed: Array<{ el: Element; hadInert: boolean; ariaHidden: string | null; addedNoPrint: boolean }> = [];
    const hide = (el: Element) => {
      if (el.hasAttribute('data-session-lock') || el.tagName === 'SCRIPT' || changed.some((c) => c.el === el)) return;
      changed.push({ el, hadInert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden'), addedNoPrint: !el.classList.contains('no-print') });
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      el.classList.add('no-print');
    };
    Array.from(document.body.children).forEach(hide);
    const observer = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => { if (n instanceof Element) hide(n); })));
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const c of changed) {
        if (!c.hadInert) c.el.removeAttribute('inert');
        if (c.ariaHidden === null) c.el.removeAttribute('aria-hidden');
        else c.el.setAttribute('aria-hidden', c.ariaHidden);
        if (c.addedNoPrint) c.el.classList.remove('no-print');
      }
    };
  }, []);
}

/** The last minute before the idle lock. Stays mounted while signed in and unlocked so the live region exists before its text changes. */
export const IdleWarningBanner: React.FC<{ secondsLeft: number | null; onStay: () => void }> = ({ secondsLeft, onStay }) => {
  const titleId = useId();
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{secondsLeft !== null ? IDLE_WARNING_ANNOUNCEMENT : ''}</p>
      {secondsLeft !== null && createPortal(
        <section aria-labelledby={titleId} className="fixed bottom-4 right-4 z-[70] w-[min(22rem,calc(100vw-2rem))] no-print animate-fadeIn">
          <div className="p-4 rounded-2xl bg-slate-900 border border-amber-500/40 shadow-2xl space-y-3 text-xs">
            <div className="flex items-start gap-2.5">
              <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <h2 id={titleId} className="font-bold text-white">Still there?</h2>
                <p aria-hidden="true" className="text-slate-300 leading-relaxed">This session locks in <span className="font-mono font-bold text-amber-300 tabular-nums">{formatCountdown(secondsLeft)}</span> without activity.</p>
              </div>
            </div>
            <button type="button" onClick={onStay} className="w-full py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">Stay signed in</button>
          </div>
        </section>, document.body)}
    </>
  );
};

/** The opaque lock screen (#163, #39): password, then a code or an authenticator set-up when the account needs one. Nothing typed here is stored or logged. */
export const SessionLockScreen: React.FC = () => {
  const { currentUser, lock, mfaChallenge, unlockWithPassword, startEnrolment, confirmEnrolment, finishMfa, cancelMfa, authError, clearAuthError, logout } = useAuth();
  useHidePageBehind();
  const reason = lock?.reason ?? 'idle';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unsaved, setUnsaved] = useState<Array<{ key: string; label: string }>>([]);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertId = useId();
  const emailId = useId();
  const passwordId = useId();
  const descId = useId();
  const confirmDescId = useId();
  const heading = mfaChallenge?.stage === 'enrol' ? 'Set Up Two-Step Verification' : mfaChallenge?.stage === 'verify' ? 'Two-Step Verification' : lockHeading(reason);
  const status = busy ? 'Checking your password…' : mfaChallenge?.stage === 'verify' ? 'Password accepted. Enter your two-step verification code.' : mfaChallenge?.stage === 'enrol' ? 'Password accepted. Set up two-step verification to continue.' : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    const outcome = await unlockWithPassword(password);
    setBusy(false);
    if (outcome !== 'offline') setPassword('');
    if (outcome === 'failed' || outcome === 'offline') passwordRef.current?.focus();
  };
  const openSignOut = () => {
    setUnsaved(collectUnsavedText().map(({ key, label }) => ({ key, label })));
    setConfirmOpen(true);
  };
  const signOut = async () => {
    setConfirmOpen(false);
    clearAuthError();
    rescueUnsavedText(currentUser.id);
    await logout();
  };

  return (
    <>
      <DialogOverlay onClose={ignoreEscape} data-session-lock="" aria-describedby={descId} className={LOCK_OVERLAY_CLASS}>
        <div className="w-full max-w-md my-auto p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
            <div className="text-center space-y-2 mb-6">
              <div className="flex justify-center mb-2"><BrandLogo size="lg" showText={false} /></div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-xs font-bold uppercase tracking-widest text-cyan-300"><Lock className="w-3 h-3 text-cyan-400" aria-hidden="true" />Session locked</div>
              <DialogTitle as="h1" className="text-2xl font-black text-white tracking-tight">{heading}</DialogTitle>
              <p id={descId} className="text-xs text-slate-300 leading-relaxed">{lockReasonText(reason)}</p>
            </div>
            <p role="status" aria-live="polite" className="sr-only">{status}</p>
            {authError && (
              <div role="alert" id={alertId} className="mb-4 p-3 rounded-xl bg-rose-950/50 border border-rose-800/60 text-rose-300 text-xs flex items-center justify-between gap-3">
                <span>{authError}</span>
                <button type="button" onClick={() => { clearAuthError(); passwordRef.current?.focus(); }} aria-label="Dismiss this message" className="shrink-0 rounded text-rose-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"><span aria-hidden="true">✕</span></button>
              </div>
            )}
            {mfaChallenge?.stage === 'verify' && <MfaChallengeForm />}
            {mfaChallenge?.stage === 'enrol' && (
              <div className="space-y-3">
                {reason === 'mfa_required' && <p className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs leading-relaxed">{ENROL_REQUIRED_TEXT}</p>}
                <MfaEnrolmentPanel onStart={startEnrolment} onConfirm={confirmEnrolment} onDone={finishMfa} onCancel={cancelMfa} cancelLabel="Back to password" />
              </div>
            )}
            {!mfaChallenge && (
              <form onSubmit={submit} className="space-y-3" aria-busy={busy}>
                <div>
                  <label htmlFor={emailId} className="block text-xs font-semibold text-slate-300 mb-1">Signed in as</label>
                  <input id={emailId} type="email" readOnly autoComplete="username" value={currentUser.email} className="w-full px-3 py-2 text-xs bg-slate-900/60 border border-slate-800 rounded-xl text-slate-300 font-mono focus:outline-none focus:border-brand-500" />
                </div>
                <div>
                  <label htmlFor={passwordId} className="block text-xs font-semibold text-slate-300 mb-1">Password</label>
                  <input id={passwordId} ref={passwordRef} type="password" required autoFocus autoComplete="current-password" readOnly={busy} aria-describedby={authError ? alertId : undefined} value={password} onChange={(e) => { setPassword(e.target.value); if (authError) clearAuthError(); }} placeholder="••••••••••••" className={inputClass} />
                </div>
                <button type="submit" disabled={busy || !password} className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all">{busy ? 'Unlocking…' : 'Unlock'}</button>
              </form>
            )}
            <button type="button" onClick={openSignOut} disabled={busy} className="mt-4 w-full text-center text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 disabled:opacity-50">Sign out instead</button>
          </div>
        </div>
      </DialogOverlay>
      {confirmOpen && (
        <DialogOverlay role="alertdialog" data-session-lock="" onClose={() => setConfirmOpen(false)} aria-describedby={confirmDescId} className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-slate-950/80 animate-fadeIn">
          <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <DialogTitle as="h2" className="text-sm font-bold text-white flex items-center gap-2"><LogOut className="w-4 h-4 text-rose-400" aria-hidden="true" /><span>Sign out instead?</span></DialogTitle>
            <div id={confirmDescId} className="space-y-3 text-xs text-slate-300 leading-relaxed">
              <p>{signOutWarning(unsaved.length)}</p>
              {unsaved.length > 0 && <ul className="max-h-32 overflow-y-auto list-disc pl-5 font-mono text-slate-400">{unsaved.map((e) => <li key={e.key} className="break-all">{e.label}</li>)}</ul>}
            </div>
            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button type="button" autoFocus onClick={() => setConfirmOpen(false)} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">Stay on this screen</button>
              <button type="button" onClick={() => void signOut()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors bg-rose-950/40 text-rose-300 border-rose-800/50 hover:bg-rose-900/50"><LogOut className="w-3.5 h-3.5" aria-hidden="true" />Sign out</button>
            </div>
          </div>
        </DialogOverlay>
      )}
    </>
  );
};

export default SessionLockScreen;
