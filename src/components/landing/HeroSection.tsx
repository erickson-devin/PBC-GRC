import React from 'react';
import {
  ShieldCheck,
  ArrowRight,
  FileText,
  CheckCircle2,
  Lock,
  Database,
  Sparkles,
  Fingerprint,
  ChevronRight
} from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';

interface HeroSectionProps {
  onExploreSandbox: () => void;
  onOpenSampleSsp: () => void;
  onEnterApp: () => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({
  onExploreSandbox,
  onOpenSampleSsp,
  onEnterApp
}) => {
  return (
    <section className="relative pt-32 pb-20 md:pt-40 md:pb-28 overflow-hidden">

      {/* Ambient background glow and grid mesh */}
      <div className="absolute inset-0 pointer-events-none -z-10">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[450px] bg-brand-500/10 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 left-1/4 w-[400px] h-[350px] bg-indigo-600/10 rounded-full blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:24px_24px] opacity-30 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,#000_70%,transparent_100%)]" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        {/* Central Hero Stack */}
        <div className="max-w-4xl mx-auto text-center space-y-6">

          {/* Brand Logo Emblem */}
          <div className="flex justify-center mb-2">
            <BrandLogo size="lg" showText={false} />
          </div>

          {/* Eyebrow Pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/90 border border-slate-700/80 shadow-lg shadow-black/40 backdrop-blur-md">
            <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-xs font-semibold text-slate-200 tracking-wide">
              Event Horizon: Singularity • DoD CMMC 2.0 & Defense GRC
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          </div>

          {/* Main Headline */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white tracking-tight leading-[1.1]">
            Automated CMMC 2.0 & <br className="hidden sm:inline" />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-brand-400 via-brand-300 to-indigo-300">
              NIST SP 800-171
            </span> Compliance Enclave
          </h1>

          {/* Subheadline (Clean, under 25 words) */}
          <p className="text-lg sm:text-xl text-slate-300 max-w-2xl mx-auto font-normal leading-relaxed">
            Streamline your 17 CMMC Level 1 controls, calculate real-time SPRS scores, and generate auditor-ready System Security Plans (SSPs) backed by Google Cloud Storage.
          </p>

          {/* Primary Action Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">

            {/* Primary Sandbox CTA */}
            <button
              onClick={onExploreSandbox}
              className="btn-primary w-full sm:w-auto group inline-flex items-center justify-center gap-3 px-7 py-3.5 rounded-full font-semibold text-base ring-1 ring-white/20"
            >
              <Sparkles className="w-4 h-4 text-brand-200" />
              <span>Launch Live Interactive Sandbox</span>
              <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center group-hover:translate-x-1 transition-transform duration-200">
                <ArrowRight className="w-3.5 h-3.5 text-white" />
              </span>
            </button>

            {/* Secondary Sample SSP CTA */}
            <button
              onClick={onOpenSampleSsp}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-full bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white font-semibold text-base shadow-lg transition-all duration-200"
            >
              <FileText className="w-4 h-4 text-brand-400" />
              <span>Generate Sample SSP</span>
            </button>
          </div>

          {/* Existing License Holder Link */}
          <div className="pt-0.5">
            <button
              onClick={onEnterApp}
              className="text-xs text-slate-400 hover:text-brand-300 font-medium transition-colors inline-flex items-center gap-1"
            >
              <span>Existing License Holder? Sign In to Enclave</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>

          {/* Trust Badges Bar */}
          <div className="pt-6 flex flex-wrap items-center justify-center gap-3 sm:gap-4 text-xs font-medium text-slate-300">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              FAR 52.204-21 Compliant
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <Database className="w-3.5 h-3.5 text-brand-400" />
              Google Cloud Secure
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <Fingerprint className="w-3.5 h-3.5 text-purple-400" />
              SHA-256 Verified Evidence
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
              CMMC 2.0 Ready
            </span>
          </div>

        </div>

        {/* Hero Double-Bezel Interactive Enclave Showcase Card */}
        <div className="mt-14 max-w-5xl mx-auto">
          {/* Outer Shell */}
          <div className="p-2 sm:p-3 rounded-[2rem] bg-gradient-to-b from-slate-700/40 via-slate-800/20 to-slate-900/40 ring-1 ring-white/10 shadow-2xl shadow-black/80 backdrop-blur-2xl">
            {/* Inner Core */}
            <div className="rounded-[calc(2rem-0.75rem)] bg-slate-950/95 border border-slate-800/80 overflow-hidden shadow-inner">

              {/* Window Bar */}
              <div className="px-4 py-3 bg-slate-900/80 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500/80" />
                  <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
                  <span className="ml-2 text-xs font-mono text-slate-400">
                    event-horizon://singularity/vanguard-defense-01/assessment
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    SPRS: 17/17 MET (100%)
                  </span>
                  <span className="hidden sm:inline-block text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                    gs://singularity-evidence-prod
                  </span>
                </div>
              </div>

              {/* Showcase Grid Preview */}
              <div className="p-5 sm:p-7 grid grid-cols-1 md:grid-cols-3 gap-5">

                {/* Panel 1: Live Status Gauge */}
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Compliance Readiness</span>
                    <span className="text-xs font-bold text-emerald-400">100% Score</span>
                  </div>
                  <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-brand-500 to-emerald-400 h-full w-full rounded-full" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                    <div className="bg-slate-950/70 p-2 rounded-lg border border-slate-800">
                      <div className="text-base font-extrabold text-emerald-400">17</div>
                      <div className="text-xs text-slate-400">MET</div>
                    </div>
                    <div className="bg-slate-950/70 p-2 rounded-lg border border-slate-800">
                      <div className="text-base font-extrabold text-slate-400">0</div>
                      <div className="text-xs text-slate-400">In Progress</div>
                    </div>
                    <div className="bg-slate-950/70 p-2 rounded-lg border border-slate-800">
                      <div className="text-base font-extrabold text-brand-400">15</div>
                      <div className="text-xs text-slate-400">FAR Clauses</div>
                    </div>
                  </div>
                </div>

                {/* Panel 2: Cryptographic Evidence Vault */}
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">GCS Evidence Vault</span>
                    <span className="text-xs font-mono text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">SHA-256 Validated</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="p-2 rounded-lg bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2 truncate">
                        <Lock className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                        <span className="truncate text-slate-200 font-mono text-xs">AC.1.001_m365_rbac.pdf</span>
                      </div>
                      <span className="text-xs font-mono text-emerald-400 shrink-0">e3b0c4...</span>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                      <div className="flex items-center gap-2 truncate">
                        <Fingerprint className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                        <span className="truncate text-slate-200 font-mono text-xs">IA.1.076_duo_mfa_audit.png</span>
                      </div>
                      <span className="text-xs font-mono text-emerald-400 shrink-0">7f83b1...</span>
                    </div>
                  </div>
                </div>

                {/* Panel 3: Automated SSP Document Export */}
                <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-400">System Security Plan</span>
                      <span className="text-xs font-semibold text-brand-400">NIST SP 800-171</span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Pre-compiled narratives for Microsoft 365, Active Directory & GCP Enclaves ready for C3PAO submission.
                    </p>
                  </div>
                  <button
                    onClick={onOpenSampleSsp}
                    className="w-full py-2 px-3 rounded-lg bg-slate-850 hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors group"
                  >
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Preview Sample SSP</span>
                    <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </button>
                </div>

              </div>

            </div>
          </div>
        </div>

      </div>
    </section>
  );
};
