import React, { useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileCheck2, Paperclip, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAssessment } from '../../context/AssessmentContext';
import { useProgramInventory } from '../../hooks/useProgramInventory';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import {
  DOC_KIND_LABELS,
  VENDOR_UI_TEXT,
  docRows,
  evidenceChoices,
  suggestedVendorDocControl,
  uploadLinkFailedText,
  vendorErrorMessage,
} from '../../data/inventory/vendorRegisterView';
import { VENDOR_DOCUMENT_KINDS, type InventoryVendor, type VendorDocumentKind, type VendorDocumentLink } from '../../types/inventory';

interface VendorDocumentsDialogProps {
  vendor: InventoryVendor;
  programName: string;
  framework: string;
  /** The document links of the open program (all vendors). */
  links: VendorDocumentLink[];
  canEdit: boolean;
  onClose: () => void;
}

type Source = 'existing' | 'upload';

const fieldClass = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';
const labelClass = 'block font-semibold text-slate-300 mb-1.5';
const confirmButton = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50';

/**
 * The documents linked to one vendor in the open program (#248). Each document is an Evidence Vault file of that program: attaching picks an
 * existing file or uploads one through the ordinary evidence upload (filed under a control, with a fixed description). File names are shown but
 * never logged or stored by this screen.
 */
export const VendorDocumentsDialog: React.FC<VendorDocumentsDialogProps> = ({ vendor, programName, framework, links, canEdit, onClose }) => {
  const { state, frameworkControls, uploadEvidence, setPreviewEvidence } = useAssessment();
  const inv = useProgramInventory();
  const uid = useId();
  const id = (k: string): string => `${uid}-${k}`;

  const [docKind, setDocKind] = useState<VendorDocumentKind>('CRM');
  const [source, setSource] = useState<Source>('existing');
  const [evidenceId, setEvidenceId] = useState('');
  const catalogIds = useMemo(() => new Set(frameworkControls.map((c) => c.id)), [frameworkControls]);
  const suggested = suggestedVendorDocControl(framework, catalogIds);
  const [controlId, setControlId] = useState(suggested ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);

  const kindRef = useRef<HTMLSelectElement>(null);
  const unlinkButtons = useRef(new Map<string, HTMLButtonElement>());

  const displayId = (cid: string): string => cmmcDisplayId(cid, framework);
  const choices = useMemo(() => evidenceChoices(state.evidenceIndex), [state.evidenceIndex]);
  const rows = useMemo(() => docRows(links, vendor.id, state.evidenceIndex), [links, vendor.id, state.evidenceIndex]);
  const linkedIds = useMemo(() => new Set(rows.map((r) => r.evidenceId)), [rows]);

  const complete = source === 'existing' ? evidenceId !== '' : controlId !== '' && file !== null;

  const open = (evId: string): void => {
    const item = state.evidenceIndex.find((e) => e.id === evId);
    if (item) setPreviewEvidence(item);
  };

  const cancelUnlink = (evId: string): void => {
    setPendingUnlink(null);
    setTimeout(() => unlinkButtons.current.get(evId)?.focus(), 0);
  };

  const confirmUnlink = async (evId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await inv.unlinkDocument(vendor.id, evId);
      setPendingUnlink(null);
      setStatus('Document unlinked.');
      setTimeout(() => kindRef.current?.focus(), 0);
    } catch (err: unknown) {
      setError(vendorErrorMessage(err, 'unlink'));
      if ((err as { reason?: unknown } | null)?.reason === 'not_found') setPendingUnlink(null);
    } finally {
      setBusy(false);
    }
  };

  const attach = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    setStatus('');
    let linkedEvidenceId = evidenceId;
    let uploaded = false;
    try {
      if (source === 'upload' && file) {
        const ev = await uploadEvidence(controlId, file, 'Vendor document');
        linkedEvidenceId = ev.id;
        uploaded = true;
      }
      await inv.linkDocument(vendor.id, linkedEvidenceId, docKind);
      setStatus('Document linked.');
      setEvidenceId('');
      setFile(null);
      setFileKey((k) => k + 1);
      setTimeout(() => kindRef.current?.focus(), 0);
    } catch (err: unknown) {
      setError(uploaded ? uploadLinkFailedText(displayId(controlId)) : vendorErrorMessage(err, source === 'upload' ? 'upload' : 'link'));
      if (uploaded) {
        setFile(null);
        setFileKey((k) => k + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogOverlay onClose={busy ? undefined : onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <FileCheck2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">{`Documents: ${vendor.name}`}</DialogTitle>
              <p className="text-xs text-slate-400 mt-0.5">{`In ${programName} (${frameworkLabel(framework)}). ${VENDOR_UI_TEXT.docsIntro}`}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <ErrorNotice message={error} />
        {status && (
          <div role="status" className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span>{status}</span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-slate-400">{VENDOR_UI_TEXT.docsEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.evidenceId} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300">{DOC_KIND_LABELS[r.docKind]}</span>
                  {r.missing ? (
                    <span className="flex-1 min-w-0 text-amber-300">{VENDOR_UI_TEXT.docsRemoved}</span>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 truncate font-semibold text-white" title={r.name ?? undefined}>{r.name}</span>
                      <span className="font-mono text-slate-400">{r.controlId ? displayId(r.controlId) : ''}</span>
                    </>
                  )}
                  {!r.missing && (
                    <button
                      type="button"
                      aria-label={`Open ${r.name ?? 'file'}`}
                      onClick={() => open(r.evidenceId)}
                      className="px-2 py-1 rounded-lg text-cyan-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                    >
                      Open
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Unlink ${r.name ?? 'removed file'}`}
                      aria-expanded={pendingUnlink === r.evidenceId}
                      ref={(el) => {
                        if (el) unlinkButtons.current.set(r.evidenceId, el);
                        else unlinkButtons.current.delete(r.evidenceId);
                      }}
                      disabled={busy}
                      onClick={() => setPendingUnlink(r.evidenceId)}
                      className="px-2 py-1 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                    >
                      Unlink
                    </button>
                  )}
                </div>
                {pendingUnlink === r.evidenceId && (
                  <div
                    role="group"
                    aria-label="Unlink this document?"
                    className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        cancelUnlink(r.evidenceId);
                      }
                    }}
                  >
                    <span className="flex-1 min-w-[14rem] text-slate-200">{VENDOR_UI_TEXT.unlinkConfirm}</span>
                    <button type="button" disabled={busy} onClick={() => cancelUnlink(r.evidenceId)} className={confirmButton}>Cancel</button>
                    <button type="button" autoFocus disabled={busy} onClick={() => void confirmUnlink(r.evidenceId)} className="btn-danger px-3 py-1 rounded-lg text-xs disabled:opacity-50">Unlink</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form onSubmit={(e) => void attach(e)} noValidate className="text-xs">
            <fieldset className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
              <legend className="px-1 font-semibold text-slate-300">Attach a document</legend>
              <div>
                <label htmlFor={id('kind')} className={labelClass}>Document type</label>
                <select ref={kindRef} id={id('kind')} value={docKind} onChange={(e) => setDocKind(e.target.value as VendorDocumentKind)} className={fieldClass}>
                  {VENDOR_DOCUMENT_KINDS.map((k) => (
                    <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>
                  ))}
                </select>
              </div>

              <fieldset>
                <legend className={labelClass}>Source</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(
                    [
                      ['existing', 'A file already in the Evidence Vault'],
                      ['upload', 'Upload a new file'],
                    ] as const
                  ).map(([v, text]) => (
                    <label
                      key={v}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        source === v ? 'border-cyan-500/60 bg-cyan-500/10 text-white' : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      <input type="radio" name={id('source')} value={v} checked={source === v} onChange={() => setSource(v)} className="accent-cyan-500" />
                      <span>{text}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {source === 'existing' ? (
                choices.length === 0 ? (
                  <p className="text-slate-400">This program has no evidence files yet.</p>
                ) : (
                  <div>
                    <label htmlFor={id('file')} className={labelClass}>File</label>
                    <select id={id('file')} value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} className={fieldClass}>
                      <option value="">Choose a file</option>
                      {choices.map((c) => (
                        <option key={c.id} value={c.id} disabled={linkedIds.has(c.id)}>{`${c.name} (${displayId(c.controlId)})`}</option>
                      ))}
                    </select>
                  </div>
                )
              ) : (
                <div className="space-y-3">
                  <div>
                    <label htmlFor={id('control')} className={labelClass}>File it under control</label>
                    <select id={id('control')} value={controlId} onChange={(e) => setControlId(e.target.value)} aria-describedby={id('uploadHint')} className={fieldClass}>
                      <option value="">Choose a control</option>
                      {frameworkControls.map((c) => (
                        <option key={c.id} value={c.id}>{`${displayId(c.id)} ${c.title}`}</option>
                      ))}
                    </select>
                    <p id={id('uploadHint')} className="mt-1 text-slate-400">{VENDOR_UI_TEXT.uploadHint}</p>
                  </div>
                  <div>
                    <label htmlFor={id('upload')} className={labelClass}>File to upload</label>
                    <input
                      key={fileKey}
                      id={id('upload')}
                      type="file"
                      aria-describedby={id('uploadHint')}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:text-slate-200 file:text-xs"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button type="submit" disabled={busy || !complete} className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{busy ? 'Attaching…' : 'Attach'}</span>
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </DialogOverlay>
  );
};

export default VendorDocumentsDialog;
