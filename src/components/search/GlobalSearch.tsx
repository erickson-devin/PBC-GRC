import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Boxes, Building2, ClipboardList, FileText, ListChecks, Paperclip, Search, Server, ShieldCheck, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAssessment, type PendingFocusKind } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useGlobalSearch } from '../../hooks/useGlobalSearch';
import { requestDocumentFocus } from '../documents/documentFocus';
import { isSearchShortcut } from '../../data/search/searchShortcut';
import { searchNavPlan } from '../../data/search/searchNav';
import {
  KIND_LABELS,
  fieldLabel,
  flattenOptions,
  groupCountText,
  nextActive,
  searchAnnouncement,
  searchErrorMessage,
  shortcutHint,
  splitHighlight,
  type FlatOption,
} from '../../data/search/searchUiView';
import { SEARCH_MIN, type SearchKind, type SearchNav, type SearchResponse } from '../../types/search';

const KIND_ICON: Record<SearchKind, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  control: ShieldCheck,
  objective: ListChecks,
  evidence: Paperclip,
  asset: Server,
  poam_control: ClipboardList,
  poam_vm: ClipboardList,
  tool: Boxes,
  vendor: Building2,
  document: FileText,
};

const RETRY_CLASS = 'mt-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

/** The text with the query marked, as React elements: a title is never turned into HTML. */
const Highlighted: React.FC<{ text: string; q: string }> = ({ text, q }) => {
  const s = splitHighlight(text, q);
  if (!s) return <>{text}</>;
  return <>{s.before}<mark className="rounded bg-cyan-500/25 px-0.5 text-cyan-100">{s.match}</mark>{s.after}</>;
};

export interface SearchResultsListProps {
  /** Only the groups that have results. */
  groups: SearchResponse['groups'];
  /** flattenOptions(groups, idPrefix). */
  flat: FlatOption[];
  active: number;
  q: string;
  idPrefix: string;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}

/**
 * The results, grouped by kind, as a listbox: the focus stays in the search box and `active` is the option it points at (aria-activedescendant). Every
 * result, snippet and title is a React text node; the match is marked with <mark>. Props only, so a test can render it.
 */
export const SearchResultsList: React.FC<SearchResultsListProps> = ({ groups, flat, active, q, idPrefix, onHover, onPick }) => {
  let offset = 0;
  return (
    <div id={`${idPrefix}-list`} role="listbox" aria-label="Search results" className="space-y-3">
      {groups.map((g) => {
        const base = offset;
        const moreIdx = base + g.results.length;
        offset += g.results.length + (g.truncated ? 1 : 0);
        const Icon = KIND_ICON[g.kind];
        return (
          <div key={g.kind} role="group" aria-labelledby={`${idPrefix}-h-${g.kind}`}>
            <div id={`${idPrefix}-h-${g.kind}`} className="flex justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <span>{KIND_LABELS[g.kind]}</span>
              <span className="normal-case font-medium">{groupCountText(g.results.length, null, g.truncated)}</span>
            </div>
            {g.results.map((r, i) => {
              const o = base + i;
              return (
                <div
                  key={r.id}
                  id={flat[o]?.id}
                  role="option"
                  aria-selected={active === o}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => onHover(o)}
                  onClick={() => onPick(o)}
                  className={`flex items-start gap-3 rounded-xl px-3 py-2 cursor-pointer ${active === o ? 'bg-cyan-500/10 ring-1 ring-cyan-500/40' : 'hover:bg-slate-800/70'}`}
                >
                  <Icon className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-white break-words [overflow-wrap:anywhere]"><Highlighted text={r.title} q={q} /></span>
                      {r.subtitle && <span className="text-xs font-mono text-slate-400 break-words [overflow-wrap:anywhere]">{r.subtitle}</span>}
                      {r.inProgram === false && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-600 text-slate-300">Not in this program</span>}
                    </div>
                    {r.snippet && (
                      <p className="mt-0.5 text-xs text-slate-300 break-words [overflow-wrap:anywhere]">
                        <span className="text-slate-500">{fieldLabel(r.field)}: </span>
                        {r.snippet.before}<mark className="rounded bg-cyan-500/25 px-0.5 text-cyan-100">{r.snippet.match}</mark>{r.snippet.after}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {g.truncated && (
              <div
                id={flat[moreIdx]?.id}
                role="option"
                aria-selected={active === moreIdx}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => onHover(moreIdx)}
                onClick={() => onPick(moreIdx)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ${active === moreIdx ? 'bg-cyan-500/10 text-cyan-200 ring-1 ring-cyan-500/40' : 'text-cyan-300 hover:bg-slate-800/70'}`}
              >
                Show more {KIND_LABELS[g.kind].toLowerCase()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Global search (#254): the header button, the "/" and Ctrl+K / Cmd+K shortcuts, and the dialog. The query and the results live in React state only and are
 * dropped when the dialog closes: nothing is stored, put in the URL, logged or sent to the audit ledger.
 */
export const GlobalSearch: React.FC = () => {
  const { setActiveTab, setSelectedControlId, openControlAtObjective, setPreviewEvidence, requestFocus, state } = useAssessment();
  const { currentTenant, activeProgram } = useTenant();
  const { status, response, error, search, loadMore, clear } = useGlobalSearch();
  const uid = useId();
  const inputId = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const idPrefix = `${uid}-r`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const keepActive = useRef(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(-1);

  const serverBacked = Boolean(currentTenant.serverBacked);
  const programName = activeProgram?.name ?? 'this program';
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';

  // "/" (when no field has the focus) and Ctrl+K / Cmd+K open the search, unless another dialog is already open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented, target: e.target as HTMLElement | null })) return;
      if (document.querySelector('[data-dialog-overlay]')) return; // another dialog is open: never stack over it
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const groups = useMemo(() => (response ? response.groups.filter((g) => g.results.length > 0) : []), [response]);
  const flat = useMemo(() => flattenOptions(groups, idPrefix), [groups, idPrefix]);
  const count = useMemo(() => groups.reduce((n, g) => n + g.results.length, 0), [groups]);

  // Each new answer starts on its first option (a "Show more" keeps the place)
  useEffect(() => {
    if (keepActive.current) {
      keepActive.current = false;
      setActive((a) => Math.min(a, flat.length - 1));
    } else setActive(flat.length > 0 ? 0 : -1);
  }, [flat]);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    clear();
  }, [clear]);

  // A tab with no dialog of its own: the list row takes the focus from the screen it lands on
  const go = (nav: SearchNav) => {
    const plan = searchNavPlan(nav);
    let opensDialog = false;
    if (plan.openObjective) {
      setActiveTab(plan.tab);
      openControlAtObjective(plan.openObjective.controlId, plan.openObjective.objectiveId);
      opensDialog = true;
    } else if (plan.selectControlId) {
      setActiveTab(plan.tab);
      setSelectedControlId(plan.selectControlId);
      opensDialog = true;
    } else if (plan.previewEvidenceId) {
      setActiveTab(plan.tab);
      const item = state.evidenceIndex.find((e) => e.id === plan.previewEvidenceId);
      if (item) {
        setPreviewEvidence(item);
        opensDialog = true;
      }
    } else if (plan.pendingFocus) {
      if (plan.pendingFocus.kind === 'document') {
        requestDocumentFocus(plan.pendingFocus.id);
        setActiveTab(plan.tab);
      } else {
        requestFocus(plan.pendingFocus.kind as PendingFocusKind, plan.pendingFocus.id, plan.tab);
      }
    } else setActiveTab(plan.tab);
    if (!opensDialog) document.getElementById('app-main')?.focus({ preventScroll: true });
  };

  const pick = (index: number) => {
    const o = flat[index];
    if (!o) return;
    if (o.result === null) {
      keepActive.current = true;
      loadMore(o.kind);
      return;
    }
    // Close first so focus returns to where it was; a dialog the result opens next then captures that element, not this search box
    const nav = o.result.nav;
    close();
    window.setTimeout(() => go(nav), 0);
  };

  const moveTo = (n: number) => {
    setActive(n);
    const id = flat[n]?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      moveTo(nextActive(e.key, active, flat));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    }
  };

  const onChange = (value: string) => {
    setQ(value);
    search(value);
  };

  const tooShort = q.trim().length < SEARCH_MIN;
  const hasInput = serverBacked && Boolean(activeProgram);
  const loading = status === 'loading';

  let body: React.ReactNode;
  if (!serverBacked) {
    body = (
      <div className="px-3 py-6 text-center">
        <p className="text-xs text-slate-300">Search needs a server-backed organization: this organization's data is kept in this browser only.</p>
        <button
          type="button"
          onClick={() => { close(); setActiveTab('matrix'); }}
          className="mt-3 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          Filter the control matrix instead
        </button>
      </div>
    );
  } else if (!activeProgram) {
    body = <p className="px-3 py-6 text-center text-xs text-slate-400">Open a program to search it.</p>;
  } else if (tooShort) {
    body = <p className="px-3 py-6 text-center text-xs text-slate-400">Type at least {SEARCH_MIN} characters to search {programName}.</p>;
  } else if (status === 'error' && !response) {
    body = (
      <div className="px-3 py-4">
        <ErrorNotice message={searchErrorMessage(error)} />
        {error !== 'invalid' && <button type="button" onClick={() => search(q)} className={RETRY_CLASS}>Try again</button>}
      </div>
    );
  } else if (!response || (loading && count === 0)) {
    body = status === 'idle' && !response
      ? <p className="px-3 py-6 text-center text-xs text-slate-400">{searchErrorMessage('invalid')}</p>
      : <p className="px-3 py-6 text-center text-xs text-slate-400">Searching…</p>;
  } else if (count === 0) {
    body = (
      <div className="px-3 py-6 text-center space-y-1">
        <p className="text-xs text-slate-300">No matches in this program.</p>
        <p className="text-[11px] text-slate-500">Search matches part of a word or a phrase, ignoring case. Control ids such as AC.L2-3.1.1 work too.</p>
      </div>
    );
  } else {
    body = (
      <div className={loading ? 'opacity-60' : undefined}>
        {status === 'error' && (
          <div className="px-2 pb-2">
            <ErrorNotice message={searchErrorMessage(error)} />
          </div>
        )}
        <SearchResultsList groups={groups} flat={flat} active={active} q={q} idPrefix={idPrefix} onHover={setActive} onPick={pick} />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Search this program"
        aria-keyshortcuts="/ Control+K Meta+K"
        title={`Search this program (/ or ${shortcutHint(platform)})`}
        className="flex items-center gap-2 p-2 xl:pl-2.5 xl:pr-1.5 xl:py-1.5 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        <Search className="w-4 h-4" aria-hidden="true" />
        <span className="hidden xl:inline">Search</span>
        <kbd aria-hidden="true" className="hidden xl:inline-flex items-center px-1.5 py-0.5 rounded-md border border-slate-600 bg-slate-900 font-mono text-[10px] text-slate-400">{shortcutHint(platform)}</kbd>
      </button>

      {open && (
        <DialogOverlay onClose={close} onClick={close} className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/80 backdrop-blur-sm p-2 sm:p-4 sm:pt-[10vh] animate-fadeIn">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[90vh] sm:max-h-[75vh] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800">
              <DialogTitle as="h2" className={hasInput ? 'sr-only' : 'text-sm font-bold text-white flex-1'}>Search {programName}</DialogTitle>
              {hasInput && (
                <>
                  <Search className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                  <label htmlFor={inputId} className="sr-only">Search {programName}</label>
                  <input
                    id={inputId}
                    autoFocus
                    type="search"
                    role="combobox"
                    aria-expanded={flat.length > 0}
                    aria-controls={flat.length > 0 ? `${idPrefix}-list` : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={active >= 0 ? flat[active]?.id : undefined}
                    aria-describedby={hintId}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={100}
                    value={q}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={onInputKey}
                    placeholder="Controls, evidence, assets, POA&M…"
                    className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
                  />
                </>
              )}
              <button
                type="button"
                autoFocus={!hasInput}
                onClick={close}
                aria-label="Close search"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            {hasInput && (
              <p id={hintId} className="px-4 pt-2 text-[11px] text-slate-400">
                Searches {programName}: controls, objectives, evidence file names, assets, POA&amp;M items, tools, vendors and documents. Searches are not saved. Up and Down move through results, Enter opens one, Escape closes.
              </p>
            )}
            <div className="flex-1 overflow-y-auto px-2 py-2" aria-busy={loading || undefined}>{body}</div>
            {hasInput && (
              <div aria-hidden="true" className="hidden sm:flex gap-3 px-4 py-2 border-t border-slate-800 text-[11px] text-slate-500">
                <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
                <span><kbd>Enter</kbd> open</span>
                <span><kbd>Esc</kbd> close</span>
              </div>
            )}
            <p role="status" aria-live="polite" className="sr-only">
              {hasInput && q.trim() !== '' ? searchAnnouncement({ tooShort: q.trim().length > 0 && tooShort, loading, error: status === 'error', count, groups: groups.length }) : ''}
            </p>
          </div>
        </DialogOverlay>
      )}
    </>
  );
};
