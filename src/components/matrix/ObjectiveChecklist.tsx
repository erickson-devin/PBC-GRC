import React, { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  Paperclip,
  ShieldCheck,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Activity,
  Zap,
  ExternalLink,
  Ban,
  FileCheck,
  Sliders,
  type LucideIcon,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { AssessmentObjective, ObjectiveStatus } from '../../types/assessment';
import { calculateControlRollup } from '../../data/frameworks/assessmentObjectives';
import { getStigRulesForControl } from '../../data/stigs/stigCatalog';

interface ObjectiveChecklistProps {
  controlId: string;
  onStatusChange?: (status: string) => void;
}

export const ObjectiveChecklist: React.FC<ObjectiveChecklistProps> = ({
  controlId,
  onStatusChange,
}) => {
  const {
    state,
    getObjectivesForControl,
    updateObjectiveStatus,
    updateObjectiveNarrative,
    applyObjectivePrefilledNarrative,
    applyAllObjectiveTemplatesForControl,
    linkEvidenceToObjective,
    setPreviewEvidence,
  } = useAssessment();

  const { canEdit } = useTenant();

  // Retrieve objectives for this control
  const objectives = getObjectivesForControl(controlId);
  const rollup = calculateControlRollup(objectives);

  // Mapped STIG rules and control evidence
  const mappedStigRules = getStigRulesForControl(controlId);
  const controlEvidence = state.evidenceIndex.filter((e) => e.controlId === controlId);

  // Local state for expanded pre-filled cards and narrative edits
  const [expandedTemplates, setExpandedTemplates] = useState<Record<string, boolean>>({});
  const [editingNarratives, setEditingNarratives] = useState<Record<string, string>>({});
  const [appliedNoticeId, setAppliedNoticeId] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<boolean>(false);
  const [showEvidenceSelectorForId, setShowEvidenceSelectorForId] = useState<string | null>(null);

  // Local state for Organization-Defined Parameters (ODPs) inline customization
  const [odpCustomValues, setOdpCustomValues] = useState<Record<string, Record<string, string>>>({});
  const [odpAppliedNoticeId, setOdpAppliedNoticeId] = useState<string | null>(null);

  const is80053 = !controlId.includes('.L');

  // Helper to highlight Organization-Defined Parameters (ODPs) with a distinct cyan badge
  const renderTextWithOdpBadges = (text: string) => {
    if (!text) return null;
    const parts = text.split(/(\[ODP:[^\]]+\])/g);
    return parts.map((part, index) => {
      const match = part.match(/\[ODP:\s*([^\]]+)\]/);
      if (match) {
        const val = match[1].trim();
        return (
          <span
            key={index}
            className="inline-flex items-center gap-1 mx-1 px-2 py-0.5 rounded-md bg-cyan-950/90 text-cyan-300 border border-cyan-400/50 font-mono text-[11px] font-bold shadow-sm shadow-cyan-950/40 align-baseline"
            title="Organization-Defined Parameter (NIST SP 800-53B Tailoring)"
          >
            <Sliders className="w-3 h-3 text-cyan-400 shrink-0" />
            <span>ODP: {val}</span>
          </span>
        );
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    });
  };

  const handleOdpInputChange = (objId: string, paramId: string, value: string) => {
    setOdpCustomValues((prev) => ({
      ...prev,
      [objId]: {
        ...(prev[objId] || {}),
        [paramId]: value,
      },
    }));
  };

  const handleApplyOdpValue = (
    obj: AssessmentObjective,
    param: { id: string; label: string; defaultValue: string; currentValue?: string },
    newValue: string
  ) => {
    if (!canEdit || !newValue.trim()) return;
    const oldValue = param.currentValue || param.defaultValue;

    const baseNarrative =
      editingNarratives[obj.id] !== undefined
        ? editingNarratives[obj.id]
        : obj.implementationNarrative || obj.prefilledTemplate;

    let updated = baseNarrative;
    if (oldValue && updated.includes(oldValue)) {
      updated = updated.split(oldValue).join(newValue);
    }
    if (updated.includes(`[ODP: ${oldValue}]`)) {
      updated = updated.split(`[ODP: ${oldValue}]`).join(`[ODP: ${newValue}]`);
    }

    setEditingNarratives((prev) => ({
      ...prev,
      [obj.id]: updated,
    }));
    updateObjectiveNarrative(obj.id, updated);

    // Update parameter currentValue in param reference
    param.currentValue = newValue;

    setOdpAppliedNoticeId(obj.id);
    setTimeout(() => setOdpAppliedNoticeId(null), 3000);
  };

  const toggleTemplateExpand = (objId: string) => {
    setExpandedTemplates((prev) => ({
      ...prev,
      [objId]: !prev[objId],
    }));
  };

  const handleStatusClick = (objId: string, status: ObjectiveStatus) => {
    if (!canEdit) return;
    updateObjectiveStatus(objId, status);
    if (onStatusChange) {
      // Pass the rolled up status to parent if needed
      const updatedObjs = objectives.map((o) => (o.id === objId ? { ...o, status } : o));
      const nextRollup = calculateControlRollup(updatedObjs);
      onStatusChange(nextRollup.calculatedStatus);
    }
  };

  const handleApplyPrefilled = (obj: AssessmentObjective) => {
    if (!canEdit) return;
    applyObjectivePrefilledNarrative(obj.id);
    setAppliedNoticeId(obj.id);
    setTimeout(() => setAppliedNoticeId(null), 2500);

    if (onStatusChange) {
      const updatedObjs = objectives.map((o) =>
        o.id === obj.id
          ? { ...o, status: 'MET' as ObjectiveStatus, implementationNarrative: o.prefilledTemplate }
          : o
      );
      const nextRollup = calculateControlRollup(updatedObjs);
      onStatusChange(nextRollup.calculatedStatus);
    }
  };

  const handleBulkApplyAll = () => {
    if (!canEdit) return;
    applyAllObjectiveTemplatesForControl(controlId);
    setBulkNotice(true);
    setTimeout(() => setBulkNotice(false), 3000);
    if (onStatusChange) {
      onStatusChange('MET');
    }
  };

  const handleNarrativeChange = (objId: string, value: string) => {
    setEditingNarratives((prev) => ({
      ...prev,
      [objId]: value,
    }));
  };

  const handleSaveNarrative = (objId: string) => {
    if (!canEdit) return;
    const customText = editingNarratives[objId];
    if (customText !== undefined) {
      updateObjectiveNarrative(objId, customText);
    }
  };

  const percentMet =
    rollup.totalObjectives > 0
      ? Math.round(((rollup.metCount + rollup.notApplicableCount) / rollup.totalObjectives) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* ── Top Rollup Summary & Quick Actions ── */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
              {is80053 ? 'NIST SP 800-53A Objective Rollup' : 'NIST SP 800-171A Objective Rollup'}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold ${
                rollup.calculatedStatus === 'MET'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : rollup.calculatedStatus === 'NOT_MET'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  : rollup.calculatedStatus === 'IN_PROGRESS'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-slate-800 text-slate-300 border border-slate-700'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  rollup.calculatedStatus === 'MET'
                    ? 'bg-emerald-400 animate-pulse'
                    : rollup.calculatedStatus === 'NOT_MET'
                    ? 'bg-rose-400'
                    : rollup.calculatedStatus === 'IN_PROGRESS'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-slate-400'
                }`}
              />
              Control Status: {rollup.calculatedStatus}
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-white">
              {rollup.metCount} of {rollup.totalObjectives} Objectives Met
            </span>
            {rollup.notApplicableCount > 0 && (
              <span className="text-xs text-slate-400">({rollup.notApplicableCount} N/A)</span>
            )}
            {rollup.notMetCount > 0 && (
              <span className="text-xs text-rose-400 font-medium">({rollup.notMetCount} Not Met)</span>
            )}
          </div>

          {/* Micro Progress Bar */}
          <div className="w-full sm:w-64 bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                percentMet === 100
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                  : 'bg-gradient-to-r from-cyan-500 to-blue-500'
              }`}
              style={{ width: `${percentMet}%` }}
            />
          </div>
        </div>

        {/* Bulk Action Button */}
        <div className="flex items-center gap-2 self-start md:self-auto">
          <button
            onClick={handleBulkApplyAll}
            disabled={!canEdit}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all bg-gradient-to-r from-cyan-600/30 to-blue-600/30 hover:from-cyan-600/50 hover:to-blue-600/50 text-cyan-200 border border-cyan-500/40 hover:border-cyan-400 disabled:opacity-50 shadow-md shadow-cyan-950/40"
            title="Auto-fills all objective narratives with pre-filled baseline templates and marks all objectives as MET"
          >
            <Sparkles className="w-4 h-4 text-cyan-300 animate-pulse" />
            <span>Confirm All Best-Practice Narratives</span>
          </button>
        </div>
      </div>

      {bulkNotice && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
          <Check className="w-4 h-4 text-emerald-400" />
          <span>All {is80053 ? 'NIST SP 800-53A' : 'NIST SP 800-171A'} determination narratives applied and rolled up to MET status!</span>
        </div>
      )}

      {/* ── Individual Assessment Objectives List ── */}
      <div className="space-y-4">
        {objectives.map((obj) => {
          const isTemplateOpen = expandedTemplates[obj.id] ?? false;
          const currentNarrative =
            editingNarratives[obj.id] !== undefined
              ? editingNarratives[obj.id]
              : obj.implementationNarrative;
          const hasConfirmedNarrative = Boolean(obj.implementationNarrative?.trim());
          const isAppliedJustNow = appliedNoticeId === obj.id;

          // Compute effective ODPs
          const effectiveOdps =
            obj.odpParameters && obj.odpParameters.length > 0
              ? obj.odpParameters
              : (() => {
                  const combined = `${obj.text} ${obj.prefilledTemplate}`;
                  const matches = [...combined.matchAll(/\[ODP:\s*([^\]]+)\]/g)];
                  const uniqueValues = Array.from(new Set(matches.map((m) => m[1].trim())));
                  return uniqueValues.map((val, idx) => ({
                    id: `${obj.id}-odp-${idx}`,
                    label: `Organization-Defined Parameter`,
                    defaultValue: val,
                    currentValue: val,
                  }));
                })();

          // Evidence attached specifically to this objective
          const linkedEvidence = state.evidenceIndex.filter((e) =>
            obj.linkedEvidenceIds?.includes(e.id)
          );

          // Find SCAP / STIG rule match if available
          const matchingStig = mappedStigRules.find(
            (r) =>
              (obj.scapRuleId && r.ruleVersion.toLowerCase().includes(obj.scapRuleId.toLowerCase())) ||
              r.vulnId.toLowerCase().includes(obj.letter.toLowerCase())
          );

          return (
            <div
              key={obj.id}
              className={`p-5 rounded-2xl border transition-all duration-200 ${
                obj.status === 'MET'
                  ? 'bg-slate-900/80 border-emerald-500/30 shadow-sm shadow-emerald-950/20'
                  : obj.status === 'NOT_MET'
                  ? 'bg-slate-900/80 border-rose-500/30 shadow-sm shadow-rose-950/20'
                  : obj.status === 'IN_PROGRESS'
                  ? 'bg-slate-900/80 border-amber-500/30 shadow-sm shadow-amber-950/20'
                  : 'bg-slate-900/50 border-slate-800'
              }`}
            >
              {/* Header: Letter, Determination Text, Status Toggles */}
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {/* Objective Letter Badge */}
                  <span className="shrink-0 font-mono font-bold text-sm px-2.5 py-1 rounded-xl bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40">
                    [{obj.letter}]
                  </span>

                  {/* Determination Statement Text */}
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-100 tracking-tight leading-relaxed">
                      {renderTextWithOdpBadges(obj.text)}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-400">
                      <span className="font-mono text-cyan-400/80">{obj.id}</span>

                      {/* Telemetry verification badge */}
                      {obj.isAutoVerifiedByTelemetry && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 font-medium">
                          <Activity className="w-3 h-3 text-emerald-400 animate-pulse" />
                          <span>Telemetry Verified (OpenSCAP / STIG)</span>
                        </span>
                      )}

                      {obj.scapRuleId && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 font-mono text-[10px]">
                          <Zap className="w-3 h-3 text-cyan-400" />
                          <span>CCE: {obj.scapRuleId}</span>
                        </span>
                      )}

                      {matchingStig && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-300 border border-purple-500/30 font-mono text-[10px]">
                          <ShieldCheck className="w-3 h-3 text-purple-400" />
                          <span>STIG: {matchingStig.vulnId}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Status Toggle Buttons */}
                <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 shrink-0 self-start">
                  {(
                    [
                      { id: 'MET', label: 'MET', icon: CheckCircle2, active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
                      { id: 'NOT_MET', label: 'NOT MET', icon: AlertTriangle, active: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
                      { id: 'IN_PROGRESS', label: 'IN PROGRESS', icon: Clock, active: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
                      { id: 'NOT_APPLICABLE', label: 'N/A', icon: Ban, active: 'bg-slate-700 text-slate-200 border-slate-600' },
                    ] as { id: ObjectiveStatus; label: string; icon: LucideIcon; active: string }[]
                  ).map((s) => {
                    const isSelected = obj.status === s.id;
                    const IconComponent = s.icon;
                    return (
                      <button
                        key={s.id}
                        onClick={() => handleStatusClick(obj.id, s.id)}
                        disabled={!canEdit}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition-all border ${
                          isSelected
                            ? `${s.active} shadow-sm`
                            : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-850'
                        } disabled:opacity-50`}
                      >
                        <IconComponent className="w-3.5 h-3.5" />
                        <span>{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Pre-Filled Best-Practice Template Card ── */}
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
                <div
                  onClick={() => toggleTemplateExpand(obj.id)}
                  className="px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-slate-900/60 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-semibold text-cyan-200">
                      Industry Best-Practice Defense Baseline Narrative
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-800/40">
                      FedRAMP Mod / Azure Gov / STIG
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-400">
                      {isTemplateOpen ? 'Collapse' : 'Preview Template'}
                    </span>
                    {isTemplateOpen ? (
                      <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    )}
                  </div>
                </div>

                {isTemplateOpen && (
                  <div className="p-4 border-t border-slate-800/80 bg-slate-900/40 space-y-3">
                    <div className="text-xs text-slate-300 leading-relaxed font-sans whitespace-pre-wrap">
                      {renderTextWithOdpBadges(obj.prefilledTemplate)}
                    </div>
                    <div className="flex items-center justify-between gap-4 pt-1">
                      <span className="text-[11px] text-slate-400 italic">
                        Clicking confirm writes this standard narrative to the SSP and marks objective [{obj.letter}] as MET.
                      </span>
                      <button
                        onClick={() => handleApplyPrefilled(obj)}
                        disabled={!canEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-500/40 hover:border-cyan-400 disabled:opacity-50 shrink-0 shadow-sm"
                      >
                        <Check className="w-3.5 h-3.5 text-cyan-300" />
                        <span>Confirm & Use Best-Practice Narrative</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Organization-Defined Parameters (ODPs) Inline Editor ── */}
              {effectiveOdps.length > 0 && (
                <div className="mt-3.5 p-3.5 rounded-xl bg-cyan-950/30 border border-cyan-500/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs font-bold text-cyan-200">
                        Organization-Defined Parameters (ODPs)
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-900/60 text-cyan-300 border border-cyan-700/50">
                        NIST SP 800-53B Tailoring
                      </span>
                    </div>
                    <span className="text-[11px] text-cyan-300/80 font-mono">
                      {effectiveOdps.length} parameter{effectiveOdps.length > 1 ? 's' : ''}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {effectiveOdps.map((param) => {
                      const customValue =
                        odpCustomValues[obj.id]?.[param.id] !== undefined
                          ? odpCustomValues[obj.id][param.id]
                          : param.currentValue || param.defaultValue;

                      return (
                        <div
                          key={param.id}
                          className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-slate-200">{param.label}</span>
                              <span className="text-[11px] font-mono text-slate-400">
                                (Default: {param.defaultValue})
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-950/90 text-cyan-300 border border-cyan-400/50 font-mono text-[11px] font-bold">
                                <Sliders className="w-3 h-3 text-cyan-400" />
                                <span>ODP: {param.currentValue || param.defaultValue}</span>
                              </span>
                            </div>
                          </div>

                          {/* Inline "Edit Parameter" Input & Apply Button */}
                          <div className="flex items-center gap-2 shrink-0">
                            <input
                              type="text"
                              value={customValue}
                              onChange={(e) => handleOdpInputChange(obj.id, param.id, e.target.value)}
                              disabled={!canEdit}
                              placeholder="Adjust parameter..."
                              className="w-40 sm:w-48 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-cyan-500/40 text-xs text-cyan-200 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-400 placeholder-slate-600 disabled:opacity-50"
                            />
                            <button
                              type="button"
                              onClick={() => handleApplyOdpValue(obj, param, customValue)}
                              disabled={!canEdit || !customValue.trim()}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white transition-colors flex items-center gap-1.5 shadow-sm shadow-cyan-950/40 disabled:opacity-50 shrink-0"
                              title="Update parameter value inside template and narrative"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Apply Parameter</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {odpAppliedNoticeId === obj.id && (
                    <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-xs flex items-center gap-2 animate-fadeIn">
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Organization-Defined Parameter (ODP) updated in template & narrative!</span>
                    </div>
                  )}
                </div>
              )}

              {isAppliedJustNow && (
                <div className="mt-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Baseline narrative confirmed and objective [{obj.letter}] marked MET!</span>
                </div>
              )}

              {/* ── Implementation Narrative Box ── */}
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-300 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                    <span>Objective Implementation Narrative</span>
                    {hasConfirmedNarrative && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                        Confirmed for SSP
                      </span>
                    )}
                  </label>
                  {!isTemplateOpen && !hasConfirmedNarrative && (
                    <button
                      onClick={() => handleApplyPrefilled(obj)}
                      disabled={!canEdit}
                      className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-semibold transition-colors disabled:opacity-50"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>Quick-Adopt Baseline Template</span>
                    </button>
                  )}
                </div>

                <div className="relative">
                  <textarea
                    rows={3}
                    value={currentNarrative}
                    onChange={(e) => handleNarrativeChange(obj.id, e.target.value)}
                    onBlur={() => handleSaveNarrative(obj.id)}
                    disabled={!canEdit}
                    placeholder={`Describe how requirement [${obj.letter}] (${obj.text}) is implemented in your enclave, or click 'Confirm & Use Best-Practice Narrative' above...`}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all font-sans leading-relaxed disabled:opacity-60"
                  />
                  {editingNarratives[obj.id] !== undefined &&
                    editingNarratives[obj.id] !== obj.implementationNarrative && (
                      <div className="absolute bottom-2.5 right-2.5 flex items-center gap-2">
                        <button
                          onClick={() => handleSaveNarrative(obj.id)}
                          className="px-2 py-1 rounded-md text-[11px] font-bold bg-cyan-600 text-white hover:bg-cyan-500 shadow-sm transition-colors"
                        >
                          Save Changes
                        </button>
                      </div>
                    )}
                </div>
              </div>

              {/* ── Evidence Attachment Badges & Auto-Linked Artifacts ── */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-slate-400 flex items-center gap-1">
                    <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                    <span>Evidence:</span>
                  </span>

                  {linkedEvidence.length === 0 ? (
                    <span className="text-xs text-slate-400 italic">
                      No specific evidence files pinned yet.
                    </span>
                  ) : (
                    linkedEvidence.map((ev) => (
                      <div
                        key={ev.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 font-mono shadow-sm group hover:border-cyan-500/40 transition-colors"
                      >
                        <FileCheck className="w-3 h-3 text-cyan-400" />
                        <span className="truncate max-w-[140px] text-slate-300" title={ev.name}>
                          {ev.name}
                        </span>
                        <button
                          onClick={() => setPreviewEvidence(ev)}
                          className="text-slate-400 hover:text-cyan-300 ml-1"
                          title="Preview Evidence"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => linkEvidenceToObjective(obj.id, ev.id)}
                            className="text-slate-400 hover:text-rose-400 ml-0.5 text-xs font-bold"
                            title="Unlink from this objective"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))
                  )}

                  {/* SCAP Finding Auto-link badge if available */}
                  {obj.scapRuleId && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono"
                      title="OpenSCAP continuous telemetry finding linked to this determination statement"
                    >
                      <Activity className="w-3 h-3 text-emerald-400" />
                      <span>SCAP Scan Finding: PASS</span>
                    </span>
                  )}
                </div>

                {/* Evidence Attach Trigger */}
                {controlEvidence.length > 0 && canEdit && (
                  <div className="relative">
                    <button
                      onClick={() =>
                        setShowEvidenceSelectorForId(
                          showEvidenceSelectorForId === obj.id ? null : obj.id
                        )
                      }
                      className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1 transition-colors font-medium"
                    >
                      <Paperclip className="w-3 h-3" />
                      <span>Pin Control Evidence ({controlEvidence.length})</span>
                    </button>

                    {showEvidenceSelectorForId === obj.id && (
                      <div className="absolute right-0 bottom-full mb-2 w-72 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-3 z-30 space-y-2 animate-scaleUp">
                        <div className="flex items-center justify-between pb-1 border-b border-slate-800">
                          <span className="text-xs font-bold text-white">Attach Evidence to [{obj.letter}]</span>
                          <button
                            onClick={() => setShowEvidenceSelectorForId(null)}
                            className="text-slate-400 hover:text-white text-xs"
                          >
                            ×
                          </button>
                        </div>
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {controlEvidence.map((ev) => {
                            const isLinked = obj.linkedEvidenceIds?.includes(ev.id);
                            return (
                              <button
                                key={ev.id}
                                onClick={() => {
                                  linkEvidenceToObjective(obj.id, ev.id);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                                  isLinked
                                    ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                                    : 'hover:bg-slate-800 text-slate-300'
                                }`}
                              >
                                <span className="truncate pr-2 font-mono text-[11px]">{ev.name}</span>
                                {isLinked && <Check className="w-3 h-3 text-cyan-400 shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ObjectiveChecklist;
