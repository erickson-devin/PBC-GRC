import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, Paperclip, Star, Unlink, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAssessment } from '../../context/AssessmentContext';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import {
  DOCUMENT_UI_TEXT,
  attachLinkFailedText,
  attachmentRows,
  documentErrorMessage,
  unlinkAttachmentText,
  uploadControlChoices,
} from '../../data/documents/documentUiView';
import type { DocumentAttachment, GovernanceDocument } from '../../types/documents';
import { DocumentLocation } from './DocumentLocation';
import { EvidenceAttachFieldset } from '../inventory/EvidenceAttachFieldset';

interface DocumentAttachmentsDialogProps {
  doc: GovernanceDocument;
  programName: string;
  framework: string;
  /** The attachments of the open program (all documents). */
  attachments: DocumentAttachment[];
  controlLinks: { documentId: string; controlId: string }[];
  /** The person may change files: a write role, a ready program that is not archived. */
  canEdit: boolean;
  /** The program is archived (only changes the read-only wording). */
  archived: boolean;
  displayId: (id: string) => string;
  onLink: (evidenceId: string, primary: boolean) => Promise<void>;
  onSetPrimary: (evidenceId: string) => Promise<void>;
  onUnlink: (evidenceId: string) => Promise<void>;
  onClose: () => void;
}

const CHIP = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border';
const EMERALD = 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300';
const confirmButton = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50';
const rowButton = 'px-2 py-1 rounded-lg hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * The files linked to one document in the open program. Each file is an Evidence Vault file of that program: attaching picks an existing file or uploads
 * one through the ordinary evidence upload (filed under one of the document's linked controls, with a fixed description). File names are shown but never
 * logged or stored by this screen.
 */
export const DocumentAttachmentsDialog: React.FC<DocumentAttachmentsDialogProps> = ({
  doc, programName, framework, attachments, controlLinks, canEdit, archived, displayId, onLink, onSetPrimary, onUnlink, onClose,
}) => {
  const { state, frameworkControls, uploadEvidence, setPreviewEvidence } = useAssessment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);
  const [primaryChoice, setPrimaryChoice] = useState<boolean | null>(null);
  const unlinkButtons = useRef(new Map<string, HTMLButtonElement>());

  const rows = useMemo(() => attachmentRows(attachments, doc.id, state.evidenceIndex), [attachments, doc.id, state.evidenceIndex]);
  const linkedIds = useMemo(() => new Set(rows.map((r) => r.evidenceId)), [rows]);
  const titles = useMemo(() => Object.fromEntries(frameworkControls.map((c) => [c.id, c.title])), [frameworkControls]);
  const choices = useMemo(() => uploadControlChoices(controlLinks, doc.id, displayId, titles), [controlLinks, doc.id, displayId, titles]);
  // A copy shared from another control cannot be linked: the server asks for the original
  const attachable = useMemo(() => state.evidenceIndex.filter((e) => !e.id.includes('__inh_')), [state.evidenceIndex]);
  const makePrimary = primaryChoice ?? !rows.some((r) => r.isPrimary);

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
    setStatus('');
    try {
      await onUnlink(evId);
      setPendingUnlink(null);
      setStatus('File unlinked.');
    } catch (err: unknown) {
      setError(documentErrorMessage(err, 'unlink', programName));
      if ((err as { reason?: unknown } | null)?.reason === 'not_found') setPendingUnlink(null);
    } finally {
      setBusy(false);
    }
  };

  const makePrimaryFile = async (evId: string, name: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await onSetPrimary(evId);
      setStatus(`${name ?? 'The file'} is now the primary copy.`);
    } catch (err: unknown) {
      setError(documentErrorMessage(err, 'primary', programName));
    } finally {
      setBusy(false);
    }
  };

  // The attach fieldset clears its entries when these resolve and keeps them when they reject; the errors and status are shown here
  const attachExisting = async (evId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await onLink(evId, makePrimary);
      setPrimaryChoice(null);
      setStatus('File linked.');
    } catch (err: unknown) {
      setError(documentErrorMessage(err, 'attach', programName));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const attachUpload = async (controlId: string, file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus('');
    let uploaded = null as Awaited<ReturnType<typeof uploadEvidence>> | null;
    try {
      uploaded = await uploadEvidence(controlId, file, 'Governance document');
    } catch (err: unknown) {
      setError('The file could not be uploaded to the Evidence Vault. Nothing was linked. Try again.');
      setBusy(false);
      throw err;
    }
    try {
      await onLink(uploaded.id, makePrimary);
      setPrimaryChoice(null);
      setStatus('File linked.');
    } catch {
      // the file is in the vault but not linked: the form is cleared so it is not uploaded twice
      setError(attachLinkFailedText(displayId(controlId)));
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
              <Paperclip className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle as="h2" className="text-base font-bold text-white">{`Files: ${doc.title}`}</DialogTitle>
              <p className="text-xs text-slate-400 mt-0.5">{`In ${programName} (${frameworkLabel(framework)}). ${DOCUMENT_UI_TEXT.filesIntro}`}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!canEdit && (
          <p role="note" className="text-xs text-slate-300 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
            {archived ? DOCUMENT_UI_TEXT.archived : DOCUMENT_UI_TEXT.readOnly}
          </p>
        )}

        <ErrorNotice message={error} />
        {status && (
          <div role="status" className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span>{status}</span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-slate-400">{DOCUMENT_UI_TEXT.filesEmpty}</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.evidenceId} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {r.isPrimary && (
                    <span className={`${CHIP} ${EMERALD}`}>
                      <Star className="w-3 h-3" aria-hidden="true" />
                      Primary copy
                    </span>
                  )}
                  {r.missing ? (
                    <span className="flex-1 min-w-0 text-amber-300">{DOCUMENT_UI_TEXT.fileRemoved}</span>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 truncate font-semibold text-white" title={r.name ?? undefined}>{r.name}</span>
                      <span className="font-mono text-slate-400">{r.controlId ? displayId(r.controlId) : ''}</span>
                      <span className="text-slate-400">{r.uploadedAt ? r.uploadedAt.slice(0, 10) : ''}</span>
                    </>
                  )}
                  {!r.missing && (
                    <button type="button" aria-label={`Open ${r.name ?? 'file'}`} onClick={() => open(r.evidenceId)} className={`${rowButton} text-cyan-300`}>
                      Open
                    </button>
                  )}
                  {canEdit && !r.isPrimary && !r.missing && (
                    <button type="button" aria-label={`Make ${r.name ?? 'the file'} the primary copy`} disabled={busy} onClick={() => void makePrimaryFile(r.evidenceId, r.name)} className={`${rowButton} text-slate-200`}>
                      Make primary
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Unlink ${r.name ?? 'the removed file'}`}
                      aria-expanded={pendingUnlink === r.evidenceId}
                      ref={(el) => {
                        if (el) unlinkButtons.current.set(r.evidenceId, el);
                        else unlinkButtons.current.delete(r.evidenceId);
                      }}
                      disabled={busy}
                      onClick={() => setPendingUnlink(r.evidenceId)}
                      className={`${rowButton} inline-flex items-center gap-1 text-slate-400 hover:text-rose-300`}
                    >
                      <Unlink className="w-3 h-3" aria-hidden="true" />
                      Unlink
                    </button>
                  )}
                </div>
                {pendingUnlink === r.evidenceId && (
                  <div
                    role="group"
                    aria-label="Unlink this file?"
                    className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        cancelUnlink(r.evidenceId);
                      }
                    }}
                  >
                    <span className="flex-1 min-w-[14rem] text-slate-200">{unlinkAttachmentText(r.isPrimary)}</span>
                    <button type="button" disabled={busy} onClick={() => cancelUnlink(r.evidenceId)} className={confirmButton}>Cancel</button>
                    <button type="button" autoFocus disabled={busy} onClick={() => void confirmUnlink(r.evidenceId)} className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50">
                      Unlink
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-1.5">
          <p className="text-[11px] text-slate-400">{DOCUMENT_UI_TEXT.primaryRule}</p>
          {doc.locationUrl && (
            <p className="text-xs text-slate-300 flex flex-wrap items-center gap-1.5">
              <span>Internal location:</span>
              <DocumentLocation value={doc.locationUrl} />
            </p>
          )}
        </div>

        {canEdit && (
          <EvidenceAttachFieldset
            legend="Attach a file"
            evidence={attachable}
            displayId={displayId}
            uploadControls={choices}
            defaultControlId={choices[0]?.id ?? null}
            uploadHint={DOCUMENT_UI_TEXT.uploadHint}
            uploadDisabledReason={choices.length === 0 ? DOCUMENT_UI_TEXT.uploadNeedsControl : null}
            disabledEvidenceIds={linkedIds}
            submitLabel="Attach"
            busy={busy}
            onAttachExisting={attachExisting}
            onUpload={attachUpload}
            extra={
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input type="checkbox" checked={makePrimary} onChange={(e) => setPrimaryChoice(e.target.checked)} className="accent-cyan-500" />
                <span>Make it the primary copy</span>
              </label>
            }
          />
        )}
      </div>
    </DialogOverlay>
  );
};

export default DocumentAttachmentsDialog;
