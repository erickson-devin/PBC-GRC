import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Megaphone, RotateCw } from 'lucide-react';
import { ApiClient, ApiError, DEFAULT_ANNOUNCEMENT_LIMITS } from '../../services/apiClient';
import type { AdminAnnouncement, AnnouncementLimits, NoticeSeverity } from '../../services/apiClient';
import { useAuth } from '../../context/AuthContext';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { normalizeNoticeText } from '../../data/systemUseNotice';
import { utcToday } from '../../utils/memberProfile';
import {
  ANNOUNCEMENT_TEXT,
  activeHeadingText,
  announcementDraftProblem,
  announcementEndIso,
  announcementEndText,
  announcementErrorMessage,
  announcementMetaText,
  atLimitText,
  maxAnnouncementEndDate,
  refreshesAnnouncements,
  splitAnnouncements,
} from '../../data/announcementsView';
import { WHATS_NEW_TEXT } from '../../data/whatsNewView';

const RADIO = 'h-4 w-4 border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const FIELD = 'w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none';
const CODE_FIELD = 'w-full sm:w-48 px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white font-mono tracking-widest focus:outline-none focus:border-brand-500';

const SeverityBadge: React.FC<{ severity: NoticeSeverity }> = ({ severity }) => {
  const warning = severity === 'warning';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold border ${warning ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'}`}>
      {warning ? <AlertTriangle className="w-3 h-3" aria-hidden="true" /> : <Info className="w-3 h-3" aria-hidden="true" />}
      {warning ? WHATS_NEW_TEXT.warning : WHATS_NEW_TEXT.info}
    </span>
  );
};

/**
 * The announcements editor for platform administrators (issue #260): messages shown to every person of every organization in their
 * What's new panel, and, for a warning, as a banner. Posting and withdrawing need a fresh code from the administrator's authenticator
 * app. Titles and texts are plain text nodes, never HTML, and are never logged.
 */
export const AnnouncementsSection: React.FC = () => {
  const { mfaEnrolled } = useAuth();
  const titleId = useId();
  const titleFieldId = useId();
  const titleCountId = useId();
  const bodyFieldId = useId();
  const bodyCountId = useId();
  const endToggleId = useId();
  const endDateId = useId();
  const codeId = useId();
  const codeHelpId = useId();
  const withdrawCodeId = useId();
  const activeHeadingRef = useRef<HTMLHeadingElement>(null);

  const [list, setList] = useState<AdminAnnouncement[] | null>(null);
  const [limits, setLimits] = useState<AnnouncementLimits>(DEFAULT_ANNOUNCEMENT_LIMITS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<NoticeSeverity>('info');
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const [withdrawTarget, setWithdrawTarget] = useState<AdminAnnouncement | null>(null);
  const [withdrawCode, setWithdrawCode] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    ApiClient.listAnnouncementsAdmin().then(
      (r) => {
        if (cancelled) return;
        setList(r.announcements);
        setLimits(r.limits);
        setForbidden(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setLoadError(ANNOUNCEMENT_TEXT.loadFailed);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const focusActiveHeading = () => requestAnimationFrame(() => activeHeadingRef.current?.focus());

  const resetForm = () => {
    setTitle('');
    setBody('');
    setSeverity('info');
    setHasEnd(false);
    setEndDate('');
    setPostError(null);
  };

  const post = async () => {
    if (busy) return;
    const problem = announcementDraftProblem({ title, body, hasEnd, endDate }, limits, Date.now());
    if (problem) {
      setPostError(problem);
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setPostError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setPostError(null);
    setNotice('');
    try {
      const created = await ApiClient.postAnnouncement(
        { title: title.trim(), body: normalizeNoticeText(body), severity, expiresAt: hasEnd ? announcementEndIso(endDate) : null },
        code
      );
      setList((p) => [created, ...(p ?? [])]);
      resetForm();
      setNotice(ANNOUNCEMENT_TEXT.posted);
      focusActiveHeading();
    } catch (err: unknown) {
      setPostError(announcementErrorMessage(err, 'post', limits));
      if (refreshesAnnouncements(err)) setReloadKey((k) => k + 1);
    } finally {
      setCode('');
      setBusy(false);
    }
  };

  const openWithdraw = (a: AdminAnnouncement) => {
    setWithdrawError(null);
    setWithdrawCode('');
    setWithdrawTarget(a);
  };
  const closeWithdraw = () => {
    setWithdrawTarget(null);
    setWithdrawCode('');
    setWithdrawError(null);
  };

  const withdraw = async () => {
    if (!withdrawTarget || withdrawBusy) return;
    if (!/^\d{6}$/.test(withdrawCode)) {
      setWithdrawError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setWithdrawBusy(true);
    setWithdrawError(null);
    try {
      const r = await ApiClient.withdrawAnnouncement(withdrawTarget.id, withdrawCode);
      setList((p) => (p ?? []).map((x) => (x.id === r.id ? r : x)));
      closeWithdraw();
      setNotice(ANNOUNCEMENT_TEXT.withdrawn);
      focusActiveHeading();
    } catch (err: unknown) {
      setWithdrawError(announcementErrorMessage(err, 'withdraw', limits));
      if (refreshesAnnouncements(err)) setReloadKey((k) => k + 1);
    } finally {
      setWithdrawCode('');
      setWithdrawBusy(false);
    }
  };

  const now = Date.now();
  const split = list ? splitAnnouncements(list, now) : null;
  const atLimit = split ? split.active.length >= limits.maxActive : false;
  const dirty = title !== '' || body !== '';
  const problem = announcementDraftProblem({ title, body, hasEnd, endDate }, limits, now);

  const item = (a: AdminAnnouncement, withButton: boolean) => (
    <li key={a.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={a.severity} />
          <span className="text-sm font-semibold text-white break-words">{a.title}</span>
        </div>
        <p className="text-slate-300 whitespace-pre-line break-words line-clamp-3">{a.body}</p>
        <p className="text-slate-400">{announcementMetaText(a, now)}</p>
      </div>
      {withButton && (
        <button type="button" onClick={() => openWithdraw(a)} aria-label={`Withdraw the announcement "${a.title}"`} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
          {ANNOUNCEMENT_TEXT.withdraw}
        </button>
      )}
    </li>
  );

  return (
    <section aria-labelledby={titleId} className="stitch-card p-6 space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-base font-bold text-white flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <span>{ANNOUNCEMENT_TEXT.heading}</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">{ANNOUNCEMENT_TEXT.lead}</p>
        </div>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0">
          <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{ANNOUNCEMENT_TEXT.refresh}</span>
        </button>
      </div>
      <p role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <strong className="font-semibold">{ANNOUNCEMENT_TEXT.cuiWarning}</strong>
      </p>
      <p role="status" aria-live="polite" className="text-xs text-emerald-300">{notice}</p>
      <ErrorNotice message={loadError} />
      {forbidden && <p className="text-xs text-slate-400">{ANNOUNCEMENT_TEXT.forbidden}</p>}
      {!list && !loadError && !forbidden && <p role="status" className="text-xs text-slate-400">{ANNOUNCEMENT_TEXT.loading}</p>}
      {list && split && (
        <div className="space-y-5 text-xs">
          <form noValidate onSubmit={(e) => { e.preventDefault(); void post(); }} className="space-y-3">
            <fieldset disabled={busy || atLimit} className="space-y-3">
              <legend className="text-sm font-bold text-white">{ANNOUNCEMENT_TEXT.formLegend}</legend>
              <div>
                <label htmlFor={titleFieldId} className="block text-xs font-semibold text-slate-300 mb-1">{ANNOUNCEMENT_TEXT.titleLabel}</label>
                <input id={titleFieldId} type="text" maxLength={limits.titleMax} value={title} onChange={(e) => { setTitle(e.target.value.replace(/[\r\n]+/g, ' ')); setNotice(''); }} aria-describedby={titleCountId} className={FIELD} />
                <p id={titleCountId} className="text-xs text-slate-400">{`${title.length} of ${limits.titleMax} characters`}</p>
              </div>
              <div>
                <label htmlFor={bodyFieldId} className="block text-xs font-semibold text-slate-300 mb-1">{ANNOUNCEMENT_TEXT.bodyLabel}</label>
                <textarea id={bodyFieldId} rows={6} maxLength={limits.bodyMax} value={body} onChange={(e) => { setBody(e.target.value); setNotice(''); }} aria-describedby={bodyCountId} className={`${FIELD} leading-relaxed`} />
                <p id={bodyCountId} className="text-xs text-slate-400">{`${body.length} of ${limits.bodyMax} characters`}</p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold text-slate-300">{ANNOUNCEMENT_TEXT.severityLegend}</legend>
                <label className="flex items-center gap-2 text-slate-300">
                  <input type="radio" name={`${titleId}-sev`} checked={severity === 'info'} onChange={() => setSeverity('info')} className={RADIO} />
                  {ANNOUNCEMENT_TEXT.severityInfo}
                </label>
                <label className="flex items-center gap-2 text-slate-300">
                  <input type="radio" name={`${titleId}-sev`} checked={severity === 'warning'} onChange={() => setSeverity('warning')} className={RADIO} />
                  {ANNOUNCEMENT_TEXT.severityWarning}
                </label>
              </fieldset>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id={endToggleId} checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />
                  <label htmlFor={endToggleId} className="text-xs font-semibold text-slate-300">{ANNOUNCEMENT_TEXT.endToggle}</label>
                </div>
                {hasEnd && (
                  <div className="space-y-1.5">
                    <label htmlFor={endDateId} className="block text-xs font-semibold text-slate-300">{ANNOUNCEMENT_TEXT.endLabel}</label>
                    <input id={endDateId} type="date" min={utcToday(now)} max={maxAnnouncementEndDate(now, limits)} value={endDate} onChange={(e) => setEndDate(e.target.value)}
                      className="w-full sm:w-56 px-3 py-2 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all" />
                    <p aria-live="polite" className="text-slate-300">{announcementEndText(endDate)}</p>
                  </div>
                )}
              </div>
            </fieldset>
            {dirty && (
              <div>
                <h3 className="text-xs font-bold text-slate-300 mb-1">{ANNOUNCEMENT_TEXT.previewHeading}</h3>
                <div className={`rounded-xl border p-3 space-y-1.5 ${severity === 'warning' ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-800 bg-slate-900/60'}`}>
                  <SeverityBadge severity={severity} />
                  <p className="text-sm font-semibold text-white break-words">{title}</p>
                  <p className="text-slate-300 whitespace-pre-line break-words leading-relaxed">{body}</p>
                </div>
              </div>
            )}
            {mfaEnrolled ? (
              <div>
                <label htmlFor={codeId} className="block text-xs font-semibold text-slate-300 mb-1">{ANNOUNCEMENT_TEXT.codeLabel}</label>
                <input id={codeId} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-describedby={codeHelpId} className={CODE_FIELD} />
                <p id={codeHelpId} className="mt-1 text-xs text-slate-400">{ANNOUNCEMENT_TEXT.codeHelp}</p>
              </div>
            ) : (
              <p className="text-xs text-amber-300 leading-relaxed">{ANNOUNCEMENT_TEXT.needsMfa}</p>
            )}
            {atLimit && <p className="text-xs text-amber-300">{atLimitText(limits.maxActive)}</p>}
            <ErrorNotice message={postError ?? (dirty ? problem : null)} />
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => { resetForm(); setCode(''); setNotice(''); }} className="btn-base btn-secondary px-3 py-1.5 text-xs">{ANNOUNCEMENT_TEXT.clear}</button>
              <button type="submit" disabled={busy || atLimit || !!problem || !mfaEnrolled || !/^\d{6}$/.test(code)} className="btn-base btn-primary px-3 py-1.5 text-xs">
                {busy ? ANNOUNCEMENT_TEXT.posting : ANNOUNCEMENT_TEXT.post}
              </button>
            </div>
          </form>

          <div className="space-y-2">
            <h3 ref={activeHeadingRef} tabIndex={-1} className="text-sm font-bold text-white focus:outline-none">{activeHeadingText(split.active.length, limits.maxActive)}</h3>
            {split.active.length === 0 ? (
              <p className="text-slate-400">{ANNOUNCEMENT_TEXT.activeEmpty}</p>
            ) : (
              <ul className="divide-y divide-slate-800/80">{split.active.map((a) => item(a, true))}</ul>
            )}
          </div>

          {split.ended.length > 0 && (
            <details className="group rounded-xl border border-slate-800 bg-slate-900/60">
              <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-2 px-3 py-2 text-slate-200 font-semibold rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                <span>{`${ANNOUNCEMENT_TEXT.endedHeading} (${split.ended.length})`}</span>
                <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              </summary>
              <ul className="divide-y divide-slate-800/80 px-3 pb-2">{split.ended.map((a) => item(a, false))}</ul>
            </details>
          )}
        </div>
      )}

      {withdrawTarget && (
        <DialogOverlay role="alertdialog" onClose={withdrawBusy ? undefined : closeWithdraw} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
          <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-rose-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
            <form noValidate onSubmit={(e) => { e.preventDefault(); void withdraw(); }} className="max-h-[calc(94vh-0.75rem)] overflow-y-auto p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-4 text-xs">
              <DialogTitle as="h3" className="text-base font-bold text-white">{ANNOUNCEMENT_TEXT.withdrawTitle}</DialogTitle>
              <p className="text-slate-300 leading-relaxed">
                &quot;<strong className="text-white break-words">{withdrawTarget.title}</strong>&quot; {ANNOUNCEMENT_TEXT.withdrawLead}
              </p>
              {mfaEnrolled ? (
                <div>
                  <label htmlFor={withdrawCodeId} className="block text-xs font-semibold text-slate-300 mb-1">{ANNOUNCEMENT_TEXT.codeLabel}</label>
                  <input id={withdrawCodeId} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={withdrawCode} disabled={withdrawBusy} onChange={(e) => setWithdrawCode(e.target.value.replace(/\D/g, ''))} className={CODE_FIELD} />
                </div>
              ) : (
                <p className="text-amber-300 leading-relaxed">{ANNOUNCEMENT_TEXT.needsMfa}</p>
              )}
              <ErrorNotice message={withdrawError} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={closeWithdraw} disabled={withdrawBusy} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">{ANNOUNCEMENT_TEXT.cancel}</button>
                <button type="submit" disabled={withdrawBusy || !mfaEnrolled || !/^\d{6}$/.test(withdrawCode)} className="btn-danger rounded-xl px-4 py-2">
                  {withdrawBusy ? ANNOUNCEMENT_TEXT.withdrawing : ANNOUNCEMENT_TEXT.withdraw}
                </button>
              </div>
            </form>
          </div>
        </DialogOverlay>
      )}
    </section>
  );
};

export default AnnouncementsSection;
