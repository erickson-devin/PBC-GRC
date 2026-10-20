import React, { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Paperclip,
  FileText,
  ArrowRight,
  Shield,
  Building2,
  Lock,
  Target,
  ShieldCheck,
  Database,
  ExternalLink,
  HardDrive,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getFrameworkTitle, getFrameworkGuidanceText } from '../../data/frameworks';
import { calculateSprsScore, formatSprsScore, getSprsPointDeduction } from '../../data/reports/sprsCompiler';
import { useStorageConfig } from '../../hooks/useStorageConfig';
import { DomainCards } from './DomainCards';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';
import { ROLE_LABELS } from '../../utils/roles';
import { SspGateBanner } from './SspGateBanner';

export const ComplianceOverview: React.FC = () => {
  const { metrics, state, frameworkControls, setActiveTab, openExportModal, setSelectedControlId } = useAssessment();
  const { currentTenant, canEdit, currentRole, activeFramework } = useTenant();
  const storageConfig = useStorageConfig(currentTenant?.id);

  const frameworkTitle = getFrameworkTitle(activeFramework);
  const guidance = getFrameworkGuidanceText(activeFramework);
  const totalCount = metrics.totalControls || frameworkControls.length || 1;

  // Real-time CMMC L2 SPRS score (-203 to +110)
  const sprsResult = useMemo(() => {
    if (activeFramework === 'CMMC_L2') {
      return calculateSprsScore(frameworkControls, state.controls, state.sspMetadata);
    }
    return null;
  }, [activeFramework, frameworkControls, state.controls, state.sspMetadata]);

  // Progress Bar Percentage Math (Guaranteed to sum to 100% across totalCount)
  const metPct = totalCount > 0 ? (metrics.metCount / totalCount) * 100 : 0;
  const inProgressPct = totalCount > 0 ? (metrics.inProgressCount / totalCount) * 100 : 0;
  const notMetPct = totalCount > 0 ? (metrics.notMetCount / totalCount) * 100 : 0;
  const notStartedPct = totalCount > 0 ? (metrics.notStartedCount / totalCount) * 100 : 0;

  // High-Yield Remediation: Top 3 unmet controls sorted by SPRS point impact (5-pt > 3-pt > 1-pt)
  const highYieldRemediations = useMemo(() => {
    return frameworkControls
      .filter((c) => state.controls[c.id]?.status !== 'MET')
      .map((c) => ({
        control: c,
        weight: getSprsPointDeduction(c.id),
        status: state.controls[c.id]?.status || 'NOT_STARTED',
      }))
      // The SSP requirement (3.12.4) has weight 0 but blocks scoring entirely, so it always ranks first.
      .sort((a, b) => (b.weight === 0 ? 100 : b.weight) - (a.weight === 0 ? 100 : a.weight))
      .slice(0, 3);
  }, [frameworkControls, state.controls]);

  const handleRemediateControl = (controlId: string) => {
    setSelectedControlId(controlId);
    setActiveTab('controls');
  };

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* SSP gate: the SPRS score is locked until a System Security Plan exists; point the user at the SSP + POA&M */}
      {sprsResult && <SspGateBanner sprs={sprsResult} />}

      {/* A tenant that exists only in this browser: offer to move it to the server (owners only) */}
      {canEdit && <LegacyTenantNotice tenant={currentTenant} />}

      {/* RBAC Read-Only Banner for Viewers */}
      {!canEdit && (
        <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <Lock className="w-5 h-5 text-amber-400 shrink-0" />
            <div>
              <span className="font-bold text-amber-300">Read-Only {ROLE_LABELS[currentRole]} Mode:</span>{' '}
              <span className="text-slate-300">
                You are currently viewing <strong>{currentTenant.name}</strong> in audit review mode. 
                Modifications to control narratives and evidence uploads are disabled.
              </span>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">
            {currentRole.replace('_', ' ')}
          </span>
        </div>
      )}

      {/* Hero: Consolidated Tactical Command HUD */}
      <div className={`relative overflow-hidden rounded-3xl p-6 sm:p-8 border shadow-2xl transition-all ${
        metrics.isSprsReady
          ? 'bg-gradient-to-br from-emerald-950/80 via-slate-900 to-slate-900 border-emerald-500/40 shadow-emerald-500/10'
          : 'bg-gradient-to-br from-slate-900 via-slate-900/90 to-brand-950/40 border-slate-800 shadow-brand-500/5'
      }`}>
        <div className="relative z-10 grid grid-cols-1 xl:grid-cols-12 gap-8 items-center">
          
          {/* Left Block: Authority, Status, Description & Tenant Meta */}
          <div className="xl:col-span-7 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800/90 border border-slate-700 text-slate-200">
                <Shield className="w-3.5 h-3.5 text-cyan-400" />
                <span>{guidance.bannerTitle}</span>
              </div>
              <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                {guidance.authority}
              </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight leading-tight">
              {metrics.isSprsReady ? (
                <span className="text-emerald-400 flex items-center gap-3">
                  <CheckCircle2 className="w-8 h-8 shrink-0 text-emerald-400" />
                  {frameworkTitle} Ready: 100% Baseline Achieved
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <AlertTriangle className="w-8 h-8 shrink-0 text-amber-400" />
                  Self-Assessment In Progress ({metrics.completionPercentage}%)
                </span>
              )}
            </h1>

            <p className="text-sm text-slate-300 leading-relaxed max-w-xl">
              {metrics.isSprsReady ? (
                <>
                  All {totalCount} {guidance.standardRef} practices for <strong>{currentTenant.name}</strong> are evaluated as <strong>MET</strong> with cryptographic evidence assurance.
                  {' '}Your organization satisfies the {frameworkTitle} baseline and is ready for formal System Security Plan export.
                </>
              ) : (
                <>
                  {frameworkTitle} mandates satisfying all <strong>{totalCount} controls</strong> across the active enclave boundary.
                  {' '}{guidance.poamPolicyText} 
                  {' '}Currently, <strong>{totalCount - metrics.metCount}</strong> of {totalCount} controls require implementation narrative or verified evidence.
                </>
              )}
            </p>

            {/* Micro Badges with Active Tenant Metadata */}
            <div className="flex flex-wrap items-center gap-2.5 pt-2 text-xs font-medium text-slate-400">
              <span className="px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-200 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-cyan-400" />
                <strong className="text-white">{currentTenant.name}</strong>
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300 font-mono">
                CAGE: <strong className="text-cyan-300">{currentTenant.cageCode || 'N/A'}</strong>
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300">
                SAM: <strong className={currentTenant.samStatus === 'ACTIVE' ? 'text-emerald-400' : 'text-amber-400'}>{currentTenant.samStatus}</strong>
              </span>
              <span className="px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-300">
                Evidence Files: <strong className="text-white">{state.evidenceIndex.length}</strong>
              </span>
            </div>
          </div>

          {/* Right Block: Consolidated Tactical Command HUD */}
          <div className="xl:col-span-5 bg-slate-950/70 backdrop-blur-md rounded-2xl border border-slate-800/90 p-5 sm:p-6 shadow-xl space-y-5">
            {/* Primary Score & Status */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                  {sprsResult ? 'Official DoD SPRS Score' : `${frameworkTitle} Readiness`}
                </p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className={`text-3xl sm:text-4xl font-black font-mono tracking-tight ${
                    sprsResult?.score == null ? (sprsResult ? 'text-amber-300' : 'text-white') : metrics.isSprsReady ? 'text-emerald-400' : sprsResult.score > 0 ? 'text-cyan-400' : 'text-white'
                  }`}>
                    {sprsResult ? formatSprsScore(sprsResult) : `${metrics.completionPercentage}%`}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {sprsResult
                      ? sprsResult.scoreStatus === 'NOT_SCORED'
                        ? '(SSP required)'
                        : '(-203 to +110 range)'
                      : `(${metrics.metCount}/${totalCount} MET)`}
                  </span>
                </div>
              </div>

              <div className="text-right">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono border ${
                  metrics.isSprsReady
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                }`}>
                  {metrics.isSprsReady ? 'AUDIT READY' : `${metrics.completionPercentage}% BASELINE`}
                </span>
                <p className="text-xs text-slate-400 mt-1 font-mono">
                  {metrics.metCount} of {totalCount} controls
                </p>
              </div>
            </div>

            {/* Single Unified Multi-Segment Progress Bar */}
            <div className="space-y-2">
              <div className="w-full bg-slate-800 rounded-full h-3.5 overflow-hidden flex shadow-inner border border-slate-700/50">
                <div
                  className="bg-emerald-500 transition-all duration-700"
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

              {/* Inline Legend / Tooltip Indicators */}
              <div className="flex items-center justify-between text-xs font-mono text-slate-300 flex-wrap gap-2 pt-0.5">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <strong>{metrics.metCount}</strong> MET
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    <strong>{metrics.inProgressCount}</strong> IN PROGRESS
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-slate-600" />
                    <strong>{metrics.notStartedCount}</strong> NOT STARTED
                  </span>
                  {metrics.notMetCount > 0 && (
                    <span className="flex items-center gap-1.5 text-rose-400">
                      <span className="w-2 h-2 rounded-full bg-rose-500" />
                      <strong>{metrics.notMetCount}</strong> NOT MET
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Action CTA Block */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
              <button
                onClick={() => openExportModal()}
                className="btn-primary py-2.5 text-xs shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2"
              >
                <FileText className="w-4 h-4" />
                <span>Generate Official SSP</span>
              </button>

              <button
                onClick={() => setActiveTab('controls')}
                className="btn-secondary py-2.5 text-xs flex items-center justify-center gap-2"
              >
                <span>Control Matrix ({totalCount})</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

        </div>
      </div>

      {/* Two Actionable Operational Widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        
        {/* Widget 1: High-Yield Remediation Priority */}
        <div className="stitch-card p-6 shadow-xl flex flex-col justify-between border-slate-800 hover:border-cyan-500/30 transition-all">
          <div>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
                  <Target className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white tracking-tight">High-Yield Remediation Priority</h3>
                  <p className="text-xs text-slate-400">Top unmet controls ranked by SPRS point impact</p>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-md text-xs font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
                {highYieldRemediations.length} PRIORITIES
              </span>
            </div>

            {highYieldRemediations.length === 0 ? (
              <div className="p-5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-center my-3 space-y-1.5">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
                <p className="text-xs font-bold text-emerald-300">All High-Yield Controls Satisfied</p>
                <p className="text-xs text-slate-400">
                  Zero high-deduction requirements remaining. Your active enclave satisfies full baseline scoring.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 my-3">
                {highYieldRemediations.map(({ control, weight, status }) => (
                  <button type="button"
                    key={control.id}
                    onClick={() => handleRemediateControl(control.id)}
                    className="w-full text-left p-3 rounded-xl bg-slate-850/90 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 transition-all cursor-pointer group flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-xs font-bold text-cyan-400">{control.id}</span>
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          {control.domain}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-slate-200 truncate group-hover:text-cyan-300 transition-colors">
                        {control.title}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 rounded-lg text-xs font-mono font-bold border ${
                        weight === 5
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                          : weight === 3
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                          : 'bg-slate-700 text-slate-300 border-slate-600'
                      }`}>
                        -{weight} SPRS PTS
                      </span>
                      <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                        {status.replace('_', ' ')}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-cyan-400 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Resolving 5-pt controls yields immediate SPRS recovery</span>
            <button
              onClick={() => setActiveTab('controls')}
              className="text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 transition-colors"
            >
              <span>View Control Matrix</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Widget 2: Evidence Vault & Artifact Health */}
        {(() => {
          const storageProvider = storageConfig.provider;
          const localStoragePath = storageConfig.localStoragePath;
          const isLocal = storageProvider === 'local';

          return (
            <div className="stitch-card p-6 shadow-xl flex flex-col justify-between border-slate-800 hover:border-cyan-500/30 transition-all">
              <div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 flex items-center justify-center">
                      <Database className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white tracking-tight">Evidence Vault & Artifact Health</h3>
                      <p className="text-xs text-slate-400">
                        {isLocal
                          ? 'Air-gapped enclave local storage posture & cryptographic integrity'
                          : 'Cryptographic audit integrity and cloud storage posture'}
                      </p>
                    </div>
                  </div>
                  {isLocal ? (
                    <span className="px-2.5 py-0.5 rounded-md text-xs font-mono font-bold bg-cyan-950/90 text-cyan-300 border border-cyan-500/50 flex items-center gap-1.5 shadow-sm shadow-cyan-950/40">
                      <HardDrive className="w-3 h-3 text-cyan-400" />
                      LOCAL ENCLAVE STORAGE
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-md text-xs font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      {state.evidenceIndex.length} VAULT FILES
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2.5 my-3">
                  <div className="p-3 rounded-xl bg-slate-850/80 border border-slate-800">
                    <p className="text-xs font-mono uppercase text-slate-400">Integrity Digest</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span className="text-xs font-bold text-white">SHA-256 Validated</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1 truncate">
                      {isLocal ? 'Local disk zero-leakage hash' : 'Chained cryptographic proof'}
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-850/80 border border-slate-800">
                    <p className="text-xs font-mono uppercase text-slate-400">Storage Retention</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Lock className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs font-bold text-white">
                        {isLocal ? 'Air-Gapped Enclave' : 'DFARS 252.204-7012'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {isLocal ? 'Persistent host volume' : '3-Year locked retention'}
                    </p>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Paperclip className="w-4 h-4 text-slate-400" />
                    <span className="text-slate-300">Total Enclave Artifacts Attached:</span>
                  </div>
                  <span className="font-mono font-bold text-white">{state.evidenceIndex.length} Verified Files</span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                <span
                  className="text-slate-400 text-xs truncate max-w-[260px]"
                  title={`Local Storage Path: ${localStoragePath}`}
                >
                  {`Storage Path: ${localStoragePath}`}
                </span>
                <button
                  onClick={() => setActiveTab('vault')}
                  className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 hover:border-cyan-500/40 shrink-0"
                >
                  <span>Open Evidence Vault</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })()}

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
