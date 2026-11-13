import React, { useId } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** Shared small button and filter-chip classes of the POA&M screen. */
export const SMALL_BUTTON = 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors';
export const CHIP_ON = 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold';
export const CHIP_OFF = 'bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800';

export interface PoamGroupPanelProps {
  title: string;
  code?: string;
  countText: string;
  badges?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Lets the caller move focus to the header button (e.g. when "Show more" has nothing left to show). */
  toggleRef?: (el: HTMLButtonElement | null) => void;
  children: React.ReactNode;
}

/** A collapsible group of the POA&M screen: a heading that wraps the disclosure button, the panel below it. */
export const PoamGroupPanel: React.FC<PoamGroupPanelProps> = ({ title, code, countText, badges, expanded, onToggle, toggleRef, children }) => {
  const uid = useId();
  const headingId = `${uid}-h`;
  const panelId = `${uid}-p`;
  return (
    <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
      <h4 id={headingId} className="m-0">
        <button
          type="button"
          ref={toggleRef}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-2xl"
        >
          <span className="flex items-center gap-2 min-w-0">
            {expanded
              ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />}
            {code && <span className="font-mono text-xs font-bold text-cyan-300">{code}</span>}
            <span className="text-sm font-semibold text-white truncate">{title}</span>
          </span>
          <span className="flex items-center gap-2 shrink-0 text-xs text-slate-400">
            {badges}
            <span>{countText}</span>
          </span>
        </button>
      </h4>
      {expanded && <div id={panelId} className="border-t border-slate-800">{children}</div>}
    </section>
  );
};