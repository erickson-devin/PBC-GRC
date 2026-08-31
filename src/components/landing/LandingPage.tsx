import React, { useState } from 'react';
import { LandingNav } from './LandingNav';
import { HeroSection } from './HeroSection';
import { FeatureGrid } from './FeatureGrid';
import { InteractiveSandbox } from './InteractiveSandbox';
import { PricingSection } from './PricingSection';
import { GcpSecuritySection } from './GcpSecuritySection';
import { LandingFooter } from './LandingFooter';
import { SampleSspModal } from './SampleSspModal';
import { GcpArchitectureModal } from '../common/GcpArchitectureModal';
import { useTenant } from '../../context/TenantContext';

interface LandingPageProps {
  onEnterApp: (tenantId?: string) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterApp }) => {
  const { setIsGcpArchitectureModalOpen, switchTenant } = useTenant();
  const [isSampleSspOpen, setIsSampleSspOpen] = useState(false);

  const handleLaunchWithTenant = (tenantId?: string) => {
    if (tenantId) {
      switchTenant(tenantId);
    }
    onEnterApp(tenantId);
  };

  const handleScrollToSandbox = () => {
    const el = document.getElementById('sandbox-demo');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-brand-500 selection:text-white flex flex-col">
      {/* 1. Public Sticky/Floating Island Navigation */}
      <LandingNav 
        onEnterApp={() => onEnterApp()} 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)} 
      />

      {/* 2. Hero Section with Trust Badges & Showcase Card */}
      <HeroSection 
        onExploreSandbox={handleScrollToSandbox}
        onOpenSampleSsp={() => setIsSampleSspOpen(true)}
        onEnterApp={() => onEnterApp()}
      />

      {/* 3. Core Capabilities Bento Grid */}
      <FeatureGrid 
        onEnterApp={() => onEnterApp()} 
      />

      {/* 4. Interactive Live Sandbox Section (1-Click Test Drive) */}
      <InteractiveSandbox 
        onLaunchFullApp={handleLaunchWithTenant}
      />

      {/* 5. Transparent Pricing & Tier Table */}
      <PricingSection 
        onSelectPlan={(_planId) => onEnterApp()} 
      />

      {/* 6. Enterprise GCP Architecture & Security */}
      <GcpSecuritySection 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)} 
      />

      {/* 7. Footer */}
      <LandingFooter 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)}
        onEnterApp={() => onEnterApp()}
      />

      {/* Sample SSP Modal */}
      <SampleSspModal 
        isOpen={isSampleSspOpen} 
        onClose={() => setIsSampleSspOpen(false)}
        onEnterApp={() => {
          setIsSampleSspOpen(false);
          onEnterApp();
        }}
      />

      {/* Global GCP Architecture Diagram Modal */}
      <GcpArchitectureModal />
    </div>
  );
};
