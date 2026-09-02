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
import { useAuth } from '../../context/AuthContext';

interface LandingPageProps {
  onEnterApp: (tenantId?: string) => void;
  onLaunchSandbox: (tenantId?: string) => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onEnterApp, onLaunchSandbox, onOpenLegal }) => {
  const { setIsGcpArchitectureModalOpen, switchTenant } = useTenant();
  const { openLicenseModal, isAuthenticated } = useAuth();
  const [isSampleSspOpen, setIsSampleSspOpen] = useState(false);

  const handleLaunchWithTenant = (tenantId?: string) => {
    const target = tenantId || 'tenant-vanguard-01';
    switchTenant(target);
    onLaunchSandbox(target);
  };

  const handleGetStarted = () => {
    if (isAuthenticated) {
      onEnterApp();
    } else {
      openLicenseModal('single-org');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-brand-500 selection:text-white flex flex-col">
      {/* 1. Public Sticky/Floating Island Navigation */}
      <LandingNav 
        onEnterApp={() => onEnterApp()} 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)} 
        onLaunchSandbox={() => handleLaunchWithTenant('tenant-vanguard-01')}
      />

      {/* 2. Hero Section with Trust Badges & Showcase Card */}
      <HeroSection 
        onExploreSandbox={() => handleLaunchWithTenant('tenant-vanguard-01')}
        onOpenSampleSsp={() => setIsSampleSspOpen(true)}
        onEnterApp={handleGetStarted}
      />

      {/* 3. Core Capabilities Bento Grid */}
      <FeatureGrid 
        onEnterApp={handleGetStarted} 
      />

      {/* 4. Interactive Live Sandbox Section (1-Click Test Drive) */}
      <InteractiveSandbox 
        onLaunchFullApp={handleLaunchWithTenant}
      />

      {/* 5. Transparent Pricing & Tier Table ($1,000 / $1,500/yr) */}
      <PricingSection 
        onSelectPlan={(planId) => openLicenseModal(planId)} 
        onTestDriveSandbox={() => handleLaunchWithTenant('tenant-vanguard-01')}
      />

      {/* 6. Enterprise GCP Architecture & Security */}
      <GcpSecuritySection 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)} 
      />

      {/* 7. Footer */}
      <LandingFooter 
        onOpenGcpModal={() => setIsGcpArchitectureModalOpen(true)}
        onEnterApp={handleGetStarted}
        onOpenLegal={onOpenLegal || (() => {})}
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
