import React, { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import { DOCUMENT_UI_TEXT, documentErrorMessage } from '../../data/documents/documentUiView';
import type { GovernanceDocument } from '../../types/documents';
import { ControlLinksDialog } from '../inventory/ControlLinksDialog';

interface DocumentControlsEditorProps {
  doc: GovernanceDocument;
  programName: string;
  framework: string;
  controls: Array<{ id: string; title: string; domain: string }>;
  displayId: (id: string) => string;
  /** This document's linked control ids in the open program. */
  controlIds: string[];
  /** The program declares its documents and this one is not among them: links cannot be added until it is. */
  blocked: boolean;
  /** The person may change links: a write role, a ready program that is not archived. */
  canEdit: boolean;
  /** The program is archived (only changes the read-only wording). */
  archived: boolean;
  onAddToProgram: () => Promise<void>;
  /** Saves the links; `expectedIds` is the set of control ids the editor last saw. Rejects with the ApiError. */
  onSave: (controlIds: string[], expectedIds: string[]) => Promise<string[]>;
  onClose: () => void;
}

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** The controls a document is linked to in the open program: the shared control-links dialog with the document's wording. Links are `{ controlId }` only. */
export const DocumentControlsEditor: React.FC<DocumentControlsEditorProps> = ({
  doc, programName, framework, controls, displayId, controlIds, blocked, canEdit, archived, onAddToProgram, onSave, onClose,
}) => {
  const initial = useMemo(() => controlIds.map((controlId) => ({ controlId })), [controlIds]);
  return (
    <ControlLinksDialog
      title={`Controls for ${doc.title}`}
      subtitle={`${programName} (${frameworkLabel(framework)}). ${DOCUMENT_UI_TEXT.linksIntro}`}
      icon={Link2}
      controls={controls}
      framework={framework}
      displayId={displayId}
      initial={initial}
      canEdit={canEdit}
      readOnlyText={archived ? DOCUMENT_UI_TEXT.archived : DOCUMENT_UI_TEXT.linksReadOnly}
      blocked={
        blocked
          ? ({ saving, setSaving, setBanner }) => (
              <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <span>{DOCUMENT_UI_TEXT.linksNotInProgram}</span>
                {canEdit && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setSaving(true);
                      setBanner(null);
                      onAddToProgram()
                        .catch((err: unknown) => setBanner(documentErrorMessage(err, 'membership', programName)))
                        .finally(() => setSaving(false));
                    }}
                    className={secondaryButton}
                  >
                    Add to program
                  </button>
                )}
              </div>
            )
          : undefined
      }
      suggestions={null}
      staleText={DOCUMENT_UI_TEXT.linksStale}
      errorText={(err) => documentErrorMessage(err, 'links', programName)}
      onSave={(next, expectedIds) => onSave(next.map((l) => l.controlId), expectedIds).then((ids) => ids.map((controlId) => ({ controlId })))}
      onClose={onClose}
    />
  );
};

export default DocumentControlsEditor;
