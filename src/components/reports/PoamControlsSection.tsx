import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Eye, Filter, Info, ListChecks, Loader2, Pencil, Search } from 'lucide-react';
import { FRAMEWORK_REGISTRY } from '../../data/frameworks';
import type { FrameworkControlDefinition } from '../../types/framework';
import type { POAMEntry } from '../../types/report';
import {
  POAM_COPY,
  POAM_GROUP_PAGE,
  POAM_STATUS_BADGE,
  POAM_STATUS_LABEL,
  POAM_STATUS_ORDER,
  defaultPoamStatuses,
  filterPoamEntries,
  groupOpen,
  groupPoamByFamily,
  initialExpanded,
  poamQueryTerms,
  poamResultsText,
  poamStatusCounts,
  poamStatusKey,
  showMoreText,
  type PoamStatusKey,
} from '../../data/reports/poamView';
import { poamEmptyState, type VmPoamLoad } from '../../data/reports/vmPoamView';
import type { UseControlPoam } from '../../hooks/useControlPoam';
import type { ControlPoamRecord } from '../../types/controlPoam';
import { controlPoamMap } from '../../data/reports/controlPoamView';
import { CONTROL_POAM_COPY, controlPoamItemLabel, controlPoamLoadNotice, controlPoamSavedText, poamDateWarnings, todayIso } from '../../data/reports/controlPoamForm';
import { milestoneProgressText } from '../../data/reports/poamMilestoneForm';
import { ErrorNotice } from '../common/ErrorNotice';
import { ControlPoamDialog } from './ControlPoamDialog';
import { CHIP_OFF, CHIP_ON, PoamGroupPanel, SMALL_BUTTON } from './PoamGroupPanel';

export interface PoamControlsSectionProps {
  entries: readonly POAMEntry[];
  framework: string;
  controls: readonly Pick<FrameworkControlDefinition, 'id' | 'domain' | 'domainName'>[];
  vmLoad: VmPoamLoad;
  /** Opens a control (by its stored id) in the control view. The control id is plain text without it. */
  onOpenControl?: (controlId: string) => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** The recorded POA&M fields of the controls (#304). Without it the rows have no Edit / View button and no notice. */
  controlPoam?: Pick<UseControlPoam, 'load' | 'reload' | 'applySaved' | 'api'>;
  /** The write roles (Tenant Owner, Admin, MSP Admin): the Edit button; other roles get View. */
  canEdit?: boolean;
}

const NOTE_CLASS = 'rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400';

/**
 * The controls half of the POA&M screen (#278): search, status chips and collapsible family groups over the entries it is given.
 * Filtering is a view only: the exports always list every entry. Props only, state in React only (nothing typed is stored or logged).
 */
export const PoamControlsSection: React.FC<PoamControlsSectionProps> = ({ entries, framework, controls, vmLoad, onOpenControl, headingRef, controlPoam, canEdit = false }) => {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const searchId = `${uid}-search`;
  const statusLabelId = `${uid}-status`;

  const [statuses, setStatuses] = useState<Set<PoamStatusKey> | null>(null); // null: the default
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const firstChipRef = useRef<HTMLButtonElement>(null);
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const [openEntry, setOpenEntry] = useState<{ entry: POAMEntry; groupCode: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterClose = useRef<{ controlId: string; groupCode: string } | null>(null);

  const defaults = useMemo(() => defaultPoamStatuses(entries), [entries]);
  const effective = statuses ?? defaults;
  const counts = useMemo(() => poamStatusCounts(entries), [entries]);
  const visible = useMemo(() => filterPoamEntries(entries, effective, query), [entries, effective, query]);
  const groups = useMemo(() => {
    const domains = (FRAMEWORK_REGISTRY[framework] ?? FRAMEWORK_REGISTRY.CMMC_L1).domains ?? {};
    return groupPoamByFamily(visible, entries, controls, domains);
  }, [visible, entries, controls, framework]);
  const initial = useMemo(() => initialExpanded(groups.map((g) => g.code)), [groups]);
  const searching = poamQueryTerms(query).length > 0;
  const vmCount = vmLoad.status === 'ready' ? vmLoad.data.openItemsTotal : null;
  const poamLoad = controlPoam?.load ?? null;
  const notice = poamLoad ? controlPoamLoadNotice(poamLoad) : null;
  // The Edit / View column exists for a server-backed organization with a program; the buttons work once the stored fields are loaded
  const editColumn = poamLoad !== null && poamLoad.status !== 'unsupported' && poamLoad.status !== 'no_program' && poamLoad.status !== 'idle';
  const recorded = useMemo(() => (poamLoad?.status === 'ready' ? controlPoamMap(poamLoad.entries) : {}), [poamLoad]);
  const today = todayIso();

  const toggleStatus = (key: PoamStatusKey) => {
    const next = new Set(effective);
    if (next.has(key)) next.delete(key); else next.add(key);
    setStatuses(next);
    setShown({});
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    setShown({});
    setSearchCollapsed(new Set());
  };
  const clearSearch = () => {
    changeQuery('');
    searchRef.current?.focus();
  };
  const showAllStatuses = () => {
    setStatuses(new Set(POAM_STATUS_ORDER));
    setShown({});
    requestAnimationFrame(() => firstChipRef.current?.focus());
  };
  const flip = (set: ReadonlySet<string>, code: string): Set<string> => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  };
  const toggleGroup = (code: string) => {
    if (searching) setSearchCollapsed((prev) => flip(prev, code));
    else setExpanded(flip(expanded ?? initial, code));
  };
  const expandAll = () => {
    if (searching) setSearchCollapsed(new Set());
    else setExpanded(new Set(groups.map((g) => g.code)));
  };
  const collapseAll = () => {
    if (searching) setSearchCollapsed(new Set(groups.map((g) => g.code)));
    else setExpanded(new Set());
  };
  const showMore = (code: string, total: number) => {
    const next = (shown[code] ?? POAM_GROUP_PAGE) + POAM_GROUP_PAGE;
    setShown((prev) => ({ ...prev, [code]: next }));
    // The button disappears with the last rows: focus moves to the group header instead of being lost
    if (next >= total) requestAnimationFrame(() => toggleRefs.current.get(code)?.focus());
  };

  const closeEntry = (saved?: { entry: ControlPoamRecord | null; changed: boolean }) => {
    if (!openEntry) return;
    focusAfterClose.current = { controlId: openEntry.entry.controlId, groupCode: openEntry.groupCode };
    const shownId = openEntry.entry.controlDisplayId ?? openEntry.entry.controlId;
    setOpenEntry(null);
    if (saved) {
      controlPoam?.applySaved(saved.changed ? saved.entry : null);
      setAnnouncement(controlPoamSavedText(shownId, saved.changed));
    }
  };
  // After the commit that removed the dialog (and maybe the row): the row's button, else its group's toggle, else the section heading
  useEffect(() => {
    const f = focusAfterClose.current;
    if (!f || openEntry) return;
    focusAfterClose.current = null;
    requestAnimationFrame(() => {
      const btn = itemButtonRefs.current.get(f.controlId);
      if (btn?.isConnected) { btn.focus(); return; }
      const toggle = toggleRefs.current.get(f.groupCode);
      if (toggle?.isConnected) { toggle.focus(); return; }
      document.getElementById(headingId)?.focus();
    });
  }, [openEntry, entries, headingId]);

  const empty = controls.length === 0 ? null : poamEmptyState(entries.length, vmLoad);

  const renderEmptyCard = (tone: 'clear' | 'partial', title: string, body: string) => (
    <div className="p-10 text-center rounded-3xl bg-slate-900/60 border border-slate-800 space-y-3">
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto ${tone === 'clear' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-300'}`}>
        {tone === 'clear' ? <CheckCircle2 className="w-6 h-6" aria-hidden="true" /> : <Info className="w-6 h-6" aria-hidden="true" />}
      </div>
      <h4 className="text-base font-bold text-white">{title}</h4>
      <p className="text-xs text-slate-400 max-w-md mx-auto">{body}</p>
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <ListChecks className="w-4 h-4 text-amber-400" aria-hidden="true" />
        {POAM_COPY.controlsHeading}
      </h3>
      <p className="text-xs text-slate-400">{POAM_COPY.controlsIntro}</p>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {notice?.kind === 'loading' && (
        <p role="status" className={`${NOTE_CLASS} flex items-center gap-2`}>
          <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none shrink-0" aria-hidden="true" />
          {notice.text}
        </p>
      )}
      {notice?.kind === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message={notice.text} />
          <button type="button" onClick={() => { void controlPoam?.reload(); }} className={SMALL_BUTTON}>{CONTROL_POAM_COPY.retry}</button>
        </div>
      )}
      {(notice?.kind === 'unsupported' || notice?.kind === 'no_program') && <p role="note" className={NOTE_CLASS}>{notice.text}</p>}

      {controls.length === 0 ? (
        renderEmptyCard('partial', 'No control entries', POAM_COPY.noControls)
      ) : empty ? (
        renderEmptyCard(empty.tone, empty.title, empty.body)
      ) : (
        <>
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">{POAM_COPY.searchLabel}</label>
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                id={searchId}
                ref={searchRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
                placeholder={POAM_COPY.searchPlaceholder}
                className="w-full pl-10 pr-20 py-2.5 rounded-xl bg-slate-950/80 border border-slate-800 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 focus:outline-none text-xs sm:text-sm text-white placeholder-slate-400 transition-all duration-200"
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded bg-slate-800 transition-colors"
                >
                  {POAM_COPY.clear}
                </button>
              )}
            </div>
            <div role="group" aria-labelledby={statusLabelId} className="flex items-center gap-1.5 flex-wrap">
              <span id={statusLabelId} className="text-xs font-semibold text-slate-400 mr-1 flex items-center gap-1">
                <Filter className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                {POAM_COPY.statusGroupLabel}
              </span>
              {POAM_STATUS_ORDER.map((key, i) => {
                const on = effective.has(key);
                return (
                  <button
                    key={key}
                    type="button"
                    ref={i === 0 ? firstChipRef : undefined}
                    aria-pressed={on}
                    onClick={() => toggleStatus(key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${on ? CHIP_ON : CHIP_OFF}`}
                  >
                    {on && <Check className="w-3 h-3" aria-hidden="true" />}
                    {POAM_STATUS_LABEL[key]} ({counts[key]})
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap pt-3 border-t border-slate-800/80">
              <p role="status" aria-live="polite" className="text-xs text-slate-400">{poamResultsText(entries, visible, effective, query)}</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={expandAll} className={SMALL_BUTTON}>{POAM_COPY.expandAll}</button>
                <button type="button" onClick={collapseAll} className={SMALL_BUTTON}>{POAM_COPY.collapseAll}</button>
              </div>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="p-6 text-center rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
              <p className="text-sm text-slate-300">{searching ? POAM_COPY.noMatch : POAM_COPY.allHidden}</p>
              <button type="button" onClick={searching ? clearSearch : showAllStatuses} className={SMALL_BUTTON}>
                {searching ? POAM_COPY.clearSearch : POAM_COPY.showAllStatuses}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const rows = g.entries.slice(0, shown[g.code] ?? POAM_GROUP_PAGE);
                const remaining = g.entries.length - rows.length;
                const caption = POAM_COPY.groupCaption(g.code, g.name);
                return (
                  <PoamGroupPanel
                    key={g.code}
                    code={g.code}
                    title={g.name}
                    countText={POAM_COPY.groupCount(g.entries.length, g.total)}
                    expanded={groupOpen(g.code, { searching, expanded, searchCollapsed, initial })}
                    onToggle={() => toggleGroup(g.code)}
                    toggleRef={(el) => {
                      if (el) toggleRefs.current.set(g.code, el);
                      else toggleRefs.current.delete(g.code);
                    }}
                  >
                    <div className="overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400" tabIndex={0} role="region" aria-label={caption}>
                      <table className="w-full min-w-[560px] lg:min-w-0 text-left text-xs">
                        <caption className="sr-only">{caption}</caption>
                        <thead className="bg-slate-950 text-slate-400 uppercase text-xs tracking-wider border-b border-slate-800">
                          <tr>
                            <th scope="col" className="p-3">Weakness ID</th>
                            <th scope="col" className="p-3">Control</th>
                            <th scope="col" className="p-3">Deficiency Summary</th>
                            <th scope="col" className="p-3">Status</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">Target Date</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">Owner</th>
                            <th scope="col" className="p-3 hidden lg:table-cell">Resources</th>
                            {editColumn && <th scope="col" className="p-3"><span className="sr-only">Actions</span></th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {rows.map((entry) => {
                            const k = poamStatusKey(entry.status);
                            const shownId = entry.controlDisplayId ?? entry.controlId;
                            const idTitle = shownId !== entry.controlId ? `Stored as ${entry.controlId}` : undefined;
                            const warns = poamDateWarnings({ date: entry.scheduledCompletionDate, open: true, today });
                            const progress = milestoneProgressText(entry.milestones);
                            return (
                              <tr key={entry.controlId} className="hover:bg-slate-850/50">
                                <th scope="row" className="p-3 font-mono font-bold text-amber-300 whitespace-nowrap text-left">{entry.weaknessId}</th>
                                <td className="p-3">
                                  {onOpenControl ? (
                                    <button
                                      type="button"
                                      onClick={() => onOpenControl(entry.controlId)}
                                      title={idTitle ?? 'Open this control'}
                                      className="font-bold text-cyan-300 hover:underline text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                                    >
                                      {shownId}
                                    </button>
                                  ) : (
                                    <div className="font-bold text-white" title={idTitle}>{shownId}</div>
                                  )}
                                  <div className="text-xs text-slate-400 truncate max-w-[140px]">{entry.controlTitle}</div>
                                </td>
                                <td className="p-3 text-slate-300 max-w-md whitespace-pre-wrap break-words">
                                  {entry.weaknessDescription}
                                  {entry.controlId === 'RA.L2-3.11.3' && vmCount ? (
                                    <p className="mt-1 text-xs text-cyan-300">{POAM_COPY.crossRef(vmCount)}</p>
                                  ) : null}
                                  <p className="mt-1 text-slate-400 lg:hidden">
                                    Target date: {entry.scheduledCompletionDate}. Owner: {entry.responsibleRole}. Resources: {entry.requiredResources}.
                                  </p>
                                </td>
                                <td className="p-3">
                                  <span className={`badge px-2 py-0.5 rounded text-xs font-bold ${POAM_STATUS_BADGE[k]}`}>{POAM_STATUS_LABEL[k]}</span>
                                  {progress && <p className="mt-1 text-slate-400">{progress}</p>}
                                  {warns.map((w) => (
                                    <p key={w} className="mt-1 text-amber-300 flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />{w === 'far' ? CONTROL_POAM_COPY.farRowText : CONTROL_POAM_COPY.pastRowText}</p>
                                  ))}
                                </td>
                                <td className="p-3 font-mono text-slate-300 hidden lg:table-cell">{entry.scheduledCompletionDate}</td>
                                <td className="p-3 text-slate-300 hidden lg:table-cell">{entry.responsibleRole}</td>
                                <td className="p-3 text-slate-400 text-xs hidden lg:table-cell">{entry.requiredResources}</td>
                                {editColumn && (
                                  <td className="p-3 text-right">
                                    <button
                                      type="button"
                                      ref={(el) => { if (el) itemButtonRefs.current.set(entry.controlId, el); else itemButtonRefs.current.delete(entry.controlId); }}
                                      onClick={() => setOpenEntry({ entry, groupCode: g.code })}
                                      disabled={poamLoad?.status !== 'ready'}
                                      aria-label={`${canEdit ? 'Edit' : 'View'} ${controlPoamItemLabel(shownId)}`}
                                      className={`${SMALL_BUTTON} inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed`}
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
                        <button type="button" onClick={() => showMore(g.code, g.entries.length)} className={SMALL_BUTTON}>
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
      {openEntry && controlPoam && (
        <ControlPoamDialog
          key={openEntry.entry.controlId}
          entry={openEntry.entry}
          record={recorded[openEntry.entry.controlId] ?? null}
          controlStatus={entries.find((e) => e.controlId === openEntry.entry.controlId)?.status ?? 'MET'}
          canEdit={canEdit}
          api={controlPoam.api}
          onClose={closeEntry}
        />
      )}
    </section>
  );
};