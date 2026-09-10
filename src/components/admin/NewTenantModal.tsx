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
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { Tenant, TenantInvitation } from '../../types/tenant';

interface NewTenantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTenantCreated?: (tenant: Tenant, invitation: TenantInvitation, inviteUrl: string) => void;
}

export const NewTenantModal: React.FC<NewTenantModalProps> = ({
  isOpen,
  onClose,
  onTenantCreated,
}) => {
  const { provisionTenant } = useTenant();

  const [companyName, setCompanyName] = useState('');
  const [cageCode, setCageCode] = useState('');
  const [systemBoundaryName, setSystemBoundaryName] = useState('');
  const [licenseTier, setLicenseTier] = useState<'single-org' | 'msp-assessor'>('single-org');
  const [tenantOwnerEmail, setTenantOwnerEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
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
    setLicenseTier('single-org');
    setTenantOwnerEmail('');
    setCreatedResult(null);
    setCopiedLink(false);
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() || !tenantOwnerEmail.trim()) return;

    setIsSubmitting(true);
    try {
      const result = await provisionTenant({
        companyName: companyName.trim(),
        cageCode: cageCode.trim().toUpperCase() || 'PENDING',
        systemBoundaryName: systemBoundaryName.trim() || `${companyName.trim()} Operations Enclave`,
        licenseTier,
        tenantOwnerEmail: tenantOwnerEmail.trim().toLowerCase(),
      });

      setCreatedResult(result);
      if (onTenantCreated) {
        onTenantCreated(result.tenant, result.invitation, result.inviteUrl);
      }
    } catch (err) {
      console.error('Failed to provision tenant:', err);
      alert('Failed to provision tenant enclave. Please check parameters and try again.');
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
                    {createdResult.tenant.licenseTier === 'msp-assessor' ? 'MSP / Assessor (Multi-Enclave)' : 'Single Org ($1,000/yr)'}
                  </span>
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
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-1">
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
                  <Building2 className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
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
                    onChange={e => setLicenseTier(e.target.value as 'single-org' | 'msp-assessor')}
                    className="w-full px-3.5 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-brand-500 transition-colors"
                  >
                    <option value="single-org">Single Org Defense Enclave ($1,000/yr)</option>
                    <option value="msp-assessor">MSP / Assessor Multi-Tenant</option>
                  </select>
                </div>
              </div>

              {/* System Boundary Name */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  System Boundary Name (SSP Title)
                </label>
                <div className="relative">
                  <Layers className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="e.g. Corporate Operations Enclave (COE)"
                    value={systemBoundaryName}
                    onChange={e => setSystemBoundaryName(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Tenant Owner Email */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-300 mb-1.5">
                  Tenant Owner Email (Designated Lead) <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    placeholder="e.g. ciso@apexdefense.us"
                    value={tenantOwnerEmail}
                    onChange={e => setTenantOwnerEmail(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-500 font-mono focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
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
