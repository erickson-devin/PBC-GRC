import JSZip from 'jszip';
import { CMMC_ID_RE, NIST_NUMBER_RE, foldForMatching, isAnchorLine } from './chunk';
import { extractWith } from './extractCore';

/**
 * Structure and recall diagnostics for a .docx, for the operator script (scripts/sspDiagnose.ts). COUNTS ONLY: it never returns
 * or logs any text of the document, so the result is safe to paste into a ticket.
 */
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

export async function diagnoseDocx(data: Uint8Array): Promise<Record<string, number>> {
  const zip = await JSZip.loadAsync(data);
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const { text } = await extractWith({ kind: 'docx', data, maxPages: 0, maxChars: 50_000_000, maxZipEntries: 10_000 });
  const folded = foldForMatching(text);

  return {
    paragraphs: count(xml, /<w:p[ >]/g),
    lineBreaks: count(xml, /<w:br(?![A-Za-z])(?:\s*\/>|\s*>|\s+w:type="textWrapping")/g),
    pageBreaks: count(xml, /<w:br\s+w:type="page"/g),
    numberedParagraphs: count(xml, /<w:numPr>/g),
    headingStyled: count(xml, /<w:pStyle\s+w:val="Heading/g),
    tables: count(xml, /<w:tbl>/g),
    cmmcIds: count(folded, new RegExp(CMMC_ID_RE.source, 'g')),
    nistNumbers: count(folded, new RegExp(NIST_NUMBER_RE.source, 'g')),
    anchorLines: folded.split('\n').filter((l) => isAnchorLine(l)).length,
    gluedIds: count(text, /(3\.\d{1,2}\.\d{1,2})[A-Za-z]/g),
    v1Ids: count(text, /\b[A-Z]{2}\.[1-5]\.\d{3}\b/g),
    rev3Ids: count(text, /\b03\.\d{2}\.\d{2}\b/g),
    dottedLevelIds: count(text, /\b[A-Z]{2}\.L[12]\.3\./g),
  };
}
