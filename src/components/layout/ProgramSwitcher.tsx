import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Layers, Plus, ArrowRight, AlertTriangle, Loader2 } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useProgram } from '../../hooks/useProgram';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import type { Program } from '../../types/program';
import { ProgramFormModal } from '../programs/ProgramFormModal';

/** "CMMC Level 2", or "NIST SP 800-53 Rev. 5 · Moderate" ("· Moderate + Privacy" with the privacy baseline). */
function programChip(program: Pick<Program, 'framework' | 'baseline'> & { privacyBaseline?: boolean }): string {
  const label = frameworkLabel(program.framework);
  if (program.framework !== 'NIST_800_53_REV5' || !program.baseline) return label;
  return `${label} · ${program.baseline.charAt(0)}${program.baseline.slice(1).toLowerCase()}${program.privacyBaseline ? ' + Privacy' : ''}`;
}

const chipClass = 'badge text-xs font-mono px-1.5 py-0.5 rounded bg-slate-900/80 text-cyan-300 border border-slate-700';

/**
 * The program (authorization boundary) switcher of the header. The button doubles as the scope badge: program name, framework and
 * baseline chip, control count. The menu lists the programs that are not archived (a radio group), "+ New Program" for the people
 * who may create one, and a link to the programs page. A tenant that only exists in this browser has one implicit boundary and gets
 * a static badge.
 */
export const ProgramSwitcher: React.FC = () => {
  const { currentTenant } = useTenant();
  const { metrics } = useAssessment();
  const { openPrograms, activeProgram, programsStatus, switchProgram, refreshPrograms, canManagePrograms } = useProgram();

  const [isOpen, setIsOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside mousedown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape closes the menu and returns focus to the button
  useEscapeKey(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, isOpen);

  // A change of organization closes the menu
  useEffect(() => {
    setIsOpen(false);
  }, [currentTenant.id]);

  const menuItems = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  // Focus the active program (or the first item) when the menu opens from the keyboard or the mouse
  const focusItem = (which: 'active' | 'first' | 'last') => {
    window.setTimeout(() => {
      const items = menuItems();
      const target = which === 'last' ? items[items.length - 1] : which === 'active' ? items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0] : items[0];
      target?.focus();
    }, 0);
  };

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIsOpen(true);
      focusItem(e.key === 'ArrowUp' ? 'last' : 'active');
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') {
      setIsOpen(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items[next].focus();
    }
  };

  const select = (program: Program) => {
    if (program.id !== activeProgram?.id) switchProgram(program.id);
    closeAndFocusTrigger();
  };

  const openCreate = () => {
    setIsOpen(false);
    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    triggerRef.current?.focus();
  };

  // A tenant that only exists in this browser: one implicit boundary, nothing to switch
  if (programsStatus === 'unsupported') {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800/90 text-slate-200 shadow-sm"
        title="This organization is stored in this browser only: programs need the server, so it has one boundary"
      >
        <div className="w-5 h-5 rounded-md bg-brand-500/20 text-brand-400 flex items-center justify-center border border-brand-500/30">
          <Layers className="w-3 h-3" />
        </div>
        <div className="text-left">
          <div className="text-xs text-slate-400 font-mono leading-none">PROGRAM</div>
          <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
            <span>Default boundary</span>
            <span className="text-xs font-mono text-cyan-300 font-normal">({metrics.totalControls})</span>
          </div>
        </div>
      </div>
    );
  }

  // Loading, or the list could not be loaded and there is nothing to show
  if (!activeProgram && openPrograms.length === 0) {
    const failed = programsStatus === 'error';
    return (
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800/90 text-slate-200 shadow-sm"
        aria-live="polite"
      >
        <div className="w-5 h-5 rounded-md bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700">
          {failed ? <AlertTriangle className="w-3 h-3 text-amber-400" /> : <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
        <div className="text-left">
          <div className="text-xs text-slate-400 font-mono leading-none">PROGRAM</div>
          <div className="text-xs font-bold text-white mt-0.5">{failed ? 'Programs unavailable' : 'Loading programs…'}</div>
        </div>
        {failed && (
          <button
            type="button"
            onClick={() => void refreshPrograms()}
            className="px-2 py-0.5 rounded text-xs font-bold bg-slate-800 text-slate-300 hover:text-white border border-slate-700"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) focusItem('active');
        }}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 hover:border-cyan-500/50 text-slate-200 transition-all shadow-sm group text-left"
        title="Switch the active program (authorization boundary)"
      >
        <div className="w-5 h-5 rounded-md bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/30 group-hover:scale-105 transition-transform">
          <Layers className="w-3 h-3" />
        </div>
        <div className="text-left">
          <div className="text-xs text-slate-400 font-mono leading-none flex items-center gap-1">
            <span>PROGRAM</span>
            {activeProgram && <span className="text-cyan-300 normal-case">{programChip(activeProgram)}</span>}
          </div>
          <div className="text-xs font-bold text-white flex items-center gap-1.5 mt-0.5">
            <span className="max-w-[140px] md:max-w-[180px] truncate">{activeProgram?.name ?? 'No program selected'}</span>
            <span className="text-xs font-mono text-cyan-300 font-normal">({metrics.totalControls})</span>
          </div>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 ml-0.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Programs"
          onKeyDown={handleMenuKeyDown}
          className="absolute left-0 top-full mt-2 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2.5 space-y-2 backdrop-blur-xl animate-fadeIn"
        >
          <div className="px-2.5 py-1.5 border-b border-slate-800">
            <div className="text-xs font-bold text-white flex items-center justify-between">
              <span>Programs ({openPrograms.length})</span>
              <span className="badge text-xs font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                {currentTenant.name}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">Each program has its own framework, answers and evidence.</p>
            {programsStatus === 'error' && (
              <p className="text-xs text-amber-300 mt-1">The list could not be refreshed; it may be out of date.</p>
            )}
          </div>

          <div className="space-y-1 max-h-72 overflow-y-auto">
            {openPrograms.map((p) => {
              const selected = p.id === activeProgram?.id;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={-1}
                  key={p.id}
                  onClick={() => select(p)}
                  className={`w-full text-left p-2.5 rounded-xl cursor-pointer transition-all flex items-center justify-between gap-2 ${
                    selected
                      ? 'bg-cyan-500/15 border border-cyan-500/40 text-white'
                      : 'hover:bg-slate-800/70 focus:bg-slate-800/70 text-slate-300 border border-transparent'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-bold flex items-center gap-1.5">
                      <span className="truncate">{p.name}</span>
                      {p.isDefault && (
                        <span className="badge text-xs px-1 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">Default</span>
                      )}
                    </div>
                    <div className="mt-1">
                      <span className={chipClass}>{programChip(p)}</span>
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`w-4 h-4 rounded-full border shrink-0 flex items-center justify-center ${
                      selected ? 'border-cyan-400 bg-cyan-500 text-slate-950' : 'border-slate-600'
                    }`}
                  >
                    {selected && <Check className="w-3 h-3" />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-slate-800 space-y-1">
            {canManagePrograms && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={openCreate}
                className="w-full py-2 px-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-md shadow-brand-500/20"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Program</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setIsOpen(false);
                window.location.hash = 'programs';
              }}
              className="w-full py-2 px-3 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 focus:bg-slate-800 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            >
              <span>View All Programs</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {isCreateOpen && <ProgramFormModal mode="create" onClose={closeCreate} />}
    </div>
  );
};

export default ProgramSwitcher;
