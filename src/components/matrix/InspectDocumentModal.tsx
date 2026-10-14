import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  BookOpen,
  ListChecks,
  FileCheck,
  CheckCircle2,
  Sparkles,
  Paperclip,
  Upload,
  Trash2,
  Eye,
  ChevronLeft,
  ChevronRight,
  Info,
  Check,
  Copy,
  Share2,
  ShieldAlert,
  ShieldCheck,
  HardDrive,
  Terminal,
  Download,
  RefreshCw,
  FileText,
  Sliders,
} from 'lucide-react';
import { ControlStatus } from '../../types/cmmc';
import { ComplianceFramework } from '../../types/framework';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useStorageConfig } from '../../hooks/useStorageConfig';
import {
  findControlDefinition,
  FRAMEWORK_REGISTRY,
  getCrossFrameworkMappings,
} from '../../data/frameworks';
import { getStigRulesForControl } from '../../data/stigs/stigCatalog';
import { StigRule } from '../../types/stig';
import { ObjectiveChecklist } from './ObjectiveChecklist';
import { CrosswalkPanel } from './CrosswalkPanel';
import { OdpPanel } from './OdpPanel';
import { generateFamilyPolicyDocument } from '../../data/reports/policyDocumentGenerator';
import { getCascadedObjectiveNarrative } from '../../data/frameworks/policyCompiler';
import { useFipsModules } from '../../hooks/useFipsModules';
import { NIST_800_171A_REGISTRY } from '../../data/frameworks/assessmentObjectives';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { EnclaveStackSurveyModal } from '../admin/EnclaveStackSurveyModal';

import { activateOnKey } from '../../utils/a11y';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyToClipboard } from '../../utils/clipboard';
interface InspectDocumentModalProps {
  controlId?: string | null;
  onClose?: () => void;
}

const InspectDocumentModalContent: React.FC<InspectDocumentModalProps> = ({
  controlId: propControlId,
  onClose: propOnClose,
}) => {
  const {
    selectedControlId,
    setSelectedControlId,
    frameworkControls,
    state,
    updateControlStatus,
    updateControlNotes,
    applyStarterTemplate,
    uploadEvidence,
    removeEvidence,
    setPreviewEvidence,
    getObjectivesForControl,
  } = useAssessment();

  const { canEdit, currentTenant, activeFramework, setActiveFramework } = useTenant();
  const storageConfig = useStorageConfig(currentTenant?.id);

  // Primary active tab defaults to 'objectives' as specified
  const [activeTab, setActiveTab] = useState<
    'objectives' | 'narrative' | 'guidance' | 'evidence' | 'mappings' | 'stigs' | 'living_policy'
  >('objectives');

  const [templateFilter, setTemplateFilter] = useState<'all' | 'm365' | 'gcp' | 'activedirectory' | 'physical'>('all');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [templateAppliedNotice, setTemplateAppliedNotice] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [appliedStigRuleId, setAppliedStigRuleId] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [recompileCount, setRecompileCount] = useState<number>(0);
  const [recompileNotice, setRecompileNotice] = useState<boolean>(false);
  const [copiedPolicy, setCopiedPolicy] = useState<boolean>(false);
  const [policyViewMode, setPolicyViewMode] = useState<'preview' | 'raw'>('preview');
  const [isSurveyModalOpen, setIsSurveyModalOpen] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeId = propControlId !== undefined ? propControlId : selectedControlId;

  const controlIndex = activeId ? frameworkControls.findIndex((c) => c.id === activeId) : -1;
  const control = activeId
    ? (controlIndex >= 0 ? frameworkControls[controlIndex] : findControlDefinition(activeId))
    : null;

  const getFamilyPrefix = (id?: string, domain?: string): string => {
    if (domain && domain.length <= 4) return domain.toUpperCase();
    if (!id) return '';
    if (id.includes('-')) {
      const part = id.split('-')[0];
      if (part.includes('.')) return part.split('.')[0].toUpperCase();
      return part.toUpperCase();
    }
    if (id.startsWith('3.1.')) return 'AC';
    if (id.startsWith('3.2.')) return 'AT';
    if (id.startsWith('3.3.')) return 'AU';
    if (id.startsWith('3.4.')) return 'CM';
    if (id.startsWith('3.5.')) return 'IA';
    if (id.startsWith('3.6.')) return 'IR';
    if (id.startsWith('3.7.')) return 'MA';
    if (id.startsWith('3.8.')) return 'MP';
    if (id.startsWith('3.9.')) return 'PS';
    if (id.startsWith('3.10.')) return 'PE';
    if (id.startsWith('3.11.')) return 'RA';
    if (id.startsWith('3.12.')) return 'CA';
    if (id.startsWith('3.13.')) return 'SC';
    if (id.startsWith('3.14.')) return 'SI';
    return (id.split('.')[0] || '').toUpperCase();
  };

  const isPolicyControl = Boolean(
    control?.id && (
      control.id.endsWith('-1') ||
      control.id === '3.1.1' ||
      control.id === '3.2.1' ||
      control.id === '3.3.1' ||
      control.id === '3.4.1' ||
      control.id === '3.5.1' ||
      control.id === '3.6.1' ||
      control.id === '3.7.1' ||
      control.id === '3.8.1' ||
      control.id === '3.9.1' ||
      control.id === '3.10.1' ||
      control.id === '3.11.1' ||
      control.id === '3.12.1' ||
      control.id === '3.13.1' ||
      control.id === '3.14.1' ||
      control.id.includes('.L2-3.1.1') ||
      control.id.includes('.L2-3.5.1') ||
      control.id.includes('.L2-3.14.1') ||
      control.id.includes('.L2-3.3.1') ||
      control.id.includes('.L2-3.4.1') ||
      control.id.includes('.L2-3.13.1')
    )
  );
  const familyPrefix = getFamilyPrefix(control?.id, control?.domain);
  const familyTitle = control?.domainName || control?.domain || familyPrefix;

  // Escape is handled by the shared <DialogOverlay> (top-most dialog only), not by a window listener here

  // Tab sync: reset to 'objectives' if the inspected control is not a -1 policy control
  useEffect(() => {
    if (!isPolicyControl && activeTab === 'living_policy') {
      setActiveTab('objectives');
    }
  }, [isPolicyControl, activeTab]);

  const compiledFamilyControls = React.useMemo(() => {
    if (!isPolicyControl || !familyPrefix) return [];
    const norm = familyPrefix.split('-')[0].trim().toUpperCase();
    return Object.values(NIST_800_171A_REGISTRY)
      .filter((reg) => (reg.family || '').toUpperCase() === norm)
      .sort((a, b) => a.controlNumber.localeCompare(b.controlNumber, undefined, { numeric: true, sensitivity: 'base' }));
  }, [isPolicyControl, familyPrefix]);

  // CMVP certificates recorded on the Security Protection Assets: cited by the 3.13.11 policy text
  const cryptoModules = useFipsModules();

  const compiledPolicyMarkdown = React.useMemo(() => {
    if (!isPolicyControl || !currentTenant || !familyPrefix) return '';
    return generateFamilyPolicyDocument(currentTenant, familyPrefix, familyTitle, activeFramework, cryptoModules);
  }, [isPolicyControl, currentTenant, familyPrefix, familyTitle, activeFramework, recompileCount, cryptoModules]);

  // Guard return ONLY AFTER all useState, useContext, useMemo, and useEffect hooks have been unconditionally initialized
  if (!activeId || !control) return null;

  const currentFramework = control.framework || activeFramework;
  const currentFrameworkDef = FRAMEWORK_REGISTRY[currentFramework] || FRAMEWORK_REGISTRY.CMMC_L1;

  const ctrlState = state.controls[control.id] || {
    id: control.id,
    tenantId: currentTenant.id,
    status: 'NOT_STARTED',
    implementationNotes: '',
    responsibleRole: 'IT / Security Lead',
    lastUpdated: new Date().toISOString(),
    tags: [],
  };

  const domainInfo = currentFrameworkDef.domains[control.domain] || {
    code: control.domain,
    name: control.domainName || control.domain,
    description: '',
    totalControls: 0,
    iconName: 'Shield',
    color: '#06b6d4',
  };

  const authorityRef =
    control.authorityReference ||
    control.farReference ||
    'NIST SP 800-171 Requirement';
  const controlEvidence = state.evidenceIndex.filter((e) => e.controlId === control.id);
  const objectives = getObjectivesForControl(control.id);
  const metObjectivesCount = objectives.filter((o) => o.status === 'MET').length;

  // Mappings
  const rawMappings =
    control.mappings && control.mappings.length > 0
      ? control.mappings
      : getCrossFrameworkMappings(control.id).map((m) => ({
          targetFramework: m.targetFramework === currentFramework ? m.sourceFramework : m.targetFramework,
          targetControlId: m.targetControlId === control.id ? m.sourceControlId : m.targetControlId,
          targetTitle: m.notes,
          mappingType: m.mappingType,
        }));

  // DISA STIG Benchmark mappings
  const mappedStigRules = getStigRulesForControl(control.id);

  const handleRecompile = () => {
    setRecompileCount((prev) => prev + 1);
    setRecompileNotice(true);
    setTimeout(() => setRecompileNotice(false), 3000);
  };

  const handleExportPolicyMarkdown = () => {
    const filename = `${familyPrefix}_Family_Living_Policy_${currentTenant.cageCode || 'Enclave'}.md`;
    const blob = new Blob([compiledPolicyMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyPolicyMarkdown = () => {
    copyToClipboard(compiledPolicyMarkdown);
    setCopiedPolicy(true);
    setTimeout(() => setCopiedPolicy(false), 2000);
  };

  const handleClose = () => {
    if (propOnClose) {
      propOnClose();
    } else {
      setSelectedControlId(null);
    }
  };

  const handlePrev = () => {
    if (controlIndex > 0) {
      const prevControl = frameworkControls[controlIndex - 1];
      setSelectedControlId(prevControl.id);
    }
  };

  const handleNext = () => {
    if (controlIndex >= 0 && controlIndex < frameworkControls.length - 1) {
      const nextControl = frameworkControls[controlIndex + 1];
      setSelectedControlId(nextControl.id);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(control.id, files[i]);
      }
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (!canEdit) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(control.id, files[i]);
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleApplyTemplate = (narrative: string) => {
    applyStarterTemplate(control.id, narrative);
    setTemplateAppliedNotice(true);
    setTimeout(() => setTemplateAppliedNotice(false), 3000);
  };

  const handleCopyHash = (hash?: string) => {
    if (!hash) return;
    copyToClipboard(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const handleApplyStigNarrative = (rule: StigRule) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives for this tenant.');
      return;
    }
    let newNotes = `[DISA STIG Baseline - ${rule.vulnId} / ${rule.ruleVersion}]:\n${rule.policyNarrative}`;
    if (ctrlState.implementationNotes && ctrlState.implementationNotes.trim()) {
      if (!ctrlState.implementationNotes.includes(rule.policyNarrative)) {
        newNotes = `${ctrlState.implementationNotes}\n\n[DISA STIG Baseline - ${rule.vulnId}]:\n${rule.policyNarrative}`;
      } else {
        newNotes = ctrlState.implementationNotes;
      }
    }
    updateControlNotes(control.id, newNotes);
    setAppliedStigRuleId(rule.id);
    setTimeout(() => setAppliedStigRuleId(null), 2500);
  };

  const starterTemplates = control.starterTemplates || [];
  const filteredTemplates = starterTemplates.filter((t) => {
    if (templateFilter === 'all') return true;
    return t.category === templateFilter;
  });

  const handleNavigateToMapped = (targetFramework: ComplianceFramework, targetControlId: string) => {
    if (FRAMEWORK_REGISTRY[targetFramework]) {
      setActiveFramework(targetFramework);
    }
    setSelectedControlId(targetControlId);
  };

  return (
    <DialogOverlay onClose={handleClose} className="no-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-scaleUp">
        {/* ── Top Header ── */}
        <div className="px-6 py-4 bg-slate-850 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono font-bold text-sm tracking-wide px-3 py-1 rounded-xl bg-cyan-950/60 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40">
              {control.id}
            </span>
            <span
              className="text-xs font-semibold px-2.5 py-0.5 rounded-lg"
              style={{
                backgroundColor: `${domainInfo.color}15`,
                color: domainInfo.color,
                border: `1px solid ${domainInfo.color}30`,
              }}
            >
              {domainInfo.name}
            </span>
            <span className="hidden sm:inline text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
              {authorityRef}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Prev / Next controls */}
            {frameworkControls.length > 0 && (
              <div className="flex items-center gap-1 mr-2 bg-slate-800 rounded-xl p-1 border border-slate-700">
                <button
                  onClick={handlePrev}
                  disabled={controlIndex <= 0}
                  className="p-1 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Previous Control"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono text-slate-400 px-1">
                  {controlIndex >= 0 ? `${controlIndex + 1}/${frameworkControls.length}` : control.id}
                </span>
                <button
                  onClick={handleNext}
                  disabled={controlIndex < 0 || controlIndex === frameworkControls.length - 1}
                  className="p-1 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                  title="Next Control"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Fluid Close Trigger */}
            <button
              onClick={handleClose}
              className="modal-close-trigger p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              title="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── Title & Status Strip ── */}
        <div className="px-6 py-4 bg-slate-900 border-b border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
          <div>
            <DialogTitle as="h2" className="text-xl font-bold text-white tracking-tight">{control.title}</DialogTitle>
            <p className="text-xs text-slate-400 mt-0.5">{control.plainEnglishSummary}</p>
          </div>

          {/* Workflow Status Selector */}
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-2xl border border-slate-800 shrink-0 self-start md:self-auto">
            {(
              [
                { id: 'NOT_STARTED', label: 'Not Started', active: 'bg-slate-800 text-white font-mono' },
                { id: 'IN_PROGRESS', label: 'In Progress', active: 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono font-bold' },
                { id: 'MET', label: 'Met', active: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-mono font-bold' },
                { id: 'NOT_MET', label: 'Not Met', active: 'bg-rose-500/20 text-rose-300 border border-rose-500/40 font-mono font-bold' },
              ] as { id: ControlStatus; label: string; active: string }[]
            ).map((s) => {
              const isSelected = ctrlState.status === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => updateControlStatus(control.id, s.id)}
                  disabled={!canEdit}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 disabled:opacity-60 ${
                    isSelected ? s.active : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── MANDATORY C3PAO ASSESSMENT METHOD BANNER ── */}
        <div className="px-6 py-3 bg-gradient-to-r from-cyan-950/70 via-slate-900 to-indigo-950/60 border-b border-cyan-500/30 flex items-center gap-3 shrink-0">
          <ShieldAlert className="w-5 h-5 text-cyan-400 shrink-0 animate-pulse motion-reduce:animate-none" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-cyan-200 tracking-wide">
              C3PAO Assessment Method: All objectives must be satisfied for overall control compliance.
            </p>
            <p className="text-xs text-slate-400">
              Under DoD CMMC Assessment Guide Level 2 and NIST SP 800-171A, each determination statement [a], [b], [c]... must be evaluated and verified as MET or N/A. Any NOT_MET objective drops the parent control to NOT_MET.
            </p>
          </div>
        </div>

        {/* ── Navigation Tabs ── */}
        <div className="px-6 border-b border-slate-800 flex items-center gap-6 text-sm font-semibold text-slate-400 shrink-0 overflow-x-auto">
          {/* PRIMARY TAB: Assessment Objectives */}
          <button
            onClick={() => setActiveTab('objectives')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'objectives'
                ? 'border-cyan-400 text-cyan-300 font-bold'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <ListChecks className="w-4 h-4 text-cyan-400" />
            <span>Assessment Objectives</span>
            <span className="badge text-xs px-1.5 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800/60 font-mono">
              {metObjectivesCount}/{objectives.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('narrative')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'narrative'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>System Security Plan (SSP)</span>
          </button>

          <button
            onClick={() => setActiveTab('evidence')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'evidence'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Paperclip className="w-4 h-4" />
            <span>Evidence Vault ({controlEvidence.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('guidance')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'guidance'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>Auditor Guidance</span>
          </button>

          <button
            onClick={() => setActiveTab('mappings')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'mappings'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Share2 className="w-4 h-4" />
            <span>Cross-Framework Mappings ({rawMappings.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('stigs')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'stigs'
                ? 'border-cyan-400 text-cyan-300 font-bold'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>STIG Hardening ({mappedStigRules.length})</span>
          </button>

          {/* Generated Living Policy Tab Button (for any -1 control) */}
          {isPolicyControl && (
            <button
              onClick={() => setActiveTab('living_policy')}
              className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
                activeTab === 'living_policy'
                  ? 'border-cyan-400 text-cyan-300 font-bold'
                  : 'border-transparent hover:text-slate-200'
              }`}
            >
              <FileText className="w-4 h-4 text-cyan-400" />
              <span>Generated Living Policy</span>
              <span className="badge text-xs px-1.5 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800/60 font-mono">
                LIVE STACK
              </span>
            </button>
          )}
        </div>

        {/* ── Scrollable Tab Body ── */}
        <div className="p-6 overflow-y-auto flex-1 min-h-[420px]">
          {/* 1. PRIMARY TAB: Objective-Level Evaluation */}
          {activeTab === 'objectives' && (
            <ObjectiveChecklist controlId={control.id} />
          )}

          {/* 2. Implementation Narrative & SSP Tab */}
          {activeTab === 'narrative' && (
            <div className="space-y-6">
              {templateAppliedNotice && (
                <div className="p-3 rounded-xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 text-xs flex items-center gap-2 animate-fadeIn">
                  <Check className="w-4 h-4 text-cyan-400" />
                  <span>Starter implementation template successfully applied to this control!</span>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Compiled SSP Implementation Narrative
                  </label>
                  <span className="text-xs text-slate-400">
                    {ctrlState.lastUpdated ? `Last modified ${new Date(ctrlState.lastUpdated).toLocaleDateString()}` : ''}
                  </span>
                </div>
                <textarea
                  rows={8}
                  value={ctrlState.implementationNotes || ''}
                  onChange={(e) => updateControlNotes(control.id, e.target.value)}
                  disabled={!canEdit}
                  placeholder="Detail your organizational implementation for this requirement across people, processes, and technology..."
                  className="w-full p-4 rounded-2xl bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/60 transition-all font-mono leading-relaxed disabled:opacity-60"
                />
                <OdpPanel control={control} notes={ctrlState.implementationNotes || ''} canEdit={canEdit} tenantId={currentTenant.id} onNotesChange={(next) => updateControlNotes(control.id, next)} />
              </div>

              {/* Starter Templates */}
              {starterTemplates.length > 0 && (
                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-cyan-400" />
                        <span>Pre-Packaged Architecture Templates</span>
                      </h4>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Adopt pre-written compliance statements for popular cloud and on-prem baselines.
                      </p>
                    </div>

                    <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
                      {(['all', 'm365', 'activedirectory', 'physical'] as const).map((cat) => (
                        <button
                          key={cat}
                          onClick={() => setTemplateFilter(cat)}
                          className={`px-2.5 py-1 rounded-lg capitalize font-medium transition-colors ${
                            templateFilter === cat ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          {cat === 'all' ? 'All' : cat === 'activedirectory' ? 'Active Directory' : cat.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredTemplates.map((tmpl, idx) => (
                      <div
                        key={idx}
                        className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80 hover:border-cyan-500/40 transition-colors flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-white">{tmpl.title}</span>
                            <span className="badge text-xs uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-300">
                              {tmpl.category}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 line-clamp-3 mb-3">{tmpl.narrative}</p>
                        </div>
                        <button
                          onClick={() => handleApplyTemplate(tmpl.narrative)}
                          disabled={!canEdit}
                          className="w-full py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 hover:border-cyan-400 transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>Apply to Narrative</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 3. Evidence Vault Tab */}
          {activeTab === 'evidence' && (
            <div className="space-y-6">
              {/* Drag & Drop Upload Zone */}
              {canEdit && (
                <div role="button" tabIndex={0} onKeyDown={activateOnKey} aria-label="Upload evidence files: drop files here or press Enter to browse"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingOver(true);
                  }}
                  onDragLeave={() => setIsDraggingOver(false)}
                  onDrop={handleFileDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`p-6 border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all ${
                    isDraggingOver
                      ? 'border-cyan-400 bg-cyan-950/20'
                      : 'border-slate-800 hover:border-slate-700 bg-slate-950/40'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <Upload className="w-6 h-6 text-cyan-400 mx-auto mb-2" />
                  <p className="text-xs font-bold text-white">
                    {isUploading ? 'Encrypting & Storing Evidence...' : 'Click to Upload or Drag & Drop'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    PDF, PNG, JPG, DOCX, TXT, LOG up to 50MB. Files are cryptographically hashed with SHA-256 for audit immutability.
                  </p>
                </div>
              )}

              {/* Uploaded Evidence Items */}
              <div className="space-y-3">
                {(() => {
                  const storageProvider = storageConfig.provider;
                  const localStoragePath = storageConfig.localStoragePath;
                  const isLocal = storageProvider === 'local';

                  return (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-1">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                        Attached Evidence Artifacts ({controlEvidence.length})
                      </h4>
                      {isLocal && (
                        <span className="badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 font-mono text-xs font-bold shadow-sm shadow-cyan-950/30">
                          <HardDrive className="w-3 h-3 text-cyan-400" />
                          <span>LOCAL ENCLAVE STORAGE ({localStoragePath})</span>
                        </span>
                      )}
                    </div>
                  );
                })()}

              {controlEvidence.length === 0 ? (
                <div className="p-8 rounded-2xl bg-slate-950/40 border border-slate-800 text-center">
                  <Paperclip className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-300">No Evidence Uploaded Yet</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                    Attach screenshots, GPO exports, network configs, or policy sign-off documents to satisfy C3PAO audit requirements.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {controlEvidence.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-4 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0">
                          <FileCheck className="w-5 h-5 text-cyan-400" />
                        </div>
                        <div className="min-w-0 space-y-0.5">
                          <p className="text-xs font-bold text-white truncate">{ev.name}</p>
                          <div className="flex items-center gap-2 flex-wrap text-xs">
                            <span className="text-slate-400 font-mono">
                              {(ev.fileSize / 1024).toFixed(1)} KB • {new Date(ev.uploadedAt).toLocaleDateString()}
                            </span>
                            {storageConfig.provider === 'local' ? (
                              <span className="badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60 font-mono text-xs font-bold">
                                <ShieldCheck className="w-2.5 h-2.5 text-cyan-400" />
                                <span>LOCAL ENCLAVE • SHA-256 CHECKED</span>
                              </span>
                            ) : (
                              <span className="badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-xs">
                                GCS SYNCED
                              </span>
                            )}
                          </div>
                          {ev.fileHash && (
                            <p className="text-xs text-cyan-400/80 font-mono truncate max-w-md">
                              SHA-256: {ev.fileHash}
                            </p>
                          )}
                        </div>
                      </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setPreviewEvidence(ev)}
                            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                            title="Preview Evidence"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {ev.fileHash && (
                            <button
                              onClick={() => handleCopyHash(ev.fileHash)}
                              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                              title="Copy SHA-256 Hash"
                            >
                              {copiedHash === ev.fileHash ? (
                                <Check className="w-4 h-4 text-emerald-400" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          {canEdit && (
                            <button
                              onClick={() => removeEvidence(ev.id)}
                              className="p-2 rounded-lg bg-slate-800 hover:bg-rose-900/40 text-slate-400 hover:text-rose-400 transition-colors"
                              title="Delete Evidence"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 4. Auditor Guidance & Discussion Tab */}
          {activeTab === 'guidance' && (
            <div className="space-y-6">
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80 space-y-2">
                <h4 className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-2">
                  <Info className="w-4 h-4" />
                  <span>Discussion & Scope</span>
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed font-sans">{control.discussion}</p>
              </div>

              {/* Auditor Checklist Items */}
              {control.auditorChecklist && control.auditorChecklist.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                    Auditor Examination Checklist
                  </h4>
                  <div className="space-y-2">
                    {control.auditorChecklist.map((item: string, idx: number) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3"
                      >
                        <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                        <span className="text-xs text-slate-300">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 5. Cross-Framework Mappings Tab */}
          {activeTab === 'mappings' && (
            <div className="space-y-4">
              <CrosswalkPanel controlId={control.id} />
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                Cross-Framework Harmonization ({rawMappings.length})
              </h4>
              {rawMappings.length === 0 ? (
                <p className="text-xs text-slate-400">No cross-framework mappings defined for this control.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {rawMappings.map((m, idx) => (
                    <button type="button"
                      key={idx}
                      onClick={() => handleNavigateToMapped(m.targetFramework, m.targetControlId)}
                      className="w-full text-left p-4 rounded-xl bg-slate-950 border border-slate-800/80 hover:border-cyan-500/40 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs font-bold text-cyan-300">
                          {m.targetControlId}
                        </span>
                        <span className="badge text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                          {m.targetFramework}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 truncate">{m.targetTitle || 'Mapped Requirement'}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 6. DISA STIG Hardening Tab */}
          {activeTab === 'stigs' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    <span>DISA STIG Technical Hardening Rules ({mappedStigRules.length})</span>
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    DoD security configuration baselines applicable to this control.
                  </p>
                </div>
              </div>

              {mappedStigRules.length === 0 ? (
                <p className="text-xs text-slate-400">No DISA STIG rules currently mapped to this control.</p>
              ) : (
                <div className="space-y-3">
                  {mappedStigRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="p-4 rounded-2xl bg-slate-950 border border-slate-800/80 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-cyan-300">{rule.vulnId}</span>
                          <span className="font-mono text-xs text-slate-400">({rule.ruleVersion})</span>
                          <span
                            className={`badge text-xs px-2 py-0.5 rounded font-bold uppercase font-mono ${
                              rule.severity === 'CAT_I'
                                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                : rule.severity === 'CAT_II'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {rule.severity}
                          </span>
                        </div>
                        <button
                          onClick={() => handleApplyStigNarrative(rule)}
                          disabled={!canEdit}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-300 border border-cyan-500/30 transition-colors"
                        >
                          {appliedStigRuleId === rule.id ? 'Applied!' : 'Adopt STIG Narrative'}
                        </button>
                      </div>

                      <p className="text-xs font-semibold text-white">{rule.title}</p>
                      <p className="text-xs text-slate-300 leading-relaxed font-sans">{rule.policyNarrative}</p>

                      <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400 font-mono">
                        <span>Benchmark: {rule.benchmarkId}</span>
                        <span>Rule: {rule.id}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 7. Generated Living Policy Tab (for -1 controls) */}
          {isPolicyControl && activeTab === 'living_policy' && (
            <div className="space-y-6 animate-fadeIn">
              {/* Action Toolbar */}
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-cyan-400" />
                    Living Policy: {familyPrefix} ({familyTitle})
                  </span>
                  <span className="badge text-xs font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
                    Compiled from Active Enclave Stack
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Re-Compile from Enclave Stack Button */}
                  <button
                    onClick={handleRecompile}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-colors"
                    title="Re-run policy compilation engine with current enclave tech stack parameters"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Re-Compile from Enclave Stack</span>
                  </button>

                  {/* Open Enclave Stack Survey Wizard Button */}
                  <button
                    onClick={() => setIsSurveyModalOpen(true)}
                    className="px-3 py-1.5 rounded-xl bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 hover:text-cyan-200 text-xs font-semibold flex items-center gap-1.5 border border-cyan-500/40 transition-colors"
                    title="Configure Identity, EDR, Cloud, MDM, SIEM, and ODP parameters"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>Configure Stack</span>
                  </button>

                  {/* Export Policy Markdown Button */}
                  <button
                    onClick={handleExportPolicyMarkdown}
                    className="btn-primary px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5"
                    title="Download living policy as .md file"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export Policy Markdown</span>
                  </button>

                  {/* Copy Markdown */}
                  <button
                    onClick={handleCopyPolicyMarkdown}
                    className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                    title="Copy Markdown to Clipboard"
                  >
                    {copiedPolicy ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>

                  {/* View Mode Toggle */}
                  <div className="flex items-center bg-slate-900 rounded-xl p-0.5 border border-slate-800">
                    <button
                      onClick={() => setPolicyViewMode('preview')}
                      className={`px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        policyViewMode === 'preview'
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Formatted
                    </button>
                    <button
                      onClick={() => setPolicyViewMode('raw')}
                      className={`px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        policyViewMode === 'raw'
                          ? 'bg-slate-800 text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Raw .MD
                    </button>
                  </div>
                </div>
              </div>

              {/* Re-compile Feedback */}
              {recompileNotice && (
                <div className="p-3 rounded-xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 text-xs flex items-center gap-2 animate-fadeIn">
                  <Check className="w-4 h-4 text-cyan-400" />
                  <span>Living Policy successfully re-compiled from active Enclave Stack profile and ODP parameters!</span>
                </div>
              )}

              {/* Active Stack Highlights Ribbon */}
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center gap-2 flex-wrap text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Active Enclave Telemetry Stack:</span>
                <span className="badge px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-900/60 font-mono text-xs">
                  IAM: {currentTenant.stackProfile?.identityProvider || 'ENTRA_ID_COMMERCIAL'}
                </span>
                <span className="badge px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-900/60 font-mono text-xs">
                  EDR: {currentTenant.stackProfile?.edrSolution || 'DEFENDER_FOR_ENDPOINT'}
                </span>
                <span className="badge px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-900/60 font-mono text-xs">
                  Infra: {currentTenant.stackProfile?.infrastructure || 'AZURE_GOV'}
                </span>
                <span className="badge px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-900/60 font-mono text-xs">
                  MDM: {currentTenant.stackProfile?.mdmSolution || 'INTUNE'}
                </span>
                <span className="badge px-2 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-900/60 font-mono text-xs">
                  SIEM: {currentTenant.stackProfile?.siemSolution || 'SENTINEL'}
                </span>
              </div>

              {/* Document Rendering */}
              {policyViewMode === 'preview' ? (
                <div className="p-6 rounded-2xl bg-slate-950 border border-slate-800 text-slate-200 space-y-6 shadow-inner">
                  {/* Document Header Card */}
                  <div className="border-b border-slate-800 pb-5">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div>
                        <span className="text-xs font-mono uppercase tracking-widest text-cyan-400 font-bold">
                          Enclave Living Policy Standard
                        </span>
                        <h1 className="text-xl font-extrabold text-white mt-1">
                          {familyTitle} ({familyPrefix}) Policy
                        </h1>
                      </div>
                      <div className="text-right text-xs text-slate-400 font-mono">
                        <div>Rev Date: {new Date().toISOString().split('T')[0]}</div>
                        <div className="text-emerald-400 font-semibold">Status: APPROVED & ENFORCED</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4 pt-4 border-t border-slate-800/80 text-xs font-mono">
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block text-xs">Organization</span>
                        <span className="font-bold text-white">{currentTenant.name}</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block text-xs">System Name</span>
                        <span className="font-bold text-white">{currentTenant.systemName}</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block text-xs">CAGE Code / SAM</span>
                        <span className="font-bold text-white">{currentTenant.cageCode || 'N/A'} ({currentTenant.samStatus})</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block text-xs">Authorizing Official</span>
                        <span className="font-bold text-white">{currentTenant.systemOwner}</span>
                      </div>
                    </div>
                  </div>

                  {/* Section 1 & 2: Purpose & Scope */}
                  <div className="space-y-4 text-xs leading-relaxed text-slate-300">
                    <div>
                      <h2 className="text-sm font-bold text-white mb-1.5 flex items-center gap-2">
                        <span className="w-5 h-5 rounded-md bg-cyan-950 text-cyan-400 flex items-center justify-center font-mono text-xs">1</span>
                        Purpose
                      </h2>
                      <p className="bg-slate-900/60 p-3 rounded-xl border border-slate-800/60">
                        The purpose of this policy is to establish formal management requirements and operational safeguards for the {familyTitle} family of controls in accordance with NIST SP 800-53 Rev. 5, NIST SP 800-171, and CMMC requirements.
                      </p>
                    </div>

                    <div>
                      <h2 className="text-sm font-bold text-white mb-1.5 flex items-center gap-2">
                        <span className="w-5 h-5 rounded-md bg-cyan-950 text-cyan-400 flex items-center justify-center font-mono text-xs">2</span>
                        Scope
                      </h2>
                      <p className="bg-slate-900/60 p-3 rounded-xl border border-slate-800/60">
                        This policy applies to all information systems, networks, software configurations, and personnel operating within or interacting with the {currentTenant.systemName} boundary.
                      </p>
                    </div>
                  </div>

                  {/* Section 3: Policy Statements */}
                  <div className="space-y-4">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-cyan-950 text-cyan-400 flex items-center justify-center font-mono text-xs">3</span>
                      Policy Statements & Implementation Baselines
                    </h2>

                    <div className="space-y-3">
                      {compiledFamilyControls.map((ctrl) => (
                        <div key={ctrl.controlNumber} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="badge font-mono text-xs font-bold text-cyan-300 px-2 py-0.5 rounded bg-cyan-950 border border-cyan-800/60">
                                {ctrl.controlNumber}
                              </span>
                              <span className="text-xs font-bold text-white">{ctrl.title}</span>
                            </div>
                            <span className="badge text-xs font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">
                              {ctrl.objectives.length} Objectives Tailored
                            </span>
                          </div>

                          <div className="space-y-2.5 pt-1">
                            {ctrl.objectives.map((obj) => {
                              const narrative = getCascadedObjectiveNarrative(
                                ctrl.controlNumber,
                                obj.letter,
                                currentTenant.stackProfile || {
                                  identityProvider: 'ENTRA_ID_COMMERCIAL',
                                  edrSolution: 'DEFENDER_FOR_ENDPOINT',
                                  infrastructure: 'AZURE_GOV',
                                  mdmSolution: 'INTUNE',
                                  siemSolution: 'SENTINEL',
                                  odpParams: {},
                                },
                                cryptoModules
                              );
                              return (
                                <div key={obj.letter} className="text-xs bg-slate-950/70 p-3 rounded-lg border border-slate-800/60 space-y-1.5">
                                  <div className="font-semibold text-cyan-200">
                                    Objective [{obj.letter}]: <span className="text-slate-300 font-normal">{obj.text}</span>
                                  </div>
                                  <div className="text-slate-300 text-xs leading-relaxed pt-1 border-t border-slate-800/60">
                                    <strong className="text-slate-400">Implementation: </strong>
                                    {narrative}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Section 4: Revision History */}
                  <div className="space-y-2">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-cyan-950 text-cyan-400 flex items-center justify-center font-mono text-xs">4</span>
                      Revision History
                    </h2>
                    <div className="overflow-x-auto rounded-xl border border-slate-800">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-900 text-slate-400 uppercase font-mono text-xs">
                          <tr>
                            <th className="p-2.5">Date</th>
                            <th className="p-2.5">Version</th>
                            <th className="p-2.5">Description</th>
                            <th className="p-2.5">Author</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800 text-slate-300">
                          <tr>
                            <td className="p-2.5 font-mono">{new Date().toISOString().split('T')[0]}</td>
                            <td className="p-2.5 font-mono">1.0</td>
                            <td className="p-2.5">Initial Living Policy generation from Enclave Stack</td>
                            <td className="p-2.5">Singularity Policy Compiler</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Section 5: Authorizing Official Signature Block */}
                  <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2 text-xs">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-cyan-950 text-cyan-400 flex items-center justify-center font-mono text-xs">5</span>
                      Authorizing Official Approval
                    </h2>
                    <p className="text-slate-400">
                      I have reviewed and formally approved this policy for the {currentTenant.systemName} boundary.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 font-mono text-xs">
                      <div>
                        <strong>Signature: </strong>
                        <span className="border-b border-slate-600 inline-block w-48 ml-1"></span>
                      </div>
                      <div>
                        <strong>Date: </strong>
                        <span className="border-b border-slate-600 inline-block w-32 ml-1"></span>
                      </div>
                      <div>
                        <strong>Name: </strong> {currentTenant.systemOwner}
                      </div>
                      <div>
                        <strong>Title: </strong> System Owner / Authorizing Official
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Raw Markdown View */
                <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-400">policy_document.md</span>
                    <button
                      onClick={handleCopyPolicyMarkdown}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 flex items-center gap-1 border border-slate-700 transition-colors"
                    >
                      {copiedPolicy ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPolicy ? 'Copied' : 'Copy Raw'}</span>
                    </button>
                  </div>
                  <pre className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[500px]">
                    {compiledPolicyMarkdown}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Enclave Stack Survey Wizard Modal */}
        <EnclaveStackSurveyModal
          isOpen={isSurveyModalOpen}
          onClose={() => setIsSurveyModalOpen(false)}
          onSaved={() => {
            handleRecompile();
          }}
        />
      </div>
    </DialogOverlay>
  );
};

export const InspectDocumentModal: React.FC<InspectDocumentModalProps> = (props) => {
  const { selectedControlId, setSelectedControlId } = useAssessment();
  const activeId = props.controlId !== undefined ? props.controlId : selectedControlId;

  // Nothing is open, so there is nothing to guard.
  if (!activeId) return null;

  return (
    <ErrorBoundary
      name="Control Inspector"
      variant="modal"
      resetKeys={[activeId]}
      onReset={() => (props.onClose ? props.onClose() : setSelectedControlId(null))}
    >
      <InspectDocumentModalContent {...props} />
    </ErrorBoundary>
  );
};

export default InspectDocumentModal;
