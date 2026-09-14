import React from 'react';
import { Check, Sparkles, ArrowRight, Zap, Shield, Building2, Mail, Award } from 'lucide-react';
import { LicenseTier } from '../../types/tenant';

interface PricingSectionProps {
  onSelectPlan: (planId: LicenseTier) => void;
}

export const PricingSection: React.FC<PricingSectionProps> = ({ onSelectPlan }) => {
  return (
    <section id="pricing" className="py-24 relative overflow-hidden">
      {/* Subtle background ambient glows */}
      <div className="absolute top-1/2 left-1/4 -translate-y-1/2 -translate-x-1/2 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 right-1/4 -translate-y-1/2 translate-x-1/2 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        
        {/* Header */}
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-semibold text-brand-300 shadow-inner">
            <Zap className="w-3.5 h-3.5 text-brand-400" />
            Enterprise Commercial Licensing
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
            Predictable Compliance Licensing
          </h2>
          <p className="text-base sm:text-lg text-slate-300 leading-relaxed">
            Transparent, flat annual licensing for defense contractors, prime suppliers, and assessor networks. No hidden per-seat fees or audit surprise surcharges.
          </p>
        </div>

        {/* Pricing Cards 3-Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">
          
          {/* TIER 1: Foundational Enclave ($3,500/yr) */}
          <div className="p-2 rounded-[2rem] bg-gradient-to-b from-slate-800/40 via-slate-900/30 to-slate-950/60 ring-1 ring-slate-800 shadow-xl flex flex-col justify-between transition-all duration-300 hover:ring-slate-700">
            <div className="h-full p-7 rounded-[calc(2rem-0.5rem)] bg-slate-950/90 border border-slate-800/80 flex flex-col justify-between space-y-7">
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Shield className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-xl font-bold text-white tracking-tight">Foundational Enclave</h3>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Target: Small Suppliers & Commercial Organizations (FAR 52.204-21, HIPAA, SOC 2 Type II)
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-800/80">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-white font-mono">
                      $3,500
                    </span>
                    <span className="text-xs text-slate-400 font-medium">/ year flat</span>
                  </div>
                  <p className="text-[11px] text-cyan-400 font-mono font-semibold mt-1">
                    Entry defense enclave • 1 boundary
                  </p>
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span><strong>1 Enclave Boundary</strong> (Cloud SQL RLS isolation)</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span><strong>CMMC Level 1 (17 Controls)</strong> or HIPAA / SOC 2</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span><strong>PDF Artifact Exporter</strong> with cryptographic evidence hashing</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span><strong>Single-User Owner</strong> administrative seat</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span>Standard Support & Architecture Knowledge Base</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5 pt-4 border-t border-slate-800/80">
                <button
                  onClick={() => onSelectPlan('FOUNDATIONAL')}
                  className="btn-secondary w-full py-3.5 px-5 text-xs font-semibold flex items-center justify-center gap-2 group"
                >
                  <span>Schedule Onboarding / Reserve Enclave</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform text-cyan-400" />
                </button>
                <div className="text-center">
                  <a
                    href="mailto:sales@pitchblackcyber.com?subject=Foundational%20Enclave%20License%20Inquiry"
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3 h-3 text-cyan-400" />
                    <span>Invoice / PO: sales@pitchblackcyber.com</span>
                  </a>
                </div>
              </div>

            </div>
          </div>

          {/* TIER 2: Defense Professional ($7,000/yr - RECOMMENDED / MOST POPULAR) */}
          <div className="relative p-2 rounded-[2rem] bg-gradient-to-b from-brand-500/50 via-indigo-600/35 to-slate-950/80 ring-2 ring-brand-500 shadow-2xl shadow-brand-500/25 flex flex-col justify-between transform lg:-translate-y-2 transition-transform duration-300">
            
            {/* Top Recommended / Most Popular Ribbon */}
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-gradient-to-r from-brand-500 via-indigo-500 to-brand-600 text-white text-[10px] font-extrabold uppercase tracking-wider shadow-lg flex items-center gap-1.5 whitespace-nowrap">
              <Sparkles className="w-3 h-3 text-amber-300" />
              Recommended / Most Popular
            </div>

            <div className="h-full p-7 rounded-[calc(2rem-0.5rem)] bg-slate-950/95 border border-brand-500/30 flex flex-col justify-between space-y-7">
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Award className="w-4 h-4 text-brand-400" />
                      <h3 className="text-xl font-bold text-white tracking-tight">Defense Professional</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 text-[10px] font-extrabold border border-brand-500/30 uppercase tracking-wider">
                      CUI Ready
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Target: DoD Prime & Sub-Contractors handling CUI (NIST SP 800-171 / CMMC Level 2)
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-800">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-white font-mono">
                      $7,000
                    </span>
                    <span className="text-xs text-slate-400 font-medium">/ year flat</span>
                  </div>
                  <p className="text-[11px] text-emerald-400 font-mono font-semibold mt-1">
                    Turnkey NIST SP 800-171 & CMMC Level 2 platform
                  </p>
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>CMMC Level 2 (110 Controls)</strong> & NIST SP 800-171</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>NIST SP 800-53 Rev 5</strong> (Low/Mod + Tactical Overlays)</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>DISA STIG Library</strong> & Ansible/PowerShell Script Generator</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>Dynamic NIST SP 800-18 SSP & POA&M Compiler</strong></span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>Cross-Framework Evidence Inheritance</strong> (AC-2 &rarr; CC6.1)</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span><strong>5 User Seats</strong> with RBAC & auditor view access</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5 pt-4 border-t border-slate-800">
                <button
                  onClick={() => onSelectPlan('DEFENSE_PRO')}
                  className="btn-primary w-full py-3.5 px-5 text-xs font-bold flex items-center justify-center gap-2 group shadow-lg shadow-brand-500/20"
                >
                  <span>Schedule Onboarding / Reserve Enclave</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
                <div className="text-center">
                  <a
                    href="mailto:sales@pitchblackcyber.com?subject=Defense%20Professional%20Enclave%20License%20Inquiry"
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3 h-3 text-cyan-400" />
                    <span>Invoice / PO: sales@pitchblackcyber.com</span>
                  </a>
                </div>
              </div>

            </div>
          </div>

          {/* TIER 3: Enterprise & Assessor Enclave ($14,000/yr) */}
          <div className="p-2 rounded-[2rem] bg-gradient-to-b from-purple-900/30 via-slate-900/30 to-slate-950/60 ring-1 ring-purple-500/30 shadow-xl flex flex-col justify-between transition-all duration-300 hover:ring-purple-500/60">
            <div className="h-full p-7 rounded-[calc(2rem-0.5rem)] bg-slate-950/90 border border-slate-800/80 flex flex-col justify-between space-y-7">
              
              <div className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-purple-400" />
                      <h3 className="text-xl font-bold text-white tracking-tight">Enterprise & Assessor</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 text-[10px] font-bold border border-purple-500/30 uppercase tracking-wide">
                      Multi-CAGE
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Target: Defense MSPs, Multi-CAGE Enterprise Organizations & C3PAO Assessor Networks
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-800/80">
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-black text-white font-mono">
                      $14,000
                    </span>
                    <span className="text-xs text-slate-400 font-medium">/ year flat</span>
                  </div>
                  <p className="text-[11px] text-purple-400 font-mono font-semibold mt-1">
                    Unlimited enclaves • Dedicated isolation & SLA
                  </p>
                </div>

                <ul className="space-y-3 text-xs text-slate-300">
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <span><strong>Unlimited Enclaves / Multi-Boundary Management</strong></span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <span><strong>OpenSCAP Engine</strong> & Asset Sensor API Integration</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <span><strong>Custom Baseline Overlays</strong> & Tailored Control Scopes</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <span><strong>Dedicated Database Isolation</strong> & Cloud SQL RLS</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <span><strong>Priority 24/7 Defense Engineering Support</strong> & SLA</span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5 pt-4 border-t border-slate-800/80">
                <button
                  onClick={() => onSelectPlan('ENTERPRISE')}
                  className="w-full py-3.5 px-5 text-xs font-bold rounded-xl bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/25 flex items-center justify-center gap-2 group transition-all"
                >
                  <span>Schedule Onboarding / Reserve Enclave</span>
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </button>
                <div className="text-center">
                  <a
                    href="mailto:sales@pitchblackcyber.com?subject=Enterprise%20Enclave%20License%20Inquiry"
                    className="text-[11px] text-slate-400 hover:text-cyan-300 transition-colors inline-flex items-center gap-1.5"
                  >
                    <Mail className="w-3 h-3 text-cyan-400" />
                    <span>Invoice / PO: sales@pitchblackcyber.com</span>
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
