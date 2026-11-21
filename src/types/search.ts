/**
 * Global search (#254). A query is sent in a POST body, never in a URL, and neither it nor a snippet is logged or stored. A snippet is plain text with the
 * match located by offsets of its parts: it is never HTML.
 */

export const SEARCH_KINDS = ['control', 'objective', 'evidence', 'asset', 'poam_control', 'poam_vm', 'tool', 'vendor', 'document'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;
export const SEARCH_PER_KIND_DEFAULT = 8;
export const SEARCH_PER_KIND_MAX = 25;

/** The text around a match, split in three; render each as a text node (the match in a <mark>). */
export interface SearchSnippet {
  before: string;
  match: string;
  after: string;
}

export type SearchNav =
  | { screen: 'control'; controlId: string }
  | { screen: 'objective'; controlId: string; objectiveId: string }
  | { screen: 'evidence'; evidenceId: string; controlId: string }
  | { screen: 'asset'; assetId: string }
  | { screen: 'poam_control'; controlId: string }
  | { screen: 'poam_vm'; itemId: string }
  | { screen: 'tool'; toolId: string }
  | { screen: 'vendor'; vendorId: string }
  | { screen: 'document'; documentId: string };

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** Which field matched, e.g. 'notes' or 'file name'. */
  field: string;
  snippet: SearchSnippet | null;
  /** Tenant-wide registers only: whether the item belongs to the active program. */
  inProgram?: boolean;
  nav: SearchNav;
}

export interface SearchResponse {
  programId: string;
  groups: { kind: SearchKind; results: SearchResult[]; truncated: boolean }[];
}
