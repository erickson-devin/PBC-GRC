import React, { useEffect, useRef, useState } from 'react';
import { Copy, ShieldCheck } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import type { MfaEnrolmentStart } from '../../services/apiClient';
import { copyToClipboard } from '../../utils/clipboard';
import { errorMessage } from '../../utils/errors';

const inputClass =
  'w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500';

/** The secret in groups of four, easier to read aloud and to type: "ABCD EFGH ...". */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

interface RecoveryCodesNoticeProps {
  codes: string[];
  onDone: () => void;
  doneLabel?: string;
}

/**
 * The one-time recovery codes. They are shown once; Continue stays disabled until the person confirms they saved them.
 * Nothing here is written to browser storage.
 */
export const RecoveryCodesNotice: React.FC<RecoveryCodesNoticeProps> = ({ codes, onDone, doneLabel = 'Continue' }) => {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyAll = async () => {
    try {
      await copyToClipboard(codes.join('\n'));
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError('Could not copy automatically. Select the codes and copy them manually.');
    }
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs leading-relaxed">
        <strong>Save these recovery codes now.</strong> Each one works once if you lose access to your authenticator app. They are shown only
        this one time and cannot be displayed again.
      </div>
      <ErrorNotice message={copyError} />
      <ul className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-slate-900 border border-slate-800 font-mono text-sm text-slate-100 select-all" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <button type="button" onClick={copyAll} className="btn-base btn-secondary px-3 py-1.5 text-xs">
        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
        {copied ? 'Copied' : 'Copy all codes'}
      </button>
      <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} className="mt-0.5" />
        <span>I have saved these codes</span>
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onDone}
        className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all"
      >
        {doneLabel}
      </button>
    </div>
  );
};

interface MfaEnrolmentPanelProps {
  /** Creates the pending secret (called once when the panel opens). */
  onStart: () => Promise<MfaEnrolmentStart>;
  /** Confirms the authenticator with a code and resolves the one-time recovery codes. */
  onConfirm: (code: string) => Promise<string[]>;
  /** Called after the person confirmed they saved the recovery codes. */
  onDone: () => void | Promise<void>;
  onCancel?: () => void;
  cancelLabel?: string;
}

/**
 * Sets up an authenticator app (TOTP): shows the setup link and the key as selectable text (there is no QR code), asks for a code
 * to prove it works, then shows the recovery codes once. The secret, the link and the codes live in this component's state only,
 * are dropped as soon as they are no longer needed, and are never stored or logged.
 */
export const MfaEnrolmentPanel: React.FC<MfaEnrolmentPanelProps> = ({ onStart, onConfirm, onDone, onCancel, cancelLabel = 'Cancel' }) => {
  const [phase, setPhase] = useState<'loading' | 'setup' | 'codes'>('loading');
  const [info, setInfo] = useState<MfaEnrolmentStart | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'uri' | 'secret' | null>(null);
  const started = useRef(false);

  const start = async () => {
    setError(null);
    setPhase('loading');
    try {
      setInfo(await onStart());
      setPhase('setup');
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not start the setup.');
      setPhase('setup');
    }
  };

  useEffect(() => {
    if (started.current) return; // one secret per opening, even when effects run twice
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (which: 'uri' | 'secret', text: string) => {
    try {
      await copyToClipboard(text);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000);
    } catch {
      setError('Could not copy automatically. Select the text and copy it manually.');
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError('Enter the 6-digit code shown in your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const codes = await onConfirm(digits);
      setInfo(null); // the secret is no longer needed
      setCode('');
      setRecoveryCodes(codes);
      setPhase('codes');
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The code could not be checked.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'codes') {
    return (
      <RecoveryCodesNotice
        codes={recoveryCodes}
        onDone={() => {
          setRecoveryCodes([]);
          void onDone();
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-xs text-slate-300 leading-relaxed">
        <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          Set up two-step verification. Any authenticator app that supports time-based one-time codes (TOTP) works: add a new account
          in the app by entering the key below (or pasting the setup link), then enter the 6-digit code it shows.
        </span>
      </div>

      <ErrorNotice message={error} />

      {phase === 'loading' && <p className="text-xs text-slate-400" role="status">Preparing your key…</p>}

      {phase === 'setup' && !info && (
        <button type="button" onClick={() => void start()} className="btn-base btn-secondary px-3 py-1.5 text-xs">Try again</button>
      )}

      {phase === 'setup' && info && (
        <form onSubmit={confirm} className="space-y-3">
          <div>
            <span className="block text-xs font-semibold text-slate-300 mb-1">Key (enter it in your app)</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 text-sm font-mono tracking-wider bg-slate-900 border border-slate-700 rounded-xl text-cyan-200 select-all break-all" aria-label="Authenticator key">
                {groupSecret(info.secret)}
              </code>
              <button type="button" onClick={() => void copy('secret', info.secret)} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                {copied === 'secret' ? 'Copied' : 'Copy key'}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Account {info.accountName}, {info.digits} digits, new code every {info.period} seconds.
            </p>
          </div>

          <div>
            <label htmlFor="mfa-enrol-uri" className="block text-xs font-semibold text-slate-300 mb-1">Setup link (for apps that accept one)</label>
            <div className="flex items-center gap-2">
              <input
                id="mfa-enrol-uri"
                readOnly
                value={info.otpauthUri}
                onFocus={e => e.currentTarget.select()}
                className={`${inputClass} font-mono`}
              />
              <button type="button" onClick={() => void copy('uri', info.otpauthUri)} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                {copied === 'uri' ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="mfa-enrol-code" className="block text-xs font-semibold text-slate-300 mb-1">Code from the app</label>
            <input
              id="mfa-enrol-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="123456"
              className={`${inputClass} font-mono tracking-widest`}
            />
          </div>

          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all"
          >
            {busy ? 'Checking…' : 'Confirm and continue'}
          </button>
        </form>
      )}

      {onCancel && (
        <button type="button" onClick={onCancel} className="w-full text-center text-xs text-slate-400 hover:text-slate-200">
          {cancelLabel}
        </button>
      )}
    </div>
  );
};
