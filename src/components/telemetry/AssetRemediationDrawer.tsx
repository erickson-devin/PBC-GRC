import React, { useState } from 'react';
import {
  X,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Terminal,
  Monitor,
  Zap,
  Play,
  RotateCcw,
  Info,
} from 'lucide-react';
import { FailingAssetInfo } from '../../types/telemetry';
import { ControlDefinition } from '../../types/cmmc';
import { FrameworkControlDefinition } from '../../types/framework';
import { remediateAssetRule } from '../../data/telemetry/assetTelemetryEngine';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';

interface AssetRemediationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  control: ControlDefinition | FrameworkControlDefinition | any;
  failingAssets: FailingAssetInfo[];
  totalEndpoints?: number;
  onRemediated?: () => void;
}

export const AssetRemediationDrawer: React.FC<AssetRemediationDrawerProps> = ({
  isOpen,
  onClose,
  control,
  failingAssets,
  totalEndpoints = 4,
  onRemediated,
}) => {
  const { currentTenant } = useTenant();
  const { refreshBoundaryTelemetry } = useAssessment();
  const [copiedRuleId, setCopiedRuleId] = useState<string | null>(null);
  const [remediatingAssetId, setRemediatingAssetId] = useState<string | null>(null);
  const [remediatedSuccess, setRemediatedSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

  const failingCount = failingAssets.length;
  const passingCount = Math.max(0, totalEndpoints - failingCount);

  const handleCopyScript = (scriptText: string, ruleId: string) => {
    navigator.clipboard.writeText(scriptText);
    setCopiedRuleId(ruleId);
    setTimeout(() => setCopiedRuleId(null), 2500);
  };

  const handlePushRemediation = async (asset: FailingAssetInfo) => {
    const assetId = asset.assetId;
    if (!assetId) return;

    setRemediatingAssetId(assetId);
    try {
      await remediateAssetRule(currentTenant.id, assetId, asset.failedRule);
      if (refreshBoundaryTelemetry) {
        await refreshBoundaryTelemetry();
      }
      setRemediatedSuccess(asset.hostName);
      setTimeout(() => setRemediatedSuccess(null), 4000);
      if (onRemediated) {
        onRemediated();
      }
    } catch (err) {
      console.error('Error applying remediation:', err);
    } finally {
      setRemediatingAssetId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      {/* Drawer Overlay Backdrop */}
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />

      {/* Slide-in Panel */}
      <div className="relative w-full max-w-2xl h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col z-10 overflow-hidden text-slate-100">
        
        {/* Drawer Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-950/80 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold px-2.5 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/30">
                {control.id}
              </span>
              <span className="px-2 py-0.5 rounded text-xs font-bold font-mono bg-rose-950/60 text-rose-300 border border-rose-500/30">
                BOUNDARY: NOT_MET
              </span>
            </div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <span>Asset Health & Root-Cause Remediation Drawer</span>
            </h2>
            <p className="text-xs text-slate-400">
              {control.title}
            </p>
          </div>

          <button aria-label="Close"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tactical Banner */}
        <div className="bg-gradient-to-r from-rose-950/50 via-amber-950/30 to-slate-950 border-b border-rose-500/30 px-5 py-3 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2.5 text-rose-300 font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              ⚠️ {failingCount} of {totalEndpoints} Endpoints Non-Compliant — Worst-Case Boundary Rollup Enforced
            </span>
          </div>
          <span className="font-mono text-xs text-slate-400 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800">
            DoD SCAP Policy
          </span>
        </div>

        {/* Remediation Success Toast */}
        {remediatedSuccess && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              ✓ Remediation pushed to <strong>{remediatedSuccess}</strong>! STIG rule verified as PASS. Boundary compliance recalculating...
            </span>
          </div>
        )}

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          
          {/* Plain English Impact Context */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
              <Info className="w-4 h-4 text-cyan-400" />
              <span>Boundary Enforcement Explanation</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Under DoD CMMC 2.0 and NIST SP 800-171, security controls apply across the entirety of the assessment boundary.
              If any endpoint in the enclave fails automated DISA STIG baselines, the parent requirement is flagged as non-compliant.
            </p>
          </div>

          {/* Non-Compliant Endpoints List */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold tracking-wider text-slate-400 uppercase flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span>Non-Compliant Endpoints ({failingCount})</span>
            </h3>

            {failingAssets.map((asset, idx) => {
              const ruleId = asset.failedRule;
              const fix = asset.fixScript || `sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && systemctl reload sshd`;
              const isCopied = copiedRuleId === ruleId;
              const isRemediating = remediatingAssetId === asset.assetId;

              return (
                <div
                  key={idx}
                  className="rounded-2xl border border-rose-500/30 bg-slate-950/80 p-4 space-y-4 shadow-lg"
                >
                  {/* Endpoint Header */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-xl bg-rose-500/15 border border-rose-500/30">
                        <Monitor className="w-4 h-4 text-rose-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-white text-sm">
                            {asset.hostName}
                          </span>
                          <span className="px-2 py-0.5 rounded text-xs font-mono bg-slate-800 text-slate-300 border border-slate-700">
                            {asset.ipAddress}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          OS: {asset.osProfile || 'Linux'} • Evaluated via OpenSCAP
                        </p>
                      </div>
                    </div>

                    <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                      {asset.severity || 'CAT_I'} • HIGH RISK
                    </span>
                  </div>

                  {/* Failing Rule Details */}
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between text-slate-400">
                      <span className="font-semibold text-slate-300">Failing STIG Rule:</span>
                      <span className="font-mono text-cyan-400">{asset.failedRule}</span>
                    </div>
                    {asset.ruleTitle && (
                      <p className="text-slate-300 font-medium">{asset.ruleTitle}</p>
                    )}
                  </div>

                  {/* Raw Scanner STDOUT Error Block */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                      <Terminal className="w-3 h-3 text-rose-400" />
                      <span>Scanner Diagnostic Output (stdout)</span>
                    </label>
                    <div className="p-3 rounded-xl bg-slate-900 border border-rose-900/40 font-mono text-xs text-rose-300 leading-relaxed overflow-x-auto">
                      {asset.stdout || 'FAIL: Root access allowed over SSH network socket.'}
                    </div>
                  </div>

                  {/* Remediation Script Section */}
                  <div className="space-y-2 pt-1 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                        <span>Remediation Command (Blake's Scanner Agent)</span>
                      </span>
                      <button
                        onClick={() => handleCopyScript(fix, ruleId)}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs font-medium transition-colors flex items-center gap-1.5"
                      >
                        {isCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400 font-bold">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy Remediation Script</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 font-mono text-xs text-amber-300/90 overflow-x-auto select-all">
                      <code>{fix}</code>
                    </div>

                    {/* Instant Push Action */}
                    <div className="pt-2 flex justify-end">
                      <button
                        onClick={() => handlePushRemediation(asset)}
                        disabled={isRemediating}
                        className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
                      >
                        {isRemediating ? (
                          <>
                            <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                            <span>Pushing Fix via Agent...</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            <span>Push Fix Script via Blake's Agent</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Passing Endpoints Summary */}
          {passingCount > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Compliant Enclave Endpoints</span>
                </span>
                <span className="font-mono text-emerald-400 font-bold">
                  {passingCount} of {totalEndpoints} Passing
                </span>
              </div>
              <p className="text-xs text-slate-400">
                All other registered endpoints in this boundary meet the technical hardening baselines for this practice.
              </p>
            </div>
          )}

        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs">
          <span className="text-slate-400">
            Automated STIG Remediation Engine • Event Horizon
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold transition-colors"
          >
            Close Drawer
          </button>
        </div>

      </div>
    </div>
  );
};
