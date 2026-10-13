import { getFrameworkControls } from '../../src/data/frameworks';
import { CMMC_ID_RE, NIST_NUMBER_RE, chunkDocument, foldForMatching, isAnchorRef } from './chunk';
import type {
  CoverageReport,
  DocChunk,
  GapAnalysis,
  GapItem,
  MappingResult,
  PageSpan,
  SourceQuote,
  SspImportFramework,
  SspMatchKind,
  StagedControlDraft,
  UnmappedFinding,
} from './types';

/**
 * Phase 1 control mapping: regular expressions only, no AI. A control is found where the document names it, either by its
 * CMMC identifier (AC.L2-3.1.1) or by its NIST SP 800-171 number (3.1.1). A section that starts with the identifier is the
 * document's description of that control; a reference inside another section is only a mention.
 *
 * Mapping is limited to the ONE requested framework; references to other controls are reported, never staged.
 */
export const ANALYZER_ID = 'regex-v1';

const MAX_NOTES_CHARS = 8000;
const QUOTE_CHARS = 300;
const MAX_MENTION_PARAGRAPHS = 3;
const MAX_UNMAPPED = 50;
const BRIEF_NOTES_CHARS = 120;

const CONFIDENCE: Record<SspMatchKind, number> = { CMMC_ID_SECTION: 0.9, NIST_NUMBER_SECTION: 0.7, MENTION: 0.3 };

interface Ref {
  /** NIST number, e.g. 3.1.5 */
  number: string;
  kind: 'CMMC' | 'NIST';
  /** The text as written, e.g. AC.L2-3.1.5 */
  text: string;
  /** Offset inside the chunk text */
  index: number;
}

function findRefs(foldedChunk: string): Ref[] {
  const refs: Ref[] = [];
  const cmmc = new RegExp(CMMC_ID_RE.source, 'g');
  for (let m = cmmc.exec(foldedChunk); m; m = cmmc.exec(foldedChunk)) refs.push({ number: m[3], kind: 'CMMC', text: m[0], index: m.index });
  const nist = new RegExp(NIST_NUMBER_RE.source, 'g');
  for (let m = nist.exec(foldedChunk); m; m = nist.exec(foldedChunk)) {
    // The number inside a CMMC identifier (AC.L2-3.1.5) is the same reference, not a second one
    if (refs.some((r) => r.kind === 'CMMC' && m!.index >= r.index && m!.index < r.index + r.text.length)) continue;
    refs.push({ number: m[1], kind: 'NIST', text: m[0], index: m.index });
  }
  return refs.sort((a, b) => a.index - b.index);
}

export const numberOf = (controlId: string): string | null => controlId.match(/-(3\.\d+\.\d+)$/)?.[1] ?? null;

export function numberToIdMap(framework: SspImportFramework): Map<string, { id: string; title: string }> {
  const map = new Map<string, { id: string; title: string }>();
  for (const c of getFrameworkControls(framework)) {
    const n = numberOf(c.id);
    if (n) map.set(n, { id: c.id, title: c.title });
  }
  return map;
}

/** The control description from a section: its first line without the reference label, plus the rest. */
function sectionNotes(chunk: DocChunk, foldedChunk: string, refs: Ref[], title: string): string {
  const lines = chunk.text.split('\n');
  const foldedFirst = foldedChunk.split('\n')[0] ?? '';
  let first = lines[0] ?? '';
  // Remove the reference labels from the first line (positions come from the folded copy: same length)
  for (const r of refs.filter((x) => x.index < foldedFirst.length).sort((a, b) => b.index - a.index)) {
    first = first.slice(0, r.index) + first.slice(r.index + r.text.length);
  }
  first = first.replace(/^[\s:|\-‐-―.)•*,;/&]+/, '').replace(/[\s|]+$/, '').trim();
  // The catalog title may repeat the heading; some PDFs also run the heading and the first sentence together
  if (first.toLowerCase().startsWith(title.toLowerCase())) first = first.slice(title.length).replace(/^[\s:|\-‐-―.)]+/, '');
  // What is left of the first line is the document's own title for the control ("Identify Users"): not part of the narrative
  if (lines.length > 1 && first.length <= 80 && !/[.;!?:]$/.test(first)) first = '';
  return [first, ...lines.slice(1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function paragraphAround(chunkText: string, index: number): string {
  const before = chunkText.lastIndexOf('\n\n', index);
  const after = chunkText.indexOf('\n\n', index);
  return chunkText.slice(before === -1 ? 0 : before + 2, after === -1 ? chunkText.length : after).trim();
}

export function pageAt(offset: number, pages: readonly PageSpan[]): number | null {
  const hit = pages.find((p) => offset >= p.start && offset <= p.end);
  return hit ? hit.page : null;
}

/** A verbatim excerpt from `start`, at most QUOTE_CHARS long and never past `limit` (the end of its section). */
function makeQuote(text: string, start: number, pages: readonly PageSpan[], limit: number): SourceQuote {
  const end = Math.min(text.length, limit, start + QUOTE_CHARS);
  const quote = text.slice(start, end);
  return { quote, page: pageAt(start, pages), start, end, verified: text.slice(start, end) === quote };
}

function heuristicGaps(kind: SspMatchKind, notes: string, number: string): GapAnalysis {
  const gaps: GapItem[] = [];
  if (kind === 'MENTION') {
    gaps.push({
      severity: 'MEDIUM',
      missingElement: 'Implementation description',
      recommendation: 'The document refers to this practice but has no section that describes how it is implemented. Add one, or confirm the reference is not a requirement.',
    });
  } else if (notes.length < BRIEF_NOTES_CHARS) {
    gaps.push({
      severity: 'LOW',
      missingElement: 'Detail',
      recommendation: 'The description is very brief. State what is done, who is responsible, and how it is verified.',
    });
  }
  if (kind === 'NIST_NUMBER_SECTION') {
    gaps.push({
      severity: 'LOW',
      missingElement: 'Confirmation of the match',
      recommendation: `This section was matched only by the number ${number}. Check that it describes this control and is not the document's own section numbering.`,
    });
  }
  return {
    source: 'heuristic',
    summary: gaps.length === 0 ? 'No automated findings. This is not an assessment of whether the practice is met.' : `${gaps.length} automated finding${gaps.length === 1 ? '' : 's'}. These are simple text checks, not an assessment.`,
    gaps,
  };
}

interface Found {
  controlId: string;
  title: string;
  number: string;
  sections: Array<{ kind: SspMatchKind; chunk: DocChunk; notes: string }>;
  mentions: Array<{ chunk: DocChunk; paragraph: string; offset: number }>;
}

/** Maps an extracted document to the controls of `framework`. Pure and deterministic. */
export function mapDocumentToControls(
  text: string,
  pages: readonly PageSpan[],
  framework: SspImportFramework,
  chunks: DocChunk[] = chunkDocument(text, pages)
): MappingResult {
  const inScope = numberToIdMap(framework);
  const universe = numberToIdMap('CMMC_L2'); // every CMMC practice: tells "out of scope" from "does not exist"
  const found = new Map<string, Found>();
  const unmapped = new Map<string, UnmappedFinding>();

  const entry = (number: string): Found => {
    const c = inScope.get(number)!;
    let f = found.get(c.id);
    if (!f) found.set(c.id, (f = { controlId: c.id, title: c.title, number, sections: [], mentions: [] }));
    return f;
  };

  for (const chunk of chunks) {
    const folded = foldForMatching(chunk.text);
    const refs = findRefs(folded);
    if (refs.length === 0) continue;
    const firstLineEnd = folded.indexOf('\n') === -1 ? folded.length : folded.indexOf('\n');
    const headRefs = refs.filter((r) => r.index < firstLineEnd && isAnchorRef(folded.slice(0, firstLineEnd), r));

    for (const r of refs) {
      if (!inScope.has(r.number)) {
        // Referenced, but not a control of this framework
        if (r.kind === 'CMMC' || universe.has(r.number)) {
          const key = r.text;
          if (!unmapped.has(key) && unmapped.size < MAX_UNMAPPED) {
            unmapped.set(key, {
              reference: r.text,
              reason: universe.has(r.number) ? 'OUT_OF_SCOPE' : 'NOT_IN_CATALOG',
              page: chunk.page,
              excerpt: chunk.text.slice(Math.max(0, r.index - 40), r.index + 100).replace(/\s+/g, ' ').trim(),
            });
          }
        }
        continue;
      }
      const f = entry(r.number);
      const isHead = headRefs.includes(r);
      if (isHead) {
        const kind: SspMatchKind = headRefs.some((h) => h.number === r.number && h.kind === 'CMMC') ? 'CMMC_ID_SECTION' : 'NIST_NUMBER_SECTION';
        if (!f.sections.some((s) => s.chunk.index === chunk.index)) {
          f.sections.push({ kind, chunk, notes: sectionNotes(chunk, folded, headRefs, f.title) });
        }
      } else if (!f.mentions.some((m) => m.chunk.index === chunk.index)) {
        f.mentions.push({ chunk, paragraph: paragraphAround(chunk.text, r.index), offset: chunk.start + r.index });
      }
    }
  }

  const staged: StagedControlDraft[] = [];
  for (const f of found.values()) {
    const sections = f.sections;
    let kind: SspMatchKind;
    let notes: string;
    let quotes: SourceQuote[];
    let heading: string;

    if (sections.length > 0) {
      kind = sections.some((s) => s.kind === 'CMMC_ID_SECTION') ? 'CMMC_ID_SECTION' : 'NIST_NUMBER_SECTION';
      notes = sections.map((s) => s.notes).filter(Boolean).join('\n\n').slice(0, MAX_NOTES_CHARS).trim();
      quotes = sections.slice(0, 3).map((s) => makeQuote(text, s.chunk.start, pages, s.chunk.end));
      heading = sections[0].chunk.heading;
    } else {
      kind = 'MENTION';
      const paras = [...new Set(f.mentions.map((m) => m.paragraph).filter(Boolean))].slice(0, MAX_MENTION_PARAGRAPHS);
      notes = paras.join('\n\n').slice(0, MAX_NOTES_CHARS).trim();
      quotes = f.mentions.slice(0, 3).map((m) => makeQuote(text, m.offset, pages, m.chunk.end));
      heading = f.mentions[0].chunk.heading;
    }

    const confidence = Math.max(0.1, +(CONFIDENCE[kind] - (notes.length < BRIEF_NOTES_CHARS && kind !== 'MENTION' ? 0.1 : 0)).toFixed(2));
    staged.push({
      controlId: f.controlId,
      framework,
      matchKind: kind,
      sectionHeading: heading,
      suggestedNotes: notes,
      confidence,
      sourceQuotes: quotes,
      gapAnalysis: heuristicGaps(kind, notes, f.number),
    });
  }
  staged.sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));

  const catalog = getFrameworkControls(framework);
  const foundIds = new Set(staged.map((s) => s.controlId));
  const coverage: CoverageReport = {
    framework,
    totalControls: catalog.length,
    foundControls: foundIds.size,
    missing: catalog.map((c) => c.id).filter((id) => !foundIds.has(id)),
  };

  return { staged, unmapped: [...unmapped.values()], coverage };
}
