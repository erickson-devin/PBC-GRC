/**
 * Configuration results (#103): the configuration (XCCDF / ARF) scans the server received, and the control statuses they suggest for the
 * active program. Everybody reads; a Tenant Owner / MSP Admin may record a suggested status, one control at a time, after confirming it.
 * Nothing here is kept in browser storage or logged: the server is the source of truth.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, HelpCircle, Info, ListChecks, Lock } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { useEnclaveAssets } from '../../hooks/useEnclaveAssets';
import { ApiClient } from '../../services/apiClient';
import type { VmConfigRuleResultRow } from '../../services/apiClient';
import { ErrorNotice } from '../common/ErrorNotice';
import { LegacyTenantNotice } from '../common/LegacyTenantNotice';
import { frameworkLabel } from '../../data/tenantFrameworkPolicy';
import {
  CONFIG_RESULTS_COPY, EXPORTER_XCCDF_COMMAND, applyBlock, applyConfirmText, applyResultMessage, archivedMessage, assetLabel, boundaryCaption,
  countSummary, failingAssetNames, groupResultCounts, noSuggestionsMessage, outsideNote, ruleSummary, shownCaption, sortScanRows,
  sortSuggestions, splitByProgramControls, statusLabel, suggestionLabel, suggestionStatus, unmappedNote, unsupportedMessage,
} from '../../data/telemetry/configResultsView';
import type { ControlDecisionOutcome } from '../../data/telemetry/configResultsView';
import type { VmConfigScan, VmConfigSuggestion, VmConfigSuggestionsResponse, VmConfigSuggestionValue } from '../../types/vm';
import type { ControlStatus } from '../../types/cmmc';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
interface RowResult { kind: 'ok' | 'error'; message: string; stale: boolean }

const STATUS_CLASS: Record<ControlStatus, string> = {
  MET: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  NOT_MET: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  IN_PROGRESS: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  NOT_STARTED: 'bg-slate-800 text-slate-300 border-slate-700',
};
// Suggestions are dashed: never mistaken for a recorded status
const SUGGESTION_STYLE: Record<VmConfigSuggestionValue, { cls: string; Icon: React.ElementType }> = {
  NOT_MET: { cls: 'border-dashed border-rose-500/50 bg-rose-950/30 text-rose-300', Icon: AlertTriangle },
  MET: { cls: 'border-dashed border-emerald-500/50 bg-emerald-950/30 text-emerald-300', Icon: CheckCircle2 },
  REVIEW: { cls: 'border-dashed border-amber-500/50 bg-amber-950/30 text-amber-300', Icon: HelpCircle },
};
const RETRY_CLASS = 'px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700';
const TABLE_HEAD_CLASS = 'border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold';

export const ConfigurationResultsView: React.FC = () => {
  const { currentTenant, activeProgram, programsStatus, canEdit, refreshLiveData } = useTenant();
  const { state, notesEditable, decideControlStatus, frameworkControls, setSelectedControlId } = useAssessment();
  const { assets, loading: assetsLoading, error: assetsError } = useEnclaveAssets();
  const tenantId = currentTenant.id;
  const serverBacked = Boolean(currentTenant.serverBacked);
  const programId = activeProgram?.id ?? null;
  const programName = activeProgram?.name ?? 'This program';
  const archived = Boolean(activeProgram?.archived);
  const headingId = useId();
  const scansHeadingId = useId();
  const suggestionsHeadingId = useId();
  const blockReasonId = useId();
  const baseId = useId();

  const names = useMemo(() => new Map(assets.map((a) => [a.id, a.hostName] as const)), [assets]);
  const titles = useMemo(() => new Map(frameworkControls.map((c) => [c.id, c.title] as const)), [frameworkControls]);
  const programControlIds = useMemo(() => new Set(frameworkControls.map((c) => c.id)), [frameworkControls]);

  // ── Scans: tenant-wide ──
  const [scans, setScans] = useState<{ status: LoadStatus; list: VmConfigScan[]; total: number }>({ status: 'idle', list: [], total: 0 });
  const tenantRef = useRef(tenantId);
  const loadScans = useCallback(async (): Promise<void> => {
    if (!serverBacked) return;
    const at = tenantId;
    setScans((s) => ({ ...s, status: 'loading' }));
    try {
      const r = await ApiClient.listConfigScans(tenantId, { latest: true, limit: 500 });
      if (tenantRef.current !== at) return;
      setScans({ status: 'ready', list: r.scans, total: r.totalCount });
    } catch {
      if (tenantRef.current !== at) return;
      setScans((s) => ({ ...s, status: 'error' }));
    }
  }, [tenantId, serverBacked]);
  const [openScanId, setOpenScanId] = useState<string | null>(null);
  const [rules, setRules] = useState<Record<string, { status: LoadStatus; list: VmConfigRuleResultRow[]; total: number }>>({});
  useEffect(() => {
    tenantRef.current = tenantId;
    setScans({ status: 'idle', list: [], total: 0 });
    setOpenScanId(null);
    setRules({});
    void loadScans();
  }, [tenantId, serverBacked, loadScans]);

  const toggleRules = async (scan: VmConfigScan) => {
    if (openScanId === scan.id) { setOpenScanId(null); return; }
    setOpenScanId(scan.id);
    if (rules[scan.id]?.status === 'ready') return;
    const at = tenantId;
    setRules((r) => ({ ...r, [scan.id]: { status: 'loading', list: [], total: 0 } }));
    try {
      const res = await ApiClient.getConfigScanResults(tenantId, scan.id, { result: 'fail', limit: 200 });
      if (tenantRef.current !== at) return;
      setRules((r) => ({ ...r, [scan.id]: { status: 'ready', list: res.results, total: res.totalCount } }));
    } catch {
      if (tenantRef.current !== at) return;
      setRules((r) => ({ ...r, [scan.id]: { status: 'error', list: [], total: 0 } }));
    }
  };

  // ── Suggestions: the active program ──
  const [sugg, setSugg] = useState<{ status: LoadStatus; data: VmConfigSuggestionsResponse | null }>({ status: 'idle', data: null });
  const scopeRef = useRef('');
  const loadSuggestions = useCallback(async (): Promise<void> => {
    if (!serverBacked || !programId) return;
    const scope = `${tenantId}::${programId}`;
    setSugg((s) => ({ ...s, status: 'loading' }));
    try {
      const data = await ApiClient.getConfigSuggestions(tenantId, programId);
      if (scopeRef.current !== scope) return;
      setSugg({ status: 'ready', data });
    } catch {
      if (scopeRef.current !== scope) return;
      setSugg((s) => ({ ...s, status: 'error' }));
    }
  }, [tenantId, programId, serverBacked]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const [announcement, setAnnouncement] = useState('');
  const applyRefs = useRef(new Map<string, HTMLButtonElement>());
  const resultRefs = useRef(new Map<string, HTMLElement>());
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    scopeRef.current = `${tenantId}::${programId ?? ''}`;
    setSugg({ status: 'idle', data: null });
    setConfirmId(null);
    setBusyId(null);
    setRowResults({});
    setAnnouncement('');
    void loadSuggestions();
  }, [tenantId, programId, serverBacked, loadSuggestions]);
  // The confirmation takes the focus when it opens
  useEffect(() => { if (confirmId) confirmRef.current?.focus(); }, [confirmId]);

  const focusLater = (target: () => HTMLElement | null | undefined) => { requestAnimationFrame(() => target()?.focus()); };
  const clearRow = (id: string) => setRowResults((r) => { const n = { ...r }; delete n[id]; return n; });
  const cancelConfirm = (id: string) => { setConfirmId(null); focusLater(() => applyRefs.current.get(id)); };

  const confirmApply = async (s: VmConfigSuggestion, next: ControlStatus) => {
    const scope = scopeRef.current;
    setBusyId(s.controlId);
    const outcome: ControlDecisionOutcome = await decideControlStatus(s.controlId, next);
    if (scopeRef.current !== scope) return;
    setBusyId(null);
    setConfirmId(null);
    const message = applyResultMessage(outcome, s.controlId, next);
    setRowResults((r) => ({ ...r, [s.controlId]: { kind: outcome === 'saved' ? 'ok' : 'error', message, stale: outcome === 'stale' } }));
    if (outcome === 'saved') setAnnouncement(message);
    focusLater(() => (outcome === 'saved' || outcome === 'stale' ? resultRefs.current.get(s.controlId) : applyRefs.current.get(s.controlId) ?? resultRefs.current.get(s.controlId)));
  };

  const reloadAfterStale = async (id: string) => {
    clearRow(id);
    await refreshLiveData().catch(() => undefined);
    await loadSuggestions();
  };

  const scanRows = useMemo(() => sortScanRows(scans.list, names), [scans.list, names]);
  const split = useMemo(() => splitByProgramControls(sortSuggestions(sugg.data?.controls ?? []), programControlIds), [sugg.data, programControlIds]);
  const fwLabel = frameworkLabel(sugg.data?.frameworkId ?? activeProgram?.framework ?? '');
  const scansCaption = shownCaption(scans.list.length, scans.total, 'scans');
  const data = sugg.data;

  return (
    <div className="space-y-4">
      <section aria-labelledby={headingId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
        <div>
          <h2 id={headingId} className="text-base font-bold text-white flex items-center gap-2.5">
            <span className="p-1.5 rounded-xl bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
              <ListChecks className="w-4 h-4" aria-hidden="true" />
            </span>
            <span>Configuration Results</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">{CONFIG_RESULTS_COPY.intro}</p>
        </div>

        {!serverBacked ? (
          <>
            <div role="status" data-testid="config-results-browser-only" className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
              <CloudOff className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{CONFIG_RESULTS_COPY.browserOnly}</span>
            </div>
            {canEdit && <LegacyTenantNotice tenant={currentTenant} variant="inline" />}
          </>
        ) : (
          <>
            {/* Scans */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 id={scansHeadingId} className="text-sm font-bold text-white">Latest scans</h3>
                <span className="text-xs text-slate-400">Whole organization</span>
              </div>
              {scans.status === 'error' && (
                <div className="flex items-center justify-between gap-3">
                  <ErrorNotice message={CONFIG_RESULTS_COPY.unavailable} className="flex-1" />
                  <button type="button" onClick={() => void loadScans()} className={RETRY_CLASS}>Retry</button>
                </div>
              )}
              <ErrorNotice message={assetsError ? CONFIG_RESULTS_COPY.assetNamesUnavailable : null} />
              {scansCaption && <p className="text-xs text-slate-400">{scansCaption}</p>}
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                <table data-testid="config-scans-table" aria-labelledby={scansHeadingId} aria-busy={scans.status === 'loading' || undefined} className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className={TABLE_HEAD_CLASS}>
                      <th scope="col" className="py-2.5 px-3">Asset</th>
                      <th scope="col" className="py-2.5 px-3">Benchmark and profile</th>
                      <th scope="col" className="py-2.5 px-3">Scanner</th>
                      <th scope="col" className="py-2.5 px-3">Scanned</th>
                      <th scope="col" className="py-2.5 px-3 text-right">Pass</th>
                      <th scope="col" className="py-2.5 px-3 text-right">Fail</th>
                      <th scope="col" className="py-2.5 px-3 text-right">Error</th>
                      <th scope="col" className="py-2.5 px-3 text-right">Other</th>
                      <th scope="col" className="py-2.5 px-3"><span className="sr-only">Failing rules</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {scanRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-slate-400">
                          {scans.status === 'ready' ? (
                            <>
                              <span className="block">{CONFIG_RESULTS_COPY.noResults}</span>
                              <span className="block mt-1">
                                {CONFIG_RESULTS_COPY.noResultsHint}{' '}
                                <code className="px-1.5 py-0.5 rounded bg-slate-900 text-cyan-300 font-mono">{EXPORTER_XCCDF_COMMAND}</code>
                              </span>
                            </>
                          ) : scans.status === 'error' ? (
                            <span>{CONFIG_RESULTS_COPY.noData}</span>
                          ) : (
                            <span role="status">{CONFIG_RESULTS_COPY.loading}</span>
                          )}
                        </td>
                      </tr>
                    ) : (
                      scanRows.map((scan) => {
                        const counts = groupResultCounts(scan.resultCounts);
                        const open = openScanId === scan.id;
                        const label = assetLabel(scan.assetId, names);
                        const rulesState = rules[scan.id];
                        const rulesId = `${baseId}-rules-${scan.id}`;
                        return (
                          <React.Fragment key={scan.id}>
                            <tr className="hover:bg-slate-800/40 transition-colors">
                              <th scope="row" className="py-3 px-3 font-mono font-bold text-white text-xs">
                                {assetsLoading && !names.has(scan.assetId) ? 'Loading…' : label}
                              </th>
                              <td className="py-3 px-3 text-slate-200">
                                <span>{scan.benchmarkTitle || scan.benchmarkId}</span>
                                {scan.benchmarkVersion && <span className="ml-1 font-mono text-slate-400">{scan.benchmarkVersion}</span>}
                                <span className="block text-slate-400">{scan.profileTitle || scan.profileId || CONFIG_RESULTS_COPY.noProfile}</span>
                              </td>
                              <td className="py-3 px-3 text-slate-200">
                                <span>{scan.scannerName}</span>
                                {scan.scannerVersion && <span className="ml-1 font-mono text-slate-400">{scan.scannerVersion}</span>}
                              </td>
                              <td className="py-3 px-3 text-slate-300">
                                <time dateTime={scan.scannedAt}>{new Date(scan.scannedAt).toLocaleString()}</time>
                              </td>
                              <td className="py-3 px-3 text-right font-mono text-slate-200">{counts.pass}</td>
                              <td className={`py-3 px-3 text-right font-mono ${counts.fail > 0 ? 'font-bold text-rose-300' : 'text-slate-200'}`}>{counts.fail}</td>
                              <td className={`py-3 px-3 text-right font-mono ${counts.error > 0 ? 'text-amber-300' : 'text-slate-200'}`}>{counts.error}</td>
                              <td className="py-3 px-3 text-right font-mono text-slate-200">{counts.other}</td>
                              <td className="py-3 px-3 text-right">
                                {counts.fail > 0 && (
                                  <button
                                    type="button"
                                    aria-expanded={open}
                                    aria-controls={rulesId}
                                    onClick={() => void toggleRules(scan)}
                                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                  >
                                    {open ? 'Hide failing rules' : 'Failing rules'}
                                    <span className="sr-only"> ({label})</span>
                                  </button>
                                )}
                              </td>
                            </tr>
                            {open && (
                              <tr id={rulesId}>
                                <td colSpan={9} className="px-3 pb-3 bg-slate-950/40">
                                  {!rulesState || rulesState.status === 'loading' ? (
                                    <p role="status" className="py-2 text-slate-400">{CONFIG_RESULTS_COPY.rulesLoading}</p>
                                  ) : rulesState.status === 'error' ? (
                                    <ErrorNotice message={CONFIG_RESULTS_COPY.rulesUnavailable} />
                                  ) : (
                                    <ul aria-label={`Failing rules of ${label}`} className="space-y-1.5 py-2">
                                      {rulesState.list.map((rule) => (
                                        <li key={rule.ruleId} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
                                          <span className="font-mono text-cyan-300 break-all">{rule.ruleId}</span>
                                          {rule.severity && <span className="ml-2 text-slate-400">severity {rule.severity}</span>}
                                          {rule.controls && (
                                            <span className="ml-2 font-mono text-indigo-300">
                                              {[rule.controls.cmmc, rule.controls.nist80053].filter((c): c is string => Boolean(c)).join(' · ')}
                                            </span>
                                          )}
                                          {rule.title && <span className="block text-slate-300 mt-0.5">{rule.title}</span>}
                                        </li>
                                      ))}
                                      {shownCaption(rulesState.list.length, rulesState.total, 'failing rules') && (
                                        <li className="text-slate-400">{shownCaption(rulesState.list.length, rulesState.total, 'failing rules')}</li>
                                      )}
                                    </ul>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Suggestions */}
            <section aria-labelledby={suggestionsHeadingId} data-testid="config-suggestions" className="space-y-3 pt-4 border-t border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <h3 id={suggestionsHeadingId} className="text-sm font-bold text-white">
                  Suggested control statuses{activeProgram ? <> for <span className="text-cyan-300">{activeProgram.name}</span></> : null}
                </h3>
                <span className="text-xs text-slate-400">{fwLabel}</span>
              </div>
              <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
              <p role="note" data-testid="config-suggestion-notice" className="flex items-start gap-2 rounded-xl border border-dashed border-brand-800/50 bg-brand-950/20 p-3 text-xs text-brand-200">
                <Info className="w-4 h-4 text-brand-300 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{CONFIG_RESULTS_COPY.suggestionNotice}</span>
              </p>
              {!canEdit && (
                <div role="status" className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
                  <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                  <span>{CONFIG_RESULTS_COPY.readOnly}</span>
                </div>
              )}
              {canEdit && archived && (
                <p id={blockReasonId} role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">{archivedMessage(programName)}</p>
              )}
              {canEdit && !archived && !notesEditable && (
                <p id={blockReasonId} role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">{CONFIG_RESULTS_COPY.notLoaded}</p>
              )}
              {!activeProgram && (
                programsStatus === 'error'
                  ? <ErrorNotice message={CONFIG_RESULTS_COPY.programUnavailable} />
                  : <p role="status" className="text-xs text-slate-400">{CONFIG_RESULTS_COPY.programLoading}</p>
              )}
              {activeProgram && sugg.status === 'error' && (
                <div className="flex items-center justify-between gap-3">
                  <ErrorNotice message={CONFIG_RESULTS_COPY.suggestionsUnavailable} className="flex-1" />
                  <button type="button" onClick={() => void loadSuggestions()} className={RETRY_CLASS}>Retry</button>
                </div>
              )}
              {activeProgram && !data && sugg.status !== 'error' && (
                <p role="status" className="text-xs text-slate-400">{CONFIG_RESULTS_COPY.suggestionsLoading}</p>
              )}
              {activeProgram && data && !data.supported && (
                <p role="note" className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
                  <Info className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{unsupportedMessage(fwLabel)}</span>
                </p>
              )}
              {activeProgram && data && data.supported && (
                <>
                  <p className="text-xs text-slate-400">{boundaryCaption(data.boundary, programName)}</p>
                  {unmappedNote(data.unmappedRuleCount) && <p className="text-xs text-slate-400">{unmappedNote(data.unmappedRuleCount)}</p>}
                  {outsideNote(split.outside) && <p className="text-xs text-slate-400">{outsideNote(split.outside)}</p>}
                  {split.shown.length === 0 ? (
                    <p className="rounded-xl border border-slate-800 bg-slate-950/60 py-6 text-center text-xs text-slate-400">{noSuggestionsMessage()}</p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                      <table aria-labelledby={suggestionsHeadingId} aria-busy={sugg.status === 'loading' || busyId !== null || undefined} className="w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className={TABLE_HEAD_CLASS}>
                            <th scope="col" className="py-2.5 px-3">Control</th>
                            <th scope="col" className="py-2.5 px-3">Recorded status</th>
                            <th scope="col" className="py-2.5 px-3">Suggestion</th>
                            <th scope="col" className="py-2.5 px-3">Assets and rules</th>
                            <th scope="col" className="py-2.5 px-3">Failing assets</th>
                            {canEdit && <th scope="col" className="py-2.5 px-3 text-right">Decision</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {split.shown.map((s) => {
                            const current: ControlStatus = state.controls[s.controlId]?.status ?? 'NOT_STARTED';
                            const next = suggestionStatus(s.suggestion);
                            const block = applyBlock({ suggestion: s.suggestion, currentStatus: current, canEdit, archived, controlsLoaded: notesEditable });
                            const style = SUGGESTION_STYLE[s.suggestion];
                            const failing = failingAssetNames(s.failingAssetIds, names, 5);
                            const result = rowResults[s.controlId];
                            const confirmOpen = confirmId === s.controlId && next !== null;
                            return (
                              <tr key={s.controlId} className="align-top hover:bg-slate-800/40 transition-colors">
                                <th scope="row" className="py-3 px-3 font-normal">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedControlId(s.controlId)}
                                    aria-label={`Open ${s.controlId}`}
                                    className="font-mono font-bold text-cyan-300 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                                  >
                                    {s.controlId}
                                  </button>
                                  {titles.get(s.controlId) && <span className="block text-slate-400 max-w-xs">{titles.get(s.controlId)}</span>}
                                </th>
                                <td className="py-3 px-3">
                                  <span className={`badge inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono font-bold border ${STATUS_CLASS[current]}`}>{statusLabel(current)}</span>
                                </td>
                                <td className="py-3 px-3">
                                  <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${style.cls}`}>
                                    <style.Icon className="w-3 h-3" aria-hidden="true" />
                                    <span>{suggestionLabel(s.suggestion)}</span>
                                  </span>
                                  <span className="block text-slate-400 mt-1">{CONFIG_RESULTS_COPY.notApplied}</span>
                                </td>
                                <td className="py-3 px-3 text-slate-200">
                                  <span className="block">{countSummary(s.assets)}</span>
                                  <span className="block text-slate-400">{ruleSummary(s.rules)}</span>
                                  {s.latestScanAt && (
                                    <span className="block text-slate-400">Latest scan <time dateTime={s.latestScanAt}>{new Date(s.latestScanAt).toLocaleString()}</time></span>
                                  )}
                                </td>
                                <td className="py-3 px-3">
                                  {failing.shown.length === 0 ? (
                                    <span className="text-slate-400">None</span>
                                  ) : (
                                    <>
                                      <ul aria-label={`Assets failing ${s.controlId}`} className="space-y-0.5">
                                        {failing.shown.map((n, i) => <li key={i} className="font-mono text-slate-200">{n}</li>)}
                                      </ul>
                                      {failing.more > 0 && <span className="block text-slate-400">+{failing.more} more</span>}
                                    </>
                                  )}
                                </td>
                                {canEdit && (
                                  <td className="py-3 px-3 text-right">
                                    {confirmOpen && next ? (
                                      <div
                                        role="group"
                                        aria-labelledby={`${baseId}-confirm-${s.controlId}`}
                                        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelConfirm(s.controlId); } }}
                                        className="ml-auto max-w-xs space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-left"
                                      >
                                        <p id={`${baseId}-confirm-${s.controlId}`} className="text-xs text-amber-100">{applyConfirmText(s.controlId, current, next)}</p>
                                        <div className="flex items-center justify-end gap-2">
                                          <button
                                            type="button"
                                            onClick={() => cancelConfirm(s.controlId)}
                                            disabled={busyId !== null}
                                            className="px-3 py-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 text-xs"
                                          >
                                            Cancel
                                          </button>
                                          <button
                                            ref={confirmRef}
                                            type="button"
                                            onClick={() => void confirmApply(s, next)}
                                            disabled={busyId !== null}
                                            className="btn-primary px-3 py-1.5 rounded-xl text-xs"
                                          >
                                            {busyId === s.controlId ? 'Recording…' : `Record ${statusLabel(next)}`}
                                          </button>
                                        </div>
                                      </div>
                                    ) : block === 'matches' ? (
                                      <span className="text-slate-400">Matches the recorded status</span>
                                    ) : block === 'review' ? (
                                      <span className="text-slate-400">No status suggested</span>
                                    ) : next ? (
                                      <button
                                        type="button"
                                        ref={(el) => { if (el) applyRefs.current.set(s.controlId, el); else applyRefs.current.delete(s.controlId); }}
                                        onClick={() => { clearRow(s.controlId); setConfirmId(s.controlId); }}
                                        disabled={block !== null || busyId !== null || confirmId !== null}
                                        aria-describedby={block !== null ? blockReasonId : undefined}
                                        className="px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cyan-500/20 text-cyan-200 border-cyan-500/40 hover:bg-cyan-500/30 whitespace-nowrap"
                                      >
                                        Apply {statusLabel(next)}…<span className="sr-only"> to {s.controlId}</span>
                                      </button>
                                    ) : null}
                                    {result && result.kind === 'ok' && (
                                      <p
                                        ref={(el) => { if (el) resultRefs.current.set(s.controlId, el); else resultRefs.current.delete(s.controlId); }}
                                        tabIndex={-1}
                                        className="mt-1.5 flex items-center justify-end gap-1 text-xs text-emerald-300 focus:outline-none"
                                      >
                                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                        <span>{result.message}</span>
                                      </p>
                                    )}
                                    {result && result.kind === 'error' && (
                                      <div
                                        ref={(el) => { if (el) resultRefs.current.set(s.controlId, el); else resultRefs.current.delete(s.controlId); }}
                                        tabIndex={-1}
                                        role="alert"
                                        className="mt-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-left text-xs text-rose-300 focus:outline-none"
                                      >
                                        {result.message}
                                        {result.stale && (
                                          <button type="button" onClick={() => void reloadAfterStale(s.controlId)} className="ml-2 underline text-rose-200 hover:text-white">Reload</button>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </section>
    </div>
  );
};

export default ConfigurationResultsView;
