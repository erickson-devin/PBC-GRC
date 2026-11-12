import React, { useEffect, useId, useMemo, useState } from 'react';
import { Search, ShieldAlert } from 'lucide-react';
import { VM_SEVERITIES } from '../../types/vm';
import type { VmFinding } from '../../types/vm';
import { NOT_REPORTED } from '../../data/telemetry/observedInventoryView';
import {
  FINDINGS_COPY,
  FINDINGS_RENDER_STEP,
  FINDING_STATUS_FILTERS,
  SEVERITY_BADGE,
  SEVERITY_LABEL,
  STATUS_BADGE,
  STATUS_LABEL,
  affectedPackagesView,
  filterFindings,
  findingsCapNotice,
  findingsCaption,
  findingsEmptyMessage,
  fixText,
  moreText,
  packageLabel,
  severityCounts,
  sortFindings,
} from '../../data/telemetry/vmFindingsView';
import type { FindingStatusFilter, SeverityFilter } from '../../data/telemetry/vmFindingsView';
import type { VmFindingsStatus } from '../../hooks/useVmFindings';

interface VmFindingsListProps {
  status: VmFindingsStatus;
  findings: VmFinding[];
  statusFilter: FindingStatusFilter;
  onStatusFilterChange: (s: FindingStatusFilter) => void;
  onRetry: () => void;
  /** Whether a scanner has reported this host (null while that is not known): only changes the wording of the empty state. */
  scannerReported: boolean | null;
}

const FIELD_CLASS = 'bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-cyan-500';

const dateOnly = (iso: string): string | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

const SeenDate: React.FC<{ iso: string }> = ({ iso }) => {
  const text = dateOnly(iso);
  return text === null ? <span className="text-slate-400">{NOT_REPORTED}</span> : <time dateTime={iso}>{text}</time>;
};

/**
 * The vulnerability findings the scanners report for one asset, read-only: searched and filtered here, never kept in the browser.
 * Every scanner string is rendered as a text node; no link, no write action, no justification or decider.
 */
export const VmFindingsList: React.FC<VmFindingsListProps> = ({ status, findings, statusFilter, onStatusFilterChange, onRetry, scannerReported }) => {
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<SeverityFilter>('ALL');
  const [visible, setVisible] = useState<number>(FINDINGS_RENDER_STEP);
  const idBase = useId();
  const statusId = `${idBase}-status`;
  const searchId = `${idBase}-search`;
  const severityId = `${idBase}-severity`;

  useEffect(() => {
    setVisible(FINDINGS_RENDER_STEP);
  }, [query, severity, statusFilter]);

  const sorted = useMemo(() => sortFindings(findings), [findings]);
  const shown = useMemo(() => filterFindings(sorted, query, severity), [sorted, query, severity]);
  const counts = useMemo(() => severityCounts(findings), [findings]);
  const rows = shown.slice(0, visible);
  const capNotice = status === 'ready' ? findingsCapNotice(findings.length) : null;

  return (
    <section aria-labelledby={`${idBase}-heading`} aria-busy={status === 'loading' || undefined} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3 text-xs">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h3 id={`${idBase}-heading`} className="flex items-center gap-1.5 text-xs font-bold text-cyan-300">
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{FINDINGS_COPY.heading}</span>
          </h3>
          <p className="text-slate-400 mt-1">{FINDINGS_COPY.note}</p>
        </div>
        <div className="shrink-0">
          <label htmlFor={statusId} className="block font-semibold text-slate-300 mb-1">Status</label>
          <select id={statusId} value={statusFilter} onChange={(e) => onStatusFilterChange(e.target.value as FindingStatusFilter)} className={FIELD_CLASS}>
            {FINDING_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? 'All statuses' : STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
      </div>

      {status === 'idle' || (status === 'loading' && findings.length === 0) ? (
        <p role="status" className="text-slate-400">{FINDINGS_COPY.loading}</p>
      ) : status === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
          <span>{FINDINGS_COPY.loadError}</span>
          <button type="button" onClick={onRetry} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0">{FINDINGS_COPY.retry}</button>
        </div>
      ) : findings.length === 0 ? (
        <p role="status" className="text-slate-400">{findingsEmptyMessage({ statusFilter, scannerReported })}</p>
      ) : (
        <>
          <ul aria-label="Findings by severity" className="flex flex-wrap gap-1.5">
            {VM_SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
              <li key={s}>
                <span className={`badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold border ${SEVERITY_BADGE[s]}`}>
                  {SEVERITY_LABEL[s]} <span className="font-mono">{counts[s]}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <label htmlFor={searchId} className="block font-semibold text-slate-300 mb-1">Search findings</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="CVE or package name"
                  className={`${FIELD_CLASS} w-full pl-9`}
                />
              </div>
            </div>
            <div>
              <label htmlFor={severityId} className="block font-semibold text-slate-300 mb-1">Severity</label>
              <select id={severityId} value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)} className={FIELD_CLASS}>
                <option value="ALL">All severities</option>
                {VM_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
                ))}
              </select>
            </div>
          </div>

          <p role="status" className="text-slate-400">{findingsCaption(shown.length, findings.length)}</p>
          {capNotice && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">{capNotice}</div>
          )}

          <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-slate-800" tabIndex={0} role="region" aria-label="Vulnerability findings table">
            <table className="w-full min-w-[40rem] text-left text-xs border-collapse">
              <caption className="sr-only">{FINDINGS_COPY.caption}</caption>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-slate-800 bg-slate-900 text-slate-400 font-semibold">
                  <th scope="col" className="py-2 px-3">Vulnerability</th>
                  <th scope="col" className="py-2 px-3">Severity</th>
                  <th scope="col" className="py-2 px-3">Status</th>
                  <th scope="col" className="py-2 px-3">Affected packages</th>
                  <th scope="col" className="py-2 px-3">First seen</th>
                  <th scope="col" className="py-2 px-3">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-slate-400">{FINDINGS_COPY.noMatch}</td>
                  </tr>
                ) : (
                  rows.map((f) => {
                    const pk = affectedPackagesView(f);
                    return (
                      <tr key={f.id} className="align-top">
                        <th scope="row" className="py-2 px-3 font-mono font-bold text-cyan-300 whitespace-nowrap text-left">{f.vulnId}</th>
                        <td className="py-2 px-3">
                          <span className={`badge px-1.5 py-0.5 rounded text-xs font-mono font-bold border ${SEVERITY_BADGE[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
                        </td>
                        <td className="py-2 px-3">
                          <span className={`badge px-1.5 py-0.5 rounded text-xs font-semibold border ${STATUS_BADGE[f.status]}`}>{STATUS_LABEL[f.status]}</span>
                        </td>
                        <td className="py-2 px-3 text-slate-200">
                          {pk.shown.length === 0 ? (
                            <span className="text-slate-400">{NOT_REPORTED}</span>
                          ) : (
                            <ul className="space-y-0.5">
                              {pk.shown.map((p, i) => (
                                <li key={`${p.name}|${p.version}|${i}`} className="break-words">
                                  <span className="font-mono">{packageLabel(p)}</span>{' '}
                                  <span className={p.fixedVersion ? 'text-emerald-300' : 'text-slate-400'}>({fixText(p)})</span>
                                </li>
                              ))}
                              {pk.more > 0 && <li className="text-slate-400">{moreText(pk.more)}</li>}
                            </ul>
                          )}
                        </td>
                        <td className="py-2 px-3 text-slate-300 whitespace-nowrap"><SeenDate iso={f.firstSeenAt} /></td>
                        <td className="py-2 px-3 text-slate-300 whitespace-nowrap"><SeenDate iso={f.lastSeenAt} /></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {shown.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((v) => v + FINDINGS_RENDER_STEP)}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              {`Show ${Math.min(FINDINGS_RENDER_STEP, shown.length - visible)} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
};
