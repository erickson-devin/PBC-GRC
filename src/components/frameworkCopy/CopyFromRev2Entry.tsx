import React, { useId, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useProgram } from '../../hooks/useProgram';
import { useFrameworkCopyRuns } from '../../hooks/useFrameworkCopy';
import { COPY_ENTRY_TEXT, copyEntryState, lastRunLine } from '../../data/frameworkCopy/copyView';
import { CopyFromRev2Dialog } from './CopyFromRev2Dialog';

interface CopyFromRev2EntryProps {
  /** Called after a copy is made, so the matrix can read the suggestions again. */
  onCopied: () => void;
}

/** The strip on the Rev. 3 control matrix: the last copy made into this program and the button that opens "Copy from Rev. 2" (#255). */
export const CopyFromRev2Entry: React.FC<CopyFromRev2EntryProps> = ({ onCopied }) => {
  const { currentTenant, activeProgram, activeFramework, canEdit } = useTenant();
  const { notesEditable } = useAssessment();
  const { programs } = useProgram();
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const state = copyEntryState({
    framework: activeFramework,
    serverBacked: Boolean(currentTenant.serverBacked),
    hasProgram: Boolean(activeProgram),
    archived: Boolean(activeProgram?.archived),
    canEdit,
    notesEditable,
  });
  const runs = useFrameworkCopyRuns(state !== 'hidden');
  const newest = useMemo(() => {
    if (runs.load.status !== 'ready' || runs.load.runs.length === 0) return undefined;
    return [...runs.load.runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  }, [runs.load]);
  const line = lastRunLine(newest, (id) => programs.find((p) => p.id === id)?.name ?? null);

  if (state === 'hidden') return null;
  if (state === 'browser_only') {
    return canEdit ? <p className="text-xs text-slate-400">{COPY_ENTRY_TEXT.browserOnly}</p> : null;
  }
  if (state === 'read_only' || state === 'archived') {
    return line ? <p className="text-xs text-slate-400">{line}</p> : null;
  }

  return (
    <section aria-label="Copy from Rev. 2" className="rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 text-xs">
      <ArrowLeftRight className="w-4 h-4 text-cyan-400 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-slate-300">{line ?? COPY_ENTRY_TEXT.intro}</p>
        {runs.load.status === 'loading' && <p role="status" className="text-slate-400">{COPY_ENTRY_TEXT.historyLoading}</p>}
        {runs.load.status === 'error' && (
          <p className="text-slate-400">
            {COPY_ENTRY_TEXT.historyFailed}{' '}
            <button type="button" onClick={() => void runs.reload()} className="font-semibold text-cyan-300 underline underline-offset-2">Try again</button>
          </p>
        )}
        {state === 'not_loaded' && <p id={reasonId} className="text-amber-300">{COPY_ENTRY_TEXT.notLoaded}</p>}
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={state !== 'ready'}
        aria-haspopup="dialog"
        aria-describedby={state === 'not_loaded' ? reasonId : undefined}
        className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />Copy from Rev. 2
      </button>
      {open && <CopyFromRev2Dialog onClose={() => setOpen(false)} onCopied={() => { void runs.reload(); onCopied(); }} />}
    </section>
  );
};
