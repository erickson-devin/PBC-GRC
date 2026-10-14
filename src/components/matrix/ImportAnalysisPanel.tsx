import React, { useEffect, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { ApiClient } from '../../services/apiClient';
import type { ObjectiveStatus, SspImportJob, StagedControlView } from '../../types/sspImport';

interface Props {
  controlId: string;
  tenantId: string;
}

const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  ADDRESSED: 'Supporting sentence found',
  PARTIAL: 'Partly',
  NOT_ADDRESSED: 'No supporting sentence found',
  UNSUPPORTED: 'Not supported by the text',
  NOT_ASSESSED: 'Not assessed',
};
const STATUS_CLASS: Record<ObjectiveStatus, string> = {
  ADDRESSED: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  PARTIAL: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  NOT_ADDRESSED: 'text-slate-300 border-slate-600 bg-slate-800/60',
  UNSUPPORTED: 'text-slate-300 border-slate-600 bg-slate-800/60',
  NOT_ASSESSED: 'text-slate-400 border-slate-700 bg-slate-900/60',
};

/**
 * What the most recent SSP import found for this control: the sentences of the uploaded document that the AI picked for each
 * assessment objective, the confidence of the match and the warnings. Read-only: an import only suggests; the objectives below
 * are still assessed by a person. Shows nothing when no import mentions the control (or the caller may not read imports).
 */
export const ImportAnalysisPanel: React.FC<Props> = ({ controlId, tenantId }) => {
  const [found, setFound] = useState<{ job: SspImportJob; staged: StagedControlView } | null>(null);

  useEffect(() => {
    let alive = true;
    setFound(null);
    (async () => {
      const jobs = (await ApiClient.sspListJobs(tenantId)).filter((j) => j.status === 'READY_FOR_REVIEW' || j.status === 'COMMITTED').slice(0, 5); // newest first
      for (const job of jobs) {
        const { staged } = await ApiClient.sspGetStaged(tenantId, job.id);
        const hit = staged.find((s) => s.controlId === controlId && s.reviewState !== 'REJECTED');
        if (hit) {
          if (alive) setFound({ job, staged: hit });
          return;
        }
      }
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [controlId, tenantId]);

  if (!found) return null;
  const { job, staged } = found;
  const gap = staged.gapAnalysis;
  const objectives = gap.objectives ?? [];

  return (
    <section aria-label="Found in the last SSP import" className="rounded-2xl border border-violet-500/30 bg-violet-950/20 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-violet-200">
          <FileSearch className="w-3.5 h-3.5" aria-hidden="true" /> Found in “{job.fileName}”
        </h4>
        <span className="text-xs text-slate-400">
          {staged.origin === 'AI' ? 'AI match' : 'Identifier match'} · confidence {Math.round(staged.confidence * 100)}%{staged.reviewState === 'COMMITTED' ? ' · committed' : ''}
        </span>
      </div>
      {gap.summary && <p className="text-xs text-slate-300">{gap.summary}</p>}
      {staged.sourceQuotes[0] && (
        <blockquote className="text-xs text-slate-300 border-l-2 border-violet-400/50 pl-3 break-words">
          {staged.sourceQuotes[0].quote}
          {staged.sourceQuotes[0].page ? <span className="text-slate-500"> (page {staged.sourceQuotes[0].page})</span> : null}
        </blockquote>
      )}
      {objectives.length > 0 && (
        <ul className="space-y-2">
          {objectives.map((o) => (
            <li key={o.letter} className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-slate-200 break-words">
                  <span className="font-mono text-cyan-300">[{o.letter}]</span> {o.text}
                </p>
                <span className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_CLASS[o.status]}`}>{STATUS_LABEL[o.status]}</span>
              </div>
              {o.evidence && <p className="text-xs text-slate-300 break-words border-l-2 border-slate-600 pl-3">{o.evidence}</p>}
              {o.weak && <p className="text-[11px] text-amber-300">Check: this sentence shares few words with the objective.</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-slate-500">This is what the AI found in the uploaded document, not an assessment. Mark each objective below yourself.</p>
    </section>
  );
};
