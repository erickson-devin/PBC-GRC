import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  FileText,
  Download,
  Printer,
  FileCode,
  FileSpreadsheet,
  Building,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Edit3,
  Layers,
  Sparkles,
  Save,
  Check,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import {
  ReportDocumentType,
  ReportMetadata,
  SystemOperationalStatus,
  DocumentClassificationLevel,
} from '../../types/report';
import {
  getDefaultDocumentTypeForFramework,
  compileReportDocument,
} from '../../data/reports/documentCompilers';
import {
  triggerBrowserPrint,
  downloadHtmlDocument,
  downloadJsonPackage,
  downloadPoamCsv,
} from '../../data/reports/reportExporters';
import {
  calculateSprsScore,
  downloadEmassCsv,
  downloadSprsSummaryJson,
} from '../../data/reports/sprsCompiler';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';

interface ArtifactExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ArtifactExportModal: React.FC<ArtifactExportModalProps> = ({ isOpen, onClose }) => {
  const {
    state,
    frameworkControls,
    updateSSPMetadata,
    exportModalInitialDocType,
  } = useAssessment();

  const {
    currentTenant,
    activeFramework,
    canEdit,
  } = useTenant();

  // Document Type selection: default dynamically to the active framework's standard report
  const [selectedDocType, setSelectedDocType] = useState<ReportDocumentType>(() => {
    return exportModalInitialDocType || getDefaultDocumentTypeForFramework(activeFramework);
  });

  // Active View Tab: 'preview' | 'metadata' | 'poam' | 'sprs'
  const [activeTab, setActiveTab] = useState<'preview' | 'metadata' | 'poam' | 'sprs'>('preview');

  // Compute live DoD SPRS scoring metrics
  const sprsResult = useMemo(() => {
    return calculateSprsScore(frameworkControls, state.controls);
  }, [frameworkControls, state.controls]);

  // Metadata form local state (allows editing before generation and live preview)
  const meta = state.sspMetadata;
  const [formData, setFormData] = useState<ReportMetadata>({
    systemName: meta.systemName || currentTenant.systemName || 'Defense Contracting Information Network',
    organizationName: meta.organizationName || currentTenant.name || 'Organization Enclave',
    cageCode: meta.cageCode || currentTenant.cageCode || '9X7B4',
    samStatus: meta.samStatus || currentTenant.samStatus || 'ACTIVE',
    systemOwner: meta.systemOwner || currentTenant.systemOwner || 'Alex Mercer, CMMC CCA',
    primaryAssessor: meta.authorName || 'Lead Compliance Assessor',
    boundaryDescription: meta.systemBoundaryScope || currentTenant.systemBoundaryScope || 'The system boundary encompasses corporate identity tenants, managed physical and virtual endpoints, boundary gateway firewalls, and cloud services processing Federal Contract Information (FCI) or Controlled Unclassified Information (CUI).',
    systemEnvironment: meta.systemEnvironment || 'Hybrid Cloud: Cloud Identity & SaaS Services + On-Premises Enclave VLAN.',
    operationalStatus: 'Operational' as SystemOperationalStatus,
    cloudServiceProviders: meta.cloudServiceProviders || 'Google Cloud Platform, Microsoft 365, Cloudflare Zero Trust.',
    classificationLevel: (activeFramework === 'SOC_2_TYPE_II'
      ? 'CONFIDENTIAL'
      : activeFramework === 'HIPAA_SECURITY'
      ? 'RESTRICTED // LAW ENFORCEMENT SENSITIVE'
      : 'UNCLASSIFIED // CUI') as DocumentClassificationLevel,
    assessmentDate: meta.assessmentDate || new Date().toISOString().split('T')[0],
    version: meta.version || '1.0.0',
    framework: activeFramework,
  });

  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);
  const [isExportingJson, setIsExportingJson] = useState<boolean>(false);

  // Sync state whenever activeFramework or exportModalInitialDocType changes
  useEffect(() => {
    if (exportModalInitialDocType) {
      setSelectedDocType(exportModalInitialDocType);
    } else {
      setSelectedDocType(getDefaultDocumentTypeForFramework(activeFramework));
    }
  }, [activeFramework, exportModalInitialDocType, isOpen]);

  // Sync initial metadata from current tenant when opening modal
  useEffect(() => {
    if (isOpen) {
      setFormData(prev => ({
        ...prev,
        systemName: meta.systemName || currentTenant.systemName || prev.systemName,
        organizationName: meta.organizationName || currentTenant.name || prev.organizationName,
        cageCode: meta.cageCode || currentTenant.cageCode || prev.cageCode,
        samStatus: meta.samStatus || currentTenant.samStatus || prev.samStatus,
        systemOwner: meta.systemOwner || currentTenant.systemOwner || prev.systemOwner,
        primaryAssessor: meta.authorName || prev.primaryAssessor,
        boundaryDescription: meta.systemBoundaryScope || currentTenant.systemBoundaryScope || prev.boundaryDescription,
        framework: activeFramework,
      }));
    }
  }, [isOpen, currentTenant, meta, activeFramework]);

  // Save metadata to tenant state
  const handleSaveMetadata = useCallback(() => {
    updateSSPMetadata({
      systemName: formData.systemName,
      organizationName: formData.organizationName,
      cageCode: formData.cageCode,
      samStatus: formData.samStatus,
      systemOwner: formData.systemOwner,
      authorName: formData.primaryAssessor,
      systemBoundaryScope: formData.boundaryDescription,
      systemEnvironment: formData.systemEnvironment,
      cloudServiceProviders: formData.cloudServiceProviders,
      version: formData.version,
      assessmentDate: formData.assessmentDate,
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  }, [formData, updateSSPMetadata]);

  // Dynamic Live Document Compilation
  const compiledDoc = useMemo(() => {
    return compileReportDocument(
      selectedDocType,
      formData,
      frameworkControls,
      state.controls,
      state.evidenceIndex
    );
  }, [selectedDocType, formData, frameworkControls, state.controls, state.evidenceIndex]);

  // Export handlers
  const handleDownloadHtml = () => {
    downloadHtmlDocument(compiledDoc);
  };

  const handlePrint = () => {
    triggerBrowserPrint(compiledDoc);
  };

  const handleExportJson = async () => {
    setIsExportingJson(true);
    try {
      await downloadJsonPackage(compiledDoc, state);
    } catch (err) {
      console.error('Failed to export JSON package:', err);
    } finally {
      setIsExportingJson(false);
    }
  };

  const handleExportPoamCsv = () => {
    const entries = compiledDoc.poamEntries || [];
    downloadPoamCsv(entries, formData.systemName);
  };

  if (!isOpen) return null;

  const frameworkDef = FRAMEWORK_REGISTRY[activeFramework] || FRAMEWORK_REGISTRY.CMMC_L1;

  const docTypeOptions: { id: ReportDocumentType; label: string; icon: React.ComponentType<{ className?: string }>; badge: string; desc: string }[] = [
    {
      id: 'NIST_SP_800_18_SSP',
      label: 'NIST SP 800-18 / 171 SSP',
      icon: Shield,
      badge: 'CMMC / NIST',
      desc: 'System Security Plan formatted into standard NIST SP 800-18 sections with implementation statements.',
    },
    {
      id: 'POAM',
      label: 'Plan of Action & Milestones',
      icon: AlertTriangle,
      badge: 'Deficiency Tracking',
      desc: 'Aggregates all NOT_MET & IN_PROGRESS controls with weakness IDs, scheduled dates, and milestones.',
    },
    {
      id: 'SOC_2_SYSTEM_DESCRIPTION',
      label: 'SOC 2 Type II System Description',
      icon: Building,
      badge: 'AICPA DC 200',
      desc: 'System architecture, Trust Services Criteria (CC1–CC9, A1, C1), and third-party vendor boundaries.',
    },
    {
      id: 'HIPAA_SECURITY_ASSESSMENT',
      label: 'HIPAA Security Assessment',
      icon: Layers,
      badge: '45 CFR §164',
      desc: 'Evaluates Administrative (§164.308), Physical (§164.310), and Technical (§164.312) ePHI safeguards.',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-6xl h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Modal Top Bar */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-brand-500/20 text-white">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-extrabold text-white tracking-tight">
                  Compliance Documentation & Artifact Export Center
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-brand-500/20 text-brand-300 border border-brand-500/30">
                  {frameworkDef.shortName}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Compile defense-grade audit packages, NIST SSPs, POA&Ms, and machine-readable JSON verification bundles for <strong>{currentTenant.name}</strong>.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Document Type Selector Bar */}
        <div className="px-5 py-3 border-b border-slate-800/80 bg-slate-900/90 flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2 overflow-x-auto py-1">
            {docTypeOptions.map((opt) => {
              const isSelected = selectedDocType === opt.id;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  onClick={() => setSelectedDocType(opt.id)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all whitespace-nowrap ${
                    isSelected
                      ? 'bg-brand-600 text-white shadow-md shadow-brand-600/30 border border-brand-500'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white border border-slate-700/60'
                  }`}
                  title={opt.desc}
                >
                  <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-white' : 'text-slate-400'}`} />
                  <span>{opt.label}</span>
                  <span className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase tracking-wider ${
                    isSelected ? 'bg-white/20 text-white' : 'bg-slate-900 text-slate-400'
                  }`}>
                    {opt.badge}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Sub-view switcher: Preview vs Metadata Form vs POA&M Matrix */}
          <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1 shrink-0">
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'preview'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Live Preview</span>
            </button>
            <button
              onClick={() => setActiveTab('metadata')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'metadata'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Boundary Metadata</span>
            </button>
            <button
              onClick={() => setActiveTab('poam')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'poam'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span>POA&M Table ({compiledDoc.poamEntries?.length || 0})</span>
            </button>
            <button
              onClick={() => setActiveTab('sprs')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'sprs'
                  ? 'bg-cyan-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-cyan-300" />
              <span>SPRS / eMASS</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold ${
                sprsResult.score >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
              }`}>
                {sprsResult.score > 0 ? `+${sprsResult.score}` : sprsResult.score}
              </span>
            </button>
          </div>
        </div>

        {/* Modal Body / Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 bg-slate-950/40">
          
          {/* TAB 1: LIVE DOCUMENT PREVIEW */}
          {activeTab === 'preview' && (
            <div className="max-w-4xl mx-auto space-y-6">
              
              {/* Preview Document Cover Card */}
              <div className="p-6 sm:p-8 rounded-3xl bg-slate-900 border border-slate-800 shadow-xl space-y-6">
                <div className="border-b border-brand-500/30 pb-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold bg-brand-500/20 text-brand-300 border border-brand-500/30 uppercase">
                      {formData.classificationLevel}
                    </span>
                    <span className="text-xs text-slate-400">
                      Generated: {new Date().toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="text-2xl font-extrabold text-white mt-3">
                    {compiledDoc.title}
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">
                    {compiledDoc.subtitle}
                  </p>
                </div>

                {/* System Metadata Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-4 rounded-2xl bg-slate-950 border border-slate-800/80 text-xs">
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">System Name</span>
                    <span className="text-white font-medium">{formData.systemName}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">Governing Entity</span>
                    <span className="text-white font-medium">{formData.organizationName}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">CAGE Code / SAM</span>
                    <span className="text-brand-300 font-mono">{formData.cageCode} • {formData.samStatus}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">System Owner</span>
                    <span className="text-white font-medium">{formData.systemOwner}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">Lead Assessor</span>
                    <span className="text-white font-medium">{formData.primaryAssessor}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-semibold block uppercase text-[10px]">Operational Status</span>
                    <span className="text-emerald-400 font-medium">{formData.operationalStatus}</span>
                  </div>
                </div>

                {/* Executive Posture Score Box */}
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="text-sm font-bold text-emerald-300">
                      Executive Compliance Readiness Posture
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {compiledDoc.summaryMetrics.metCount} of {compiledDoc.summaryMetrics.totalControls} Requirements MET ({compiledDoc.summaryMetrics.inProgressCount} in progress, {compiledDoc.summaryMetrics.notMetCount} deficiencies)
                    </div>
                  </div>
                  <div className="text-2xl font-mono font-black text-emerald-400">
                    {compiledDoc.summaryMetrics.completionPercentage}%
                  </div>
                </div>
              </div>

              {/* Sections Breakdown */}
              <div className="space-y-4">
                {compiledDoc.sections.map((sec) => (
                  <div
                    key={sec.id}
                    className="p-5 sm:p-6 rounded-2xl bg-slate-900 border border-slate-800 shadow-md space-y-3"
                  >
                    <h4 className="text-base font-bold text-white flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-brand-500" />
                      {sec.title}
                    </h4>

                    {sec.summary && (
                      <p className="text-xs text-slate-400 italic">
                        {sec.summary}
                      </p>
                    )}

                    {sec.content && (
                      <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap bg-slate-950 p-3.5 rounded-xl border border-slate-800/80 font-mono">
                        {sec.content}
                      </div>
                    )}

                    {/* Table Render */}
                    {sec.table && (
                      <div className="overflow-x-auto rounded-xl border border-slate-800">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                            <tr>
                              {sec.table.headers.map((h, i) => (
                                <th key={i} className="p-2.5 font-semibold">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800">
                            {sec.table.rows.map((row, rIdx) => {
                              const cells = Array.isArray(row) ? row : row.cells;
                              return (
                                <tr key={rIdx} className="hover:bg-slate-850/50">
                                  {cells.map((cell, cIdx) => (
                                    <td key={cIdx} className="p-2.5 text-slate-300">
                                      {String(cell)}
                                    </td>
                                  ))}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Subsections Render */}
                    {sec.subsections && sec.subsections.length > 0 && (
                      <div className="space-y-3 pt-2">
                        {sec.subsections.map((sub, sIdx) => (
                          <div key={sIdx} className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/70 space-y-2">
                            <h5 className="text-xs font-bold text-brand-300">
                              {sub.title}
                            </h5>

                            {sub.content && (
                              <p className="text-xs text-slate-300 leading-relaxed">
                                {sub.content}
                              </p>
                            )}

                            {sub.items && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
                                {sub.items.map((item, iIdx) => (
                                  <div key={iIdx} className="flex justify-between gap-2 border-b border-slate-800/60 pb-1">
                                    <span className="text-slate-500 font-medium">{item.label}:</span>
                                    <span className="text-slate-200 font-semibold">{item.value}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {sub.table && (
                              <div className="overflow-x-auto rounded-lg border border-slate-800 mt-2">
                                <table className="w-full text-left text-[11px]">
                                  <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                                    <tr>
                                      {sub.table.headers.map((h, i) => (
                                        <th key={i} className="p-2 font-semibold">{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-800">
                                    {sub.table.rows.map((row, rIdx) => {
                                      const cells = Array.isArray(row) ? row : row.cells;
                                      return (
                                        <tr key={rIdx} className="hover:bg-slate-850/50">
                                          {cells.map((cell, cIdx) => (
                                            <td key={cIdx} className="p-2 text-slate-300">
                                              {String(cell)}
                                            </td>
                                          ))}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: SYSTEM BOUNDARY METADATA FORM */}
          {activeTab === 'metadata' && (
            <div className="max-w-4xl mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-xl">
              <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-slate-800">
                <div>
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <Building className="w-5 h-5 text-brand-400" />
                    System Boundary & Governance Specification
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Modifications made here dynamically update the active audit document, live preview, and official cover page.
                  </p>
                </div>

                {canEdit && (
                  <button
                    onClick={handleSaveMetadata}
                    className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-md shadow-brand-600/20"
                  >
                    {savedSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : <Save className="w-4 h-4" />}
                    <span>{savedSuccess ? 'Saved to Tenant!' : 'Save & Sync Metadata'}</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* System Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    System Name / Designation *
                  </label>
                  <input
                    type="text"
                    value={formData.systemName}
                    onChange={(e) => setFormData({ ...formData, systemName: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                    placeholder="e.g. Defense Contracting Information Network (DCIN)"
                  />
                </div>

                {/* Organization Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Organization / Legal Entity Name *
                  </label>
                  <input
                    type="text"
                    value={formData.organizationName}
                    onChange={(e) => setFormData({ ...formData, organizationName: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                    placeholder="e.g. Vanguard Defense Systems, LLC"
                  />
                </div>

                {/* System Owner */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    System Owner (Formal Authority) *
                  </label>
                  <input
                    type="text"
                    value={formData.systemOwner}
                    onChange={(e) => setFormData({ ...formData, systemOwner: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                    placeholder="e.g. Alex Mercer, CMMC CCA (CISO)"
                  />
                </div>

                {/* Primary Assessor */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Primary Assessor / Author *
                  </label>
                  <input
                    type="text"
                    value={formData.primaryAssessor}
                    onChange={(e) => setFormData({ ...formData, primaryAssessor: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                    placeholder="e.g. Lead Certified C3PAO Assessor"
                  />
                </div>

                {/* CAGE Code */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    CAGE Code (Commercial & Government Entity)
                  </label>
                  <input
                    type="text"
                    value={formData.cageCode}
                    onChange={(e) => setFormData({ ...formData, cageCode: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono uppercase focus:border-brand-500 focus:outline-none"
                    placeholder="e.g. 8K3R1"
                  />
                </div>

                {/* Operational Status */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Operational Status
                  </label>
                  <select
                    value={formData.operationalStatus}
                    onChange={(e) => setFormData({ ...formData, operationalStatus: e.target.value as SystemOperationalStatus })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                  >
                    <option value="Operational">Operational (Live Production)</option>
                    <option value="Under Development">Under Development / Assessment</option>
                    <option value="Major Modification">Major Modification</option>
                    <option value="Decommissioning">Decommissioning</option>
                  </select>
                </div>

                {/* Classification Level */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Document Classification Marking
                  </label>
                  <select
                    value={formData.classificationLevel}
                    onChange={(e) => setFormData({ ...formData, classificationLevel: e.target.value as DocumentClassificationLevel })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                  >
                    <option value="UNCLASSIFIED // CUI">UNCLASSIFIED // CUI (Fed/DoD Standard)</option>
                    <option value="CONFIDENTIAL">CONFIDENTIAL (SOC 2 / Corporate Standard)</option>
                    <option value="RESTRICTED // LAW ENFORCEMENT SENSITIVE">RESTRICTED // ePHI (HIPAA Standard)</option>
                    <option value="PROPRIETARY">PROPRIETARY // INTERNAL AUDIT ONLY</option>
                  </select>
                </div>

                {/* Assessment Date */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Assessment Attestation Date
                  </label>
                  <input
                    type="date"
                    value={formData.assessmentDate}
                    onChange={(e) => setFormData({ ...formData, assessmentDate: e.target.value })}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Boundary Description Textarea */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  System Boundary & Scope Narrative *
                </label>
                <textarea
                  rows={4}
                  value={formData.boundaryDescription}
                  onChange={(e) => setFormData({ ...formData, boundaryDescription: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none leading-relaxed"
                  placeholder="Detail all corporate endpoints, cloud tenants, subnets, firewalls, and data repositories that store, process, or transmit sensitive contract information..."
                />
              </div>

              {/* CSPs & Cloud Infrastructure */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Cloud Service Providers (CSPs) & Infrastructure Components
                </label>
                <input
                  type="text"
                  value={formData.cloudServiceProviders}
                  onChange={(e) => setFormData({ ...formData, cloudServiceProviders: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none"
                  placeholder="e.g. Google Cloud Platform, Microsoft 365 GCC High, AWS GovCloud, Cloudflare Zero Trust"
                />
              </div>
            </div>
          )}

          {/* TAB 3: POA&M TABLE & DEFICIENCY TRACKING */}
          {activeTab === 'poam' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-between flex-wrap gap-4 shadow-lg">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-amber-400" />
                    Automated Plan of Action & Milestones (POA&M) Matrix
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Aggregated {compiledDoc.poamEntries?.length || 0} active weaknesses across all non-compliant and in-progress controls.
                  </p>
                </div>

                <button
                  onClick={handleExportPoamCsv}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-2 transition-colors"
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                  <span>Download POA&M (CSV)</span>
                </button>
              </div>

              {(!compiledDoc.poamEntries || compiledDoc.poamEntries.length === 0) ? (
                <div className="p-12 text-center rounded-3xl bg-slate-900/60 border border-slate-800 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <h4 className="text-base font-bold text-white">Zero Open Deficiencies on Record!</h4>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    All controls evaluated for {formData.systemName} are currently marked MET (100% compliant). Zero open POA&M entries are required.
                  </p>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900 shadow-xl">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                        <tr>
                          <th className="p-3">Weakness ID</th>
                          <th className="p-3">Control</th>
                          <th className="p-3">Deficiency Summary</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Target Date</th>
                          <th className="p-3">Owner</th>
                          <th className="p-3">Resources</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {compiledDoc.poamEntries.map((entry) => (
                          <tr key={entry.weaknessId} className="hover:bg-slate-850/50">
                            <td className="p-3 font-mono font-bold text-amber-300">
                              {entry.weaknessId}
                            </td>
                            <td className="p-3">
                              <div className="font-bold text-white">{entry.controlId}</div>
                              <div className="text-[11px] text-slate-400 truncate max-w-[140px]">{entry.controlTitle}</div>
                            </td>
                            <td className="p-3 text-slate-300 max-w-xs">
                              {entry.weaknessDescription}
                            </td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                entry.status === 'IN_PROGRESS'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              }`}>
                                {entry.status}
                              </span>
                            </td>
                            <td className="p-3 font-mono text-slate-300">
                              {entry.scheduledCompletionDate}
                            </td>
                            <td className="p-3 text-slate-300">
                              {entry.responsibleRole}
                            </td>
                            <td className="p-3 text-slate-400 text-[11px]">
                              {entry.requiredResources}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: SPRS / eMASS SUBMISSION ENGINE */}
          {activeTab === 'sprs' && (
            <div className="max-w-4xl mx-auto space-y-6 animate-fadeIn">
              
              {/* Executive Score Card */}
              <div className="p-6 sm:p-8 rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase tracking-wider">
                        DFARS 252.204-7019 / 7020
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-slate-400 bg-slate-800">
                        NIST SP 800-171 Rev 2
                      </span>
                    </div>
                    <h3 className="text-xl font-black text-white tracking-tight">
                      DoD Supplier Performance Risk System (SPRS) Score
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Official scoring methodology calculated for CAGE Code <strong>{formData.cageCode}</strong>.
                    </p>
                  </div>

                  {/* Primary Score Pill */}
                  <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex items-center gap-4 text-right sm:text-center">
                    <div>
                      <span className="text-[10px] font-mono uppercase text-slate-500 block">SPRS Score</span>
                      <span className={`text-3xl font-black font-mono tracking-tight ${
                        sprsResult.score >= 100
                          ? 'text-emerald-400'
                          : sprsResult.score >= 70
                          ? 'text-cyan-400'
                          : sprsResult.score >= 0
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}>
                        {sprsResult.score > 0 ? `+${sprsResult.score}` : sprsResult.score}
                      </span>
                    </div>
                    <div className="h-10 w-px bg-slate-800" />
                    <div>
                      <span className="text-[10px] font-mono uppercase text-slate-500 block">Maximum</span>
                      <span className="text-3xl font-black font-mono text-slate-400">/ 110</span>
                    </div>
                  </div>
                </div>

                {/* Score Breakdown Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 text-center">
                    <span className="text-[10px] uppercase font-bold text-slate-500 block">Evaluated Controls</span>
                    <span className="text-xl font-extrabold text-white font-mono mt-0.5 block">{sprsResult.totalControls}</span>
                    <span className="text-[10px] text-slate-400">Total Requirements</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-emerald-950/20 border border-emerald-500/30 text-center">
                    <span className="text-[10px] uppercase font-bold text-emerald-400 block">Implemented</span>
                    <span className="text-xl font-extrabold text-emerald-400 font-mono mt-0.5 block">{sprsResult.metCount}</span>
                    <span className="text-[10px] text-emerald-300">0 Point Deductions</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-500/30 text-center">
                    <span className="text-[10px] uppercase font-bold text-amber-400 block">In Progress</span>
                    <span className="text-xl font-extrabold text-amber-400 font-mono mt-0.5 block">{sprsResult.inProgressCount}</span>
                    <span className="text-[10px] text-amber-300">POA&M Remediation</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-rose-950/20 border border-rose-500/30 text-center">
                    <span className="text-[10px] uppercase font-bold text-rose-400 block">Total Deductions</span>
                    <span className="text-xl font-extrabold text-rose-400 font-mono mt-0.5 block">-{sprsResult.totalDeductions}</span>
                    <span className="text-[10px] text-rose-300">Points Subtracted</span>
                  </div>
                </div>

                {/* Deficiency Point Categories */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Deficiencies Breakdown by DoD Point Weight
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {/* 5-Point Deductions */}
                    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-rose-400">Critical 5-Point Deductions</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-bold">
                          {sprsResult.deductionsByWeight.fivePoint.length} Controls
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        High-impact basic requirements (access control, cryptography, MFA, boundary firewalls).
                      </p>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pt-1">
                        {sprsResult.deductionsByWeight.fivePoint.length === 0 ? (
                          <span className="text-[10px] text-emerald-400 font-mono">None (100% Satisfied)</span>
                        ) : (
                          sprsResult.deductionsByWeight.fivePoint.map(id => (
                            <span key={id} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20">
                              {id}
                            </span>
                          ))
                        )}
                      </div>
                    </div>

                    {/* 3-Point Deductions */}
                    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-amber-400">Intermediate 3-Point Deductions</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                          {sprsResult.deductionsByWeight.threePoint.length} Controls
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Derived requirements (audit log review, configuration control, password complexity).
                      </p>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pt-1">
                        {sprsResult.deductionsByWeight.threePoint.length === 0 ? (
                          <span className="text-[10px] text-emerald-400 font-mono">None (100% Satisfied)</span>
                        ) : (
                          sprsResult.deductionsByWeight.threePoint.map(id => (
                            <span key={id} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                              {id}
                            </span>
                          ))
                        )}
                      </div>
                    </div>

                    {/* 1-Point Deductions */}
                    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-300">Standard 1-Point Deductions</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-bold">
                          {sprsResult.deductionsByWeight.onePoint.length} Controls
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Procedural specifications (visitor logs, training records, physical access badges).
                      </p>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pt-1">
                        {sprsResult.deductionsByWeight.onePoint.length === 0 ? (
                          <span className="text-[10px] text-emerald-400 font-mono">None (100% Satisfied)</span>
                        ) : (
                          sprsResult.deductionsByWeight.onePoint.map(id => (
                            <span key={id} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                              {id}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Direct Exporter Actions Bar */}
                <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div className="text-xs text-slate-400 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Formatted for instant entry into DoD PIEE (Procurement Integrated Enterprise Environment).</span>
                  </div>

                  <div className="flex items-center gap-2.5 w-full sm:w-auto">
                    <button
                      onClick={() => downloadEmassCsv(frameworkControls, state.controls, formData)}
                      className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-cyan-500/40 text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-sm"
                    >
                      <FileSpreadsheet className="w-4 h-4" />
                      <span>Download eMASS (CSV)</span>
                    </button>

                    <button
                      onClick={() => downloadSprsSummaryJson(frameworkControls, state.controls, formData, compiledDoc.poamEntries)}
                      className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-brand-600 hover:from-cyan-500 hover:to-brand-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-md shadow-cyan-500/20"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download SPRS Record (JSON)</span>
                    </button>
                  </div>
                </div>

              </div>

            </div>
          )}

        </div>

        {/* Modal Bottom Action Footer */}
        <div className="px-5 py-4 border-t border-slate-800 bg-slate-950 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Sparkles className="w-4 h-4 text-brand-400" />
            <span>
              Compiled for <strong>{currentTenant.name}</strong> • Framework: <strong>{frameworkDef.name}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap justify-end w-full sm:w-auto">
            {/* Download POA&M CSV */}
            {compiledDoc.poamEntries && compiledDoc.poamEntries.length > 0 && (
              <button
                onClick={handleExportPoamCsv}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                title="Download standard POA&M spreadsheet table (.csv)"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span className="hidden md:inline">Export POA&M (CSV)</span>
              </button>
            )}

            {/* Export JSON Audit Package */}
            <button
              onClick={handleExportJson}
              disabled={isExportingJson}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-60"
              title="Export machine-readable JSON package with SHA-256 integrity checksum"
            >
              <FileCode className="w-4 h-4 text-indigo-400" />
              <span>Export Package (JSON)</span>
            </button>

            {/* Print / Save as PDF */}
            <button
              onClick={handlePrint}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
              title="Open print dialog or save as PDF"
            >
              <Printer className="w-4 h-4 text-amber-400" />
              <span>Print / Save PDF</span>
            </button>

            {/* Download Official Document (HTML) */}
            <button
              onClick={handleDownloadHtml}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-400 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-brand-500/25 flex items-center gap-2 transition-all active:scale-[0.98]"
              title="Download official self-contained HTML audit document"
            >
              <Download className="w-4 h-4" />
              <span>Download Official Document</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
