import React, { useState } from 'react';
import {
  FileText,
  Printer,
  Download,
  Copy,
  Check,
  Building,
  Eye,
  Edit3,
  Lock,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { CMMC_LEVEL_1_CONTROLS } from '../../data/cmmcLevel1Controls';
import { DEFAULT_GCP_CONFIG } from '../../services/gcsService';

export const SSPBuilder: React.FC = () => {
  const {
    state,
    metrics,
    updateSSPMetadata,
    exportAssessmentMarkdown,
  } = useAssessment();

  const { currentTenant, canEdit } = useTenant();

  const [viewMode, setViewMode] = useState<'document' | 'form'>('document');
  const [copied, setCopied] = useState<boolean>(false);

  const meta = state.sspMetadata;

  const handlePrint = () => {
    window.print();
  };

  const handleCopyText = () => {
    let text = `SYSTEM SECURITY PLAN (SSP) - CMMC LEVEL 1 / FAR 52.204-21\n\n`;
    text += `ORGANIZATION: ${meta.organizationName}\n`;
    text += `CAGE CODE: ${meta.cageCode}\n`;
    text += `SAM.GOV STATUS: ${meta.samStatus || 'Active'}\n`;
    text += `SYSTEM NAME: ${meta.systemName}\n`;
    text += `SYSTEM OWNER: ${meta.systemOwner}\n`;
    text += `ASSESSMENT DATE: ${meta.assessmentDate}\n`;
    text += `GCS ENCLAVE: gs://${DEFAULT_GCP_CONFIG.gcsBucketName}/tenants/${currentTenant.id}/\n\n`;
    text += `SYSTEM BOUNDARY & SCOPE:\n${meta.systemBoundaryScope}\n\n`;
    text += `17 CONTROLS ASSESSMENT MATRIX:\n`;

    for (const ctrl of CMMC_LEVEL_1_CONTROLS) {
      const cState = state.controls[ctrl.id];
      const evidence = state.evidenceIndex.filter(e => e.controlId === ctrl.id);
      text += `\n[${ctrl.id}] ${ctrl.title} (${ctrl.farReference})\n`;
      text += `Status: ${cState?.status || 'NOT_STARTED'}\n`;
      text += `Implementation Statement:\n${cState?.implementationNotes || 'No implementation notes provided.'}\n`;
      if (evidence.length > 0) {
        text += `Evidence Artifacts: ${evidence.map(e => `${e.name} (SHA-256: ${e.fileHash || 'N/A'})`).join(', ')}\n`;
      }
    }

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Top Action Toolbar (Hidden during print) */}
      <div className="no-print bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-xl">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-brand-500/20 text-brand-300">
              <FileText className="w-5 h-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-white tracking-tight">
                  System Security Plan (SSP) Generator
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-800 text-brand-300 border border-slate-700">
                  {currentTenant.name}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                NIST SP 800-171 / FAR 52.204-21 compliance documentation automatically compiled for all 17 controls.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap w-full md:w-auto justify-end">
          {/* Mode Switcher */}
          <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1">
            <button
              onClick={() => setViewMode('document')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                viewMode === 'document'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Audit Document</span>
            </button>
            <button
              onClick={() => setViewMode('form')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                viewMode === 'form'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit System Info</span>
            </button>
          </div>

          {/* Print / PDF Button */}
          <button
            onClick={handlePrint}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-all flex items-center gap-2 shadow-lg shadow-emerald-600/20 hover:scale-[1.02]"
          >
            <Printer className="w-4 h-4" />
            <span>Print / Save as PDF</span>
          </button>

          {/* Copy Text */}
          <button
            onClick={handleCopyText}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            title="Copy Full SSP Text"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>

          {/* Export Markdown */}
          <button
            onClick={exportAssessmentMarkdown}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            title="Download SSP Markdown (.md)"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* VIEW 1: SYSTEM INFO FORM */}
      {viewMode === 'form' && (
        <div className="no-print bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-xl">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Building className="w-5 h-5 text-brand-400" />
              System & Organization Governance Information
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              These details populate the System Security Plan header, boundary scope narrative, and executive summary for <strong>{currentTenant.name}</strong>.
            </p>
          </div>

          {!canEdit && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
              <Lock className="w-4 h-4" />
              <span>You are in Read-Only Viewer mode. Editing metadata is disabled.</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Organization Name */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Organization Name
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.organizationName}
                onChange={(e) => updateSSPMetadata({ organizationName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. Apex Defense Solutions, LLC"
              />
            </div>

            {/* CAGE Code */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                CAGE Code (Commercial and Government Entity)
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.cageCode}
                onChange={(e) => updateSSPMetadata({ cageCode: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white font-mono focus:border-brand-500 focus:outline-none uppercase disabled:opacity-70"
                placeholder="e.g. 9X7B4"
              />
            </div>

            {/* System Name */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Information System Name
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.systemName}
                onChange={(e) => updateSSPMetadata({ systemName: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. Corporate Operations Enclave (COE)"
              />
            </div>

            {/* System Owner */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Designated System Owner & Role
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.systemOwner}
                onChange={(e) => updateSSPMetadata({ systemOwner: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. Alex Mercer, CMMC CCA"
              />
            </div>

            {/* Assessment Date */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Assessment Baseline Date
              </label>
              <input
                type="date"
                disabled={!canEdit}
                value={meta.assessmentDate}
                onChange={(e) => updateSSPMetadata({ assessmentDate: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
              />
            </div>

            {/* Document Version */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                SSP Version
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.version}
                onChange={(e) => updateSSPMetadata({ version: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. 1.0.0"
              />
            </div>

            {/* Boundary Scope */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                System Boundary & Scope Description
              </label>
              <textarea
                rows={4}
                disabled={!canEdit}
                value={meta.systemBoundaryScope}
                onChange={(e) => updateSSPMetadata({ systemBoundaryScope: e.target.value })}
                className="w-full p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="Describe the operational boundary, physical facilities, cloud tenants, and components that process, store, or transmit FCI..."
              />
            </div>

            {/* Operating Environment */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                System Operating Environment
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.systemEnvironment}
                onChange={(e) => updateSSPMetadata({ systemEnvironment: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. Hybrid Cloud: Microsoft 365 + On-Premises HQ"
              />
            </div>

            {/* Cloud Service Providers */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Authorized Cloud Service Providers (CSPs)
              </label>
              <input
                type="text"
                disabled={!canEdit}
                value={meta.cloudServiceProviders}
                onChange={(e) => updateSSPMetadata({ cloudServiceProviders: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70"
                placeholder="e.g. Microsoft 365, Google Cloud Platform, Cloudflare"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800 flex justify-end">
            <button
              onClick={() => setViewMode('document')}
              className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs transition-colors"
            >
              View Formatted SSP Document
            </button>
          </div>
        </div>
      )}

      {/* VIEW 2: FORMAL PRINTABLE AUDIT DOCUMENT */}
      {viewMode === 'document' && (
        <div className="ssp-print-document bg-white text-slate-900 rounded-3xl p-6 sm:p-12 shadow-2xl border border-slate-200 font-sans space-y-8 max-w-5xl mx-auto">
          
          {/* Document Header & Cover Banner */}
          <div className="border-b-2 border-slate-900 pb-6 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 font-mono">
              <span>SECURITY CLASSIFICATION: UNCLASSIFIED // FCI ONLY</span>
              <span>VERSION {meta.version}</span>
            </div>
            
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-950 tracking-tight">
              SYSTEM SECURITY PLAN (SSP)
            </h1>
            <p className="text-sm font-semibold text-slate-700">
              Basic Safeguarding of Covered Contractor Information Systems
            </p>
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <span className="text-xs font-bold px-2 py-0.5 bg-slate-100 text-slate-800 rounded border border-slate-300">
                FAR 52.204-21
              </span>
              <span className="text-xs font-bold px-2 py-0.5 bg-brand-50 text-brand-800 rounded border border-brand-200">
                CMMC 2.0 Level 1 (17 Controls)
              </span>
              <span className="text-xs font-bold px-2 py-0.5 bg-emerald-50 text-emerald-800 rounded border border-emerald-200">
                NIST SP 800-171 Baseline
              </span>
            </div>
          </div>

          {/* Section 1: System Identification & Governance Metadata */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              1. System Identification & Governance
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Organization Name</span>
                <span className="text-slate-900 font-bold text-sm">{meta.organizationName}</span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">CAGE Code</span>
                <span className="text-slate-900 font-mono font-bold text-sm">{meta.cageCode || 'N/A'}</span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Information System Name</span>
                <span className="text-slate-900 font-bold">{meta.systemName}</span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Designated System Owner</span>
                <span className="text-slate-900 font-semibold">{meta.systemOwner}</span>
              </div>

              <div className="sm:col-span-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">System Architecture & Hosting Environment</span>
                <span className="text-slate-900">{meta.systemEnvironment}</span>
              </div>
            </div>
          </div>

          {/* Section 2: System Boundary & Scope */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              2. System Boundary & Scope Narrative
            </h2>
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-800 leading-relaxed whitespace-pre-wrap">
              {meta.systemBoundaryScope || 'No boundary scope defined.'}
            </div>
          </div>

          {/* Section 3: Executive Compliance Summary */}
          <div className="space-y-3 print-avoid-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              3. Executive Compliance Scorecard
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{metrics.metCount}/17</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Practices Met</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{metrics.completionPercentage}%</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Overall Readiness</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">0</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Allowed POA&Ms</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{state.evidenceIndex.length}</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Evidence Files</p>
              </div>
            </div>
          </div>

          {/* Section 4: 17 CMMC Level 1 Practices Evaluation Matrix */}
          <div className="space-y-4 print-page-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              4. FAR 52.204-21 / CMMC Level 1 Practices Evaluation Matrix (17 Controls)
            </h2>

            <div className="space-y-4">
              {CMMC_LEVEL_1_CONTROLS.map((ctrl) => {
                const cState = state.controls[ctrl.id];
                const status = cState?.status || 'NOT_STARTED';
                const evidenceList = state.evidenceIndex.filter((e) => e.controlId === ctrl.id);

                return (
                  <div
                    key={ctrl.id}
                    className="p-4 rounded-xl border border-slate-300 bg-white space-y-2.5 print-avoid-break shadow-sm"
                  >
                    {/* Control Bar */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-xs bg-slate-900 text-white px-2 py-0.5 rounded">
                          {ctrl.id}
                        </span>
                        <span className="font-bold text-sm text-slate-900">
                          {ctrl.title}
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          ({ctrl.farReference})
                        </span>
                      </div>

                      {/* Status Badge */}
                      <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full self-start sm:self-auto ${
                        status === 'MET'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : status === 'IN_PROGRESS'
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : status === 'NOT_MET'
                          ? 'bg-rose-100 text-rose-800 border border-rose-300'
                          : 'bg-slate-100 text-slate-700 border border-slate-300'
                      }`}>
                        Status: {status}
                      </span>
                    </div>

                    {/* Requirement Summary */}
                    <p className="text-[11px] text-slate-600 italic">
                      Requirement: {ctrl.plainEnglishSummary}
                    </p>

                    {/* Implementation Narrative */}
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                        Implementation Statement:
                      </span>
                      <p className="text-xs text-slate-800 leading-relaxed whitespace-pre-wrap">
                        {cState?.implementationNotes || (
                          <span className="text-slate-400 italic">No implementation notes documented.</span>
                        )}
                      </p>
                    </div>

                    {/* Evidence References with SHA-256 and GCS Path */}
                    <div className="flex items-start gap-2 flex-wrap text-[11px] pt-1">
                      <span className="font-semibold text-slate-600">Attached Evidence Artifacts:</span>
                      {evidenceList.length === 0 ? (
                        <span className="text-slate-400 italic">None attached</span>
                      ) : (
                        <div className="flex flex-col gap-1 w-full mt-1">
                          {evidenceList.map((e) => (
                            <div
                              key={e.id}
                              className="px-2.5 py-1 bg-slate-100 border border-slate-200 text-slate-800 rounded-lg font-mono text-[10px] flex items-center justify-between flex-wrap gap-2"
                            >
                              <span className="font-bold">{e.name}</span>
                              <span className="text-slate-500">GCS: {e.gcsPath || 'Local Vault'}</span>
                              {e.fileHash && (
                                <span className="text-emerald-700 font-semibold">SHA-256: {e.fileHash.substring(0, 16)}...</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 5: Formal Attestation & Signature Block */}
          <div className="space-y-4 pt-6 border-t-2 border-slate-900 print-avoid-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              5. Formal Attestation & Self-Assessment Approval
            </h2>

            <p className="text-xs text-slate-700 leading-relaxed">
              I, the undersigned Senior Official / System Owner, hereby certify that the information contained within this System Security Plan (SSP) accurately reflects the security safeguards implemented within <strong>{meta.systemName}</strong> for <strong>{meta.organizationName}</strong> in accordance with FAR 52.204-21 and CMMC Level 1 standards.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-6">
              <div className="border-t border-slate-900 pt-2">
                <p className="text-xs font-bold text-slate-900">{meta.systemOwner}</p>
                <p className="text-[11px] text-slate-500">System Owner / Authorized Representative Signature</p>
              </div>

              <div className="border-t border-slate-900 pt-2">
                <p className="text-xs font-bold text-slate-900">{meta.assessmentDate}</p>
                <p className="text-[11px] text-slate-500">Date of Attestation</p>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
