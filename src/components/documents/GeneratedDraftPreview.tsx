import React, { useMemo, useState } from 'react';
import { Download, FileText, Sparkles, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { MarkdownPreview } from '../common/MarkdownPreview';
import { useTenant } from '../../context/TenantContext';
import { useFipsModules } from '../../hooks/useFipsModules';
import { withEffectiveStack } from '../../data/effectiveStackProfile';
import { parseGeneratedSeed, renderGeneratedDraft } from '../../data/documents/generatedDrafts';
import { DOCUMENT_UI_TEXT, generatedDraftFileName } from '../../data/documents/documentUiView';
import { localDateIso } from '../../data/inventory/inventoryUiView';
import { COPY_FAILED_MESSAGE, copyText } from '../../utils/clipboard';
import type { GovernanceDocument } from '../../types/documents';

interface GeneratedDraftPreviewProps {
  doc: GovernanceDocument;
  onClose: () => void;
}

const secondaryButton = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/**
 * The text the policy generator drafts for a generated document, rendered now from the program's technology answers. It is never stored, uploaded or
 * counted as evidence: it is a starting point to download, edit and then attach as the reviewed copy. The register hides the button when the seed is
 * not one the generator knows, so there is nothing to show for such a row.
 */
export const GeneratedDraftPreview: React.FC<GeneratedDraftPreviewProps> = ({ doc, onClose }) => {
  const { currentTenant, activeProgram } = useTenant();
  const cryptoModules = useFipsModules();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const seed = useMemo(() => parseGeneratedSeed(doc.seedKey), [doc.seedKey]);
  const markdown = useMemo(
    () => (seed ? renderGeneratedDraft(withEffectiveStack(currentTenant, activeProgram), seed, doc.title, cryptoModules) : ''),
    [seed, currentTenant, activeProgram, doc.title, cryptoModules]
  );

  const download = (): void => {
    if (!seed) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generatedDraftFileName(seed, localDateIso(new Date()));
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copy = (): void => {
    void copyText(markdown).then((ok) => setCopyState(ok ? 'copied' : 'failed'));
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 gap-4">
        <div className="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
          <div className="flex items-start gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300">
              <FileText className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">{`Generated text: ${doc.title}`}</DialogTitle>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div role="note" className="flex items-start gap-2 rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-100">
          <Sparkles className="w-4 h-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold text-amber-300">{DOCUMENT_UI_TEXT.generatedBadge}</p>
            <p>{DOCUMENT_UI_TEXT.generatedIntro}</p>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-2xl border-2 border-dashed border-amber-500/30 bg-slate-950/60 p-5">
          <MarkdownPreview markdown={markdown} headingOffset={2} className="space-y-4 max-w-3xl mx-auto" />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <p role="status" className={copyState === 'failed' ? 'text-xs text-amber-300 mr-auto' : 'sr-only'}>
            {copyState === 'failed' ? COPY_FAILED_MESSAGE : copyState === 'copied' ? 'Text copied.' : ''}
          </p>
          <button type="button" onClick={download} disabled={!seed} className={secondaryButton}>
            <Download className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>Download .md for editing</span>
          </button>
          <button type="button" onClick={copy} disabled={!seed} className={secondaryButton}>
            <span>Copy text</span>
          </button>
          <button type="button" onClick={onClose} className={secondaryButton}>Close</button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default GeneratedDraftPreview;
