import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, History, Loader2, ShieldAlert, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useUnsavedTextProvider } from '../../hooks/useUnsavedTextProvider';
import type { VmPoamItemApi } from '../../hooks/useVmPoam';
import { VM_POAM_COPY, isoDate } from '../../data/reports/vmPoamView';
import {
  VM_POAM_ITEM_COPY, rebaseVmPoamForm, vmPoamCompletedBlockedText, vmPoamCreatedText, vmPoamEventView, vmPoamFieldNames,
  vmPoamFindingStateText, vmPoamFormDirty, vmPoamFormErrors, vmPoamFormFrom, vmPoamFormPatch, vmPoamReopenWarning, vmPoamSaveError,
  vmPoamStatusMarker, vmPoamStatusOptions, vmPoamUnsavedText, type VmPoamForm, type VmPoamFormField,
} from '../../data/reports/vmPoamItemForm';
import { VM_POAM_DATE_MAX, VM_POAM_DATE_MIN, VM_POAM_MITIGATION_MAX, VM_POAM_OWNER_MAX } from '../../data/vmPoamEdit';
import type { VmPoamItemEvent, VmPoamRow, VmPoamStatus } from '../../types/vm';
import { VmPoamStatusBadge } from './VmPoamStatusBadge';
import { SMALL_BUTTON } from './PoamGroupPanel';

export interface VmPoamItemDialogProps {
  row: VmPoamRow;
  weaknessId: string | null;
  canEdit: boolean;
  includeClosed: boolean;
  api: VmPoamItemApi;
  onClose: (saved?: { before: VmPoamRow; after: VmPoamRow; changed: boolean }) => void;
}

type StaleState = null | { phase: 'error' } | { phase: 'loading' } | { phase: 'loaded'; conflicts: VmPoamFormField[] } | { phase: 'failed' };
type HistoryState = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; events: VmPoamItemEvent[] };

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-slate-300 mb-1';

/**
 * View or edit one vulnerability POA&M item (#297): owner, target date, plan and status, with the rules shown before the server refuses
 * them, and the item's change history. The owner and the plan are user text and may be sensitive: they live in this component's React
 * state only, are rendered as text, are never logged or stored, and are offered to the session rescue when unsaved. Every failed save
 * shows fixed copy, never the server's message.
 */
export const VmPoamItemDialog: React.FC<VmPoamItemDialogProps> = ({ row, weaknessId, canEdit, includeClosed, api, onClose }) => {
  const uid = useId();
  // The row as loaded: later prop changes are ignored so the stale-write check stays honest
  const [base, setBase] = useState<VmPoamRow>(row);
  const [form, setForm] = useState<VmPoamForm>(() => vmPoamFormFrom(row));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ReturnType<typeof vmPoamSaveError> | null>(null);
  const [lockedReason, setLocked] = useState<null | 'archived' | 'removed' | 'forbidden'>(null);
  const locked = lockedReason !== null;
  const [stale, setStale] = useState<StaleState>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ownerRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const mitigationRef = useRef<HTMLTextAreaElement>(null);

  // Owner and plan typed here and not saved yet are reported to the unsaved-text rescue (labels carry the CVE only)
  useUnsavedTextProvider(() => vmPoamUnsavedText(base, form));

  const dirty = vmPoamFormDirty(base, form);
  const errors = vmPoamFormErrors(base, form);
  const editable = canEdit && !locked;
  const blocked = vmPoamCompletedBlockedText(base);
  const reopen = vmPoamReopenWarning(base, form);
  const marker = vmPoamStatusMarker(base);
  const shownErrors: Partial<Record<VmPoamFormField, string>> = showErrors ? errors : {};

  const focusCancel = () => requestAnimationFrame(() => cancelRef.current?.focus());

  const requestClose = () => {
    if (saving) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      focusCancel();
      return;
    }
    if (editable && dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const focusField = (field: VmPoamFormField) => {
    if (field === 'owner') ownerRef.current?.focus();
    else if (field === 'scheduledCompletion') dateRef.current?.focus();
    else if (field === 'mitigation') mitigationRef.current?.focus();
    else document.getElementById(`${uid}-status-${form.status}`)?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || locked || stale?.phase === 'error' || stale?.phase === 'loading') return;
    setShowErrors(true);
    const first = (['owner', 'scheduledCompletion', 'mitigation', 'status'] as VmPoamFormField[]).find((f) => errors[f]);
    if (first) {
      focusField(first);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.save(base.id, vmPoamFormPatch(base, form), base.updatedAt);
      onClose({ before: base, after: res.item, changed: res.changed });
    } catch (err: unknown) {
      if (!mounted.current) return;
      const f = vmPoamSaveError(err);
      if (f.kind === 'session') return; // the session rescue keeps the text; nothing to show here
      if (f.kind === 'stale') setStale({ phase: 'error' });
      else if (f.kind === 'archived') setLocked('archived');
      else if (f.kind === 'not_found') setLocked('removed');
      else if (f.kind === 'forbidden') setLocked('forbidden');
      else if (f.field) focusField(f.field);
      setSaveError(f);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const loadCurrent = async () => {
    setStale({ phase: 'loading' });
    const r = await api.refreshItem(base.id);
    if (!mounted.current) return;
    if (!r.ok) {
      setStale({ phase: 'failed' });
      return;
    }
    if (r.row === null) {
      setLocked('removed');
      setStale(null);
      return;
    }
    const merged = rebaseVmPoamForm(base, r.row, form);
    setBase(r.row);
    setForm(merged.form);
    setStale({ phase: 'loaded', conflicts: merged.conflicts });
    setSaveError(null);
  };

  const useCurrentValues = () => {
    setForm(vmPoamFormFrom(base));
    setStale(null);
  };

  const loadHistory = async () => {
    setHistory({ status: 'loading' });
    try {
      const events = await api.loadEvents(base.id);
      if (mounted.current) setHistory({ status: 'ready', events });
    } catch {
      if (mounted.current) setHistory({ status: 'error' });
    }
  };

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history.status === 'idle') void loadHistory();
  };

  const set = <K extends keyof VmPoamForm>(key: K, value: VmPoamForm[K]) => {
    if (locked) return;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const ownerHintId = `${uid}-owner-hint`;
  const ownerErrorId = `${uid}-owner-error`;
  const dateHintId = `${uid}-date-hint`;
  const dateErrorId = `${uid}-date-error`;
  const mitigationHintId = `${uid}-mitigation-hint`;
  const mitigationCountId = `${uid}-mitigation-count`;
  const mitigationErrorId = `${uid}-mitigation-error`;
  const blockedId = `${uid}-status-blocked`;
  const reopenId = `${uid}-status-reopen`;
  const statusErrorId = `${uid}-status-error`;
  const join = (ids: Array<string | false | null>): string | undefined => ids.filter(Boolean).join(' ') || undefined;
  const statusOptions = vmPoamStatusOptions(base);
  const conflictNames = stale?.phase === 'loaded' ? vmPoamFieldNames(stale.conflicts) : '';

  return (
    <DialogOverlay onClose={saving ? undefined : requestClose} className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="min-w-0 space-y-1">
            <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
              <span className="break-words">{base.finding ? `Vulnerability POA&M item: ${base.finding.vulnId}` : 'Vulnerability POA&M item (finding removed)'}</span>
            </DialogTitle>
            {!canEdit && <p role="note" className="text-xs text-slate-400">{VM_POAM_COPY.readOnlyNote}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={requestClose} disabled={saving} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div><dt className="text-slate-400">Weakness ID</dt><dd className="font-mono text-amber-300">{weaknessId ?? VM_POAM_COPY.notInExports}</dd></div>
          <div><dt className="text-slate-400">Asset</dt><dd className="text-slate-200 break-words">{base.finding?.asset?.name ?? VM_POAM_COPY.orphanAsset}</dd></div>
          <div><dt className="text-slate-400">Remediation deadline</dt><dd className="font-mono text-slate-200">{isoDate(base.finding?.slaDueAt ?? null)}</dd></div>
          <div><dt className="text-slate-400">Scanner</dt><dd className="text-slate-200">{vmPoamFindingStateText(base)}</dd></div>
          <div className="sm:col-span-2">
            <dt className="text-slate-400">Current status</dt>
            <dd className="flex flex-wrap items-center gap-2"><VmPoamStatusBadge status={base.status} />{marker && <span className="text-slate-400">{marker}</span>}</dd>
          </div>
        </dl>

        {!canEdit ? (
          <>
            <dl className="space-y-3 text-xs">
              <div><dt className="text-slate-400">Owner</dt><dd className="text-slate-200 break-words">{base.owner.trim() ? base.owner : VM_POAM_ITEM_COPY.notRecorded}</dd></div>
              <div><dt className="text-slate-400">Target completion date</dt><dd className="font-mono text-slate-200">{base.scheduledCompletion ?? 'None'}</dd></div>
              <div>
                <dt className="text-slate-400">Plan</dt>
                {base.mitigation.trim() ? (
                  <dd tabIndex={0} role="region" aria-label="Plan" className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950/60 border border-slate-800 p-3 text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{base.mitigation}</dd>
                ) : (
                  <dd className="text-slate-200">{VM_POAM_ITEM_COPY.notRecorded}</dd>
                )}
              </div>
            </dl>
            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button type="button" ref={cancelRef} onClick={() => onClose()} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">Close</button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => { void submit(e); }} noValidate aria-busy={saving} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-owner`} className={labelClass}>Owner</label>
                <input
                  id={`${uid}-owner`}
                  ref={ownerRef}
                  type="text"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={VM_POAM_OWNER_MAX}
                  readOnly={locked}
                  disabled={saving}
                  value={form.owner}
                  onChange={(e) => set('owner', e.target.value)}
                  placeholder="Person or role responsible"
                  aria-invalid={shownErrors.owner ? true : undefined}
                  aria-describedby={join([ownerHintId, shownErrors.owner ? ownerErrorId : null])}
                  className={inputClass}
                />
                <p id={ownerHintId} className="mt-1 text-xs text-slate-400">Printed as the Responsible Role.</p>
                {shownErrors.owner && <p id={ownerErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.owner}</p>}
              </div>
              <div>
                <label htmlFor={`${uid}-date`} className={labelClass}>Target completion date</label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${uid}-date`}
                    ref={dateRef}
                    type="date"
                    min={VM_POAM_DATE_MIN}
                    max={VM_POAM_DATE_MAX}
                    readOnly={locked}
                    disabled={saving}
                    value={form.scheduledCompletion}
                    onChange={(e) => set('scheduledCompletion', e.target.value)}
                    aria-invalid={shownErrors.scheduledCompletion ? true : undefined}
                    aria-describedby={join([dateHintId, shownErrors.scheduledCompletion ? dateErrorId : null])}
                    className={`${inputClass} font-mono`}
                  />
                  {form.scheduledCompletion && !locked && (
                    <button
                      type="button"
                      onClick={() => { set('scheduledCompletion', ''); dateRef.current?.focus(); }}
                      disabled={saving}
                      aria-label="Clear the target completion date"
                      className={`${SMALL_BUTTON} shrink-0`}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p id={dateHintId} className="mt-1 text-xs text-slate-400">Printed as the Scheduled Completion Date. Leave it empty if no date is planned.</p>
                {shownErrors.scheduledCompletion && <p id={dateErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.scheduledCompletion}</p>}
              </div>
            </div>

            <div>
              <label htmlFor={`${uid}-mitigation`} className={labelClass}>Mitigation and remediation plan</label>
              <textarea
                id={`${uid}-mitigation`}
                ref={mitigationRef}
                rows={6}
                maxLength={VM_POAM_MITIGATION_MAX}
                readOnly={locked}
                disabled={saving}
                value={form.mitigation}
                onChange={(e) => set('mitigation', e.target.value)}
                aria-invalid={shownErrors.mitigation ? true : undefined}
                aria-describedby={join([mitigationHintId, mitigationCountId, shownErrors.mitigation ? mitigationErrorId : null])}
                className={`${inputClass} resize-y`}
              />
              <p id={mitigationHintId} className="mt-1 text-xs text-slate-400">Printed as the Remediation Plan. Required for Risk accepted.</p>
              <p id={mitigationCountId} className={`mt-1 text-xs text-right font-mono ${form.mitigation.length > VM_POAM_MITIGATION_MAX - 200 ? 'text-amber-300' : 'text-slate-400'}`}>{form.mitigation.length} / {VM_POAM_MITIGATION_MAX}</p>
              {shownErrors.mitigation && <p id={mitigationErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.mitigation}</p>}
            </div>

            <fieldset aria-describedby={join([blocked && blockedId, reopen && reopenId, shownErrors.status ? statusErrorId : null])} className="space-y-2">
              <legend className={labelClass}>Status</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {statusOptions.map((o) => {
                  const selected = form.status === o.status;
                  const radioId = `${uid}-status-${o.status}`;
                  return (
                    <label
                      key={o.status}
                      htmlFor={radioId}
                      className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${selected ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/60'} ${o.available ? 'cursor-pointer' : 'text-slate-400 cursor-not-allowed'}`}
                    >
                      <input
                        id={radioId}
                        type="radio"
                        name={`${uid}-status`}
                        value={o.status}
                        checked={selected}
                        disabled={!o.available || saving || locked}
                        onChange={() => set('status', o.status as VmPoamStatus)}
                        aria-describedby={`${radioId}-note`}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block font-bold text-slate-200">{o.label}</span>
                        <span id={`${radioId}-note`} className="block text-slate-400">{o.note}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {blocked && <p id={blockedId} className="text-xs text-slate-400">{blocked}</p>}
              <div aria-live="polite">
                {reopen && (
                  <p id={reopenId} className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />
                    {reopen}
                  </p>
                )}
              </div>
              {shownErrors.status && <p id={statusErrorId} className="text-xs text-rose-300">{shownErrors.status}</p>}
            </fieldset>

            <ErrorNotice message={saveError?.text ?? null} />

            {(stale?.phase === 'error' || stale?.phase === 'failed') && (
              <div className="space-y-2">
                {stale.phase === 'failed' && <ErrorNotice message={VM_POAM_ITEM_COPY.loadCurrentFailed} />}
                <button type="button" onClick={() => { void loadCurrent(); }} className={SMALL_BUTTON}>{VM_POAM_ITEM_COPY.loadCurrent}</button>
              </div>
            )}
            {stale?.phase === 'loading' && <p role="status" className="text-xs text-slate-400">{VM_POAM_ITEM_COPY.loadingCurrent}</p>}
            {stale?.phase === 'loaded' && (
              <div role="status" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <p>
                  {stale.conflicts.length === 0
                    ? VM_POAM_ITEM_COPY.loadedNoConflict
                    : `The current values are loaded. Saved meanwhile and different from your entries: ${conflictNames}. Saving now replaces them.`}
                </p>
                {stale.conflicts.length > 0 && (
                  <button type="button" onClick={useCurrentValues} className={SMALL_BUTTON}>{VM_POAM_ITEM_COPY.useCurrent}</button>
                )}
              </div>
            )}

            {lockedReason === 'removed' && saveError?.kind !== 'not_found' && (
              <p role="note" className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
                {VM_POAM_ITEM_COPY.removedNote}{includeClosed ? '' : VM_POAM_ITEM_COPY.removedHint}
              </p>
            )}

            {confirmDiscard ? (
              <div
                role="group"
                aria-labelledby={`${uid}-discard`}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmDiscard(false);
                    focusCancel();
                  }
                }}
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2.5"
              >
                <p id={`${uid}-discard`} className="text-xs text-amber-200">{VM_POAM_ITEM_COPY.discardQuestion}</p>
                <div className="flex justify-end gap-2.5">
                  <button type="button" autoFocus onClick={() => { setConfirmDiscard(false); focusCancel(); }} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">Keep editing</button>
                  <button type="button" onClick={() => onClose()} className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 hover:bg-rose-900/50">Discard changes</button>
                </div>
              </div>
            ) : (
              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  ref={cancelRef}
                  onClick={requestClose}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {locked ? 'Close' : 'Cancel'}
                </button>
                {!locked && (
                  <button
                    type="submit"
                    disabled={saving || !dirty || stale?.phase === 'error' || stale?.phase === 'loading'}
                    className="px-5 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-500 rounded-xl shadow-lg shadow-brand-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    {saving && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                )}
              </div>
            )}
          </form>
        )}

        <section aria-labelledby={`${uid}-history-h`} className="border-t border-slate-800 pt-4 space-y-2">
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
              Change history
            </button>
          </h4>
          {historyOpen && (
            <div id={`${uid}-history`} className="space-y-2">
              {history.status === 'loading' && <p role="status" className="text-xs text-slate-400">{VM_POAM_ITEM_COPY.historyLoading}</p>}
              {history.status === 'error' && (
                <div className="space-y-2">
                  <ErrorNotice message={VM_POAM_ITEM_COPY.historyError} />
                  <button type="button" onClick={() => { void loadHistory(); }} className={SMALL_BUTTON}>{VM_POAM_COPY.retry}</button>
                </div>
              )}
              {history.status === 'ready' && history.events.length === 0 && <p className="text-xs text-slate-400">{VM_POAM_ITEM_COPY.historyEmpty}</p>}
              {history.status === 'ready' && history.events.length > 0 && (
                <ol aria-label="Change history" tabIndex={0} className="max-h-48 overflow-y-auto space-y-2 text-xs rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                  {history.events.map((ev) => {
                    const v = vmPoamEventView(ev);
                    return (
                      <li key={ev.id}>
                        <p className="text-slate-200">{v.what}</p>
                        <p className="text-slate-400">{v.who}, {v.when}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
              {history.status === 'ready' && history.events.length >= 100 && <p className="text-xs text-slate-400">{VM_POAM_ITEM_COPY.historyCap}</p>}
              <p className="text-xs text-slate-400">{vmPoamCreatedText(base)}</p>
            </div>
          )}
        </section>
      </div>
    </DialogOverlay>
  );
};
