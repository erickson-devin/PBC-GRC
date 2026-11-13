import React, { useRef } from 'react';
import { AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import type { FrameworkControlDefinition } from '../../types/framework';
import type { POAMEntry } from '../../types/report';
import type { Program } from '../../types/program';
import type { UseVmPoam } from '../../hooks/useVmPoam';
import { poamExportNote, poamHeaderText } from '../../data/reports/vmPoamView';
import { PoamControlsSection } from './PoamControlsSection';
import { PoamVulnerabilitiesSection } from './PoamVulnerabilitiesSection';
import { SMALL_BUTTON } from './PoamGroupPanel';

export interface PoamWorkspaceProps {
  entries: POAMEntry[];
  framework: string;
  frameworkControls: FrameworkControlDefinition[];
  vm: UseVmPoam;
  /** The open vulnerability items as the exports carry them (for the CSV button). */
  vmEntries: POAMEntry[];
  programs: Program[];
  onExportCsv: () => void;
}

/** The POA&M tab: the control entries (#278) and the vulnerability items (#274). Read-only; the exports always hold every entry. */
export const PoamWorkspace: React.FC<PoamWorkspaceProps> = ({ entries, framework, frameworkControls, vm, vmEntries, programs, onExportCsv }) => {
  const { setSelectedControlId } = useAssessment();
  const controlsHeadingRef = useRef<HTMLHeadingElement>(null);
  const vulnHeadingRef = useRef<HTMLHeadingElement>(null);
  const jump = (r: React.RefObject<HTMLHeadingElement | null>) => {
    r.current?.scrollIntoView({ block: 'start' });
    r.current?.focus();
  };
  const { load } = vm;
  const targetProgramName = load.status === 'ready' ? programs.find((p) => p.id === load.data.rules.vmTargetProgramId)?.name ?? null : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 flex items-start justify-between flex-wrap gap-4 shadow-lg">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" aria-hidden="true" />
            Plan of Action & Milestones (POA&M)
          </h3>
          <p className="text-xs text-slate-400">{poamHeaderText(entries.length, load)}</p>
          <p className="text-xs text-slate-400">{poamExportNote(load)}</p>
          <nav aria-label="POA&M sections" className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => jump(controlsHeadingRef)} className={SMALL_BUTTON}>Controls ({entries.length})</button>
            {load.status !== 'unsupported' && (
              <button type="button" onClick={() => jump(vulnHeadingRef)} className={SMALL_BUTTON}>
                Vulnerabilities{load.status === 'ready' ? ` (${load.data.openItemsTotal})` : ''}
              </button>
            )}
          </nav>
        </div>
        <button
          type="button"
          onClick={onExportCsv}
          disabled={entries.length + vmEntries.length === 0}
          className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <FileSpreadsheet className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          <span>Download POA&M (CSV)</span>
        </button>
      </div>
      <PoamControlsSection
        entries={entries}
        framework={framework}
        controls={frameworkControls}
        vmLoad={load}
        onOpenControl={setSelectedControlId}
        headingRef={controlsHeadingRef}
      />
      <PoamVulnerabilitiesSection
        load={load}
        onRetry={() => { void vm.reload(); }}
        framework={framework}
        targetProgramName={targetProgramName}
        headingRef={vulnHeadingRef}
      />
    </div>
  );
};