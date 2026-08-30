import React from 'react';
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

const AppContent: React.FC = () => {
  const { activeTab } = useAssessment();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
      {/* Top Application Header */}
      <Header />

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
