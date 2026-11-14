import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, Info, Loader2, Pencil, Search, ShieldAlert } from 'lucide-react';
import { Badge } from '../common/Badge';
import { ErrorNotice } from '../common/ErrorNotice';
import { POAM_GROUP_PAGE, groupOpen, initialExpanded, poamQueryTerms, showMoreText } from '../../data/reports/poamView';
import {
  VM_POAM_COPY,
  VM_UPCOMING_DEFAULT_OPEN,
  daysRemainingText,
  filterVmPoamRows,
  groupVmPoamByAsset,
  isOpenVmPoamStatus,
  isoDate,
  vmClosedCount,
  vmClosedToggleText,
  vmGroupCountText,
  vmItemsEmptyText,
  vmPackagesView,
  vmPastTargetDate,
  vmPoamNotices,
  vmResultsText,
  vmRulesText,
  vmWeaknessIds,
  type VmPoamLoad,
} from '../../data/reports/vmPoamView';
import { vmPoamItemLabel, vmPoamSavedText, vmPoamStatusMarker } from '../../data/reports/vmPoamItemForm';
import type { VmPoamItemApi } from '../../hooks/useVmPoam';
import { SEVERITY_BADGE, SEVERITY_LABEL, fixText, moreText, packageLabel } from '../../data/telemetry/vmFindingsView';
import type { VmAffectedPackage, VmPoamResponse, VmPoamRow, VmSeverity } from '../../types/vm';
import { PoamGroupPanel, SMALL_BUTTON } from './PoamGroupPanel';
import { VmPoamItemDialog } from './VmPoamItemDialog';
import { VmPoamStatusBadge } from './VmPoamStatusBadge';

export interface PoamVulnerabilitiesSectionProps {
  load: VmPoamLoad;
  onRetry: () => void;
  framework: string;
  targetProgramName: string | null;
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** Tenant Owner and MSP Admin: the Edit button; other roles get View. */
  canEdit?: boolean;
  /** Without it the rows have no Edit / View button. */
  itemApi?: VmPoamItemApi;
  includeClosed?: boolean;
  onIncludeClosedChange?: (on: boolean) => void;
  /** A quiet reload is running. */
  refreshing?: boolean;
  /** The last quiet reload failed. */
  refreshFailed?: boolean;
  onRefresh?: () => void;
  /** Called with the saved row after a change was saved. */
  onItemSaved?: (row: VmPoamRow) => void;
  /** Opens the Programs page (where the vulnerability target is chosen). */
  onOpenPrograms?: () => void;
}

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
export const PoamVulnerabilitiesSection: React.FC<PoamVulnerabilitiesSectionProps> = ({
  load, onRetry, framework, targetProgramName, headingRef, canEdit = false, itemApi, includeClosed = false, onIncludeClosedChange,
  refreshing = false, refreshFailed = false, onRefresh, onItemSaved, onOpenPrograms,
}) => {
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
      {load.status === 'ready' && (
        <PoamVulnerabilitiesReady
          data={load.data}
          framework={framework}
          targetProgramName={targetProgramName}
          headingId={headingId}
          canEdit={canEdit}
          itemApi={itemApi}
          includeClosed={includeClosed}
          onIncludeClosedChange={onIncludeClosedChange}
          refreshing={refreshing}
          refreshFailed={refreshFailed}
          onRefresh={onRefresh}
          onItemSaved={onItemSaved}
          onOpenPrograms={onOpenPrograms}
        />
      )}
    </section>
  );
};

type ReadyProps = Pick<PoamVulnerabilitiesSectionProps, 'framework' | 'targetProgramName' | 'itemApi' | 'onIncludeClosedChange' | 'onRefresh' | 'onItemSaved' | 'onOpenPrograms'> & {
  data: VmPoamResponse;
  headingId: string;
  canEdit: boolean;
  includeClosed: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
};

const PoamVulnerabilitiesReady: React.FC<ReadyProps> = ({
  data, framework, targetProgramName, headingId, canEdit, itemApi, includeClosed, onIncludeClosedChange, refreshing, refreshFailed, onRefresh, onItemSaved, onOpenPrograms,
}) => {
  const uid = useId();
  const searchId = `${uid}-search`;
  const closedId = `${uid}-closed`;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const [upcomingOpen, setUpcomingOpen] = useState<boolean>(VM_UPCOMING_DEFAULT_OPEN);
  const [upcomingShown, setUpcomingShown] = useState<number>(POAM_GROUP_PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const upcomingToggleRef = useRef<HTMLButtonElement | null>(null);
  const [openItem, setOpenItem] = useState<{ row: VmPoamRow; weaknessId: string | null; groupKey: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterClose = useRef<{ rowId: string; groupKey: string } | null>(null);
  const closedTotal = vmClosedCount(data);
  const openShown = useMemo(() => data.items.filter((r) => isOpenVmPoamStatus(r.status)).length, [data.items]);

  const notices = useMemo(() => vmPoamNotices(data, { framework, targetProgramName, includeClosed }), [data, framework, targetProgramName, includeClosed]);
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

  const closeItem = (saved?: { before: VmPoamRow; after: VmPoamRow; changed: boolean }) => {
    if (!openItem) return;
    focusAfterClose.current = { rowId: openItem.row.id, groupKey: openItem.groupKey };
    setOpenItem(null);
    if (saved) {
      if (saved.changed) onItemSaved?.(saved.after);
      setAnnouncement(vmPoamSavedText(saved.before, saved.after, saved.changed, includeClosed));
    }
  };
  // After the commit that removed the dialog (and maybe the row): the row's button, else its group's toggle, else the section heading
  useEffect(() => {
    const f = focusAfterClose.current;
    if (!f || openItem) return;
    focusAfterClose.current = null;
    requestAnimationFrame(() => {
      const btn = itemButtonRefs.current.get(f.rowId);
      if (btn?.isConnected) { btn.focus(); return; }
      const toggle = toggleRefs.current.get(f.groupKey);
      if (toggle?.isConnected) { toggle.focus(); return; }
      document.getElementById(headingId)?.focus();
    });
  }, [openItem, data.items, headingId]);

  const tableWrap = 'overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';
  const headClass = 'bg-slate-950 text-slate-400 uppercase text-xs tracking-wider border-b border-slate-800';

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400 leading-relaxed">{vmRulesText(data.rules, framework)}</p>
      <p className="text-xs text-slate-400 leading-relaxed">{VM_POAM_COPY.exportFields}</p>
      {notices.map((n) => (
        <p
          key={n.id}
          role="note"
          className={n.tone === 'amber'
            ? 'flex flex-wrap items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200'
            : 'flex flex-wrap items-start gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300'}
        >
          {n.tone === 'amber'
            ? <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />
            : <Info className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />}
          <span className="flex-1">{n.text}</span>
          {n.action === 'open_programs' && onOpenPrograms && (
            <button type="button" onClick={onOpenPrograms} className={`${SMALL_BUTTON} shrink-0`}>{VM_POAM_COPY.openPrograms}</button>
          )}
        </p>
      ))}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {refreshFailed && (
        <div className="space-y-2">
          <ErrorNotice message={VM_POAM_COPY.refreshFailed} />
          <button type="button" onClick={onRefresh} className={SMALL_BUTTON}>{VM_POAM_COPY.retry}</button>
        </div>
      )}
      {(closedTotal > 0 || includeClosed) && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label htmlFor={closedId} className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              id={closedId}
              type="checkbox"
              checked={includeClosed}
              disabled={!onIncludeClosedChange}
              onChange={(e) => onIncludeClosedChange?.(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {vmClosedToggleText(closedTotal)}
          </label>
          <p role="status" aria-live="polite" className="text-xs text-slate-400 flex items-center gap-2">
            {refreshing && (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {includeClosed ? VM_POAM_COPY.closedLoading : VM_POAM_COPY.loading}
              </>
            )}
          </p>
        </div>
      )}

      {openShown === 0 && (
        <p className="p-6 text-center rounded-2xl bg-slate-900/60 border border-slate-800 text-sm text-slate-300">{vmItemsEmptyText(data, { includeClosed })}</p>
      )}
      {data.items.length > 0 && (
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
                    countText={vmGroupCountText(g)}
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
                      <table className="w-full min-w-[720px] lg:min-w-0 text-left text-xs">
                        <caption className="sr-only">{caption}</caption>
                        <thead className={headClass}>
                          <tr>
                            <th scope="col" className="p-3">Weakness ID</th>
                            <th scope="col" className="p-3">Vulnerability</th>
                            <th scope="col" className="p-3">Severity</th>
                            <th scope="col" className="p-3 hidden md:table-cell">Affected Packages</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">First Seen</th>
                            <th scope="col" className="p-3">Deadline</th>
                            <th scope="col" className="p-3">Target Date</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">Owner</th>
                            <th scope="col" className="p-3">Status</th>
                            {itemApi && <th scope="col" className="p-3"><span className="sr-only">Actions</span></th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {rows.map((row) => {
                            const f = row.finding;
                            const closed = !isOpenVmPoamStatus(row.status);
                            const wid = ids.get(row.id) ?? null;
                            const marker = vmPoamStatusMarker(row);
                            return (
                              <tr key={row.id} className={`hover:bg-slate-850/50${closed ? ' bg-slate-950/40' : ''}`}>
                                <th scope="row" className="p-3 font-mono font-bold text-amber-300 whitespace-nowrap text-left">
                                  {wid ?? <span className="font-sans font-normal text-slate-400">{VM_POAM_COPY.notInExports}</span>}
                                </th>
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
                                <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{row.scheduledCompletion ?? 'None'}</td>
                                <td className="p-3 text-slate-300 hidden lg:table-cell max-w-[10rem] break-words">{row.owner.trim() ? row.owner : <span className="text-slate-400">Not recorded</span>}</td>
                                <td className="p-3 text-slate-300">
                                  <VmPoamStatusBadge status={row.status} />
                                  {marker && <p className="mt-1 text-slate-400">{marker}</p>}
                                  {vmPastTargetDate(row, data.generatedAt) && (
                                    <p className="mt-1 text-amber-300 flex items-center gap-1"><AlertTriangle className="w-3 h-3" aria-hidden="true" />Past target date</p>
                                  )}
                                  <p className="mt-1 text-slate-400 lg:hidden break-words">Owner: {row.owner.trim() || 'Not recorded'}</p>
                                </td>
                                {itemApi && (
                                  <td className="p-3 text-right">
                                    <button
                                      type="button"
                                      ref={(el) => { if (el) itemButtonRefs.current.set(row.id, el); else itemButtonRefs.current.delete(row.id); }}
                                      onClick={() => setOpenItem({ row, weaknessId: wid, groupKey: g.key })}
                                      aria-label={`${canEdit ? 'Edit' : 'View'} ${vmPoamItemLabel(row, wid)}`}
                                      className={`${SMALL_BUTTON} inline-flex items-center gap-1.5`}
                                    >
                                      {canEdit ? <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
                                      <span>{canEdit ? 'Edit' : 'View'}</span>
                                    </button>
                                  </td>
                                )}
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

      {openItem && itemApi && (
        <VmPoamItemDialog row={openItem.row} weaknessId={openItem.weaknessId} canEdit={canEdit} includeClosed={includeClosed} api={itemApi} onClose={closeItem} />
      )}
    </div>
  );
};