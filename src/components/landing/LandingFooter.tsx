import React from 'react';
import { Mail, ExternalLink, Lock, ArrowUp } from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';

interface LandingFooterProps {
  onEnterApp: () => void;
  onOpenLegal: (tab: 'privacy' | 'terms') => void;
}

export const LandingFooter: React.FC<LandingFooterProps> = ({ onEnterApp, onOpenLegal }) => {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <footer className="bg-slate-950 border-t border-slate-900 pt-16 pb-12 text-slate-400 text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Main Footer Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10 pb-12 border-b border-slate-900">
          
          {/* Col 1: Brand & Bio */}
          <div className="space-y-4 md:col-span-1">
            <div className="flex items-center gap-2.5">
              <BrandLogo size="sm" />
              <span className="font-extrabold text-sm sm:text-base text-white tracking-tight">Event Horizon: Singularity</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Central Governance & Compliance Engine by Pitch Black Cyber. DoD-grade CMMC 2.0 Level 1 compliance enclave and automated System Security Plan (SSP) engine.
            </p>
            <div className="flex items-center gap-2 text-slate-300">
              <Mail className="w-3.5 h-3.5 text-brand-400" />
              <a href="mailto:support@pitchblackcyber.com" className="hover:text-white transition-colors">
                support@pitchblackcyber.com
              </a>
            </div>
          </div>

          {/* Col 2: Platform Navigation */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">Platform</h4>
            <ul className="space-y-2">
              <li>
                <a href="#features" className="hover:text-white transition-colors">17 Controls Engine</a>
              </li>
              <li>
                <a href="#sandbox-demo" className="hover:text-white transition-colors">Interactive Sandbox</a>
              </li>
              <li>
                <a href="#pricing" className="hover:text-white transition-colors">Licensing & Tiers</a>
              </li>
              <li>
                <a href="#security" className="hover:text-white transition-colors">
                  Security Infrastructure
                </a>
              </li>
              <li>
                <button onClick={onEnterApp} className="hover:text-brand-300 transition-colors text-left font-semibold text-brand-400">
                  Launch Enclave App
                </button>
              </li>
            </ul>
          </div>

          {/* Col 3: Compliance & DoD Standards */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">Standards & Authorities</h4>
            <ul className="space-y-2">
              <li>
                <a 
                  href="https://www.acquisition.gov/far/52.204-21" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="hover:text-white transition-colors flex items-center gap-1"
                >
                  <span>FAR 52.204-21 Clause</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
              <li>
                <a 
                  href="https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="hover:text-white transition-colors flex items-center gap-1"
                >
                  <span>NIST SP 800-171 Rev 2</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
              <li>
                <a 
                  href="https://dodcio.defense.gov/CMMC/" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="hover:text-white transition-colors flex items-center gap-1"
                >
                  <span>DoD CIO CMMC 2.0 Portal</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
              <li>
                <a 
                  href="https://www.sprs.csd.disa.mil/" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="hover:text-white transition-colors flex items-center gap-1"
                >
                  <span>SPRS Scoring Portal (DISA)</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
            </ul>
          </div>

          {/* Col 4: Trust & Cloud Enclave */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">Cloud Governance</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Google Cloud Storage evidence enclaves with client-side SHA-256 validation. Logical multi-tenant isolation with Cloud SQL Row-Level Security.
            </p>
            <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center gap-2 text-xs text-emerald-400">
              <Lock className="w-3.5 h-3.5" />
              <span>TLS 1.3 & SHA-256 Verified</span>
            </div>
            <ul className="space-y-1 pt-1 text-xs">
              <li>
                <button
                  onClick={() => onOpenLegal('privacy')}
                  className="hover:text-white transition-colors text-slate-400 flex items-center gap-1"
                >
                  <span>Privacy Policy</span>
                </button>
              </li>
              <li>
                <button
                  onClick={() => onOpenLegal('terms')}
                  className="hover:text-white transition-colors text-slate-400 flex items-center gap-1"
                >
                  <span>Terms of Service</span>
                </button>
              </li>
            </ul>
          </div>

        </div>

        {/* Bottom Legal & Copyright Bar */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} Pitch Black Cyber, LLC. All rights reserved. CMMC is a registered trademark of the Cyber AB / DoD.
          </p>

          <div className="flex items-center gap-4 text-xs text-slate-400">
            <button
              onClick={() => onOpenLegal('privacy')}
              className="hover:text-white transition-colors hover:underline"
            >
              Privacy Policy
            </button>
            <span className="text-slate-700">•</span>
            <button
              onClick={() => onOpenLegal('terms')}
              className="hover:text-white transition-colors hover:underline"
            >
              Terms of Service
            </button>
          </div>

          <button
            onClick={scrollToTop}
            className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800 transition-colors flex items-center gap-1.5 text-xs font-medium"
          >
            <span>Back to Top</span>
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </div>

      </div>
    </footer>
  );
};
