import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { SspSectionId } from '../../data/ssp/sspSections';
import type { NavEntryView } from '../../data/ssp/sspBuilderView';

interface SspSectionNavProps {
  entries: NavEntryView[];
  activeId: SspSectionId;
  onSelect: (id: SspSectionId) => void;
  summary: string;
}

const TONE = {
  slate: 'bg-slate-800 text-slate-300 border-slate-700',
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
} as const;

/** The SSP sections with what each still lacks: a red count of required items, or a green check when complete, and the sign-off state. */
export const SspSectionNav: React.FC<SspSectionNavProps> = ({ entries, activeId, onSelect, summary }) => (
  <nav aria-label="SSP sections" className="space-y-3">
    <p className="text-xs text-slate-400">{summary}</p>
    <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
      {entries.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            onClick={() => onSelect(e.id)}
            aria-current={e.id === activeId ? 'true' : undefined}
            className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              e.id === activeId ? 'border-brand-500/60 bg-brand-500/10' : 'border-slate-800 bg-slate-950/60 hover:bg-slate-800/60'
            }`}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="font-mono text-[11px] text-slate-500 mr-1.5">{e.number}</span>
                <span className="text-xs font-semibold text-slate-200">{e.title}</span>
              </span>
              {e.complete ? (
                <span className="shrink-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  <span className="sr-only">Complete</span>
                </span>
              ) : (
                <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                  <span aria-hidden="true">{e.requiredMissing}</span>
                  <span className="sr-only">{e.missingText}</span>
                </span>
              )}
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {e.advisoryText && <span className="text-[11px] text-slate-400">{e.advisoryText}</span>}
              {e.review && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${TONE[e.review.tone]}`}>{e.review.text}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  </nav>
);
