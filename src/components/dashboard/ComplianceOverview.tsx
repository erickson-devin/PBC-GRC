import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Paperclip,
  FileText,
  Sparkles,
  ArrowRight,
  Shield,
  Layers,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { DomainCards } from './DomainCards';

export const ComplianceOverview: React.FC = () => {
  const { metrics, state, setActiveTab, loadDemoScenario } = useAssessment();

  return (
    <div className="space-y-8 animate-fadeIn">
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
                  All 17 FAR 52.204-21 controls are documented and evaluated as <strong>MET</strong>. 
                  Your organization satisfies the CMMC Level 1 standard with zero allowable POA&Ms. 
                  You are ready to generate your formal System Security Plan (SSP) and submit your score to SPRS.
                </>
              ) : (
                <>
                  CMMC Level 1 mandates satisfying all <strong>17 practices</strong> across 6 domains. 
                  Unlike Level 2, <span className="text-amber-300 font-semibold">Plans of Action & Milestones (POA&Ms) are NOT permitted</span> for Level 1 certification. 
                  Currently, <strong>{17 - metrics.metCount}</strong> controls require review or evidence.
                </>
              )}
            </p>

            {/* Micro Badges */}
            <div className="flex flex-wrap items-center gap-3 pt-2 text-xs font-medium text-slate-400">
              <span className="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300">
                System: <strong className="text-white">{state.sspMetadata.systemName}</strong>
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300 font-mono">
                CAGE: <strong className="text-brand-300">{state.sspMetadata.cageCode || 'N/A'}</strong>
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300">
                Evidence Files: <strong className="text-white">{state.evidenceIndex.length}</strong>
              </span>
            </div>
          </div>

          {/* Right Action Box */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-3 w-full sm:w-auto lg:w-60 shrink-0">
            <button
              onClick={() => setActiveTab('ssp')}
              className="w-full py-3 px-4 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm shadow-lg shadow-brand-500/25 flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <FileText className="w-4 h-4" />
              <span>Generate Official SSP</span>
            </button>

            <button
              onClick={() => setActiveTab('controls')}
              className="w-full py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-sm border border-slate-700 flex items-center justify-center gap-2 transition-all hover:scale-[1.02]"
            >
              <span>Manage Controls Matrix</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

        </div>

        {/* Global Progress Bar */}
        <div className="mt-8 pt-6 border-t border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-400">Overall Level 1 Readiness</span>
            <span className="text-white font-mono">{metrics.metCount} / 17 Controls Met ({metrics.completionPercentage}%)</span>
          </div>

          <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden flex p-0.5 border border-slate-800">
            <div
              className="bg-emerald-500 rounded-l-full transition-all duration-700 shadow-sm"
              style={{ width: `${(metrics.metCount / 17) * 100}%` }}
              title={`${metrics.metCount} Met`}
            />
            <div
              className="bg-amber-500 transition-all duration-700 shadow-sm"
              style={{ width: `${(metrics.inProgressCount / 17) * 100}%` }}
              title={`${metrics.inProgressCount} In Progress`}
            />
            <div
              className="bg-rose-500 transition-all duration-700 shadow-sm"
              style={{ width: `${(metrics.notMetCount / 17) * 100}%` }}
              title={`${metrics.notMetCount} Not Met`}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
                <span>Met ({metrics.metCount})</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                <span>In Progress ({metrics.inProgressCount})</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-600 inline-block" />
                <span>Not Started ({metrics.notStartedCount})</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />
                <span>Not Met ({metrics.notMetCount})</span>
              </span>
            </div>
            <span className="hidden sm:inline text-slate-500">
              17 of 17 Required for DoD SPRS
            </span>
          </div>
        </div>
      </div>

      {/* 4 Metric Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Met Card */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Met Practices</span>
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.metCount}</span>
            <span className="text-xs text-slate-400">/ 17 practices</span>
          </div>
          <p className="text-xs text-emerald-400 font-medium mt-1">
            {metrics.completionPercentage}% of baseline satisfied
          </p>
        </div>

        {/* In Progress Card */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">In Progress</span>
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.inProgressCount}</span>
            <span className="text-xs text-slate-400">practices active</span>
          </div>
          <p className="text-xs text-amber-400 font-medium mt-1">
            Under active policy/evidence review
          </p>
        </div>

        {/* Not Started Card */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Not Started</span>
            <div className="w-8 h-8 rounded-lg bg-slate-800 text-slate-400 flex items-center justify-center">
              <HelpCircle className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{metrics.notStartedCount}</span>
            <span className="text-xs text-slate-400">remaining</span>
          </div>
          <p className="text-xs text-slate-400 font-medium mt-1">
            Awaiting narrative or evaluation
          </p>
        </div>

        {/* Evidence Artifacts Card */}
        <div 
          onClick={() => setActiveTab('vault')}
          className="bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 shadow-lg cursor-pointer transition-all group"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider group-hover:text-brand-300 transition-colors">
              Evidence Vault
            </span>
            <div className="w-8 h-8 rounded-lg bg-brand-500/15 text-brand-400 flex items-center justify-center">
              <Paperclip className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white font-mono">{state.evidenceIndex.length}</span>
            <span className="text-xs text-slate-400">files stored</span>
          </div>
          <p className="text-xs text-brand-400 group-hover:text-brand-300 font-medium mt-1 flex items-center gap-1">
            <span>View all audit artifacts</span>
            <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </p>
        </div>
      </div>

      {/* Domain Breakdown Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
              <Layers className="w-5 h-5 text-brand-400" />
              CMMC Level 1 Domain Breakdown
            </h3>
            <p className="text-xs text-slate-400">
              6 core domains governing Federal Contract Information (FCI) protection under FAR 52.204-21.
            </p>
          </div>
          <button
            onClick={() => setActiveTab('controls')}
            className="text-xs text-brand-400 hover:text-brand-300 font-semibold flex items-center gap-1"
          >
            <span>View All 17 Controls</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <DomainCards />
      </div>

      {/* Quick Starter Helper Callout */}
      {metrics.notStartedCount > 0 && (
        <div className="p-4 rounded-2xl bg-brand-950/30 border border-brand-800/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-brand-500/20 text-brand-300 shrink-0 mt-0.5">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-white">Need pre-built starter narratives?</h4>
              <p className="text-xs text-slate-400">
                Every control features built-in enterprise starter templates (Microsoft 365, Entra ID MFA, Defender EDR, BitLocker) ready for 1-click insertion.
              </p>
            </div>
          </div>
          <button
            onClick={loadDemoScenario}
            className="px-4 py-2 rounded-xl bg-brand-600/30 hover:bg-brand-600/50 text-brand-300 border border-brand-500/40 font-medium text-xs whitespace-nowrap transition-colors"
          >
            Load Compliant Demo Data
          </button>
        </div>
      )}
    </div>
  );
};
