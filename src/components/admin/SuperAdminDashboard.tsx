import { assetBackendMode, getAssetBackend } from '../../services/assetService';
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Shield,
  Building2,
  Users,
  Key,
  Plus,
  Copy,
  Check,
  ExternalLink,
  RotateCw,
  Trash2,
  Lock,
  Search,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Clock,
  ArrowUpRight,
  ArrowLeft,
  MoreVertical,
  Edit3,
  Download,
  PauseCircle,
  PlayCircle,
  AlertTriangle,
  CalendarPlus,
  Flame,
  FileCheck2,
  X,
  ShieldCheck,
} from 'lucide-react';
import { useTenant, buildInviteUrl } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { BrandLogo } from '../common/BrandLogo';
import { Tenant, TenantInvitation } from '../../types/tenant';
import { frameworkLabel, programSummary } from '../../data/programs';
import { ApiClient, ApiError, type LocalAccount } from '../../services/apiClient';
import { ErrorNotice } from '../common/ErrorNotice';
import { NewTenantModal } from './NewTenantModal';
import { EditEnclaveModal } from './EditEnclaveModal';
import { EditInvitationModal } from './EditInvitationModal';
import { FinanceProvisioningLog } from './FinanceProvisioningLog';
import {
  generateEnclaveHandoverPackage,
  executeCryptographicDestruction,
} from '../../data/storage/offboardingEngine';
import { CertificateOfDestruction } from '../../types/audit';
import type { ControlState, EvidenceItem } from '../../types/cmmc';
import { errorMessage } from '../../utils/errors';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyToClipboard } from '../../utils/clipboard';
interface SuperAdminDashboardProps {
  onNavigateToApp?: () => void;
  onNavigateToLogin?: () => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}



export const SuperAdminDashboard: React.FC<SuperAdminDashboardProps> = ({
  onNavigateToApp,
  onNavigateToLogin,
}) => {
  const {
    tenants,
    invitations,
    teamMembers,
    currentUser,
    isSuperAdmin,
    switchTenant,
    suspendTenant,
    deleteTenant,
    revokeInvitation,
    resendInvitation,
    extendInvitationExpiration,
    refreshAllTeams,
  } = useTenant();

  const { logout, openAuthModal } = useAuth();

  // Modals & UI state
  const [isNewTenantModalOpen, setIsNewTenantModalOpen] = useState(false);
  const [selectedTenantForEdit, setSelectedTenantForEdit] = useState<Tenant | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Invitation editing state
  const [selectedInvitationForEdit, setSelectedInvitationForEdit] = useState<TenantInvitation | null>(null);
  const [isEditInvitationModalOpen, setIsEditInvitationModalOpen] = useState(false);

  // Platform administrators, as configured on the server (read-only here)
  const [serverAdmins, setServerAdmins] = useState<string[] | null>(null);
  const [adminsError, setAdminsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ApiClient.listPlatformAdmins().then((list) => {
      if (cancelled) return;
      setServerAdmins(list);
      setAdminsError(list === null ? 'The server did not return the list of platform administrators.' : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Local accounts: who can sign in to this installation, and the administrator actions on them
  type AccountActionKind = 'reset-password' | 'reset-mfa' | 'disable' | 'enable';
  const [localUsers, setLocalUsers] = useState<LocalAccount[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersVersion, setUsersVersion] = useState(0);
  const [accountAction, setAccountAction] = useState<{ kind: AccountActionKind; user: LocalAccount } | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountActionError, setAccountActionError] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ApiClient.listLocalUsers().then(
      (list) => {
        if (cancelled) return;
        setLocalUsers(list);
        setUsersError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        setUsersError(errorMessage(err) || 'Could not load the local accounts.');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [usersVersion]);

  const closeAccountAction = () => {
    setAccountAction(null);
    setTempPassword('');
    setAccountActionError(null);
  };

  const runAccountAction = async () => {
    if (!accountAction) return;
    const { kind, user } = accountAction;
    if (kind === 'reset-password' && tempPassword.length < 12) {
      setAccountActionError('The temporary password must be at least 12 characters.');
      return;
    }
    setAccountBusy(true);
    setAccountActionError(null);
    try {
      if (kind === 'reset-password') {
        await ApiClient.adminResetPassword(user.id, tempPassword);
        setAccountNotice(`${user.email}: the temporary password is set. They must change it at their next sign-in, and set up two-step verification again. Give it to them through a separate secure channel.`);
      } else if (kind === 'reset-mfa') {
        await ApiClient.adminResetMfa(user.id);
        setAccountNotice(`${user.email}: two-step verification was removed and their sessions were signed out.`);
      } else if (kind === 'disable') {
        await ApiClient.disableUser(user.id);
        setAccountNotice(`${user.email} is disabled and cannot sign in. Their sessions were signed out and their two-step verification was removed.`);
      } else {
        await ApiClient.enableUser(user.id);
        setAccountNotice(`${user.email} can sign in again. They will need to set up two-step verification again if it is required.`);
      }
      closeAccountAction();
      setUsersVersion((v) => v + 1);
    } catch (err: unknown) {
      setAccountActionError(errorMessage(err) || 'The action failed.');
    } finally {
      setAccountBusy(false);
      setTempPassword('');
    }
  };

  // Destruction state
  const [selectedTenantForDestruction,setSelectedTenantForDestruction] = useState<Tenant | null>(null);
  const [isDestructionModalOpen, setIsDestructionModalOpen] = useState(false);
  const [destructionConfirmInput, setDestructionConfirmInput] = useState('');
  const [isDestroying, setIsDestroying] = useState(false);
  const [destructionCertificate, setDestructionCertificate] = useState<CertificateOfDestruction | null>(null);

  // Search & Filter state
  const [tenantSearch, setTenantSearch] = useState('');
  const [inviteSearch, setInviteSearch] = useState('');
  const [enclaveStatusFilter, setEnclaveStatusFilter] = useState<'ALL' | 'ACTIVE' | 'SUSPENDED'>('ALL');

  // Copy & Action dropdown state
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [copiedEnclaveId, setCopiedEnclaveId] = useState<string | null>(null);
  const [exportingTenantId, setExportingTenantId] = useState<string | null>(null);
  const [notificationToast, setNotificationToast] = useState<{ type: 'success' | 'info' | 'error'; message: string } | null>(null);

  // Invitations and teams of server-backed tenants live on the server: load them for every tenant the admin manages
  useEffect(() => {
    void refreshAllTeams();
  }, [refreshAllTeams, tenants.length]);

  // Floating Context Menu state (Fixed Position Portal)
  const [floatingMenu, setFloatingMenu] = useState<{
    tenant: Tenant;
    top: number;
    right: number;
  } | null>(null);

  const floatingMenuRef = useRef<HTMLDivElement>(null);

  // Dismiss floating menu on click outside or window scroll
  useEffect(() => {
    const handleDismiss = (event: MouseEvent) => {
      if (floatingMenuRef.current && !floatingMenuRef.current.contains(event.target as Node)) {
        setFloatingMenu(null);
      }
    };
    const handleScrollOrResize = () => {
      setFloatingMenu(null);
    };

    document.addEventListener('mousedown', handleDismiss);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);

    return () => {
      document.removeEventListener('mousedown', handleDismiss);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, []);

  // Auto-dismiss notification toast
  useEffect(() => {
    if (notificationToast) {
      const timer = setTimeout(() => setNotificationToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [notificationToast]);

  const hasAccess = isSuperAdmin;

  const handleCopy = async (text: string, id: string, type: 'token' | 'enclave') => {
    try {
      await copyToClipboard(text);
      if (type === 'token') {
        setCopiedTokenId(id);
        setTimeout(() => setCopiedTokenId(null), 2000);
      } else {
        setCopiedEnclaveId(id);
        setTimeout(() => setCopiedEnclaveId(null), 2000);
      }
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  const handleEnterEnclave = (tenantId: string) => {
    switchTenant(tenantId);
    if (onNavigateToApp) {
      onNavigateToApp();
    } else if (typeof window !== 'undefined') {
      window.location.hash = 'app';
    }
  };

  // Open Context Menu Popover with Fixed Portal Positioning
  const handleOpenActionMenu = (e: React.MouseEvent<HTMLButtonElement>, tenant: Tenant) => {
    e.stopPropagation();
    if (floatingMenu?.tenant.id === tenant.id) {
      setFloatingMenu(null);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const menuHeight = 230;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow < menuHeight ? rect.top - menuHeight - 6 : rect.bottom + 6;
    const right = Math.max(16, window.innerWidth - rect.right);

    setFloatingMenu({
      tenant,
      top,
      right,
    });
  };

  // Enclave Handover Package Export
  const handleExportOffboarding = async (tenant: Tenant) => {
    setExportingTenantId(tenant.id);
    setFloatingMenu(null);
    try {
      // The CMMC scope in the SSP comes from the asset inventory. If it cannot be read, the SSP simply states no counts.
      const assets = await getAssetBackend(tenant.id, assetBackendMode({ serverBacked: tenant.serverBacked })).list().catch(() => undefined);
      // A live tenant's implementation notes live on the server; the browser cache may be empty or stale. Never hand over a package with missing notes.
      let controlStates: Record<string, ControlState> | undefined;
      // The evidence list is server-only too: the browser cache of a live tenant no longer holds it.
      let evidenceList: EvidenceItem[] | undefined;
      if (tenant.serverBacked) {
        try {
          // null: the tenant's default program (the handover package is not scoped to whichever program this browser has open)
          const [list, evidence] = await Promise.all([
            ApiClient.getControls(tenant.id, { framework: tenant.primaryFramework }, null),
            ApiClient.getEvidence(tenant.id, null),
          ]);
          controlStates = Object.fromEntries(list.map(c => [c.id, c]));
          evidenceList = evidence;
        } catch (err: unknown) {
          // The membership check in authMiddleware answers 403 for an administrator who is not a member of the tenant.
          const notMember = err instanceof ApiError && err.status === 403;
          setNotificationToast({
            type: 'error',
            message: notMember
              ? 'You are not a member of this tenant, so its implementation notes cannot be read. Add yourself to the tenant (or ask an owner to export) before generating the handover package.'
              : 'Implementation notes could not be loaded from the server; the handover package was not generated.',
          });
          return;
        }
      }
      await generateEnclaveHandoverPackage(tenant.id, tenant, assets, controlStates, evidenceList);
      setNotificationToast({
        type: 'success',
        message: `Offboarding package for "${tenant.name}" exported and downloaded successfully.`,
      });
    } catch (err: unknown) {
      console.error('Failed to export offboarding package:', err);
      setNotificationToast({
        type: 'error',
        message: `Failed to export offboarding package: ${errorMessage(err) || 'Unknown error'}`,
      });
    } finally {
      setExportingTenantId(null);
    }
  };

  // Toggle Enclave Suspension
  const handleToggleSuspension = (tenant: Tenant) => {
    setFloatingMenu(null);
    const nextSuspended = !tenant.isSuspended;
    suspendTenant(tenant.id, nextSuspended);
    setNotificationToast({
      type: 'info',
      message: nextSuspended
        ? `Enclave "${tenant.name}" is now SUSPENDED. User access is frozen.`
        : `Enclave "${tenant.name}" has been REACTIVATED. Full operational access restored.`,
    });
  };

  // Open Edit Modal
  const handleOpenEditModal = (tenant: Tenant) => {
    setSelectedTenantForEdit(tenant);
    setIsEditModalOpen(true);
    setFloatingMenu(null);
  };

  // Open Edit Invitation Modal
  const handleOpenEditInvitationModal = (invitation: TenantInvitation) => {
    setSelectedInvitationForEdit(invitation);
    setIsEditInvitationModalOpen(true);
  };

  // Open Destruction Confirmation Modal
  const handleOpenDestructionModal = (tenant: Tenant) => {
    setSelectedTenantForDestruction(tenant);
    setDestructionConfirmInput('');
    setDestructionCertificate(null);
    setIsDestructionModalOpen(true);
    setFloatingMenu(null);
  };

  // Execute Cryptographic Destruction
  const handleExecuteDestruction = async () => {
    if (!selectedTenantForDestruction) return;

    setIsDestroying(true);
    try {
      const cert = await executeCryptographicDestruction({
        tenantId: selectedTenantForDestruction.id,
        systemName: selectedTenantForDestruction.systemName,
        cageCode: selectedTenantForDestruction.cageCode,
        actorName: currentUser.name || 'Pitch Black Cyber Super Admin',
        actorEmail: currentUser.email || 'devin@pitchblackcyber.com',
      });

      deleteTenant(selectedTenantForDestruction.id);

      setDestructionCertificate(cert);
      setNotificationToast({
        type: 'success',
        message: `Enclave "${selectedTenantForDestruction.name}" cryptographically destroyed. Certificate ${cert.certificateId} downloaded.`,
      });
    } catch (err: unknown) {
      console.error('Cryptographic destruction failed:', err);
      setNotificationToast({
        type: 'error',
        message: `Destruction protocol failed: ${errorMessage(err) || 'Unknown error'}`,
      });
    } finally {
      setIsDestroying(false);
    }
  };

  // -------------------------------------------------------------------------
  // 1. ROUTE GUARD: Unauthorized Screen (Discrete 403 High-Security Gate)
  // -------------------------------------------------------------------------
  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 sm:p-6 font-sans">
        <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-slate-800/40 via-slate-900/30 to-slate-950 ring-1 ring-slate-800 shadow-2xl animate-scaleUp">
          <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-center space-y-6">
            
            <div className="w-12 h-12 mx-auto rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shadow-lg shadow-rose-500/5">
              <Lock className="w-6 h-6" />
            </div>

            <div className="space-y-2">
              <span className="badge text-xs uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-slate-900 text-slate-400 border border-slate-800">
                ACCESS RESTRICTED
              </span>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight pt-1">
                403 - Administrative Access Required
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
                This portal is restricted to authorized platform administrators.
              </p>
            </div>

            <div className="pt-2 space-y-3">
              <button
                onClick={() => openAuthModal('signin')}
                className="w-full btn-primary text-xs py-3 flex items-center justify-center gap-2 font-bold shadow-lg shadow-brand-500/20"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Sign In as Administrator</span>
              </button>

              <button
                onClick={() => {
                  if (onNavigateToApp) {
                    onNavigateToApp();
                  } else if (typeof window !== 'undefined') {
                    window.location.hash = 'app';
                  }
                }}
                className="w-full btn-secondary text-xs py-2.5 flex items-center justify-center gap-2 font-semibold text-slate-300 hover:text-white"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Return to Dashboard</span>
              </button>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 2. AUTHORIZED SUPER ADMIN CONSOLE
  // -------------------------------------------------------------------------
  const filteredTenants = tenants
    .filter(t => {
      if (enclaveStatusFilter === 'ACTIVE') return !t.isSuspended;
      if (enclaveStatusFilter === 'SUSPENDED') return Boolean(t.isSuspended);
      return true;
    })
    .filter(t =>
      t.name.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      t.cageCode.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      t.id.toLowerCase().includes(tenantSearch.toLowerCase())
    );

  const filteredInvitations = invitations.filter(i =>
    i.email.toLowerCase().includes(inviteSearch.toLowerCase()) ||
    i.tenantName.toLowerCase().includes(inviteSearch.toLowerCase()) ||
    i.token.toLowerCase().includes(inviteSearch.toLowerCase())
  );

  const pendingInvitesCount = invitations.filter(i => i.status === 'PENDING').length;
  const activeEnclavesCount = tenants.filter(t => !t.isSuspended).length;
  const suspendedEnclavesCount = tenants.filter(t => t.isSuspended).length;
  // Enclaves per assessment program (their primary framework)
  const programCounts = tenants.reduce<Record<string, number>>((acc, t) => {
    const key = t.primaryFramework || 'CMMC_L1';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const programsInUse = Object.keys(programCounts).length;

  const destructionExpectedChallenge = selectedTenantForDestruction
    ? (selectedTenantForDestruction.cageCode && selectedTenantForDestruction.cageCode !== 'PENDING'
        ? selectedTenantForDestruction.cageCode
        : selectedTenantForDestruction.name)
    : '';

  const isDestructionConfirmed = Boolean(
    destructionConfirmInput.trim().toUpperCase() === destructionExpectedChallenge.trim().toUpperCase()
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
      
      {/* Toast Notification Banner */}
      {notificationToast && (
        <div className="fixed top-16 right-6 z-50 animate-fadeIn">
          <div className={`px-4 py-3 rounded-2xl shadow-2xl border flex items-center gap-3 text-xs font-semibold backdrop-blur-md ${
            notificationToast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200'
              : notificationToast.type === 'error'
              ? 'bg-rose-950/90 border-rose-500/40 text-rose-200'
              : 'bg-cyan-950/90 border-cyan-500/40 text-cyan-200'
          }`}>
            {notificationToast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : notificationToast.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            ) : (
              <Sparkles className="w-4 h-4 text-cyan-400" />
            )}
            <span>{notificationToast.message}</span>
            <button aria-label="Close"
              onClick={() => setNotificationToast(null)}
              className="ml-2 text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Top Super Admin Navigation Bar */}
      <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-4 sm:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <BrandLogo size="md" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base text-white tracking-tight">Event Horizon: Singularity</span>
                <span className="badge px-2 py-0.5 rounded-full text-xs font-mono font-extrabold bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-wider">
                  SUPER ADMIN CONSOLE
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium">
                Pitch Black Cyber Operator Portal • Multi-Tenant Enclave Engine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Operator Identifier */}
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700/80 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse motion-reduce:animate-none" />
              <span className="text-slate-400">Operator:</span>
              <span className="font-bold text-white">{currentUser.name}</span>
              <span className="text-slate-400">({currentUser.email})</span>
            </div>

            <button
              onClick={onNavigateToApp}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-semibold border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <span>Active Enclave</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={async () => {
                await logout();
                if (onNavigateToLogin) onNavigateToLogin();
              }}
              className="px-3 py-1.5 rounded-xl text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 border border-rose-900/30 text-xs font-semibold transition-colors"
            >
              Sign Out
            </button>
          </div>

        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-8 space-y-8">
        
        {/* Header Hero + CTA */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Tenant Provisioning & Enclave Management
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Initialize cryptographic defense enclaves, configure boundaries, export compliance offboarding bundles, and execute NIST SP 800-88 sanitized deletion.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setIsNewTenantModalOpen(true)}
              className="btn-primary text-xs px-5 py-2.5 shadow-lg shadow-cyan-500/20"
            >
              <Plus className="w-4 h-4" />
              <span>Provision New Tenant</span>
            </button>
          </div>
        </div>

        {/* KPI Metrics Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="stitch-card p-5 space-y-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-cyan-400" /> Total Enclaves
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-3xl font-black text-white font-mono">{tenants.length}</span>
              <span className="text-xs text-emerald-400 font-mono font-semibold">
                ({activeEnclavesCount} active{suspendedEnclavesCount > 0 ? `, ${suspendedEnclavesCount} suspended` : ''})
              </span>
            </div>
            <p className="text-xs text-slate-400">Isolated data boundaries</p>
          </div>

          <div className="stitch-card p-5 space-y-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> Assessment Programs
            </span>
            <p className="text-3xl font-black text-emerald-400 font-mono mt-1">
              {programsInUse}
            </p>
            <p className="text-xs text-slate-400">
              {Object.entries(programCounts).map(([fw, n]) => `${n} ${frameworkLabel(fw)}`).join(' • ') || 'No enclaves yet'}
            </p>
          </div>

          <div className="stitch-card p-5 space-y-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" /> Pending Invites
            </span>
            <p className="text-3xl font-black text-amber-300 font-mono mt-1">{pendingInvitesCount}</p>
            <p className="text-xs text-slate-400">Awaiting contractor claim</p>
          </div>

          <div className="stitch-card p-5 space-y-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-purple-400" /> Enclave Seats Bound
            </span>
            <p className="text-3xl font-black text-purple-300 font-mono mt-1">
              {Object.values(teamMembers).reduce((acc, curr) => acc + curr.length, 0)}
            </p>
            <p className="text-xs text-slate-400">Owners, Assessors & Viewers</p>
          </div>
        </div>

        {/* Section 1: Tenant Enclave Registry */}
        <div className="stitch-card p-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Building2 className="w-4 h-4 text-brand-400" />
                <span>Isolated Defense Enclaves ({filteredTenants.length})</span>
              </h2>
              <p className="text-xs text-slate-400">
                DoD contractor environments with dedicated assessment matrix, RLS database boundaries, and SSP records
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
              {/* Enclave Status Filter Tabs */}
              <div className="flex items-center p-1 rounded-xl bg-slate-950 border border-slate-800 text-xs font-semibold">
                <button
                  onClick={() => setEnclaveStatusFilter('ALL')}
                  className={`px-3 py-1 rounded-lg transition-colors ${
                    enclaveStatusFilter === 'ALL'
                      ? 'bg-slate-800 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All ({tenants.length})
                </button>
                <button
                  onClick={() => setEnclaveStatusFilter('ACTIVE')}
                  className={`px-3 py-1 rounded-lg transition-colors ${
                    enclaveStatusFilter === 'ACTIVE'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Active ({activeEnclavesCount})
                </button>
                <button
                  onClick={() => setEnclaveStatusFilter('SUSPENDED')}
                  className={`px-3 py-1 rounded-lg transition-colors ${
                    enclaveStatusFilter === 'SUSPENDED'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Suspended ({suspendedEnclavesCount})
                </button>
              </div>

              {/* Search input */}
              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search name, CAGE, ID..."
                  value={tenantSearch}
                  onChange={e => setTenantSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
                />
              </div>
            </div>
          </div>

          {/* Tenants Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Organization & Boundary</th>
                  <th className="py-3 px-4">CAGE / SAM</th>
                  <th className="py-3 px-4">Assessment Program</th>
                  <th className="py-3 px-4">Framework Scope</th>
                  <th className="py-3 px-4">System Owner</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-sans">
                {filteredTenants.map(t => {
                  const members = teamMembers[t.id] || [];
                  const activeFrameworks = t.enabledFrameworks && t.enabledFrameworks.length > 0
                    ? t.enabledFrameworks
                    : [t.primaryFramework || 'CMMC_L1'];
                  const isSuspended = Boolean(t.isSuspended);

                  return (
                    <tr
                      key={t.id}
                      className={`transition-colors duration-150 ${
                        isSuspended
                          ? 'bg-amber-950/15 hover:bg-amber-950/25 border-l-2 border-l-amber-500/60'
                          : 'even:bg-slate-950/40 odd:bg-slate-900/20 hover:bg-slate-800/60'
                      }`}
                    >
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <div className="font-bold text-white text-xs">{t.name}</div>
                          {isSuspended && (
                            <span className="badge px-2 py-0.5 rounded-full text-xs font-mono font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/40 uppercase tracking-wider flex items-center gap-1">
                              <PauseCircle className="w-2.5 h-2.5" /> Suspended
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 truncate max-w-xs">{t.systemName}</div>
                        <div className="text-xs font-mono text-slate-400 flex items-center gap-2 mt-0.5">
                          <span>{t.id}</span>
                          <button
                            onClick={() => handleCopy(t.id, t.id, 'enclave')}
                            className="text-slate-400 hover:text-white"
                            title="Copy Enclave ID"
                          >
                            {copiedEnclaveId === t.id ? (
                              <Check className="w-3 h-3 text-emerald-400 inline" />
                            ) : (
                              <Copy className="w-3 h-3 inline" />
                            )}
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span className="badge font-mono text-xs px-2 py-0.5 rounded bg-cyan-950/40 text-cyan-300 font-bold border border-cyan-500/30">
                          {t.cageCode || 'PENDING'}
                        </span>
                        <div className="text-xs text-slate-400 mt-1">
                          {t.samStatus === 'ACTIVE' ? (
                            <span className="text-emerald-400 font-medium">SAM Active</span>
                          ) : (
                            <span className="text-slate-400">SAM {t.samStatus}</span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className="badge inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-brand-500/20 text-brand-300 border border-brand-500/30"
                          title={programSummary(t.primaryFramework, t.enabledFrameworks).text}
                        >
                          <Shield className="w-3 h-3" /> {programSummary(t.primaryFramework, t.enabledFrameworks).primary}
                          {programSummary(t.primaryFramework, t.enabledFrameworks).additional.length > 0 &&
                            ` +${programSummary(t.primaryFramework, t.enabledFrameworks).additional.length}`}
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="badge text-xs font-mono px-2 py-0.5 rounded font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                              {t.primaryFramework || 'CMMC_L1'}
                            </span>
                            <span className="text-xs font-mono text-slate-400">PRIMARY</span>
                          </div>
                          {activeFrameworks.length > 1 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {activeFrameworks.filter(f => f !== (t.primaryFramework || 'CMMC_L1')).map(fw => (
                                <span key={fw} className="badge text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/80">
                                  {fw}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="text-slate-200 text-xs font-medium truncate max-w-xs">{t.systemOwner || 'Unassigned'}</div>
                        <div className="text-xs font-mono text-slate-400">{t.domain || 'N/A'}</div>
                        <div className="text-xs font-mono text-slate-400 mt-0.5">
                          {members.length > 0 ? `${members.length} team seat(s)` : '1 (Owner)'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        {isSuspended ? (
                          <div className="space-y-0.5">
                            <span className="badge inline-flex items-center gap-1 text-amber-400 font-bold font-mono text-xs bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
                              <PauseCircle className="w-3 h-3" /> Suspended
                            </span>
                            <div className="text-xs text-slate-400">Access Frozen</div>
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <span className="badge inline-flex items-center gap-1 text-emerald-400 font-bold font-mono text-xs bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                              <CheckCircle2 className="w-3 h-3" /> Active
                            </span>
                            <div className="text-xs text-slate-400">RLS Enforced</div>
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="relative inline-flex items-center justify-end gap-1.5">
                          
                          {/* Quick Launch Button */}
                          <button
                            onClick={() => handleEnterEnclave(t.id)}
                            className={`btn-primary text-xs px-3 py-1.5 flex items-center gap-1 font-bold ${
                              isSuspended ? 'opacity-80' : ''
                            }`}
                            title={isSuspended ? 'Launch Enclave (Administrative View)' : 'Launch Enclave'}
                          >
                            <span>Launch</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>

                          {/* Action Dropdown Trigger */}
                          <button
                            onClick={(e) => handleOpenActionMenu(e, t)}
                            className={`p-1.5 rounded-xl border transition-all ${
                              floatingMenu?.tenant.id === t.id
                                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border-slate-700'
                            }`}
                            title="Enclave Lifecycle Actions"
                          >
                            <MoreVertical className="w-3.5 h-3.5" />
                          </button>

                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 2: Platform administrators (configured on the server) */}
        <div className="stitch-card p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400" />
              <span>Platform Administrators{serverAdmins ? ` (${serverAdmins.length})` : ''}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              The operators of this installation. Only they can provision enclaves for a specific assessment program and use this console.
              They are the addresses in the server setting <code className="text-cyan-300 font-mono">PLATFORM_ADMIN_EMAILS</code>: edit it in the
              server&apos;s <code className="font-mono">.env</code> and restart the app. See <code className="font-mono">docs/ASSESSMENT_PROGRAMS.md</code>.
            </p>
          </div>

          {adminsError && <ErrorNotice message={adminsError} />}

          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Administrator</th>
                  <th className="py-3 px-4">Source</th>
                  <th className="py-3 px-4">Scope</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-sans">
                {(serverAdmins ?? []).map((email) => (
                  <tr key={email} className="even:bg-slate-950/40 odd:bg-slate-900/20">
                    <td className="py-3.5 px-4 font-mono text-slate-200 font-semibold">
                      {email}
                      {email === currentUser.email.toLowerCase() && <span className="ml-2 text-xs font-sans text-cyan-300">(you)</span>}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300">Server configuration</td>
                    <td className="py-3.5 px-4 text-slate-300">Provision tenants and set their assessment program</td>
                  </tr>
                ))}
                {serverAdmins !== null && serverAdmins.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-6 px-4 text-center text-slate-400">No platform administrators are configured.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 2b: Local accounts (sign-in credentials and second factors) */}
        <div className="stitch-card p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-cyan-400" />
              <span>Local accounts{localUsers ? ` (${localUsers.length})` : ''}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Everyone who can sign in to this installation. Resetting a password sets a temporary one the person must change at their next sign-in.
              Resetting two-step verification, resetting a password and disabling an account all sign the person out everywhere.
            </p>
          </div>

          {usersError && <ErrorNotice message={usersError} />}
          {accountNotice && (
            <div role="status" className="flex items-start justify-between gap-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
              <span>{accountNotice}</span>
              <button aria-label="Dismiss" onClick={() => setAccountNotice(null)} className="text-emerald-400 hover:text-white">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Account</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">2-step</th>
                  <th className="py-3 px-4">Last sign-in</th>
                  <th className="py-3 px-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-sans">
                {(localUsers ?? []).map((u) => {
                  const isSelf = u.email.toLowerCase() === currentUser.email.toLowerCase();
                  const locked = Boolean(u.lockedUntil) && new Date(u.lockedUntil as string).getTime() > Date.now();
                  const actionClass = 'px-2 py-1 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed';
                  return (
                    <tr key={u.id} className="even:bg-slate-950/40 odd:bg-slate-900/20 align-top">
                      <td className="py-3.5 px-4">
                        <div className="font-mono text-slate-200 font-semibold">
                          {u.email}
                          {isSelf && <span className="ml-2 text-xs font-sans text-cyan-300">(you)</span>}
                        </div>
                        {u.name && <div className="text-slate-400">{u.name}</div>}
                      </td>
                      <td className="py-3.5 px-4 space-x-1.5">
                        {u.disabled ? (
                          <span className="px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300">Disabled</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">Active</span>
                        )}
                        {locked && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">Locked</span>}
                        {u.mustChangePassword && <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">Must change password</span>}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300">{u.mfaEnrolled ? 'On' : 'Off'}</td>
                      <td className="py-3.5 px-4 text-slate-300">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap gap-1.5">
                          <button type="button" disabled={isSelf} onClick={() => setAccountAction({ kind: 'reset-password', user: u })} className={actionClass}>Reset password</button>
                          <button type="button" disabled={isSelf || !u.mfaEnrolled} onClick={() => setAccountAction({ kind: 'reset-mfa', user: u })} className={actionClass}>Reset 2-step</button>
                          {u.disabled ? (
                            <button type="button" disabled={isSelf} onClick={() => setAccountAction({ kind: 'enable', user: u })} className={actionClass}>Enable</button>
                          ) : (
                            <button type="button" disabled={isSelf} onClick={() => setAccountAction({ kind: 'disable', user: u })} className={actionClass}>Disable</button>
                          )}
                        </div>
                        {isSelf && <p className="text-slate-400 mt-1">Use Account settings to change your own password.</p>}
                      </td>
                    </tr>
                  );
                })}
                {localUsers !== null && localUsers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 px-4 text-center text-slate-400">There are no local accounts.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Confirmation for a local-account action */}
        {accountAction && (
          <DialogOverlay onClose={accountBusy ? undefined : closeAccountAction} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
            <div className="w-full max-w-md p-1.5 rounded-[2rem] bg-gradient-to-b from-brand-500/20 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl max-h-[94vh] flex flex-col">
              <div className="max-h-[calc(94vh-0.75rem)] overflow-y-auto p-6 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800 space-y-4 text-xs">
                <DialogTitle as="h3" className="text-base font-bold text-white">
                  {accountAction.kind === 'reset-password' && 'Reset password'}
                  {accountAction.kind === 'reset-mfa' && 'Reset two-step verification'}
                  {accountAction.kind === 'disable' && 'Disable account'}
                  {accountAction.kind === 'enable' && 'Enable account'}
                </DialogTitle>
                <p className="text-slate-300 leading-relaxed">
                  {accountAction.kind === 'reset-password' && <>Set a temporary password for <strong className="text-white font-mono">{accountAction.user.email}</strong>. They are signed out everywhere, lose their two-step verification and recovery codes, and must change this password at their next sign-in.</>}
                  {accountAction.kind === 'reset-mfa' && <>Remove the authenticator and recovery codes of <strong className="text-white font-mono">{accountAction.user.email}</strong> and sign them out everywhere. They will set up two-step verification again at their next sign-in if it is required.</>}
                  {accountAction.kind === 'disable' && <>Block <strong className="text-white font-mono">{accountAction.user.email}</strong> from signing in. They are signed out everywhere and their two-step verification is removed.</>}
                  {accountAction.kind === 'enable' && <>Allow <strong className="text-white font-mono">{accountAction.user.email}</strong> to sign in again. Their two-step verification is not restored.</>}
                </p>
                {accountAction.kind === 'reset-password' && (
                  <div>
                    <label htmlFor="admin-temp-password" className="block text-xs font-semibold text-slate-300 mb-1">Temporary password (at least 12 characters)</label>
                    <input
                      id="admin-temp-password"
                      type="password"
                      autoComplete="new-password"
                      value={tempPassword}
                      onChange={(e) => setTempPassword(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                    />
                  </div>
                )}
                <ErrorNotice message={accountActionError} />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={closeAccountAction} disabled={accountBusy} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">Cancel</button>
                  <button
                    type="button"
                    onClick={() => void runAccountAction()}
                    disabled={accountBusy || (accountAction.kind === 'reset-password' && !tempPassword)}
                    className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold"
                  >
                    {accountBusy ? 'Working…' : 'Confirm'}
                  </button>
                </div>
              </div>
            </div>
          </DialogOverlay>
        )}

        {/* Section 3: Pending & Recent Onboarding Invitations */}
        <div className="stitch-card p-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                <span>Onboarding & Staff Invitations ({filteredInvitations.length})</span>
              </h2>
              <p className="text-xs text-slate-400">
                Authorized access tokens awaiting contractor claim via <code className="text-cyan-300 font-mono">/accept-invite</code>
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search email, tenant or token..."
                value={inviteSearch}
                onChange={e => setInviteSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Invited Recipient</th>
                  <th className="py-3 px-4">Enclave & Role</th>
                  <th className="py-3 px-4">Status & Expiration</th>
                  <th className="py-3 px-4">Token Preview</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-sans">
                {filteredInvitations.map(inv => {
                  const isExpired = new Date(inv.expiresAt).getTime() < Date.now();
                  const inviteUrl = buildInviteUrl(inv.token);

                  return (
                    <tr
                      key={inv.id}
                      className="even:bg-slate-950/40 odd:bg-slate-900/20 hover:bg-slate-800/60 transition-colors duration-150"
                    >
                      <td className="py-3.5 px-4">
                        <div className="font-mono text-white text-xs font-semibold">{inv.email}</div>
                        <div className="text-xs text-slate-400 font-mono">Invited by: {inv.invitedBy}</div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-200 text-xs">{inv.tenantName}</div>
                        {inv.role === 'TENANT_OWNER' ? (
                          <span className="badge inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30">
                            <Shield className="w-3 h-3" /> Tenant Owner
                          </span>
                        ) : inv.role === 'ASSESSOR' ? (
                          <span className="badge inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                            <CheckCircle2 className="w-3 h-3" /> Assessor
                          </span>
                        ) : (
                          <span className="badge inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-xs font-bold font-mono bg-slate-700/50 text-slate-300 border border-slate-600/50">
                            <Lock className="w-3 h-3" /> Viewer
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        {inv.status === 'ACCEPTED' ? (
                          <span className="badge inline-flex items-center gap-1 text-emerald-400 font-bold font-mono text-xs bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> Claimed
                          </span>
                        ) : inv.status === 'REVOKED' ? (
                          <span className="badge inline-flex items-center gap-1 text-rose-400 font-bold font-mono text-xs bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                            Revoked
                          </span>
                        ) : isExpired ? (
                          <span className="badge inline-flex items-center gap-1 text-amber-400 font-bold font-mono text-xs bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                            Expired
                          </span>
                        ) : (
                          <span className="badge inline-flex items-center gap-1 text-cyan-300 font-bold font-mono text-xs bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                            <Clock className="w-3 h-3 text-cyan-400" /> Pending Claim
                          </span>
                        )}
                        <div className="text-xs font-mono text-slate-400 mt-1">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <code className="badge font-mono text-xs text-slate-400 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 select-all">
                          {inv.token.slice(0, 14)}...
                        </code>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.status === 'PENDING' && (
                            <>
                              {/* 1. Edit Invitation Action */}
                              <button
                                onClick={() => handleOpenEditInvitationModal(inv)}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-cyan-950 text-cyan-300 hover:text-cyan-200 border border-slate-700 hover:border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all"
                                title="Edit Recipient, Enclave, Role, or Expiration"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>Edit</span>
                              </button>

                              {/* 2. Copy Invite Link */}
                              <button
                                onClick={() => handleCopy(inviteUrl, inv.id, 'token')}
                                disabled={!inv.token}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                title={inv.token ? 'Copy full invite link to clipboard' : 'The server stores only a hash of the link: use Resend to create a new one'}
                              >
                                {copiedTokenId === inv.id ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-emerald-400">Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    <span>Copy Link</span>
                                  </>
                                )}
                              </button>

                                {/* 3. Extend (+7 Days) */}
                              <button
                                onClick={async () => {
                                  try {
                                    const res = await extendInvitationExpiration(inv.id, 7);
                                    setNotificationToast({
                                      type: 'info',
                                      message: `Invitation for ${inv.email} extended to ${new Date(res.expiresAt).toLocaleDateString()} (+7 days).`,
                                    });
                                  } catch (err: unknown) {
                                    setNotificationToast({ type: 'error', message: errorMessage(err) || 'Could not extend the invitation.' });
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-amber-300 hover:text-white border border-slate-700 transition-all"
                                title="Extend Expiration (+7 Days)"
                              >
                                <CalendarPlus className="w-3.5 h-3.5" />
                              </button>

                              {/* 4. Resend Token (+14 days) */}
                              <button
                                onClick={async () => {
                                  try {
                                    const res = await resendInvitation(inv.id);
                                    await handleCopy(res.inviteUrl, inv.id, 'token');
                                    setNotificationToast({
                                      type: 'success',
                                      message: `New invitation link created and copied. The previous link no longer works.`,
                                    });
                                  } catch (err: unknown) {
                                    setNotificationToast({ type: 'error', message: errorMessage(err) || 'Could not resend the invitation.' });
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 transition-all"
                                title="Resend & Extend by 14 Days"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>

                              {/* 5. Revoke Token */}
                              <button
                                onClick={async () => {
                                  if (confirm(`Revoke onboarding invitation for ${inv.email}? Link will become immediately invalid.`)) {
                                    try {
                                      await revokeInvitation(inv.id);
                                      setNotificationToast({
                                        type: 'info',
                                        message: `Invitation for ${inv.email} has been revoked.`,
                                      });
                                    } catch (err: unknown) {
                                      setNotificationToast({ type: 'error', message: errorMessage(err) || 'Could not revoke the invitation.' });
                                    }
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 transition-all"
                                title="Revoke Token"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {/* 5. External route link */}
                          <a
                            href={inviteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white border border-slate-700 transition-all"
                            title="Open Acceptance Route in New Tab"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 4: Finance-Driven Manual Provisioning Pipeline & Audit Log */}
        <FinanceProvisioningLog
          tenants={tenants}
          invitations={invitations}
          onOpenNewTenantModal={() => setIsNewTenantModalOpen(true)}
          onEnterEnclave={handleEnterEnclave}
        />

      </main>

      {/* Floating Enclave Action Context Menu rendered via React Portal at Root Document Level */}
      {floatingMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={floatingMenuRef}
          style={{
            position: 'fixed',
            top: `${floatingMenu.top}px`,
            right: `${floatingMenu.right}px`,
            zIndex: 9999,
          }}
          className="w-56 p-1.5 rounded-2xl bg-slate-900 border border-slate-700/90 shadow-2xl shadow-black/90 animate-scaleUp text-left space-y-0.5"
        >
          <div className="px-3 py-1.5 text-xs uppercase font-mono font-bold text-slate-400 border-b border-slate-800">
            Enclave: {floatingMenu.tenant.cageCode || 'BOUNDARY'}
          </div>

          {/* 1. Edit Configuration */}
          <button
            onClick={() => handleOpenEditModal(floatingMenu.tenant)}
            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 transition-colors"
          >
            <Edit3 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Edit Configuration</span>
          </button>

          {/* 2. Export Offboarding Package */}
          <button
            onClick={() => handleExportOffboarding(floatingMenu.tenant)}
            disabled={exportingTenantId === floatingMenu.tenant.id}
            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 transition-colors"
          >
            {exportingTenantId === floatingMenu.tenant.id ? (
              <span className="w-3.5 h-3.5 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span>Export Offboarding Package</span>
          </button>

          {/* 3. Suspend / Reactivate Enclave */}
          <button
            onClick={() => handleToggleSuspension(floatingMenu.tenant)}
            className={`w-full px-3 py-2 rounded-xl text-left text-xs font-semibold flex items-center gap-2.5 transition-colors ${
              floatingMenu.tenant.isSuspended
                ? 'text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200'
                : 'text-amber-300 hover:bg-amber-950/40 hover:text-amber-200'
            }`}
          >
            {floatingMenu.tenant.isSuspended ? (
              <>
                <PlayCircle className="w-3.5 h-3.5 text-emerald-400" />
                <span>Reactivate Enclave</span>
              </>
            ) : (
              <>
                <PauseCircle className="w-3.5 h-3.5 text-amber-400" />
                <span>Suspend Enclave</span>
              </>
            )}
          </button>

          <div className="my-1 border-t border-slate-800" />

          {/* 4. Cryptographic Sanitize & Destroy */}
          <button
            onClick={() => handleOpenDestructionModal(floatingMenu.tenant)}
            className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 flex items-center gap-2.5 transition-colors"
          >
            <Flame className="w-3.5 h-3.5 text-rose-500" />
            <span>Sanitize & Destroy</span>
          </button>
        </div>,
        document.body
      )}

      {/* 1. New Tenant Provisioning Modal */}
      <NewTenantModal
        isOpen={isNewTenantModalOpen}
        onClose={() => setIsNewTenantModalOpen(false)}
      />

      {/* 2. Edit Enclave Configuration Modal */}
      <EditEnclaveModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setSelectedTenantForEdit(null);
        }}
        tenant={selectedTenantForEdit}
        onSaved={() => {
          setNotificationToast({
            type: 'success',
            message: 'Enclave configuration updated successfully.',
          });
        }}
      />

      {/* 3. Edit Invitation Modal */}
      <EditInvitationModal
        isOpen={isEditInvitationModalOpen}
        onClose={() => {
          setIsEditInvitationModalOpen(false);
          setSelectedInvitationForEdit(null);
        }}
        invitation={selectedInvitationForEdit}
        tenants={tenants}
        onSaved={() => {
          setNotificationToast({
            type: 'success',
            message: 'Invitation details updated successfully.',
          });
        }}
      />

      {/* 5. Two-Step NIST SP 800-88 Cryptographic Sanitization & Destruction Modal */}
      {isDestructionModalOpen && selectedTenantForDestruction && (
        <DialogOverlay onClose={isDestroying ? undefined : () => { setIsDestructionModalOpen(false); setSelectedTenantForDestruction(null); }} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/85 backdrop-blur-md overflow-y-auto">
          <div className="relative w-full max-w-xl my-auto p-1.5 rounded-[2rem] bg-gradient-to-b from-rose-900/40 via-slate-900/60 to-slate-950 ring-1 ring-rose-700/60 shadow-2xl shadow-rose-950/40 animate-scaleUp">
            <div className="p-6 sm:p-8 rounded-[calc(2rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-left space-y-6">
              
              <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                    <Flame className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="badge text-xs uppercase font-mono font-extrabold tracking-widest px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      NIST SP 800-88 PROTOCOL
                    </span>
                    <DialogTitle as="h2" className="text-xl font-black text-white tracking-tight pt-1">
                      Cryptographic Sanitize & Destroy
                    </DialogTitle>
                  </div>
                </div>

                {!isDestroying && (
                  <button aria-label="Close"
                    onClick={() => {
                      setIsDestructionModalOpen(false);
                      setSelectedTenantForDestruction(null);
                    }}
                    className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>

              {destructionCertificate ? (
                <div className="space-y-4 py-2">
                  <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 space-y-2 text-xs">
                    <div className="flex items-center gap-2 font-bold text-sm text-emerald-200">
                      <FileCheck2 className="w-5 h-5 text-emerald-400" />
                      <span>Certificate of Destruction Issued & Signed</span>
                    </div>
                    <p className="text-slate-300">
                      Enclave records were overwritten with pseudo-random cryptographic noise and purged in compliance with NIST SP 800-88 Rev 1.
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2 text-xs font-mono">
                    <div className="flex justify-between text-slate-400">
                      <span>Certificate ID:</span>
                      <span className="text-cyan-300 font-bold">{destructionCertificate.certificateId}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Purged Objects:</span>
                      <span className="text-white font-bold">{destructionCertificate.purgedObjectsCount}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Method:</span>
                      <span className="text-slate-200">{destructionCertificate.sanitizationMethod}</span>
                    </div>
                    <div className="pt-2 border-t border-slate-800">
                      <span className="text-slate-400 block mb-1">SHA-256 Checksum:</span>
                      <span className="text-xs text-purple-300 break-all bg-slate-950 p-2 rounded block">
                        {destructionCertificate.certificateSha256}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      onClick={() => {
                        setIsDestructionModalOpen(false);
                        setSelectedTenantForDestruction(null);
                      }}
                      className="btn-primary text-xs px-6 py-2.5 font-bold"
                    >
                      Done
                    </button>
                  </div>
                </div>
              ) : isDestroying ? (
                <div className="py-8 text-center space-y-4">
                  <div className="w-14 h-14 mx-auto rounded-full border-4 border-rose-500/20 border-t-rose-500 animate-spin motion-reduce:animate-none" />
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-white">
                      Executing 3-Pass Cryptographic Wipe...
                    </h3>
                    <p className="text-xs text-slate-400 font-mono">
                      Overwriting local keys • Revoking certificates • Writing audit block
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="p-4 rounded-2xl bg-rose-950/30 border border-rose-500/30 text-xs space-y-2 text-rose-200">
                    <div className="font-bold flex items-center gap-2 text-rose-300">
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>Warning: Permanent & Irreversible Destruction</span>
                    </div>
                    <p className="text-slate-300 leading-relaxed">
                      Executing this command will cryptographically overwrite all compliance assessments, control narratives, SSP drafts, and evidence indices for <strong className="text-white">{selectedTenantForDestruction.name}</strong> ({selectedTenantForDestruction.id}).
                    </p>
                    <p className="text-slate-400 text-xs">
                      A formal, digitally signed Certificate of Destruction will be generated, registered in the immutable audit ledger, and downloaded to your browser.
                    </p>
                  </div>

                  <div className="space-y-2 pt-2">
                    <label className="text-xs text-slate-300 font-medium block">
                      To confirm cryptographic deletion, type <code className="font-mono font-bold text-rose-300 bg-rose-950/60 px-2 py-0.5 rounded border border-rose-800/60 select-all">{destructionExpectedChallenge}</code> below:
                    </label>

                    <input
                      type="text"
                      value={destructionConfirmInput}
                      onChange={e => setDestructionConfirmInput(e.target.value)}
                      placeholder={`Type "${destructionExpectedChallenge}"`}
                      className="w-full px-3 py-2.5 text-xs font-mono font-bold bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-all"
                      autoFocus
                    />
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => {
                        setIsDestructionModalOpen(false);
                        setSelectedTenantForDestruction(null);
                      }}
                      className="px-4 py-2.5 text-xs font-semibold text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-xl transition-colors"
                    >
                      Cancel
                    </button>

                    <button
                      type="button"
                      disabled={!isDestructionConfirmed || isDestroying}
                      onClick={handleExecuteDestruction}
                      className="btn-danger px-5 py-2.5 rounded-xl text-xs flex items-center gap-2"
                    >
                      <Flame className="w-4 h-4" />
                      <span>Execute Cryptographic Wipe & Destroy</span>
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        </DialogOverlay>
      )}

    </div>
  );
};
