import React, { useState, useEffect } from 'react';
import { ArrowRight, Lock, Menu, X, Sparkles, Cloud } from 'lucide-react';
import { BrandLogo } from '../common/BrandLogo';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';

interface LandingNavProps {
  onEnterApp: () => void;
  onLaunchSandbox?: () => void;
}

export const LandingNav: React.FC<LandingNavProps> = ({ onEnterApp, onLaunchSandbox }) => {
  const { isAuthenticated, openAuthModal, openLicenseModal } = useAuth();
  const { currentTenant } = useTenant();

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
        <button type="button" 
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="text-left flex items-center gap-3 cursor-pointer group"
        >
          <BrandLogo size="md" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base sm:text-lg tracking-tight text-white">Event Horizon: Singularity</span>
              <span className="text-xs uppercase font-bold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                Defense Enclave
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium tracking-wide">
              Pitch Black Cyber // Singularity GRC
            </p>
          </div>
        </button>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-8">
          <button 
            onClick={() => scrollToSection('features')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            Capabilities
          </button>
          <button 
            onClick={onLaunchSandbox ? onLaunchSandbox : () => scrollToSection('sandbox-demo')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 group"
          >
            <Sparkles className="w-3.5 h-3.5 text-brand-400 group-hover:scale-110 transition-transform" />
            Live Sandbox
          </button>
          <button 
            onClick={() => scrollToSection('pricing')} 
            className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
          >
            Pricing & Licensing
          </button>
          <button 
            onClick={() => scrollToSection('security')} 
            className="text-sm font-medium text-slate-300 hover:text-brand-300 transition-colors flex items-center gap-1.5"
          >
            <Cloud className="w-3.5 h-3.5 text-brand-400" />
            Security & GCP
          </button>
        </nav>

        {/* Action Buttons */}
        <div className="hidden sm:flex items-center gap-2.5">
          {isAuthenticated ? (
            /* Logged in state: Instant Enclave Link */
            <button
              onClick={onEnterApp}
              className="group relative inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-emerald-600 via-brand-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white text-xs font-semibold shadow-lg shadow-brand-500/25 ring-1 ring-white/20 active:scale-[0.98] transition-all duration-200"
            >
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span>Enter Enclave ({currentTenant.name.split(' ')[0]})</span>
              <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center group-hover:translate-x-0.5 transition-transform duration-200">
                <ArrowRight className="w-3 h-3 text-white" />
              </span>
            </button>
          ) : (
            /* Unauthenticated state: Sign In + Request License */
            <>
              <button
                onClick={() => openAuthModal('signin')}
                className="px-3.5 py-1.5 text-xs font-semibold text-slate-300 hover:text-white transition-colors flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5 text-slate-400" />
                <span>Sign In</span>
              </button>

              <button
                onClick={() => openLicenseModal('DEFENSE_PRO')}
                className="btn-primary text-xs px-4 py-2 flex items-center gap-1.5 shadow-lg shadow-cyan-500/20"
              >
                <span>Request License</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </>
          )}
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
              Pricing & Licensing
            </button>
            <button 
              onClick={() => { setMobileMenuOpen(false); scrollToSection('security'); }} 
              className="text-left text-base font-medium text-slate-200 py-2 border-b border-slate-800/50 flex items-center gap-2"
            >
              <Cloud className="w-4 h-4 text-brand-400" />
              DoD Cloud Security
            </button>
          </div>

          <div className="pt-2 flex flex-col gap-3">
            {isAuthenticated ? (
              <button
                onClick={() => { setMobileMenuOpen(false); onEnterApp(); }}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 via-brand-600 to-indigo-600 text-white font-semibold flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20"
              >
                <span>Enter Enclave</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <>
                <button
                  onClick={() => { setMobileMenuOpen(false); openAuthModal('signin'); }}
                  className="w-full py-3 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 font-semibold flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4 text-slate-400" />
                  Sign In to Enclave
                </button>
                <button
                  onClick={() => { setMobileMenuOpen(false); openLicenseModal('DEFENSE_PRO'); }}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 text-white font-semibold flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20"
                >
                  <span>Request License & Sales Call</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
