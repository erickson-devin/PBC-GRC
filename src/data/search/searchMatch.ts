// Matching and snippets of the global search (#254). One case-insensitive CONTIGUOUS substring (the same as an escaped ILIKE '%q%'): SQL narrows the rows,
// and both stores (memory and PostgreSQL) run these functions over the candidates, so the two give identical results. A snippet is plain text split in
// before / match / after: never HTML. Pure: types only; nothing here stores, logs or sends a query (a query and its snippets may be CUI).

import { SEARCH_MAX, SEARCH_MIN, type SearchResult, type SearchSnippet } from '../../types/search';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The trimmed query when it is a string of SEARCH_MIN to SEARCH_MAX characters with no control character. Never echoes the input. */
export function normalizeQuery(raw: unknown): { ok: true; q: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const q = raw.trim();
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX || CONTROL_CHARS.test(q)) return { ok: false };
  return { ok: true, q };
}

/** The ILIKE pattern of a query: '%' + the query with backslash, percent and underscore escaped + '%'. Use with ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Lower case that never changes the length (a character whose lower case is longer, or shorter, is kept), so an offset in it is an offset in the text. */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** The index of the first case-insensitive occurrence of `q` in `text`, or -1 (also for an empty query). */
export function matchText(text: string, q: string): number {
  if (typeof text !== 'string' || typeof q !== 'string' || q === '') return -1;
  return fold(text).indexOf(fold(q));
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ');

/**
 * The first match with up to `radius` characters each side, whitespace collapsed to single spaces and '…' where the text was cut. The visible length is
 * at most 2 * radius + the query length (the ellipses come on top). null when there is no match.
 */
export function snippetAround(text: string, q: string, radius = 60): SearchSnippet | null {
  if (typeof text !== 'string' || typeof q !== 'string' || q === '') return null;
  const flat = collapse(text);
  const needle = collapse(q);
  const at = matchText(flat, needle);
  if (at < 0) return null;
  const from = Math.max(0, at - radius);
  const end = at + needle.length;
  const to = Math.min(flat.length, end + radius);
  return {
    before: (from > 0 ? '…' : '') + flat.slice(from, at),
    match: flat.slice(at, end),
    after: flat.slice(end, to) + (to < flat.length ? '…' : ''),
  };
}

/**
 * The results ordered by how well they match: the exact id or title first, then a title that starts with the query, then one that contains it, then the
 * rest (a match in another field). Ties are ordered by id. Returns a new array.
 */
export function rankResults(results: SearchResult[], q: string): SearchResult[] {
  const needle = fold(q.trim());
  const rank = (r: SearchResult): number => {
    const id = fold(r.id);
    const title = fold(r.title);
    if (id === needle || title === needle) return 0;
    if (title.startsWith(needle)) return 1;
    if (title.includes(needle)) return 2;
    return 3;
  };
  return results
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) || a.i - b.i)
    .map((x) => x.r);
}
