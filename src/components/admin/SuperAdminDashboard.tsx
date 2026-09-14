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
  ArrowRight,
  Sparkles,
  Globe,
  Clock,
  ArrowUpRight,
  Award,
  ArrowLeft,
} from 'lucide-react';
import { useTenant, buildInviteUrl } from '../../context/TenantContext';
import { useAuth } from '../../context/AuthContext';
import { BrandLogo } from '../common/BrandLogo';
import { getLicenseTierPrice, normalizeLicenseTier } from '../../types/tenant';
import { NewTenantModal } from './NewTenantModal';
import { FinanceProvisioningLog } from './FinanceProvisioningLog';

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
    revokeInvitation,
    resendInvitation,
  } = useTenant();

  const { logout, openAuthModal } = useAuth();

  // Modals & UI state
  const [isNewTenantModalOpen, setIsNewTenantModalOpen] = useState(false);
  const [tenantSearch, setTenantSearch] = useState('');
  const [inviteSearch, setInviteSearch] = useState('');
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [copiedEnclaveId, setCopiedEnclaveId] = useState<string | null>(null);

  const hasAccess = isSuperAdmin;

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
              <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold px-3 py-1 rounded-full bg-slate-900 text-slate-400 border border-slate-800">
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
  const foundationalCount = tenants.filter(t => normalizeLicenseTier(t.licenseTier) === 'FOUNDATIONAL').length;
  const defenseProCount = tenants.filter(t => normalizeLicenseTier(t.licenseTier) === 'DEFENSE_PRO').length;
  const enterpriseCount = tenants.filter(t => normalizeLicenseTier(t.licenseTier) === 'ENTERPRISE').length;
  const totalArr = tenants.reduce((acc, t) => acc + getLicenseTierPrice(t.licenseTier), 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-brand-500 selection:text-white">
      
      {/* Top Super Admin Navigation Bar */}
      <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-4 sm:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <BrandLogo size="md" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base text-white tracking-tight">Event Horizon: Singularity</span>
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
              className="btn-primary text-xs px-5 py-2.5"
            >
              <Plus className="w-4 h-4" />
              <span>Provision New Tenant</span>
            </button>
          </div>
        </div>

        {/* KPI Metrics Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="stitch-card p-5 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-cyan-400" /> Total Enclaves
            </span>
            <p className="text-3xl font-black text-white font-mono mt-1">{tenants.length}</p>
            <p className="text-[11px] text-slate-500">Live & sandbox organizations</p>
          </div>

          <div className="stitch-card p-5 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> Active ARR Run-Rate
            </span>
            <p className="text-3xl font-black text-emerald-400 font-mono mt-1">
              ${totalArr.toLocaleString()}/yr
            </p>
            <p className="text-[11px] text-slate-500">
              {foundationalCount} Foundational • {defenseProCount} Defense Pro • {enterpriseCount} Enterprise
            </p>
          </div>

          <div className="stitch-card p-5 space-y-1">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" /> Pending Invites
            </span>
            <p className="text-3xl font-black text-amber-300 font-mono mt-1">{pendingInvitesCount}</p>
            <p className="text-[11px] text-slate-500">Awaiting contractor claim</p>
          </div>

          <div className="stitch-card p-5 space-y-1">
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
        <div className="stitch-card p-6 space-y-4">
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
                  <th className="py-3 px-4">Framework Scope</th>
                  <th className="py-3 px-4">System Owner</th>
                  <th className="py-3 px-4">Seats</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 font-sans">
                {filteredTenants.map(t => {
                  const members = teamMembers[t.id] || [];
                  const activeFrameworks = t.enabledFrameworks && t.enabledFrameworks.length > 0
                    ? t.enabledFrameworks
                    : [t.primaryFramework || 'CMMC_L1'];
                  return (
                    <tr
                      key={t.id}
                      className="even:bg-slate-950/40 odd:bg-slate-900/20 hover:bg-slate-800/60 transition-colors duration-150"
                    >
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-white text-xs">{t.name}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-xs">{t.systemName}</div>
                        <div className="text-[10px] font-mono text-slate-500">{t.id}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="font-mono text-xs px-2 py-0.5 rounded bg-cyan-950/40 text-cyan-300 font-bold border border-cyan-500/30">
                          {t.cageCode || 'PENDING'}
                        </span>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {t.samStatus === 'ACTIVE' ? (
                            <span className="text-emerald-400 font-medium">SAM Active</span>
                          ) : (
                            <span className="text-slate-500">SAM {t.samStatus}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {(() => {
                          const norm = normalizeLicenseTier(t.licenseTier);
                          if (norm === 'ENTERPRISE') {
                            return (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-wide">
                                <Building2 className="w-3 h-3" /> Enterprise ($14k)
                              </span>
                            );
                          }
                          if (norm === 'DEFENSE_PRO') {
                            return (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-brand-500/20 text-brand-300 border border-brand-500/30 uppercase tracking-wide">
                                <Award className="w-3 h-3" /> Defense Pro ($7k)
                              </span>
                            );
                          }
                          return (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase tracking-wide">
                              <Shield className="w-3 h-3" /> Foundational ($3.5k)
                            </span>
                          );
                        })()}
                        {t.isDemo && (
                          <span className="ml-1 text-[9px] font-mono font-bold text-amber-300 bg-amber-500/15 px-1.5 py-0.5 rounded border border-amber-500/30">
                            DEMO
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-brand-500/20 text-brand-300 border border-brand-500/30">
                              {t.primaryFramework || 'CMMC_L1'}
                            </span>
                            <span className="text-[9px] font-mono text-slate-400">PRIMARY</span>
                          </div>
                          {activeFrameworks.length > 1 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {activeFrameworks.filter(f => f !== (t.primaryFramework || 'CMMC_L1')).map(fw => (
                                <span key={fw} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/80">
                                  {fw}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="text-slate-200 text-xs font-medium truncate max-w-xs">{t.systemOwner || 'Unassigned'}</div>
                        <div className="text-[10px] font-mono text-slate-500">{t.domain || 'N/A'}</div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-300">
                        {members.length > 0 ? `${members.length} members` : '1 (Owner)'}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleCopy(t.id, t.id, 'enclave')}
                            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 transition-all"
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
                            className="btn-primary text-xs px-3 py-1.5"
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
        <div className="stitch-card p-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                <span>Onboarding & Staff Invitations ({filteredInvitations.length})</span>
              </h2>
              <p className="text-xs text-slate-400">
                Cryptographically generated tokens awaiting claim via <code className="text-cyan-300 font-mono">/accept-invite</code>
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search email, tenant or token..."
                value={inviteSearch}
                onChange={e => setInviteSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
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
                        <div className="text-[10px] text-slate-500 font-mono">Invited by: {inv.invitedBy}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-slate-200 text-xs">{inv.tenantName}</div>
                        {inv.role === 'TENANT_OWNER' ? (
                          <span className="inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30">
                            <Shield className="w-3 h-3" /> Tenant Owner
                          </span>
                        ) : inv.role === 'ASSESSOR' ? (
                          <span className="inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                            <CheckCircle2 className="w-3 h-3" /> Assessor
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-slate-700/50 text-slate-300 border border-slate-600/50">
                            <Lock className="w-3 h-3" /> Viewer
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {inv.status === 'ACCEPTED' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-bold font-mono text-[11px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> Claimed
                          </span>
                        ) : inv.status === 'REVOKED' ? (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-bold font-mono text-[11px] bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                            Revoked
                          </span>
                        ) : isExpired ? (
                          <span className="inline-flex items-center gap-1 text-amber-400 font-bold font-mono text-[11px] bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                            Expired
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-cyan-300 font-bold font-mono text-[11px] bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                            <Clock className="w-3 h-3 text-cyan-400" /> Pending Claim
                          </span>
                        )}
                        <div className="text-[10px] font-mono text-slate-500 mt-1">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <code className="font-mono text-[11px] text-slate-300 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 select-all">
                            {inv.token.slice(0, 16)}...
                          </code>
                          <button
                            onClick={() => handleCopy(inviteUrl, inv.id, 'token')}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 transition-all"
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
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 transition-all"
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
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 border border-slate-700 hover:scale-105 active:scale-95 transition-all"
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
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-white border border-slate-700 hover:scale-105 active:scale-95 transition-all"
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

        {/* Section 3: Finance-Driven Manual Provisioning Pipeline & Audit Log */}
        <FinanceProvisioningLog
          tenants={tenants}
          invitations={invitations}
          onOpenNewTenantModal={() => setIsNewTenantModalOpen(true)}
          onEnterEnclave={handleEnterEnclave}
        />

      </main>

      {/* New Tenant Provisioning Modal */}
      <NewTenantModal
        isOpen={isNewTenantModalOpen}
        onClose={() => setIsNewTenantModalOpen(false)}
      />

    </div>
  );
};
