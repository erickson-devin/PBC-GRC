import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Sliders, WifiOff, Radio, Smartphone, EyeOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';

/**
 * The "Overlays" menu of the header. The framework and the baseline now belong to the active program (see ProgramSwitcher); what
 * stays per browser (decision 8) are the four operational overlays: they tailor which controls apply to the boundary.
 */
export const FrameworkSwitcher: React.FC = () => {
  const { activeOverlayFilters, toggleOverlayFilter } = useTenant();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Escape closes the menu and returns focus to its button
  useEscapeKey(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, isOpen);

  const overlays: {
    active: boolean | undefined;
    title: string;
    detail: string;
    icon: LucideIcon;
    iconOn: string;
    buttonOn: string;
    toggle: () => void;
  }[] = [
    {
      // Stand-Alone / Air-Gapped
      active: activeOverlayFilters.nonNetworkedOnly,
      title: 'Stand-Alone / Air-Gapped',
      detail: 'Excludes SC-7, AC-17, SC-8',
      icon: WifiOff,
      iconOn: 'text-amber-400',
      buttonOn: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
      toggle: () => toggleOverlayFilter('nonNetworkedOnly'),
    },
    {
      // No Wireless Capabilities
      active: activeOverlayFilters.noWireless,
      title: 'No Wireless Capabilities',
      detail: 'Excludes AC-18 wireless access',
      icon: Radio,
      iconOn: 'text-cyan-400',
      buttonOn: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40',
      toggle: () => toggleOverlayFilter('noWireless'),
    },
    {
      // No Mobile Devices
      active: activeOverlayFilters.noMobileDevices,
      title: 'No Mobile Devices',
      detail: 'Excludes AC-19, MP-7 mobile controls',
      icon: Smartphone,
      iconOn: 'text-indigo-400',
      buttonOn: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
      toggle: () => toggleOverlayFilter('noMobileDevices'),
    },
    {
      // No PII Processing
      active: activeOverlayFilters.noPiiProcessing,
      title: 'No PII Processing',
      detail: 'Excludes PT family & privacy safeguards',
      icon: EyeOff,
      iconOn: 'text-emerald-400',
      buttonOn: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
      toggle: () => toggleOverlayFilter('noPiiProcessing'),
    },
  ];

  const activeCount = overlays.filter(o => o.active).length;

  return (
    <div className="relative flex items-center gap-2" ref={dropdownRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setIsOpen(prev => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/50 text-slate-200 transition-all shadow-sm group"
        title="Operational overlays for the active program (kept in this browser)"
      >
        <div className="w-5 h-5 rounded-md bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30 group-hover:scale-105 transition-transform">
          <Sliders className="w-3 h-3" />
        </div>
        <div className="text-left">
          <div className="text-xs text-slate-400 font-mono leading-none flex items-center gap-1">
            <span>OVERLAYS</span>
            {activeOverlayFilters.nonNetworkedOnly && (
              <span className="badge text-xs px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                TACTICAL
              </span>
            )}
          </div>
          <div className="text-xs font-bold text-white mt-0.5">
            {activeCount === 0 ? 'None active' : `${activeCount} active`}
          </div>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 ml-0.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-2 w-80 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2.5 space-y-2 backdrop-blur-xl animate-fadeIn">
          {/* Operational Overlays & Tailoring Caveats */}
          <div className="px-2 space-y-2">
            <div className="text-xs font-bold text-slate-300 flex items-center justify-between">
              <span>Operational Caveats & Overlays</span>
            </div>
            <p className="text-xs text-slate-400">Saved in this browser; they tailor which controls apply.</p>

            <div className="space-y-1">
              {overlays.map(o => {
                const Icon = o.icon;
                return (
                  <div key={o.title} className="flex items-center justify-between p-1.5 rounded-lg bg-slate-950/40 text-xs">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-3.5 h-3.5 ${o.active ? o.iconOn : 'text-slate-400'}`} />
                      <div>
                        <div className="text-xs font-bold text-slate-300">{o.title}</div>
                        <div className="text-xs text-slate-400">{o.detail}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-pressed={Boolean(o.active)}
                      aria-label={`${o.title} overlay`}
                      onClick={(e) => {
                        e.stopPropagation();
                        o.toggle();
                      }}
                      className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
                        o.active ? o.buttonOn : 'bg-slate-800 text-slate-400 hover:text-slate-300'
                      }`}
                    >
                      {o.active ? 'Active' : 'Off'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
