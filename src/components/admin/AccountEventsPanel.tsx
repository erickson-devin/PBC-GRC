import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { History, RotateCw, X } from 'lucide-react';
import { ApiClient, ApiError } from '../../services/apiClient';
import type { AccountEvent, AccountEventFilter, LocalAccount } from '../../services/apiClient';
import type { Tenant } from '../../types/tenant';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  ACCOUNT_EVENTS_FILTERED_EMPTY, ACCOUNT_EVENTS_OLDER_ERROR, ACCOUNT_EVENTS_OLDEST, ACCOUNT_EVENTS_OLDEST_MATCHING, ACCOUNT_EVENTS_PAGE_SIZE,
  accountEventFilterActive, accountEventFilterSummary, accountEventRows, accountEventsErrorText, accountEventsLoadedText, accountFilterOptions, actionFilterOptions, formatEventTime,
} from '../../utils/accountEvents';

interface AccountEventsPanelProps {
  localUsers: LocalAccount[] | null;
  tenants: Tenant[];
  /** Changes after every account action, so the list reloads. */
  refreshKey: number;
  /** The account / event filter (#194); the console owns it so a History button on an account row can set it. */
  filter: AccountEventFilter;
  onFilterChange: (filter: AccountEventFilter) => void;
  /** Lets the console move focus to the heading after History. */
  headingRef?: React.Ref<HTMLHeadingElement>;
}

/** The read-only account-event trail for platform administrators (#40). Errors show fixed texts, never the server's message. */
export const AccountEventsPanel: React.FC<AccountEventsPanelProps> = ({ localUsers, tenants, refreshKey, filter, onFilterChange, headingRef }) => {
  const titleId = useId();
  const targetSelectRef = useRef<HTMLSelectElement>(null);
  const target = filter.target || null;
  const action = filter.action || null;
  const filtered = accountEventFilterActive(filter);
  const filterKey = `${target ?? ''}|${action ?? ''}`;
  const lastFilterKey = useRef(filterKey);
  const generation = useRef(0); // a newer load (refresh or filter change) makes an in-flight "Load older" stale
  const [events, setEvents] = useState<AccountEvent[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let cancelled = false;
    const gen = ++generation.current;
    if (lastFilterKey.current !== filterKey) { lastFilterKey.current = filterKey; setEvents(null); setNextBefore(null); }
    setError(null);
    setOlderError(null);
    setLoadingOlder(false);
    const current: AccountEventFilter = { target, action };
    ApiClient.listAccountEvents(ACCOUNT_EVENTS_PAGE_SIZE, undefined, current).then(
      (page) => {
        if (cancelled || gen !== generation.current) return;
        setEvents(page.events); setNextBefore(page.nextBefore);
        if (accountEventFilterActive(current)) setAnnouncement(accountEventsLoadedText(page.events.length, page.nextBefore !== null));
      },
      (err: unknown) => { if (!cancelled) setError(accountEventsErrorText(err instanceof ApiError ? err.status : -1, accountEventFilterActive(current))); }
    );
    return () => { cancelled = true; };
  }, [refreshKey, reloadKey, filterKey]);

  const loadOlder = async () => {
    if (!nextBefore || loadingOlder) return;
    const gen = generation.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await ApiClient.listAccountEvents(ACCOUNT_EVENTS_PAGE_SIZE, nextBefore, filter);
      if (gen !== generation.current) return;
      const have = new Set((events ?? []).map((e) => e.id));
      const fresh = page.events.filter((e) => !have.has(e.id));
      setEvents([...(events ?? []), ...fresh]);
      setNextBefore(page.nextBefore);
      setAnnouncement(`Loaded ${fresh.length} older event${fresh.length === 1 ? '' : 's'}.`);
    } catch {
      if (gen === generation.current) setOlderError(ACCOUNT_EVENTS_OLDER_ERROR);
    } finally {
      if (gen === generation.current) setLoadingOlder(false);
    }
  };

  const rows = useMemo(() => accountEventRows(events ?? [], localUsers ?? [], tenants), [events, localUsers, tenants]);
  const accountOptions = useMemo(() => accountFilterOptions(localUsers, target), [localUsers, target]);
  const setTarget = (value: string) => onFilterChange({ target: value || null, action });
  const setAction = (value: string) => onFilterChange({ target, action: value || null });
  const clearFilter = () => { onFilterChange({}); targetSelectRef.current?.focus(); }; // the button disables itself, so move focus first

  return (
    <section aria-labelledby={titleId} className="stitch-card p-6 space-y-4 scroll-mt-24">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-base font-bold text-white flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"><History className="w-4 h-4 text-cyan-400" aria-hidden="true" /><span>Account events</span></h2>
          <p className="text-xs text-slate-400 mt-1">Security changes to local accounts, newest first: passwords, two-step verification, enabling and disabling, tenant roles and sign-outs. Read-only; the server keeps them for the period set in <code className="text-cyan-300 font-mono">ACCOUNT_EVENT_RETENTION_DAYS</code>.</p>
        </div>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0"><RotateCw className="w-3.5 h-3.5" aria-hidden="true" /><span>Refresh</span></button>
      </div>
      <fieldset className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <legend className="sr-only">Filter account events</legend>
        <div className="flex-1 min-w-0">
          <label htmlFor={`${titleId}-target`} className="block text-xs font-semibold text-slate-300 mb-1">Account</label>
          <select id={`${titleId}-target`} ref={targetSelectRef} value={target ?? ''} onChange={(e) => setTarget(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400">
            {accountOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-0">
          <label htmlFor={`${titleId}-action`} className="block text-xs font-semibold text-slate-300 mb-1">Event</label>
          <select id={`${titleId}-action`} value={action ?? ''} onChange={(e) => setAction(e.target.value)} className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400">
            {actionFilterOptions(action).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button type="button" onClick={clearFilter} disabled={!filtered} className="btn-base btn-secondary px-3 py-1.5 text-xs shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"><X className="w-3.5 h-3.5" aria-hidden="true" /><span>Clear filter</span></button>
      </fieldset>
      {filtered && <p className="text-xs text-cyan-300">{accountEventFilterSummary(filter, localUsers ?? [])}</p>}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <ErrorNotice message={error} />
      {events === null && !error && <p role="status" className="text-xs text-slate-400">Loading account events…</p>}
      {events !== null && (
        <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{filtered ? 'Account events matching the filter, newest first' : 'Account events, newest first'}</caption>
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-xs tracking-wider border-b border-slate-800">
              <tr>
                <th scope="col" className="py-3 px-4">Time</th>
                <th scope="col" className="py-3 px-4">Event</th>
                <th scope="col" className="py-3 px-4">By</th>
                <th scope="col" className="py-3 px-4">Account</th>
                <th scope="col" className="py-3 px-4">Tenant</th>
                <th scope="col" className="py-3 px-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 font-sans">
              {rows.map((r) => (
                <tr key={r.key} className="even:bg-slate-950/40 odd:bg-slate-900/20 align-top">
                  <td className="py-3 px-4 text-slate-300 whitespace-nowrap"><time dateTime={r.at} title={r.at}>{formatEventTime(r.at)}</time></td>
                  <td className="py-3 px-4 text-slate-200 font-semibold">{r.action}</td>
                  <td className="py-3 px-4 font-mono text-slate-300 break-all">{r.actor}</td>
                  <td className="py-3 px-4 font-mono text-slate-200 break-all">{r.target}</td>
                  <td className="py-3 px-4 text-slate-300">{r.tenant}</td>
                  <td className="py-3 px-4">{r.details.length > 0 ? <ul className="space-y-0.5 font-mono text-slate-400">{r.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : <span className="text-slate-400">None</span>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="py-6 px-4 text-center text-slate-400">{filtered ? ACCOUNT_EVENTS_FILTERED_EMPTY : 'No account events have been recorded yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNotice message={olderError} />
      {events !== null && events.length > 0 && (nextBefore ? (
        <div className="flex justify-center"><button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} aria-busy={loadingOlder} className="btn-base btn-secondary px-4 py-1.5 text-xs disabled:opacity-50">{loadingOlder ? 'Loading…' : 'Load older'}</button></div>
      ) : <p className="text-center text-xs text-slate-400">{filtered ? ACCOUNT_EVENTS_OLDEST_MATCHING : ACCOUNT_EVENTS_OLDEST}</p>)}
    </section>
  );
};

export default AccountEventsPanel;
