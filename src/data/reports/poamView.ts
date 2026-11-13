import type { POAMEntry } from '../../types/report';
import type { FrameworkControlDefinition } from '../../types/framework';

/**
 * #278: the POA&M screen's controls view as pure functions: status filter, search and family groups over the entries it is
 * given. Entries are never regenerated on a subset (the weakness ids come from generatePOAMEntries over every control), and the
 * search runs in memory only. Results hold the same object references as the input; nothing here mutates its input.
 */

export type PoamStatusKey = 'NOT_MET' | 'IN_PROGRESS' | 'NOT_STARTED';
export const POAM_STATUS_ORDER: PoamStatusKey[] = ['NOT_MET', 'IN_PROGRESS', 'NOT_STARTED'];
export const POAM_STATUS_LABEL: Record<PoamStatusKey, string> = { NOT_MET: 'Not met', IN_PROGRESS: 'In progress', NOT_STARTED: 'Not started' };
export const POAM_STATUS_BADGE: Record<PoamStatusKey, string> = {
  NOT_MET: 'bg-rose-500/20 text-rose-300 border border-rose-500/30',
  IN_PROGRESS: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  NOT_STARTED: 'bg-slate-800 text-slate-300 border border-slate-700',
};
/** Rows shown per group before "Show more". */
export const POAM_GROUP_PAGE = 25;
/** Groups start expanded when a section has this many groups or fewer. */
export const POAM_GROUPS_OPEN_MAX = 3;

export const POAM_COPY = {
  controlsHeading: 'Controls',
  controlsIntro: 'One entry for each control not recorded as Met, grouped by family.',
  searchLabel: 'Search control entries',
  searchPlaceholder: 'Search by control ID, title, description or owner',
  statusGroupLabel: 'Show status:',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  clear: 'Clear',
  clearSearch: 'Clear search',
  showAllStatuses: 'Show all statuses',
  noMatch: 'No control entries match the search.',
  allHidden: 'Every control entry is hidden by the status filter.',
  noControls: 'No controls are loaded for this program, so there are no control entries.',
  groupCaption: (code: string, name: string) => `${code} ${name}: control POA&M entries`,
  groupCount: (shown: number, total: number) => shown === total ? `${total} ${total === 1 ? 'entry' : 'entries'}` : `${shown} of ${total} shown`,
  crossRef: (n: number) => `${n} vulnerability ${n === 1 ? 'item' : 'items'} for this requirement ${n === 1 ? 'is' : 'are'} listed under Vulnerabilities.`,
};

export interface PoamFamilyGroup {
  code: string;
  name: string;
  entries: POAMEntry[];
  /** Entries of this family in the full list, whatever the filters show. */
  total: number;
}

/** OPEN, DELAYED and anything unexpected count as Not met; only the two softer states keep their own key. */
export function poamStatusKey(s: POAMEntry['status']): PoamStatusKey {
  if (s === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (s === 'NOT_STARTED') return 'NOT_STARTED';
  return 'NOT_MET';
}

export function poamStatusCounts(entries: readonly POAMEntry[]): Record<PoamStatusKey, number> {
  const counts: Record<PoamStatusKey, number> = { NOT_MET: 0, IN_PROGRESS: 0, NOT_STARTED: 0 };
  for (const e of entries) counts[poamStatusKey(e.status)]++;
  return counts;
}

/** Not started is hidden by default only when something more pressing exists; otherwise every status shows. */
export function defaultPoamStatuses(entries: readonly POAMEntry[]): Set<PoamStatusKey> {
  const c = poamStatusCounts(entries);
  return c.NOT_MET + c.IN_PROGRESS > 0 ? new Set<PoamStatusKey>(['NOT_MET', 'IN_PROGRESS']) : new Set<PoamStatusKey>(POAM_STATUS_ORDER);
}

export function poamQueryTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

export function matchesPoamQuery(e: POAMEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const hay = [e.weaknessId, e.controlId, e.controlDisplayId ?? '', e.controlTitle, e.weaknessDescription, e.responsibleRole].join(' ').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function filterPoamEntries(entries: readonly POAMEntry[], statuses: ReadonlySet<PoamStatusKey>, query: string): POAMEntry[] {
  const terms = poamQueryTerms(query);
  return entries.filter((e) => statuses.has(poamStatusKey(e.status)) && matchesPoamQuery(e, terms));
}

/**
 * Family groups of the visible entries. The family is the control's own domain (looked up by controlId, the weakness id is never
 * parsed); groups follow the framework's domain order and unknown families come last as Other. Empty groups are left out.
 */
export function groupPoamByFamily(
  visible: readonly POAMEntry[],
  all: readonly POAMEntry[],
  controls: readonly Pick<FrameworkControlDefinition, 'id' | 'domain' | 'domainName'>[],
  domains: Readonly<Record<string, { code: string; name: string }>>
): PoamFamilyGroup[] {
  const byControl = new Map<string, Pick<FrameworkControlDefinition, 'id' | 'domain' | 'domainName'>>();
  for (const c of controls) byControl.set(c.id, c);
  const OTHER = 'OTHER';
  const familyOf = (e: POAMEntry): string => {
    const c = byControl.get(e.controlId);
    return c && Object.prototype.hasOwnProperty.call(domains, c.domain) ? c.domain : OTHER;
  };
  const nameOf = (code: string): string => {
    if (code === OTHER) return 'Other';
    return domains[code]?.name ?? controls.find((c) => c.domain === code)?.domainName ?? code;
  };
  const totals = new Map<string, number>();
  for (const e of all) totals.set(familyOf(e), (totals.get(familyOf(e)) ?? 0) + 1);
  const buckets = new Map<string, POAMEntry[]>();
  for (const e of visible) {
    const code = familyOf(e);
    const list = buckets.get(code);
    if (list) list.push(e); else buckets.set(code, [e]);
  }
  const codes = [...Object.keys(domains).filter((code) => buckets.has(code)), ...(buckets.has(OTHER) ? [OTHER] : [])];
  return codes.map((code) => ({ code, name: nameOf(code), entries: buckets.get(code) ?? [], total: totals.get(code) ?? 0 }));
}

export function initialExpanded(codes: readonly string[], max: number = POAM_GROUPS_OPEN_MAX): Set<string> {
  return codes.length <= max ? new Set(codes) : new Set<string>();
}

/** While a search is active every group is open unless the user closed it; otherwise the user's choice, or the initial default. */
export function groupOpen(
  code: string,
  s: { searching: boolean; expanded: ReadonlySet<string> | null; searchCollapsed: ReadonlySet<string>; initial: ReadonlySet<string> }
): boolean {
  return s.searching ? !s.searchCollapsed.has(code) : (s.expanded ?? s.initial).has(code);
}

/** The live result line: what is shown, and how many entries the status filter and the search are hiding. */
export function poamResultsText(
  all: readonly POAMEntry[],
  visible: readonly POAMEntry[],
  statuses: ReadonlySet<PoamStatusKey>,
  query: string
): string {
  if (all.length === 0) return 'No control entries.';
  if (visible.length === all.length) return all.length === 1 ? 'Showing 1 control entry.' : `Showing all ${all.length} control entries.`;
  let text = `Showing ${visible.length} of ${all.length} control entries.`;
  const counts = poamStatusCounts(all);
  const hidden = [...POAM_STATUS_ORDER].reverse().filter((k) => !statuses.has(k) && counts[k] > 0);
  const hiddenSum = hidden.reduce((n, k) => n + counts[k], 0);
  if (hidden.length === 1) {
    const n = counts[hidden[0]];
    text += ` ${n} ${POAM_STATUS_LABEL[hidden[0]].toLowerCase()} ${n === 1 ? 'entry is' : 'entries are'} hidden by the status filter.`;
  } else if (hidden.length > 1) {
    text += ` ${hiddenSum} entries are hidden by the status filter (${hidden.map((k) => `${counts[k]} ${POAM_STATUS_LABEL[k].toLowerCase()}`).join(', ')}).`;
  }
  const m = all.length - hiddenSum - visible.length;
  if (m > 0 && poamQueryTerms(query).length > 0) text += ` ${m} ${m === 1 ? 'does' : 'do'} not match the search.`;
  return text;
}

export function showMoreText(remaining: number, step: number): string {
  return remaining <= step ? `Show the remaining ${remaining}` : `Show ${step} more (${remaining} not shown)`;
}
