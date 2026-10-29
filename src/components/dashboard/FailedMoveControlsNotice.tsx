import React, { useRef, useState } from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import { useFailedMoveControls } from '../../hooks/useFailedMoveControls';
import { ErrorNotice } from '../common/ErrorNotice';
import { ConfirmKeepServerAnswersDialog } from './ConfirmKeepServerAnswersDialog';

/** Offers a retry for control answers that did not reach the server when a browser-only tenant was moved (#113). Renders nothing when none are left. */
export const FailedMoveControlsNotice: React.FC = () => {
  const { pending, status, error, lastResult, retry, keepServerVersion } = useFailedMoveControls();
  const [confirming, setConfirming] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  if (pending === 0) return null;
  const conflictCount = lastResult ? lastResult.conflictIds.reduce((n, c) => n + c.ids.length, 0) : 0;
  return (
    <div ref={regionRef} tabIndex={-1} role="region" aria-label="Control answers not yet moved to the server" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs focus:outline-none">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 leading-relaxed text-slate-300">
          <strong className="text-amber-200">{pending} control answer{pending === 1 ? ' is' : 's are'} still only in this browser.</strong>{' '}
          They were not saved when this tenant was moved to the server. Retry to save them; this browser&apos;s copy is removed once the server holds them.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {conflictCount > 0 && (
            <button type="button" onClick={() => setConfirming(true)} disabled={status !== 'idle'} className="px-3 py-2 text-xs font-semibold text-amber-200 hover:text-white disabled:opacity-50">
              Keep the server&apos;s version
            </button>
          )}
          <button type="button" onClick={() => void retry()} disabled={status !== 'idle'} className="btn-primary px-4 py-2 text-xs shrink-0 disabled:opacity-50">
            {status === 'retrying' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{status === 'retrying' ? 'Retrying…' : `Retry moving ${pending} control answer${pending === 1 ? '' : 's'}`}</span>
          </button>
        </div>
      </div>
      <ErrorNotice message={error} className="mt-3" />
      <p role="status" aria-live="polite" className="mt-2 text-amber-200">
        {lastResult ? `${lastResult.saved} saved, ${lastResult.conflicts} differ from the server, ${lastResult.stillLocal} still in this browser.` : ''}
      </p>
      {confirming && (
        <ConfirmKeepServerAnswersDialog
          count={conflictCount}
          onConfirm={keepServerVersion}
          onClose={() => setConfirming(false)}
          onDiscarded={() => regionRef.current?.focus()}
        />
      )}
    </div>
  );
};
