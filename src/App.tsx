import React, { useState, useEffect, useCallback } from 'react';
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
import { InspectDocumentModal } from './components/matrix/InspectDocumentModal';
import { EvidencePreviewModal } from './components/common/EvidencePreviewModal';
import { LoginPage } from './components/auth/LoginPage';
import { AuthModal } from './components/auth/AuthModal';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LegalModal, LegalTab } from './components/common/LegalModal';
import { OnboardingModal } from './components/onboarding/OnboardingModal';
import { SuperAdminDashboard } from './components/admin/SuperAdminDashboard';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { SetupPage } from './pages/SetupPage';
import { ApiClient } from './services/apiClient';
import { TeamSettingsModal } from './components/settings/TeamSettingsModal';
import { StigAutomationModal } from './components/stigs/StigAutomationModal';
import { ArtifactExportModal } from './components/reports/ArtifactExportModal';
import { AuditTrailViewer } from './components/audit/AuditTrailViewer';
import { AssetInventoryManager } from './components/telemetry/AssetInventoryManager';
import { EnclaveStackSurveyModal } from './components/admin/EnclaveStackSurveyModal';
import { EnclaveSettings } from './components/settings/EnclaveSettings';
import { PolicyLibraryView } from './views/PolicyLibraryView';
import { ErrorBoundary } from './components/common/ErrorBoundary';


import { AppRoute, resolveRoot, routeFromUrl } from './utils/appRoute';
const AppContent: React.FC = () => {
  const { activeTab, setActiveTab, isExportModalOpen, setIsExportModalOpen } = useAssessment();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const {
    isOnboardingModalOpen,
    setIsOnboardingModalOpen,
    needsOnboarding,
    isTeamModalOpen,
    setIsTeamModalOpen,
    isStigModalOpen,
    setIsStigModalOpen,
    isStackSurveyModalOpen,
    setIsStackSurveyModalOpen,
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

  const getRouteFromUrl = (): AppRoute =>
    typeof window === 'undefined'
      ? 'root'
      : routeFromUrl({ pathname: window.location.pathname, hash: window.location.hash, search: window.location.search });

  const [currentRoute, setCurrentRoute] = useState<AppRoute>(getRouteFromUrl);

  // First-time setup. On boot the server says whether this installation still has no administrator; if so EVERY route
  // is the setup wizard, and once an administrator exists the wizard route does not exist any more (it resolves like
  // any unknown path). The server enforces the same rule, so this is only the user-facing half of the lockdown.
  const [setup, setSetup] = useState<{ state: 'checking' | 'required' | 'done'; tokenRequired: boolean }>({ state: 'checking', tokenRequired: false });
  useEffect(() => {
    let cancelled = false;
    ApiClient.getSetupStatus().then((status) => {
      if (cancelled) return;
      setSetup({ state: status?.setupRequired ? 'required' : 'done', tokenRequired: Boolean(status?.tokenRequired) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [openLegalModal, setIsTeamModalOpen]);

  useEffect(() => {
    if (setup.state === 'required' && currentRoute !== 'setup') {
      window.history.replaceState(null, '', '/#setup');
      setCurrentRoute('setup');
    } else if (setup.state === 'done' && currentRoute === 'setup') {
      setCurrentRoute('root'); // no wizard once an administrator exists: resolved like any unknown path
    }
  }, [setup.state, currentRoute]);

  const finishSetup = useCallback(() => {
    setSetup({ state: 'done', tokenRequired: false });
    window.history.replaceState(null, '', '/#app');
    setCurrentRoute('app');
    window.scrollTo({ top: 0 });
  }, []);

  // Unknown paths (and /) never show a page of their own: they go to the app when signed in, to the login page otherwise.
  useEffect(() => {
    if (currentRoute !== 'root' || authLoading || setup.state === 'checking') return;
    const next = resolveRoot(isAuthenticated);
    window.history.replaceState(null, '', next === 'app' ? '/#app' : '/#login');
    setCurrentRoute(next);
  }, [currentRoute, authLoading, isAuthenticated, setup.state]);

  const navigateToApp = useCallback(() => {
    // Always back to the site root: with a path like /login still in the URL, "/login#app" would resolve to the login page
    if (typeof window !== 'undefined') window.history.pushState(null, '', '/#app');
    setCurrentRoute('app');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigateToLogin = useCallback((redirectUrl: string = '/app') => {
    if (typeof window !== 'undefined') window.history.pushState(null, '', `/#login?redirectUrl=${encodeURIComponent(redirectUrl)}`);
    setCurrentRoute('login');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <>
      {/* 0a. Waiting for the server to say whether this installation still needs its first administrator */}
      {setup.state === 'checking' && (
        <div role="status" aria-live="polite" className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
          Loading…
        </div>
      )}

      {/* 0b. First-time setup wizard (/setup): only exists while there is no administrator */}
      {setup.state === 'required' && currentRoute === 'setup' && (
        <SetupPage tokenRequired={setup.tokenRequired} onFinished={finishSetup} onOpenLegal={openLegalModal} />
      )}

      {/* 0. Resolving /, or an unknown path, to the app or the login page */}
      {setup.state === 'done' && currentRoute === 'root' && (
        <div role="status" aria-live="polite" className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
          Loading…
        </div>
      )}

      {/* 1. Standalone Login Page Route */}
      {setup.state === 'done' && currentRoute === 'login' && (
        <LoginPage
          onSuccessRedirect={navigateToApp}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* 4. Protected Production CMMC Defense Enclave Route (/app or /dashboard) */}
      {setup.state === 'done' && currentRoute === 'app' && (
        <ProtectedRoute onRedirectToLogin={navigateToLogin}>
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
                {(activeTab === 'matrix' || activeTab === 'controls') && <ControlsList />}
                {activeTab === 'assets' && (
                  <div className="space-y-4">
                    {/* Accretion Discovery Engine Banner */}
                    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-sm">
                      <span className="flex h-2.5 w-2.5 relative">
                        <span className="animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
                      </span>
                      <span>
                        <strong className="text-cyan-100">Accretion Discovery Engine:</strong>{' '}
                        Discovery results are ingested at{' '}
                        <code className="px-1.5 py-0.5 rounded bg-cyan-950/60 text-cyan-300 font-mono text-xs">/api/v1/tenants/:id/assets/discovery</code>
                      </span>
                    </div>
                    <AssetInventoryManager />
                  </div>
                )}
                {activeTab === 'ssp' && <SSPBuilder />}
                {activeTab === 'policies' && <PolicyLibraryView />}
                {(activeTab === 'evidence' || activeTab === 'vault') && <EvidenceVaultView />}
                {activeTab === 'poam' && <ArtifactExportModal isOpen={true} onClose={() => setActiveTab('dashboard')} initialDocType="POAM" embedded />}
                {activeTab === 'export' && <ArtifactExportModal isOpen={true} onClose={() => setActiveTab('dashboard')} embedded />}
                {activeTab === 'rbac' && <TeamSettingsModal isOpen={true} onClose={() => setActiveTab('dashboard')} embedded />}
                {(activeTab === 'audit_logs' || activeTab === 'audit') && <AuditTrailViewer />}
                {activeTab === 'guidance' && <AssessmentGuidanceView />}
                {activeTab === 'settings' && <EnclaveSettings />}
              </main>
            </div>

            {/* Enclave Modals */}
            <InspectDocumentModal />
            <EvidencePreviewModal />
          </div>
        </ProtectedRoute>
      )}

      {/* 5. Platform administration: tenant provisioning (/admin) */}
      {setup.state === 'done' && currentRoute === 'admin' && (
        <SuperAdminDashboard
          onNavigateToApp={navigateToApp}
          onNavigateToLogin={navigateToLogin}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* 6. Token Acceptance & Onboarding Route (/invite or /accept-invite) */}
      {setup.state === 'done' && currentRoute === 'accept-invite' && (
        <AcceptInvitePage
          onSuccessNavigate={navigateToApp}
          onNavigateToLogin={navigateToLogin}
          onOpenLegal={openLegalModal}
        />
      )}

      {/* Global Authentication, Onboarding, Team Management & Legal Modals */}
      <AuthModal onOpenLegal={openLegalModal} />
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
      <EnclaveStackSurveyModal
        isOpen={isStackSurveyModalOpen}
        onClose={() => setIsStackSurveyModalOpen(false)}
      />
    </>
  );
};

export const App: React.FC = () => {
  return (
    <ErrorBoundary name="Application" variant="root">
      <TenantProvider>
        <AuthProvider>
          <AssessmentProvider>
            <AppContent />
          </AssessmentProvider>
        </AuthProvider>
      </TenantProvider>
    </ErrorBoundary>
  );
};

export default App;
