import React, { useRef } from 'react';
import {
  AlertTriangle,
  Download,
  Upload,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Lock,
  Globe,
  FileCheck,
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { TenantSwitcher } from './TenantSwitcher';
import { FrameworkSwitcher } from './FrameworkSwitcher';
import { UserProfileDropdown } from '../auth/UserProfileDropdown';

interface HeaderProps {
  onExitToLanding?: () => void;
  isSandboxMode?: boolean;
  onRequestLicense?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onExitToLanding, isSandboxMode, onRequestLicense }) => {
  const {
    metrics,
    frameworkControls,
    loadDemoScenario,
    resetAssessment,
    exportAssessmentJSON,
    importAssessmentJSON,
    setActiveTab,
    openExportModal,
  } = useAssessment();

  const { canEdit, currentTenant, activeFramework } = useTenant();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const success = await importAssessmentJSON(file);
      if (success) {
        alert(`Assessment data successfully imported for ${currentTenant.name}!`);
      }
      e.target.value = '';
    }
  };

  const handleReset = async () => {
    if (window.confirm(`Are you sure you want to reset the assessment for "${currentTenant.name}"? All custom narratives and evidence for this tenant will be cleared.`)) {
      await resetAssessment();
    }
  };

  return (
    <header className="no-print bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-3 sm:px-6 py-2.5 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 sm:gap-4">
        
        {/* Left: Brand + Multi-Tenant Switcher + Framework Switcher */}
        <div className="flex items-center gap-3 sm:gap-4 w-full md:w-auto justify-between md:justify-start flex-wrap">
          {/* Brand */}
          <div 
            onClick={() => setActiveTab('dashboard')}
            className="flex items-center gap-2.5 cursor-pointer group"
          >
            <BrandLogo size="sm" />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-sm sm:text-base text-white tracking-tight">Event Horizon: Singularity</span>
                <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-full border ${
                  isSandboxMode
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                }`}>
                  {isSandboxMode ? 'SANDBOX' : 'LIVE ENCLAVE'}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium">
                Pitch Black Cyber • {frameworkControls.length} Controls
              </p>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-800 hidden md:block" />

          {/* Top-Nav Multi-Tenant Switcher */}
          <TenantSwitcher />

          <div className="h-6 w-px bg-slate-800 hidden lg:block" />

          {/* Top-Nav Framework & Baseline Switcher */}
          <FrameworkSwitcher />
        </div>

        {/* Right: SPRS / Framework Readiness Pill + Global Actions */}
        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end flex-wrap">
          
          {/* SPRS / Compliance Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700/80 shadow-inner">
            <div className="text-xs text-slate-400 flex items-center gap-1.5 font-medium">
              <Lock className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden sm:inline">
                {activeFramework === 'CMMC_L1' ? 'SPRS Readiness:' : 'Readiness:'}
              </span>
            </div>
            {metrics.isSprsReady ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {metrics.metCount} / {metrics.totalControls} MET (100%)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5" />
                {metrics.metCount} / {metrics.totalControls} Met ({metrics.completionPercentage}%)
              </span>
            )}
          </div>


          {/* Quick Action Buttons */}
          <div className="flex items-center gap-1.5">
            {/* Load Demo */}
            {canEdit && (
              <button
                onClick={loadDemoScenario}
                title="Populate 100% compliant demo narrative and sample evidence for active tenant"
                className="px-2.5 py-1.5 text-xs font-medium rounded-xl bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/30 hover:border-brand-500/50 transition-colors flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                <span className="hidden sm:inline">Demo Data</span>
              </button>
            )}

            {/* Export Audit Package / Compliance Artifacts */}
            <button
              onClick={() => openExportModal()}
              title="Open Compliance Documentation & Artifact Export Center (SSP, POA&M, System Description)"
              className="px-2.5 py-1.5 text-xs font-semibold rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white shadow-md shadow-brand-600/25 flex items-center gap-1.5 transition-all"
            >
              <FileCheck className="w-3.5 h-3.5 text-brand-200" />
              <span className="hidden sm:inline">Export Audit Package</span>
              <span className="sm:hidden">Export</span>
            </button>

            {/* Quick Export JSON Backup */}
            <button
              onClick={exportAssessmentJSON}
              title="Backup current tenant assessment to JSON"
              className="p-2 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>

            {/* Import JSON */}
            {canEdit && (
              <>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".json"
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  title="Import assessment from JSON backup into active tenant"
                  className="p-2 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors"
                >
                  <Upload className="w-4 h-4" />
                </button>
              </>
            )}

            {/* Reset */}
            {canEdit && (
              <button
                onClick={handleReset}
                title="Reset active tenant assessment to baseline"
                className="p-2 text-rose-400/80 hover:text-rose-300 bg-slate-800 hover:bg-rose-950/40 border border-slate-700 hover:border-rose-900 rounded-xl transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}

            {/* Request License Callout in Sandbox Mode */}
            {isSandboxMode && onRequestLicense && (
              <button
                onClick={onRequestLicense}
                title="Schedule sales onboarding call and configure licensed boundary"
                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-400 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-brand-500/20 flex items-center gap-1.5 transition-all"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                <span className="hidden sm:inline">Request Enclave License</span>
                <span className="sm:hidden">License</span>
              </button>
            )}

            {/* User Profile & Identity Dropdown */}
            <UserProfileDropdown />

            {/* Exit to Landing Page */}
            {onExitToLanding && (
              <button
                onClick={onExitToLanding}
                title="Exit to Public Landing Page"
                className="p-2 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors flex items-center gap-1.5 text-xs"
              >
                <Globe className="w-4 h-4 text-slate-400" />
                <span className="hidden xl:inline">Public Site</span>
              </button>
            )}
          </div>
        </div>

      </div>
    </header>
  );
};
