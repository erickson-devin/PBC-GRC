import React, { useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileCheck2, X } from 'lucide-react';
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
  suggestedVendorDocControl,
  uploadLinkFailedText,
  vendorErrorMessage,
} from '../../data/inventory/vendorRegisterView';
import { VENDOR_DOCUMENT_KINDS, type InventoryVendor, type VendorDocumentKind, type VendorDocumentLink } from '../../types/inventory';
import { EvidenceAttachFieldset } from './EvidenceAttachFieldset';

interface VendorDocumentsDialogProps {
  vendor: InventoryVendor;
  programName: string;
  framework: string;
  /** The document links of the open program (all vendors). */
  links: VendorDocumentLink[];
  canEdit: boolean;
  onClose: () => void;
}

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
  const catalogIds = useMemo(() => new Set(frameworkControls.map((c) => c.id)), [frameworkControls]);
  const suggested = suggestedVendorDocControl(framework, catalogIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);

  const kindRef = useRef<HTMLSelectElement>(null);
  const unlinkButtons = useRef(new Map<string, HTMLButtonElement>());

  const displayId = (cid: string): string => cmmcDisplayId(cid, framework);
  const uploadControls = useMemo(() => frameworkControls.map((c) => ({ id: c.id, label: `${displayId(c.id)} ${c.title}` })), [frameworkControls, framework]);
  const rows = useMemo(() => docRows(links, vendor.id, state.evidenceIndex), [links, vendor.id, state.evidenceIndex]);
  const linkedIds = useMemo(() => new Set(rows.map((r) => r.evidenceId)), [rows]);

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

  // The attach fieldset clears its entries when these resolve and keeps them when they reject; the errors and status are shown here
  const attachUpload = async (controlId: string, file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('');
    let uploaded = false;
    try {
      const ev = await uploadEvidence(controlId, file, 'Vendor document');
      uploaded = true;
      await inv.linkDocument(vendor.id, ev.id, docKind);
      setStatus('Document linked.');
      setTimeout(() => kindRef.current?.focus(), 0);
    } catch (err: unknown) {
      if (uploaded) {
        // the file is in the vault but not linked: the form is cleared so it is not uploaded twice
        setError(uploadLinkFailedText(displayId(controlId)));
        return;
      }
      setError(vendorErrorMessage(err, 'upload'));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const attachExisting = async (evId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await inv.linkDocument(vendor.id, evId, docKind);
      setStatus('Document linked.');
      setTimeout(() => kindRef.current?.focus(), 0);
    } catch (err: unknown) {
      setError(vendorErrorMessage(err, 'link'));
      throw err;
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
          <EvidenceAttachFieldset
            legend="Attach a document"
            evidence={state.evidenceIndex}
            displayId={displayId}
            uploadControls={uploadControls}
            defaultControlId={suggested}
            uploadHint={VENDOR_UI_TEXT.uploadHint}
            disabledEvidenceIds={linkedIds}
            submitLabel="Attach"
            busy={busy}
            onAttachExisting={attachExisting}
            onUpload={attachUpload}
            extra={
              <div>
                <label htmlFor={id('kind')} className={labelClass}>Document type</label>
                <select ref={kindRef} id={id('kind')} value={docKind} onChange={(e) => setDocKind(e.target.value as VendorDocumentKind)} className={fieldClass}>
                  {VENDOR_DOCUMENT_KINDS.map((k) => (
                    <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>
                  ))}
                </select>
              </div>
            }
          />
        )}
      </div>
    </DialogOverlay>
  );
};

export default VendorDocumentsDialog;
