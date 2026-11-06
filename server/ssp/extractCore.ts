/**
 * The parsing itself: turns an untrusted PDF or DOCX into text. It runs inside the forked child process (see
 * extractChild.ts and extract.ts), never in the API server's own process.
 */
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { ExtractedDocument, PageSpan } from './types';

export type CoreInput = { kind: 'pdf' | 'docx'; data: Uint8Array; maxPages: number; maxChars: number; maxZipEntries: number };

async function extractPdf(input: CoreInput): Promise<ExtractedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const doc = await pdfjs.getDocument({
    data: input.data,
    isEvalSupported: false, // never evaluate font programs from the file
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(fontDir).href,
    verbosity: 0,
  }).promise;

  if (doc.numPages > input.maxPages) throw new Error(`too_many_pages:${doc.numPages}`);

  let text = '';
  const pages: PageSpan[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      pageText += item.str;
      pageText += item.hasEOL ? '\n' : item.str && !item.str.endsWith(' ') ? ' ' : '';
    }
    pageText = pageText.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    const start = text.length;
    text += pageText;
    pages.push({ page: n, start, end: text.length });
    text += '\n\n';
    if (text.length > input.maxChars) throw new Error('too_much_text');
  }
  return { text: text.trimEnd(), pages, pageCount: doc.numPages };
}

/** mammoth's raw-text conversion (lib/raw-text.js), plus a line break element as "\n". */
function elementToText(element: any): string {
  if (element.type === 'text') return element.value;
  if (element.type === 'tab') return '\t';
  if (element.type === 'break') return '\n';
  const tail = element.type === 'paragraph' ? '\n\n' : '';
  return (element.children || []).map(elementToText).join('') + tail;
}

async function extractDocx(input: CoreInput): Promise<ExtractedDocument> {
  // A .docx is a zip: refuse an archive with an absurd number of entries before handing it to the parser
  const zip = await JSZip.loadAsync(input.data);
  if (Object.keys(zip.files).length > input.maxZipEntries) throw new Error('too_many_entries');
  // Same as mammoth.extractRawText, except a line break (Shift+Enter, page break) becomes "\n" instead of vanishing: without
  // it "AC.L2-3.1.1<br>Title" would read "AC.L2-3.1.1Title". The document is emptied after reading, so no HTML or image work is done.
  let value = '';
  await mammoth.convertToHtml(
    { buffer: Buffer.from(input.data) },
    {
      externalFileAccess: false,
      transformDocument: (doc) => {
        value = elementToText(doc);
        return { ...doc, children: [] };
      },
    } as Parameters<typeof mammoth.convertToHtml>[1]
  );
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > input.maxChars) throw new Error('too_much_text');
  return { text, pages: [], pageCount: 0 };
}

export async function extractWith(input: CoreInput): Promise<ExtractedDocument> {
  return input.kind === 'pdf' ? extractPdf(input) : extractDocx(input);
}
