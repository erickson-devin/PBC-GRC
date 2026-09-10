import React, { useState } from 'react';
import { 
  Building, 
  CheckCircle2, 
  AlertTriangle, 
  Lock, 
  FileText, 
  ShieldCheck, 
  Sparkles, 
  ArrowRight,
  Download,
  Fingerprint,
  ExternalLink,
} from 'lucide-react';
import { CMMC_LEVEL_1_CONTROLS } from '../../data/cmmcLevel1Controls';

interface InteractiveSandboxProps {
  onLaunchFullApp: (tenantId?: string) => void;
  onRequestLicense?: () => void;
}

export const InteractiveSandbox: React.FC<InteractiveSandboxProps> = ({ onLaunchFullApp, onRequestLicense }) => {
  const [selectedScenario, setSelectedScenario] = useState<'vanguard' | 'apex'>('vanguard');
  const [activeSandboxTab, setActiveSandboxTab] = useState<'matrix' | 'ssp' | 'evidence'>('matrix');

  // Scenario 1: Vanguard Defense Systems (100% Compliant)
  const isVanguard = selectedScenario === 'vanguard';

  const currentOrg = isVanguard ? {
    id: 'tenant-vanguard-01',
    name: 'Vanguard Defense Systems LLC',
    cageCode: '8K3R1',
    systemName: 'Defense Contracting Information Network (DCIN)',
    metCount: 17,
    inProgressCount: 0,
    sprsPercentage: 100,
    evidenceCount: 12,
    statusText: '100% Compliant • Audit Ready',
  } : {
    id: 'tenant-apex-02',
    name: 'Apex Aerospace Enclave',
    cageCode: '9X7B4',
    systemName: 'Corporate Operations Enclave (COE)',
    metCount: 10,
    inProgressCount: 7,
    sprsPercentage: 59,
    evidenceCount: 6,
    statusText: 'In Progress • 7 Actions Remaining',
  };

  return (
    <section id="sandbox-demo" className="py-24 bg-slate-950/60 border-y border-slate-900 relative">
      
      {/* Background radial highlight */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[500px] bg-brand-500/5 rounded-full blur-[150px] pointer-events-none -z-10" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-semibold text-brand-300">
            <Sparkles className="w-3.5 h-3.5 text-brand-400" />
            1-Click Interactive Test Drive
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Explore the Live Compliance Sandbox
          </h2>
          <p className="text-base sm:text-lg text-slate-300">
            Toggle between defense contractor scenarios below to test real-time SPRS calculations, control statuses, and automated SSP generation.
          </p>
        </div>

        {/* Sandbox Container with Double Bezel */}
        <div className="p-2 sm:p-3 rounded-[2.5rem] bg-gradient-to-b from-slate-700/30 via-slate-800/20 to-slate-900/40 ring-1 ring-white/10 shadow-2xl backdrop-blur-2xl">
          <div className="rounded-[calc(2.5rem-0.75rem)] bg-slate-950 border border-slate-800/90 overflow-hidden shadow-2xl">
            
            {/* Top Toolbar: Scenario Switcher + Status Bar */}
            <div className="p-4 sm:p-6 bg-slate-900/90 border-b border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              
              {/* Left: Organization Toggle Pills */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 mr-1">
                  Active Scenario:
                </span>
                <button
                  onClick={() => setSelectedScenario('vanguard')}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                    isVanguard 
                      ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/25 ring-1 ring-white/20' 
                      : 'bg-slate-850 text-slate-300 hover:bg-slate-800 border border-slate-700/80'
                  }`}
                >
                  <Building className="w-3.5 h-3.5" />
                  <span>Vanguard Defense (100% MET)</span>
                  <span className="px-1.5 py-0.2 rounded bg-emerald-500/30 text-emerald-200 text-[10px]">17/17</span>
                </button>

                <button
                  onClick={() => setSelectedScenario('apex')}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                    !isVanguard 
                      ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/25 ring-1 ring-white/20' 
                      : 'bg-slate-850 text-slate-300 hover:bg-slate-800 border border-slate-700/80'
                  }`}
                >
                  <Building className="w-3.5 h-3.5" />
                  <span>Apex Aerospace (59% MET)</span>
                  <span className="px-1.5 py-0.2 rounded bg-amber-500/30 text-amber-200 text-[10px]">10/17</span>
                </button>
              </div>

              {/* Right: SPRS Metric Badge & Launch CTA */}
              <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800">
                  <Lock className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-xs text-slate-300 font-medium">SPRS:</span>
                  <span className={`text-xs font-extrabold ${isVanguard ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {currentOrg.metCount} / 17 ({currentOrg.sprsPercentage}%)
                  </span>
                </div>

                <button
                  onClick={() => onLaunchFullApp(currentOrg.id)}
                  className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  title="Open assessment platform in full-screen enclave mode"
                >
                  <span>Open Full Screen</span>
                  <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
                </button>
              </div>

            </div>

            {/* Sandbox Navigation Tabs */}
            <div className="px-4 sm:px-6 pt-3 bg-slate-900/50 border-b border-slate-800 flex items-center gap-4">
              <button
                onClick={() => setActiveSandboxTab('matrix')}
                className={`pb-3 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 border-b-2 transition-colors ${
                  activeSandboxTab === 'matrix'
                    ? 'border-brand-500 text-brand-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                17-Control Matrix Preview
              </button>
              <button
                onClick={() => setActiveSandboxTab('ssp')}
                className={`pb-3 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 border-b-2 transition-colors ${
                  activeSandboxTab === 'ssp'
                    ? 'border-brand-500 text-brand-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                System Security Plan (SSP)
              </button>
              <button
                onClick={() => setActiveSandboxTab('evidence')}
                className={`pb-3 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 border-b-2 transition-colors ${
                  activeSandboxTab === 'evidence'
                    ? 'border-brand-500 text-brand-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Fingerprint className="w-3.5 h-3.5" />
                GCS Evidence Enclave
              </button>
            </div>

            {/* Tab Body Content */}
            <div className="p-4 sm:p-6 max-h-[480px] overflow-y-auto">
              
              {/* TAB 1: 17 Controls List */}
              {activeSandboxTab === 'matrix' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-400 pb-2 border-b border-slate-800/80 font-medium">
                    <span>CMMC Level 1 Security Requirements (FAR 52.204-21)</span>
                    <span>17 Total Controls</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {CMMC_LEVEL_1_CONTROLS.slice(0, 10).map((ctrl, index) => {
                      const isMet = isVanguard ? true : index < 6;
                      return (
                        <div 
                          key={ctrl.id}
                          className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800/90 flex items-start justify-between gap-3 hover:border-slate-700 transition-colors"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-brand-400">{ctrl.id}</span>
                              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                                {ctrl.domain}
                              </span>
                            </div>
                            <h4 className="text-xs font-semibold text-slate-200 line-clamp-1">{ctrl.title}</h4>
                            <p className="text-[11px] text-slate-400 line-clamp-1">{ctrl.plainEnglishSummary}</p>
                          </div>

                          <div className="shrink-0">
                            {isMet ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                <CheckCircle2 className="w-3 h-3" />
                                MET
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                <AlertTriangle className="w-3 h-3" />
                                IN PROGRESS
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="pt-2 text-center">
                    <button
                      onClick={() => onLaunchFullApp(currentOrg.id)}
                      className="text-xs font-semibold text-brand-400 hover:text-brand-300 inline-flex items-center gap-1"
                    >
                      <span>View all 17 controls with interactive evidence attachments</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 2: Live SSP Document Preview */}
              {activeSandboxTab === 'ssp' && (
                <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 font-mono text-xs text-slate-300 space-y-4">
                  <div className="pb-3 border-b border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="font-bold text-white text-sm">SYSTEM SECURITY PLAN (SSP)</div>
                      <div className="text-slate-400 text-[11px]">CMMC Level 1 / FAR 52.204-21 Compliant Enclave</div>
                    </div>
                    <button 
                      onClick={() => onLaunchFullApp(currentOrg.id)}
                      className="px-3 py-1 rounded bg-brand-500 text-white text-xs font-sans font-semibold flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export SSP Document
                    </button>
                  </div>

                  <div className="space-y-2 text-[11px] leading-relaxed">
                    <p><strong className="text-brand-400">ORGANIZATION:</strong> {currentOrg.name}</p>
                    <p><strong className="text-brand-400">CAGE CODE:</strong> {currentOrg.cageCode} | <strong className="text-brand-400">STATUS:</strong> Active (SAM.gov)</p>
                    <p><strong className="text-brand-400">SYSTEM BOUNDARY:</strong> {currentOrg.systemName} encompasses Microsoft 365 GCC/Commercial, Google Cloud Storage Evidence Enclave, and corporate endpoints.</p>
                    <p><strong className="text-brand-400">GCS VAULT:</strong> gs://pbc-grc-evidence-prod/tenants/{currentOrg.id}/</p>
                    
                    <div className="pt-3 border-t border-slate-800">
                      <div className="text-slate-200 font-bold mb-2">CONTROL AC.1.001 - AUTHORIZED ACCESS CONTROL</div>
                      <p className="text-slate-400">
                        {isVanguard 
                          ? 'All corporate and system access requires individual authenticated accounts configured with least privilege in Microsoft Entra ID. Remote access is governed by conditional access policies with FIDO2 / Duo Security MFA.' 
                          : 'Standard username/password accounts configured. MFA rollout in progress for remote access gateways.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: Evidence Enclave */}
              {activeSandboxTab === 'evidence' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-400 pb-2 border-b border-slate-800/80">
                    <span>Google Cloud Storage Bucket: <code className="text-brand-400">gs://pbc-grc-evidence-prod</code></span>
                    <span>Client-Side SHA-256 Validated</span>
                  </div>

                  <div className="space-y-2">
                    {[
                      { name: 'AC.1.001_M365_RBAC_Assignment_Report.pdf', size: '245 KB', hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', date: '2026-08-30' },
                      { name: 'IA.1.076_Duo_Security_MFA_Enforcement_Audit.png', size: '1.2 MB', hash: '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069', date: '2026-08-28' },
                      { name: 'PE.1.131_Badge_Access_Physical_Facility_Log.json', size: '84 KB', hash: 'c5b8b981657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d942', date: '2026-08-25' },
                    ].map((item, i) => (
                      <div key={i} className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between gap-3">
                        <div className="space-y-1 truncate">
                          <div className="flex items-center gap-2 text-xs font-semibold text-white truncate">
                            <Lock className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                            <span className="truncate">{item.name}</span>
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 flex items-center gap-2">
                            <span>{item.size}</span>
                            <span>•</span>
                            <span className="text-purple-400">SHA-256: {item.hash.substring(0, 16)}...</span>
                          </div>
                        </div>

                        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 shrink-0">
                          GCS Verified
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>

            {/* Bottom Callout Bar */}
            <div className="p-4 bg-gradient-to-r from-slate-900 to-slate-950 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Ready to conduct your organization's official CMMC assessment?</span>
              </div>
              <button
                onClick={onRequestLicense ? onRequestLicense : () => onLaunchFullApp(currentOrg.id)}
                className="btn-primary w-full sm:w-auto px-5 py-2 text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                <span>Request Enclave License & Schedule Call</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

          </div>
        </div>

      </div>
    </section>
  );
};
