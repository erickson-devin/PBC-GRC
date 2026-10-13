/**
 * Runs in a worker thread (see extract.ts): parses an untrusted PDF or DOCX. Isolated so that a malicious or huge file
 * can only take down this thread (it has a memory cap and a timeout), never the API server.
 */
import { parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import type { ExtractedDocument, PageSpan, SspDocumentKind } from './types';

interface WorkerInput {
  kind: SspDocumentKind;
  data: Uint8Array;
  maxPages: number;
  maxChars: number;
  maxZipEntries: number;
}

const input = workerData as WorkerInput;

async function extractPdf(): Promise<ExtractedDocument> {
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

async function extractDocx(): Promise<ExtractedDocument> {
  // A .docx is a zip: refuse an archive with an absurd number of entries before handing it to the parser
  const zip = await JSZip.loadAsync(input.data);
  if (Object.keys(zip.files).length > input.maxZipEntries) throw new Error('too_many_entries');
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(input.data) });
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > input.maxChars) throw new Error('too_much_text');
  return { text, pages: [], pageCount: 0 };
}

(input.kind === 'pdf' ? extractPdf() : extractDocx())
  .then((result) => parentPort!.postMessage({ ok: true, result }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }));
