import React, { useEffect, useId, useState } from 'react';
import { RotateCw, ShieldAlert } from 'lucide-react';
import { ApiClient, ApiError } from '../../services/apiClient';
import type { PlatformSystemUseNotice } from '../../services/apiClient';
import { useAuth } from '../../context/AuthContext';
import { ErrorNotice } from '../common/ErrorNotice';
import { DEFAULT_SYSTEM_USE_NOTICE, SYSTEM_USE_NOTICE_MAX, normalizeNoticeText, validateNoticeDraft } from '../../data/systemUseNotice';

const LOAD_ERROR = 'The system use notice could not be loaded. Check the connection to the server and try again.';
const FORBIDDEN_TEXT = 'Only platform administrators can change the notice.';

/**
 * The editor for the system use notification shown before sign-in (issue #256), for platform administrators. One notice for the whole
 * installation. Saving needs a fresh code from the administrator's authenticator app, like the other platform-administrator actions.
 * The text is shown as plain text and is never logged.
 */
export const SystemUseNoticeSection: React.FC = () => {
  const { mfaEnrolled } = useAuth();
  const titleId = useId();
  const enabledId = useId();
  const textId = useId();
  const countId = useId();
  const codeId = useId();
  const codeHelpId = useId();
  const [saved, setSaved] = useState<PlatformSystemUseNotice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    ApiClient.getPlatformSystemUseNotice().then(
      (n) => {
        if (cancelled) return;
        setSaved(n);
        setEnabled(n.enabled);
        setDraft(n.text);
        setForbidden(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setLoadError(LOAD_ERROR);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const maxLength = saved?.maxLength ?? SYSTEM_USE_NOTICE_MAX;
  const defaultText = saved?.defaultText ?? DEFAULT_SYSTEM_USE_NOTICE;
  const validationError = saved ? validateNoticeDraft(enabled, draft, maxLength) : null;
  const changed = saved !== null && (enabled !== saved.enabled || normalizeNoticeText(draft) !== normalizeNoticeText(saved.text));
  const codeReady = /^\d{6}$/.test(code);

  const discard = () => {
    if (!saved) return;
    setEnabled(saved.enabled);
    setDraft(saved.text);
    setSaveError(null);
    setNotice('Changes discarded.');
  };

  const save = async () => {
    if (!saved || busy || validationError || !changed) return;
    if (!codeReady) {
      setSaveError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setSaveError(null);
    setNotice('');
    try {
      const next = await ApiClient.updatePlatformSystemUseNotice({ enabled, text: draft, code });
      setSaved(next);
      setEnabled(next.enabled);
      setDraft(next.text);
      setNotice('Saved. The new notice is shown at the next sign-in.');
    } catch (err: unknown) {
      const reason = err instanceof ApiError ? err.reason : undefined;
      if (reason === 'invalid_code') setSaveError('That code is not correct or was already used. Wait for the next code in your authenticator app and try again.');
      else if (reason === 'mfa_not_enrolled') setSaveError('Set up two-step verification on your own account before you change the notice.');
      else if (reason === 'code_required') setSaveError('Enter the 6-digit code from your authenticator app.');
      else setSaveError('The notice could not be saved. Check the text and try again.');
    } finally {
      setBusy(false);
      setCode('');
    }
  };

  return (
    <section aria-labelledby={titleId} className="stitch-card p-6 space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-base font-bold text-white flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <span>System use notice</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Shown before the sign-in form. People must acknowledge it to reach the form; the acknowledgement is recorded with their sign-in.
          </p>
        </div>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
          <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>
      <p role="status" aria-live="polite" className="text-xs text-emerald-300">{notice}</p>
      <ErrorNotice message={loadError} />
      {forbidden && <p className="text-xs text-slate-400">{FORBIDDEN_TEXT}</p>}
      {!saved && !loadError && !forbidden && <p role="status" className="text-xs text-slate-400">Loading the notice…</p>}
      {saved && (
        <div className="space-y-3">
          <fieldset disabled={busy} className="space-y-3">
            <legend className="sr-only">System use notice settings</legend>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={enabledId}
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setNotice('');
                }}
                className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              />
              <label htmlFor={enabledId} className="text-xs font-semibold text-slate-300">Show the notice before sign-in</label>
            </div>
            {!enabled && <p className="text-xs text-amber-300">With the notice off, people reach the sign-in form directly.</p>}
            <div>
              <label htmlFor={textId} className="block text-xs font-semibold text-slate-300 mb-1">Notice text</label>
              <textarea
                id={textId}
                rows={12}
                maxLength={maxLength}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setNotice('');
                }}
                aria-describedby={countId}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none leading-relaxed font-mono"
              />
              <p id={countId} className="text-xs text-slate-400">
                {draft.length} of {maxLength} characters{normalizeNoticeText(draft) === normalizeNoticeText(defaultText) ? ' · default text' : ''}
              </p>
            </div>
          </fieldset>
          <div>
            <h3 className="text-xs font-bold text-slate-300 mb-1">Preview</h3>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-amber-500/30 bg-slate-900/80 p-3.5 text-xs leading-relaxed text-slate-200 whitespace-pre-wrap break-words">
              {draft || defaultText}
            </div>
          </div>
          {mfaEnrolled ? (
            <div>
              <label htmlFor={codeId} className="block text-xs font-semibold text-slate-300 mb-1">Code from your authenticator app</label>
              <input
                id={codeId}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                disabled={busy}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                aria-describedby={codeHelpId}
                className="w-full sm:w-48 px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white font-mono tracking-widest focus:outline-none focus:border-brand-500"
              />
              <p id={codeHelpId} className="mt-1 text-xs text-slate-400">Saving needs a fresh code. A code works once.</p>
            </div>
          ) : (
            <p className="text-xs text-amber-300 leading-relaxed">Set up two-step verification on your own account before you change the notice.</p>
          )}
          <ErrorNotice message={saveError ?? (changed ? validationError : null)} />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(defaultText);
                setNotice('Default text restored in the editor. Save to apply.');
              }}
              className="btn-base btn-secondary px-3 py-1.5 text-xs"
            >
              Reset to default
            </button>
            <button type="button" disabled={busy || !changed} onClick={discard} className="btn-base btn-secondary px-3 py-1.5 text-xs">
              Discard changes
            </button>
            <button
              type="button"
              disabled={!changed || !!validationError || busy || !mfaEnrolled || !codeReady}
              onClick={() => void save()}
              className="btn-base btn-primary px-3 py-1.5 text-xs"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default SystemUseNoticeSection;
