import React, { useId, useMemo } from 'react';
import { ArrowLeftRight, BookOpen, ExternalLink, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { policyControlReference } from '../../data/policyControlReference';

interface PolicyControlReferenceDialogProps {
  controlId: string;
  onClose: () => void;
}

/**
 * Read-only SP 800-53 reference for a policy's control (for example AC-1). It never switches the active program: a CMMC
 * program sees the crosswalked practices with links into its own matrix, a NIST program can open the control if it records it.
 */
export const PolicyControlReferenceDialog: React.FC<PolicyControlReferenceDialogProps> = ({ controlId, onClose }) => {
  const { activeFramework, activeProgram } = useTenant();
  const { state, setActiveTab, setSelectedControlId } = useAssessment();
  const headingId = useId();
  const programIds = useMemo(() => new Set(Object.keys(state.controls)), [state.controls]);
  const ref = useMemo(() => policyControlReference(controlId, activeFramework, programIds), [controlId, activeFramework, programIds]);
  const isCmmc = activeFramework === 'CMMC_L1' || activeFramework === 'CMMC_L2';
  const loaded = programIds.size > 0;

  const openInMatrix = (id: string) => {
    onClose();
    setActiveTab('matrix');
    setSelectedControlId(id);
  };

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-fadeIn">
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-4 bg-slate-950/60 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-300 flex items-center justify-center border border-indigo-500/30 shrink-0">
              <BookOpen className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DialogTitle as="h3" className="text-base font-bold text-white flex flex-wrap items-center gap-2">
                <span className="font-mono text-cyan-300">{ref.controlId}</span>
                <span>{ref.found ? ref.title : 'Not in the SP 800-53 catalog'}</span>
              </DialogTitle>
              <p className="text-xs text-slate-400">NIST SP 800-53 Rev. 5 reference. Read-only: {activeProgram ? `${activeProgram.name} stays the active program.` : 'the active framework does not change.'}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 shrink-0">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {ref.found ? (
            <section aria-label="Control statement" className="space-y-2">
              {ref.summary && <p className="text-sm text-slate-200 leading-relaxed">{ref.summary}</p>}
              {ref.statement && (
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 max-h-48 overflow-y-auto">
                  <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{ref.statement}</p>
                </div>
              )}
            </section>
          ) : (
            <p className="text-xs text-slate-400">The shipped SP 800-53 Rev. 5 catalog has no control {ref.controlId}.</p>
          )}
          {isCmmc && (
            <section aria-labelledby={headingId} className="rounded-xl border border-slate-700/70 bg-slate-950/60 p-3.5 space-y-2">
              <h4 id={headingId} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
                <ArrowLeftRight className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                <span>Crosswalk: practices in the {ref.family} family ({ref.practices.length})</span>
              </h4>
              <p className="text-xs text-slate-400">SP 800-171 Rev. 2 Appendix D maps no requirement to {ref.controlId} itself; these practices map to {ref.family} controls.</p>
              {!loaded && <p className="text-xs text-slate-500 italic">This program's controls are not loaded yet: matrix links appear once they are.</p>}
              {ref.practices.length === 0 ? (
                <p className="text-xs text-slate-500">No SP 800-171 requirement maps to the {ref.family} family.</p>
              ) : (
                <ul className="space-y-2">
                  {ref.practices.map((p) => (
                    <li key={p.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold text-cyan-300">{p.id}</span>
                          <span className="text-xs text-slate-200">{p.title}</span>
                        </div>
                        <p className="text-xs text-slate-400">Maps to {p.via.join(', ')}</p>
                      </div>
                      {p.inProgram ? (
                        <button type="button" onClick={() => openInMatrix(p.id)} aria-label={`Open ${p.id} in the control matrix`} className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 shrink-0">
                          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Open in matrix</span>
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500">Reference only: not part of this program.</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {!isCmmc && ref.found && !ref.openInMatrix && (
            <p className="text-xs text-slate-400">{activeProgram ? activeProgram.name : 'This tenant'} does not record {ref.controlId} (outside its baseline, or not loaded yet). Shown for reference only.</p>
          )}
        </div>
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-end gap-2 shrink-0">
          {ref.openInMatrix && (
            <button type="button" onClick={() => openInMatrix(ref.controlId)} className="px-4 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-bold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Open {ref.controlId} in Control Matrix</span>
            </button>
          )}
          <button type="button" onClick={onClose} autoFocus className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">Close</button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default PolicyControlReferenceDialog;
