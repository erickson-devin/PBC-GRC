import React from 'react';
import { Lock, FileText, ClipboardList, ArrowRight, Circle } from 'lucide-react';
import { SprsScoreResult } from '../../types/audit';
import { useAssessment } from '../../context/AssessmentContext';

interface SspGateBannerProps {
  sprs: SprsScoreResult;
  /** Compact variant for tight spaces (e.g. inside a tab header). */
  compact?: boolean;
}

/**
 * Shown whenever the SPRS score is locked because there is no completed System Security Plan.
 * DoD Assessment Methodology 5(g): an SSP (3.12.4) AND a POA&M (3.12.2) for every unimplemented requirement
 * are prerequisites, so this walks the user through both instead of just showing "Not Scored".
 */
export const SspGateBanner: React.FC<SspGateBannerProps> = ({ sprs, compact = false }) => {
  const { setActiveTab } = useAssessment();

  if (sprs.scoreStatus !== 'NOT_SCORED') return null;

  const unimplemented = sprs.totalControls - sprs.metCount;

  return (
    <section
      role="status"
      aria-live="polite"
      className="relative overflow-hidden rounded-2xl border border-amber-500/50 bg-gradient-to-br from-amber-500/15 via-slate-950 to-slate-950 p-5 sm:p-6 shadow-lg shadow-amber-950/30"
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-amber-400" aria-hidden="true" />

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/15 text-amber-300">
              <Lock className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <span className="badge rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                SPRS score locked
              </span>
              <h2 className="mt-1.5 text-base font-bold text-white sm:text-lg">
                No score can be calculated until your System Security Plan is complete
              </h2>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-slate-300 sm:text-sm">
            The DoD Assessment Methodology scores an organization against its SSP, so without one there is nothing to
            assess. It also requires a Plan of Action &amp; Milestones for every requirement you have not implemented
            yet.{' '}
            <strong className="text-white">
              Start your POA&amp;M now: you can build it while you finish the SSP, and you must have both before you
              submit a score to SPRS.
            </strong>
          </p>

          {!compact && sprs.sspGaps.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Still needed for the SSP
              </p>
              <ul className="space-y-1">
                {sprs.sspGaps.map((gap) => (
                  <li key={gap} className="flex items-start gap-2 text-xs text-amber-200">
                    <Circle className="mt-1 h-2 w-2 shrink-0 fill-amber-400 text-amber-400" />
                    <span>{gap}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <ol className="grid w-full shrink-0 gap-2.5 lg:w-80">
          <li>
            <button
              type="button"
              onClick={() => setActiveTab('ssp')}
              className="group flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-left transition-colors hover:border-amber-400 hover:bg-amber-500/20"
            >
              <span className="badge h-6 w-6 shrink-0 rounded-full bg-amber-400 text-xs font-black text-slate-950">1</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-bold text-white">
                  <FileText className="h-4 w-4 text-amber-300" /> Complete your SSP
                </span>
                <span className="block text-[11px] text-slate-400">Fill in the plan, then mark 3.12.4 MET</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-amber-300 transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => setActiveTab('poam')}
              className="group flex w-full items-center gap-3 rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-3 text-left transition-colors hover:border-cyan-400 hover:bg-cyan-500/20"
            >
              <span className="badge h-6 w-6 shrink-0 rounded-full bg-cyan-400 text-xs font-black text-slate-950">2</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-bold text-white">
                  <ClipboardList className="h-4 w-4 text-cyan-300" /> Start your POA&amp;M
                </span>
                <span className="block text-[11px] text-slate-400">
                  {unimplemented} unimplemented requirement{unimplemented === 1 ? '' : 's'} need a remediation plan
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-cyan-300 transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        </ol>
      </div>
    </section>
  );
};

export default SspGateBanner;
