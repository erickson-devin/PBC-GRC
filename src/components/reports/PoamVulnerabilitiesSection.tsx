import React, { useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Info, Loader2, Search, ShieldAlert } from 'lucide-react';
import { Badge } from '../common/Badge';
import { ErrorNotice } from '../common/ErrorNotice';
import { POAM_GROUP_PAGE, groupOpen, initialExpanded, poamQueryTerms, showMoreText } from '../../data/reports/poamView';
import {
  VM_POAM_COPY,
  VM_UPCOMING_DEFAULT_OPEN,
  daysRemainingText,
  filterVmPoamRows,
  groupVmPoamByAsset,
  isoDate,
  vmItemsEmptyText,
  vmPackagesView,
  vmPoamNotices,
  vmResultsText,
  vmRulesText,
  vmWeaknessIds,
  type VmPoamLoad,
} from '../../data/reports/vmPoamView';
import { SEVERITY_BADGE, SEVERITY_LABEL, fixText, moreText, packageLabel } from '../../data/telemetry/vmFindingsView';
import type { VmAffectedPackage, VmPoamResponse, VmPoamStatus, VmSeverity } from '../../types/vm';
import { PoamGroupPanel, SMALL_BUTTON } from './PoamGroupPanel';

export interface PoamVulnerabilitiesSectionProps {
  load: VmPoamLoad;
  onRetry: () => void;
  framework: string;
  targetProgramName: string | null;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

const STATUS_LABEL: Record<VmPoamStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', RISK_ACCEPTED: 'Risk accepted' };

const NOTE_CLASS = 'rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400';

const SeverityBadge: React.FC<{ severity: VmSeverity; prefix?: string }> = ({ severity, prefix }) => (
  <span className={`badge px-2 py-0.5 rounded border text-xs font-bold ${SEVERITY_BADGE[severity]}`}>
    {prefix && <span className="sr-only">{prefix}</span>}
    {SEVERITY_LABEL[severity]}
  </span>
);

type PackageSource = { affectedPackages: readonly VmAffectedPackage[]; affectedPackageCount: number };

const PackageLines: React.FC<{ f: PackageSource }> = ({ f }) => {
  const view = vmPackagesView(f);
  if (view.shown.length === 0) return <span className="text-slate-400">None recorded</span>;
  return (
    <>
      {view.shown.map((p, i) => (
        <div key={`${p.name}-${p.version}-${i}`}>{packageLabel(p)} ({fixText(p)})</div>
      ))}
      {view.more > 0 && <div className="text-slate-400">{moreText(view.more)}</div>}
    </>
  );
};

const packagesLine = (f: PackageSource): string => {
  const view = vmPackagesView(f);
  return view.shown.length === 0 ? 'No packages recorded' : [...view.shown.map((p) => packageLabel(p)), ...(view.more > 0 ? [moreText(view.more)] : [])].join(', ');
};

/**
 * The vulnerabilities half of the POA&M screen (#274): the program's open vulnerability POA&M items grouped by asset, the rules that
 * create them, and (for the vulnerability target) a collapsed list of what is coming due. Props only; read-only; weakness text and
 * asset names are rendered as text and held in React state only. A failed load never claims there are no items.
 */
export const PoamVulnerabilitiesSection: React.FC<PoamVulnerabilitiesSectionProps> = ({ load, onRetry, framework, targetProgramName, headingRef }) => {
  const uid = useId();
  const headingId = `${uid}-heading`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <ShieldAlert className="w-4 h-4 text-rose-400" aria-hidden="true" />
        {VM_POAM_COPY.heading}
      </h3>
      {load.status === 'unsupported' && <p role="note" className={NOTE_CLASS}>{VM_POAM_COPY.browserOnly}</p>}
      {(load.status === 'idle' || load.status === 'loading') && (
        <p role="status" aria-live="polite" className="text-xs text-slate-400 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          {VM_POAM_COPY.loading}
        </p>
      )}
      {load.status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message={VM_POAM_COPY.loadError} />
          <button type="button" onClick={onRetry} className={SMALL_BUTTON}>{VM_POAM_COPY.retry}</button>
        </div>
      )}
      {load.status === 'no_program' && <p role="note" className={NOTE_CLASS}>{VM_POAM_COPY.noProgram}</p>}
      {load.status === 'ready' && <PoamVulnerabilitiesReady data={load.data} framework={framework} targetProgramName={targetProgramName} />}
    </section>
  );
};

const PoamVulnerabilitiesReady: React.FC<{ data: VmPoamResponse; framework: string; targetProgramName: string | null }> = ({ data, framework, targetProgramName }) => {
  const uid = useId();
  const searchId = `${uid}-search`;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const [upcomingOpen, setUpcomingOpen] = useState<boolean>(VM_UPCOMING_DEFAULT_OPEN);
  const [upcomingShown, setUpcomingShown] = useState<number>(POAM_GROUP_PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const upcomingToggleRef = useRef<HTMLButtonElement | null>(null);

  const notices = useMemo(() => vmPoamNotices(data, { framework, targetProgramName }), [data, framework, targetProgramName]);
  const ids = useMemo(() => vmWeaknessIds(data.items), [data.items]);
  const filtered = useMemo(() => filterVmPoamRows(data.items, query), [data.items, query]);
  const groups = useMemo(() => groupVmPoamByAsset(filtered), [filtered]);
  const initial = useMemo(() => initialExpanded(groups.map((g) => g.key)), [groups]);
  const searching = poamQueryTerms(query).length > 0;

  const changeQuery = (value: string) => {
    setQuery(value);
    setShown({});
    setSearchCollapsed(new Set());
  };
  const clearSearch = () => {
    changeQuery('');
    searchRef.current?.focus();
  };
  const flip = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };
  const toggleGroup = (key: string) => {
    if (searching) setSearchCollapsed((prev) => flip(prev, key));
    else setExpanded(flip(expanded ?? initial, key));
  };
  const expandAll = () => {
    if (searching) setSearchCollapsed(new Set());
    else setExpanded(new Set(groups.map((g) => g.key)));
  };
  const collapseAll = () => {
    if (searching) setSearchCollapsed(new Set(groups.map((g) => g.key)));
    else setExpanded(new Set());
  };
  const showMore = (key: string, total: number) => {
    const next = (shown[key] ?? POAM_GROUP_PAGE) + POAM_GROUP_PAGE;
    setShown((prev) => ({ ...prev, [key]: next }));
    if (next >= total) requestAnimationFrame(() => toggleRefs.current.get(key)?.focus());
  };

  const tableWrap = 'overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';
  const headClass = 'bg-slate-950 text-slate-400 uppercase text-xs tracking-wider border-b border-slate-800';

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400 leading-relaxed">{vmRulesText(data.rules, framework)}</p>
      {notices.map((n) => (
        <p
          key={n.id}
          role="note"
          className={n.tone === 'amber'
            ? 'flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200'
            : 'flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300'}
        >
          {n.tone === 'amber'
            ? <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />
            : <Info className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />}
          <span>{n.text}</span>
        </p>
      ))}

      {data.items.length === 0 ? (
        <p className="p-6 text-center rounded-2xl bg-slate-900/60 border border-slate-800 text-sm text-slate-300">{vmItemsEmptyText(data)}</p>
      ) : (
        <>
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">{VM_POAM_COPY.searchLabel}</label>
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                id={searchId}
                ref={searchRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
                placeholder={VM_POAM_COPY.searchPlaceholder}
                className="w-full pl-10 pr-20 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-none text-xs sm:text-sm text-white placeholder-slate-400 transition-all duration-200"
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap pt-3 border-t border-slate-800/80">
              <p role="status" aria-live="polite" className="text-xs text-slate-400">{vmResultsText(filtered.length, data.items.length)}</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={expandAll} className={SMALL_BUTTON}>Expand all</button>
                <button type="button" onClick={collapseAll} className={SMALL_BUTTON}>Collapse all</button>
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="p-6 text-center rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
              <p className="text-sm text-slate-300">{VM_POAM_COPY.noMatch}</p>
              <button type="button" onClick={clearSearch} className={SMALL_BUTTON}>Clear search</button>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const rows = g.items.slice(0, shown[g.key] ?? POAM_GROUP_PAGE);
                const remaining = g.items.length - rows.length;
                const caption = VM_POAM_COPY.itemsCaption(g.assetName);
                return (
                  <PoamGroupPanel
                    key={g.key}
                    title={g.assetName}
                    countText={`${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}`}
                    badges={(
                      <>
                        {g.worstSeverity && <SeverityBadge severity={g.worstSeverity} prefix="Most severe: " />}
                        {g.kevCount > 0 && <Badge tone="rose" pill={false} title={VM_POAM_COPY.kevTitle}>{g.kevCount} KEV</Badge>}
                      </>
                    )}
                    expanded={groupOpen(g.key, { searching, expanded, searchCollapsed, initial })}
                    onToggle={() => toggleGroup(g.key)}
                    toggleRef={(el) => {
                      if (el) toggleRefs.current.set(g.key, el);
                      else toggleRefs.current.delete(g.key);
                    }}
                  >
                    <div className={tableWrap} tabIndex={0} role="region" aria-label={caption}>
                      <table className="w-full min-w-[560px] lg:min-w-0 text-left text-xs">
                        <caption className="sr-only">{caption}</caption>
                        <thead className={headClass}>
                          <tr>
                            <th scope="col" className="p-3">Weakness ID</th>
                            <th scope="col" className="p-3">Vulnerability</th>
                            <th scope="col" className="p-3">Severity</th>
                            <th scope="col" className="p-3 hidden md:table-cell">Affected Packages</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">First Seen</th>
                            <th scope="col" className="p-3">Deadline</th>
                            <th scope="col" className="p-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {rows.map((row) => {
                            const f = row.finding;
                            return (
                              <tr key={row.id} className="hover:bg-slate-850/50">
                                <th scope="row" className="p-3 font-mono font-bold text-amber-300 whitespace-nowrap text-left">{ids.get(row.id) ?? ''}</th>
                                <td className="p-3 text-slate-300 max-w-xs">
                                  {f ? (
                                    <>
                                      <span className="font-mono text-white">{f.vulnId}</span>
                                      {f.kev && <Badge tone="rose" pill={false} className="ml-1.5" title={VM_POAM_COPY.kevTitle}>KEV</Badge>}
                                      <p className="mt-1 text-slate-400 md:hidden">{packagesLine(f)}</p>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-slate-400">{VM_POAM_COPY.findingRemoved}</span>
                                      <p className="mt-1 text-slate-400 whitespace-pre-wrap break-words">{row.weakness}</p>
                                    </>
                                  )}
                                </td>
                                <td className="p-3">{f ? <SeverityBadge severity={f.severity} /> : <span className="text-slate-400">Unknown</span>}</td>
                                <td className="p-3 text-slate-300 hidden md:table-cell">{f ? <PackageLines f={f} /> : <span className="text-slate-400">None recorded</span>}</td>
                                <td className="p-3 font-mono text-slate-300 hidden lg:table-cell">{isoDate(f?.firstSeenAt ?? row.findingFirstSeenAt)}</td>
                                <td className="p-3 font-mono text-slate-300">{isoDate(f?.slaDueAt ?? null)}</td>
                                <td className="p-3 text-slate-300">{STATUS_LABEL[row.status]}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {remaining > 0 && (
                      <div className="px-4 py-3 border-t border-slate-800">
                        <button type="button" onClick={() => showMore(g.key, g.items.length)} className={SMALL_BUTTON}>
                          {showMoreText(remaining, POAM_GROUP_PAGE)}
                        </button>
                      </div>
                    )}
                  </PoamGroupPanel>
                );
              })}
            </div>
          )}
        </>
      )}

      {data.rules.isVmTarget && data.upcomingTotal > 0 && (
        <PoamGroupPanel
          title={VM_POAM_COPY.upcomingToggle(data.upcomingTotal)}
          countText={data.upcoming.length < data.upcomingTotal ? VM_POAM_COPY.upcomingCap(data.upcoming.length, data.upcomingTotal) : ''}
          expanded={upcomingOpen}
          onToggle={() => setUpcomingOpen((v) => !v)}
          toggleRef={(el) => { upcomingToggleRef.current = el; }}
        >
          <p className="px-4 pt-3 text-xs text-slate-400">{VM_POAM_COPY.upcomingNote}</p>
          <div className={tableWrap} tabIndex={0} role="region" aria-label={VM_POAM_COPY.upcomingCaption}>
            <table className="w-full min-w-[560px] lg:min-w-0 text-left text-xs">
              <caption className="sr-only">{VM_POAM_COPY.upcomingCaption}</caption>
              <thead className={headClass}>
                <tr>
                  <th scope="col" className="p-3">Vulnerability</th>
                  <th scope="col" className="p-3">Severity</th>
                  <th scope="col" className="p-3">Asset</th>
                  <th scope="col" className="p-3">Deadline</th>
                  <th scope="col" className="p-3">Time Left</th>
                  <th scope="col" className="p-3 hidden md:table-cell">Affected Packages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {data.upcoming.slice(0, upcomingShown).map((u) => (
                  <tr key={u.findingId} className="hover:bg-slate-850/50">
                    <th scope="row" className="p-3 text-left font-normal">
                      <span className="font-mono text-white">{u.vulnId}</span>
                      {u.kev && <Badge tone="rose" pill={false} className="ml-1.5" title={VM_POAM_COPY.kevTitle}>KEV</Badge>}
                    </th>
                    <td className="p-3"><SeverityBadge severity={u.severity} /></td>
                    <td className="p-3 text-slate-300">{u.assetName}</td>
                    <td className="p-3 font-mono text-slate-300">{isoDate(u.slaDueAt)}</td>
                    <td className="p-3 text-slate-300">{daysRemainingText(u.daysRemaining)}</td>
                    <td className="p-3 text-slate-300 hidden md:table-cell"><PackageLines f={u} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.upcoming.length > upcomingShown && (
            <div className="px-4 py-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => {
                  const next = upcomingShown + POAM_GROUP_PAGE;
                  setUpcomingShown(next);
                  if (next >= data.upcoming.length) requestAnimationFrame(() => upcomingToggleRef.current?.focus());
                }}
                className={SMALL_BUTTON}
              >
                {showMoreText(data.upcoming.length - upcomingShown, POAM_GROUP_PAGE)}
              </button>
            </div>
          )}
        </PoamGroupPanel>
      )}
    </div>
  );
};