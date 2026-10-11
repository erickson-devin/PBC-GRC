import React from 'react';
import {
  LayoutDashboard,
  CheckSquare,
  FileText,
  BookOpen,
  Layers,
  Building,
  Users,
  ShieldCheck,
  Terminal,
  ExternalLink,
  Server,
  ClipboardList,
  Package,
  Settings,
  Lock,
  Scroll,
} from 'lucide-react';
import { useAssessment, NavigationTab } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { getFrameworkGuidanceText, FRAMEWORK_REGISTRY } from '../../data/frameworks';
import { BrandLogo } from '../common/BrandLogo';

// ─── Badge Design System ────────────────────────────────────────────────────
type BadgeVariant = 'neutral' | 'status' | 'accent';

const BADGE_VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-800/60 text-slate-300 border border-slate-700/50',
  status:  'bg-cyan-950/40 text-cyan-400 border border-cyan-800/40',
  accent:  'bg-purple-950/40 text-purple-300 border border-purple-800/40',
};

const BADGE_BASE =
  'inline-flex items-center justify-center shrink-0 rounded-full px-2.5 py-0.5 text-xs font-mono tracking-tight leading-none whitespace-nowrap font-medium';

interface SidebarBadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
}

/** Standardized sidebar badge pill with design-system tokens. */
const SidebarBadge: React.FC<SidebarBadgeProps> = ({ children, variant = 'neutral' }) => (
  <span className={`${BADGE_BASE} ${BADGE_VARIANT_CLASSES[variant]}`}>
    {children}
  </span>
);

// ─── Sidebar navigation item types ─────────────────────────────────────────
interface NavItem {
  id: NavigationTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string | number;
  badgeVariant?: BadgeVariant;
}

interface ExternalNavItem {
  kind: 'external';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  badge?: string;
  badgeVariant?: BadgeVariant;
}

type SidebarItem = NavItem | ExternalNavItem;

interface NavSection {
  title: string;
  items: SidebarItem[];
}

// ─── Role label helper ──────────────────────────────────────────────────────
function getRoleLabel(role: string): string {
  switch (role) {
    case 'TENANT_OWNER': return 'Owner';
    case 'MSP_ADMIN':    return 'MSP Admin';
    case 'ASSESSOR':     return 'Assessor';
    case 'VIEWER':       return 'Viewer';
    default:             return role;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────
export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab, metrics, state, frameworkControls } = useAssessment();
  const {
    currentTenant,
    currentRole,
    isSuperAdmin,
    activeFramework,
  } = useTenant();

  const totalControls = frameworkControls.length || metrics.totalControls || 17;
  const guidance = getFrameworkGuidanceText(activeFramework);

  // ── Dynamic data bindings ───────────────────────────────────────────────
  const frameworkDef = FRAMEWORK_REGISTRY[activeFramework];
  const familyCount = frameworkDef?.domains
    ? Object.keys(frameworkDef.domains).length
    : 0;
  const evidenceCount = state.evidenceIndex.length;
  const completionLabel = metrics.isSprsReady
    ? '100%'
    : `${metrics.completionPercentage}%`;

  // Photon external URL — environment-configurable, falls back to Blake's beta instance
  const photonUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PHOTON_URL)
    || 'http://beta.vpn.pitchblackcyber.com:8800/';

  // ── Section Definitions ─────────────────────────────────────────────────
  const sections: NavSection[] = [
    {
      title: 'GRC Core',
      items: [
        {
          id: 'dashboard',
          label: 'Compliance Dashboard',
          icon: LayoutDashboard,
        },
        {
          id: 'matrix',
          label: `Control Matrix (${totalControls})`,
          icon: CheckSquare,
          badge: completionLabel,
          badgeVariant: metrics.isSprsReady ? 'status' : 'neutral',
        },
        {
          id: 'assets',
          label: 'Asset Inventory & Fleet',
          icon: Server,
        },
      ],
    },
    {
      title: 'Automation & Evidence',
      items: [
        {
          kind: 'external',
          label: 'Technical Baselines & STIGs',
          icon: Terminal,
          href: photonUrl,
          badgeVariant: 'status',
        } as ExternalNavItem,
        {
          id: 'evidence',
          label: 'Evidence Vault',
          icon: Lock,
          badge: evidenceCount,
          badgeVariant: 'neutral',
        },
      ],
    },
    {
      title: 'Compliance Documents & Exports',
      items: [
        {
          id: 'policies',
          label: 'Living Policy Library',
          icon: Scroll,
          badge: familyCount > 0 ? `${familyCount} Families` : undefined,
          badgeVariant: 'status',
        },
        {
          id: 'ssp',
          label: 'System Security Plan (SSP)',
          icon: FileText,
          badge: metrics.isSprsReady ? 'Audit Ready' : `${metrics.completionPercentage}%`,
          badgeVariant: metrics.isSprsReady ? 'status' : 'neutral',
        },
        {
          id: 'poam',
          label: 'Plan of Action & Milestones (POA&M)',
          icon: ClipboardList,
        },
        {
          id: 'export',
          label: 'Export Audit Package',
          icon: Package,
        },
      ],
    },
    {
      title: 'Enclave & Administration',
      items: [
        {
          id: 'rbac',
          label: 'Team & Role RBAC',
          icon: Users,
          badge: getRoleLabel(currentRole),
          badgeVariant: 'accent',
        },
        {
          id: 'audit_logs',
          label: 'Immutable Audit Trail',
          icon: ShieldCheck,
          badge: guidance.standardRef.split('/')[0].trim(),
          badgeVariant: 'status',
        },
        {
          id: 'guidance',
          label: 'Framework Guidance & Authority',
          icon: BookOpen,
        },
        {
          id: 'settings',
          label: 'Enclave Settings',
          icon: Settings,
        },
      ],
    },
  ];

  // ── Helpers ─────────────────────────────────────────────────────────────
  const isExternal = (item: SidebarItem): item is ExternalNavItem =>
    (item as ExternalNavItem).kind === 'external';

  const isActiveTab = (tabId: NavigationTab): boolean =>
    activeTab === tabId;

  const handleExternalClick = (href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  // ── Render ──────────────────────────────────────────────────────────────
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

        {/* Dynamic Navigation Sections */}
        {sections.map((section) => (
          <div key={section.title}>
            <p className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase px-3 mb-2">
              {section.title}
            </p>
            <nav className="space-y-1">
              {section.items.map((item) => {
                if (isExternal(item)) {
                  // ── External Link (opens in new tab) ──
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      onClick={() => handleExternalClick(item.href)}
                      className="w-full flex items-center justify-between min-h-[36px] px-3 py-1.5 rounded-xl font-medium text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent transition-all text-left group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        <ExternalLink className="w-3 h-3 text-slate-400 group-hover:text-cyan-400 transition-colors" />
                      </div>
                    </button>
                  );
                }

                // ── Internal Tab Navigation ──
                const navItem = item as NavItem;
                const Icon = navItem.icon;
                const isActive = isActiveTab(navItem.id);

                return (
                  <button
                    key={navItem.id}
                    onClick={() => setActiveTab(navItem.id)}
                    className={`w-full flex items-center justify-between min-h-[36px] px-3 py-1.5 rounded-xl font-medium text-sm transition-all text-left ${
                      isActive
                        ? 'bg-brand-600/15 text-brand-400 border border-brand-500/30 shadow-sm shadow-brand-500/10'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-400'}`} />
                      <span className="truncate">{navItem.label}</span>
                    </div>
                    {navItem.badge !== undefined && (
                      <div className="shrink-0 ml-2">
                        <SidebarBadge variant={navItem.badgeVariant}>
                          {navItem.badge}
                        </SidebarBadge>
                      </div>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
        ))}

        {/* Super Admin Operator Access */}
        {isSuperAdmin && (
          <div>
            <button
              onClick={() => {
                if (typeof window !== 'undefined') window.location.hash = 'admin';
              }}
              className="w-full flex items-center justify-between min-h-[36px] px-3 py-1.5 rounded-xl font-bold text-xs text-amber-300 hover:text-amber-200 hover:bg-amber-950/40 border border-amber-500/30 transition-all text-left shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-amber-400" />
                <span>Super Admin Portal</span>
              </div>
              <span className="inline-flex items-center justify-center shrink-0 rounded-full px-2.5 py-0.5 text-[10px] uppercase font-mono tracking-tight leading-none whitespace-nowrap bg-amber-500/20 text-amber-300 border border-amber-500/30">
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
      <div className="hidden md:block pt-4 border-t border-slate-800/80 text-[11px] text-slate-400 space-y-1">
        <p className="flex items-center gap-1">
          <Layers className="w-3.5 h-3.5 text-slate-400" />
          <span>{guidance.authority} Compliant</span>
        </p>
        <p>{totalControls} Controls • {guidance.poamPermitted ? 'Time-Bounded POA&Ms' : 'Zero POA&Ms Allowed'}</p>
      </div>
    </aside>
  );
};
