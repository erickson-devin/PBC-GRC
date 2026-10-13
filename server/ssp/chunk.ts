import type { DocChunk, PageSpan } from './types';

/**
 * Structure-aware chunking of an extracted document.
 *
 * A new chunk starts at a line that "anchors" a control (a control reference in the first few characters of the line, e.g.
 * "AC.L2-3.1.1 Access control", "3.1.1 Limit system access", "| 3.1.2 | ...") and at a generic section heading
 * ("4. Incident Response", "ACCESS CONTROL"). So one chunk is normally one section of the plan, and the section that
 * describes a control stays together. Every chunk keeps its offsets and page.
 *
 * Offsets always refer to the ORIGINAL text. Detection runs on a copy where dash and space variants are folded
 * one-for-one (so offsets line up).
 */

/** Folds typographic dashes and non-breaking spaces to ASCII, keeping the length identical. */
export const foldForMatching = (text: string): string => text.replace(/[‐-―−]/g, '-').replace(/ /g, ' ');

/** A CMMC identifier, e.g. AC.L2-3.1.5 */
export const CMMC_ID_RE = /\b([A-Z]{2})\.L([12])-(3\.\d{1,2}\.\d{1,2})\b/g;
/** A NIST SP 800-171 requirement number, e.g. 3.1.5 (not part of a longer dotted number or a word). */
export const NIST_NUMBER_RE = /(?<![\w.])(3\.(?:[1-9]|1[0-4])\.(?:[1-9]|1\d|2\d))(?![\w]|\.\d)/g;

/** How far into a line a control reference may start and still make it a section anchor. */
const ANCHOR_WINDOW = 40;
const GENERIC_HEADING_MAX = 100;
const NUMBERED_HEADING_RE = /^\d+(?:\.\d+){0,3}[.)]?\s+[A-Z][^.!?]*$/;

/**
 * What may precede a bare NIST number for the line to be a section anchor: bullets, table pipes, or a label such as
 * "Control" or "NIST SP 800-171". A number in the middle of a sentence is a mention, not a section.
 */
export const NIST_ANCHOR_PREFIX_RE = /^[\s|•*-]*(?:(?:control|requirement|practice|nist(?:\s+sp)?\s*800-171)\s*[:#-]?\s*)?$/i;

/** True when a reference found at `index` in a folded line makes that line the start of a control's section. */
export function isAnchorRef(foldedLine: string, ref: { kind: 'CMMC' | 'NIST'; index: number }): boolean {
  const labelled = NIST_ANCHOR_PREFIX_RE.test(foldedLine.slice(0, ref.index));
  if (ref.kind === 'NIST') return labelled;
  // A CMMC identifier is explicit enough to anchor a heading that puts the title first ("Authorized Access (AC.L1-3.1.1)"),
  // but not a sentence that merely refers to it ("See also AC.L2-3.1.5 for least privilege.")
  const line = foldedLine.trim();
  return labelled || (ref.index <= ANCHOR_WINDOW && line.length <= GENERIC_HEADING_MAX && !/[.;!?]$/.test(line));
}

export function isAnchorLine(foldedLine: string): boolean {
  const line = foldedLine.trim();
  if (!line) return false;
  const cmmc = new RegExp(CMMC_ID_RE.source, 'g');
  const cm = cmmc.exec(line);
  if (cm && isAnchorRef(line, { kind: 'CMMC', index: cm.index })) return true;
  const nist = new RegExp(NIST_NUMBER_RE.source, 'g');
  const nm = nist.exec(line);
  return Boolean(nm && isAnchorRef(line, { kind: 'NIST', index: nm.index }));
}

function isGenericHeading(foldedLine: string): boolean {
  const line = foldedLine.trim();
  if (line.length < 4 || line.length > GENERIC_HEADING_MAX) return false;
  if (NUMBERED_HEADING_RE.test(line)) return true;
  // ALL CAPS line of letters (not a sentence)
  return /^[A-Z][A-Z0-9 &/,\-()]{3,}$/.test(line) && !/[a-z]/.test(line);
}

function pageOf(offset: number, pages: readonly PageSpan[]): number | null {
  if (pages.length === 0) return null;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return pages[lo].page;
}

export interface ChunkOptions {
  /** Split a section longer than this on paragraph boundaries (the pieces share the section's heading). */
  maxChars?: number;
}

export function chunkDocument(text: string, pages: readonly PageSpan[] = [], options: ChunkOptions = {}): DocChunk[] {
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const folded = foldForMatching(text);

  // Line table
  const lines: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    lines.push({ start: pos, end: nl });
    pos = nl + 1;
  }

  // Section boundaries
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = folded.slice(lines[i].start, lines[i].end);
    if (isAnchorLine(f) || isGenericHeading(f)) boundaries.push(lines[i].start);
  }
  if (boundaries[0] !== 0) boundaries.unshift(0);

  const sections: Array<{ start: number; end: number }> = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = b + 1 < boundaries.length ? boundaries[b + 1] : text.length;
    if (text.slice(start, end).trim()) sections.push({ start, end });
  }

  const chunks: DocChunk[] = [];
  const push = (start: number, end: number, heading: string): void => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) return;
    chunks.push({ index: chunks.length, start: start + lead, end: start + lead + body.length, heading, page: pageOf(start + lead, pages), text: body });
  };

  for (const s of sections) {
    const raw = text.slice(s.start, s.end);
    const heading = (raw.trim().split('\n')[0] ?? '').trim().slice(0, 200);
    if (raw.length <= maxChars) {
      push(s.start, s.end, heading);
      continue;
    }
    // Oversized section: cut on blank lines, then hard-cut anything still too long
    let cursor = s.start;
    while (cursor < s.end) {
      let cut = Math.min(cursor + maxChars, s.end);
      if (cut < s.end) {
        const para = text.lastIndexOf('\n\n', cut);
        if (para > cursor + maxChars * 0.4) cut = para;
      }
      push(cursor, cut, heading);
      cursor = cut;
    }
  }
  return chunks;
}
