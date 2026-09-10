import React from 'react';
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
import { DomainCards } from './DomainCards';

export const ComplianceOverview: React.FC = () => {
  const { metrics, state, setActiveTab } = useAssessment();
  const { currentTenant, canEdit } = useTenant();

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
              <span>CMMC 2.0 Level 1 / FAR 52.204-21 Compliance Engine</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              {metrics.isSprsReady ? (
                <span className="text-emerald-400 flex items-center gap-3">
                  <CheckCircle2 className="w-8 h-8 shrink-0 text-emerald-400" />
                  SPRS Ready: 100% Baseline Achieved
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <AlertTriangle className="w-8 h-8 shrink-0 text-amber-400" />
                  Self-Assessment In Progress ({metrics.completionPercentage}%)
                </span>
              )}
            </h1>

            <p className="text-sm text-slate-300 leading-relaxed">
              {metrics.isSprsReady ? (
                <>
                  All 17 FAR 52.204-21 / NIST SP 800-171 practices for <strong>{currentTenant.name}</strong> are documented and evaluated as <strong>MET</strong>. 
                  Your organization satisfies the CMMC Level 1 standard with zero allowable POA&Ms. 
                  You are ready to generate your formal System Security Plan (SSP) and submit your score to SPRS.
                </>
              ) : (
                <>
                  CMMC Level 1 mandates satisfying all <strong>17 practices</strong> across 6 domains. 
                  Unlike Level 2, <span className="text-amber-300 font-semibold">Plans of Action & Milestones (POA&Ms) are NOT permitted</span> for Level 1 certification. 
                  Currently, <strong>{metrics.totalControls - metrics.metCount}</strong> of 17 controls require review or evidence.
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
              onClick={() => setActiveTab('ssp')}
              className="btn-primary w-full py-3 text-sm shadow-lg shadow-cyan-500/25"
            >
              <FileText className="w-4 h-4" />
              <span>Generate Official SSP</span>
            </button>

            <button
              onClick={() => setActiveTab('controls')}
              className="btn-secondary w-full py-3 text-sm"
            >
              <span>Manage Control Matrix (17)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

        </div>

        {/* Dynamic Progress Bar */}
        <div className="mt-8 pt-6 border-t border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="text-slate-400">Total CMMC Level 1 Readiness Progress</span>
            <span className="text-white font-mono">{metrics.metCount} / 17 Controls Met ({metrics.completionPercentage}%)</span>
          </div>

          <div className="w-full bg-slate-850 rounded-full h-3 overflow-hidden flex shadow-inner">
            <div
              className="bg-emerald-500 transition-all duration-700 relative"
              style={{ width: `${(metrics.metCount / 17) * 100}%` }}
              title={`${metrics.metCount} Met`}
            />
            <div
              className="bg-amber-500 transition-all duration-700"
              style={{ width: `${(metrics.inProgressCount / 17) * 100}%` }}
              title={`${metrics.inProgressCount} In Progress`}
            />
            <div
              className="bg-rose-500 transition-all duration-700"
              style={{ width: `${(metrics.notMetCount / 17) * 100}%` }}
              title={`${metrics.notMetCount} Not Met`}
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
              17 of 17 Required for DoD SPRS
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
            <span className="text-xs text-slate-400">/ 17 practices</span>
          </div>
          <p className="text-[11px] text-emerald-400 font-medium mt-2">
            {metrics.isSprsReady ? '100% Target Met' : `${17 - metrics.metCount} controls remaining`}
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

      {/* 6 CMMC Domains Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">
              CMMC Domain Assessment Breakdown
            </h3>
            <p className="text-xs text-slate-400">
              Click any domain card to jump directly to its filtered control requirements in the matrix.
            </p>
          </div>

          <button
            onClick={() => setActiveTab('controls')}
            className="text-xs font-semibold text-brand-400 hover:text-brand-300 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/20 transition-colors"
          >
            <span>View All 17 Controls</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <DomainCards />
      </div>

    </div>
  );
};
