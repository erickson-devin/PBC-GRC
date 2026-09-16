import React from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  FileText,
  Paperclip,
  BookOpen,
  Layers,
  Building,
  Users,
  Shield,
  ShieldCheck,
  Terminal,
  FileCheck,
} from 'lucide-react';
import { useAssessment, NavigationTab } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getFrameworkGuidanceText } from '../../data/frameworks';
import { BrandLogo } from '../common/BrandLogo';

export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab, metrics, state, frameworkControls, openExportModal } = useAssessment();
  const {
    currentTenant,
    canManageTenant,
    setIsTeamModalOpen,
    setIsStigModalOpen,
    isSuperAdmin,
    activeFramework,
  } = useTenant();

  const totalControls = frameworkControls.length || metrics.totalControls || 17;
  const guidance = getFrameworkGuidanceText(activeFramework);

  const navItems: { id: NavigationTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: string | number; badgeColor?: string }[] = [
    {
      id: 'dashboard',
      label: 'Compliance Dashboard',
      icon: LayoutDashboard,
    },
    {
      id: 'controls',
      label: `Control Matrix (${totalControls})`,
      icon: CheckSquare,
      badge: metrics.isSprsReady ? '100%' : `${metrics.completionPercentage}%`,
      badgeColor: metrics.isSprsReady ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-300',
    },
    {
      id: 'ssp',
      label: 'System Security Plan (SSP)',
      icon: FileText,
      badge: 'Audit Ready',
      badgeColor: 'bg-indigo-500/20 text-indigo-300',
    },
    {
      id: 'vault',
      label: 'Evidence Vault',
      icon: Paperclip,
      badge: state.evidenceIndex.length,
      badgeColor: 'bg-slate-700 text-slate-300',
    },
    {
      id: 'audit',
      label: 'Audit Trail (Immutable)',
      icon: ShieldCheck,
      badge: 'NIST 3.3',
      badgeColor: 'bg-cyan-500/20 text-cyan-300',
    },
    {
      id: 'guidance',
      label: 'CMMC & FAR Guidance',
      icon: BookOpen,
    },
  ];

  return (
    <aside className="no-print w-full md:w-64 bg-slate-900/60 border-r border-slate-800 flex flex-col justify-between p-4 shrink-0">
      <div className="space-y-6">
        {/* Top Branding Block */}
        <div 
          onClick={() => setActiveTab('dashboard')}
          className="px-2 py-1.5 cursor-pointer group flex items-center gap-3 border-b border-slate-800/80 pb-4"
        >
          <BrandLogo size="md" />
          <div className="min-w-0">
            <h2 className="text-xs font-black tracking-tight text-white group-hover:text-cyan-400 transition-colors truncate">
              Event Horizon: Singularity
            </h2>
            <p className="text-[10px] font-mono text-cyan-400/90 tracking-wider uppercase mt-0.5 truncate">
              Pitch Black Cyber // Singularity GRC
            </p>
          </div>
        </div>

        {/* Navigation Items */}
        <div>
          <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase px-3 mb-2">
            GRC Modules
          </p>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium text-sm transition-all text-left ${
                    isActive
                      ? 'bg-brand-600/15 text-brand-400 border border-brand-500/30 shadow-sm shadow-brand-500/10'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-brand-400' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge !== undefined && (
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${item.badgeColor || 'bg-slate-800 text-slate-300'}`}>
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Compliance Documentation & Artifact Exporter */}
        <div className="space-y-1">
          <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase px-3 mb-1">
            Compliance Documentation
          </p>
          <button
            onClick={() => openExportModal()}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium text-xs text-indigo-300 hover:text-white hover:bg-indigo-950/40 border border-indigo-500/30 transition-all text-left shadow-sm group"
          >
            <div className="flex items-center gap-2.5">
              <FileCheck className="w-4 h-4 text-indigo-400 group-hover:scale-110 transition-transform" />
              <span>Export Compliance Package</span>
            </div>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              SSP / POA&M
            </span>
          </button>
        </div>

        {/* Enclave Administration & Hardening Baselines */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase px-3 mb-1">
            Enclave Administration
          </p>

          <button
            onClick={() => setIsStigModalOpen(true)}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium text-xs text-cyan-300 hover:text-white hover:bg-cyan-950/40 border border-cyan-500/30 transition-all text-left shadow-sm group"
          >
            <div className="flex items-center gap-2.5">
              <Terminal className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform" />
              <span>Technical Baselines & STIGs</span>
            </div>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              DISA
            </span>
          </button>

          {canManageTenant && (
            <button
              onClick={() => setIsTeamModalOpen(true)}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium text-xs text-purple-300 hover:text-white hover:bg-purple-950/30 border border-purple-500/20 transition-all text-left shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <Users className="w-4 h-4 text-purple-400" />
                <span>Team & Role RBAC</span>
              </div>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                Owner
              </span>
            </button>
          )}
        </div>

        {/* Super Admin Operator Access */}
        {isSuperAdmin && (
          <div>
            <button
              onClick={() => {
                if (typeof window !== 'undefined') window.location.hash = 'admin';
              }}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-bold text-xs text-amber-300 hover:text-amber-200 hover:bg-amber-950/40 border border-amber-500/30 transition-all text-left shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <Shield className="w-4 h-4 text-amber-400" />
                <span>Super Admin Portal</span>
              </div>
              <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                /admin
              </span>
            </button>
          </div>
        )}



        {/* Active Client Organization Context Card */}
        <div className="hidden md:block p-3.5 rounded-2xl bg-slate-850 border border-slate-800/80 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase text-slate-400 flex items-center gap-1.5">
              <Building className="w-3.5 h-3.5 text-brand-400" />
              Active Tenant
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-brand-300">
              {currentTenant.cageCode || 'CAGE'}
            </span>
          </div>

          <div className="text-xs text-slate-300">
            <p className="font-bold truncate text-white">{currentTenant.name}</p>
            <p className="text-[11px] text-slate-400 truncate mt-0.5">
              {currentTenant.systemName}
            </p>
          </div>

          <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
            <span className="text-slate-400">Controls Met</span>
            <span className="font-semibold text-white">
              {metrics.metCount} / {metrics.totalControls}
            </span>
          </div>
          
          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 rounded-full ${
                metrics.isSprsReady ? 'bg-emerald-500' : 'bg-brand-500'
              }`}
              style={{ width: `${metrics.completionPercentage}%` }}
            />
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="hidden md:block pt-4 border-t border-slate-800/80 text-[11px] text-slate-500 space-y-1">
        <p className="flex items-center gap-1">
          <Layers className="w-3.5 h-3.5 text-slate-400" />
          <span>{guidance.authority} Compliant</span>
        </p>
        <p>{totalControls} Controls • {guidance.poamPermitted ? 'Time-Bounded POA&Ms' : 'Zero POA&Ms Allowed'}</p>
      </div>
    </aside>
  );
};
