import React from 'react';
import { Check, Sparkles, ArrowRight, Zap, Shield, Building2, Mail } from 'lucide-react';

interface PricingSectionProps {
  onSelectPlan: (planId: 'single-org' | 'msp-assessor') => void;
}

export const PricingSection: React.FC<PricingSectionProps> = ({ onSelectPlan }) => {
  return (
    <section id="pricing" className="py-24 relative overflow-hidden">
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-semibold text-brand-300">
            <Zap className="w-3.5 h-3.5 text-brand-400" />
            Transparent Defense Contracting Pricing
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Predictable Compliance Licensing
          </h2>
          <p className="text-base sm:text-lg text-slate-300">
            Simple, flat annual licensing for DoD sub-contractors and lead assessors. No surprise per-seat fees. Schedule a 15-minute onboarding call to configure your tenant boundary.
          </p>
        </div>

        {/* Pricing Cards Grid */}
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
          
          {/* TIER 1: Single Organization Enclave ($1,000/yr) */}
          <div className="p-2 rounded-[2rem] bg-gradient-to-b from-slate-800/40 via-slate-900/30 to-slate-950/60 ring-1 ring-slate-800 shadow-xl flex flex-col justify-between">
            <div className="h-full p-8 rounded-[calc(2rem-0.5rem)] bg-slate-950/90 border border-slate-800/80 flex flex-col justify-between space-y-8">
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4 text-brand-400" />
                    <h3 className="text-xl font-bold text-white tracking-tight">Single Organization Enclave</h3>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Complete turnkey CMMC Level 1 enclave for defense subcontractors securing their own compliance boundary.
                  </p>
                </div>

                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-white">
                      $1,000
                    </span>
                    <span className="text-xs text-slate-400 font-medium">/ year flat</span>
                  </div>
                  <p className="text-[11px] text-emerald-400 font-mono font-semibold mt-1">
                    Transparent annual license • No hidden per-user fees
                  </p>
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>1 Dedicated Enclave</strong> (Google Cloud SQL RLS boundary)</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>All 17 CMMC Level 1 Controls</strong> with FAR 52.204-21 mapping</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Automated NIST SP 800-171 System Security Plan (SSP) generation</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Immutable SHA-256 cryptographic GCS evidence vault</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Microsoft 365 / Entra ID & Google Workspace SSO integration</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>Unlimited Auditor Read-Only Seats</strong> for C3PAO reviews</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5">
                <button
                  onClick={() => onSelectPlan('single-org')}
                  className="btn-secondary w-full py-3.5 px-6 text-xs font-semibold flex items-center justify-center gap-2 group"
                >
                  <span>Contact Sales & Schedule Onboarding</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
                <div className="text-center">
                  <a
                    href="mailto:sales@pitchblackcyber.com?subject=Single%20Enclave%20License%20Inquiry"
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3 h-3 text-cyan-400" />
                    <span>Direct Invoice / PO: sales@pitchblackcyber.com</span>
                  </a>
                </div>
              </div>

            </div>
          </div>

          {/* TIER 2: MSP & Defense Assessor Multi-Enclave ($1,500/yr - FEATURED) */}
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
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-brand-400" />
                      <h3 className="text-xl font-bold text-white tracking-tight">MSP & Defense Assessor</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 text-[10px] font-bold border border-brand-500/30">
                      Multi-Tenant
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Multi-tenant platform for Managed Service Providers (MSPs), C3PAO assessors, and compliance consultants.
                  </p>
                </div>

                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-white">
                      $1,500
                    </span>
                    <span className="text-xs text-slate-400 font-medium">/ year flat</span>
                  </div>
                  <p className="text-[11px] text-emerald-400 font-mono font-semibold mt-1">
                    Unlimited client boundaries • Priority architecture support
                  </p>
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>Unlimited Client Organization Enclaves</strong></span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Multi-tenant Switcher with instant enclave context switching</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span><strong>Unlimited Assessor & Lead Auditor Team Seats</strong></span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Custom branding on exported SSP documents & SPRS reports</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Passwordless Magic Links for third-party C3PAO assessors</span>
                  </li>
                  <li className="flex items-center gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Dedicated CMMC solutions architect onboarding session</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5">
                <button
                  onClick={() => onSelectPlan('msp-assessor')}
                  className="btn-primary w-full py-3.5 px-6 text-xs font-bold flex items-center justify-center gap-2 group"
                >
                  <span>Schedule MSP Onboarding Call</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
                <div className="text-center">
                  <a
                    href="mailto:sales@pitchblackcyber.com?subject=MSP%20Multi-Enclave%20License%20Inquiry"
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3 h-3 text-cyan-400" />
                    <span>Direct Invoice / PO: sales@pitchblackcyber.com</span>
                  </a>
                </div>
              </div>

            </div>
          </div>

        </div>


      </div>
    </section>
  );
};
