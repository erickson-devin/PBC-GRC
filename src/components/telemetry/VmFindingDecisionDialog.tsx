import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Scale, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { VmDecisionCard } from './VmDecisionCard';
import { useTenant } from '../../context/TenantContext';
import { useUnsavedTextProvider } from '../../hooks/useUnsavedTextProvider';
import { useVmFindingDecisions } from '../../hooks/useVmDecisions';
import { NOT_REPORTED } from '../../data/telemetry/observedInventoryView';
import { SEVERITY_LABEL } from '../../data/telemetry/vmFindingsView';
import { canRoleWrite } from '../../utils/roles';
import {
  REMEDIATION_COPY as C,
  TIER_LABEL,
  VM_DECISION_JUSTIFICATION_MAX,
  approverNote,
  canRequestDecision,
  decisionDateBounds,
  decisionFormDirty,
  decisionFormErrors,
  decisionRequestError,
  decisionUnsavedText,
  justificationLength,
  loadErrorText,
  ownerLevelCount,
  roleNote,
  tierLines,
} from '../../data/telemetry/vmRemediationView';
import type { VmDecisionForm, VmDecisionTarget } from '../../data/telemetry/vmRemediationView';

export interface VmFindingDecisionDialogProps {
  target: VmDecisionTarget;
  /** `changed`: a request or an action went through, so the caller's lists are stale. */
  onClose: (changed: boolean) => void;
}

const inputClass = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-slate-300 mb-1';
const EMPTY_FORM: VmDecisionForm = { kind: '', justification: '', expiresAt: '' };
const KINDS = [
  { kind: 'RISK_ACCEPTED' as const, label: 'Risk accepted', note: C.kindRiskNote },
  { kind: 'FALSE_POSITIVE' as const, label: 'False positive', note: C.kindFpNote },
];
const join = (ids: Array<string | false | null | undefined>): string | undefined => ids.filter(Boolean).join(' ') || undefined;

/**
 * The risk decisions of one finding: their history, and (for the write roles) a request for a risk acceptance or a false-positive decision. A request
 * needs the approval of another owner-level person before it takes effect. The justification lives in this component's React state only, is rendered as
 * text, is never logged or stored, and is offered to the session rescue while unsent.
 */
export const VmFindingDecisionDialog: React.FC<VmFindingDecisionDialogProps> = ({ target, onClose }) => {
  const uid = useId();
  const { currentTenant, currentRole, teamMembers } = useTenant();
  const decisions = useVmFindingDecisions(target.findingId, true);
  const [openedAt] = useState(() => Date.now());
  const [form, setForm] = useState<VmDecisionForm>(EMPTY_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [changed, setChanged] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const firstRadioRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLHeadingElement>(null);

  useUnsavedTextProvider(() => decisionUnsavedText(target, form));

  const load = decisions.load;
  const list = load.status === 'ready' ? load.decisions : [];
  const hasPending = list.some((d) => d.state === 'PENDING');
  const writer = canRoleWrite(currentRole);
  const notOpen = target.findingStatus !== null && target.findingStatus !== 'OPEN';
  const showForm = load.status === 'ready' && writer && canRequestDecision(currentRole, target) && !hasPending;
  const errors = decisionFormErrors(form, openedAt);
  const shown = showErrors ? errors : {};
  const bounds = decisionDateBounds(openedAt);
  const dirty = decisionFormDirty(form);
  const note = approverNote({ role: currentRole, ownerLevelCount: ownerLevelCount(teamMembers[currentTenant.id]) });
  const role = roleNote(currentRole);

  // Focus the first radio once the form appears: the focus trap focuses the dialog root first
  const focused = useRef(false);
  useEffect(() => {
    if (showForm && !focused.current) {
      focused.current = true;
      firstRadioRef.current?.focus({ preventScroll: true });
    }
  }, [showForm]);

  const focusCancel = () => requestAnimationFrame(() => cancelRef.current?.focus());
  const focusHistory = () => requestAnimationFrame(() => historyRef.current?.focus());

  const requestClose = () => {
    if (sending) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      focusCancel();
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose(changed);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return;
    setShowErrors(true);
    if (errors.kind) {
      firstRadioRef.current?.focus();
      return;
    }
    if (errors.justification) {
      textRef.current?.focus();
      return;
    }
    if (errors.expiresAt) {
      dateRef.current?.focus();
      return;
    }
    if (form.kind === '') return;
    setSending(true);
    setSendError(null);
    try {
      await decisions.request({ kind: form.kind, justification: form.justification.trim(), expiresAt: form.expiresAt });
      if (!mounted.current) return;
      setChanged(true);
      setForm(EMPTY_FORM);
      setShowErrors(false);
      setAnnounce(C.sent);
      decisions.reload();
      focusHistory();
    } catch (err: unknown) {
      if (!mounted.current) return;
      const f = decisionRequestError(err);
      if (f.kind === 'session') return; // the session rescue keeps the text; nothing to show here
      setSendError(f.text);
      if (f.reload) {
        setChanged(true);
        decisions.reload();
      }
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const onChanged = () => {
    setChanged(true);
    decisions.reload();
  };

  const justId = `${uid}-just`;
  const tier = target.tier;
  const tl = tier ? tierLines(tier) : null;

  return (
    <DialogOverlay onClose={sending ? undefined : requestClose} className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-2xl rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="min-w-0 space-y-1">
            <DialogTitle as="h3" className="text-sm font-bold text-white flex items-center gap-2">
              <Scale className="w-4 h-4 text-violet-400 shrink-0" aria-hidden="true" />
              <span className="break-words">{C.dialogTitle(target.vulnId)}</span>
            </DialogTitle>
            {role && <p role="note" className="text-xs text-slate-400">{role}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={requestClose} disabled={sending} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
          <div><dt className="text-slate-400">Asset</dt><dd className="text-slate-200 break-words">{target.assetName ?? 'An asset no longer recorded'}</dd></div>
          {target.severity !== null && <div><dt className="text-slate-400">Severity</dt><dd className="text-slate-200">{SEVERITY_LABEL[target.severity]}</dd></div>}
          {tier && tl && (
            <div>
              <dt className="text-slate-400">Remediation</dt>
              <dd className="text-slate-200">
                {TIER_LABEL[tier.tier]}
                {tl.due && <span className="block text-slate-300">{tl.due}</span>}
                {tl.reason && <span className="block text-slate-400">{tl.reason}</span>}
              </dd>
            </div>
          )}
          {target.severity === null && !tier && <div><dt className="text-slate-400">Remediation</dt><dd className="text-slate-400">{NOT_REPORTED}</dd></div>}
        </dl>

        <section aria-labelledby={`${uid}-hist`} className="space-y-2 text-xs">
          <h4 id={`${uid}-hist`} ref={historyRef} tabIndex={-1} className="text-xs font-bold text-slate-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{C.historyHeading}</h4>
          {load.status === 'idle' || load.status === 'loading' ? (
            <p role="status" className="text-slate-400">{C.decisionsLoading}</p>
          ) : load.status === 'error' ? (
            <div className="flex items-center justify-between gap-3">
              <ErrorNotice message={loadErrorText('decisions', load.offline)} className="flex-1" />
              <button type="button" aria-label="Retry loading the decisions" onClick={decisions.reload} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">{C.retry}</button>
            </div>
          ) : load.status === 'ready' && list.length === 0 ? (
            <p className="text-slate-400">{C.historyNone}</p>
          ) : (
            <ul className="space-y-2">
              {list.map((d) => (
                <VmDecisionCard
                  key={d.id}
                  decision={d}
                  ctx={{ vulnId: target.vulnId, assetName: target.assetName }}
                  showFinding={false}
                  role={currentRole}
                  nowMs={openedAt}
                  onAct={async (a) => { await decisions.act(d.id, a); }}
                  onDone={(text) => { setAnnounce(text); onChanged(); focusHistory(); }}
                  onReloadNeeded={onChanged}
                />
              ))}
            </ul>
          )}
          <p role="status" aria-live="polite" className="text-emerald-300">{announce}</p>
        </section>

        {load.status === 'ready' && writer && (
          <section aria-labelledby={`${uid}-req`} className="space-y-2.5 border-t border-slate-800 pt-4 text-xs">
            <h4 id={`${uid}-req`} className="text-xs font-bold text-slate-200">{C.requestHeading}</h4>
            {notOpen ? (
              <p role="note" className="text-slate-400">{C.notOpen}</p>
            ) : hasPending ? (
              <p role="note" className="text-slate-400">{C.pendingBlock}</p>
            ) : (
              <form onSubmit={(e) => { void submit(e); }} noValidate aria-busy={sending} className="space-y-3.5">
                <fieldset aria-describedby={shown.kind ? `${uid}-kind-err` : undefined} className="space-y-2">
                  <legend className={labelClass}>{C.kindLegend}</legend>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {KINDS.map((k, i) => {
                      const selected = form.kind === k.kind;
                      const radioId = `${uid}-kind-${k.kind}`;
                      return (
                        <label
                          key={k.kind}
                          htmlFor={radioId}
                          className={`flex items-start gap-2 rounded-xl border p-3 text-xs cursor-pointer ${selected ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/60'}`}
                        >
                          <input
                            id={radioId}
                            ref={i === 0 ? firstRadioRef : undefined}
                            type="radio"
                            name={`${uid}-kind`}
                            value={k.kind}
                            checked={selected}
                            disabled={sending}
                            onChange={() => setForm((f) => ({ ...f, kind: k.kind }))}
                            aria-describedby={`${radioId}-note`}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block font-bold text-slate-200">{k.label}</span>
                            <span id={`${radioId}-note`} className="block text-slate-400">{k.note}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {shown.kind && <p id={`${uid}-kind-err`} className="text-xs text-rose-300">{shown.kind}</p>}
                </fieldset>

                <div>
                  <label htmlFor={justId} className={labelClass}>{C.justificationLabel}</label>
                  <textarea
                    id={justId}
                    ref={textRef}
                    rows={6}
                    maxLength={VM_DECISION_JUSTIFICATION_MAX}
                    disabled={sending}
                    value={form.justification}
                    onChange={(e) => setForm((f) => ({ ...f, justification: e.target.value }))}
                    aria-invalid={shown.justification ? true : undefined}
                    aria-describedby={join([`${justId}-hint`, `${justId}-count`, shown.justification && `${justId}-err`])}
                    className={`${inputClass} resize-y`}
                  />
                  <p id={`${justId}-hint`} className="mt-1 text-xs text-slate-400">{C.justificationHint}</p>
                  <p id={`${justId}-count`} className={`mt-1 text-xs text-right font-mono ${justificationLength(form.justification) > 3800 ? 'text-amber-300' : 'text-slate-400'}`}>
                    {justificationLength(form.justification)} / {VM_DECISION_JUSTIFICATION_MAX}
                  </p>
                  {shown.justification && <p id={`${justId}-err`} className="mt-1 text-xs text-rose-300">{shown.justification}</p>}
                </div>

                <div>
                  <label htmlFor={`${uid}-date`} className={labelClass}>{C.expiresLabel}</label>
                  <input
                    id={`${uid}-date`}
                    ref={dateRef}
                    type="date"
                    min={bounds.min}
                    max={bounds.max}
                    disabled={sending}
                    value={form.expiresAt}
                    onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
                    aria-invalid={shown.expiresAt ? true : undefined}
                    aria-describedby={join([`${uid}-date-hint`, shown.expiresAt && `${uid}-date-err`])}
                    className={`${inputClass} font-mono max-w-[12rem]`}
                  />
                  <p id={`${uid}-date-hint`} className="mt-1 text-xs text-slate-400">{C.expiresHint(bounds.min, bounds.max)}</p>
                  {shown.expiresAt && <p id={`${uid}-date-err`} className="mt-1 text-xs text-rose-300">{shown.expiresAt}</p>}
                </div>

                <p className="text-slate-300">{C.approvalHint}</p>
                {note && <p role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">{note}</p>}
                <ErrorNotice message={sendError} />

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
                    <p id={`${uid}-discard`} className="text-amber-200">{C.discardRequest}</p>
                    <div className="flex justify-end gap-2.5">
                      <button type="button" autoFocus onClick={() => { setConfirmDiscard(false); focusCancel(); }} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">{C.keepEditing}</button>
                      <button type="button" onClick={() => onClose(changed)} className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 hover:bg-rose-900/50">{C.discardRequestButton}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2.5">
                    <button ref={cancelRef} type="button" onClick={requestClose} disabled={sending} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50">{C.cancel}</button>
                    <button
                      type="submit"
                      disabled={sending}
                      className="px-5 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-500 rounded-xl shadow-lg shadow-brand-500/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                    >
                      {sending && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                      {sending ? C.sending : C.send}
                    </button>
                  </div>
                )}
              </form>
            )}
          </section>
        )}

        {!showForm && (
          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button ref={cancelRef} type="button" onClick={requestClose} className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors">{C.close}</button>
          </div>
        )}
      </div>
    </DialogOverlay>
  );
};
