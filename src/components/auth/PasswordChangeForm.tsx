import React, { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../utils/errors';

// Must equal MIN_PASSWORD_LENGTH in server/auth/localAuth.ts
const MIN_PASSWORD_LENGTH = 12;

const inputClass =
  'w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500';
const labelClass = 'block text-xs font-semibold text-slate-300 mb-1';

interface PasswordChangeFormProps {
  /** Called after the password was changed (the session is already replaced by then). */
  onChanged?: () => void;
  onCancel?: () => void;
  /** Shown above the fields. */
  intro?: string;
}

/**
 * Changes the signed-in account's password: the current password, a new one (at least 12 characters) twice, and a code from the
 * authenticator app when the account has one. Used for the forced change after an administrator reset and from Account settings.
 */
export const PasswordChangeForm: React.FC<PasswordChangeFormProps> = ({ onChanged, onCancel, intro }) => {
  const { changePassword, mfaEnrolled } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    if (next === current) {
      setError('The new password must be different from the current one.');
      return;
    }
    const digits = code.replace(/\s+/g, '');
    if (mfaEnrolled && !/^\d{6}$/.test(digits)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next, mfaEnrolled ? digits : undefined);
      setCurrent('');
      setNext('');
      setConfirm('');
      setCode('');
      onChanged?.();
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The password could not be changed.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Change password">
      {intro && <p className="text-xs text-slate-400 leading-relaxed">{intro}</p>}
      <ErrorNotice message={error} />
      <div>
        <label htmlFor="pw-change-current" className={labelClass}>Current password</label>
        <input id="pw-change-current" type="password" required autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label htmlFor="pw-change-new" className={labelClass}>New password (at least {MIN_PASSWORD_LENGTH} characters)</label>
        <input id="pw-change-new" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label htmlFor="pw-change-confirm" className={labelClass}>Confirm new password</label>
        <input id="pw-change-confirm" type="password" required autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} className={inputClass} />
      </div>
      {mfaEnrolled && (
        <div>
          <label htmlFor="pw-change-code" className={labelClass}>Code from your authenticator app</label>
          <input id="pw-change-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} placeholder="123456" className={`${inputClass} font-mono tracking-widest`} />
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-colors">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || !current || !next || !confirm} className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all">
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  );
};

/**
 * Full-screen replacement for the app while the account must change its password (an administrator reset it, or it was created
 * from the command line). Nothing else works until this succeeds, so the only other action is signing out.
 */
export const PasswordChangeScreen: React.FC = () => {
  const { logout, currentUser } = useAuth();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-brand-500 selection:text-white">
      <header className="px-6 py-4 border-b border-slate-800/80 bg-slate-950/80 flex items-center justify-between">
        <div className="text-left flex items-center gap-2.5">
          <BrandLogo size="sm" />
          <span className="font-extrabold text-sm text-white tracking-tight">Event Horizon: Singularity</span>
        </div>
        <button type="button" onClick={() => void logout()} className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white">
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" /> Sign out
        </button>
      </header>
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl shadow-slate-950">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 space-y-4">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-xs font-bold uppercase tracking-widest text-amber-300">
                <KeyRound className="w-3 h-3" aria-hidden="true" />
                Password change required
              </div>
              <h1 className="text-xl font-black text-white tracking-tight">Choose a new password</h1>
              <p className="text-xs text-slate-400">
                {currentUser.email} is signed in with a temporary password. Set your own to continue.
              </p>
            </div>
            <PasswordChangeForm />
          </div>
        </div>
      </main>
      <footer className="px-6 py-4 text-center text-xs text-slate-400 border-t border-slate-900">
        © {new Date().getFullYear()} Pitch Black Cyber LLC
      </footer>
    </div>
  );
};
