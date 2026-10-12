import React, { useState } from 'react';
import {
  ShieldCheck,
  Building2,
  CheckCircle2,
  X,
  Mail,
  User,
  Phone,
  Clock,
  Users,
  Sparkles,
  ArrowRight,
  Lock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';
import { LicenseTier, getLicenseTierBadge } from '../../types/tenant';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { radioGroupKeyDown } from '../../utils/a11y';
interface LicenseRequestModalProps {
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const LicenseRequestModal: React.FC<LicenseRequestModalProps> = ({ onOpenLegal }) => {
  const { isLicenseModalOpen, closeLicenseModal, selectedLicensePlan } = useAuth();
  const { submitLicenseRequest } = useTenant();

  const [fullName, setFullName] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [cageCode, setCageCode] = useState('');
  const [plan, setPlan] = useState<LicenseTier>(selectedLicensePlan || 'DEFENSE_PRO');
  const [inScopeUsers, setInScopeUsers] = useState('1–15 Users');
  const [targetTimeline, setTargetTimeline] = useState('Within 30 Days (Immediate)');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  // Sync initial plan selection when opened
  React.useEffect(() => {
    if (selectedLicensePlan) {
      setPlan(selectedLicensePlan);
    }
  }, [selectedLicensePlan]);

  if (!isLicenseModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workEmail.trim() || !companyName.trim() || !fullName.trim()) return;

    setIsSubmitting(true);
    try {
      await submitLicenseRequest({
        fullName: fullName.trim(),
        workEmail: workEmail.trim(),
        companyName: companyName.trim(),
        cageCode: cageCode.trim().toUpperCase() || undefined,
        selectedPlan: plan,
        inScopeUsers,
        targetTimeline,
        phoneNumber: phoneNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setIsSubmitted(true);
    } catch (err) {
      console.error('License request submission failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setIsSubmitted(false);
    setFullName('');
    setWorkEmail('');
    setCompanyName('');
    setCageCode('');
    setPhoneNumber('');
    setNotes('');
    closeLicenseModal();
  };

  return (
    <DialogOverlay onClose={handleResetAndClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-xl animate-fadeIn overflow-y-auto">
      {/* Outer Shell (Double-Bezel hardware architecture) */}
      <div className="relative w-full max-w-2xl my-8 p-1.5 sm:p-2 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950/80 ring-1 ring-white/10 shadow-2xl shadow-slate-950/80">
        
        {/* Inner Core Container */}
        <div className="relative p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
          
          {/* Close Button */}
          <button
            onClick={handleResetAndClose}
            className="absolute top-5 right-5 w-8 h-8 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>

          {!isSubmitted ? (
            <div>
              {/* Header */}
              <div className="space-y-2 mb-6 pr-8">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-500/10 border border-brand-500/25 text-xs font-bold uppercase tracking-widest text-brand-300">
                  <ShieldCheck className="w-3.5 h-3.5 text-brand-400" />
                  Defense Enclave Licensing & Onboarding
                </div>
                <DialogTitle as="h3" className="text-2xl font-black text-white tracking-tight">
                  Request Enclave License & Schedule Sales Call
                </DialogTitle>
                <p className="text-xs sm:text-sm text-slate-400">
                  Fill out your contractor details below. Our CMMC Solutions Architecture team will configure your isolated Microsoft 365 or Google Workspace tenant enclave and coordinate your licensing setup.
                </p>
              </div>

              {/* Commercial Pricing Selector Cards */}
              <div role="radiogroup" aria-label="License plan" onKeyDown={radioGroupKeyDown} className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                {/* Foundational Enclave Option */}
                <button type="button" role="radio" aria-checked={plan === 'FOUNDATIONAL' || plan === 'single-org'} tabIndex={(plan === 'FOUNDATIONAL' || plan === 'single-org') ? 0 : -1}
                  onClick={() => setPlan('FOUNDATIONAL')}
                  className={`w-full text-left cursor-pointer p-3.5 rounded-2xl border transition-all ${
                    plan === 'FOUNDATIONAL' || plan === 'single-org'
                      ? 'bg-cyan-950/40 border-cyan-500/80 ring-1 ring-cyan-500/50 shadow-lg shadow-cyan-500/10'
                      : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white">Foundational</span>
                    {(plan === 'FOUNDATIONAL' || plan === 'single-org') && (
                      <span className="w-4 h-4 rounded-full bg-cyan-500 text-slate-950 flex items-center justify-center text-xs font-black">
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-black text-white font-mono">$3,500</span>
                    <span className="text-xs text-slate-400 font-medium">/ yr</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-snug">
                    1 boundary, CMMC Level 1 (17 controls) or HIPAA/SOC 2, single owner.
                  </p>
                </button>

                {/* Defense Professional Option (Recommended) */}
                <button type="button" role="radio" aria-checked={plan === 'DEFENSE_PRO'} tabIndex={(plan === 'DEFENSE_PRO') ? 0 : -1}
                  onClick={() => setPlan('DEFENSE_PRO')}
                  className={`w-full text-left cursor-pointer p-3.5 rounded-2xl border relative transition-all ${
                    plan === 'DEFENSE_PRO'
                      ? 'bg-brand-950/50 border-brand-500/90 ring-2 ring-brand-500/60 shadow-lg shadow-brand-500/20'
                      : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white flex items-center gap-1">
                      Defense Pro
                      <Sparkles className="w-3 h-3 text-amber-400" />
                    </span>
                    {plan === 'DEFENSE_PRO' && (
                      <span className="w-4 h-4 rounded-full bg-brand-500 text-white flex items-center justify-center text-xs font-bold">
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-black text-white font-mono">$7,000</span>
                    <span className="text-xs text-slate-400 font-medium">/ yr</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-snug">
                    CMMC Level 2 (110 controls), NIST 800-53, STIG generator, 5 seats.
                  </p>
                </button>

                {/* Enterprise & Assessor Enclave Option */}
                <button type="button" role="radio" aria-checked={plan === 'ENTERPRISE'} tabIndex={(plan === 'ENTERPRISE') ? 0 : -1}
                  onClick={() => setPlan('ENTERPRISE')}
                  className={`w-full text-left cursor-pointer p-3.5 rounded-2xl border transition-all ${
                    plan === 'ENTERPRISE' || plan === 'msp-assessor'
                      ? 'bg-purple-950/40 border-purple-500/80 ring-1 ring-purple-500/50 shadow-lg shadow-purple-500/10'
                      : 'bg-slate-900/50 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-white">Enterprise</span>
                    {(plan === 'ENTERPRISE' || plan === 'msp-assessor') && (
                      <span className="w-4 h-4 rounded-full bg-purple-500 text-white flex items-center justify-center text-xs font-bold">
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-black text-white font-mono">$14,000</span>
                    <span className="text-xs text-slate-400 font-medium">/ yr</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-snug">
                    Unlimited enclaves, OpenSCAP sensor API, dedicated DB, 24/7 support.
                  </p>
                </button>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Full Name */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Primary Contact Name & Title *
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                      <input
                        type="text"
                        required
                        value={fullName}
                        onChange={e => setFullName(e.target.value)}
                        placeholder="e.g. John Miller, CISO"
                        className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                      />
                    </div>
                  </div>

                  {/* Work Email */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Work Email (Defense Domain) *
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                      <input
                        type="email"
                        required
                        value={workEmail}
                        onChange={e => setWorkEmail(e.target.value)}
                        placeholder="john@aerodefense.com"
                        className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Company Name */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Company / Organization Name *
                    </label>
                    <div className="relative">
                      <Building2 className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                      <input
                        type="text"
                        required
                        value={companyName}
                        onChange={e => setCompanyName(e.target.value)}
                        placeholder="e.g. Aero Defense Technologies LLC"
                        className="w-full pl-9 pr-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                      />
                    </div>
                  </div>

                  {/* CAGE Code */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      CAGE Code <span className="text-slate-400 font-normal">(Optional)</span>
                    </label>
                    <input
                      type="text"
                      maxLength={10}
                      value={cageCode}
                      onChange={e => setCageCode(e.target.value.toUpperCase())}
                      placeholder="e.g. 8K4P1"
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 uppercase"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Scope */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      <Users className="w-3.5 h-3.5 inline mr-1 text-slate-400" />
                      In-Scope Users
                    </label>
                    <select
                      value={inScopeUsers}
                      onChange={e => setInScopeUsers(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white focus:outline-none focus:border-brand-500"
                    >
                      <option value="1–15 Users">1–15 Users</option>
                      <option value="16–50 Users">16–50 Users</option>
                      <option value="51–200 Users">51–200 Users</option>
                      <option value="200+ Enterprise">200+ Enterprise</option>
                    </select>
                  </div>

                  {/* Timeline */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      <Clock className="w-3.5 h-3.5 inline mr-1 text-slate-400" />
                      Assessment Timeline
                    </label>
                    <select
                      value={targetTimeline}
                      onChange={e => setTargetTimeline(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white focus:outline-none focus:border-brand-500"
                    >
                      <option value="Within 30 Days (Immediate)">Immediate (Under 30 Days)</option>
                      <option value="30–60 Days">30–60 Days</option>
                      <option value="60–90 Days">60–90 Days</option>
                      <option value="Planning / Exploring">Exploring / Next FY</option>
                    </select>
                  </div>

                  {/* Phone */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      <Phone className="w-3.5 h-3.5 inline mr-1 text-slate-400" />
                      Direct Phone
                    </label>
                    <input
                      type="tel"
                      value={phoneNumber}
                      onChange={e => setPhoneNumber(e.target.value)}
                      placeholder="(555) 019-2834"
                      className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
                    />
                  </div>
                </div>

                {/* Additional Notes */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Specific Architecture / SSO Requirements (M365 GCC High, Commercial, Workspace)
                  </label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="e.g. Need Microsoft 365 GCC High tenant integration and third-party assessor read-only access for upcoming DIBCAC audit."
                    className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-750 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 resize-none"
                  />
                </div>

                {/* Security and SLA Note */}
                <div className="flex items-center gap-2 text-xs text-slate-400 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800">
                  <Lock className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <span>
                    Your inquiry is protected under defense-grade confidentiality. No automated charges or unverified account creation.
                  </span>
                </div>

                {/* Submit Action */}
                <div className="pt-2 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleResetAndClose}
                    className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 transition-colors"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="btn-primary group relative inline-flex items-center gap-2.5 px-6 py-2.5 rounded-full text-xs ring-1 ring-white/20"
                  >
                    <span>{isSubmitting ? 'Submitting Request...' : 'Schedule Call & Request Enclave License'}</span>
                    <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center group-hover:translate-x-0.5 transition-transform">
                      <ArrowRight className="w-3 h-3 text-white" />
                    </span>
                  </button>
                </div>

                {/* Legal Notice */}
                <div className="pt-2 text-center text-xs text-slate-400">
                  <span>By scheduling a call, you agree to our </span>
                  <button
                    type="button"
                    onClick={() => onOpenLegal && onOpenLegal('terms')}
                    className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
                  >
                    Terms of Service
                  </button>
                  <span> and </span>
                  <button
                    type="button"
                    onClick={() => onOpenLegal && onOpenLegal('privacy')}
                    className="text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
                  >
                    Privacy Policy
                  </button>
                  <span>.</span>
                </div>
              </form>
            </div>
          ) : (
            /* Confirmation Screen */
            <div className="py-8 text-center space-y-6">
              <div className="w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center mx-auto shadow-xl shadow-emerald-500/20">
                <CheckCircle2 className="w-8 h-8" />
              </div>

              <div className="space-y-2 max-w-md mx-auto">
                <h3 className="text-2xl font-black text-white tracking-tight">
                  License Request Received!
                </h3>
                <p className="text-xs sm:text-sm text-slate-300">
                  Thank you, <strong className="text-white">{fullName}</strong>. A Pitch Black Cyber CMMC Solutions Architect will contact you at <span className="font-mono text-brand-300">{workEmail}</span> within 1 business day.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 max-w-md mx-auto text-left text-xs space-y-2.5">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-slate-400">Requested Plan:</span>
                  <span className="font-bold text-white">
                    {getLicenseTierBadge(plan).badge}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-slate-400">Organization:</span>
                  <span className="font-semibold text-white">{companyName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Next Step:</span>
                  <span className="text-brand-300 font-medium">Sales call & SSO Tenant Boundary Provisioning</span>
                </div>
              </div>

              <div className="pt-4 flex items-center justify-center gap-3">
                <button
                  onClick={handleResetAndClose}
                  className="px-6 py-2.5 rounded-full bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-lg shadow-brand-500/20 transition-all"
                >
                  Return to Pitch Black Cyber
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </DialogOverlay>
  );
};
