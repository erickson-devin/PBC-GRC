// What the global search dialog (#254) shows and how its keyboard moves: pure text and index logic, no React. A query and a snippet may be CUI: nothing
// here keeps, logs or announces either (the screen reader line carries counts only), and every error text is fixed.

import type { SearchKind, SearchResponse, SearchResult } from '../../types/search';
import { matchText } from './searchMatch';

export const KIND_LABELS: Record<SearchKind, string> = {
  control: 'Controls',
  objective: 'Objectives',
  evidence: 'Evidence files',
  asset: 'Assets',
  poam_control: 'POA&M: controls',
  poam_vm: 'POA&M: vulnerabilities',
  tool: 'Tools and services',
  vendor: 'Vendors',
  document: 'Documents',
};

/** The field names the server sends for a match, in words. */
export const FIELD_LABELS: Record<string, string> = {
  id: 'Identifier',
  title: 'Title',
  notes: 'Implementation notes',
  narrative: 'Objective narrative',
  'objective text': 'Objective text',
  'file name': 'File name',
  owner: 'Owner',
  plan: 'Plan',
  'required resources': 'Resources',
  weakness: 'Weakness',
  mitigation: 'Mitigation',
  'item number': 'Item number',
  'host name': 'Host name',
  'IP address': 'IP address',
  'MAC address': 'MAC address',
  'serial number': 'Serial number',
  name: 'Name',
  vendor: 'Vendor',
  services: 'Services',
  reference: 'Reference',
};

export function fieldLabel(field: string): string {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, field) ? FIELD_LABELS[field] : 'Match';
}

/** "Showing 8 of 43" when the total is known, "Showing 8, more match" when the list is cut off without one, else the plain count. */
export function groupCountText(shown: number, total: number | null, truncated: boolean): string {
  if (total !== null && total > shown) return `Showing ${shown} of ${total}`;
  if (truncated) return `Showing ${shown}, more match`;
  return String(shown);
}

export interface FlatOption {
  id: string;
  kind: SearchKind;
  groupIndex: number;
  /** null: the group's "Show more" row. */
  result: SearchResult | null;
}

/** Every option of the list in the order it is shown: each result, then the group's "Show more" row when the group is cut off. Empty groups have none. */
export function flattenOptions(groups: SearchResponse['groups'], idPrefix: string): FlatOption[] {
  const flat: FlatOption[] = [];
  groups.forEach((g, groupIndex) => {
    g.results.forEach((result, i) => flat.push({ id: `${idPrefix}-${g.kind}-${i}`, kind: g.kind, groupIndex, result }));
    if (g.truncated && g.results.length > 0) flat.push({ id: `${idPrefix}-${g.kind}-more`, kind: g.kind, groupIndex, result: null });
  });
  return flat;
}

/**
 * The active option after a key: Down and Up wrap round (Up from nothing goes to the last), Page Down goes to the first option of the next group (and stays
 * where it is in the last group), Page Up to the first option of the current group, or of the previous one when already on it. Any other key: unchanged.
 */
export function nextActive(key: string, active: number, flat: FlatOption[]): number {
  const n = flat.length;
  if (n === 0) return -1;
  const here = active >= 0 && active < n ? active : -1;
  const firstOf = (groupIndex: number): number => flat.findIndex((o) => o.groupIndex === groupIndex);
  switch (key) {
    case 'ArrowDown':
      return here < 0 ? 0 : (here + 1) % n;
    case 'ArrowUp':
      return here <= 0 ? n - 1 : here - 1;
    case 'PageDown': {
      if (here < 0) return 0;
      const next = flat.find((o) => o.groupIndex > flat[here].groupIndex);
      return next ? firstOf(next.groupIndex) : here;
    }
    case 'PageUp': {
      if (here < 0) return 0;
      const start = firstOf(flat[here].groupIndex);
      if (here > start) return start;
      const before = flat.slice(0, start).reverse().find((o) => o.groupIndex < flat[here].groupIndex);
      return before ? firstOf(before.groupIndex) : start;
    }
    default:
      return active;
  }
}

/** A title (or other text) split around the first case-insensitive match of the query, for a <mark>; null when it does not contain it. */
export function splitHighlight(text: string, q: string): { before: string; match: string; after: string } | null {
  const needle = q.trim();
  const at = matchText(text, needle);
  if (at < 0) return null;
  return { before: text.slice(0, at), match: text.slice(at, at + needle.length), after: text.slice(at + needle.length) };
}

/** The polite line a screen reader hears. Counts only: never the query or a result. */
export function searchAnnouncement(s: { tooShort: boolean; loading: boolean; error: boolean; count: number; groups: number }): string {
  if (s.tooShort) return 'Type at least 2 characters to search.';
  if (s.loading || s.error) return '';
  if (s.count === 0) return 'No matches in this program.';
  return `${s.count} ${s.count === 1 ? 'result' : 'results'} in ${s.groups} ${s.groups === 1 ? 'group' : 'groups'}.`;
}

/** A fixed message for a failed search: from an HTTP failure (a numeric `status`) or from the hook's error code. Never the server's text. */
export function searchErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 429 || err === 'too_many') return 'Too many searches. Wait a moment and try again.';
  if (status === 400 || err === 'invalid') return 'Use 2 to 100 characters, without control characters.';
  return 'Search failed. Check the connection and try again.';
}

/** The key hint on the header button: the Command key on Apple devices, Ctrl elsewhere. */
export function shortcutHint(platform: string): string {
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl K';
}
