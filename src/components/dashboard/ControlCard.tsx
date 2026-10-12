import React, { useState, useRef } from 'react';
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HelpCircle,
  Paperclip,
  ChevronDown,
  ChevronUp,
  FileEdit,
  Upload,
  Sparkles,
  ExternalLink,
  ChevronRight,
  Cloud,
  Copy,
  Check,
  Terminal,
} from 'lucide-react';
import { ControlStatus, DomainInfo } from '../../types/cmmc';
import { FrameworkControlDefinition, FrameworkDomainInfo } from '../../types/framework';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getStigRulesForControl } from '../../data/stigs/stigCatalog';
import { getSprsPointDeduction } from '../../data/reports/sprsCompiler';
import { getControlImpactBadge } from '../../data/frameworks';
import { AssetRemediationDrawer } from '../telemetry/AssetRemediationDrawer';
import { FailingAssetInfo } from '../../types/telemetry';

import { activateOnKey } from '../../utils/a11y';
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
    updateControlStatus,
    updateControlNotes,
    applyStarterTemplate,
    uploadEvidence,
    setSelectedControlId,
  } = useAssessment();
  const { canEdit, currentTenant, activeFramework } = useTenant();

  const ctrlState = state.controls[control.id];
  const status: ControlStatus = ctrlState?.status || 'NOT_STARTED';
  const notes = ctrlState?.implementationNotes || '';
  const hasNotes = notes.trim().length > 0;
  const evidenceList = state.evidenceIndex.filter((e) => e.controlId === control.id);
  const evidenceCount = evidenceList.length;
  const mappedStigRules = getStigRulesForControl(control.id);

  const [isExpanded, setIsExpanded] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [quickTemplateNotice, setQuickTemplateNotice] = useState(false);
  const [isAssetDrawerOpen, setIsAssetDrawerOpen] = useState(false);

  const failingAssets: FailingAssetInfo[] = ctrlState?.failingAssets || [];
  const hasFailingAssets = failingAssets.length > 0;

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Status Badge Helper
  const renderStatusBadge = () => {
    switch (status) {
      case 'MET':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 ring-1 ring-emerald-500/20 shadow-sm shadow-emerald-950/40">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
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
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
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

  // Drag & Drop Handlers
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

    await uploadFiles(files);
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(files);
    e.target.value = '';
  };

  const uploadFiles = async (files: FileList) => {
    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(control.id, files[i]);
      }
    } catch (err) {
      console.error('Evidence upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleQuickTemplate = () => {
    if (control.starterTemplates && control.starterTemplates.length > 0) {
      applyStarterTemplate(control.id, control.starterTemplates[0].narrative);
      setQuickTemplateNotice(true);
      setTimeout(() => setQuickTemplateNotice(false), 2500);
    }
  };

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const handleOpenDetail = () => {
    if (onOpenDetailModal) {
      onOpenDetailModal();
    } else {
      setSelectedControlId(control.id);
    }
  };

  return (
    <div
      className={`stitch-card transition-all duration-200 shadow-md ${
        isExpanded
          ? 'ring-1 ring-cyan-500/40 shadow-cyan-950/30'
          : 'hover:border-slate-700 hover:shadow-lg hover:shadow-slate-950/40'
      }`}
    >
      {/* Top Header Strip */}
      <div className="p-4 sm:p-5 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        
        {/* Left: Identifiers & Titles */}
        <div className="space-y-2.5 max-w-3xl flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Control ID in Bold Monospace Text */}
            <span className="font-mono font-bold text-sm tracking-wide px-3 py-1 rounded-lg bg-cyan-950/50 text-cyan-300 border border-cyan-500/30 shadow-sm shadow-cyan-950/30">
              {control.id}
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
            <h3 
              onClick={handleOpenDetail}
              className="text-base font-bold text-white hover:text-cyan-300 transition-colors cursor-pointer inline-flex items-center gap-2"
            >
              <span>{control.title}</span>
              <ExternalLink className="w-3.5 h-3.5 text-slate-400 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            </h3>
            <p className="text-xs text-slate-300/90 leading-relaxed mt-1">
              {control.plainEnglishSummary}
            </p>
          </div>

          {/* Tactical Telemetry Warning Banner (Per-Asset Root-Cause Analysis) */}
          {hasFailingAssets && (
            <button type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsAssetDrawerOpen(true);
              }}
              className="w-full text-left group flex items-center justify-between px-3.5 py-2 rounded-xl bg-gradient-to-r from-rose-950/60 via-amber-950/40 to-slate-900 border border-rose-500/40 hover:border-rose-400 cursor-pointer transition-all shadow-sm shadow-rose-950/40 mt-1.5"
            >
              <div className="flex items-center gap-2.5">
                <span className="p-1 rounded-lg bg-rose-500/20 text-rose-400">
                  <AlertTriangle className="w-4 h-4 text-rose-400 animate-pulse" />
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-rose-200 group-hover:text-white transition-colors">
                    ⚠️ {failingAssets.length} of 4 Endpoints Non-Compliant
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-rose-950/70 text-rose-300 border border-rose-500/30">
                    DISA STIG Telemetry
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1 text-xs font-semibold text-rose-300 group-hover:text-white transition-colors">
                <span>Open Root-Cause Drawer</span>
                <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </div>
            </button>
          )}

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
                hasNotes ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              <FileEdit className="w-3.5 h-3.5" />
              {hasNotes ? 'Narrative Documented' : 'No narrative yet'}
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
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenDetail();
                }}
                className="flex items-center gap-1 font-mono text-xs px-2.5 py-0.5 rounded-full bg-cyan-950/70 text-cyan-300 border border-cyan-500/35 hover:border-cyan-400 cursor-pointer transition-colors shadow-sm"
                title={`${mappedStigRules.length} DISA STIG technical rules mapped to this control requirement`}
              >
                <Terminal className="w-3 h-3 text-cyan-400" />
                <span>{mappedStigRules.length} STIG {mappedStigRules.length === 1 ? 'Rule' : 'Rules'}</span>
              </span>
            )}
          </div>
        </div>

        {/* Right Actions: Quick Status Selector & Buttons */}
        <div className="flex items-center gap-2.5 w-full lg:w-auto justify-between lg:justify-end pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-800/80 shrink-0 flex-wrap">
          
          {/* Quick Status Dropdown */}
          <div className="relative">
            <select
              value={status}
              disabled={!canEdit}
              onChange={(e) => updateControlStatus(control.id, e.target.value as ControlStatus)}
              className={`text-xs font-bold rounded-xl px-3 py-2 pr-8 border appearance-none cursor-pointer focus:outline-none transition-all duration-200 disabled:opacity-60 ${
                status === 'MET'
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40 hover:border-emerald-400'
                  : status === 'NOT_MET'
                  ? 'bg-rose-950/60 text-rose-300 border-rose-500/40 hover:border-rose-400'
                  : status === 'IN_PROGRESS'
                  ? 'bg-amber-950/60 text-amber-300 border-amber-500/40 hover:border-amber-400'
                  : 'bg-slate-850 text-slate-300 border-slate-700 hover:border-slate-600'
              }`}
            >
              <option value="NOT_STARTED" className="bg-slate-900 text-slate-300">NOT_STARTED</option>
              <option value="IN_PROGRESS" className="bg-slate-900 text-amber-400">IN_PROGRESS</option>
              <option value="MET" className="bg-slate-900 text-emerald-400">MET (Compliant)</option>
              <option value="NOT_MET" className="bg-slate-900 text-rose-400">NOT_MET</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <ChevronDown className="w-3 h-3" />
            </div>
          </div>

          {/* Secondary Quick-Edit Toggle */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="btn-secondary text-xs px-3 py-2"
            title={isExpanded ? 'Collapse inline editor' : 'Expand inline narrative & evidence dropzone'}
          >
            <span>{isExpanded ? 'Close Editor' : 'Quick Edit'}</span>
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {/* Primary Action Button: Electric Cyan/Blue gradient with hover glow */}
          <button
            onClick={handleOpenDetail}
            className="btn-primary text-xs px-3.5 py-2"
          >
            <span>Inspect & Document</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>

        </div>

      </div>

      {/* Expandable Inline Narrative & Evidence Dropzone Section */}
      {isExpanded && (
        <div className="border-t border-slate-800 bg-slate-950/60 p-4 sm:p-6 rounded-b-xl space-y-5 animate-fadeIn">
          
          {/* Top Bar for Expanded Area */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
              <FileEdit className="w-3.5 h-3.5" />
              <span>Implementation Narrative ({currentTenant.name})</span>
            </span>

            <div className="flex items-center gap-2">
              {quickTemplateNotice && (
                <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1 animate-fadeIn">
                  <Check className="w-3.5 h-3.5" /> Starter template applied!
                </span>
              )}
              {canEdit && control.starterTemplates && control.starterTemplates.length > 0 && (
                <button
                  onClick={handleQuickTemplate}
                  className="px-2.5 py-1 rounded-lg bg-cyan-950/40 text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 text-xs font-medium flex items-center gap-1 transition-colors"
                >
                  <Sparkles className="w-3 h-3 text-cyan-400" />
                  <span>Use Starter Template</span>
                </button>
              )}
            </div>
          </div>

          {/* Implementation Narrative Text Box */}
          <div className="space-y-1.5">
            <textarea
              rows={4}
              disabled={!canEdit}
              value={notes}
              onChange={(e) => updateControlNotes(control.id, e.target.value)}
              placeholder={`Describe how ${currentTenant.name} enforces this practice (e.g. policies, technical configurations, endpoint controls)...`}
              className="w-full p-3.5 rounded-xl bg-slate-900 border border-slate-700/80 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 text-xs sm:text-sm text-slate-100 placeholder-slate-400 leading-relaxed font-sans transition-all duration-200 disabled:opacity-60 resize-y"
            />
            <div className="flex items-center justify-between text-xs text-slate-400 px-1">
              <span>FAR 52.204-21 audit evidence reference</span>
              <span className="font-mono">{notes.length} characters</span>
            </div>
          </div>

          {/* Evidence Upload Drop-Zone with Clear Drop Indicators */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Paperclip className="w-3.5 h-3.5 text-cyan-400" />
                <span>Audit Evidence Drop-Zone ({evidenceCount} attached)</span>
              </span>
              <span className="text-xs text-slate-400">SHA-256 Validated • GCS Vault</span>
            </div>

            {canEdit ? (
              <div role="button" tabIndex={0} onKeyDown={activateOnKey} aria-label="Upload evidence files: drop files here or press Enter to browse"
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                data-drag-over={isDraggingOver}
                className={`dropzone-container relative transition-all duration-200 ${
                  isDraggingOver
                    ? 'border-cyan-400 bg-cyan-950/40 ring-2 ring-cyan-500/50 shadow-lg shadow-cyan-500/20 scale-[1.01]'
                    : 'hover:border-cyan-500/50 hover:bg-slate-900/60'
                }`}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileInputChange}
                  multiple
                  className="hidden"
                />

                <div className="flex flex-col items-center justify-center space-y-2">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                      isDraggingOver
                        ? 'bg-cyan-500/25 text-cyan-300 scale-110 animate-bounce'
                        : 'bg-slate-800 text-cyan-400'
                    }`}
                  >
                    <Upload className="w-5 h-5" />
                  </div>

                  <div>
                    <p className="text-xs sm:text-sm font-bold text-white">
                      {isUploading
                        ? 'Hashing with SHA-256 & Encrypting into GCS Vault...'
                        : isDraggingOver
                        ? 'Drop Files to Attach as Evidence'
                        : 'Drag & Drop Evidence Files Here or Click to Browse'}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Supports screenshots, PDFs, configuration exports, and audit reports.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-400 text-center">
                Read-only clearance: Evidence uploading disabled for viewer mode.
              </div>
            )}

            {/* Attached Evidence Chips */}
            {evidenceCount > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {evidenceList.map((item) => {
                  const isInherited = item.syncStatus === 'inherited' || (item.description && item.description.startsWith('[Inherited'));
                  return (
                    <div
                      key={item.id}
                      className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 text-xs ${
                        isInherited ? 'bg-indigo-950/30 border-indigo-500/30' : 'bg-slate-900/90 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Paperclip className={`w-3.5 h-3.5 shrink-0 ${isInherited ? 'text-indigo-400' : 'text-cyan-400'}`} />
                        <div className="min-w-0">
                          <p className="font-semibold text-white truncate text-xs">{item.name}</p>
                          <div className="flex items-center gap-1 text-xs text-slate-400 font-mono">
                            <span>{Math.round(item.fileSize / 1024)} KB</span>
                            <span>•</span>
                            {isInherited ? (
                              <span className="text-amber-300 font-medium px-1 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 flex items-center gap-0.5">
                                Cross-Framework Inherited
                              </span>
                            ) : (
                              <span className="text-emerald-400 flex items-center gap-0.5">
                                <Cloud className="w-2.5 h-2.5" /> GCS
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {item.fileHash && (
                        <button
                          onClick={() => handleCopyHash(item.fileHash!)}
                          title="Copy SHA-256"
                          className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-750 text-xs font-mono text-slate-300 flex items-center gap-1 border border-slate-700 shrink-0"
                        >
                          {copiedHash === item.fileHash ? (
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-2.5 h-2.5" />
                          )}
                          <span>{item.fileHash.slice(0, 6)}...</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>
      )}

      {/* Asset Health & Root-Cause Remediation Drawer */}
      <AssetRemediationDrawer
        isOpen={isAssetDrawerOpen}
        onClose={() => setIsAssetDrawerOpen(false)}
        control={control}
        failingAssets={failingAssets}
        totalEndpoints={4}
      />
    </div>
  );
};

export default ControlCard;
