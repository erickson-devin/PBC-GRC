import React, { useState, useRef } from 'react';
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
  Download,
  ChevronLeft,
  ChevronRight,
  User,
  Info,
  Check,
  Lock,
  Cloud,
  Shield,
  Copy,
  Share2,
  ArrowRight,
  Terminal,
} from 'lucide-react';
import { ControlStatus, EvidenceItem } from '../../types/cmmc';
import { ComplianceFramework } from '../../types/framework';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { EvidenceVault } from '../../services/evidenceVault';
import {
  findControlDefinition,
  FRAMEWORK_REGISTRY,
  getCrossFrameworkMappings,
} from '../../data/frameworks';
import { getStigRulesForControl } from '../../data/stigs/stigCatalog';
import { StigRule } from '../../types/stig';

export const ControlDetailModal: React.FC = () => {
  const {
    selectedControlId,
    setSelectedControlId,
    frameworkControls,
    state,
    updateControlStatus,
    updateControlNotes,
    updateControlRole,
    applyStarterTemplate,
    uploadEvidence,
    removeEvidence,
    setPreviewEvidence,
  } = useAssessment();

  const { canEdit, currentTenant, activeFramework, setActiveFramework } = useTenant();

  const [activeTab, setActiveTab] = useState<'narrative' | 'guidance' | 'evidence' | 'mappings' | 'stigs'>('narrative');
  const [templateFilter, setTemplateFilter] = useState<'all' | 'm365' | 'gcp' | 'activedirectory' | 'physical'>('all');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [templateAppliedNotice, setTemplateAppliedNotice] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [copiedStigFixId, setCopiedStigFixId] = useState<string | null>(null);
  const [appliedStigRuleId, setAppliedStigRuleId] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!selectedControlId) return null;

  const controlIndex = frameworkControls.findIndex((c) => c.id === selectedControlId);
  const control = controlIndex >= 0 ? frameworkControls[controlIndex] : findControlDefinition(selectedControlId);
  if (!control) return null;

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
    name: (control as any).domainName || control.domain,
    description: '',
    totalControls: 0,
    iconName: 'Shield',
    color: '#06b6d4',
  };

  const authorityRef = (control as any).authorityReference || (control as any).farReference || 'Baseline Requirement';
  const controlEvidence = state.evidenceIndex.filter((e) => e.controlId === control.id);

  // Mappings
  const rawMappings = control.mappings && control.mappings.length > 0
    ? control.mappings
    : getCrossFrameworkMappings(control.id).map(m => ({
        targetFramework: m.targetFramework === currentFramework ? m.sourceFramework : m.targetFramework,
        targetControlId: m.targetControlId === control.id ? m.sourceControlId : m.targetControlId,
        targetTitle: m.notes,
        mappingType: m.mappingType,
      }));

  // DISA STIG Benchmark mappings for active control
  const mappedStigRules = getStigRulesForControl(control.id);

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

  const handleCopyStigFix = async (ruleId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStigFixId(ruleId);
      setTimeout(() => setCopiedStigFixId(null), 2000);
    } catch {
      // Fallback
    }
  };

  // Navigation handlers
  const handlePrev = () => {
    if (controlIndex > 0) {
      setSelectedControlId(frameworkControls[controlIndex - 1].id);
    }
  };

  const handleNext = () => {
    if (controlIndex >= 0 && controlIndex < frameworkControls.length - 1) {
      setSelectedControlId(frameworkControls[controlIndex + 1].id);
    }
  };

  // Upload handler
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to upload evidence files.');
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(control.id, files[i]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Failed to upload evidence file.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canEdit) return;
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (!canEdit) return;

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(control.id, files[i]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Failed to upload evidence file.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownloadFile = async (evidence: EvidenceItem) => {
    const fileData = await EvidenceVault.getFile(currentTenant.id, evidence.id);
    if (!fileData) {
      alert('This evidence file does not have local binary storage attached (Cloud metadata reference only).');
      return;
    }
    const url = URL.createObjectURL(fileData.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = evidence.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleApplyTemplate = (narrative: string) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to modify narratives.');
      return;
    }

    if (ctrlState.implementationNotes.trim().length > 0) {
      if (!window.confirm('Applying this template will replace your current implementation narrative. Proceed?')) {
        return;
      }
    }
    applyStarterTemplate(control.id, narrative);
    setTemplateAppliedNotice(true);
    setTimeout(() => setTemplateAppliedNotice(false), 3000);
  };

  const handleCopyHash = (hash?: string) => {
    if (!hash) return;
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const starterTemplates = control.starterTemplates || [];
  const filteredTemplates = starterTemplates.filter(t => {
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
    <div className="no-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-scaleUp">
        
        {/* Top Header */}
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
              onClick={() => setSelectedControlId(null)}
              className="modal-close-trigger"
              title="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Title & Status Strip */}
        <div className="px-6 py-4 bg-slate-900 border-b border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">{control.title}</h2>
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

        {/* Navigation Tabs */}
        <div className="px-6 border-b border-slate-800 flex items-center gap-6 text-sm font-semibold text-slate-400 shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab('narrative')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors shrink-0 ${
              activeTab === 'narrative'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Implementation Narrative</span>
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
            <span>Auditor Guidance & Objectives</span>
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
            {mappedStigRules.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold">
                DISA
              </span>
            )}
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          
          {/* TAB 1: IMPLEMENTATION NARRATIVE */}
          {activeTab === 'narrative' && (
            <div className="space-y-6">
              
              {/* Starter Templates Picker */}
              {starterTemplates.length > 0 ? (
                <div className="p-4 rounded-2xl bg-slate-950/70 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-brand-400 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      Pre-Built Starter Templates
                    </span>
                    {templateAppliedNotice && (
                      <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" /> Template Inserted!
                      </span>
                    )}
                    
                    {/* Category Filter Chips */}
                    <div className="flex items-center gap-1">
                      {(['all', 'm365', 'gcp', 'activedirectory', 'physical'] as const).map(cat => (
                        <button
                          key={cat}
                          onClick={() => setTemplateFilter(cat)}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                            templateFilter === cat ? 'bg-brand-600 text-white' : 'bg-slate-850 text-slate-400 hover:text-white'
                          }`}
                        >
                          {cat === 'all' ? 'All' : cat === 'm365' ? 'M365' : cat === 'gcp' ? 'GCP' : cat === 'activedirectory' ? 'On-Prem' : 'Physical'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredTemplates.map((tmpl, idx) => (
                      <div
                        key={idx}
                        className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-brand-500/50 transition-all flex flex-col justify-between space-y-2 group"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="text-xs font-bold text-white group-hover:text-brand-300">
                              {tmpl.title}
                            </h4>
                            <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                              {tmpl.category}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                            {tmpl.description}
                          </p>
                        </div>

                        <button
                          onClick={() => handleApplyTemplate(tmpl.narrative)}
                          disabled={!canEdit}
                          className="w-full py-1.5 px-3 rounded-lg bg-brand-600/20 hover:bg-brand-600 text-brand-300 hover:text-white border border-brand-500/30 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                        >
                          <Sparkles className="w-3 h-3" />
                          <span>Insert This Template</span>
                        </button>
                      </div>
                    ))}

                    {filteredTemplates.length === 0 && (
                      <div className="col-span-2 text-center py-4 text-xs text-slate-500">
                        No starter templates for this category filter.
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 text-xs text-slate-400 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    <span>Cross-Framework Baseline: Author custom organizational narrative or inherit evidence from mapped controls.</span>
                  </div>
                  {rawMappings.length > 0 && (
                    <button
                      onClick={() => setActiveTab('mappings')}
                      className="text-cyan-300 hover:underline text-[11px] font-medium shrink-0"
                    >
                      View {rawMappings.length} Mappings
                    </button>
                  )}
                </div>
              )}

              {/* Implementation Statement Editor */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5" />
                    Implementation Narrative (How {currentTenant.name} satisfies this requirement)
                  </label>
                  <span className="text-xs text-slate-500 font-mono">
                    {ctrlState.implementationNotes.length} characters
                  </span>
                </div>

                <textarea
                  rows={7}
                  disabled={!canEdit}
                  value={ctrlState.implementationNotes}
                  onChange={(e) => updateControlNotes(control.id, e.target.value)}
                  placeholder="Detail the specific technical controls, policies, procedures, and architectural configurations your organization uses to satisfy this requirement..."
                  className="w-full p-4 rounded-2xl bg-slate-950 border border-slate-800 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-none text-sm text-slate-100 placeholder-slate-500 leading-relaxed font-sans transition-all duration-200 resize-y disabled:opacity-75"
                />
              </div>

              {/* Responsible Role Input */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                    Responsible Role / System Owner
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      disabled={!canEdit}
                      value={ctrlState.responsibleRole}
                      onChange={(e) => updateControlRole(control.id, e.target.value)}
                      placeholder="e.g. CISO, IT Administrator, Security Lead"
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-none disabled:opacity-75"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                    Official Authority Reference
                  </label>
                  <div className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-cyan-300">
                    {authorityRef}
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: EVIDENCE VAULT */}
          {activeTab === 'evidence' && (
            <div className="space-y-6">
              
              {/* Dropzone Upload with Clear Drop Indicators */}
              {canEdit ? (
                <div
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  data-drag-over={isDraggingOver}
                  className={`dropzone-container p-8 transition-all duration-200 ${
                    isDraggingOver
                      ? 'border-cyan-400 bg-cyan-950/40 ring-2 ring-cyan-500/50 shadow-lg shadow-cyan-500/20 scale-[1.01]'
                      : 'hover:border-cyan-500/50 hover:bg-slate-900/60'
                  }`}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    multiple
                    className="hidden"
                  />
                  <div
                    className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 transition-all ${
                      isDraggingOver
                        ? 'bg-cyan-500/30 text-cyan-300 scale-110 animate-bounce'
                        : 'bg-slate-855 text-cyan-400 border border-slate-700'
                    }`}
                  >
                    <Upload className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white transition-colors">
                    {isUploading
                      ? 'Computing SHA-256 & Encrypting into GCS Vault...'
                      : isDraggingOver
                      ? 'Release to Upload Audit Evidence'
                      : 'Click to Upload Audit Evidence or Drag Files Here'}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                    Evidence uploaded here automatically propagates across mapped controls (e.g. CMMC ↔ NIST 800-53 ↔ SOC 2) with cryptographic SHA-256 hash preservation.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-center text-xs text-slate-400">
                  <Lock className="w-4 h-4 inline-block mr-1 text-amber-400" /> Evidence uploads are disabled in Read-Only Viewer mode.
                </div>
              )}

              {/* Attached Evidence List */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5" />
                  Attached Evidence Artifacts ({controlEvidence.length})
                </h4>

                {controlEvidence.length === 0 ? (
                  <div className="p-6 rounded-2xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
                    No evidence files attached to this control yet. Upload policies, screenshots, or logs above.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {controlEvidence.map((item) => {
                      const isInherited = item.syncStatus === ('inherited' as any) || (item.description && item.description.startsWith('[Inherited'));
                      return (
                        <div
                          key={item.id}
                          className={`p-3.5 rounded-2xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-colors ${
                            isInherited ? 'bg-indigo-950/20 border-indigo-500/30' : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-start sm:items-center gap-3 min-w-0">
                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                              isInherited ? 'bg-indigo-900/40 text-indigo-300 border-indigo-500/40' : 'bg-slate-850 text-brand-400 border-slate-700'
                            }`}>
                              <Paperclip className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-xs font-bold text-white truncate">{item.name}</p>
                                {isInherited ? (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                                    Cross-Framework Inherited
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                    <Cloud className="w-2.5 h-2.5" /> GCS Synced
                                  </span>
                                )}
                              </div>
                              
                              {/* Metadata & SHA-256 */}
                              <div className="flex items-center gap-3 text-[10px] text-slate-400 mt-1 flex-wrap font-mono">
                                <span>{Math.round(item.fileSize / 1024)} KB</span>
                                <span>•</span>
                                <span className="truncate max-w-[220px]" title={item.description || item.gcsPath}>
                                  {item.description || item.gcsPath || `gs://tenants/${currentTenant.id}/...`}
                                </span>
                                {item.fileHash && (
                                  <>
                                    <span>•</span>
                                    <button
                                      onClick={() => handleCopyHash(item.fileHash)}
                                      title="Copy SHA-256 Hash"
                                      className="flex items-center gap-1 text-slate-300 hover:text-white bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800"
                                    >
                                      <Shield className="w-2.5 h-2.5 text-brand-400" />
                                      <span>SHA-256: {item.fileHash.substring(0, 8)}...</span>
                                      {copiedHash === item.fileHash ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                            <button
                              onClick={() => setPreviewEvidence(item)}
                              title="Preview Evidence"
                              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDownloadFile(item)}
                              title="Download File"
                              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                            {canEdit && (
                              <button
                                onClick={() => removeEvidence(item.id)}
                                title="Delete Evidence"
                                className="p-2 rounded-xl bg-slate-800 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>
          )}

          {/* TAB 3: AUDITOR GUIDANCE & OBJECTIVES */}
          {activeTab === 'guidance' && (
            <div className="space-y-6">
              
              {/* Plain English Discussion */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-brand-400 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  Official Requirement Discussion
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {control.discussion}
                </p>
              </div>

              {/* Assessment Objectives */}
              {control.assessmentObjectives && control.assessmentObjectives.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <ListChecks className="w-3.5 h-3.5 text-brand-400" />
                    Assessment Objectives (What must be proven)
                  </h4>
                  <div className="space-y-2">
                    {control.assessmentObjectives.map((obj, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-start gap-2.5 text-xs text-slate-300"
                      >
                        <div className="w-4 h-4 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                          {idx + 1}
                        </div>
                        <span>{obj}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Auditor Evidence Checklist */}
              {control.auditorChecklist && control.auditorChecklist.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
                    Auditor Evidence Checklist (Artifacts auditors evaluate)
                  </h4>
                  <div className="space-y-2">
                    {control.auditorChecklist.map((item, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 flex items-start gap-2.5 text-xs text-slate-300"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* TAB 4: CROSS-FRAMEWORK MAPPINGS */}
          {activeTab === 'mappings' && (
            <div className="space-y-6">
              
              <div className="p-4 rounded-2xl bg-indigo-950/40 border border-indigo-500/30 space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                  <Share2 className="w-3.5 h-3.5" />
                  Cross-Framework Evidence Inheritance Architecture
                </h4>
                <p className="text-xs text-indigo-200/80 leading-relaxed">
                  Event Horizon GRC automatically maps defense requirements across DoD CMMC, NIST SP 800-53 Rev 5, SOC 2 Type II, and HIPAA Security Rule. Any SHA-256 validated evidence attached to <strong>{control.id}</strong> propagates across these mapped controls without duplicate manual uploads.
                </p>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-cyan-400" />
                  Mapped Equivalent Controls ({rawMappings.length})
                </h4>

                {rawMappings.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
                    No cross-framework mappings defined for this control.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {rawMappings.map((mapping: any, idx: number) => {
                      const targetDef = FRAMEWORK_REGISTRY[mapping.targetFramework as ComplianceFramework];
                      return (
                        <div
                          key={idx}
                          className="p-4 rounded-2xl bg-slate-950 border border-slate-800 hover:border-indigo-500/40 transition-all flex flex-col justify-between space-y-3"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono font-bold text-xs text-indigo-300 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-500/30">
                                {mapping.targetControlId}
                              </span>
                              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                {mapping.mappingType || 'EQUIVALENT'}
                              </span>
                            </div>

                            <p className="text-xs font-bold text-white mt-2">
                              {targetDef ? targetDef.shortName : mapping.targetFramework}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                              {mapping.targetTitle || `Direct equivalence bridge between ${control.id} and ${mapping.targetControlId}.`}
                            </p>
                          </div>

                          <button
                            onClick={() => handleNavigateToMapped(mapping.targetFramework, mapping.targetControlId)}
                            className="w-full py-1.5 px-3 rounded-xl bg-indigo-950/40 hover:bg-indigo-900/60 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <span>Switch to {mapping.targetControlId}</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>
          )}

          {/* TAB 5: DISA STIG BENCHMARK & POLICY TEMPLATE */}
          {activeTab === 'stigs' && (
            <div className="space-y-6">
              <div className="p-4 rounded-2xl bg-cyan-950/40 border border-cyan-500/30 flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0 mt-0.5">
                  <Terminal className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    DISA STIG Technical Hardening & Pre-Vetted Narratives
                  </h4>
                  <p className="text-xs text-cyan-200/80 leading-relaxed">
                    Review official Defense Information Systems Agency (DISA) STIG requirements mapped to <strong>{control.id}</strong>. Copy direct hardening scripts (PowerShell, Bash, Ansible) or inject pre-formulated policy narratives directly into your System Security Plan.
                  </p>
                </div>
              </div>

              {mappedStigRules.length === 0 ? (
                <div className="p-8 text-center rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
                  <Terminal className="w-8 h-8 text-slate-500 mx-auto" />
                  <p className="text-sm font-semibold text-white">
                    No Direct DISA STIG Rules Mapped to {control.id}
                  </p>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    This control may be an administrative, physical, or organizational policy requirement rather than a workstation technical setting. You can browse the full technical catalog from <strong>Enclave Administration &gt; Technical Baselines &amp; STIGs</strong>.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {mappedStigRules.map(rule => {
                    let sevBadge = (
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/40">
                        CAT III (LOW)
                      </span>
                    );
                    if (rule.severity === 'CAT_I') {
                      sevBadge = (
                        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">
                          CAT I (HIGH / CRITICAL)
                        </span>
                      );
                    } else if (rule.severity === 'CAT_II') {
                      sevBadge = (
                        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                          CAT II (MEDIUM)
                        </span>
                      );
                    }

                    const fixScript = rule.powershellSnippet || rule.bashSnippet || rule.ansibleTaskSnippet || rule.fixText;
                    const isApplied = appliedStigRuleId === rule.id;
                    const isCopied = copiedStigFixId === rule.id;

                    return (
                      <div
                        key={rule.id}
                        className="p-5 rounded-2xl bg-slate-950 border border-slate-800 hover:border-cyan-500/40 transition-all space-y-4 shadow-sm"
                      >
                        {/* Header & Meta */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono font-bold text-cyan-400">
                                {rule.vulnId}
                              </span>
                              <span className="text-xs font-mono text-slate-400">
                                {rule.ruleVersion}
                              </span>
                              {sevBadge}
                              <span className="text-slate-500 text-xs">•</span>
                              <span className="text-xs text-slate-400">
                                {rule.benchmarkTitle}
                              </span>
                            </div>
                            <h5 className="text-sm font-bold text-white leading-snug">
                              {rule.title}
                            </h5>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => handleApplyStigNarrative(rule)}
                              disabled={!canEdit}
                              className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm ${
                                isApplied
                                  ? 'bg-emerald-500 text-white font-bold'
                                  : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white'
                              }`}
                              title="Inject this STIG narrative into control implementation notes"
                            >
                              {isApplied ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  <span>Applied!</span>
                                </>
                              ) : (
                                <>
                                  <Sparkles className="w-3.5 h-3.5" />
                                  <span>Apply STIG Narrative</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Discussion */}
                        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1">
                          <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5 text-cyan-400" />
                            Vulnerability Discussion
                          </span>
                          <p className="text-slate-400 leading-relaxed">
                            {rule.discussion}
                          </p>
                        </div>

                        {/* Check & Fix Details */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                            <span className="text-[11px] font-bold text-amber-300 flex items-center gap-1.5">
                              <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                              Check Content (Audit Step)
                            </span>
                            <p className="text-slate-400 leading-relaxed font-mono text-[11px] whitespace-pre-wrap">
                              {rule.checkText}
                            </p>
                          </div>

                          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                            <span className="text-[11px] font-bold text-emerald-300 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              Fix Text (Remediation)
                            </span>
                            <p className="text-slate-400 leading-relaxed font-mono text-[11px] whitespace-pre-wrap">
                              {rule.fixText}
                            </p>
                          </div>
                        </div>

                        {/* Technical Script / Snippet */}
                        {fixScript && (
                          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 text-xs space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-bold text-cyan-300 flex items-center gap-1.5">
                                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                                Automated Enforcement Script ({rule.powershellSnippet ? 'PowerShell' : rule.bashSnippet ? 'Bash' : 'Ansible / CLI'})
                              </span>
                              <button
                                onClick={() => handleCopyStigFix(rule.id, fixScript)}
                                className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
                              >
                                {isCopied ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-emerald-400">Copied!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    <span>Copy Fix Script</span>
                                  </>
                                )}
                              </button>
                            </div>

                            <pre className="p-2.5 rounded-lg bg-slate-950 border border-slate-850 font-mono text-[11px] text-cyan-200 overflow-x-auto whitespace-pre leading-normal">
                              {fixScript}
                            </pre>
                          </div>
                        )}

                        {/* Official Policy Narrative Snippet */}
                        <div className="p-3 rounded-xl bg-indigo-950/25 border border-indigo-500/30 text-xs space-y-1">
                          <span className="text-[11px] font-bold text-indigo-300 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                            Official STIG Implementation Narrative
                          </span>
                          <p className="text-slate-300 italic text-[11px] leading-relaxed">
                            "{rule.policyNarrative}"
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-slate-850 border-t border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="text-xs text-slate-400">
            Tenant: <strong className="text-white">{currentTenant.name}</strong> • Framework: <span className="text-cyan-300 font-medium">{currentFrameworkDef.shortName}</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedControlId(null)}
              className="btn-secondary text-xs px-4 py-2"
            >
              Done
            </button>
            {frameworkControls.length > 0 && (
              <button
                onClick={handleNext}
                disabled={controlIndex < 0 || controlIndex === frameworkControls.length - 1}
                className="btn-primary text-xs px-4 py-2 disabled:opacity-50"
              >
                <span>Next Requirement</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default ControlDetailModal;
