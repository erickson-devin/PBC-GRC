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
} from 'lucide-react';
import { CMMC_LEVEL_1_CONTROLS, DOMAINS } from '../../data/cmmcLevel1Controls';
import { ControlStatus, EvidenceItem } from '../../types/cmmc';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { EvidenceVault } from '../../services/evidenceVault';

export const ControlDetailModal: React.FC = () => {
  const {
    selectedControlId,
    setSelectedControlId,
    state,
    updateControlStatus,
    updateControlNotes,
    updateControlRole,
    applyStarterTemplate,
    uploadEvidence,
    removeEvidence,
    setPreviewEvidence,
  } = useAssessment();

  const { canEdit, currentTenant } = useTenant();

  const [activeTab, setActiveTab] = useState<'narrative' | 'guidance' | 'evidence'>('narrative');
  const [templateFilter, setTemplateFilter] = useState<'all' | 'm365' | 'gcp' | 'activedirectory' | 'physical'>('all');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [templateAppliedNotice, setTemplateAppliedNotice] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!selectedControlId) return null;

  const controlIndex = CMMC_LEVEL_1_CONTROLS.findIndex((c) => c.id === selectedControlId);
  const control = CMMC_LEVEL_1_CONTROLS[controlIndex];
  if (!control) return null;

  const ctrlState = state.controls[control.id] || {
    id: control.id,
    tenantId: currentTenant.id,
    status: 'NOT_STARTED',
    implementationNotes: '',
    responsibleRole: 'IT / Security Lead',
    lastUpdated: new Date().toISOString(),
    tags: [],
  };

  const domainInfo = DOMAINS[control.domain];
  const controlEvidence = state.evidenceIndex.filter((e) => e.controlId === control.id);

  // Navigation handlers
  const handlePrev = () => {
    if (controlIndex > 0) {
      setSelectedControlId(CMMC_LEVEL_1_CONTROLS[controlIndex - 1].id);
    }
  };

  const handleNext = () => {
    if (controlIndex < CMMC_LEVEL_1_CONTROLS.length - 1) {
      setSelectedControlId(CMMC_LEVEL_1_CONTROLS[controlIndex + 1].id);
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

  const filteredTemplates = control.starterTemplates.filter(t => {
    if (templateFilter === 'all') return true;
    return t.category === templateFilter;
  });

  return (
    <div className="no-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-scaleUp">
        
        {/* Top Header */}
        <div className="px-6 py-4 bg-slate-850 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-sm px-3 py-1 rounded-xl bg-brand-500/20 text-brand-300 border border-brand-500/40">
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
            <span className="hidden sm:inline text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
              {control.farReference}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Prev / Next controls */}
            <div className="flex items-center gap-1 mr-2 bg-slate-800 rounded-xl p-1 border border-slate-700">
              <button
                onClick={handlePrev}
                disabled={controlIndex === 0}
                className="p-1 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                title="Previous Control"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono text-slate-400 px-1">
                {controlIndex + 1}/17
              </span>
              <button
                onClick={handleNext}
                disabled={controlIndex === CMMC_LEVEL_1_CONTROLS.length - 1}
                className="p-1 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                title="Next Control"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Close */}
            <button
              onClick={() => setSelectedControlId(null)}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
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
                { id: 'NOT_STARTED', label: 'Not Started', active: 'bg-slate-800 text-white' },
                { id: 'IN_PROGRESS', label: 'In Progress', active: 'bg-amber-500/20 text-amber-300 border border-amber-500/40' },
                { id: 'MET', label: 'Met', active: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' },
                { id: 'NOT_MET', label: 'Not Met', active: 'bg-rose-500/20 text-rose-300 border border-rose-500/40' },
              ] as { id: ControlStatus; label: string; active: string }[]
            ).map((s) => {
              const isSelected = ctrlState.status === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => updateControlStatus(control.id, s.id)}
                  disabled={!canEdit}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-60 ${
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
        <div className="px-6 border-b border-slate-800 flex items-center gap-6 text-sm font-semibold text-slate-400 shrink-0">
          <button
            onClick={() => setActiveTab('narrative')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'narrative'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Implementation Narrative</span>
          </button>

          <button
            onClick={() => setActiveTab('evidence')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'evidence'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <Paperclip className="w-4 h-4" />
            <span>Evidence Vault ({controlEvidence.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('guidance')}
            className={`py-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'guidance'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>Auditor Guidance & Objectives</span>
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          
          {/* TAB 1: IMPLEMENTATION NARRATIVE */}
          {activeTab === 'narrative' && (
            <div className="space-y-6">
              
              {/* Starter Templates Picker */}
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

              {/* Implementation Statement Editor */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5 text-brand-400" />
                    Implementation Narrative (How {currentTenant.name} satisfies this practice)
                  </label>
                  <span className="text-xs text-slate-500">
                    {ctrlState.implementationNotes.length} characters
                  </span>
                </div>

                <textarea
                  rows={7}
                  disabled={!canEdit}
                  value={ctrlState.implementationNotes}
                  onChange={(e) => updateControlNotes(control.id, e.target.value)}
                  placeholder="Detail the specific tools, policies, processes, and configurations your organization uses to satisfy this requirement..."
                  className="w-full p-4 rounded-2xl bg-slate-950 border border-slate-800 focus:border-brand-500 focus:outline-none text-sm text-slate-100 placeholder-slate-500 leading-relaxed font-sans transition-colors resize-y disabled:opacity-75"
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
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 focus:outline-none disabled:opacity-75"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                    FAR 52.204-21 Official Clause
                  </label>
                  <div className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-brand-300">
                    {control.farReference}
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: EVIDENCE VAULT */}
          {activeTab === 'evidence' && (
            <div className="space-y-6">
              
              {/* Dropzone Upload */}
              {canEdit ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-700 hover:border-brand-500 rounded-3xl p-8 text-center cursor-pointer bg-slate-950/50 hover:bg-slate-950 transition-all group"
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    multiple
                    className="hidden"
                  />
                  <div className="w-12 h-12 rounded-2xl bg-brand-500/15 text-brand-400 flex items-center justify-center mx-auto mb-3 group-hover:scale-110 transition-transform">
                    <Upload className="w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-white group-hover:text-brand-300 transition-colors">
                    {isUploading ? 'Computing SHA-256 & Storing in GCS Vault...' : 'Click to Upload Audit Evidence or Drag Files Here'}
                  </h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                    Attach screenshots, PDF policies, or configuration exports. Encrypted with SHA-256 hash validation and scoped to active tenant.
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
                    {controlEvidence.map((item) => (
                      <div
                        key={item.id}
                        className="p-3.5 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-700 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-colors"
                      >
                        <div className="flex items-start sm:items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-slate-850 text-brand-400 flex items-center justify-center shrink-0 border border-slate-700">
                            <Paperclip className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-xs font-bold text-white truncate">{item.name}</p>
                              <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                <Cloud className="w-2.5 h-2.5" /> GCS Synced
                              </span>
                            </div>
                            
                            {/* Metadata & SHA-256 */}
                            <div className="flex items-center gap-3 text-[10px] text-slate-400 mt-1 flex-wrap font-mono">
                              <span>{Math.round(item.fileSize / 1024)} KB</span>
                              <span>•</span>
                              <span className="truncate max-w-[200px]" title={item.gcsPath}>
                                {item.gcsPath || `gs://tenants/${currentTenant.id}/...`}
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
                    ))}
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

              {/* Assessment Objectives (NIST SP 800-171A) */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-brand-400" />
                  NIST SP 800-171A Assessment Objectives (What must be proven)
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

              {/* Auditor Evidence Checklist */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
                  Auditor Evidence Checklist (Artifacts auditors look for)
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

            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 bg-slate-850 border-t border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="text-xs text-slate-400">
            Tenant: <strong className="text-white">{currentTenant.name}</strong> • Last updated: {new Date(ctrlState.lastUpdated).toLocaleDateString()}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedControlId(null)}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs transition-colors"
            >
              Done
            </button>
            <button
              onClick={handleNext}
              disabled={controlIndex === CMMC_LEVEL_1_CONTROLS.length - 1}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs transition-colors flex items-center gap-1.5 disabled:opacity-40"
            >
              <span>Next Practice</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
