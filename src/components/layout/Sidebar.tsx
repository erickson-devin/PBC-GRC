import React from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  FileText,
  Paperclip,
  BookOpen,
  Layers,
  Cloud,
  Building,
} from 'lucide-react';
import { useAssessment, NavigationTab } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';

export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab, metrics, state } = useAssessment();
  const { currentTenant, setIsGcpArchitectureModalOpen } = useTenant();

  const navItems: { id: NavigationTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: string | number; badgeColor?: string }[] = [
    {
      id: 'dashboard',
      label: 'Compliance Dashboard',
      icon: LayoutDashboard,
    },
    {
      id: 'controls',
      label: 'Control Matrix (17)',
      icon: CheckSquare,
      badge: `${metrics.metCount}/17`,
      badgeColor: metrics.isSprsReady ? 'bg-emerald-500/20 text-emerald-300' : 'bg-brand-500/20 text-brand-300',
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
      id: 'guidance',
      label: 'CMMC & FAR Guidance',
      icon: BookOpen,
    },
  ];

  return (
    <aside className="no-print w-full md:w-64 bg-slate-900/60 border-r border-slate-800 flex flex-col justify-between p-4 shrink-0">
      <div className="space-y-6">
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

        {/* GCP Cloud Infrastructure Navigation Card */}
        <div className="hidden md:block">
          <button
            onClick={() => setIsGcpArchitectureModalOpen(true)}
            className="w-full p-3 rounded-2xl bg-gradient-to-br from-slate-900 to-brand-950/40 border border-brand-500/20 hover:border-brand-500/40 text-left transition-all group"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-brand-300 flex items-center gap-1.5">
                <Cloud className="w-3.5 h-3.5 text-brand-400" />
                GCP Backend
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Active
              </span>
            </div>
            <p className="text-xs text-slate-300 font-semibold group-hover:text-white transition-colors">
              Cloud SQL & GCS Storage
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              PostgreSQL RLS & SHA-256 vault
            </p>
          </button>
        </div>

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
          <span>FAR 52.204-21 Compliant</span>
        </p>
        <p>17 Controls • Zero POA&Ms Allowed</p>
      </div>
    </aside>
  );
};
