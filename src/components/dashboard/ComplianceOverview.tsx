import React, { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Paperclip,
  FileText,
  ArrowRight,
  Shield,
  Building2,
  Lock,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getFrameworkTitle, getFrameworkGuidanceText } from '../../data/frameworks';
import { calculateSprsScore } from '../../data/reports/sprsCompiler';
import { DomainCards } from './DomainCards';

export const ComplianceOverview: React.FC = () => {
  const { metrics, state, frameworkControls, setActiveTab, openExportModal } = useAssessment();
  const { currentTenant, canEdit, activeFramework } = useTenant();

  const frameworkTitle = getFrameworkTitle(activeFramework);
  const guidance = getFrameworkGuidanceText(activeFramework);
  const totalCount = metrics.totalControls || frameworkControls.length || 1;

  // Real-time CMMC L2 SPRS score (-203 to +110)
  const sprsResult = useMemo(() => {
    if (activeFramework === 'CMMC_L2') {
      return calculateSprsScore(frameworkControls, state.controls);
    }
    return null;
  }, [activeFramework, frameworkControls, state.controls]);

  // Progress Bar Percentage Math (Guaranteed to sum to 100% across totalCount)
  const metPct = totalCount > 0 ? (metrics.metCount / totalCount) * 100 : 0;
  const inProgressPct = totalCount > 0 ? (metrics.inProgressCount / totalCount) * 100 : 0;
  const notMetPct = totalCount > 0 ? (metrics.notMetCount / totalCount) * 100 : 0;
  const notStartedPct = totalCount > 0 ? (metrics.notStartedCount / totalCount) * 100 : 0;

  return (
    <div className="space-y-8 animate-fadeIn">
      
      {/* RBAC Read-Only Banner for Viewers */}
      {!canEdit && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <Lock className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <span className="font-bold text-amber-300">Read-Only Viewer Mode:</span>{' '}
              <span className="text-slate-300">
                You are currently viewing <strong>{currentTenant.name}</strong> in audit review mode. 
                Modifications to control narratives and evidence uploads are disabled.
              </span>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">
            VIEWER
          </span>
        </div>
      )}

      {/* Hero / SPRS Status Banner */}
      <div className={`relative overflow-hidden rounded-3xl p-6 sm:p-8 border shadow-2xl transition-all ${
        metrics.isSprsReady
          ? 'bg-gradient-to-br from-emerald-950/70 via-slate-900 to-slate-900 border-emerald-500/40 shadow-emerald-500/10'
          : 'bg-gradient-to-br from-slate-900 via-slate-900/90 to-brand-950/40 border-slate-800 shadow-brand-500/5'
      }`}>
        <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          
          <div className="space-y-3 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800/80 border border-slate-700 text-slate-300">
              <Shield className="w-3.5 h-3.5 text-brand-400" />
              <span>{guidance.bannerTitle}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {metrics.isSprsReady ? (
                <span className="text-emerald-400 flex items-center gap-3">
                  <CheckCircle2 className="w-8 h-8 shrink-0 text-emerald-400" />
                  {frameworkTitle} Ready: 100% Baseline Achieved
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <AlertTriangle className="w-8 h-8 shrink-0 text-amber-400" />
                  Self-Assessment In Progress ({metrics.completionPercentage}%)
                  {sprsResult && (
                    <span className="text-sm font-mono font-normal px-2.5 py-0.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      SPRS Score: {sprsResult.score > 0 ? `+${sprsResult.score}` : sprsResult.score}
                    </span>
                  )}
                </span>
              )}
            </h1>

            <p className="text-sm text-slate-300 leading-relaxed">
              {metrics.isSprsReady ? (
                <>
                  All {totalCount} {guidance.standardRef} practices for <strong>{currentTenant.name}</strong> are documented and evaluated as <strong>MET</strong>. 
                  {guidance.poamPermitted ? (
                    <> Your organization satisfies the {frameworkTitle} baseline with full evidence integrity.</>
                  ) : (
                    <> Your organization satisfies the {frameworkTitle} standard with zero allowable POA&Ms.</>
                  )}
                  {' '}You are ready to generate your formal System Security Plan (SSP) and submit your compliance artifacts.
                </>
              ) : (
                <>
                  {frameworkTitle} mandates satisfying all <strong>{totalCount} controls</strong> across the active scope. 
                  {' '}{guidance.poamPolicyText} 
                  {' '}Currently, <strong>{totalCount - metrics.metCount}</strong> of {totalCount} controls require review or evidence.
                </>
              )}
            </p>

            {/* Micro Badges with Active Tenant Metadata */}
            <div className="flex flex-wrap items-center gap-2.5 pt-2 text-xs font-medium text-slate-400">
              <span className="px-2.5 py-1 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-200 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-brand-400" />
                <strong className="text-white">{currentTenant.name}</strong>
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300 font-mono">
                CAGE: <strong className="text-brand-300">{currentTenant.cageCode || 'N/A'}</strong>
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300">
                SAM: <strong className={currentTenant.samStatus === 'ACTIVE' ? 'text-emerald-400' : 'text-amber-400'}>{currentTenant.samStatus}</strong>
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300">
                Evidence Files: <strong className="text-white">{state.evidenceIndex.length}</strong>
              </span>
            </div>
          </div>

          {/* Right Action Box */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-3 w-full sm:w-auto lg:w-64 shrink-0">
            <button
              onClick={() => openExportModal()}
              className="btn-primary w-full py-3 text-sm shadow-lg shadow-cyan-500/25"
            >
              <FileText className="w-4 h-4" />
              <span>Generate Official SSP</span>
            </button>

            <button
              onClick={() => setActiveTab('controls')}
              className="btn-secondary w-full py-3 text-sm"
            >
              <span>Manage Control Matrix ({totalCount})</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

        </div>

        {/* Dynamic Progress Bar */}
        <div className="mt-8 pt-6 border-t border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="text-slate-400">Total {frameworkTitle} Readiness Progress</span>
            <span className="text-white font-mono">
              {metrics.metCount} / {totalCount} Controls Met ({metrics.completionPercentage}%)
              {sprsResult && ` • SPRS: ${sprsResult.score > 0 ? `+${sprsResult.score}` : sprsResult.score}`}
            </span>
          </div>

          <div className="w-full bg-slate-850 rounded-full h-3 overflow-hidden flex shadow-inner">
            <div
              className="bg-emerald-500 transition-all duration-700 relative"
              style={{ width: `${metPct}%` }}
              title={`${metrics.metCount} Met`}
            />
            <div
              className="bg-amber-500 transition-all duration-700"
              style={{ width: `${inProgressPct}%` }}
              title={`${metrics.inProgressCount} In Progress`}
            />
            <div
              className="bg-rose-500 transition-all duration-700"
              style={{ width: `${notMetPct}%` }}
              title={`${metrics.notMetCount} Not Met`}
            />
            <div
              className="bg-slate-700/60 transition-all duration-700"
              style={{ width: `${notStartedPct}%` }}
              title={`${metrics.notStartedCount} Not Started`}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 flex-wrap gap-2">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Met ({metrics.metCount})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> In Progress ({metrics.inProgressCount})
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-600" /> Not Started ({metrics.notStartedCount})
              </span>
              {metrics.notMetCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Not Met ({metrics.notMetCount})
                </span>
              )}
            </div>

            <span className="font-mono text-slate-400">
              {metrics.metCount} of {totalCount} Satisfied
            </span>
          </div>
        </div>
      </div>

      {/* 4 Metric Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Met Count Card */}
        <div className="stitch-card p-5 shadow-lg flex flex-col justify-between hover:border-emerald-500/40">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Controls Satisfied</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.metCount}</span>
            <span className="text-xs text-slate-400">/ {totalCount} controls</span>
          </div>
          <p className="text-[11px] text-emerald-400 font-medium mt-2">
            {metrics.isSprsReady ? '100% Target Met' : `${totalCount - metrics.metCount} controls remaining`}
          </p>
        </div>

        {/* In Progress Card */}
        <div className="stitch-card p-5 shadow-lg flex flex-col justify-between hover:border-amber-500/40">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">In Progress</span>
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.inProgressCount}</span>
            <span className="text-xs text-slate-400">controls</span>
          </div>
          <p className="text-[11px] text-amber-400 font-medium mt-2">
            Narratives or evidence active
          </p>
        </div>

        {/* Not Started Card */}
        <div className="stitch-card p-5 shadow-lg flex flex-col justify-between hover:border-slate-700">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Not Started</span>
            <div className="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center">
              <HelpCircle className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.notStartedCount}</span>
            <span className="text-xs text-slate-400">controls</span>
          </div>
          <p className="text-[11px] text-slate-400 font-medium mt-2">
            {metrics.notStartedCount === 0 ? 'All controls initiated' : 'Action required'}
          </p>
        </div>

        {/* Evidence Vault Card */}
        <div 
          onClick={() => setActiveTab('vault')}
          className="stitch-card p-5 shadow-lg flex flex-col justify-between cursor-pointer hover:border-cyan-500/40 group transition-all"
        >
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">Evidence Artifacts</span>
            <div className="w-8 h-8 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center group-hover:scale-110 transition-transform">
              <Paperclip className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{state.evidenceIndex.length}</span>
            <span className="text-xs text-slate-400">GCS Synced</span>
          </div>
          <p className="text-[11px] text-cyan-400 font-medium mt-2 flex items-center gap-1">
            <span>View Vault</span>
            <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
          </p>
        </div>
      </div>

      {/* Framework Domains Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">
              {frameworkTitle} Domain Assessment Breakdown
            </h3>
            <p className="text-xs text-slate-400">
              Click any domain card to jump directly to its filtered control requirements in the matrix.
            </p>
          </div>

          <button
            onClick={() => setActiveTab('controls')}
            className="text-xs font-semibold text-brand-400 hover:text-brand-300 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/20 transition-colors"
          >
            <span>View All {totalCount} Controls</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <DomainCards />
      </div>

    </div>
  );
};
