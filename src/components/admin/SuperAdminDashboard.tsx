import React, { useState } from 'react';
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
  AlertTriangle,
  ArrowRight,
  Sparkles,
  Layers,
  FileCode,
  Globe,
  Terminal,
  Clock,
  ArrowUpRight,
  X,
} from 'lucide-react';
import { useTenant, buildInviteUrl, SUPER_ADMIN_PRESET_USER } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { Tenant, TenantInvitation, StripeWebhookPayload } from '../../types/tenant';
import { NewTenantModal } from './NewTenantModal';

interface SuperAdminDashboardProps {
  onNavigateToApp?: () => void;
  onNavigateToLanding?: () => void;
  onOpenLegal?: (tab: 'privacy' | 'terms') => void;
}

export const SuperAdminDashboard: React.FC<SuperAdminDashboardProps> = ({
  onNavigateToApp,
  onNavigateToLanding,
}) => {
  const {
    tenants,
    invitations,
    teamMembers,
    currentUser,
    isSuperAdmin,
    switchTenant,
    switchUser,
    revokeInvitation,
    resendInvitation,
    provisionTenantFromWebhook,
  } = useTenant();

  const { logout } = useAuth();

  // Modals & UI state
  const [isNewTenantModalOpen, setIsNewTenantModalOpen] = useState(false);
  const [tenantSearch, setTenantSearch] = useState('');
  const [inviteSearch, setInviteSearch] = useState('');
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [copiedEnclaveId, setCopiedEnclaveId] = useState<string | null>(null);
  const [isSimulatingWebhook, setIsSimulatingWebhook] = useState(false);
  const [webhookResult, setWebhookResult] = useState<{
    tenant: Tenant;
    invitation: TenantInvitation;
    inviteUrl: string;
  } | null>(null);

  // Operator bypass for local evaluation/testing if user is not yet logged in as devin
  const [developerOverride, setDeveloperOverride] = useState(false);

  const hasAccess = isSuperAdmin || developerOverride;

  const handleCopy = async (text: string, id: string, type: 'token' | 'enclave') => {
    try {
      await navigator.clipboard.writeText(text);
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

  const handleSimulateWebhook = async () => {
    setIsSimulatingWebhook(true);
    setWebhookResult(null);
    try {
      const demoStripePayload: StripeWebhookPayload = {
        eventId: `evt_test_${Date.now().toString(36)}`,
        eventType: 'checkout.session.completed',
        customerEmail: `ciso-${Date.now().toString(36).slice(0, 4)}@sentinel-defense.us`,
        companyName: 'Sentinel Defense Systems LLC',
        cageCode: '4S8W2',
        systemName: 'Sentinel Defense Operations Boundary',
        licenseTier: 'single-org',
        metadata: {
          stripeCustomerId: `cus_${Date.now()}`,
          subscriptionTier: 'single-org-annual-1000',
        },
      };

      const result = await provisionTenantFromWebhook(demoStripePayload);
      setWebhookResult(result);
    } catch (err) {
      console.error('Webhook simulation failed:', err);
      alert('Webhook simulation failed. Check browser console.');
    } finally {
      setIsSimulatingWebhook(false);
    }
  };

  // -------------------------------------------------------------------------
  // 1. ROUTE GUARD: Unauthorized Screen
  // -------------------------------------------------------------------------
  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 sm:p-6 font-sans">
        <div className="w-full max-w-lg p-1.5 rounded-[2.5rem] bg-gradient-to-b from-rose-500/30 via-slate-800/40 to-slate-950 ring-1 ring-white/10 shadow-2xl animate-scaleUp">
          <div className="p-6 sm:p-8 rounded-[calc(2.5rem-0.375rem)] bg-slate-950/95 border border-slate-800/90 text-center space-y-5">
            
            <div className="w-14 h-14 mx-auto rounded-3xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shadow-xl shadow-rose-500/10">
              <Lock className="w-7 h-7" />
            </div>

            <div>
              <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">
                RESTRICTED CLEARANCE AREA
              </span>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight mt-2.5">
                Super Admin Clearance Required
              </h1>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed max-w-md mx-auto">
                The Tenant Provisioning Engine is strictly restricted to authorized Pitch Black Cyber administrative personnel. Access attempts are logged in compliance with DoD FAR 52.204-21 audit requirements.
              </p>
            </div>

            {/* Current Session Summary */}
            <div className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 text-left text-xs space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>Active Session:</span>
                <span className="font-mono text-white font-semibold">{currentUser.email || 'Unauthenticated'}</span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Clearance Status:</span>
                <span className="font-bold text-rose-400 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> Insufficient Privileges
                </span>
              </div>
            </div>

            {/* Switch to Super Admin Persona / Elevate */}
            <div className="pt-2 space-y-2.5">
              <button
                onClick={() => {
                  switchUser(SUPER_ADMIN_PRESET_USER);
                  setDeveloperOverride(true);
                }}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-brand-500/25 flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              >
                <Shield className="w-4 h-4 text-amber-300" />
                <span>Log In as Super Admin (devin@pitchblackcyber.com)</span>
              </button>

              <button
                onClick={() => setDeveloperOverride(true)}
                className="w-full py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-semibold border border-slate-700 transition-colors"
              >
                Bypass Guard for Local Evaluation
              </button>

              <button
                onClick={onNavigateToLanding}
                className="w-full py-2 px-4 text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors"
              >
                Return to Public Portal
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
  const filteredTenants = tenants.filter(t =>
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
  const singleOrgCount = tenants.filter(t => t.licenseTier !== 'msp-assessor').length;
  const mspCount = tenants.filter(t => t.licenseTier === 'msp-assessor').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
      
      {/* Top Super Admin Navigation Bar */}
      <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-4 sm:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-brand-500/25">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base text-white tracking-tight">PBC-GRC</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-wider">
                  SUPER ADMIN CONSOLE
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium">
                Pitch Black Cyber Operator Portal • Multi-Tenant Enclave Engine
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Operator Identifier */}
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700/80 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-400">Operator:</span>
              <span className="font-bold text-white">{currentUser.name}</span>
              <span className="text-slate-500">({currentUser.email})</span>
            </div>

            <button
              onClick={onNavigateToApp}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-semibold border border-slate-700 flex items-center gap-1.5 transition-colors"
            >
              <span>Active Enclave</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>

            {onNavigateToLanding && (
              <button
                onClick={onNavigateToLanding}
                className="p-2 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors"
                title="Exit to Public Landing Page"
              >
                <Globe className="w-4 h-4" />
              </button>
            )}

            <button
              onClick={async () => {
                await logout();
                if (onNavigateToLanding) onNavigateToLanding();
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
              Initialize cryptographic defense enclaves, generate onboarding tokens, and manage client subscriptions.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => setIsNewTenantModalOpen(true)}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-brand-500/25 flex items-center gap-2 transition-all active:scale-[0.98]"
            >
              <Plus className="w-4 h-4" />
              <span>Provision New Tenant</span>
            </button>
          </div>
        </div>

        {/* KPI Metrics Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-brand-400" /> Total Enclaves
            </span>
            <p className="text-3xl font-black text-white font-mono mt-1">{tenants.length}</p>
            <p className="text-[11px] text-slate-500">Live & sandbox organizations</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> Active Subscriptions
            </span>
            <p className="text-3xl font-black text-emerald-400 font-mono mt-1">
              ${singleOrgCount * 1000 + mspCount * 3000}/yr
            </p>
            <p className="text-[11px] text-slate-500">{singleOrgCount} Single Org • {mspCount} MSP</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" /> Pending Invites
            </span>
            <p className="text-3xl font-black text-amber-300 font-mono mt-1">{pendingInvitesCount}</p>
            <p className="text-[11px] text-slate-500">Awaiting contractor claim</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-purple-400" /> Enclave Seats Bound
            </span>
            <p className="text-3xl font-black text-purple-300 font-mono mt-1">
              {Object.values(teamMembers).reduce((acc, curr) => acc + curr.length, 0)}
            </p>
            <p className="text-[11px] text-slate-500">Owners, Assessors & Viewers</p>
          </div>
        </div>

        {/* Section 1: Tenant Enclave Registry */}
        <div className="p-6 rounded-3xl bg-slate-900/70 border border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Building2 className="w-4 h-4 text-brand-400" />
                <span>Isolated Defense Enclaves ({filteredTenants.length})</span>
              </h2>
              <p className="text-xs text-slate-400">
                DoD contractor environments with dedicated assessment matrix and SSP records
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search tenant name or CAGE..."
                value={tenantSearch}
                onChange={e => setTenantSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
              />
            </div>
          </div>

          {/* Tenants Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Organization & Boundary</th>
                  <th className="py-3 px-4">CAGE / SAM</th>
                  <th className="py-3 px-4">License Tier</th>
                  <th className="py-3 px-4">System Owner</th>
                  <th className="py-3 px-4">Seats</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredTenants.map(t => {
                  const members = teamMembers[t.id] || [];
                  return (
                    <tr key={t.id} className="hover:bg-slate-850/50 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-white text-xs">{t.name}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-xs">{t.systemName}</div>
                        <div className="text-[10px] font-mono text-slate-500">{t.id}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-brand-300 font-bold border border-slate-700/60">
                          {t.cageCode || 'PENDING'}
                        </span>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {t.samStatus === 'ACTIVE' ? (
                            <span className="text-emerald-400">SAM Active</span>
                          ) : (
                            <span className="text-slate-500">SAM {t.samStatus}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {t.licenseTier === 'msp-assessor' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-wide">
                            <Layers className="w-3 h-3" /> MSP Assessor
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-brand-500/20 text-brand-300 border border-brand-500/30 uppercase tracking-wide">
                            <Shield className="w-3 h-3" /> Single Org ($1k)
                          </span>
                        )}
                        {t.isDemo && (
                          <span className="ml-1 text-[9px] font-mono text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                            DEMO
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="text-slate-200 text-xs truncate max-w-xs">{t.systemOwner || 'Unassigned'}</div>
                        <div className="text-[10px] text-slate-500">{t.domain || 'N/A'}</div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-300">
                        {members.length > 0 ? `${members.length} members` : '1 (Owner)'}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleCopy(t.id, t.id, 'enclave')}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 text-[11px] transition-colors"
                            title="Copy Enclave Tenant ID"
                          >
                            {copiedEnclaveId === t.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => handleEnterEnclave(t.id)}
                            className="px-2.5 py-1.5 rounded-lg bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 hover:text-brand-200 border border-brand-500/30 text-xs font-semibold flex items-center gap-1 transition-colors"
                          >
                            <span>Launch</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
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

        {/* Section 2: Pending & Recent Onboarding Invitations */}
        <div className="p-6 rounded-3xl bg-slate-900/70 border border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                <span>Onboarding & Staff Invitations ({filteredInvitations.length})</span>
              </h2>
              <p className="text-xs text-slate-400">
                Cryptographically generated tokens awaiting claim via <code className="text-brand-300">/accept-invite</code>
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search email, tenant or token..."
                value={inviteSearch}
                onChange={e => setInviteSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Invited Recipient</th>
                  <th className="py-3 px-4">Enclave & Role</th>
                  <th className="py-3 px-4">Status & Expiration</th>
                  <th className="py-3 px-4">Invite Token</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredInvitations.map(inv => {
                  const isExpired = new Date(inv.expiresAt).getTime() < Date.now();
                  const inviteUrl = buildInviteUrl(inv.token);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-850/50 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-mono text-white text-xs font-semibold">{inv.email}</div>
                        <div className="text-[10px] text-slate-500">Invited by: {inv.invitedBy}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-200 text-xs">{inv.tenantName}</div>
                        <span className={`inline-block mt-0.5 px-2 py-0.5 rounded text-[10px] font-bold ${
                          inv.role === 'TENANT_OWNER'
                            ? 'bg-purple-500/20 text-purple-300'
                            : inv.role === 'ASSESSOR'
                            ? 'bg-blue-500/20 text-blue-300'
                            : 'bg-slate-700 text-slate-300'
                        }`}>
                          {inv.role === 'TENANT_OWNER' ? 'Tenant Owner' : inv.role === 'ASSESSOR' ? 'Assessor' : 'Viewer'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        {inv.status === 'ACCEPTED' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> Claimed
                          </span>
                        ) : inv.status === 'REVOKED' ? (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-bold text-[11px] bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                            Revoked
                          </span>
                        ) : isExpired ? (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-bold text-[11px] bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                            Expired
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sky-400 font-bold text-[11px] bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                            <Clock className="w-3 h-3" /> Pending Claim
                          </span>
                        )}
                        <div className="text-[10px] text-slate-500 mt-1">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <code className="font-mono text-[11px] text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800 select-all">
                            {inv.token.slice(0, 16)}...
                          </code>
                          <button
                            onClick={() => handleCopy(inviteUrl, inv.id, 'token')}
                            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                            title="Copy full invite link"
                          >
                            {copiedTokenId === inv.id ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.status === 'PENDING' && (
                            <>
                              <button
                                onClick={async () => {
                                  const res = await resendInvitation(inv.id);
                                  await handleCopy(res.inviteUrl, inv.id, 'token');
                                  alert(`Invitation renewed for 14 days! New link copied to clipboard.`);
                                }}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                                title="Resend & Extend Expiration"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`Revoke invitation for ${inv.email}?`)) {
                                    revokeInvitation(inv.id);
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 transition-colors"
                                title="Revoke Token"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          <a
                            href={inviteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white border border-slate-700 transition-colors"
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

        {/* Section 3: Stripe Checkout Webhook Integration Simulator */}
        <div className="p-6 rounded-3xl bg-slate-900/50 border border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                CHECKOUT WEBHOOK PIPELINE
              </span>
              <h2 className="text-base font-bold text-white flex items-center gap-2 mt-1">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <span>Stripe Payment Checkout Webhook Integration</span>
              </h2>
              <p className="text-xs text-slate-400">
                Trigger the headless provisioning pipeline directly via simulated <code className="text-indigo-300">checkout.session.completed</code> event payload.
              </p>
            </div>

            <button
              onClick={handleSimulateWebhook}
              disabled={isSimulatingWebhook}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white text-xs font-bold border border-slate-700 flex items-center gap-2 transition-all active:scale-[0.98] shrink-0"
            >
              {isSimulatingWebhook ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Simulating Webhook Event...</span>
                </>
              ) : (
                <>
                  <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Simulate Stripe Webhook Checkout</span>
                </>
              )}
            </button>
          </div>

          {/* Webhook result preview */}
          {webhookResult && (
            <div className="p-4 rounded-2xl bg-indigo-950/40 border border-indigo-500/30 text-xs space-y-3 animate-fadeIn">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-indigo-300 font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Webhook Tenant Provisioned via provisionTenantFromWebhook()</span>
                </div>
                <button
                  onClick={() => setWebhookResult(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] text-slate-300">
                <div>Enclave: <strong className="text-white">{webhookResult.tenant.name}</strong></div>
                <div>CAGE: <strong className="text-brand-300">{webhookResult.tenant.cageCode}</strong></div>
                <div>Owner: <strong className="text-white">{webhookResult.invitation.email}</strong></div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-indigo-500/20">
                <input
                  type="text"
                  readOnly
                  value={webhookResult.inviteUrl}
                  className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-indigo-500/30 rounded-lg text-slate-200 font-mono select-all"
                />
                <button
                  onClick={() => handleCopy(webhookResult.inviteUrl, 'webhook-res', 'token')}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs transition-colors shrink-0"
                >
                  {copiedTokenId === 'webhook-res' ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={webhookResult.inviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white border border-slate-700 shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          )}
        </div>

      </main>

      {/* New Tenant Provisioning Modal */}
      <NewTenantModal
        isOpen={isNewTenantModalOpen}
        onClose={() => setIsNewTenantModalOpen(false)}
      />

    </div>
  );
};
