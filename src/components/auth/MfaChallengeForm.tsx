import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const inputClass =
  'w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500';

interface MfaChallengeFormProps {
  /** Called once the person is signed in (after the recovery-code notice, when one was shown). */
  onDone?: () => void;
  /** Called after the sign-in was abandoned. */
  onCancel?: () => void;
}

/**
 * The second step of a sign-in: the 6-digit code from the authenticator app, or (instead) one recovery code. Errors from the
 * server are shown by the page through the auth context; nothing typed here is stored or logged.
 */
export const MfaChallengeForm: React.FC<MfaChallengeFormProps> = ({ onDone, onCancel }) => {
  const { completeMfa, finishMfa, cancelMfa, recoveryCodesRemaining, loading } = useAuth();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = useRecovery ? code.trim() : code.replace(/\s+/g, '');
    if (!value) return;
    if (!useRecovery && !/^\d{6}$/.test(value)) return;
    const outcome = await completeMfa(value, useRecovery);
    setCode('');
    if (outcome === 'ok') onDone?.();
  };

  // A recovery code was used: the sign-in waits until the person has seen how many are left
  if (recoveryCodesRemaining !== null) {
    return (
      <div className="space-y-3" role="status">
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs leading-relaxed">
          You signed in with a recovery code, and it cannot be used again.{' '}
          {recoveryCodesRemaining === 0
            ? 'You have no recovery codes left.'
            : `You have ${recoveryCodesRemaining} recovery code${recoveryCodesRemaining === 1 ? '' : 's'} left.`}{' '}
          Generate a new set from Account settings after you sign in.
        </div>
        <button
          type="button"
          onClick={async () => {
            await finishMfa();
            onDone?.();
          }}
          className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Two-step verification">
      <div className="flex items-start gap-2 text-xs text-slate-300 leading-relaxed">
        <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          {useRecovery
            ? 'Enter one of your recovery codes. Each code works once.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </span>
      </div>
      <div>
        <label htmlFor="mfa-challenge-code" className="block text-xs font-semibold text-slate-300 mb-1">
          {useRecovery ? 'Recovery code' : 'Authentication code'}
        </label>
        {useRecovery ? (
          <input
            id="mfa-challenge-code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={24}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="XXXXX-XXXXX"
            className={`${inputClass} font-mono uppercase tracking-widest`}
          />
        ) : (
          <input
            id="mfa-challenge-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="123456"
            className={`${inputClass} font-mono tracking-widest`}
          />
        )}
      </div>
      <button
        type="submit"
        disabled={loading || !code.trim()}
        className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all"
      >
        {loading ? 'Verifying…' : 'Verify'}
      </button>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => {
            setUseRecovery(v => !v);
            setCode('');
          }}
          className="text-brand-400 hover:text-brand-300"
        >
          {useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
        </button>
        <button
          type="button"
          onClick={() => {
            cancelMfa();
            onCancel?.();
          }}
          className="text-slate-400 hover:text-slate-200"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
