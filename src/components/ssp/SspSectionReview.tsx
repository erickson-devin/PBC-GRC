import React, { useId } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { sectionReviewStatus } from '../../data/ssp/sspCompleteness';
import type { SspSectionId } from '../../data/ssp/sspSections';
import { SSP_BUILDER_TEXT, reviewHistoryRows, reviewLatestLine } from '../../data/ssp/sspBuilderView';
import type { SspSectionReview as SspSectionReviewRow, SspSectionReviewState } from '../../types/sspProfile';

interface SspSectionReviewProps {
  sectionId: SspSectionId;
  supported: boolean;
  status: 'loading' | 'ready' | 'error';
  state: SspSectionReviewState | null;
  history: SspSectionReviewRow[];
  canEdit: boolean;
  disabledReason: string | null;
  signing: boolean;
  error: string | null;
  notice: string | null;
  onSignOff: () => void;
  onRetry: () => void;
}

/**
 * Who last checked this section's saved fields, and when. Shows names and times only: the content digest is held by the hook to be sent back
 * with a sign-off and is never rendered.
 */
export const SspSectionReview: React.FC<SspSectionReviewProps> = ({
  sectionId,
  supported,
  status,
  state,
  history,
  canEdit,
  disabledReason,
  signing,
  error,
  notice,
  onSignOff,
  onRetry,
}) => {
  const baseId = useId();
  const hId = `${baseId}-heading`;
  const reasonId = `${baseId}-reason`;
  const reviewStatus = sectionReviewStatus(state, supported);
  const latestLine = reviewLatestLine(reviewStatus, state?.latest ?? null);
  const rows = reviewHistoryRows(history, sectionId, state?.currentDigest ?? null);

  return (
    <section aria-labelledby={hId} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
      <h4 id={hId} className="text-sm font-bold text-white">Section review</h4>
      <p className="text-[11px] text-slate-400">{SSP_BUILDER_TEXT.reviewCovers}</p>
      {!supported ? (
        <p className="text-xs text-slate-400">{SSP_BUILDER_TEXT.reviewUnsupported}</p>
      ) : status === 'loading' ? (
        <p role="status" className="text-xs text-slate-400">{SSP_BUILDER_TEXT.reviewLoading}</p>
      ) : status === 'error' ? (
        <div className="space-y-2">
          <ErrorNotice message={SSP_BUILDER_TEXT.reviewLoadFailed} />
          <button
            type="button"
            onClick={onRetry}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          {latestLine && (
            <p
              className={`text-xs flex items-start gap-2 ${
                reviewStatus === 'reviewed' ? 'text-emerald-200' : reviewStatus === 'changed_since_review' ? 'text-amber-200' : 'text-slate-300'
              }`}
            >
              {reviewStatus === 'reviewed' && <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" aria-hidden="true" />}
              {reviewStatus === 'changed_since_review' && <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />}
              <span>{latestLine}</span>
            </p>
          )}
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={onSignOff}
                disabled={signing || disabledReason !== null}
                aria-describedby={disabledReason ? reasonId : undefined}
                className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                {signing ? SSP_BUILDER_TEXT.marking : SSP_BUILDER_TEXT.markReviewed}
              </button>
              {disabledReason && <p id={reasonId} className="text-[11px] text-slate-400">{disabledReason}</p>}
            </>
          ) : (
            <p className="text-[11px] text-slate-400">{SSP_BUILDER_TEXT.reviewReadOnly}</p>
          )}
          <ErrorNotice message={error} />
          <p role="status" className={notice ? 'text-xs text-emerald-300' : 'sr-only'}>{notice ?? ''}</p>
          {rows.length > 0 && (
            <details className="text-xs text-slate-300">
              <summary className="cursor-pointer select-none font-semibold text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
                History ({rows.length})
              </summary>
              <ol className="mt-2 max-h-48 overflow-y-auto space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-2 text-[11px]">
                    <span className="font-mono text-slate-400">{r.when}</span>
                    <span>{r.who}</span>
                    <span className="text-slate-500">{r.version}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
};
