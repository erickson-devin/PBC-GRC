import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { ControlStatus } from '../../types/cmmc';
import type { R3StatusSuggestion } from '../../types/frameworkCopy';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { statusDisplayLabel } from '../../data/statusLabels';
import { applyResultMessage } from '../../data/telemetry/configResultsView';
import type { ControlDecisionOutcome } from '../../data/telemetry/configResultsView';
import {
  SUGGESTION_BLOCK_TEXT,
  suggestionConfirmText,
  suggestionHeading,
  suggestionReasonText,
  suggestionSetBlock,
  suggestionSourceLine,
} from '../../data/frameworkCopy/copyView';
import { REV2_SUGGESTION_CLASS } from '../dashboard/ControlCard';

interface Rev2SuggestionStripProps {
  controlId: string;
  suggestion: R3StatusSuggestion;
  currentStatus: ControlStatus;
  sourceProgramName: string | null;
  statusLoaded: boolean;
  onReload: () => void;
}

/** The Rev. 2 suggestion on a Rev. 3 control (#255). Nothing is applied without two clicks: "Set status", then "Record". Read-only roles see the text only. */
export const Rev2SuggestionStrip: React.FC<Rev2SuggestionStripProps> = ({ controlId, suggestion: s, currentStatus, sourceProgramName, statusLoaded, onReload }) => {
  const { canEdit, activeProgram } = useTenant();
  const { decideControlStatus } = useAssessment();
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ outcome: ControlDecisionOutcome; text: string } | null>(null);
  const setButtonRef = useRef<HTMLButtonElement>(null);
  const recordRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (confirming) recordRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  const suggested = s.suggested;
  if (!suggested) return null;
  const block = suggestionSetBlock({ suggested, current: currentStatus, canEdit, archived: Boolean(activeProgram?.archived), statusLoaded });
  const label = statusDisplayLabel(suggested);
  const shownId = cmmcDisplayId(controlId);

  const cancel = (): void => {
    setConfirming(false);
    requestAnimationFrame(() => setButtonRef.current?.focus());
  };
  const record = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await decideControlStatus(controlId, suggested);
      if (!mounted.current) return;
      setConfirming(false);
      setResult({ outcome, text: applyResultMessage(outcome, shownId, suggested) });
    } catch {
      if (!mounted.current) return;
      setConfirming(false);
      setResult({ outcome: 'failed', text: applyResultMessage('failed', shownId, suggested) });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const resultLine = result && (
    <div className="flex flex-wrap items-center gap-2">
      <p ref={resultRef} tabIndex={-1} role={result.outcome === 'saved' ? 'status' : 'alert'}
        className={`focus:outline-none ${result.outcome === 'saved' ? 'text-emerald-300' : 'text-rose-300'}`}>{result.text}</p>
      {result.outcome === 'stale' && (
        <button type="button" onClick={() => { setResult(null); onReload(); }}
          className="px-2 py-0.5 rounded-lg border border-slate-600 bg-slate-900/60 font-semibold text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">Reload</button>
      )}
    </div>
  );

  // The suggestion has been applied (or already holds): only the outcome of the save is left to show
  if (block === 'matches' && !result) return null;

  return (
    <section aria-labelledby={headingId} className="px-6 py-3 bg-slate-900 border-b border-slate-800/80 shrink-0">
      <div className={`rounded-xl border p-3 space-y-2 text-xs ${REV2_SUGGESTION_CLASS[suggested]}`}>
        {block === 'matches' ? (
          <>
            <h3 id={headingId} className="sr-only">{suggestionHeading(suggested)}</h3>
            {resultLine}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <h3 id={headingId} className="font-semibold">{suggestionHeading(suggested)}</h3>
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-slate-600 bg-slate-900/60 text-slate-300">Not applied</span>
            </div>
            <p className="text-slate-200">{suggestionReasonText(s)}</p>
            <ul aria-label="Rev. 2 sources" className="flex flex-wrap gap-1.5">
              {s.sources.map((src) => (
                <li key={src.controlId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-slate-700 bg-slate-900/70 text-slate-200">
                  <span className="font-mono">{cmmcDisplayId(src.controlId, 'CMMC_L2')}</span>
                  <span className="text-slate-400">{statusDisplayLabel(src.status)}</span>
                </li>
              ))}
            </ul>
            <p className="text-slate-400">{suggestionSourceLine(sourceProgramName)}</p>
            {block !== null && <p className="text-slate-400">{SUGGESTION_BLOCK_TEXT[block]}</p>}
            {block === null && !confirming && (
              <button ref={setButtonRef} type="button" onClick={() => { setResult(null); setConfirming(true); }}
                className="px-2 py-0.5 rounded-lg border border-slate-600 bg-slate-900/60 font-semibold text-slate-100 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                {`Set status to ${label}`}
              </button>
            )}
            {block === null && confirming && (
              <div role="group" aria-label="Confirm the status" className="space-y-2"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}>
                <p className="text-slate-200">{suggestionConfirmText(shownId, currentStatus, suggested)}</p>
                <div className="flex flex-wrap gap-2">
                  <button ref={recordRef} type="button" onClick={() => void record()} disabled={busy} className="btn-primary px-3 py-1 rounded-xl text-xs disabled:opacity-50">
                    {busy ? 'Recording…' : `Record ${label}`}
                  </button>
                  <button type="button" onClick={cancel} disabled={busy}
                    className="px-3 py-1 rounded-xl border border-slate-600 bg-slate-900/60 text-xs font-semibold text-slate-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">Cancel</button>
                </div>
              </div>
            )}
            {resultLine}
          </>
        )}
      </div>
    </section>
  );
};
