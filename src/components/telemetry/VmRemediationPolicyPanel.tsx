import React, { useEffect, useId, useRef, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, History, Info, Loader2 } from 'lucide-react';
import { Badge } from '../common/Badge';
import { ErrorNotice } from '../common/ErrorNotice';
import { SMALL_BUTTON } from '../reports/PoamGroupPanel';
import type { VmPolicyLoad } from '../../hooks/useVmRemediationPolicy';
import type { VmRemediationPolicy } from '../../data/vmRemediation';
import type { VmPolicyEvent, VmPolicySaveResult, VmRemediationPolicyResponse } from '../../types/vmRemediation';
import {
  POLICY_SEVERITY_LABEL,
  REMEDIATION_COPY as C,
  VM_POLICY_SEVERITIES,
  loadErrorText,
  policyChanges,
  policyEventView,
  policyFormDirty,
  policyFormErrors,
  policyFormFrom,
  policyFormSetWarn,
  policyFromForm,
  policySaveError,
  policySavedText,
  policySourceText,
  policySummaryRows,
} from '../../data/telemetry/vmRemediationView';
import type { VmPolicyField, VmPolicyForm } from '../../data/telemetry/vmRemediationView';

export interface VmRemediationPolicyPanelProps {
  load: VmPolicyLoad;
  canEdit: boolean;
  onRetry: () => void;
  onSave: (p: VmRemediationPolicy, expectedUpdatedAt: string | null) => Promise<VmPolicySaveResult>;
  onReload: () => Promise<VmRemediationPolicyResponse | null>;
  loadEvents: () => Promise<VmPolicyEvent[]>;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

type Mode = 'view' | 'edit' | 'confirm';
type Stale = null | 'error' | 'loading' | 'loaded' | 'failed';
type HistoryState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; offline: boolean } | { status: 'ready'; events: VmPolicyEvent[] };

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';
const BRAND_BUTTON = 'px-5 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-500 rounded-xl shadow-lg shadow-brand-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
const RETRY_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const FIELD_ORDER: VmPolicyField[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'graceDays'];
const join = (ids: Array<string | false | null | undefined>): string | undefined => ids.filter(Boolean).join(' ') || undefined;

/**
 * The organization's vulnerability remediation policy: its deadlines, which severities are warning only and the grace period, with the
 * change history. Owner-level roles edit it through a review step that lists what changes; everyone else reads. Values live in React state only.
 */
export const VmRemediationPolicyPanel: React.FC<VmRemediationPolicyPanelProps> = ({ load, canEdit, onRetry, onSave, onReload, loadEvents, onSaved, onDirtyChange, onBusyChange }) => {
  const uid = useId();
  const [base, setBase] = useState<VmRemediationPolicyResponse | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [form, setForm] = useState<VmPolicyForm | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ kind: string; text: string | null } | null>(null);
  const [stale, setStale] = useState<Stale>(null);
  const [announce, setAnnounce] = useState('');
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });
  const [historyOpen, setHistoryOpen] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const editRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  // In view mode the policy on screen is the loaded one; while editing it is the one the form started from
  const data: VmRemediationPolicyResponse | null = mode === 'view' ? (load.status === 'ready' ? load.data : base) : base;
  const dirty = mode !== 'view' && data !== null && form !== null && policyFormDirty(data.policy, form);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { onBusyChange?.(saving); }, [saving]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, []);

  const errors = form ? policyFormErrors(form) : {};
  const shown: Partial<Record<VmPolicyField, string>> = showErrors ? errors : {};

  const startEdit = () => {
    if (load.status !== 'ready') return;
    setBase(load.data);
    setForm(policyFormFrom(load.data.policy));
    setShowErrors(false);
    setSaveError(null);
    setStale(null);
    setAnnounce('');
    setMode('edit');
    requestAnimationFrame(() => firstRef.current?.focus());
  };

  const cancelEdit = () => {
    if (saving) return;
    setMode('view');
    setForm(null);
    setSaveError(null);
    setStale(null);
    requestAnimationFrame(() => editRef.current?.focus());
  };

  const review = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || saving) return;
    setShowErrors(true);
    const first = FIELD_ORDER.find((f) => errors[f]);
    if (first) {
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }
    setMode('confirm');
    requestAnimationFrame(() => backRef.current?.focus());
  };

  const backToEdit = () => {
    if (saving) return;
    setMode('edit');
    setSaveError(null);
    requestAnimationFrame(() => reviewRef.current?.focus());
  };

  const save = async () => {
    if (saving || !data || !form) return;
    const policy = policyFromForm(form);
    if (!policy) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await onSave(policy, data.updatedAt);
      if (!mounted.current) return;
      setAnnounce(policySavedText(res));
      setMode('view');
      setForm(null);
      setStale(null);
      onSaved?.();
      await onReload();
      requestAnimationFrame(() => editRef.current?.focus());
    } catch (err: unknown) {
      if (!mounted.current) return;
      const f = policySaveError(err);
      if (f.kind === 'session') return; // the session rescue handles it; nothing to show here
      if (f.kind === 'stale') setStale('error');
      setSaveError(f);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const loadCurrent = async () => {
    setStale('loading');
    const r = await onReload();
    if (!mounted.current) return;
    if (!r) {
      setStale('failed');
      return;
    }
    setBase(r);
    setStale('loaded');
    setSaveError(null);
    setMode('edit');
  };

  const useCurrent = () => {
    if (!base) return;
    setForm(policyFormFrom(base.policy));
    setStale(null);
  };

  const loadHistory = async () => {
    setHistory({ status: 'loading' });
    try {
      const events = await loadEvents();
      if (mounted.current) setHistory({ status: 'ready', events });
    } catch (err: unknown) {
      if (mounted.current) setHistory({ status: 'error', offline: (err as { status?: unknown } | null)?.status === 0 });
    }
  };

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history.status === 'idle') void loadHistory();
  };

  const setField = (key: VmPolicyField, value: string) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const daysHintId = `${uid}-days-hint`;
  const editing = mode !== 'view' && form !== null;

  return (
    <section aria-labelledby={`${uid}-h`} className="space-y-3 text-xs pt-4 border-t border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-h`} className="text-sm font-bold text-white flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />
          {C.policyHeading}
        </h3>
        {data && <Badge tone={data.source === 'defaults' ? 'amber' : 'neutral'}>{data.source === 'defaults' ? C.badgeDefaults : C.badgeTenant}</Badge>}
      </div>
      <p className="text-slate-400">{C.policyIntro}</p>

      {load.status === 'idle' || (load.status === 'loading' && !data) ? (
        <p role="status" className="text-slate-400">{C.policyLoading}</p>
      ) : load.status === 'error' && !data ? (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={loadErrorText('policy', load.offline)} className="flex-1" />
          <button type="button" aria-label="Retry loading the remediation policy" onClick={onRetry} className={RETRY_CLASS}>{C.retry}</button>
        </div>
      ) : data ? (
        <>
          <p className="text-slate-300">{policySourceText(data)}</p>

          {!editing && (
            <>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                {policySummaryRows(data.policy).map((r) => (
                  <div key={r.label}>
                    <dt className="text-slate-400">{r.label}</dt>
                    <dd className="font-mono text-slate-200">{r.value}</dd>
                  </div>
                ))}
              </dl>
              <FixedRule text={data.kevRule} />
              {canEdit ? (
                <div>
                  <button ref={editRef} type="button" onClick={startEdit} disabled={load.status !== 'ready'} className={SMALL_BUTTON}>{C.edit}</button>
                </div>
              ) : (
                <p role="note" className="text-slate-400">{C.readOnlyPolicy}</p>
              )}
            </>
          )}

          {editing && form && (
            <form onSubmit={review} noValidate aria-busy={saving} className="space-y-4">
              <fieldset aria-describedby={daysHintId} className="space-y-1">
                <legend className="block text-xs font-medium text-slate-300 mb-1">{C.daysLegend}</legend>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {VM_POLICY_SEVERITIES.map((s) => {
                    const err = shown[s];
                    return (
                      <div key={s}>
                        <label htmlFor={`${uid}-${s}`} className="block text-xs font-medium text-slate-300 mb-1">{POLICY_SEVERITY_LABEL[s]}</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            id={`${uid}-${s}`}
                            ref={s === 'CRITICAL' ? firstRef : undefined}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={3650}
                            step={1}
                            value={form[s]}
                            disabled={saving || mode === 'confirm'}
                            onChange={(e) => setField(s, e.target.value)}
                            aria-invalid={err ? true : undefined}
                            aria-describedby={join([daysHintId, err && `${uid}-${s}-err`])}
                            className={`${inputClass} font-mono`}
                          />
                          <span aria-hidden="true" className="text-slate-400">days</span>
                        </div>
                        {err && <p id={`${uid}-${s}-err`} className="mt-1 text-xs text-rose-300">{err}</p>}
                      </div>
                    );
                  })}
                </div>
                <p id={daysHintId} className="text-xs text-slate-400">{C.daysHint}</p>
              </fieldset>

              <fieldset className="space-y-1">
                <legend className="block text-xs font-medium text-slate-300 mb-1">{C.warnLegend}</legend>
                <div className="flex flex-wrap gap-4">
                  <label htmlFor={`${uid}-warn-medium`} className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      id={`${uid}-warn-medium`}
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={form.warnMedium}
                      disabled={saving || mode === 'confirm'}
                      onChange={(e) => setForm(policyFormSetWarn(form, 'MEDIUM', e.target.checked))}
                    />
                    Medium
                  </label>
                  <label htmlFor={`${uid}-warn-low`} className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      id={`${uid}-warn-low`}
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={form.warnLow}
                      disabled={saving || mode === 'confirm' || form.warnMedium}
                      aria-describedby={form.warnMedium ? `${uid}-warn-forced` : undefined}
                      onChange={(e) => setForm(policyFormSetWarn(form, 'LOW', e.target.checked))}
                    />
                    Low
                  </label>
                </div>
                {form.warnMedium && <p id={`${uid}-warn-forced`} className="text-xs text-slate-300">{C.warnLowForced}</p>}
                <p className="text-xs text-slate-400">{C.warnHint}</p>
              </fieldset>

              <div>
                <label htmlFor={`${uid}-graceDays`} className="block text-xs font-medium text-slate-300 mb-1">{C.graceLabel}</label>
                <input
                  id={`${uid}-graceDays`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={30}
                  step={1}
                  value={form.graceDays}
                  disabled={saving || mode === 'confirm'}
                  onChange={(e) => setField('graceDays', e.target.value)}
                  aria-invalid={shown.graceDays ? true : undefined}
                  aria-describedby={join([`${uid}-grace-hint`, shown.graceDays && `${uid}-graceDays-err`])}
                  className={`${inputClass} font-mono max-w-[8rem]`}
                />
                <p id={`${uid}-grace-hint`} className="mt-1 text-xs text-slate-400">{C.graceHint}</p>
                {shown.graceDays && <p id={`${uid}-graceDays-err`} className="mt-1 text-xs text-rose-300">{shown.graceDays}</p>}
              </div>

              <FixedRule text={data.kevRule} />

              {stale === 'loaded' && (
                <div role="status" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
                  <p>{C.loadedCurrent}</p>
                  <button type="button" onClick={useCurrent} className={SMALL_BUTTON}>{C.useCurrent}</button>
                </div>
              )}

              {mode === 'edit' ? (
                <div className="flex justify-end gap-2.5">
                  <button type="button" onClick={cancelEdit} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">{C.cancel}</button>
                  <button ref={reviewRef} type="submit" disabled={!dirty} className={BRAND_BUTTON}>{C.review}</button>
                </div>
              ) : (
                <div
                  role="group"
                  aria-labelledby={`${uid}-confirm-q`}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !saving) {
                      e.preventDefault();
                      e.stopPropagation();
                      backToEdit();
                    }
                  }}
                  className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2.5 text-xs"
                >
                  <p id={`${uid}-confirm-q`} className="font-semibold text-amber-100">{C.confirmQuestion}</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-amber-100">
                    {(policyFromForm(form) ? policyChanges(data.policy, policyFromForm(form) as VmRemediationPolicy) : []).map((c) => <li key={c}>{c}</li>)}
                  </ul>
                  {C.confirmEffects.map((t) => <p key={t} className="text-amber-200">{t}</p>)}
                  <ErrorNotice message={saveError?.text ?? null} />
                  {(stale === 'error' || stale === 'failed') && (
                    <div className="space-y-2">
                      {stale === 'failed' && <ErrorNotice message={C.loadCurrentFailed} />}
                      <button type="button" onClick={() => { void loadCurrent(); }} className={SMALL_BUTTON}>{C.loadCurrent}</button>
                    </div>
                  )}
                  {stale === 'loading' && <p role="status" className="text-amber-200">{C.loadingCurrent}</p>}
                  <div className="flex items-center justify-end gap-2">
                    <button ref={backRef} type="button" onClick={backToEdit} disabled={saving} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">{C.back}</button>
                    <button type="button" onClick={() => { void save(); }} disabled={saving || stale === 'error' || stale === 'loading'} className={`${BRAND_BUTTON} inline-flex items-center gap-1.5`}>
                      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                      {saving ? C.saving : C.save}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}

          <p role="status" aria-live="polite" className="text-emerald-300">{announce}</p>

          <div className="space-y-2">
            <h4 id={`${uid}-history-h`} className="m-0">
              <button
                type="button"
                onClick={toggleHistory}
                aria-expanded={historyOpen}
                aria-controls={`${uid}-history`}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                {historyOpen ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                {C.historyToggle}
              </button>
            </h4>
            {historyOpen && (
              <div id={`${uid}-history`} className="space-y-2">
                {history.status === 'loading' && <p role="status" className="text-slate-400">{C.historyLoading}</p>}
                {history.status === 'error' && (
                  <div className="flex items-center justify-between gap-3">
                    <ErrorNotice message={loadErrorText('history', history.offline)} className="flex-1" />
                    <button type="button" onClick={() => { void loadHistory(); }} className={RETRY_CLASS}>{C.retry}</button>
                  </div>
                )}
                {history.status === 'ready' && history.events.length === 0 && <p className="text-slate-400">{C.historyEmpty}</p>}
                {history.status === 'ready' && history.events.length > 0 && (
                  <ol aria-label="Change history" tabIndex={0} className="max-h-48 overflow-y-auto space-y-2 text-xs rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    {history.events.map((ev) => {
                      const v = policyEventView(ev);
                      return (
                        <li key={ev.id}>
                          <p className="text-slate-200">{v.what}</p>
                          <p className="text-slate-400">{v.who}, {v.when}. {v.impact}</p>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {history.status === 'ready' && history.events.length >= 50 && <p className="text-slate-400">{C.historyCap}</p>}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
};

const FixedRule: React.FC<{ text: string }> = ({ text }) => (
  <p className="flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-slate-300">
    <Info className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />
    <span><span className="font-semibold text-slate-200">{C.fixedRule}</span>{text}</span>
  </p>
);
