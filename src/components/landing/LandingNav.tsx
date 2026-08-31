import React, { useState, useEffect } from 'react';
import { ShieldCheck, ArrowRight, Lock, Menu, X, Sparkles, Cloud } from 'lucide-react';

interface LandingNavProps {
  onEnterApp: () => void;
  onOpenGcpModal: () => void;
}

export const LandingNav: React.FC<LandingNavProps> = ({ onEnterApp, onOpenGcpModal }) => {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <header 
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled 
          ? 'bg-slate-950/85 backdrop-blur-xl border-b border-slate-800/80 shadow-2xl shadow-slate-950/50 py-3' 
          : 'bg-transparent py-5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        
        {/* Brand Logo */}
        <div 
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="flex items-center gap-3 cursor-pointer group"
        >
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 via-brand-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-brand-500/25 ring-1 ring-white/20 group-hover:scale-105 transition-transform duration-300">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-lg tracking-tight text-white">PBC-GRC</span>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-brand-500/15 text-brand-300 border border-brand-500/30">
                Defense Enclave
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium tracking-wide">
              Pitch Black Cyber • CMMC 2.0 L1
            </p>
          </div>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-8">
          <button 
            onClick={() => scrollToSection('features')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            Capabilities
          </button>
          <button 
            onClick={() => scrollToSection('sandbox-demo')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5 text-brand-400" />
            Live Sandbox
          </button>
          <button 
            onClick={() => scrollToSection('pricing')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            Pricing
          </button>
          <button 
            onClick={onOpenGcpModal} 
            className="text-sm font-medium text-slate-300 hover:text-brand-300 transition-colors flex items-center gap-1.5"
          >
            <Cloud className="w-3.5 h-3.5 text-brand-400" />
            Security & GCP
          </button>
        </nav>

        {/* Action Buttons */}
        <div className="hidden sm:flex items-center gap-3">
          <button
            onClick={onEnterApp}
            className="px-4 py-2 text-sm font-semibold text-slate-300 hover:text-white transition-colors flex items-center gap-1.5"
          >
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            Sign In
          </button>

          {/* Primary CTA - Island button architecture */}
          <button
            onClick={onEnterApp}
            className="group relative inline-flex items-center gap-2.5 px-5 py-2.5 rounded-full bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-400 hover:to-indigo-500 text-white text-sm font-semibold shadow-lg shadow-brand-500/25 ring-1 ring-white/20 active:scale-[0.98] transition-all duration-200"
          >
            <span>Get Started</span>
            <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center group-hover:translate-x-0.5 transition-transform duration-200">
              <ArrowRight className="w-3.5 h-3.5 text-white" />
            </span>
          </button>
        </div>

        {/* Mobile Hamburger Toggle */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white"
          aria-label="Toggle Navigation Menu"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile Menu Dropdown */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-slate-950/95 backdrop-blur-2xl border-b border-slate-800 px-6 py-6 space-y-4 shadow-2xl">
          <div className="flex flex-col space-y-3">
            <button 
              onClick={() => scrollToSection('features')} 
              className="text-left text-base font-medium text-slate-200 py-2 border-b border-slate-800/50"
            >
              Capabilities
            </button>
            <button 
              onClick={() => scrollToSection('sandbox-demo')} 
              className="text-left text-base font-medium text-slate-200 py-2 border-b border-slate-800/50 flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4 text-brand-400" />
              Live Interactive Sandbox
            </button>
            <button 
              onClick={() => scrollToSection('pricing')} 
              className="text-left text-base font-medium text-slate-200 py-2 border-b border-slate-800/50"
            >
              Pricing & Plans
            </button>
            <button 
              onClick={() => { setMobileMenuOpen(false); onOpenGcpModal(); }} 
              className="text-left text-base font-medium text-slate-200 py-2 border-b border-slate-800/50 flex items-center gap-2"
            >
              <Cloud className="w-4 h-4 text-brand-400" />
              GCP Security Architecture
            </button>
          </div>

          <div className="pt-2 flex flex-col gap-3">
            <button
              onClick={() => { setMobileMenuOpen(false); onEnterApp(); }}
              className="w-full py-3 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 font-semibold flex items-center justify-center gap-2"
            >
              <Lock className="w-4 h-4 text-slate-400" />
              Sign In to Enclave
            </button>
            <button
              onClick={() => { setMobileMenuOpen(false); onEnterApp(); }}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 text-white font-semibold flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20"
            >
              <span>Get Started</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
