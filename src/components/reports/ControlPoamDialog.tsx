import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, History, ListChecks, Loader2, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useUnsavedTextProvider } from '../../hooks/useUnsavedTextProvider';
import type { ControlPoamApi } from '../../hooks/useControlPoam';
import { statusDisplayLabel } from '../../data/statusLabels';
import { VM_POAM_DATE_MAX, VM_POAM_DATE_MIN } from '../../data/poamDates';
import { CONTROL_POAM_OWNER_MAX, CONTROL_POAM_PLAN_MAX, CONTROL_POAM_RESOURCES_MAX } from '../../types/controlPoam';
import type { ControlPoamEvent, ControlPoamRecord } from '../../types/controlPoam';
import type { POAMEntry } from '../../types/report';
import {
  CONTROL_POAM_COPY, controlPoamEventView, controlPoamExpectedStamp, controlPoamFieldNames, controlPoamFormDirty, controlPoamFormErrors,
  controlPoamFormFrom, controlPoamFormPatch, controlPoamMilestoneErrors, controlPoamSaveError, controlPoamUnsavedText, poamDateWarningText,
  poamDateWarnings, rebaseControlPoamForm, todayIso, type ControlPoamForm, type ControlPoamFormField,
} from '../../data/reports/controlPoamForm';
import { VM_POAM_COPY } from '../../data/reports/vmPoamView';
import { PoamMilestonesEditor } from './PoamMilestonesEditor';
import { SMALL_BUTTON } from './PoamGroupPanel';

export interface ControlPoamDialogProps {
  /** The entry as listed when the dialog opened (names the control; its generated values are not edited here). */
  entry: POAMEntry;
  /** The stored fields as loaded; null when the control has none yet. */
  record: ControlPoamRecord | null;
  /** The control's current status: 'MET' when it has left the list. */
  controlStatus: string;
  canEdit: boolean;
  api: ControlPoamApi;
  onClose: (saved?: { entry: ControlPoamRecord | null; changed: boolean }) => void;
}

type StaleState = null | { phase: 'error' } | { phase: 'loading' } | { phase: 'loaded'; conflicts: ControlPoamFormField[] } | { phase: 'failed' };
type HistoryState = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; events: ControlPoamEvent[] };

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-slate-300 mb-1';

/**
 * View or edit the POA&M fields of one control entry (#304): owner, scheduled completion date, required resources, plan and milestones, with the
 * rules shown as warnings (never refusals) and the entry's change history. Every text is user text and may be CUI: it lives in this component's
 * React state only, is rendered as text, is never logged or stored, and is offered to the session rescue when unsaved. Every failed save shows
 * fixed copy, never the server's message.
 */
export const ControlPoamDialog: React.FC<ControlPoamDialogProps> = ({ entry, record, controlStatus, canEdit, api, onClose }) => {
  const uid = useId();
  const controlId = entry.controlId;
  const shownId = entry.controlDisplayId ?? controlId;
  // The stored entry as loaded: later prop changes are ignored so the stale-write check stays honest
  const [base, setBase] = useState<ControlPoamRecord | null>(record);
  const [form, setForm] = useState<ControlPoamForm>(() => controlPoamFormFrom(record));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ReturnType<typeof controlPoamSaveError> | null>(null);
  const [lockedReason, setLocked] = useState<null | 'archived' | 'forbidden' | 'unavailable'>(null);
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
  const resourcesRef = useRef<HTMLTextAreaElement>(null);
  const planRef = useRef<HTMLTextAreaElement>(null);
  // Focus the Owner field once the dialog has opened: the focus attribute loses to the focus trap, which focuses the dialog root afterwards
  useEffect(() => { if (canEdit) ownerRef.current?.focus({ preventScroll: true }); }, []);

  // Text typed here and not saved yet is reported to the unsaved-text rescue (labels carry the control id only)
  useUnsavedTextProvider(() => controlPoamUnsavedText(base, form, controlId));

  const dirty = controlPoamFormDirty(base, form);
  const errors = controlPoamFormErrors(base, form);
  const rowErrors = controlPoamMilestoneErrors(form);
  const editable = canEdit && !locked;
  const met = controlStatus === 'MET';
  const shownErrors: Partial<Record<ControlPoamFormField, string>> = showErrors ? errors : {};
  const shownRowErrors = showErrors ? rowErrors : {};
  const warnings = poamDateWarnings({ date: form.scheduledCompletion || null, open: !met, today: todayIso() });

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

  const focusField = (field: ControlPoamFormField) => {
    if (field === 'owner') ownerRef.current?.focus();
    else if (field === 'scheduledCompletion') dateRef.current?.focus();
    else if (field === 'requiredResources') resourcesRef.current?.focus();
    else if (field === 'plan') planRef.current?.focus();
    else {
      const i = Number(Object.keys(rowErrors)[0]);
      const draft = form.milestones[i];
      if (draft) document.getElementById(`${uid}-ms-${draft.key}-${rowErrors[i].description ? 'description' : 'date'}`)?.focus();
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || locked || stale?.phase === 'error' || stale?.phase === 'loading') return;
    setShowErrors(true);
    const first = (['owner', 'scheduledCompletion', 'requiredResources', 'plan', 'milestones'] as ControlPoamFormField[]).find((f) => errors[f]);
    if (first) {
      focusField(first);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.save(controlId, controlPoamFormPatch(base, form), controlPoamExpectedStamp(base));
      onClose({ entry: res.entry, changed: res.changed });
    } catch (err: unknown) {
      if (!mounted.current) return;
      const f = controlPoamSaveError(err);
      if (f.kind === 'session') return; // the session rescue keeps the text; nothing to show here
      if (f.kind === 'stale') setStale({ phase: 'error' });
      else if (f.kind === 'archived') setLocked('archived');
      else if (f.kind === 'forbidden') setLocked('forbidden');
      else if (f.kind === 'not_enabled' || f.kind === 'not_found' || f.kind === 'no_program') setLocked('unavailable');
      setSaveError(f);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const loadCurrent = async () => {
    setStale({ phase: 'loading' });
    const r = await api.refreshRecord(controlId);
    if (!mounted.current) return;
    if (!r.ok) {
      setStale({ phase: 'failed' });
      return;
    }
    const merged = rebaseControlPoamForm(base, r.record, form);
    setBase(r.record);
    setForm(merged.form);
    setStale({ phase: 'loaded', conflicts: merged.conflicts });
    setSaveError(null);
  };

  const useCurrentValues = () => {
    setForm(controlPoamFormFrom(base));
    setStale(null);
  };

  const loadHistory = async () => {
    setHistory({ status: 'loading' });
    try {
      const events = await api.loadEvents(controlId);
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

  const set = <K extends keyof ControlPoamForm>(key: K, value: ControlPoamForm[K]) => {
    if (locked) return;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const ownerHintId = `${uid}-owner-hint`;
  const ownerErrorId = `${uid}-owner-error`;
  const dateHintId = `${uid}-date-hint`;
  const dateErrorId = `${uid}-date-error`;
  const dateWarnId = `${uid}-date-warn`;
  const resourcesHintId = `${uid}-resources-hint`;
  const resourcesCountId = `${uid}-resources-count`;
  const resourcesErrorId = `${uid}-resources-error`;
  const planHintId = `${uid}-plan-hint`;
  const planCountId = `${uid}-plan-count`;
  const planErrorId = `${uid}-plan-error`;
  const join = (ids: Array<string | false | null>): string | undefined => ids.filter(Boolean).join(' ') || undefined;
  const conflictNames = stale?.phase === 'loaded' ? controlPoamFieldNames(stale.conflicts) : '';
  const ownerRecorded = (base?.owner ?? '').trim() !== '';
  const text = (v: string) => (v.trim() ? v : CONTROL_POAM_COPY.notRecorded);

  return (
    <DialogOverlay onClose={saving ? undefined : requestClose} className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="min-w-0 space-y-1">
            <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              <span className="break-words">Control POA&M entry: {shownId}</span>
            </DialogTitle>
            {!canEdit && <p role="note" className="text-xs text-slate-400">{CONTROL_POAM_COPY.readOnlyNote}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={requestClose} disabled={saving} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-slate-400">Weakness ID</dt>
            <dd className="font-mono text-amber-300">{met ? VM_POAM_COPY.notInExports : entry.weaknessId}</dd>
            <dd className="text-slate-400">{CONTROL_POAM_COPY.weaknessIdHint}</dd>
          </div>
          <div><dt className="text-slate-400">Control status</dt><dd className="text-slate-200">{statusDisplayLabel(controlStatus as Parameters<typeof statusDisplayLabel>[0])}</dd></div>
          {!ownerRecorded && <div className="sm:col-span-2"><dt className="text-slate-400">Responsible role on the control</dt><dd className="text-slate-200 break-words">{entry.responsibleRole}</dd></div>}
        </dl>

        {met && <p role="note" className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">{CONTROL_POAM_COPY.metNote}</p>}

        {!canEdit ? (
          <>
            <dl className="space-y-3 text-xs">
              <div><dt className="text-slate-400">Owner</dt><dd className="text-slate-200 break-words">{text(base?.owner ?? '')}</dd></div>
              <div><dt className="text-slate-400">Scheduled completion date</dt><dd className="font-mono text-slate-200">{base?.scheduledCompletion ?? 'None'}</dd></div>
              <div>
                <dt className="text-slate-400">Required resources</dt>
                <dd className="text-slate-200 whitespace-pre-wrap break-words">{text(base?.requiredResources ?? '')}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Remediation plan</dt>
                {(base?.plan ?? '').trim() ? (
                  <dd tabIndex={0} role="region" aria-label="Remediation plan" className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950/60 border border-slate-800 p-3 text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{base?.plan}</dd>
                ) : (
                  <dd className="text-slate-200">{CONTROL_POAM_COPY.notRecorded}</dd>
                )}
              </div>
            </dl>
            <PoamMilestonesEditor value={form.milestones} onChange={() => undefined} readOnly idBase={uid} />
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
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={CONTROL_POAM_OWNER_MAX}
                  readOnly={locked}
                  disabled={saving}
                  value={form.owner}
                  onChange={(e) => set('owner', e.target.value)}
                  placeholder="Person or role responsible"
                  aria-invalid={shownErrors.owner ? true : undefined}
                  aria-describedby={join([ownerHintId, shownErrors.owner ? ownerErrorId : null])}
                  className={inputClass}
                />
                <p id={ownerHintId} className="mt-1 text-xs text-slate-400">{CONTROL_POAM_COPY.ownerHint}</p>
                {shownErrors.owner && <p id={ownerErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.owner}</p>}
              </div>
              <div>
                <label htmlFor={`${uid}-date`} className={labelClass}>Scheduled completion date</label>
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
                    aria-describedby={join([dateHintId, warnings.length > 0 && dateWarnId, shownErrors.scheduledCompletion ? dateErrorId : null])}
                    className={`${inputClass} font-mono`}
                  />
                  {form.scheduledCompletion && !locked && (
                    <button
                      type="button"
                      onClick={() => { set('scheduledCompletion', ''); dateRef.current?.focus(); }}
                      disabled={saving}
                      aria-label="Clear the scheduled completion date"
                      className={`${SMALL_BUTTON} shrink-0`}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p id={dateHintId} className="mt-1 text-xs text-slate-400">{CONTROL_POAM_COPY.dateHint}</p>
                {shownErrors.scheduledCompletion && <p id={dateErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.scheduledCompletion}</p>}
                <div aria-live="polite">
                  {warnings.length > 0 && (
                    <div id={dateWarnId} className="mt-1 space-y-1">
                      {warnings.map((w) => (
                        <p key={w} className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />
                          {poamDateWarningText(w)}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <label htmlFor={`${uid}-resources`} className={labelClass}>Required resources</label>
              <textarea
                id={`${uid}-resources`}
                ref={resourcesRef}
                rows={3}
                maxLength={CONTROL_POAM_RESOURCES_MAX}
                readOnly={locked}
                disabled={saving}
                value={form.requiredResources}
                onChange={(e) => set('requiredResources', e.target.value)}
                aria-invalid={shownErrors.requiredResources ? true : undefined}
                aria-describedby={join([resourcesHintId, resourcesCountId, shownErrors.requiredResources ? resourcesErrorId : null])}
                className={`${inputClass} resize-y`}
              />
              <p id={resourcesHintId} className="mt-1 text-xs text-slate-400">{CONTROL_POAM_COPY.resourcesHint}</p>
              <p id={resourcesCountId} className={`mt-1 text-xs text-right font-mono ${form.requiredResources.length > CONTROL_POAM_RESOURCES_MAX - 200 ? 'text-amber-300' : 'text-slate-400'}`}>{form.requiredResources.length} / {CONTROL_POAM_RESOURCES_MAX}</p>
              {shownErrors.requiredResources && <p id={resourcesErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.requiredResources}</p>}
            </div>

            <div>
              <label htmlFor={`${uid}-plan`} className={labelClass}>Remediation plan</label>
              <textarea
                id={`${uid}-plan`}
                ref={planRef}
                rows={6}
                maxLength={CONTROL_POAM_PLAN_MAX}
                readOnly={locked}
                disabled={saving}
                value={form.plan}
                onChange={(e) => set('plan', e.target.value)}
                aria-invalid={shownErrors.plan ? true : undefined}
                aria-describedby={join([planHintId, planCountId, shownErrors.plan ? planErrorId : null])}
                className={`${inputClass} resize-y`}
              />
              <p id={planHintId} className="mt-1 text-xs text-slate-400">{CONTROL_POAM_COPY.planHint}</p>
              <p id={planCountId} className={`mt-1 text-xs text-right font-mono ${form.plan.length > CONTROL_POAM_PLAN_MAX - 200 ? 'text-amber-300' : 'text-slate-400'}`}>{form.plan.length} / {CONTROL_POAM_PLAN_MAX}</p>
              {shownErrors.plan && <p id={planErrorId} className="mt-1 text-xs text-rose-300">{shownErrors.plan}</p>}
            </div>

            <PoamMilestonesEditor
              value={form.milestones}
              onChange={(next) => set('milestones', next)}
              disabled={saving || locked}
              errors={shownRowErrors}
              idBase={uid}
            />

            <ErrorNotice message={saveError?.text ?? null} />

            {(stale?.phase === 'error' || stale?.phase === 'failed') && (
              <div className="space-y-2">
                {stale.phase === 'failed' && <ErrorNotice message={CONTROL_POAM_COPY.loadCurrentFailed} />}
                <button type="button" onClick={() => { void loadCurrent(); }} className={SMALL_BUTTON}>{CONTROL_POAM_COPY.loadCurrent}</button>
              </div>
            )}
            {stale?.phase === 'loading' && <p role="status" className="text-xs text-slate-400">{CONTROL_POAM_COPY.loadingCurrent}</p>}
            {stale?.phase === 'loaded' && (
              <div role="status" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <p>
                  {stale.conflicts.length === 0
                    ? CONTROL_POAM_COPY.loadedNoConflict
                    : `The current values are loaded. Saved meanwhile and different from your entries: ${conflictNames}. Saving now replaces them.`}
                </p>
                {stale.conflicts.length > 0 && (
                  <button type="button" onClick={useCurrentValues} className={SMALL_BUTTON}>{CONTROL_POAM_COPY.useCurrent}</button>
                )}
              </div>
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
                <p id={`${uid}-discard`} className="text-xs text-amber-200">{CONTROL_POAM_COPY.discardQuestion}</p>
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
              {history.status === 'loading' && <p role="status" className="text-xs text-slate-400">{CONTROL_POAM_COPY.historyLoading}</p>}
              {history.status === 'error' && (
                <div className="space-y-2">
                  <ErrorNotice message={CONTROL_POAM_COPY.historyError} />
                  <button type="button" onClick={() => { void loadHistory(); }} className={SMALL_BUTTON}>{CONTROL_POAM_COPY.retry}</button>
                </div>
              )}
              {history.status === 'ready' && history.events.length === 0 && <p className="text-xs text-slate-400">{CONTROL_POAM_COPY.historyEmpty}</p>}
              {history.status === 'ready' && history.events.length > 0 && (
                <ol aria-label="Change history" tabIndex={0} className="max-h-48 overflow-y-auto space-y-2 text-xs rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                  {history.events.map((ev) => {
                    const v = controlPoamEventView(ev);
                    return (
                      <li key={ev.id}>
                        <p className="text-slate-200">{v.what}</p>
                        <p className="text-slate-400">{v.who}, {v.when}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
              {history.status === 'ready' && history.events.length >= 100 && <p className="text-xs text-slate-400">{CONTROL_POAM_COPY.historyCap}</p>}
            </div>
          )}
        </section>
      </div>
    </DialogOverlay>
  );
};
