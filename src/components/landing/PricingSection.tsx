import React, { useState } from 'react';
import { Check, Sparkles, ArrowRight, Zap } from 'lucide-react';

interface PricingSectionProps {
  onSelectPlan: (planId: string) => void;
}

export const PricingSection: React.FC<PricingSectionProps> = ({ onSelectPlan }) => {
  const [isAnnual, setIsAnnual] = useState(true);

  return (
    <section id="pricing" className="py-24 relative overflow-hidden">
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-semibold text-brand-300">
            <Zap className="w-3.5 h-3.5 text-brand-400" />
            Transparent Pricing
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Predictable Compliance Licensing
          </h2>
          <p className="text-base sm:text-lg text-slate-300">
            Choose the tier tailored to your defense contracting scope—from single sub-contractor enclaves to multi-client MSP platforms.
          </p>

          {/* Billing Cycle Toggle */}
          <div className="pt-4 flex items-center justify-center gap-3">
            <span className={`text-xs font-semibold ${!isAnnual ? 'text-white' : 'text-slate-400'}`}>
              Monthly
            </span>
            <button
              onClick={() => setIsAnnual(!isAnnual)}
              className="w-13 h-7 rounded-full bg-slate-800 p-1 transition-colors relative focus:outline-none ring-1 ring-slate-700"
              aria-label="Toggle annual billing"
            >
              <div 
                className={`w-5 h-5 rounded-full bg-brand-500 shadow-md transition-transform duration-200 ${
                  isAnnual ? 'translate-x-6' : 'translate-x-0'
                }`} 
              />
            </button>
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-semibold ${isAnnual ? 'text-white' : 'text-slate-400'}`}>
                Annual Billing
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Save 20%
              </span>
            </div>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
          
          {/* TIER 1: Single Organization */}
          <div className="p-2 rounded-[2rem] bg-gradient-to-b from-slate-800/40 via-slate-900/30 to-slate-950/60 ring-1 ring-slate-800 shadow-xl flex flex-col justify-between">
            <div className="h-full p-8 rounded-[calc(2rem-0.5rem)] bg-slate-950/90 border border-slate-800/80 flex flex-col justify-between space-y-8">
              
              <div className="space-y-6">
                <div>
                  <h3 className="text-xl font-bold text-white tracking-tight">Single Organization</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Ideal for defense subcontractors securing their own CMMC Level 1 enclave.
                  </p>
                </div>

                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-extrabold text-white">
                    {isAnnual ? '$239' : '$299'}
                  </span>
                  <span className="text-xs text-slate-400 font-medium">/ month</span>
                  {isAnnual && (
                    <span className="text-[11px] text-emerald-400 font-mono font-semibold ml-2">
                      ($2,870 billed annually)
                    </span>
                  )}
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>1 Organization Enclave</strong> (Scoped System Boundary)</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Up to <strong>5 Team Members</strong> & Internal Assessors</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Automated NIST SP 800-171 SSP Builder & PDF Export</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Immutable SHA-256 GCS Evidence Storage</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Pre-built M365 & AD Starter Implementation Templates</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={() => onSelectPlan('single-org')}
                className="w-full py-3.5 px-6 rounded-xl bg-slate-900 hover:bg-slate-850 text-white font-semibold text-xs border border-slate-700/80 hover:border-slate-600 transition-all flex items-center justify-center gap-2 shadow-lg"
              >
                <span>Start 14-Day Free Trial</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

            </div>
          </div>

          {/* TIER 2: MSP / Defense Assessor (FEATURED) */}
          <div className="relative p-2 rounded-[2rem] bg-gradient-to-b from-brand-500/40 via-indigo-600/30 to-slate-950/60 ring-2 ring-brand-500/80 shadow-2xl shadow-brand-500/20 flex flex-col justify-between">
            
            {/* Top Featured Ribbon */}
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-brand-500 to-indigo-600 text-white text-[10px] font-extrabold uppercase tracking-widest shadow-md flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-amber-300" />
              Most Popular for MSPs & C3PAOs
            </div>

            <div className="h-full p-8 rounded-[calc(2rem-0.5rem)] bg-slate-950/95 border border-slate-800 flex flex-col justify-between space-y-8">
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-bold text-white tracking-tight">MSP / Defense Assessor</h3>
                    <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 text-[10px] font-bold border border-brand-500/30">
                      Multi-Tenant
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    For Managed Service Providers, Consultants, and C3PAO Lead Assessors.
                  </p>
                </div>

                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-extrabold text-white">
                    {isAnnual ? '$639' : '$799'}
                  </span>
                  <span className="text-xs text-slate-400 font-medium">/ month</span>
                  {isAnnual && (
                    <span className="text-[11px] text-emerald-400 font-mono font-semibold ml-2">
                      ($7,670 billed annually)
                    </span>
                  )}
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>Unlimited Client Organization Enclaves</strong></span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Multi-Tenant Switcher & Client Management Portal</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>Unlimited Assessor & Team Seats</strong></span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Custom Branding on Exported SSPs & SPRS Reports</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Full JSON Backup/Restore & Bulk GCS Artifact Sync</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Priority Compliance Support & Architecture Guidance</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={() => onSelectPlan('msp-assessor')}
                className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-brand-500 via-brand-600 to-indigo-600 hover:from-brand-400 hover:to-indigo-500 text-white font-bold text-xs shadow-xl shadow-brand-500/25 ring-1 ring-white/20 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                <span>Launch Assessor Portal</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

            </div>
          </div>

        </div>

      </div>
    </section>
  );
};
