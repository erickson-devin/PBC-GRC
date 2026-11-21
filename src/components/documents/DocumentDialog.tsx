import React, { useId, useRef, useState } from 'react';
import { Archive, ArchiveRestore, BadgeCheck, FilePenLine, FileStack, Undo2, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { DOCUMENT_KINDS, type DocumentInput, type GovernanceDocument } from '../../types/documents';
import {
  DOCUMENT_UI_TEXT,
  KIND_HINTS,
  KIND_LABELS,
  approvalWillClear,
  documentErrorMessage,
  documentFormFrom,
  locationMessage,
  rebaseDocumentForm,
  statusChip,
  validateDocumentForm,
  type DocumentForm,
  type DocumentFormField,
} from '../../data/documents/documentUiView';
import { classifyLocation } from '../../data/documents/documentSchema';
import { DocumentLocation } from './DocumentLocation';

export interface DocumentSaveOptions {
  expectedUpdatedAt?: string;
  addToProgram: boolean;
  linkControlIds: string[];
}

interface DocumentDialogProps {
  /** The document being edited, or null to add one. */
  initial: GovernanceDocument | null;
  /** Values for a new document (used only when `initial` is null): the checklist's Register action fills in the title and kind. */
  prefill?: Partial<DocumentForm>;
  programName: string | null;
  /** The open program is loaded, declares its documents and is writable: offer to add a new document to it (add mode only). */
  offerProgram: boolean;
  /** From the checklist: the expected document being registered and the controls it suggests (all ticked; the person confirms). */
  linkOffer?: { entryName: string; controls: { id: string; displayId: string; title: string }[] };
  /** Whether the document has a primary copy in the open program (kept for the caller; the status block does not need it). */
  primaryInProgram: boolean;
  canEdit: boolean;
  /** Saves the document; rejects with the ApiError when the server refuses it (the dialog then stays open). */
  onSave: (input: DocumentInput & { origin?: 'AI_ASSISTED' }, opts: DocumentSaveOptions) => Promise<void>;
  /** Changes the status (reinstate, retire, withdraw approval); resolves to the document as it is now. */
  onStatus: (s: 'DRAFT' | 'RETIRED') => Promise<GovernanceDocument | void>;
  /** Opens the approval dialog (stacked over this one). */
  onApprove: () => void;
  /** The document as the register holds it now (after a reload), or null when it is gone. */
  latest: (id: string) => GovernanceDocument | null;
  onClose: () => void;
}

const inputClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const conflictClass = 'border-amber-500/60';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';
const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const CHIP = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border';
const TONE = {
  emerald: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  amber: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  slate: 'bg-slate-800 border-slate-700 text-slate-300',
} as const;
const NOTES_MAX = 4000;

/** Add / edit dialog of the Document Register, with the status block (approve, withdraw, retire, reinstate). Titles, owners, locations and notes may be CUI: nothing here is logged or stored in the browser. */
export const DocumentDialog: React.FC<DocumentDialogProps> = ({
  initial, prefill, programName, offerProgram, linkOffer, canEdit, onSave, onStatus, onApprove, latest, onClose,
}) => {
  const [form, setForm] = useState<DocumentForm>(() => documentFormFrom(initial, prefill));
  const [base, setBase] = useState<GovernanceDocument | null>(initial);
  const [errors, setErrors] = useState<Partial<Record<DocumentFormField, string>>>({});
  const [conflicts, setConflicts] = useState<DocumentFormField[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addToProgram, setAddToProgram] = useState(false);
  const [linkIds, setLinkIds] = useState<Set<string>>(() => new Set(linkOffer?.controls.map((c) => c.id) ?? []));
  const [confirm, setConfirm] = useState<'withdraw' | 'retire' | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const refs = useRef(new Map<DocumentFormField, HTMLElement>());
  const bannerRef = useRef<HTMLDivElement>(null);
  const confirmTriggers = useRef(new Map<string, HTMLButtonElement>());
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;
  const hint = (k: string): string => `${uid}-${k}-hint`;
  const err = (k: string): string => `${uid}-${k}-err`;

  const editing = base !== null;
  const initialForm = documentFormFrom(base);
  const dirty = editing && (Object.keys(initialForm) as (keyof DocumentForm)[]).some((k) => k !== 'aiAssisted' && String(form[k]).trim() !== String(initialForm[k]).trim());
  const willClear = approvalWillClear(base, form);
  const locationNow = locationMessage(form.locationUrl);
  const [locationTouched, setLocationTouched] = useState(false);
  const locationShown = classifyLocation(form.locationUrl).ok && base !== null && form.locationUrl.trim() === (base.locationUrl ?? '').trim();

  const setField = <K extends keyof DocumentForm>(k: K, v: DocumentForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const reg = (k: DocumentFormField) => (el: HTMLElement | null) => {
    if (el) refs.current.set(k, el);
    else refs.current.delete(k);
  };
  const describedBy = (k: DocumentFormField, extra?: string): string | undefined => {
    const ids = [extra, errors[k] ? err(k) : undefined].filter(Boolean).join(' ');
    return ids || undefined;
  };
  const fieldClass = (k: DocumentFormField, extra = ''): string => `${inputClass} ${extra} ${conflicts.includes(k) ? conflictClass : ''}`.replace(/\s+/g, ' ').trim();
  const fieldNote = (k: DocumentFormField): React.ReactNode => (
    <>
      {errors[k] && <p id={err(k)} role="alert" className="mt-1 text-rose-300">{errors[k]}</p>}
      {conflicts.includes(k) && <p className="mt-1 text-amber-300">{DOCUMENT_UI_TEXT.conflictField}</p>}
    </>
  );

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || gone) return;
    const res = validateDocumentForm(form, editing ? 'edit' : 'add');
    setErrors(res.errors);
    if (!res.input) {
      const order = Array.from(refs.current.keys());
      const first = order.find((k) => res.errors[k]);
      if (first) refs.current.get(first)?.focus();
      return;
    }
    setBanner(null);
    setSaving(true);
    try {
      await onSave(res.input, { expectedUpdatedAt: base?.updatedAt, addToProgram: !base && offerProgram && addToProgram, linkControlIds: !base && linkOffer ? [...linkIds] : [] });
      onClose();
    } catch (error: unknown) {
      const reason = (error as { reason?: unknown } | null)?.reason;
      const field = (error as { field?: unknown } | null)?.field;
      if (reason === 'stale_write' && base) {
        const now = latest(base.id);
        if (!now) {
          setGone(true);
          setBanner(DOCUMENT_UI_TEXT.documentGone);
        } else {
          const merged = rebaseDocumentForm(base, now, form);
          setForm(merged.form);
          setConflicts(merged.conflicts);
          setBase(now);
          setBanner(DOCUMENT_UI_TEXT.staleDocument);
        }
        setTimeout(() => bannerRef.current?.focus(), 0);
      } else if (reason === 'duplicate_title') {
        setErrors({ title: documentErrorMessage(error, 'save') });
        refs.current.get('title')?.focus();
      } else if (reason === 'invalid_location') {
        setErrors({ locationUrl: documentErrorMessage(error, 'save') });
        refs.current.get('locationUrl')?.focus();
      } else if (typeof field === 'string' && (field as DocumentFormField) in form && field !== 'aiAssisted') {
        setErrors({ [field]: 'The server did not accept this value.' });
        refs.current.get(field as DocumentFormField)?.focus();
      } else {
        setBanner(documentErrorMessage(error, 'save', programName ?? undefined));
      }
      setSaving(false);
    }
  };

  const runStatus = async (next: 'DRAFT' | 'RETIRED', done: string): Promise<void> => {
    if (!base || saving) return;
    setSaving(true);
    setBanner(null);
    setStatusMsg('');
    try {
      const updated = await onStatus(next);
      const now = (updated as GovernanceDocument | undefined) ?? latest(base.id);
      if (now) {
        setBase(now);
        setForm(documentFormFrom(now));
        setConflicts([]);
        setErrors({});
      }
      setConfirm(null);
      setStatusMsg(done);
    } catch (error: unknown) {
      const reason = (error as { reason?: unknown } | null)?.reason;
      if (reason === 'stale_write') {
        const now = latest(base.id);
        if (now) {
          setBase(now);
          setForm(documentFormFrom(now));
        } else setGone(true);
      }
      setConfirm(null);
      setBanner(documentErrorMessage(error, 'status', programName ?? undefined));
      setTimeout(() => bannerRef.current?.focus(), 0);
    } finally {
      setSaving(false);
    }
  };

  const cancelConfirm = (): void => {
    const which = confirm;
    setConfirm(null);
    setTimeout(() => (which ? confirmTriggers.current.get(which)?.focus() : undefined), 0);
  };

  const chip = base ? statusChip(base) : null;
  const statusId = id('status');
  const statusBlocked = dirty || saving || gone;
  const statusButtonProps = (key: string) => ({
    disabled: statusBlocked,
    'aria-describedby': dirty ? id('dirty') : undefined,
    ref: (el: HTMLButtonElement | null) => {
      if (el) confirmTriggers.current.set(key, el);
      else confirmTriggers.current.delete(key);
    },
  });
  const notesLength = form.notes.length;

  return (
    <DialogOverlay onClose={saving ? undefined : onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={saving ? undefined : onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[85vh] overflow-y-auto text-xs">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <FileStack className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">{initial ? 'Edit document' : 'Add document'}</DialogTitle>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div ref={bannerRef} tabIndex={-1} className="outline-none">
          <ErrorNotice message={banner} />
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
          <div>
            <label htmlFor={id('title')} className={labelClass}>
              Title <span className="text-rose-400">*</span>
            </label>
            <input
              id={id('title')}
              ref={reg('title')}
              autoFocus
              type="text"
              value={form.title}
              maxLength={255}
              onChange={(e) => setField('title', e.target.value)}
              aria-required="true"
              aria-invalid={errors.title ? true : undefined}
              aria-describedby={describedBy('title')}
              placeholder="e.g. Access Control Policy"
              className={fieldClass('title')}
            />
            {fieldNote('title')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={id('kind')} className={labelClass}>
                Kind <span className="text-rose-400">*</span>
              </label>
              <select
                id={id('kind')}
                ref={reg('kind')}
                value={form.kind}
                onChange={(e) => setField('kind', e.target.value as DocumentForm['kind'])}
                aria-required="true"
                aria-invalid={errors.kind ? true : undefined}
                aria-describedby={describedBy('kind', hint('kind'))}
                className={fieldClass('kind')}
              >
                <option value="">Choose a kind</option>
                {DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
              <p id={hint('kind')} className="mt-1 text-slate-400">{form.kind ? KIND_HINTS[form.kind] : 'Plans, policies, procedures, processes, reference documents, reviews and artifacts.'}</p>
              {fieldNote('kind')}
            </div>
            <div>
              <label htmlFor={id('reference')} className={labelClass}>
                Reference <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={id('reference')}
                ref={reg('reference')}
                type="text"
                value={form.reference}
                maxLength={64}
                onChange={(e) => setField('reference', e.target.value)}
                aria-describedby={describedBy('reference')}
                placeholder="e.g. POL-AC-01"
                className={fieldClass('reference', 'font-mono')}
              />
              {fieldNote('reference')}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor={id('owner')} className={labelClass}>
                Owner <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={id('owner')}
                ref={reg('owner')}
                type="text"
                value={form.owner}
                maxLength={255}
                onChange={(e) => setField('owner', e.target.value)}
                aria-describedby={describedBy('owner')}
                placeholder="Person or role, e.g. ISSO"
                className={fieldClass('owner')}
              />
              {fieldNote('owner')}
            </div>
            <div>
              <label htmlFor={id('version')} className={labelClass}>
                Version <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                id={id('version')}
                ref={reg('version')}
                type="text"
                value={form.version}
                maxLength={32}
                onChange={(e) => setField('version', e.target.value)}
                aria-describedby={describedBy('version')}
                placeholder="e.g. 1.0"
                className={fieldClass('version', 'font-mono')}
              />
              {fieldNote('version')}
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
                aria-describedby={describedBy('reviewBy', hint('reviewBy'))}
                className={fieldClass('reviewBy')}
              />
              <p id={hint('reviewBy')} className="mt-1 text-slate-400">{DOCUMENT_UI_TEXT.reviewByHint}</p>
              {fieldNote('reviewBy')}
            </div>
          </div>

          <div>
            <label htmlFor={id('locationUrl')} className={labelClass}>
              Internal location <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <input
              id={id('locationUrl')}
              ref={reg('locationUrl')}
              type="text"
              value={form.locationUrl}
              maxLength={2048}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setField('locationUrl', e.target.value)}
              onBlur={() => setLocationTouched(true)}
              aria-invalid={errors.locationUrl || (locationTouched && locationNow.error) ? true : undefined}
              aria-describedby={[hint('locationUrl'), errors.locationUrl || (locationTouched && locationNow.error) ? err('locationUrl') : undefined, locationNow.recognised ? id('recognised') : undefined].filter(Boolean).join(' ')}
              placeholder="https://intranet.example/policies/ac.docx"
              className={fieldClass('locationUrl', 'font-mono')}
            />
            <p id={hint('locationUrl')} className="mt-1 text-slate-400">{DOCUMENT_UI_TEXT.locationHint}</p>
            {(errors.locationUrl || (locationTouched && locationNow.error)) && (
              <p id={err('locationUrl')} role="alert" className="mt-1 text-rose-300">{errors.locationUrl ?? locationNow.error}</p>
            )}
            {locationNow.recognised && !locationNow.error && <p id={id('recognised')} className="mt-1 text-[11px] text-slate-400">{locationNow.recognised}</p>}
            {locationShown && (
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-slate-300">
                <span>Shown as:</span>
                <DocumentLocation value={form.locationUrl.trim()} />
              </p>
            )}
            {conflicts.includes('locationUrl') && <p className="mt-1 text-amber-300">{DOCUMENT_UI_TEXT.conflictField}</p>}
          </div>

          <div>
            <label htmlFor={id('notes')} className={labelClass}>
              Notes <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <textarea
              id={id('notes')}
              ref={reg('notes')}
              rows={3}
              value={form.notes}
              maxLength={NOTES_MAX}
              onChange={(e) => setField('notes', e.target.value)}
              aria-describedby={describedBy('notes', hint('notes'))}
              className={fieldClass('notes')}
            />
            <div className="mt-1 flex justify-between gap-3 text-slate-400">
              <p id={hint('notes')}>{DOCUMENT_UI_TEXT.notesHint}</p>
              <span aria-hidden="true">{`${notesLength} / 4,000`}</span>
            </div>
            {fieldNote('notes')}
          </div>

          {!editing && (
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.aiAssisted}
                  onChange={(e) => setField('aiAssisted', e.target.checked)}
                  aria-describedby={id('ai-hint')}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="font-semibold">{DOCUMENT_UI_TEXT.aiAssistedLabel}</span>
              </label>
              <p id={id('ai-hint')} className="pl-6 text-slate-400">{DOCUMENT_UI_TEXT.aiAssistedHint}</p>
            </div>
          )}

          {!editing && offerProgram && programName && (
            <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
              <input type="checkbox" checked={addToProgram} onChange={(e) => setAddToProgram(e.target.checked)} className="accent-cyan-500" />
              <span>{`Also add it to ${programName}`}</span>
            </label>
          )}

          {!editing && linkOffer && programName && (
            <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
              <legend className="px-1 font-semibold text-slate-300">{`Link to controls in ${programName}`}</legend>
              <p className="text-slate-400">{`It will be linked to the expected document "${linkOffer.entryName}". These controls are suggested by the checklist; untick any that do not apply.`}</p>
              <ul className="space-y-1">
                {linkOffer.controls.map((c) => (
                  <li key={c.id}>
                    <label className="flex items-start gap-2 text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={linkIds.has(c.id)}
                        onChange={(e) =>
                          setLinkIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          })
                        }
                        className="mt-0.5 accent-cyan-500"
                      />
                      <span>
                        <span className="font-mono text-slate-300">{c.displayId}</span> {c.title}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}

          {willClear && (
            <p role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">{DOCUMENT_UI_TEXT.approvalWillClear}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>Cancel</button>
            <button type="submit" disabled={saving || gone || !canEdit} className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
              <span>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add document'}</span>
            </button>
          </div>
        </form>

        {editing && base && chip && canEdit && (
          <section aria-labelledby={statusId} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
            <h3 id={statusId} className="font-semibold text-slate-300">Status</h3>
            <p className="flex flex-wrap items-center gap-2 text-slate-300">
              <span className={`${CHIP} ${TONE[chip.tone]}`}>
                {base.status === 'APPROVED' ? <BadgeCheck className="w-3 h-3" aria-hidden="true" /> : base.status === 'RETIRED' ? <Archive className="w-3 h-3" aria-hidden="true" /> : <FilePenLine className="w-3 h-3" aria-hidden="true" />}
                {chip.text}
              </span>
              {base.status === 'APPROVED' && base.approvalDate && (
                <span>{`Approved ${base.approvalDate}${base.approvedBy ? ` by ${base.approvedBy}` : ''}${base.version ? `, version ${base.version}` : ''}.`}</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {base.status === 'DRAFT' && (
                <button type="button" aria-haspopup="dialog" onClick={onApprove} className={secondaryButton} {...statusButtonProps('approve')}>
                  <BadgeCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>Approve…</span>
                </button>
              )}
              {base.status === 'APPROVED' && (
                <button type="button" aria-expanded={confirm === 'withdraw'} onClick={() => setConfirm('withdraw')} className={secondaryButton} {...statusButtonProps('withdraw')}>
                  <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Withdraw approval</span>
                </button>
              )}
              {base.status !== 'RETIRED' && (
                <button type="button" aria-expanded={confirm === 'retire'} onClick={() => setConfirm('retire')} className={secondaryButton} {...statusButtonProps('retire')}>
                  <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Retire</span>
                </button>
              )}
              {base.status === 'RETIRED' && (
                <button type="button" onClick={() => void runStatus('DRAFT', 'Reinstated as a draft.')} className={secondaryButton} {...statusButtonProps('reinstate')}>
                  <ArchiveRestore className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Reinstate as draft</span>
                </button>
              )}
            </div>
            {dirty && <p id={id('dirty')} className="text-slate-400">{DOCUMENT_UI_TEXT.dirtyStatus}</p>}
            {confirm && (
              <div
                role="group"
                aria-label={confirm === 'withdraw' ? 'Withdraw the approval?' : 'Retire this document?'}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/70 p-3"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    cancelConfirm();
                  }
                }}
              >
                <span className="flex-1 min-w-[14rem] text-slate-200">{confirm === 'withdraw' ? DOCUMENT_UI_TEXT.withdrawConfirm : DOCUMENT_UI_TEXT.retireConfirm}</span>
                <button type="button" disabled={saving} onClick={cancelConfirm} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50">Cancel</button>
                <button
                  type="button"
                  autoFocus
                  disabled={saving}
                  onClick={() => void (confirm === 'withdraw' ? runStatus('DRAFT', 'Approval withdrawn.') : runStatus('RETIRED', 'Document retired.'))}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50"
                >
                  {confirm === 'withdraw' ? 'Withdraw approval' : 'Retire document'}
                </button>
              </div>
            )}
            <p role="status" className={statusMsg ? 'text-emerald-300' : 'sr-only'}>{statusMsg}</p>
          </section>
        )}
      </div>
    </DialogOverlay>
  );
};

export default DocumentDialog;
