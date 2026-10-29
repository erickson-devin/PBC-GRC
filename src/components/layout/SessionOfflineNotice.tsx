import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CloudOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';

const RECOVERED_NOTICE_MS = 5000;

/**
 * Non-blocking notice while the server could not confirm the session on load (sessionCheck 'offline'): the app shows the
 * data saved in this browser. "Try again" re-runs the tenant sync; when the server answers, the notice gives way to a short
 * "connected again" line and the programs and controls are reloaded. Hiding it lasts for this offline episode only.
 */
export const SessionOfflineNotice: React.FC = () => {
  const { sessionCheck } = useAuth();
  const { currentTenant, tenantSync, syncTenantsFromServer, refreshPrograms, refreshLiveData } = useTenant();
  const [dismissed, setDismissed] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef(sessionCheck);

  const offline = sessionCheck === 'offline';
  const retrying = offline && tenantSync.status === 'syncing';

  useEffect(() => {
    const was = previous.current;
    previous.current = sessionCheck;
    if (sessionCheck !== 'offline') setDismissed(false);
    if (sessionCheck !== 'verified') setRecovered(false);
    if (sessionCheck === 'offline') setAnnouncement('The server cannot be reached. Showing the data saved in this browser.');
    if (was === 'offline' && sessionCheck === 'verified') {
      setRecovered(true);
      setAnnouncement('Connected to the server again.');
      // The data loaded while offline failed: load the programs and the active program's controls again
      void refreshPrograms().then(() => refreshLiveData()).catch(() => undefined);
      const timer = window.setTimeout(() => setRecovered(false), RECOVERED_NOTICE_MS);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [sessionCheck, refreshPrograms, refreshLiveData]);

  const retry = () => {
    void syncTenantsFromServer(undefined, { force: true }).catch(() => undefined);
  };

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {offline && !dismissed && (
        <div
          role="region"
          aria-label="Server connection"
          className="max-w-7xl mx-auto mt-2 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="flex min-w-0 items-start gap-2 text-amber-200">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-amber-100">The server cannot be reached.</strong>{' '}
              {currentTenant.serverBacked
                ? 'You are seeing the data last saved in this browser, which may be out of date. Changes cannot be saved until the connection is back.'
                : 'This organization is stored in this browser, so its notes still save here. Anything that needs the server waits until the connection is back.'}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={retry} disabled={retrying} className="btn-base btn-secondary px-3 py-1.5 text-xs">
              {retrying
                ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{retrying ? 'Checking…' : 'Try again'}</span>
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Hide this notice"
              title="Hide this notice"
              className="p-1.5 rounded-lg text-amber-300/80 hover:text-white hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      {recovered && (
        <div className="max-w-7xl mx-auto mt-2 flex items-center gap-2 rounded-xl border border-emerald-800/50 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
          <span>Connected to the server again.</span>
        </div>
      )}
    </>
  );
};

export default SessionOfflineNotice;
