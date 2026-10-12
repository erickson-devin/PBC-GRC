import React, { useState, useRef, useEffect } from 'react';
import {
  Layers,
  ChevronDown,
  Check,
  Shield,
  WifiOff,
  Sliders,
  Radio,
  Smartphone,
  EyeOff,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { ComplianceFramework, ImpactLevel } from '../../types/framework';
import { FRAMEWORK_REGISTRY, getFrameworkFamilyCount } from '../../data/frameworks';

export const FrameworkSwitcher: React.FC = () => {
  const {
    currentTenant,
    activeFramework,
    setActiveFramework,
    activeOverlayFilters,
    toggleNonNetworkedOverlay,
    toggleOverlayFilter,
    ciaTriad,
    setCiaImpact,
    toggleAllControlsApplied,
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
      count: FRAMEWORK_REGISTRY.CMMC_L1.totalControls,
      description: `${FRAMEWORK_REGISTRY.CMMC_L1.totalControls} basic safeguarding requirements across ${getFrameworkFamilyCount('CMMC_L1')} families for Federal Contract Information (FCI).`,
    },
    {
      id: 'CMMC_L2',
      label: 'CMMC Level 2 (Advanced)',
      badge: 'NIST 800-171',
      authority: 'DFARS 252.204-7012',
      count: FRAMEWORK_REGISTRY.CMMC_L2.totalControls,
      description: `${FRAMEWORK_REGISTRY.CMMC_L2.totalControls} security controls across ${getFrameworkFamilyCount('CMMC_L2')} families for Controlled Unclassified Information (CUI).`,
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
            <div className="text-xs text-slate-400 font-mono leading-none flex items-center gap-1">
              <span>SCOPE: {currentFrameworkDef.shortName}</span>
              {activeOverlayFilters.nonNetworkedOnly && (
                <span className="badge text-xs px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                  TACTICAL
                </span>
              )}
            </div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
              <span>{currentFrameworkDef.shortName}</span>
              <span className="text-xs font-mono text-cyan-300 font-normal">
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
            <div className="text-xs text-slate-400 font-mono leading-none flex items-center gap-1">
              <span>SCOPE: {enclaveFrameworks.length} ACTIVE</span>
              {activeOverlayFilters.nonNetworkedOnly && (
                <span className="badge text-xs px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                  TACTICAL
                </span>
              )}
            </div>
            <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
              <span>{currentFrameworkDef.shortName}</span>
              <span className="text-xs font-mono text-cyan-300 font-normal">
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
        <WifiOff className={`w-3.5 h-3.5 ${activeOverlayFilters.nonNetworkedOnly ? 'text-amber-400 animate-pulse motion-reduce:animate-none' : 'text-slate-400'}`} />
        <span className="hidden xl:inline text-xs">
          {activeOverlayFilters.nonNetworkedOnly ? 'Tactical Overlay: ON' : 'Tactical Overlay'}
        </span>
      </button>

      {/* Dropdown Menu (Only rendered when multi-framework and open) */}
      {isMultiFramework && isOpen && (
        <div className="absolute left-0 top-full mt-2 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2.5 space-y-2 backdrop-blur-xl animate-fadeIn">
          <div className="px-2.5 py-1.5 border-b border-slate-800">
            <div className="text-xs font-bold text-white flex items-center justify-between">
              <span>Enclave Compliance Scopes ({availableFrameworks.length})</span>
              <span className="badge text-xs font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                ENCLAVE-SCOPED GRC
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Instantly switch between active compliance baselines provisioned for this enclave.
            </p>
          </div>

          {/* Frameworks List (Filtered to Enclave-Enabled Only) */}
          <div role="group" aria-label="Active compliance framework" className="space-y-1">
            {availableFrameworks.map((f) => {
              const isSelected = activeFramework === f.id;
              return (
                <button type="button" aria-pressed={isSelected}
                  key={f.id}
                  onClick={() => {
                    setActiveFramework(f.id);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left p-2.5 rounded-xl cursor-pointer transition-all ${
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
                          <span className="badge text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                            {f.count}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">
                          {f.badge} • {f.authority}
                        </div>
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-cyan-400 shrink-0" />}
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5 pl-9 leading-relaxed">
                    {f.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* NIST 800-53 Baseline & CIA Triad Selection */}
          {activeFramework === 'NIST_800_53_REV5' && (
            <div className="pt-2.5 border-t border-slate-800 px-2 space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-slate-200">
                <span className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                  <span>NIST SP 800-53 Rev 5 Baseline Scoping</span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAllControlsApplied();
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                    ciaTriad.isAllControlsApplied
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'bg-slate-800 text-slate-400 border border-slate-700'
                  }`}
                >
                  {ciaTriad.isAllControlsApplied ? 'All Controls Applied' : 'Custom CIA Triad'}
                </button>
              </div>

              {/* Granular CIA Triad Selector */}
              <div className={`space-y-1.5 p-2 rounded-xl bg-slate-950/60 border border-slate-800 transition-opacity ${ciaTriad.isAllControlsApplied ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="text-xs text-slate-400 font-semibold mb-1">CIA Triad Impact Categorization</div>
                {(['confidentiality', 'integrity', 'availability'] as const).map(dim => (
                  <div key={dim} className="flex items-center justify-between text-xs">
                    <span className="capitalize text-slate-300 font-medium w-24">{dim}:</span>
                    <div className="flex items-center gap-1">
                      {(['LOW', 'MODERATE', 'HIGH'] as ImpactLevel[]).map(lvl => {
                        const isSelected = ciaTriad[dim] === lvl;
                        return (
                          <button
                            key={lvl}
                            onClick={(e) => {
                              e.stopPropagation();
                              setCiaImpact(dim, lvl);
                            }}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                              isSelected
                                ? 'bg-brand-600 text-white shadow-sm'
                                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {lvl === 'MODERATE' ? 'Mod' : lvl.charAt(0) + lvl.slice(1).toLowerCase()}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Operational Overlays & Tailoring Caveats */}
          <div className="pt-2.5 border-t border-slate-800 px-2 space-y-2">
            <div className="text-xs font-bold text-slate-300 flex items-center justify-between">
              <span>Operational Caveats & Overlays</span>
            </div>

            <div className="space-y-1">
              {/* Overlay 1: Non-Networked / Stand-alone / Air-gapped */}
              <div className="flex items-center justify-between p-1.5 rounded-lg bg-slate-950/40 text-xs">
                <div className="flex items-center gap-2">
                  <WifiOff className={`w-3.5 h-3.5 ${activeOverlayFilters.nonNetworkedOnly ? 'text-amber-400' : 'text-slate-400'}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-300">Stand-Alone / Air-Gapped</div>
                    <div className="text-xs text-slate-400">Excludes SC-7, AC-17, SC-8</div>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOverlayFilter('nonNetworkedOnly');
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                    activeOverlayFilters.nonNetworkedOnly
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  {activeOverlayFilters.nonNetworkedOnly ? 'Active' : 'Off'}
                </button>
              </div>

              {/* Overlay 2: No Wireless Capabilities */}
              <div className="flex items-center justify-between p-1.5 rounded-lg bg-slate-950/40 text-xs">
                <div className="flex items-center gap-2">
                  <Radio className={`w-3.5 h-3.5 ${activeOverlayFilters.noWireless ? 'text-cyan-400' : 'text-slate-400'}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-300">No Wireless Capabilities</div>
                    <div className="text-xs text-slate-400">Excludes AC-18 wireless access</div>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOverlayFilter('noWireless');
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                    activeOverlayFilters.noWireless
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  {activeOverlayFilters.noWireless ? 'Active' : 'Off'}
                </button>
              </div>

              {/* Overlay 3: No Mobile Devices */}
              <div className="flex items-center justify-between p-1.5 rounded-lg bg-slate-950/40 text-xs">
                <div className="flex items-center gap-2">
                  <Smartphone className={`w-3.5 h-3.5 ${activeOverlayFilters.noMobileDevices ? 'text-indigo-400' : 'text-slate-400'}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-300">No Mobile Devices</div>
                    <div className="text-xs text-slate-400">Excludes AC-19, MP-7 mobile controls</div>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOverlayFilter('noMobileDevices');
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                    activeOverlayFilters.noMobileDevices
                      ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  {activeOverlayFilters.noMobileDevices ? 'Active' : 'Off'}
                </button>
              </div>

              {/* Overlay 4: No PII Processing */}
              <div className="flex items-center justify-between p-1.5 rounded-lg bg-slate-950/40 text-xs">
                <div className="flex items-center gap-2">
                  <EyeOff className={`w-3.5 h-3.5 ${activeOverlayFilters.noPiiProcessing ? 'text-emerald-400' : 'text-slate-400'}`} />
                  <div>
                    <div className="text-xs font-bold text-slate-300">No PII Processing</div>
                    <div className="text-xs text-slate-400">Excludes PT family & privacy safeguards</div>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOverlayFilter('noPiiProcessing');
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                    activeOverlayFilters.noPiiProcessing
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                >
                  {activeOverlayFilters.noPiiProcessing ? 'Active' : 'Off'}
                </button>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
