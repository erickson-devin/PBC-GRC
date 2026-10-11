import React, { useState, useEffect } from 'react';
import {
  X,
  Building2,
  Mail,
  Shield,
  Layers,
  Sparkles,
  Check,
  CheckCircle2,
  Award,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { Tenant, CommercialLicenseTier, normalizeLicenseTier } from '../../types/tenant';
import { ComplianceFramework } from '../../types/framework';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';

interface EditEnclaveModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: Tenant | null;
  onSaved?: (updated: Tenant) => void;
}

const ALL_FRAMEWORKS: { id: ComplianceFramework; label: string; shortName: string; authority: string }[] = [
  { id: 'CMMC_L1', label: 'CMMC 2.0 Level 1 (Foundational)', shortName: 'CMMC Level 1', authority: `FAR 52.204-21 • ${FRAMEWORK_REGISTRY.CMMC_L1.totalControls} Controls` },
  { id: 'CMMC_L2', label: 'CMMC 2.0 Level 2 (Advanced)', shortName: 'CMMC Level 2', authority: `DFARS 252.204-7012 • ${FRAMEWORK_REGISTRY.CMMC_L2.totalControls} Controls` },
  { id: 'NIST_800_53_REV5', label: 'NIST SP 800-53 Rev 5', shortName: 'NIST SP 800-53', authority: 'Federal Low/Mod Baselines' },
  { id: 'SOC_2_TYPE_II', label: 'AICPA SOC 2 Type II', shortName: 'SOC 2 Type II', authority: 'Trust Services Criteria (CC1–CC9)' },
  { id: 'HIPAA_SECURITY', label: 'HIPAA Security Rule', shortName: 'HIPAA Security', authority: '45 CFR Part 164 Subpart C' },
];

export const EditEnclaveModal: React.FC<EditEnclaveModalProps> = ({
  isOpen,
  onClose,
  tenant,
  onSaved,
}) => {
  const { updateTenant, updateTenantFrameworkScope, updateTenantOwner } = useTenant();

  const [name, setName] = useState('');
  const [cageCode, setCageCode] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [licenseTier, setLicenseTier] = useState<CommercialLicenseTier>('DEFENSE_PRO');
  const [primaryFramework, setPrimaryFramework] = useState<ComplianceFramework>('CMMC_L1');
  const [enabledFrameworks, setEnabledFrameworks] = useState<ComplianceFramework[]>(['CMMC_L1']);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);

  // Sync state with incoming tenant
  useEffect(() => {
    if (tenant) {
      setName(tenant.name || '');
      setCageCode(tenant.cageCode || '');

      // Extract email from systemOwner if formatted like "Alex Mercer (alex@example.com)" or plain email
      const rawOwner = tenant.systemOwner || '';
      const emailMatch = rawOwner.match(/<([^>]+)>|\(([^)]+)\)/);
      const extractedEmail = emailMatch ? (emailMatch[1] || emailMatch[2]) : rawOwner.includes('@') ? rawOwner : '';
      setOwnerEmail(extractedEmail || tenant.domain ? `admin@${tenant.domain}` : rawOwner);

      setLicenseTier(normalizeLicenseTier(tenant.licenseTier));
      const prim = tenant.primaryFramework || 'CMMC_L1';
      setPrimaryFramework(prim);
      setEnabledFrameworks(
        tenant.enabledFrameworks && tenant.enabledFrameworks.length > 0
          ? tenant.enabledFrameworks
          : [prim]
      );
      setShowSuccessToast(false);
    }
  }, [tenant, isOpen]);

  if (!isOpen || !tenant) return null;

  const handlePrimaryChange = (fw: ComplianceFramework) => {
    setPrimaryFramework(fw);
    if (!enabledFrameworks.includes(fw)) {
      setEnabledFrameworks(prev => [...prev, fw]);
    }
  };

  const handleToggleFramework = (fw: ComplianceFramework) => {
    if (fw === primaryFramework) return; // Primary must stay enabled
    if (enabledFrameworks.includes(fw)) {
      setEnabledFrameworks(prev => prev.filter(f => f !== fw));
    } else {
      setEnabledFrameworks(prev => [...prev, fw]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const cleanCage = (cageCode.trim() || 'PENDING').toUpperCase();
      const updatedTenant: Partial<Tenant> = {
        name: name.trim(),
        cageCode: cleanCage,
        licenseTier,
        primaryFramework,
        enabledFrameworks,
      };

      // 1. Update basic tenant metadata
      updateTenant(tenant.id, updatedTenant);

      // 2. Update multi-framework scope
      updateTenantFrameworkScope(tenant.id, enabledFrameworks, primaryFramework);

      // 3. Reassign system owner if changed
      if (ownerEmail.trim()) {
        updateTenantOwner(tenant.id, ownerEmail.trim());
      }

      setShowSuccessToast(true);
      if (onSaved) {
        onSaved({
          ...tenant,
          ...updatedTenant,
          systemOwner: ownerEmail.trim() || tenant.systemOwner,
        } as Tenant);
      }

      setTimeout(() => {
        setIsSubmitting(false);
        onClose();
      }, 700);
    } catch (err) {
      console.error('Failed to update enclave:', err);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-2xl my-8 p-1.5 rounded-[2rem] bg-gradient-to-b from-slate-800/60 via-slate-900/40 to-slate-950 ring-1 ring-slate-700/60 shadow-2xl shadow-cyan-950/20 animate-scaleUp">
        <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-left space-y-6">
          
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                  <Building2 className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg sm:text-xl font-black text-white tracking-tight">
                    Edit Enclave Configuration
                  </h2>
                  <p className="text-xs text-slate-400">
                    Update live configuration, owner assignment, and compliance boundaries for <span className="text-cyan-300 font-mono font-bold">{tenant.id}</span>
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/80 border border-transparent hover:border-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          {tenant && <LegacyTenantNotice tenant={tenant} variant="inline" />}

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Row 1: Organization Name & CAGE Code */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2 space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  Organization Legal Name *
                </label>
                <div className="relative">
                  <Building2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Apex Defense Solutions, LLC"
                    className="w-full pl-9 pr-3 py-2.5 text-xs bg-slate-900/90 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all font-medium"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  CAGE Code
                </label>
                <input
                  type="text"
                  maxLength={5}
                  value={cageCode}
                  onChange={e => setCageCode(e.target.value.toUpperCase())}
                  placeholder="e.g. 9X7B4"
                  className="w-full px-3 py-2.5 text-xs font-mono font-bold bg-slate-900/90 border border-slate-800 rounded-xl text-cyan-300 placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 uppercase transition-all"
                />
              </div>
            </div>

            {/* Row 2: Primary System Owner Email */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                  Primary System Owner Email *
                </label>
                <span className="text-[10px] text-purple-400 font-mono">
                  Reassigns TENANT_OWNER administrative seat
                </span>
              </div>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  required
                  value={ownerEmail}
                  onChange={e => setOwnerEmail(e.target.value)}
                  placeholder="e.g. ciso@defensecontractor.us"
                  className="w-full pl-9 pr-3 py-2.5 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                />
              </div>
            </div>

            {/* Row 3: Commercial License Tier */}
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 flex items-center justify-between">
                <span>License Subscription Tier</span>
                <span className="text-[10px] text-slate-400 font-mono lowercase">Annual recurring commercial license</span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Foundational */}
                <button
                  type="button"
                  onClick={() => setLicenseTier('FOUNDATIONAL')}
                  className={`p-3 rounded-2xl border text-left transition-all ${
                    licenseTier === 'FOUNDATIONAL'
                      ? 'bg-cyan-500/10 border-cyan-500/50 ring-1 ring-cyan-500/40 text-white'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-cyan-400" /> Foundational
                    </span>
                    {licenseTier === 'FOUNDATIONAL' && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                  </div>
                  <div className="text-base font-black text-cyan-300 font-mono">$3,500<span className="text-[10px] font-normal text-slate-400">/yr</span></div>
                  <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">Small suppliers • CMMC L1 ({FRAMEWORK_REGISTRY.CMMC_L1.totalControls} controls)</p>
                </button>

                {/* Defense Pro */}
                <button
                  type="button"
                  onClick={() => setLicenseTier('DEFENSE_PRO')}
                  className={`p-3 rounded-2xl border text-left transition-all relative ${
                    licenseTier === 'DEFENSE_PRO'
                      ? 'bg-brand-500/10 border-brand-500/50 ring-1 ring-brand-500/40 text-white'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded-full bg-brand-500 text-[10px] font-mono font-bold text-white uppercase tracking-wider">
                    Recommended
                  </div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Award className="w-3.5 h-3.5 text-brand-400" /> Defense Pro
                    </span>
                    {licenseTier === 'DEFENSE_PRO' && <Check className="w-3.5 h-3.5 text-brand-400" />}
                  </div>
                  <div className="text-base font-black text-brand-300 font-mono">$7,000<span className="text-[10px] font-normal text-slate-400">/yr</span></div>
                  <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">DoD Primes & Subs • CMMC L2 ({FRAMEWORK_REGISTRY.CMMC_L2.totalControls} controls)</p>
                </button>

                {/* Enterprise */}
                <button
                  type="button"
                  onClick={() => setLicenseTier('ENTERPRISE')}
                  className={`p-3 rounded-2xl border text-left transition-all ${
                    licenseTier === 'ENTERPRISE'
                      ? 'bg-purple-500/10 border-purple-500/50 ring-1 ring-purple-500/40 text-white'
                      : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-purple-400" /> Enterprise
                    </span>
                    {licenseTier === 'ENTERPRISE' && <Check className="w-3.5 h-3.5 text-purple-400" />}
                  </div>
                  <div className="text-base font-black text-purple-300 font-mono">$14,000<span className="text-[10px] font-normal text-slate-400">/yr</span></div>
                  <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">Multi-CAGE & Assessor MSP Networks</p>
                </button>
              </div>
            </div>

            {/* Row 4: Primary Framework Selection & Enabled Scope Checklist */}
            <div className="space-y-3 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Compliance Framework Scope</span>
                </label>
                <span className="text-[10px] text-slate-400 font-mono">
                  Primary framework renders on launch
                </span>
              </div>

              {/* Primary Framework Selector */}
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Primary Enclave Framework:
                </label>
                <select
                  value={primaryFramework}
                  onChange={e => handlePrimaryChange(e.target.value as ComplianceFramework)}
                  className="w-full px-3 py-2 text-xs font-semibold bg-slate-900 border border-slate-800 rounded-xl text-cyan-300 focus:outline-none focus:border-cyan-400"
                >
                  {ALL_FRAMEWORKS.map(fw => (
                    <option key={fw.id} value={fw.id}>
                      {fw.label} ({fw.authority})
                    </option>
                  ))}
                </select>
              </div>

              {/* Enabled Frameworks Scope */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Enabled Frameworks in this Enclave (cross-framework inheritance enabled):
                </label>

                <div className="space-y-1.5">
                  {ALL_FRAMEWORKS.map(fw => {
                    const isEnabled = enabledFrameworks.includes(fw.id);
                    const isPrimary = fw.id === primaryFramework;

                    return (
                      <div
                        key={fw.id}
                        onClick={() => handleToggleFramework(fw.id)}
                        className={`p-2.5 rounded-xl border flex items-center justify-between cursor-pointer transition-colors ${
                          isEnabled
                            ? 'bg-slate-900/80 border-cyan-500/30 text-white'
                            : 'bg-slate-950 border-slate-800/80 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={isEnabled}
                            onChange={() => handleToggleFramework(fw.id)}
                            disabled={isPrimary}
                            className="rounded border-slate-700 text-cyan-500 focus:ring-cyan-500 cursor-pointer"
                          />
                          <div>
                            <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                              <span>{fw.label}</span>
                              {isPrimary && (
                                <span className="text-[10px] font-mono font-bold text-cyan-300 bg-cyan-500/20 px-1.5 py-0.5 rounded border border-cyan-500/30">
                                  PRIMARY
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400">{fw.authority}</div>
                          </div>
                        </div>

                        {isEnabled && <Check className="w-3.5 h-3.5 text-cyan-400" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-850 border border-slate-800 rounded-xl transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary text-xs px-5 py-2.5 flex items-center gap-2 font-bold shadow-lg shadow-cyan-500/20"
              >
                {showSuccessToast ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 animate-bounce" />
                    <span>Enclave Updated!</span>
                  </>
                ) : isSubmitting ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Saving Changes...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Save Enclave Changes</span>
                  </>
                )}
              </button>
            </div>

          </form>

        </div>
      </div>
    </div>
  );
};
