import React, { useId, useRef } from 'react';
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HelpCircle,
  Paperclip,
  FileEdit,
  ChevronRight,
  Terminal,
} from 'lucide-react';
import { ControlStatus, DomainInfo } from '../../types/cmmc';
import { FrameworkControlDefinition, FrameworkDomainInfo } from '../../types/framework';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getStigRulesForControl } from '../../data/stigs/stigCatalog';
import { getSprsPointDeduction } from '../../data/reports/sprsCompiler';
import { getControlImpactBadge } from '../../data/frameworks';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { NOTES_NOT_SAVED_DETAIL } from '../../data/controlSave';
interface ControlCardProps {
  control: FrameworkControlDefinition;
  domainInfo: DomainInfo | FrameworkDomainInfo | any;
  onOpenDetailModal?: () => void;
}

export const ControlCard: React.FC<ControlCardProps> = ({
  control,
  domainInfo,
  onOpenDetailModal,
}) => {
  const {
    state,
    notesStatus,
    notesEditable,
    notesNotSaved,
    retryUnsavedNotes,
    setSelectedControlId,
  } = useAssessment();
  const { canEdit, activeFramework } = useTenant();

  const ctrlState = state.controls[control.id];
  const status: ControlStatus = ctrlState?.status || 'NOT_STARTED';
  const hasNotes = (ctrlState?.implementationNotes || '').trim().length > 0;
  const notesNotLoaded = notesStatus === 'loading' || notesStatus === 'unavailable';
  const evidenceCount = state.evidenceIndex.filter((e) => e.controlId === control.id).length;
  const mappedStigRules = getStigRulesForControl(control.id);

  const notesNotSavedId = useId();
  const notesNotSavedReason = notesNotSaved[control.id];
  const openButtonRef = useRef<HTMLButtonElement>(null);

  // Status Badge Helper
  const renderStatusBadge = () => {
    switch (status) {
      case 'MET':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 ring-1 ring-emerald-500/20 shadow-sm shadow-emerald-950/40">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse motion-reduce:animate-none" />
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>MET</span>
          </span>
        );
      case 'NOT_MET':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-rose-500/15 text-rose-300 border border-rose-500/30 ring-1 ring-rose-500/20 shadow-sm shadow-rose-950/40">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>NOT_MET</span>
          </span>
        );
      case 'IN_PROGRESS':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30 ring-1 ring-amber-500/20 shadow-sm shadow-amber-950/40">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none" />
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>IN_PROGRESS</span>
          </span>
        );
      case 'NOT_STARTED':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-slate-800 text-slate-300 border border-slate-700 shadow-sm">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
            <span>NOT_STARTED</span>
          </span>
        );
    }
  };

  // Tactical Point Weight Badge Helper for CMMC Level 2 mode
  const renderPointWeightBadge = () => {
    const weight = getSprsPointDeduction(control.id);
    const badge = getControlImpactBadge(weight);
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-mono uppercase tracking-wider font-bold ${badge.badgeClass}`}
        title={`SPRS Assessment Impact: ${weight} Point Deduction under DoD NIST SP 800-171`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${badge.dotClass}`} />
        <span>{badge.tagText}</span>
      </span>
    );
  };

  const handleOpenDetail = () => {
    if (onOpenDetailModal) {
      onOpenDetailModal();
    } else {
      setSelectedControlId(control.id);
    }
  };

  // Retry from the card: a saved retry removes the marker and its button, so focus goes to the Open button instead of the page
  const handleRetry = () => {
    void retryUnsavedNotes(control.id).finally(() => {
      if (!document.activeElement || document.activeElement === document.body) openButtonRef.current?.focus();
    });
  };

  return (
    <div
      className="stitch-card transition-all duration-200 shadow-md hover:border-slate-700 hover:shadow-lg hover:shadow-slate-950/40"
    >
      {/* Top Header Strip */}
      <div className="p-4 sm:p-5 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        
        {/* Left: Identifiers & Titles */}
        <div className="space-y-2.5 max-w-3xl flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Control ID in Bold Monospace Text */}
            <span
              className="font-mono font-bold text-sm tracking-wide px-3 py-1 rounded-lg bg-cyan-950/50 text-cyan-300 border border-cyan-500/30 shadow-sm shadow-cyan-950/30"
              title={cmmcDisplayId(control.id, activeFramework) !== control.id ? `Stored as ${control.id}` : undefined}
            >
              {cmmcDisplayId(control.id, activeFramework)}
            </span>

            {/* Tactical Point Weight Badge for CMMC Level 2 */}
            {activeFramework === 'CMMC_L2' && renderPointWeightBadge()}

            {/* Status Badge */}
            {renderStatusBadge()}

            {/* Domain Tag */}
            <span
              className="text-xs font-semibold px-2.5 py-0.5 rounded-lg flex items-center gap-1"
              style={{
                backgroundColor: `${domainInfo.color}15`,
                color: domainInfo.color,
                border: `1px solid ${domainInfo.color}35`,
              }}
            >
              <Shield className="w-3 h-3" />
              <span>{domainInfo.name}</span>
            </span>

            {/* Authority Reference */}
            <span className="text-xs font-mono text-slate-400 bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800">
              {control.authorityReference || control.farReference || 'Baseline'}
            </span>

            {/* Baseline Impact Tag */}
            {control.baselineImpact && (
              <span
                className={`text-xs font-mono font-bold px-2 py-0.5 rounded border shadow-sm ${
                  control.baselineImpact === 'LOW'
                    ? 'bg-cyan-950/70 text-cyan-300 border-cyan-500/40'
                    : control.baselineImpact === 'MODERATE'
                    ? 'bg-amber-950/70 text-amber-300 border-amber-500/40'
                    : 'bg-rose-950/70 text-rose-300 border-rose-500/40'
                }`}
              >
                {control.baselineImpact} BASELINE
              </span>
            )}
          </div>

          {/* Control Title & Plain-English Summary */}
          <div>
            <h3 className="text-base font-bold text-white">
              {control.title}
            </h3>
            <p className="text-xs text-slate-300/90 leading-relaxed mt-1">
              {control.plainEnglishSummary}
            </p>
          </div>

          {/* Cross-Framework Mappings (Inheritance Bridges) */}
          {control.mappings && control.mappings.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              <span className="text-xs font-mono font-semibold text-slate-400 uppercase">Equivalencies:</span>
              {control.mappings.slice(0, 4).map((m, idx) => (
                <span
                  key={idx}
                  title={`${m.targetFramework}: ${m.targetTitle || m.targetControlId}`}
                  className="text-xs font-mono px-2 py-0.5 rounded bg-indigo-950/50 text-indigo-300 border border-indigo-500/30"
                >
                  {m.targetControlId}
                </span>
              ))}
              {control.mappings.length > 4 && (
                <span className="text-xs text-slate-400 font-mono">+{control.mappings.length - 4} more</span>
              )}
            </div>
          )}

          {/* Scannable Metadata Indicators */}
          <div className="flex items-center gap-4 text-xs pt-1 flex-wrap">
            <span
              className={`flex items-center gap-1.5 font-medium ${
                notesNotLoaded ? 'text-amber-300' : hasNotes ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              <FileEdit className="w-3.5 h-3.5" aria-hidden="true" />
              {notesNotLoaded ? 'Narrative not loaded' : hasNotes ? 'Narrative Documented' : 'No narrative yet'}
            </span>

            <span
              className={`flex items-center gap-1.5 font-medium ${
                evidenceCount > 0 ? 'text-cyan-400' : 'text-slate-400'
              }`}
            >
              <Paperclip className="w-3.5 h-3.5" />
              {evidenceCount} {evidenceCount === 1 ? 'Evidence File' : 'Evidence Files'}
            </span>

            {mappedStigRules.length > 0 && (
              <span
                className="flex items-center gap-1 font-mono text-xs px-2.5 py-0.5 rounded-full bg-cyan-950/70 text-cyan-300 border border-cyan-500/35 shadow-sm"
                title={`${mappedStigRules.length} DISA STIG technical rules mapped to this control requirement`}
              >
                <Terminal className="w-3 h-3 text-cyan-400" aria-hidden="true" />
                <span>{mappedStigRules.length} STIG {mappedStigRules.length === 1 ? 'Rule' : 'Rules'}</span>
              </span>
            )}
          </div>

          {notesNotSavedReason && (
            <div id={notesNotSavedId} className="flex flex-wrap items-center gap-2 text-xs text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="font-semibold">Not saved</span>
              <span className="text-amber-200/90">{NOTES_NOT_SAVED_DETAIL[notesNotSavedReason]}</span>
              {notesNotSavedReason === 'failed' && canEdit && notesEditable && (
                <button type="button" onClick={handleRetry}
                  className="px-2 py-0.5 rounded-lg border border-amber-500/40 bg-amber-500/10 font-semibold text-amber-200 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                  Retry
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right: the one action, open the control */}
        <div className="flex items-center w-full lg:w-auto justify-end pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-800/80 shrink-0">
          <button
            ref={openButtonRef}
            type="button"
            onClick={handleOpenDetail}
            aria-label={`Open ${cmmcDisplayId(control.id, activeFramework)}`}
            aria-describedby={notesNotSavedReason ? notesNotSavedId : undefined}
            className="btn-primary text-xs px-3.5 py-2"
          >
            <span>Open</span>
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

      </div>

    </div>
  );
};

export default ControlCard;
