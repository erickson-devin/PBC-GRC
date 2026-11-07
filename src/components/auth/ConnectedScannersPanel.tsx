import React, { useCallback, useEffect, useId, useState } from 'react';
import { Radar, CheckCircle2, Clock, AlertTriangle, CircleDashed } from 'lucide-react';
import { ApiClient } from '../../services/apiClient';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  CONNECTED_SCANNERS_COPY, SOURCE_STATE_LABEL, latestRunBySource, pushSummary, sourceStatus,
} from '../../data/telemetry/vmSourcesView';
import { tokenPrefixLabel } from '../../data/telemetry/vmTokensView';
import type { SourceState } from '../../data/telemetry/vmSourcesView';
import type { VmRun, VmServiceToken, VmSource } from '../../types/vm';

/**
 * Connected scanners: the VM sources of this organization with their latest status (never / ok / stale / failed), last push, counts and
 * exporter version. Read-only. For owners and admins (`canManageTokens`) it also lists each service token's last push outcome. A failed load shows fixed text, never the server's message. Names and errors are rendered as text.
 */
interface ConnectedScannersPanelProps {
  tenantId: string;
  /** Owners and admins only: also show each service token's last push outcome. */
  canManageTokens?: boolean;
}

const STATE_STYLE: Record<SourceState, { cls: string; Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }> }> = {
  ok: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  stale: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: Clock },
  failed: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30', Icon: AlertTriangle },
  never: { cls: 'bg-slate-800 text-slate-300 border-slate-700', Icon: CircleDashed },
};
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type LoadState = { status: 'loading' | 'ready' | 'error'; sources: VmSource[]; runs: VmRun[] };

export const ConnectedScannersPanel: React.FC<ConnectedScannersPanelProps> = ({ tenantId, canManageTokens = false }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading', sources: [], runs: [] });
  const [tokens, setTokens] = useState<VmServiceToken[]>([]);
  const [tokensError, setTokensError] = useState(false);
  const headingId = useId();

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading' }));
    try {
      const [sources, runs] = await Promise.all([ApiClient.listVmSources(tenantId), ApiClient.listVmRuns(tenantId, 200)]);
      setState({ status: 'ready', sources, runs });
    } catch {
      setState((s) => ({ ...s, status: 'error' }));
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  // The tokens load on their own, so a failure here never hides the sources.
  useEffect(() => {
    if (!canManageTokens) { setTokens([]); setTokensError(false); return; }
    let cancelled = false;
    ApiClient.listVmTokens(tenantId)
      .then((list) => { if (!cancelled) { setTokens(list); setTokensError(false); } })
      .catch(() => { if (!cancelled) { setTokens([]); setTokensError(true); } });
    return () => { cancelled = true; };
  }, [tenantId, canManageTokens]);

  const now = Date.now();
  const latest = latestRunBySource(state.runs);
  const pushedTokens = tokens.filter((t) => t.lastPushAt);

  return (
    <section aria-labelledby={headingId} className="space-y-2 text-xs pt-4 border-t border-slate-800">
      <h3 id={headingId} className="text-sm font-bold text-white flex items-center gap-1.5">
        <Radar className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" />{CONNECTED_SCANNERS_COPY.heading}
      </h3>
      {state.status === 'loading' && state.sources.length === 0 && (
        <p role="status" className="text-slate-400">{CONNECTED_SCANNERS_COPY.loading}</p>
      )}
      {state.status === 'error' && (
        <div className="flex items-center justify-between gap-3">
          <ErrorNotice message={CONNECTED_SCANNERS_COPY.loadError} className="flex-1" />
          <button type="button" aria-label="Retry loading the scanners" onClick={() => void load()} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">{CONNECTED_SCANNERS_COPY.retry}</button>
        </div>
      )}
      {state.status === 'ready' && state.sources.length === 0 && (
        <p className="rounded-xl border border-slate-800 bg-slate-950/60 py-6 text-center text-slate-400">{CONNECTED_SCANNERS_COPY.empty}</p>
      )}
      {state.sources.length > 0 && (
        <ul className="space-y-2">
          {state.sources.map((source) => {
            const status = sourceStatus(source, latest.get(source.id) ?? null, now, source.expectedIntervalMinutes);
            const { cls, Icon } = STATE_STYLE[status.state];
            return (
              <li key={source.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-white break-words">
                    {source.label} <span className="font-mono text-slate-400 font-normal">{source.kind}</span>
                  </span>
                  <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${cls}`}>
                    <Icon className="w-3 h-3" aria-hidden="true" />
                    <span>{SOURCE_STATE_LABEL[status.state]}</span>
                  </span>
                </div>
                <p className="text-slate-300">
                  Last push:{' '}
                  {status.lastPushAt ? <time dateTime={status.lastPushAt}>{fmtDateTime(status.lastPushAt)}</time> : CONNECTED_SCANNERS_COPY.never}
                  {status.counts && ` · ${status.counts.hosts} hosts · ${status.counts.findings} findings · ${status.counts.configResults} configuration results`}
                  {status.exporterVersion && ` · exporter ${status.exporterVersion}`}
                </p>
                {status.error && <p className="text-rose-300 break-words">{status.error}</p>}
                {status.warning && <p className="text-amber-200 break-words">{status.warning}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {canManageTokens && (tokensError || pushedTokens.length > 0) && (
        <div className="space-y-2 pt-2">
          <h4 className="text-xs font-bold text-slate-200">{CONNECTED_SCANNERS_COPY.tokensHeading}</h4>
          {tokensError && <ErrorNotice message={CONNECTED_SCANNERS_COPY.tokensLoadError} />}
          {pushedTokens.length > 0 && (
            <ul className="space-y-2">
              {pushedTokens.map((t) => {
                const summary = pushSummary(t);
                return (
                  <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 space-y-1">
                    <p className="font-semibold text-white break-words">
                      {t.name} <span className="font-mono text-slate-400 font-normal">{tokenPrefixLabel(t.tokenPrefix)}</span>
                    </p>
                    <p className="text-slate-300">
                      Last push: {summary.at && <time dateTime={summary.at}>{fmtDateTime(summary.at)}</time>}
                    </p>
                    <p className={`break-words ${summary.state === 'refused' ? 'text-rose-300' : 'text-emerald-300'}`}>{summary.text}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
