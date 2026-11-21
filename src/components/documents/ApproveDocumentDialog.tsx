import React, { useId, useRef, useState } from 'react';
import { BadgeCheck, FileWarning, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  DOCUMENT_UI_TEXT,
  ORIGIN_BADGE,
  addYearsIso,
  approveFormFrom,
  documentErrorMessage,
  needsReviewConfirmation,
  validateApproveForm,
  type ApproveForm,
} from '../../data/documents/documentUiView';
import { localDateIso } from '../../data/inventory/inventoryUiView';
import { isRealDate } from '../../data/documents/documentSchema';
import type { GovernanceDocument } from '../../types/documents';

export type ApproveValue = NonNullable<ReturnType<typeof validateApproveForm>['value']>;

interface ApproveDocumentDialogProps {
  doc: GovernanceDocument;
  programName: string | null;
  /** Whether the document has a primary copy (a file or a location) in the open program; null when no program is open. */
  hasPrimaryInProgram: boolean | null;
  /** Opened over the edit dialog: drawn above it. */
  stacked: boolean;
  /** Approves the document; rejects with the ApiError (the dialog then stays open). */
  onApprove: (value: ApproveValue) => Promise<void>;
  onClose: () => void;
}

type ApproveField = 'version' | 'approvalDate' | 'reviewBy' | 'reviewed';

const inputClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * Approves a document: the version being approved, the approval date and the next review. The approver is the signed-in person (the server takes it from
 * the session). Generated and AI-assisted text is approved only after an explicit confirmation that a person reviewed and edited it.
 */
export const ApproveDocumentDialog: React.FC<ApproveDocumentDialogProps> = ({ doc, programName, hasPrimaryInProgram, stacked, onApprove, onClose }) => {
  const today = localDateIso(new Date());
  const untrusted = needsReviewConfirmation(doc);
  const [form, setForm] = useState<ApproveForm>(() => approveFormFrom(doc, today));
  const [errors, setErrors] = useState<Partial<Record<ApproveField, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const refs = useRef(new Map<ApproveField, HTMLElement>());
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const err = (k: string): string => `${uid}-${k}-err`;
  const reg = (k: ApproveField) => (el: HTMLElement | null) => {
    if (el) refs.current.set(k, el);
    else refs.current.delete(k);
  };
  const setField = <K extends keyof ApproveForm>(k: K, v: ApproveForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const fieldError = (k: ApproveField): React.ReactNode => (errors[k] ? <p id={err(k)} role="alert" className="mt-1 text-rose-300">{errors[k]}</p> : null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    const res = validateApproveForm(form, today, untrusted);
    setErrors(res.errors);
    if (!res.value) {
      const order: ApproveField[] = ['reviewed', 'version', 'approvalDate', 'reviewBy'];
      const first = order.find((k) => res.errors[k]);
      if (first) refs.current.get(first)?.focus();
      return;
    }
    setBanner(null);
    setSaving(true);
    try {
      await onApprove(res.value);
      onClose();
    } catch (error: unknown) {
      const reason = (error as { reason?: unknown } | null)?.reason;
      if (reason === 'not_reviewed') {
        setErrors({ reviewed: DOCUMENT_UI_TEXT.reviewedRequired });
        refs.current.get('reviewed')?.focus();
      } else if (reason === 'stale_write') {
        setBanner('This document changed while the dialog was open. Nothing was approved. Close it, check the document, and approve again.');
      } else {
        setBanner(documentErrorMessage(error, 'approve', programName ?? undefined));
      }
      setSaving(false);
    }
  };

  const reviewedId = id('reviewed');
  const reviewedErrId = err('reviewed');
  const suggestion = isRealDate(form.approvalDate.trim()) && form.reviewBy.trim() === '' ? addYearsIso(form.approvalDate.trim(), 1) : null;

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className={`fixed inset-0 ${stacked ? 'z-[60]' : 'z-50'} flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn`}>
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
              <BadgeCheck className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">Approve document</DialogTitle>
              <p className="text-xs text-slate-300 font-semibold mt-0.5">{doc.title}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <ErrorNotice message={banner} />

        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4 text-xs">
          {untrusted && (doc.origin === 'GENERATED' || doc.origin === 'AI_ASSISTED') && (
            <div role="note" className="rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-500/10 p-3 space-y-2 text-amber-100">
              <p className="flex items-center gap-1.5 font-semibold text-amber-300">
                <FileWarning className="w-4 h-4" aria-hidden="true" />
                {ORIGIN_BADGE[doc.origin]}
              </p>
              <p>{DOCUMENT_UI_TEXT.reviewNeeded.replace('{origin}', doc.origin === 'GENERATED' ? 'generated text' : 'AI-assisted text')}</p>
              <label htmlFor={reviewedId} className="flex items-start gap-2 cursor-pointer">
                <input
                  id={reviewedId}
                  ref={reg('reviewed')}
                  type="checkbox"
                  checked={form.reviewed}
                  onChange={(e) => setField('reviewed', e.target.checked)}
                  aria-required="true"
                  aria-invalid={errors.reviewed ? true : undefined}
                  aria-describedby={errors.reviewed ? reviewedErrId : undefined}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="font-semibold">{DOCUMENT_UI_TEXT.reviewedLabel}</span>
              </label>
              {errors.reviewed && <p id={reviewedErrId} role="alert" className="text-rose-300">{errors.reviewed}</p>}
            </div>
          )}

          <div>
            <label htmlFor={id('version')} className={labelClass}>
              Version <span className="text-rose-400">*</span>
            </label>
            <input
              id={id('version')}
              ref={reg('version')}
              autoFocus={!untrusted}
              type="text"
              value={form.version}
              maxLength={32}
              onChange={(e) => setField('version', e.target.value)}
              aria-required="true"
              aria-invalid={errors.version ? true : undefined}
              aria-describedby={errors.version ? err('version') : undefined}
              placeholder="e.g. 1.0"
              className={`${inputClass} font-mono`}
            />
            {fieldError('version')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('approvalDate')} className={labelClass}>
                Approval date <span className="text-rose-400">*</span>
              </label>
              <input
                id={id('approvalDate')}
                ref={reg('approvalDate')}
                type="date"
                value={form.approvalDate}
                max={today}
                onChange={(e) => setField('approvalDate', e.target.value)}
                aria-required="true"
                aria-invalid={errors.approvalDate ? true : undefined}
                aria-describedby={errors.approvalDate ? err('approvalDate') : undefined}
                className={inputClass}
              />
              {fieldError('approvalDate')}
            </div>
            <div>
              <label htmlFor={id('reviewBy')} className={labelClass}>
                Review by <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={id('reviewBy')}
                ref={reg('reviewBy')}
                type="date"
                value={form.reviewBy}
                onChange={(e) => setField('reviewBy', e.target.value)}
                aria-invalid={errors.reviewBy ? true : undefined}
                aria-describedby={errors.reviewBy ? err('reviewBy') : undefined}
                className={inputClass}
              />
              {suggestion && (
                <button
                  type="button"
                  onClick={() => setField('reviewBy', suggestion)}
                  className="mt-1 text-cyan-300 hover:text-cyan-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded"
                >
                  {`Suggest ${suggestion}`}
                </button>
              )}
              {fieldError('reviewBy')}
            </div>
          </div>

          <p className="text-slate-300">{DOCUMENT_UI_TEXT.approverLine}</p>

          {hasPrimaryInProgram === false && programName && (
            <p role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
              {DOCUMENT_UI_TEXT.noCopyOnApprove.replace('{program}', programName)}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
              <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{saving ? 'Approving…' : 'Approve document'}</span>
            </button>
          </div>
        </form>
      </div>
    </DialogOverlay>
  );
};

export default ApproveDocumentDialog;
