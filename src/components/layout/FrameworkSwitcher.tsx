import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Sliders, WifiOff, Radio, Smartphone, EyeOff, Lock, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { ConfirmOverlayChangeDialog } from '../programs/ConfirmOverlayChangeDialog';
import { OVERLAY_DETAILS, OVERLAY_TITLES, menuLockReason, overlayLockReason, overlayLockText, overlayScopeNote, summarizeOverlayChange } from '../../data/overlayScoping';
import type { OverlayKey } from '../../data/overlayScoping';
import type { OverlayFilters } from '../../types/framework';

/**
 * The "Overlays" menu of the header: the four operational overlays that tailor which controls apply, for NIST SP 800-53
 * programs only. Server-backed tenant: saved with the active program, changed by owners and admins after a confirmation, and
 * recorded on the server. Browser-only tenant: saved in this browser for this organization.
 */
export const FrameworkSwitcher: React.FC = () => {
  const { activeOverlayFilters, toggleOverlayFilter, activeProgram, activeFramework, canManagePrograms, programsStatus, currentTenant, refreshPrograms } = useTenant();
  const serverBacked = Boolean(currentTenant.serverBacked);
  const lockCtx = { serverBacked, programsStatus, canManagePrograms, framework: activeFramework, program: activeProgram };
  // A reason that applies to all four rows (not loaded, archived, not NIST, role); null when the overlays can be changed
  const menuLock = menuLockReason(lockCtx);
  const uid = useId();

  const [isOpen, setIsOpen] = useState(false);
  // The overlay waiting for confirmation (its dialog is open while this is set)
  const [pending, setPending] = useState<OverlayKey | null>(null);
  const pendingRef = useRef<OverlayKey | null>(null);
  pendingRef.current = pending;
  const [announcement, setAnnouncement] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on an outside click, but not while the confirmation (portalled to <body>) is open: focus goes back to the row
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pendingRef.current) return;
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape closes the menu and returns focus to its button (the dialog registers later, so Escape closes it first)
  useEscapeKey(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, isOpen);

  // Opening the menu re-reads the programs, so the toggles and the confirmation counts start from what is saved now
  useEffect(() => {
    if (isOpen && serverBacked) void refreshPrograms();
  }, [isOpen, serverBacked, refreshPrograms]);

  const rowReason = (key: OverlayKey): string | undefined => {
    const lock = overlayLockReason(key, lockCtx);
    return lock && lock !== menuLock ? overlayLockText(lock, activeFramework) : undefined;
  };

  const overlays: {
    key: OverlayKey;
    active: boolean;
    icon: LucideIcon;
    iconOn: string;
    buttonOn: string;
    toggle: (seen?: OverlayFilters) => Promise<void>;
    disabledReason?: string;
  }[] = [
    {
      // Stand-Alone / Air-Gapped
      key: 'nonNetworkedOnly',
      active: Boolean(activeOverlayFilters.nonNetworkedOnly),
      icon: WifiOff,
      iconOn: 'text-amber-400',
      buttonOn: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
      toggle: (seen) => toggleOverlayFilter('nonNetworkedOnly', seen),
      disabledReason: rowReason('nonNetworkedOnly'),
    },
    {
      // No Wireless Capabilities
      key: 'noWireless',
      active: Boolean(activeOverlayFilters.noWireless),
      icon: Radio,
      iconOn: 'text-cyan-400',
      buttonOn: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40',
      toggle: (seen) => toggleOverlayFilter('noWireless', seen),
      disabledReason: rowReason('noWireless'),
    },
    {
      // No Mobile Devices
      key: 'noMobileDevices',
      active: Boolean(activeOverlayFilters.noMobileDevices),
      icon: Smartphone,
      iconOn: 'text-indigo-400',
      buttonOn: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
      toggle: (seen) => toggleOverlayFilter('noMobileDevices', seen),
      disabledReason: rowReason('noMobileDevices'),
    },
    {
      // No PII Processing
      key: 'noPiiProcessing',
      active: Boolean(activeOverlayFilters.noPiiProcessing),
      icon: EyeOff,
      iconOn: 'text-emerald-400',
      buttonOn: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
      toggle: (seen) => toggleOverlayFilter('noPiiProcessing', seen),
      disabledReason: rowReason('noPiiProcessing'),
    },
  ];

  const activeCount = overlays.filter(o => o.active).length;
  const pendingOverlay = overlays.find(o => o.key === pending) ?? null;
  const readOnly = menuLock === 'cannot_manage' || menuLock === 'archived';
  const statusLine = menuLock === 'loading' ? 'Loading…' : menuLock === 'unavailable' ? 'Unavailable' : menuLock === 'not_nist' ? 'NIST only'
    : activeCount === 0 ? 'None active' : `${activeCount} active`;
  const triggerTitle = menuLock === 'not_nist' ? 'Overlays apply to NIST SP 800-53 programs only'
    : serverBacked ? 'Operational overlays of the active program (saved with the program, shared with everyone in it)'
    : 'Operational overlays (saved in this browser for this organization)';

  return (
    <div className="relative flex items-center gap-2" ref={dropdownRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
        aria-controls={isOpen ? `${uid}-panel` : undefined}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/50 text-slate-200 transition-all shadow-sm group"
        title={triggerTitle}
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
          <div className="text-xs font-bold text-white mt-0.5 flex items-center gap-1">
            <span>{statusLine}</span>
            {readOnly && (<><Lock className="w-3 h-3 text-slate-400" aria-hidden="true" /><span className="sr-only">(read-only)</span></>)}
          </div>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 ml-0.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>

      {isOpen && (
        <div id={`${uid}-panel`} role="group" aria-labelledby={`${uid}-heading`} className="absolute left-0 top-full mt-2 w-80 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2.5 space-y-2 backdrop-blur-xl animate-fadeIn">
          {/* Operational Overlays & Tailoring Caveats */}
          <div className="px-2 space-y-2">
            <div className="text-xs font-bold text-slate-300 flex items-center justify-between">
              <span id={`${uid}-heading`}>Operational Caveats & Overlays</span>
            </div>
            <p className="text-xs text-slate-400">{overlayScopeNote(serverBacked)}</p>
            {menuLock && (
              <p id={`${uid}-lock`} className="flex items-start gap-1.5 rounded-lg border border-slate-700/80 bg-slate-950/60 p-2 text-xs text-slate-300">
                {menuLock === 'loading'
                  ? <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-cyan-400 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />}
                <span>{overlayLockText(menuLock, activeFramework)}</span>
              </p>
            )}

            <div className="space-y-1">
              {overlays.map((o) => {
                const Icon = o.icon;
                const locked = Boolean(menuLock) || Boolean(o.disabledReason) || pending !== null;
                const detailId = `${uid}-${o.key}-detail`;
                const reasonId = `${uid}-${o.key}-reason`;
                const describedBy = [detailId, o.disabledReason ? reasonId : null, menuLock ? `${uid}-lock` : null].filter(Boolean).join(' ');
                return (
                  <div key={o.key} className="flex items-center justify-between gap-2 p-1.5 rounded-lg bg-slate-950/40 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${o.active ? o.iconOn : 'text-slate-400'}`} aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-300">{OVERLAY_TITLES[o.key]}</div>
                        <div id={detailId} className="text-xs text-slate-400">{OVERLAY_DETAILS[o.key]}</div>
                        {o.disabledReason && <div id={reasonId} className="text-xs text-amber-300/90">{o.disabledReason}</div>}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-pressed={o.active}
                      aria-haspopup="dialog"
                      aria-label={`${OVERLAY_TITLES[o.key]} overlay`}
                      aria-disabled={locked || undefined}
                      aria-describedby={describedBy}
                      title={o.disabledReason}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (locked) return;
                        setAnnouncement('');
                        setPending(o.key);
                      }}
                      className={`shrink-0 px-2 py-0.5 rounded text-xs font-bold transition-all ${locked ? 'opacity-50 cursor-not-allowed' : ''} ${
                        o.active ? o.buttonOn : `bg-slate-800 text-slate-400 ${locked ? '' : 'hover:text-slate-300'}`
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

      {pendingOverlay && (
        <ConfirmOverlayChangeDialog
          summary={summarizeOverlayChange({ framework: activeFramework, baseline: activeProgram?.baseline ?? null, privacyBaseline: activeProgram?.privacyBaseline }, activeOverlayFilters, pendingOverlay.key)}
          serverBacked={serverBacked}
          onConfirm={pendingOverlay.toggle}
          onClose={() => setPending(null)}
          onSaved={(turnedOn) => setAnnouncement(`${OVERLAY_TITLES[pendingOverlay.key]} is now ${turnedOn ? 'on' : 'off'}${serverBacked ? ' for this program' : ''}.`)}
        />
      )}
    </div>
  );
};
