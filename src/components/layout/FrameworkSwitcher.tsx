import React, { useState, useRef, useEffect } from 'react';
import {
  Layers,
  ChevronDown,
  Check,
  Shield,
  WifiOff,
  Sliders,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { ComplianceFramework, BaselineTier } from '../../types/framework';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';

export const FrameworkSwitcher: React.FC = () => {
  const {
    currentTenant,
    activeFramework,
    setActiveFramework,
    activeBaselineTier,
    setActiveBaselineTier,
    activeOverlayFilters,
    toggleNonNetworkedOverlay,
  } = useTenant();

  const { metrics } = useAssessment();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentFrameworkDef = FRAMEWORK_REGISTRY[activeFramework] || FRAMEWORK_REGISTRY.CMMC_L1;

  // Compute frameworks allowed for the active enclave
  const enclaveFrameworks: ComplianceFramework[] =
    currentTenant.enabledFrameworks && currentTenant.enabledFrameworks.length > 0
      ? currentTenant.enabledFrameworks
      : [currentTenant.primaryFramework || 'CMMC_L1'];

  const isMultiFramework = enclaveFrameworks.length > 1;

  const frameworksList: {
    id: ComplianceFramework;
    label: string;
    badge: string;
    authority: string;
    count: number;
    description: string;
  }[] = [
    {
      id: 'CMMC_L1',
      label: 'CMMC Level 1 (Foundational)',
      badge: 'FAR 52.204-21',
      authority: 'DoD CMMC 2.0',
      count: 17,
      description: '17 basic safeguarding requirements for Federal Contract Information (FCI).',
    },
    {
      id: 'CMMC_L2',
      label: 'CMMC Level 2 (Advanced)',
      badge: 'NIST 800-171',
      authority: 'DFARS 252.204-7012',
      count: 110,
      description: '110 security controls across 14 families for Controlled Unclassified Information (CUI).',
    },
    {
      id: 'NIST_800_53_REV5',
      label: 'NIST SP 800-53 Rev 5',
      badge: 'Low / Mod Baselines',
      authority: 'Federal Information Systems',
      count: FRAMEWORK_REGISTRY.NIST_800_53_REV5.totalControls,
      description: 'Federal security baselines supporting Low/Mod impact and non-networked overlays.',
    },
    {
      id: 'SOC_2_TYPE_II',
      label: 'SOC 2 Type II',
      badge: 'AICPA TSC',
      authority: 'Trust Services Criteria',
      count: FRAMEWORK_REGISTRY.SOC_2_TYPE_II.totalControls,
      description: 'Security (Common Criteria CC1-CC9), Availability, and Confidentiality evaluation.',
    },
    {
      id: 'HIPAA_SECURITY',
      label: 'HIPAA Security Rule',
      badge: '45 CFR Part 164',
      authority: 'HHS Office for Civil Rights',
      count: FRAMEWORK_REGISTRY.HIPAA_SECURITY.totalControls,
      description: 'National standards protecting electronic protected health information (ePHI).',
    },
  ];

  const availableFrameworks = frameworksList.filter(f => enclaveFrameworks.includes(f.id));

  return (
    <div className="relative flex items-center gap-2" ref={dropdownRef}>
      {/* If enclave has only 1 framework enabled: render sleek read-only tactical badge */}
      {!isMultiFramework ? (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800/90 text-slate-200 shadow-sm"
          title={`Enclave compliance scope strictly locked to ${currentFrameworkDef.shortName}`}
        >
          <div className="w-5 h-5 rounded-md bg-brand-500/20 text-brand-400 flex items-center justify-center border border-brand-500/30">
            <Shield className="w-3 h-3" />
          </div>
          <div className="text-left">
            <div className="text-[10px] text-slate-400 font-mono leading-none flex items-center gap-1">
              <span>SCOPE: {currentFrameworkDef.shortName}</span>
              {activeOverlayFilters.nonNetworkedOnly && (
                <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                  TACTICAL
                </span>
              )}
            </div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
              <span>{currentFrameworkDef.shortName}</span>
              <span className="text-[10px] font-mono text-cyan-300 font-normal">
                ({metrics.totalControls})
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* Multi-framework Enclave: interactive dropdown scoped strictly to enabled frameworks */
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/50 text-slate-200 transition-all shadow-sm group"
          title="Switch active compliance framework for this enclave"
        >
          <div className="w-5 h-5 rounded-md bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30 group-hover:scale-105 transition-transform">
            <Layers className="w-3 h-3" />
          </div>
          <div className="text-left">
            <div className="text-[10px] text-slate-400 font-mono leading-none flex items-center gap-1">
              <span>SCOPE: {enclaveFrameworks.length} ACTIVE</span>
              {activeOverlayFilters.nonNetworkedOnly && (
                <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                  TACTICAL
                </span>
              )}
            </div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
              <span>{currentFrameworkDef.shortName}</span>
              <span className="text-[10px] font-mono text-cyan-300 font-normal">
                ({metrics.totalControls})
              </span>
            </div>
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 ml-0.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      )}

      {/* Tactical / Non-Networked Overlay Toggle Button */}
      <button
        onClick={toggleNonNetworkedOverlay}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all ${
          activeOverlayFilters.nonNetworkedOnly
            ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm shadow-amber-500/10'
            : 'bg-slate-800/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border-slate-700/70'
        }`}
        title={
          activeOverlayFilters.nonNetworkedOnly
            ? 'Tactical / Non-Networked System Overlay is ACTIVE (hiding non-applicable network boundary controls). Click to show all controls.'
            : 'Click to enable Tactical / Non-Networked System Overlay (hides non-applicable network boundary controls)'
        }
      >
        <WifiOff className={`w-3.5 h-3.5 ${activeOverlayFilters.nonNetworkedOnly ? 'text-amber-400 animate-pulse' : 'text-slate-400'}`} />
        <span className="hidden xl:inline text-[11px]">
          {activeOverlayFilters.nonNetworkedOnly ? 'Tactical Overlay: ON' : 'Tactical Overlay'}
        </span>
      </button>

      {/* Dropdown Menu (Only rendered when multi-framework and open) */}
      {isMultiFramework && isOpen && (
        <div className="absolute left-0 top-full mt-2 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2.5 space-y-2 backdrop-blur-xl animate-fadeIn">
          <div className="px-2.5 py-1.5 border-b border-slate-800">
            <div className="text-xs font-bold text-white flex items-center justify-between">
              <span>Enclave Compliance Scopes ({availableFrameworks.length})</span>
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                ENCLAVE-SCOPED GRC
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Instantly switch between active compliance baselines provisioned for this enclave.
            </p>
          </div>

          {/* Frameworks List (Filtered to Enclave-Enabled Only) */}
          <div className="space-y-1">
            {availableFrameworks.map((f) => {
              const isSelected = activeFramework === f.id;
              return (
                <div
                  key={f.id}
                  onClick={() => {
                    setActiveFramework(f.id);
                    setIsOpen(false);
                  }}
                  className={`p-2.5 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-cyan-500/15 border border-cyan-500/40 text-white'
                      : 'hover:bg-slate-800/70 text-slate-300 border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                        isSelected ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-400'
                      }`}>
                        <Shield className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <span>{f.label}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                            {f.count}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                          {f.badge} • {f.authority}
                        </div>
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-cyan-400 shrink-0" />}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5 pl-9 leading-relaxed">
                    {f.description}
                  </p>
                </div>
              );
            })}
          </div>

          {/* NIST 800-53 Baseline Tier Options (Visible if NIST selected) */}
          {activeFramework === 'NIST_800_53_REV5' && (
            <div className="pt-2 border-t border-slate-800 px-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-300">
                <span className="flex items-center gap-1">
                  <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                  <span>NIST 800-53 Baseline Tier</span>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'LOW_LOW_LOW' as BaselineTier, label: 'Low Impact', desc: 'Standard Low' },
                  { id: 'MOD_MOD_MOD' as BaselineTier, label: 'Moderate', desc: 'Full Baseline' },
                  { id: 'LOW_LOW_MOD' as BaselineTier, label: 'Low-Mod', desc: 'High Avail' },
                ].map(b => (
                  <button
                    key={b.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveBaselineTier(b.id);
                    }}
                    className={`py-1.5 px-2 rounded-lg text-center text-xs transition-all ${
                      activeBaselineTier === b.id
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                        : 'bg-slate-800/70 hover:bg-slate-800 text-slate-400 border border-slate-700/60'
                    }`}
                  >
                    <div className="font-bold text-[11px]">{b.label}</div>
                    <div className="text-[9px] text-slate-400 mt-0.5">{b.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Overlay Parameter Toggle Callout */}
          <div className="pt-2 border-t border-slate-800 px-2 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <WifiOff className={`w-4 h-4 ${activeOverlayFilters.nonNetworkedOnly ? 'text-amber-400' : 'text-slate-500'}`} />
              <div>
                <div className="font-bold text-slate-200 text-[11px]">Tactical / Non-Networked Overlay</div>
                <div className="text-[10px] text-slate-400">Filters out network boundary controls</div>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleNonNetworkedOverlay();
              }}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                activeOverlayFilters.nonNetworkedOnly
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'
              }`}
            >
              {activeOverlayFilters.nonNetworkedOnly ? 'Enabled' : 'Disabled'}
            </button>
          </div>

        </div>
      )}
    </div>
  );
};
