import React, { useRef } from 'react';
import {
  AlertTriangle,
  Download,
  Upload,
  RotateCcw,
  CheckCircle2,
  Lock,
  FileCheck,
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { BrowserOnlyNotesBanner } from '../common/BrowserOnlyNotesBanner';
import { SessionOfflineNotice } from './SessionOfflineNotice';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { getFrameworkTitle } from '../../data/frameworks';
import { calculateSprsScore, formatSprsScore } from '../../data/reports/sprsCompiler';
import { TenantSwitcher } from './TenantSwitcher';
import { ProgramSwitcher } from './ProgramSwitcher';
import { FrameworkSwitcher } from './FrameworkSwitcher';
import { UserProfileDropdown } from '../auth/UserProfileDropdown';

interface HeaderProps {
}

export const Header: React.FC<HeaderProps> = () => {
  const {
    state,
    metrics,
    frameworkControls,
    resetAssessment,
    exportAssessmentJSON,
    importAssessmentJSON,
    setActiveTab,
    openExportModal,
  } = useAssessment();

  const { canEdit, currentTenant, activeFramework } = useTenant();
  // The server could not confirm the session on load: the app shows this browser's data, so the badge must not say "live"
  const { sessionCheck } = useAuth();
  const totalCount = metrics.totalControls || frameworkControls.length || 1;
  const frameworkTitle = getFrameworkTitle(activeFramework);

  const sprsResult = React.useMemo(() => {
    if (activeFramework === 'CMMC_L2') {
      return calculateSprsScore(frameworkControls, state.controls, state.sspMetadata);
    }
    return null;
  }, [activeFramework, frameworkControls, state.controls, state.sspMetadata]);

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
        
        {/* Left: Brand + Multi-Tenant Switcher + Program Switcher + Overlays */}
        <div className="flex items-center gap-3 sm:gap-4 w-full md:w-auto justify-between md:justify-start flex-wrap">
          {/* Brand */}
          <button type="button" 
            onClick={() => setActiveTab('dashboard')}
            className="text-left flex items-center gap-2.5 cursor-pointer group"
          >
            <BrandLogo size="sm" />
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-sm sm:text-base text-white tracking-tight">Event Horizon: Singularity</span>
                {sessionCheck === 'offline' ? (
                  <span className="text-xs uppercase font-bold px-1.5 py-0.5 rounded-full border bg-amber-500/20 text-amber-300 border-amber-500/40">
                    OFFLINE
                  </span>
                ) : (
                  <span className="text-xs uppercase font-bold px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
                    LIVE ENCLAVE
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 font-medium">
                Pitch Black Cyber • {frameworkControls.length} Controls
              </p>
            </div>
          </button>

          <div className="h-6 w-px bg-slate-800 hidden md:block" />

          {/* Top-Nav Multi-Tenant Switcher */}
          <TenantSwitcher />

          <div className="h-6 w-px bg-slate-800 hidden lg:block" />

          {/* Top-Nav Program Switcher (the program holds the framework and baseline; doubles as the scope badge) */}
          <ProgramSwitcher />

          {/* Operational overlays (NIST SP 800-53: saved with the program) */}
          <FrameworkSwitcher />
        </div>

        {/* Right: SPRS / Framework Readiness Pill + Global Actions */}
        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end flex-wrap">
          
          {/* SPRS / Compliance Indicator */}
          <button type="button"
            onClick={() => setActiveTab('controls')}
            className="text-left flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 shadow-inner cursor-pointer transition-colors"
            title={`View ${frameworkTitle} control requirements`}
          >
            <div className="text-xs text-slate-400 flex items-center gap-1.5 font-medium">
              <Lock className="w-3.5 h-3.5 text-slate-400" />
              <span className="hidden sm:inline">
                {`${frameworkTitle} Readiness:`}
              </span>
            </div>
            {metrics.isSprsReady ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-xs font-mono font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                {metrics.metCount} / {totalCount} MET
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-xs font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                {metrics.metCount} / {totalCount} MET
                {sprsResult && (
                  <span className="ml-1 pl-1.5 border-l border-amber-500/40 text-cyan-300">
                    SPRS {formatSprsScore(sprsResult)}
                  </span>
                )}
              </span>
            )}
          </button>


          {/* Quick Action Buttons */}
          <div className="flex items-center gap-1.5">
            {/* Export Audit Package / Compliance Artifacts */}
            <button
              onClick={() => openExportModal()}
              title="Open Compliance Documentation & Artifact Export Center (SSP, POA&M, System Description)"
              className="btn-primary px-2.5 py-1.5 text-xs font-semibold rounded-xl flex items-center gap-1.5"
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

            {/* User Profile & Identity Dropdown */}
            <UserProfileDropdown />

          </div>
        </div>

      </div>

      {/* The server could not confirm the session on load: cached data is shown (non-blocking, hideable) */}
      <SessionOfflineNotice />

      {/* Browser-only tenants: their notes have no other copy (persistent, not dismissable) */}
      <BrowserOnlyNotesBanner />
    </header>
  );
};
