import React, { useState } from 'react';
import {
  X,
  Building2,
  Mail,
  ShieldCheck,
  Sparkles,
  Copy,
  Check,
  ExternalLink,
  Send,
  Layers,
  Receipt,
  Lock,
  Shield,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { Tenant, TenantInvitation, LicenseTier, getLicenseTierBadge } from '../../types/tenant';
import { ComplianceFramework } from '../../types/framework';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';
import { ErrorNotice } from '../common/ErrorNotice';
import { errorMessage } from '../../utils/errors';

interface NewTenantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTenantCreated?: (tenant: Tenant, invitation: TenantInvitation, inviteUrl: string) => void;
}

const ALL_FRAMEWORKS: { id: ComplianceFramework; label: string; shortName: string; authority: string }[] = [
  { id: 'CMMC_L1', label: 'CMMC 2.0 Level 1 (Foundational)', shortName: 'CMMC Level 1', authority: `FAR 52.204-21 • ${FRAMEWORK_REGISTRY.CMMC_L1.totalControls} Controls` },
  { id: 'CMMC_L2', label: 'CMMC 2.0 Level 2 (Advanced)', shortName: 'CMMC Level 2', authority: `DFARS 252.204-7012 • ${FRAMEWORK_REGISTRY.CMMC_L2.totalControls} Controls` },
  { id: 'NIST_800_53_REV5', label: 'NIST SP 800-53 Rev 5', shortName: 'NIST SP 800-53', authority: 'Federal Low/Mod Baselines' },
  { id: 'SOC_2_TYPE_II', label: 'AICPA SOC 2 Type II', shortName: 'SOC 2 Type II', authority: 'Trust Services Criteria (CC1–CC9)' },
  { id: 'HIPAA_SECURITY', label: 'HIPAA Security Rule', shortName: 'HIPAA Security', authority: '45 CFR Part 164 Subpart C' },
];

export const NewTenantModal: React.FC<NewTenantModalProps> = ({
  isOpen,
  onClose,
  onTenantCreated,
}) => {
  const { provisionTenant } = useTenant();

  const [companyName, setCompanyName] = useState('');
  const [cageCode, setCageCode] = useState('');
  const [systemBoundaryName, setSystemBoundaryName] = useState('');
  const [licenseTier, setLicenseTier] = useState<LicenseTier>('DEFENSE_PRO');
  const [tenantOwnerEmail, setTenantOwnerEmail] = useState('');
  const [primaryFramework, setPrimaryFramework] = useState<ComplianceFramework>('CMMC_L1');
  const [enabledFrameworks, setEnabledFrameworks] = useState<ComplianceFramework[]>(['CMMC_L1']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Success result state
  const [createdResult, setCreatedResult] = useState<{
    tenant: Tenant;
    invitation: TenantInvitation;
    inviteUrl: string;
  } | null>(null);

  if (!isOpen) return null;

  const handleReset = () => {
    setCompanyName('');
    setCageCode('');
    setSystemBoundaryName('');
    setLicenseTier('DEFENSE_PRO');
    setTenantOwnerEmail('');
    setPrimaryFramework('CMMC_L1');
    setEnabledFrameworks(['CMMC_L1']);
    setCreatedResult(null);
    setSubmitError(null);
    setCopiedLink(false);
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  const handlePrimaryFrameworkChange = (fw: ComplianceFramework) => {
    setPrimaryFramework(fw);
    if (!enabledFrameworks.includes(fw)) {
      setEnabledFrameworks([...enabledFrameworks, fw]);
    }
  };

  const handleToggleFramework = (fw: ComplianceFramework) => {
    if (fw === primaryFramework) return;
    if (enabledFrameworks.includes(fw)) {
      setEnabledFrameworks(enabledFrameworks.filter(f => f !== fw));
    } else {
      setEnabledFrameworks([...enabledFrameworks, fw]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() || !tenantOwnerEmail.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await provisionTenant({
        companyName: companyName.trim(),
        cageCode: cageCode.trim().toUpperCase() || 'PENDING',
        systemBoundaryName: systemBoundaryName.trim() || `${companyName.trim()} Operations Enclave`,
        licenseTier,
        tenantOwnerEmail: tenantOwnerEmail.trim().toLowerCase(),
        primaryFramework,
        enabledFrameworks,
      });

      setCreatedResult(result);
      if (onTenantCreated) {
        onTenantCreated(result.tenant, result.invitation, result.inviteUrl);
      }
    } catch (err: unknown) {
      // ApiError messages are written for users: expired session (401), no permission (403), invalid input (400),
      // server trouble, or no connection.
      console.error('Failed to provision tenant:', err);
      setSubmitError(errorMessage(err) || 'Failed to provision the tenant enclave. Please check the details and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!createdResult?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(createdResult.inviteUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn">
      {/* Double-Bezel Architecture */}
      <div className="w-full max-w-xl p-1.5 rounded-[2.25rem] bg-gradient-to-b from-brand-500/25 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
        <div className="p-5 sm:p-7 rounded-[calc(2.25rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 flex flex-col max-h-[calc(94vh-0.75rem)] overflow-y-auto">
          
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30">
                    SUPER ADMIN CONSOLE
                  </span>
                </div>
                <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight mt-0.5">
                  {createdResult ? 'Tenant Enclave Provisioned' : 'Provision New Defense Tenant'}
                </h2>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="w-8 h-8 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Success View */}
          {createdResult ? (
            <div className="mt-5 space-y-5 animate-fadeIn">
              <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-left space-y-2">
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                  <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                  <span>Enclave Successfully Isolated & Provisioned!</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Cryptographic enclave <strong className="text-white">{createdResult.tenant.name}</strong> has been initialized with independent Cloud SQL RLS and GCS evidence partition.
                </p>
              </div>

              {/* Enclave Summary Card */}
              <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2.5 text-xs">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400 font-medium">
                  <span>Enclave ID:</span>
                  <span className="font-mono text-brand-300 font-bold">{createdResult.tenant.id}</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400 font-medium">
                  <span>Primary CAGE Code:</span>
                  <span className="font-mono text-white font-semibold">{createdResult.tenant.cageCode || 'PENDING'}</span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400 font-medium">
                  <span>License Tier:</span>
                  <span className="font-bold text-amber-300 uppercase">
                    {getLicenseTierBadge(createdResult.tenant.licenseTier).badge}
                  </span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400 font-medium">
                  <span>Primary Framework:</span>
                  <span className="font-bold text-brand-300">
                    {createdResult.tenant.primaryFramework || 'CMMC_L1'}
                  </span>
                </div>
                <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-slate-400 font-medium">
                  <span>Enabled Modules:</span>
                  <div className="flex flex-wrap gap-1 justify-end max-w-[65%]">
                    {(createdResult.tenant.enabledFrameworks || [createdResult.tenant.primaryFramework || 'CMMC_L1']).map(fw => (
                      <span key={fw} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-800 text-slate-200 border border-slate-700">
                        {fw}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between text-slate-400 font-medium">
                  <span>Designated Owner:</span>
                  <span className="text-white font-mono">{createdResult.invitation.email}</span>
                </div>
              </div>

              {/* Secure Token Onboarding Invite Link */}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                  Onboarding Claim Link (Valid for 14 Days)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={createdResult.inviteUrl}
                    className="w-full px-3.5 py-2.5 text-xs bg-slate-950 border border-brand-500/40 rounded-xl text-slate-200 font-mono select-all focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    onClick={handleCopyInviteLink}
                    className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition-all shrink-0 shadow-lg ${
                      copiedLink
                        ? 'bg-emerald-600 text-white shadow-emerald-500/25'
                        : 'bg-brand-600 hover:bg-brand-500 text-white shadow-brand-500/25'
                    }`}
                  >
                    {copiedLink ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-1">
                  <Lock className="w-3 h-3 text-slate-400" />
                  Token: <span className="font-mono text-slate-400">{createdResult.invitation.token.slice(0, 18)}...</span> (Single-use SHA-256 bound)
                </p>
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    window.open(createdResult.inviteUrl, '_blank');
                  }}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-semibold border border-slate-700 flex items-center justify-center gap-2 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Test Open Claim Page</span>
                </button>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                  >
                    Provision Another
                  </button>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="w-full sm:w-auto px-5 py-2 text-xs font-bold text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Provisioning Form */
            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              {/* Company Name */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Company Legal Entity Name <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Building2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="e.g. Apex Defense Solutions, LLC"
                    value={companyName}
                    onChange={e => {
                      setCompanyName(e.target.value);
                      if (!systemBoundaryName) {
                        setSystemBoundaryName(`${e.target.value} Corporate Operations Boundary`);
                      }
                    }}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Grid: Primary CAGE Code & License Tier */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                    Primary CAGE Code
                  </label>
                  <input
                    type="text"
                    maxLength={5}
                    placeholder="e.g. 9X7B4 (or PENDING)"
                    value={cageCode}
                    onChange={e => setCageCode(e.target.value.toUpperCase())}
                    className="w-full px-3.5 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 font-mono focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                    License Tier <span className="text-rose-400">*</span>
                  </label>
                  <select
                    value={licenseTier}
                    onChange={e => setLicenseTier(e.target.value as LicenseTier)}
                    className="w-full px-3.5 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-brand-500 transition-colors"
                  >
                    <option value="FOUNDATIONAL">Foundational Enclave ($3,500/yr)</option>
                    <option value="DEFENSE_PRO">Defense Professional ($7,000/yr) - Recommended</option>
                    <option value="ENTERPRISE">Enterprise & Assessor Enclave ($14,000/yr)</option>
                  </select>
                </div>
              </div>

              {/* System Boundary Name */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  System Boundary Name (SSP Title)
                </label>
                <div className="relative">
                  <Layers className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="e.g. Corporate Operations Enclave (COE)"
                    value={systemBoundaryName}
                    onChange={e => setSystemBoundaryName(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Target Framework Scope */}
              <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800/90 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-brand-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      Target Framework Scope
                    </span>
                  </div>
                  <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700/60">
                    {enabledFrameworks.length} Active Module{enabledFrameworks.length > 1 ? 's' : ''}
                  </span>
                </div>

                {/* Primary Framework Selector */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Primary Baseline Framework <span className="text-rose-400">*</span>
                  </label>
                  <select
                    value={primaryFramework}
                    onChange={e => handlePrimaryFrameworkChange(e.target.value as ComplianceFramework)}
                    className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-700/80 rounded-xl text-white focus:outline-none focus:border-brand-500 transition-colors"
                  >
                    {ALL_FRAMEWORKS.map(fw => (
                      <option key={fw.id} value={fw.id}>
                        {fw.label} ({fw.authority})
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Default compliance baseline loaded upon enclave activation.
                  </p>
                </div>

                {/* Additional Active Frameworks */}
                <div className="space-y-1.5 pt-1 border-t border-slate-800/60">
                  <label className="block text-[11px] font-semibold text-slate-400">
                    Additional Active Enclave Frameworks
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                    {ALL_FRAMEWORKS.map(fw => {
                      const isPrimary = fw.id === primaryFramework;
                      const isChecked = enabledFrameworks.includes(fw.id);
                      return (
                        <label
                          key={fw.id}
                          className={`flex items-start gap-2.5 p-2 rounded-xl border text-xs cursor-pointer transition-all select-none ${
                            isPrimary
                              ? 'bg-brand-500/10 border-brand-500/40 text-brand-200'
                              : isChecked
                              ? 'bg-slate-800/80 border-slate-600 text-slate-200'
                              : 'bg-slate-950/50 border-slate-800/80 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isPrimary}
                            onChange={() => handleToggleFramework(fw.id)}
                            className="mt-0.5 rounded border-slate-700 text-brand-500 focus:ring-0 focus:ring-offset-0 bg-slate-900 cursor-pointer disabled:cursor-not-allowed"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 font-semibold text-[11px] leading-tight">
                              <span className="truncate">{fw.shortName}</span>
                              {isPrimary && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/30 text-brand-300 font-mono shrink-0">
                                  PRIMARY
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-400 truncate mt-0.5">
                              {fw.authority}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Tenant Owner Email */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Tenant Owner Email (Designated Lead) <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    placeholder="e.g. ciso@apexdefense.us"
                    value={tenantOwnerEmail}
                    onChange={e => setTenantOwnerEmail(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 font-mono focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  A secure single-use onboarding claim link will be created for this email address with <strong className="text-slate-300">TENANT_OWNER</strong> privileges.
                </p>
              </div>

              {/* Internal Finance Pipeline Pill */}
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Receipt className="w-3.5 h-3.5 text-cyan-400" />
                  Internal Finance Pipeline:
                </span>
                <span className="font-mono text-cyan-300 font-semibold">
                  Manual License Provisioning
                </span>
              </div>

              <ErrorNotice message={submitError} />

              {/* Form Buttons */}
              <div className="pt-3 border-t border-slate-800/80 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !companyName.trim() || !tenantOwnerEmail.trim()}
                  className="px-6 py-2.5 text-xs font-bold text-white bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 rounded-xl shadow-lg shadow-brand-500/25 flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Provisioning Enclave...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Create & Generate Invite Link</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

        </div>
      </div>
    </div>
  );
};
