import { numberOf, numberToIdMap, pageAt } from './controlMapper';
import type { PageSpan, SourceQuote, SspImportFramework } from './types';

/**
 * Grounding checks for what a language model says about a document. A model can invent a quotation or a control; neither is
 * allowed to reach the review screen unless it can be checked against something we hold:
 *
 *   - a QUOTE must appear, word for word, in the section of the document the model was shown (and nowhere else: text from
 *     the prompt, such as the control requirement, does not count). It is stored as the document's own text, with its
 *     position and page, never as the model's rendering of it;
 *   - a CONTROL ID must be a control of the framework being mapped, and one of the controls offered for that section.
 *
 * Wording is compared after folding differences a model cannot reproduce exactly: runs of whitespace and line breaks,
 * typographic quotes and dashes, non-breaking spaces and letter case. Anything else (a paraphrase, a reordering, an added
 * word) does not match.
 */

export const MIN_QUOTE_WORDS = 5;
export const MAX_QUOTE_CHARS = 600;

export type GroundingFailure = 'QUOTE_TOO_SHORT' | 'QUOTE_NOT_FOUND' | 'UNKNOWN_CONTROL' | 'OUT_OF_SCOPE' | 'NOT_OFFERED';

interface Folded {
  text: string;
  /** map[i] is the index in the original text of folded character i. */
  map: number[];
}

const QUOTE_CHARS: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"' };

/** Lower-cases, folds typographic characters and collapses whitespace, remembering where each character came from. */
export function foldWithMap(source: string): Folded {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // leading whitespace is dropped
  for (let i = 0; i < source.length; i++) {
    let ch = source[i];
    if (ch === '­' || ch === '​' || ch === '﻿') continue; // soft hyphen, zero-width characters
    if (/[‐-―−]/.test(ch)) ch = '-';
    else if (QUOTE_CHARS[ch]) ch = QUOTE_CHARS[ch];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out.push(' ');
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    out.push(ch.toLowerCase());
    map.push(i);
    lastWasSpace = false;
  }
  if (out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  return { text: out.join(''), map };
}

/** Whitespace-separated tokens that contain letters: "AC.L1-3.1.1" is one word, not six. */
const wordCount = (s: string): number => s.split(/\s+/).filter((t) => /[A-Za-zÀ-￿]{2,}/.test(t)).length;

/** Removes what a model tends to add around a quotation: surrounding quote marks, list bullets, a trailing ellipsis. */
function cleanQuote(raw: string): string {
  return raw
    .trim()
    .replace(/^[•*\-–—]\s+/, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
}

/** Finds `quote` in `source`; returns the range of the ORIGINAL text, or null. */
export function locateQuote(source: string, quote: string): { start: number; end: number } | null {
  const folded = foldWithMap(source);
  const find = (needle: string): { start: number; end: number } | null => {
    const f = foldWithMap(needle).text;
    if (!f) return null;
    const at = folded.text.indexOf(f);
    if (at === -1) return null;
    return { start: folded.map[at], end: folded.map[at + f.length - 1] + 1 };
  };
  return find(quote);
}

export interface QuoteGrounding {
  ok: true;
  quote: SourceQuote;
}
export interface GroundingFailed {
  ok: false;
  reason: GroundingFailure;
}

/**
 * Checks `claimed` against one section of the document. `sectionText` is the section exactly as shown to the model and
 * `sectionStart` its offset in the whole document, so the returned range and page refer to the document.
 * A claim with an ellipsis ("first part ... last part") is accepted as its longest part, which is then exact.
 */
export function groundQuote(
  sectionText: string,
  sectionStart: number,
  claimed: string,
  pages: readonly PageSpan[] = [],
  options: { minWords?: number } = {}
): QuoteGrounding | GroundingFailed {
  let candidate = cleanQuote(claimed);
  if (/(\.{3}|…)/.test(candidate)) {
    const parts = candidate.split(/\s*(?:\.{3}|…)\s*/).map((p) => p.trim()).filter(Boolean);
    candidate = parts.sort((a, b) => b.length - a.length)[0] ?? '';
  }
  if (wordCount(candidate) < (options.minWords ?? MIN_QUOTE_WORDS)) return { ok: false, reason: 'QUOTE_TOO_SHORT' };

  const hit = locateQuote(sectionText, candidate);
  if (!hit) return { ok: false, reason: 'QUOTE_NOT_FOUND' };

  // The quote is stored as the document's own text (sectionText is a slice of the document), capped in length
  const endInSection = Math.min(hit.end, hit.start + MAX_QUOTE_CHARS);
  const start = sectionStart + hit.start;
  const end = sectionStart + endInSection;
  return { ok: true, quote: { quote: sectionText.slice(hit.start, endInSection), page: pageAt(start, pages), start, end, verified: true } };
}

// ------------------------------------------------------------------------------------------------ control ids

const catalogCache = new Map<SspImportFramework, Map<string, { id: string; title: string }>>();
const catalog = (framework: SspImportFramework) => {
  let m = catalogCache.get(framework);
  if (!m) catalogCache.set(framework, (m = numberToIdMap(framework)));
  return m;
};

/**
 * Turns whatever the model wrote for a control ("AC.L2-3.1.1", "ac.l1-3.1.1", "3.1.1", "NIST 3.1.1") into the catalog id of
 * `framework`, or says why it cannot. `offered` are the controls that were put to the model for this section; an id outside
 * them is refused even if it exists, because it would be a guess about something the model was not asked.
 */
export function resolveControlId(
  raw: unknown,
  framework: SspImportFramework,
  offered?: ReadonlySet<string>
): { ok: true; controlId: string } | GroundingFailed {
  if (typeof raw !== 'string') return { ok: false, reason: 'UNKNOWN_CONTROL' };
  const folded = raw.trim().replace(/[‐-―−]/g, '-').toUpperCase();
  const number = folded.match(/\b3\.\d{1,2}\.\d{1,2}\b/)?.[0] ?? numberOf(folded);
  if (!number) return { ok: false, reason: 'UNKNOWN_CONTROL' };
  const hit = catalog(framework).get(number);
  if (!hit) {
    // a real practice of another level, or not a CMMC practice at all
    return { ok: false, reason: catalog('CMMC_L2').has(number) ? 'OUT_OF_SCOPE' : 'UNKNOWN_CONTROL' };
  }
  if (offered && !offered.has(hit.id)) return { ok: false, reason: 'NOT_OFFERED' };
  return { ok: true, controlId: hit.id };
}
