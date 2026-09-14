import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { TenantProvider, useTenant } from './context/TenantContext';
import { AuthProvider, useAuth } from './context/AuthContext';
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
import { LandingPage } from './components/landing/LandingPage';
import { LoginPage } from './components/auth/LoginPage';
import { AuthModal } from './components/auth/AuthModal';
import { LicenseRequestModal } from './components/auth/LicenseRequestModal';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LegalModal, LegalTab } from './components/common/LegalModal';
import { OnboardingModal } from './components/onboarding/OnboardingModal';
import { SuperAdminDashboard } from './components/admin/SuperAdminDashboard';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { TeamSettingsModal } from './components/settings/TeamSettingsModal';
import { StigAutomationModal } from './components/stigs/StigAutomationModal';
import { ArtifactExportModal } from './components/reports/ArtifactExportModal';

type AppRoute = 'landing' | 'login' | 'app' | 'demo' | 'admin' | 'accept-invite';

const AppContent: React.FC = () => {
  const { activeTab, isExportModalOpen, setIsExportModalOpen } = useAssessment();
  const { openLicenseModal } = useAuth();
  const {
    currentTenant,
    switchTenant,
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    needsOnboarding,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
  } = useTenant();

  // Legal Modal State (Privacy Policy & Terms of Service)
  const [legalModalState, setLegalModalState] = useState<{
    isOpen: boolean;
    tab: LegalTab;
  }>({
    isOpen: false,
    tab: 'privacy',
  });

  const openLegalModal = useCallback((tab: LegalTab = 'privacy') => {
    setLegalModalState({ isOpen: true, tab });
  }, []);

  const closeLegalModal = useCallback(() => {
    setLegalModalState(prev => ({ ...prev, isOpen: false }));
    // If the hash was #privacy or #terms, reset it cleanly
    if (typeof window !== 'undefined' && (window.location.hash === '#privacy' || window.location.hash === '#terms')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const getRouteFromUrl = (): AppRoute => {
    if (typeof window === 'undefined') return 'landing';
    const path = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    const search = window.location.search.toLowerCase();

    if (path === '/admin' || hash.startsWith('#admin') || search.includes('view=admin')) {
      return 'admin';
    }
    if (path === '/accept-invite' || hash.startsWith('#accept-invite') || search.includes('view=accept-invite')) {
      return 'accept-invite';
    }
    if (path === '/login' || hash.startsWith('#login') || search.includes('view=login')) {
      return 'login';
    }
    if (
      path === '/demo' ||
      path === '/sandbox' ||
      hash.startsWith('#demo') ||
      hash.startsWith('#sandbox') ||
      search.includes('mode=sandbox') ||
      search.includes('view=demo')
    ) {
      return 'demo';
    }
    if (
      path === '/app' ||
      path === '/dashboard' ||
      hash.startsWith('#app') ||
      search.includes('view=app')
    ) {
      return 'app';
    }
    return 'landing';
  };

  const [currentRoute, setCurrentRoute] = useState<AppRoute>(getRouteFromUrl);

  // Sync route on popstate and hashchange
  useEffect(() => {
    const handleNavigation = () => {
      const hash = window.location.hash.toLowerCase();
      const path = window.location.pathname.toLowerCase();
      if (hash === '#privacy' || path === '/privacy' || path === '/privacy-policy') {
        openLegalModal('privacy');
      } else if (hash === '#terms' || path === '/terms' || path === '/terms-of-service') {
        openLegalModal('terms');
      }

      if (hash === '#settings/team' || hash === '#team' || path.includes('/settings/team')) {
        setIsTeamModalOpen(true);
      }

      const nextRoute = getRouteFromUrl();
      setCurrentRoute(nextRoute);
      if (nextRoute === 'demo') {
        // Enforce clean sandbox mode guard
        setIsOnboardingModalOpen(false);
        // Automatically ensure primary demo tenant is active
        switchTenant('tenant-vanguard-01');
      }
    };


    // Initial check for deep-linked legal path or hash
    if (typeof window !== 'undefined') {
      const initialHash = window.location.hash.toLowerCase();
      const initialPath = window.location.pathname.toLowerCase();
      if (initialHash === '#privacy' || initialPath === '/privacy' || initialPath === '/privacy-policy') {
        openLegalModal('privacy');
      } else if (initialHash === '#terms' || initialPath === '/terms' || initialPath === '/terms-of-service') {
        openLegalModal('terms');
      }
    }

    window.addEventListener('hashchange', handleNavigation);
    window.addEventListener('popstate', handleNavigation);
    return () => {
      window.removeEventListener('hashchange', handleNavigation);
      window.removeEventListener('popstate', handleNavigation);
    };
  }, [switchTenant, openLegalModal, setIsOnboardingModalOpen]);

  const navigateToApp = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.hash = 'app';
    }
    setCurrentRoute('app');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigateToSandbox = useCallback((tenantId: string = 'tenant-vanguard-01') => {
    setIsOnboardingModalOpen(false);
    switchTenant(tenantId);
    if (typeof window !== 'undefined') {
      window.location.hash = 'demo';
    }
    setCurrentRoute('demo');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [switchTenant, setIsOnboardingModalOpen]);

  const navigateToLanding = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.hash = '';
    }
    setCurrentRoute('landing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigateToLogin = useCallback((redirectUrl: string = '/app') => {
    if (typeof window !== 'undefined') {
      window.location.hash = `login?redirectUrl=${encodeURIComponent(redirectUrl)}`;
    }
    setCurrentRoute('login');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <>
      {/* 1. Standalone Login Page Route */}
      {currentRoute === 'login' && (
        <LoginPage
          onSuccessRedirect={navigateToApp}
          onExitToLanding={navigateToLanding}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* 2. Public B2B Landing Page Route */}
      {currentRoute === 'landing' && (
        <LandingPage
          onEnterApp={navigateToApp}
          onLaunchSandbox={navigateToSandbox}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* 3. Direct 1-Click Interactive Sandbox Demo Route (/demo or /sandbox) - Zero Auth Guards */}
      {currentRoute === 'demo' && (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
          {/* Persistent Live Demo Sandbox Top Banner */}
          <div className="bg-gradient-to-r from-amber-500/20 via-brand-600/25 to-indigo-600/20 border-b border-amber-500/30 px-3 sm:px-6 py-2.5 text-xs flex flex-col sm:flex-row items-center justify-between gap-3 shadow-lg backdrop-blur-md sticky top-0 z-50">
            <div className="flex items-center gap-2 text-center sm:text-left flex-wrap justify-center sm:justify-start">
              <span className="px-2.5 py-0.5 rounded-full bg-amber-500/25 text-amber-300 font-extrabold border border-amber-500/40 text-[10px] uppercase tracking-wider flex items-center gap-1 shrink-0 shadow-sm">
                <Sparkles className="w-3 h-3 text-amber-300 animate-pulse" />
                Live Demo Sandbox
              </span>
              <span className="text-slate-200 text-xs">
                LIVE DEMO SANDBOX — Exploring <strong className="text-white">{currentTenant.name}</strong> (CMMC Level 1 Readiness: <strong className="text-emerald-400">100% Met • 17/17 Controls</strong>)
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => openLicenseModal('DEFENSE_PRO')}
                className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-400 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-brand-500/25 flex items-center gap-1.5 transition-all active:scale-[0.98]"
              >
                <Sparkles className="w-3 h-3 text-amber-300" />
                <span>Request Enclave License</span>
                <ArrowRight className="w-3 h-3" />
              </button>
              <button
                onClick={navigateToLanding}
                className="px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-semibold border border-slate-700 transition-colors"
              >
                Exit Sandbox
              </button>
            </div>
          </div>

          {/* Top Application Header */}
          <Header 
            onExitToLanding={navigateToLanding}
            isSandboxMode={true}
            onRequestLicense={() => openLicenseModal('DEFENSE_PRO')}
          />

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

          {/* Enclave Modals */}
          <ControlDetailModal />
          <EvidencePreviewModal />
        </div>
      )}

      {/* 4. Protected Production CMMC Defense Enclave Route (/app or /dashboard) */}
      {currentRoute === 'app' && (
        <ProtectedRoute onRedirectToLogin={navigateToLogin}>
          <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
            {/* Top Application Header */}
            <Header onExitToLanding={navigateToLanding} />

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

            {/* Enclave Modals */}
            <ControlDetailModal />
            <EvidencePreviewModal />
          </div>
        </ProtectedRoute>
      )}

      {/* 5. Super Admin Tenant Provisioning Dashboard (/admin) */}
      {currentRoute === 'admin' && (
        <SuperAdminDashboard
          onNavigateToApp={navigateToApp}
          onNavigateToLanding={navigateToLanding}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* 6. Token Acceptance & Onboarding Public Route (/accept-invite) */}
      {currentRoute === 'accept-invite' && (
        <AcceptInvitePage
          onSuccessNavigate={navigateToApp}
          onExitToLanding={navigateToLanding}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* Global Authentication, Onboarding, Team Management & Legal Modals */}
      <AuthModal onOpenLegal={openLegalModal} />
      <LicenseRequestModal onOpenLegal={openLegalModal} />
      <LegalModal
        isOpen={legalModalState.isOpen}
        initialTab={legalModalState.tab}
        onClose={closeLegalModal}
      />
      <OnboardingModal
        isOpen={currentRoute === 'app' && (isOnboardingModalOpen || needsOnboarding)}
        onClose={() => setIsOnboardingModalOpen(false)}
      />
      <TeamSettingsModal
        isOpen={isTeamModalOpen}
        onClose={() => setIsTeamModalOpen(false)}
      />
      <StigAutomationModal
        isOpen={isStigModalOpen}
        onClose={() => setIsStigModalOpen(false)}
      />
      <ArtifactExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
      />
    </>
  );
};

export const App: React.FC = () => {
  return (
    <TenantProvider>
      <AuthProvider>
        <AssessmentProvider>
          <AppContent />
        </AssessmentProvider>
      </AuthProvider>
    </TenantProvider>
  );
};

export default App;
