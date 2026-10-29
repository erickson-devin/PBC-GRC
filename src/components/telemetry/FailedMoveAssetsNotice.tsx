import React from 'react';
import { CloudUpload, Loader2 } from 'lucide-react';
import { useFailedMoveAssets } from '../../hooks/useFailedMoveAssets';
import { ErrorNotice } from '../common/ErrorNotice';

/** Offers a retry for assets that did not reach the server when a browser-only tenant was moved (#92). Renders nothing when none are left. */
export const FailedMoveAssetsNotice: React.FC = () => {
  const { pending, status, error, lastResult, retry } = useFailedMoveAssets();
  if (pending === 0) return null;
  return (
    <div role="region" aria-label="Assets not yet moved to the server" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 leading-relaxed text-slate-300">
          <strong className="text-amber-200">{pending} asset{pending === 1 ? ' is' : 's are'} still only in this browser.</strong>{' '}
          They were not saved when this tenant was moved to the server. Retry to add them to the inventory; this browser&apos;s copy is removed once the server holds them.
        </p>
        <button type="button" onClick={() => void retry()} disabled={status !== 'idle'} className="btn-primary px-4 py-2 text-xs shrink-0 disabled:opacity-50">
          {status === 'retrying' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />}
          <span>{status === 'retrying' ? 'Retrying…' : `Retry moving ${pending} asset${pending === 1 ? '' : 's'}`}</span>
        </button>
      </div>
      <ErrorNotice message={error} className="mt-3" />
      <p role="status" aria-live="polite" className="mt-2 text-amber-200">{lastResult ? `${lastResult.moved} moved, ${lastResult.stillLocal} still in this browser.` : ''}</p>
    </div>
  );
};
