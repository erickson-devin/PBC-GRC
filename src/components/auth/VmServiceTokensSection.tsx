import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { KeyRound, Copy, Check, AlertTriangle, CheckCircle2, Clock, Ban } from 'lucide-react';
import { ApiClient } from '../../services/apiClient';
import { ErrorNotice } from '../common/ErrorNotice';
import { copyText } from '../../utils/clipboard';
import {
  VM_TOKENS_COPY, VM_TOKEN_DEFAULT_DAYS, VM_TOKEN_MAX_DAYS, VM_TOKEN_MIN_DAYS, VM_TOKEN_NAME_MAX,
  activeTokenCaption, countActiveTokens, createdByLabel, newTokenFor, normalizeTokenName, parseExpiryDays, revokeConfirmText,
  revokedMessage, tokenNameError, tokenPrefixLabel, tokenState, tokenStateLabel, vmTokenErrorMessage, vmTokenLoadErrorMessage,
} from '../../data/telemetry/vmTokensView';
import type { VmServiceToken } from '../../types/vm';

/**
 * VM service tokens (#190): list, create (name and 1-730 days), one-time copy and revoke with confirmation, for a Tenant Owner or MSP Admin of a
 * server-backed organization. The new token value is held in state until the person confirms they stored it: it is never written to the console,
 * the audit ledger, storage, history or a URL, and it appears only in the read-only field and the copy call. Names are rendered as text.
 */
interface VmServiceTokensSectionProps {
  tenantId: string;
  tenantName: string;
}

const RETRY_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700';
const TABLE_HEAD_CLASS = 'border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold';
const INPUT_CLASS = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 aria-[invalid=true]:border-rose-500/70';
const LABEL_CLASS = 'block text-xs font-semibold text-slate-300 mb-1';
const STATE_STYLE = {
  active: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  expired: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: Clock },
  revoked: { cls: 'bg-slate-800 text-slate-300 border-slate-700', Icon: Ban },
} as const;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

type ListState = { status: 'loading' | 'ready' | 'error'; tokens: VmServiceToken[]; message: string | null };

export const VmServiceTokensSection: React.FC<VmServiceTokensSectionProps> = ({ tenantId }) => {
  const [list, setList] = useState<ListState>({ status: 'loading', tokens: [], message: null });
  const [name, setName] = useState('');
  const [days, setDays] = useState(String(VM_TOKEN_DEFAULT_DAYS));
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; days?: string }>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const revokeRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const headingId = useId();
  const formHeadingId = useId();
  const nameId = useId();
  const daysId = useId();
  const oneTimeHeadingId = useId();
  const warningId = useId();
  const baseId = useId();

  const focusLater = (target: () => HTMLElement | null | undefined) => {
    requestAnimationFrame(() => target()?.focus());
  };

  // The parent remounts this section (key) when the organization changes, so there is no tenant race to guard.
  const load = useCallback(async () => {
    setList((s) => ({ ...s, status: 'loading', message: null }));
    try {
      const tokens = await ApiClient.listVmTokens(tenantId);
      setList({ status: 'ready', tokens, message: null });
    } catch (err) {
      setList((s) => ({ ...s, status: 'error', message: vmTokenLoadErrorMessage(err) }));
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { if (newToken) tokenInputRef.current?.focus(); }, [newToken]);

  useEffect(() => { if (confirmId) confirmRef.current?.focus(); }, [confirmId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    const nErr = tokenNameError(name);
    const d = parseExpiryDays(days);
    if (nErr || d === null) {
      setFieldErrors({ name: nErr ?? undefined, days: d === null ? VM_TOKENS_COPY.daysError : undefined });
      if (nErr) nameRef.current?.focus();
      else document.getElementById(daysId)?.focus();
      return;
    }
    setFieldErrors({});
    setNotice(null);
    setCreating(true);
    setCreateError(null);
    try {
      const res = await ApiClient.createVmToken(tenantId, { name: normalizeTokenName(name), expiresInDays: d });
      setList((s) => ({ ...s, tokens: [res.record, ...s.tokens] }));
      setNewToken({ name: res.record.name, token: res.token });
      setCopyState('idle');
    } catch (err) {
      setCreateError(vmTokenErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const onCopy = () => {
    if (!newToken) return;
    const value = newToken.token;
    void copyText(value).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed');
      if (!ok) tokenInputRef.current?.focus();
    });
  };

  const onDone = () => {
    setNewToken(null);
    setCopyState('idle');
    setName('');
    setDays(String(VM_TOKEN_DEFAULT_DAYS));
    setFieldErrors({});
    focusLater(() => nameRef.current);
  };

  const cancelRevoke = (id: string) => {
    setConfirmId(null);
    setRevokeError(null);
    focusLater(() => revokeRefs.current.get(id));
  };

  const confirmRevoke = async (t: VmServiceToken) => {
    setNotice(null);
    setRevokingId(t.id);
    try {
      const record = await ApiClient.revokeVmToken(tenantId, t.id);
      setList((s) => ({ ...s, tokens: s.tokens.map((x) => (x.id === t.id ? record : x)) }));
      setConfirmId(null);
      setRevokeError(null);
      setAnnouncement(revokedMessage(t.name));
      focusLater(() => rowRefs.current.get(t.id));
    } catch (err) {
      if ((err as { status?: unknown } | null)?.status === 404) {
        setConfirmId(null);
        setRevokeError(null);
        setNotice(VM_TOKENS_COPY.notFound);
        await load();
        focusLater(() => headingRef.current);
      } else {
        setRevokeError(vmTokenErrorMessage(err));
      }
    } finally {
      setRevokingId(null);
    }
  };

  const now = Date.now();

  return (
    <section aria-labelledby={headingId} className="space-y-3 text-xs pt-4 border-t border-slate-800">
      <div>
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-bold text-white flex items-center gap-1.5 focus:outline-none">
          <KeyRound className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />{VM_TOKENS_COPY.heading}
        </h3>
        <p className="text-slate-400 leading-relaxed mt-1">{VM_TOKENS_COPY.intro}</p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <ErrorNotice message={notice} />

      {newToken ? (
        <div
          role="region"
          aria-labelledby={oneTimeHeadingId}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doneRef.current?.focus(); } }}
          className="rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-950/20 p-3 space-y-3"
        >
          <h4 id={oneTimeHeadingId} className="text-xs font-bold text-amber-200 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />{VM_TOKENS_COPY.oneTimeHeading}
          </h4>
          <p className="text-slate-300">{newTokenFor(newToken.name)}</p>
          <p id={warningId} className="text-amber-100 leading-relaxed">{VM_TOKENS_COPY.oneTimeWarning}</p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              ref={tokenInputRef}
              type="text"
              readOnly
              value={newToken.token}
              aria-label={VM_TOKENS_COPY.tokenFieldLabel}
              aria-describedby={warningId}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 bg-slate-950 border border-amber-500/40 rounded-xl px-3 py-2 text-xs font-mono text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            />
            <button
              type="button"
              onClick={onCopy}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 shrink-0"
            >
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              <span>{copyState === 'copied' ? VM_TOKENS_COPY.copiedShort : VM_TOKENS_COPY.copy}</span>
            </button>
          </div>
          <p role="status" aria-live="polite" className={copyState === 'failed' ? 'text-amber-200' : 'text-slate-400'}>
            {copyState === 'copied' ? VM_TOKENS_COPY.copied : copyState === 'failed' ? VM_TOKENS_COPY.copyFailed : ''}
          </p>
          <div className="flex justify-end">
            <button
              ref={doneRef}
              type="button"
              onClick={onDone}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all"
            >
              {VM_TOKENS_COPY.done}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate aria-labelledby={formHeadingId} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 space-y-3">
          <h4 id={formHeadingId} className="text-xs font-semibold text-slate-300">{VM_TOKENS_COPY.formHeading}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem] gap-3">
            <div>
              <label htmlFor={nameId} className={LABEL_CLASS}>{VM_TOKENS_COPY.nameLabel}</label>
              <input
                id={nameId}
                ref={nameRef}
                type="text"
                required
                maxLength={VM_TOKEN_NAME_MAX}
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(e) => { setName(e.target.value); setFieldErrors((f) => ({ ...f, name: undefined })); }}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? `${nameId}-error ${nameId}-help` : `${nameId}-help`}
                className={INPUT_CLASS}
              />
              <p id={`${nameId}-help`} className="mt-1 text-slate-400">{VM_TOKENS_COPY.nameHelp}</p>
              {fieldErrors.name && <p id={`${nameId}-error`} className="mt-1 text-rose-300">{fieldErrors.name}</p>}
            </div>
            <div>
              <label htmlFor={daysId} className={LABEL_CLASS}>{VM_TOKENS_COPY.daysLabel}</label>
              <input
                id={daysId}
                type="number"
                inputMode="numeric"
                min={VM_TOKEN_MIN_DAYS}
                max={VM_TOKEN_MAX_DAYS}
                step={1}
                required
                value={days}
                onChange={(e) => { setDays(e.target.value); setFieldErrors((f) => ({ ...f, days: undefined })); }}
                aria-invalid={fieldErrors.days ? true : undefined}
                aria-describedby={fieldErrors.days ? `${daysId}-error ${daysId}-help` : `${daysId}-help`}
                className={INPUT_CLASS}
              />
              <p id={`${daysId}-help`} className="mt-1 text-slate-400">{VM_TOKENS_COPY.daysHelp}</p>
              {fieldErrors.days && <p id={`${daysId}-error`} className="mt-1 text-rose-300">{fieldErrors.days}</p>}
            </div>
          </div>
          <ErrorNotice message={createError} />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold text-xs shadow-md transition-all"
            >
              {creating ? VM_TOKENS_COPY.creating : VM_TOKENS_COPY.create}
            </button>
          </div>
        </form>
      )}

      {list.status === 'loading' && list.tokens.length === 0 && (
        <p role="status" className="text-slate-400">{VM_TOKENS_COPY.loading}</p>
      )}
      {list.status === 'error' && (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={list.message} className="flex-1" />
          <button type="button" onClick={() => void load()} className={RETRY_CLASS}>Retry</button>
        </div>
      )}
      {list.status === 'ready' && list.tokens.length === 0 && (
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 py-6 text-center text-slate-400">{VM_TOKENS_COPY.empty}</p>
      )}
      {list.tokens.length > 0 && (
        <>
          <p className="text-slate-400">{activeTokenCaption(countActiveTokens(list.tokens, now))}</p>
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table aria-labelledby={headingId} aria-busy={revokingId !== null || undefined} className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className={TABLE_HEAD_CLASS}>
                  <th scope="col" className="py-2.5 px-3">Token</th>
                  <th scope="col" className="py-2.5 px-3">Created</th>
                  <th scope="col" className="py-2.5 px-3">Expires</th>
                  <th scope="col" className="py-2.5 px-3">Last used</th>
                  <th scope="col" className="py-2.5 px-3">Status</th>
                  <th scope="col" className="py-2.5 px-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.tokens.map((t) => {
                  const st = tokenState(t, now);
                  const { cls, Icon } = STATE_STYLE[st];
                  return (
                    <React.Fragment key={t.id}>
                      <tr className={`align-top ${st === 'active' ? '' : 'text-slate-400'} hover:bg-slate-800/40 transition-colors`}>
                        <th
                          scope="row"
                          ref={(el) => { if (el) rowRefs.current.set(t.id, el); else rowRefs.current.delete(t.id); }}
                          tabIndex={-1}
                          className="py-3 px-3 font-normal focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                        >
                          <span className={`block font-semibold break-words ${st === 'active' ? 'text-white' : 'text-slate-300'}`}>{t.name}</span>
                          <span className="block font-mono text-slate-400">
                            <span className="sr-only">{VM_TOKENS_COPY.prefixSr} </span>{tokenPrefixLabel(t.tokenPrefix)} · {t.scopes.join(', ')}
                          </span>
                        </th>
                        <td className="py-3 px-3 text-slate-300">
                          <time dateTime={t.createdAt} className="whitespace-nowrap">{fmtDate(t.createdAt)}</time>
                          <span className="block text-slate-400 break-words">{createdByLabel(t.createdBy)}</span>
                        </td>
                        <td className="py-3 px-3 text-slate-300 whitespace-nowrap"><time dateTime={t.expiresAt}>{fmtDate(t.expiresAt)}</time></td>
                        <td className="py-3 px-3 text-slate-300 whitespace-nowrap">
                          {t.lastUsedAt ? <time dateTime={t.lastUsedAt}>{fmtDate(t.lastUsedAt)}</time> : VM_TOKENS_COPY.neverUsed}
                        </td>
                        <td className="py-3 px-3">
                          <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${cls}`}>
                            <Icon className="w-3 h-3" aria-hidden="true" />
                            <span>{tokenStateLabel(st)}</span>
                          </span>
                          {t.revokedAt && (
                            <span className="block mt-1 text-slate-400 whitespace-nowrap"><time dateTime={t.revokedAt}>{fmtDate(t.revokedAt)}</time></span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right">
                          {st === 'active' && (
                            <button
                              type="button"
                              ref={(el) => { if (el) revokeRefs.current.set(t.id, el); else revokeRefs.current.delete(t.id); }}
                              aria-expanded={confirmId === t.id}
                              aria-controls={`${baseId}-confirm-${t.id}`}
                              onClick={() => { setRevokeError(null); setConfirmId(t.id); }}
                              disabled={confirmId !== null || revokingId !== null}
                              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                              {VM_TOKENS_COPY.revoke}<span className="sr-only"> {t.name}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                      {confirmId === t.id && (
                        <tr id={`${baseId}-confirm-${t.id}`}>
                          <td colSpan={6} className="px-3 pb-3 bg-slate-950/40">
                            <div
                              role="group"
                              aria-labelledby={`${baseId}-confirm-text-${t.id}`}
                              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRevoke(t.id); } }}
                              className="space-y-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-left"
                            >
                              <p id={`${baseId}-confirm-text-${t.id}`} className="text-rose-100">{revokeConfirmText(t.name, t.tokenPrefix)}</p>
                              <ErrorNotice message={revokeError} />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => cancelRevoke(t.id)}
                                  disabled={revokingId !== null}
                                  className="px-3 py-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 text-xs"
                                >
                                  {VM_TOKENS_COPY.cancel}
                                </button>
                                <button
                                  ref={confirmRef}
                                  type="button"
                                  onClick={() => void confirmRevoke(t)}
                                  disabled={revokingId !== null}
                                  className="btn-danger px-3 py-1.5 rounded-xl text-xs"
                                >
                                  {revokingId === t.id ? VM_TOKENS_COPY.revoking : VM_TOKENS_COPY.confirmRevoke}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};
