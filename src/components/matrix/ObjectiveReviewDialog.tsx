import React, { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAssessment } from '../../context/AssessmentContext';
import { errorMessage } from '../../utils/errors';

/**
 * Shown to an owner / MSP admin when this browser held an objective narrative that differs from the one the server already has
 * (found by the one-time move of the browser's narratives to the server). Both texts are shown side by side as plain text (never
 * markup); the user keeps one. Nothing is overwritten until a button is pressed, and the narrative stays in this browser until then.
 */
export const ObjectiveReviewDialog: React.FC = () => {
  const { state, objectivePendingReview, serverObjectiveNarrative, resolveObjectiveConflict } = useAssessment();
  const [dismissed, setDismissed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (objectivePendingReview.length === 0 || dismissed) return null;

  const decide = async (objectiveId: string, choice: 'browser' | 'server') => {
    setBusyId(objectiveId);
    setError(null);
    try {
      await resolveObjectiveConflict(objectiveId, choice);
    } catch (err: unknown) {
      setError(errorMessage(err) || 'Could not save your choice.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <DialogOverlay onClose={busyId ? undefined : () => setDismissed(true)} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-4xl rounded-3xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start gap-2.5 border-b border-slate-800 pb-3">
          <GitMerge className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <DialogTitle as="h3" className="text-sm font-bold text-white">
              Objective narratives differ from the server
            </DialogTitle>
            <p className="text-xs text-slate-400">
              This browser held a different narrative than the server for {objectivePendingReview.length === 1 ? 'this objective' : `these ${objectivePendingReview.length} objectives`}.
              Choose which text to keep. Until you choose, nothing is changed on the server.
            </p>
          </div>
        </div>

        <ul className="space-y-4">
          {objectivePendingReview.map((objectiveId) => {
            const browserText = state.objectives?.[objectiveId]?.implementationNarrative ?? '';
            const serverText = serverObjectiveNarrative(objectiveId);
            const busy = busyId === objectiveId;
            return (
              <li key={objectiveId} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                <p className="font-mono text-xs font-bold text-cyan-300">{objectiveId}</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <section aria-label={`The server's text for ${objectiveId}`}>
                    <h4 className="mb-1 text-xs font-semibold text-slate-300">The server&apos;s text</h4>
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950 p-3 font-sans text-xs text-slate-200">
                      {serverText || '(empty)'}
                    </pre>
                  </section>
                  <section aria-label={`This browser's text for ${objectiveId}`}>
                    <h4 className="mb-1 text-xs font-semibold text-slate-300">This browser&apos;s text</h4>
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950 p-3 font-sans text-xs text-slate-200">
                      {browserText || '(empty)'}
                    </pre>
                  </section>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" disabled={busy} onClick={() => void decide(objectiveId, 'server')} className="px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white disabled:opacity-50">
                    Keep the server&apos;s text
                  </button>
                  <button type="button" disabled={busy || browserText.trim() === ''} onClick={() => void decide(objectiveId, 'browser')} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50">
                    Use this browser&apos;s text
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <ErrorNotice message={error} />
        <div className="flex justify-end border-t border-slate-800 pt-3">
          <button type="button" disabled={Boolean(busyId)} onClick={() => setDismissed(true)} className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-50">
            Decide later
          </button>
        </div>
      </div>
    </DialogOverlay>
  );
};

export default ObjectiveReviewDialog;
