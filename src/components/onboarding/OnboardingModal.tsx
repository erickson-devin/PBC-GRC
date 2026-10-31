import React, { useState, useEffect, useId } from 'react';
import {
  Shield,
  Building2,
  Server,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Sparkles,
  Lock,
  FileText,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { SamStatus } from '../../types/tenant';
import { errorMessage } from '../../utils/errors';
import {
  DEFAULT_CLOUD_PROVIDERS,
  defaultBoundaryNarrative,
  refreshBoundaryNarrative,
  refreshSystemName,
} from '../../data/onboardingDefaults';
import { onboardingSummary } from '../../data/onboardingSummary';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { OwnerMfaNotice } from '../auth/OwnerMfaNotice';
interface OnboardingModalProps {
  isOpen: boolean;
  onClose?: () => void;
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { currentTenant, currentUser, completeTenantOnboarding, programs, updateProgram, activeFramework, programsStatus } = useTenant();
  const { updateSSPMetadata, metrics, state } = useAssessment();

  const [step, setStep] = useState<1 | 2>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State initialized from currentTenant / currentUser
  const [orgName, setOrgName] = useState(currentTenant.name || '');
  const [cageCode, setCageCode] = useState(currentTenant.cageCode && currentTenant.cageCode !== 'PENDING' ? currentTenant.cageCode : '');
  const [samStatus, setSamStatus] = useState<SamStatus>(currentTenant.samStatus || 'ACTIVE');
  const [industry, setIndustry] = useState(currentTenant.industry || 'Defense Industrial Base (DIB)');
  const [systemName, setSystemName] = useState(
    currentTenant.systemName || `${currentTenant.name || 'Corporate'} Information Network (CIN)`
  );
  const [systemOwner, setSystemOwner] = useState(
    currentTenant.systemOwner || `${currentUser.name} (System Owner)`
  );
  const [boundaryScope, setBoundaryScope] = useState(
    currentTenant.systemBoundaryScope || defaultBoundaryNarrative(currentTenant.name || '', activeFramework)
  );
  const [cloudProviders, setCloudProviders] = useState(DEFAULT_CLOUD_PROVIDERS);
  // The organization name the proposed system name / narrative were derived from (they follow a change of it on step 1)
  const [derivedOrg, setDerivedOrg] = useState(currentTenant.name || '');

  // Sync initial values if currentTenant changes
  useEffect(() => {
    if (isOpen) {
      setOrgName(currentTenant.name || '');
      setCageCode(currentTenant.cageCode && currentTenant.cageCode !== 'PENDING' ? currentTenant.cageCode : '');
      setSamStatus(currentTenant.samStatus || 'ACTIVE');
      setIndustry(currentTenant.industry || 'Defense Industrial Base (DIB)');
      setSystemName(
        currentTenant.systemName || `${currentTenant.name || 'Corporate'} Information Network (CIN)`
      );
      setSystemOwner(currentTenant.systemOwner || `${currentUser.name} (System Owner)`);
      setBoundaryScope(currentTenant.systemBoundaryScope || defaultBoundaryNarrative(currentTenant.name || '', activeFramework));
      setDerivedOrg(currentTenant.name || '');
      setStep(1);
      setError(null);
    }
  }, [isOpen, currentTenant, currentUser]);

  const summaryHeadingId = useId();
  if (!isOpen) return null;

  const programsSettled = programsStatus === 'ready' || programsStatus === 'error' || programsStatus === 'unsupported';
  const summary = onboardingSummary({
    framework: activeFramework,
    total: metrics.totalControls,
    met: metrics.metCount,
    evidenceCount: state.evidenceIndex.length,
    loading: !programsSettled,
  });

  const handleNextStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setError('Please provide your legal organization or company name.');
      return;
    }
    setError(null);
    setSystemName((s) => refreshSystemName(s, derivedOrg, orgName));
    setBoundaryScope((b) => refreshBoundaryNarrative(b, derivedOrg, orgName, activeFramework));
    setDerivedOrg(orgName.trim());
    setStep(2);
  };

  const handleComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!systemName.trim()) {
      setError('Please provide a System Boundary Name for your System Security Plan (SSP).');
      return;
    }
    if (!systemOwner.trim()) {
      setError('Please designate a System Owner or Lead Assessor.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // 1. Complete tenant configuration. For a new organisation this CREATES the tenant on the server (and can fail:
      //    expired session, no permission, offline); the wizard stays open with its answers when it does.
      const finalTenantId = await completeTenantOnboarding(currentTenant.id, {
        organizationName: orgName.trim(),
        cageCode: cageCode.trim() || 'PENDING',
        samStatus: samStatus,
        systemName: systemName.trim(),
        systemOwner: systemOwner.trim(),
        systemBoundaryScope: boundaryScope.trim(),
        cloudServiceProviders: cloudProviders.trim(),
      });

      // 2. Synchronize SSP Metadata in AssessmentContext. Only when the tenant did not change: a newly created
      //    tenant already had its SSP metadata stored above, and this closure still belongs to the OLD tenant (its
      //    read-only check would reject the write and pop an alert).
      if (finalTenantId === currentTenant.id) updateSSPMetadata({
        organizationName: orgName.trim(),
        cageCode: cageCode.trim() || '',
        samStatus: samStatus,
        systemName: systemName.trim(),
        systemOwner: systemOwner.trim(),
        systemBoundaryScope: boundaryScope.trim(),
        cloudServiceProviders: cloudProviders.trim(),
        lastUpdated: new Date().toISOString(),
      });

      // 2b. The boundary statement of a server-backed tenant belongs to its DEFAULT program. A failure here does not undo the
      //     onboarding: the tenant's own copy of the text was saved above and the program text can be edited in Enclave Settings.
      if (finalTenantId === currentTenant.id && currentTenant.serverBacked) {
        const defaultProgram = programs.find((p) => p.isDefault && !p.archived);
        if (defaultProgram) {
          try {
            await updateProgram(defaultProgram.id, { boundarySummary: boundaryScope.trim() });
          } catch (err: unknown) {
            console.warn('[Onboarding] Could not save the boundary description to the default program:', err);
          }
        }
      }

      // 3. Trigger victory confetti
      try {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 },
          colors: ['#3b82f6', '#10b981', '#6366f1', '#f59e0b'],
        });
      } catch {
        // Fallback if confetti not available
      }

      if (onClose) {
        onClose();
      }
    } catch (err: unknown) {
      console.error('Failed to complete onboarding:', err);
      setError(errorMessage(err) || 'An error occurred saving your enclave configuration. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DialogOverlay className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/85 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] animate-fadeIn">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-slate-800 bg-slate-950/90 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center text-brand-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle as="h3" className="text-lg font-bold text-white tracking-tight">
                  Welcome to Your Live Compliance Enclave
                </DialogTitle>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs font-bold">
                  Step {step} of 2
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Initialize your isolated {summary.frameworkTitle} boundary &amp; System Security Plan
              </p>
            </div>
          </div>

          {/* Stepper Dots */}
          <div className="flex items-center gap-2 self-end sm:self-center" aria-hidden="true">
            <div
              className={`w-2.5 h-2.5 rounded-full transition-all ${
                step === 1 ? 'bg-brand-500 ring-4 ring-brand-500/20' : 'bg-emerald-500'
              }`}
            />
            <div className="w-6 h-0.5 bg-slate-800" />
            <div
              className={`w-2.5 h-2.5 rounded-full transition-all ${
                step === 2 ? 'bg-brand-500 ring-4 ring-brand-500/20' : 'bg-slate-700'
              }`}
            />
          </div>
        </div>

        {/* Informational Callout */}
        <div className="px-6 py-3 bg-brand-500/5 border-b border-slate-800/80 flex items-center gap-3 text-xs text-slate-300" aria-live="polite">
          <Sparkles className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
          <span>
            <strong>{summary.calloutTitle}</strong> {summary.calloutText}
          </span>
        </div>

        <ErrorNotice message={error} className="mx-6 mt-4" />
        {step === 2 && <OwnerMfaNotice className="mx-6 mt-4" />}

        {/* Modal Form Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {step === 1 ? (
            /* Step 1: Organization Profile */
            <form id="onboarding-step1" onSubmit={handleNextStep} className="space-y-4">
              <h4 className="flex items-center gap-2 pb-2 border-b border-slate-800 text-sm font-semibold text-white">
                <Building2 className="w-4 h-4 text-brand-400" aria-hidden="true" />
                <span>1. Organization & Contractor Profile</span>
              </h4>

              {/* Organization Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Legal Organization Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Pitch Black Cyber LLC"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors"
                />
                <p className="mt-1 text-xs text-slate-400">
                  {summary.sprsApplies
                    ? 'This will appear on the cover page of all generated System Security Plans (SSPs) and SPRS score reports.'
                    : 'This will appear on the cover page of all generated System Security Plans (SSPs) and exported reports.'}
                </p>
              </div>

              {/* CAGE Code & SAM.gov Status Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    CAGE Code <span className="text-slate-400 font-normal">(Optional)</span>
                  </label>
                  <input
                    type="text"
                    maxLength={5}
                    placeholder="e.g. 9X7B4 or PENDING"
                    value={cageCode}
                    onChange={(e) => setCageCode(e.target.value.toUpperCase())}
                    className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 font-mono focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    SAM.gov Registration Status
                  </label>
                  <select
                    value={samStatus}
                    onChange={(e) => setSamStatus(e.target.value as SamStatus)}
                    className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-brand-500 transition-colors"
                  >
                    <option value="ACTIVE">ACTIVE — Certified in SAM.gov</option>
                    <option value="PENDING">PENDING — Registration in Review</option>
                    <option value="NOT_REGISTERED">NOT REGISTERED — Commercial / Pre-Award</option>
                    <option value="EXPIRED">EXPIRED — Renewal Required</option>
                  </select>
                </div>
              </div>

              {/* Defense Industry Sector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Defense Industry Classification
                </label>
                <input
                  type="text"
                  placeholder="e.g. Defense IT & Systems Integration, Aerospace Hardware, C3PAO"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>

              {/* Security Isolation Notice */}
              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-start gap-2.5 text-xs text-slate-400">
                <Lock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  Your enclave is partitioned with PostgreSQL Row-Level Security and a tenant-isolated local evidence vault, hosted on-premises by the customer; documents and CUI never leave the customer's enclave. No demo data will leak into this workspace.
                </span>
              </div>
            </form>
          ) : (
            /* Step 2: System Boundary Definition */
            <form id="onboarding-step2" onSubmit={handleComplete} className="space-y-4">
              <h4 className="flex items-center gap-2 pb-2 border-b border-slate-800 text-sm font-semibold text-white">
                <Server className="w-4 h-4 text-brand-400" aria-hidden="true" />
                <span>2. System Security Plan (SSP) Boundary Definition</span>
              </h4>

              {/* System Boundary Name */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  System Boundary Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Corporate IT & CUI Enclave or Operations Boundary"
                  value={systemName}
                  onChange={(e) => setSystemName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors"
                />
                <p className="mt-1 text-xs text-slate-400">
                  The primary system or information boundary being assessed under {summary.assessedUnder}.
                </p>
              </div>

              {/* Designated System Owner */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Designated System Owner / Lead Assessor <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Alex Mercer, Director of Security / CISO"
                  value={systemOwner}
                  onChange={(e) => setSystemOwner(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>

              {/* Boundary Scope Narrative */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  System Boundary Scope Narrative
                </label>
                <textarea
                  rows={3}
                  value={boundaryScope}
                  onChange={(e) => setBoundaryScope(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors resize-none leading-relaxed"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Summarize the technical components, cloud services, and endpoints in-scope for this assessment.
                </p>
              </div>

              {/* Cloud Service Providers (CSPs) */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  In-Scope Cloud Service Providers (CSPs)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Microsoft 365 GCC High (leave empty if none)"
                  value={cloudProviders}
                  onChange={(e) => setCloudProviders(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>

              {/* Ready Checklist Summary */}
              <section aria-labelledby={summaryHeadingId} className="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800/80 space-y-2 text-xs">
                <h4 id={summaryHeadingId} className="font-semibold text-slate-300 block">Baseline Readiness Summary: {summary.frameworkTitle}</h4>
                <dl className="grid grid-cols-3 gap-2 text-xs" aria-busy={!programsSettled}>
                  <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-center">
                    <dt className="text-slate-400 block">{summary.unitLabel}</dt>
                    <dd className="text-white font-mono text-sm font-bold">
                      <span aria-hidden="true">{summary.countText}</span>
                      <span className="sr-only">{summary.countSrText}</span>
                    </dd>
                  </div>
                  <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-center">
                    <dt className="text-slate-400 block">Readiness</dt>
                    <dd className="text-amber-400 font-mono text-sm font-bold">{summary.readinessText}</dd>
                  </div>
                  <div className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-center">
                    <dt className="text-slate-400 block">Evidence Vault</dt>
                    <dd className="text-slate-300 font-mono text-sm font-bold">{summary.evidenceText}</dd>
                  </div>
                </dl>
              </section>
            </form>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/90 flex items-center justify-between gap-3">
          {step === 1 ? (
            <>
              <div className="text-xs text-slate-400 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-brand-400" />
                <span>You can edit these details later in the SSP Builder tab.</span>
              </div>
              <button
                type="submit"
                form="onboarding-step1"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-lg shadow-brand-500/25 transition-all"
              >
                <span>Next: Define Boundary Scope</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white font-semibold text-xs transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>

              <button
                type="submit"
                form="onboarding-step2"
                disabled={isSubmitting}
                className="btn-success inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs"
              >
                <CheckCircle2 className="w-4 h-4 text-white" />
                <span>{isSubmitting ? 'Saving Configuration...' : 'Complete Setup & Launch Enclave'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </DialogOverlay>
  );
};
