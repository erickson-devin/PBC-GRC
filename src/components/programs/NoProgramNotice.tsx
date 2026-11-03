import React, { useState } from 'react';
import { Layers, Plus } from 'lucide-react';
import { ProgramFormModal } from './ProgramFormModal';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { noProgramCopy, programGate } from '../../data/programDefaultChoice';

/**
 * Shown in place of a page whose data belongs to a program, while the organization has no active program (none yet, or all archived).
 * Whoever may create programs gets the button; everyone else is told who can.
 */
export const NoProgramNotice: React.FC = () => {
  const { programs, programsStatus, canManagePrograms, currentTenant } = useTenant();
  const { setActiveTab } = useAssessment();
  const [creating, setCreating] = useState(false);
  const gate = programGate({ programsStatus, programs, canManagePrograms });
  if (!gate) return null;
  const copy = noProgramCopy(gate);
  const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors';
  return (
    <section aria-labelledby="no-program-title" className="rounded-2xl bg-slate-900/60 border border-dashed border-slate-700 p-8 text-center space-y-3">
      <Layers className="w-7 h-7 text-slate-400 mx-auto" aria-hidden="true" />
      <h2 id="no-program-title" className="text-sm font-semibold text-white">{copy.title}</h2>
      <p className="text-xs text-slate-400 max-w-xl mx-auto">{copy.body}</p>
      {gate.canCreate && gate.kind === 'none' ? (
        <button type="button" onClick={() => setCreating(true)} className={`${buttonClass} bg-brand-600 text-white border-brand-500/40 hover:bg-brand-500`}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          Create a Program
        </button>
      ) : (
        <button type="button" onClick={() => setActiveTab('programs')} className={`${buttonClass} bg-slate-800/60 text-slate-200 border-slate-700 hover:bg-slate-800 hover:text-white`}>
          Open Programs &amp; Boundaries
        </button>
      )}
      {creating && (
        <ProgramFormModal
          mode="create"
          variant="first"
          initial={{ name: currentTenant.systemName, boundarySummary: currentTenant.systemBoundaryScope }}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
};

export default NoProgramNotice;
