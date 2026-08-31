import React, { useState, useEffect } from 'react';
import { TenantProvider } from './context/TenantContext';
import { AssessmentProvider, useAssessment } from './context/AssessmentContext';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { ComplianceOverview } from './components/dashboard/ComplianceOverview';
import { ControlsList } from './components/controls/ControlsList';
import { SSPBuilder } from './components/ssp/SSPBuilder';
import { EvidenceVaultView } from './components/vault/EvidenceVaultView';
import { AssessmentGuidanceView } from './components/guidance/AssessmentGuidanceView';
import { ControlDetailModal } from './components/controls/ControlDetailModal';
import { EvidencePreviewModal } from './components/common/EvidencePreviewModal';
import { GcpArchitectureModal } from './components/common/GcpArchitectureModal';
import { LandingPage } from './components/landing/LandingPage';

const AppContent: React.FC = () => {
  const { activeTab } = useAssessment();
  const [viewMode, setViewMode] = useState<'landing' | 'app'>(() => {
    // If URL contains #app or query param ?app=true, direct to app
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      const params = new URLSearchParams(window.location.search);
      if (hash === '#app' || params.get('view') === 'app') {
        return 'app';
      }
    }
    return 'landing';
  });

  // Sync hash changes
  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash === '#app') {
        setViewMode('app');
      } else if (window.location.hash === '#landing' || !window.location.hash) {
        setViewMode('landing');
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleEnterApp = () => {
    window.location.hash = 'app';
    setViewMode('app');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleExitToLanding = () => {
    window.location.hash = '';
    setViewMode('landing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // If in Landing Page Mode
  if (viewMode === 'landing') {
    return <LandingPage onEnterApp={handleEnterApp} />;
  }

  // If in Authenticated/Active Enclave App Mode
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
      {/* Top Application Header */}
      <Header onExitToLanding={handleExitToLanding} />

      {/* Main Workspace Layout */}
      <div className="flex-1 flex flex-col md:flex-row max-w-7xl w-full mx-auto">
        {/* Navigation Sidebar */}
        <Sidebar />

        {/* Dynamic Tab Content Area */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto min-w-0">
          {activeTab === 'dashboard' && <ComplianceOverview />}
          {activeTab === 'controls' && <ControlsList />}
          {activeTab === 'ssp' && <SSPBuilder />}
          {activeTab === 'vault' && <EvidenceVaultView />}
          {activeTab === 'guidance' && <AssessmentGuidanceView />}
        </main>
      </div>

      {/* Global Slide-overs and Modals */}
      <ControlDetailModal />
      <EvidencePreviewModal />
      <GcpArchitectureModal />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <TenantProvider>
      <AssessmentProvider>
        <AppContent />
      </AssessmentProvider>
    </TenantProvider>
  );
};

export default App;
