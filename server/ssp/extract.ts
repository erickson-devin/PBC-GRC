import { Worker } from 'worker_threads';
import { fileTypeFromBuffer } from 'file-type';
import type { ExtractedDocument, SspDocumentKind } from './types';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 500;
export const MAX_TEXT_CHARS = 5_000_000;
const MAX_ZIP_ENTRIES = 2000;
const EXTRACT_TIMEOUT_MS = 90_000;
const WORKER_MEMORY_MB = 768;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ExtractionErrorCode = 'timeout' | 'no_text' | 'too_large' | 'parse_failed';

export class ExtractionError extends Error {
  constructor(public code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * What the bytes really are, from their magic numbers. The file name and the client's Content-Type are not trusted.
 * Only PDF and DOCX are accepted (not legacy .doc).
 */
export async function detectDocumentKind(buffer: Buffer): Promise<{ kind: SspDocumentKind; mime: string } | null> {
  const type = await fileTypeFromBuffer(buffer);
  if (type?.mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (type?.mime === DOCX_MIME) return { kind: 'docx', mime: DOCX_MIME };
  return null;
}

/**
 * Extracts the text of a PDF or DOCX in a worker thread with a memory cap and a timeout.
 * A scanned PDF has no text layer: that is reported as 'no_text' (OCR is not part of this feature).
 */
export function extractDocument(buffer: Buffer, kind: SspDocumentKind): Promise<ExtractedDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extractWorker.ts', import.meta.url), {
      workerData: { kind, data: new Uint8Array(buffer), maxPages: MAX_PAGES, maxChars: MAX_TEXT_CHARS, maxZipEntries: MAX_ZIP_ENTRIES },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ExtractionError('timeout', 'Reading the document took too long and was stopped.'))),
      EXTRACT_TIMEOUT_MS
    );

    worker.on('message', (msg: { ok: boolean; result?: ExtractedDocument; error?: string }) =>
      finish(() => {
        if (!msg.ok || !msg.result) {
          const error = msg.error ?? 'unknown';
          if (error.startsWith('too_many_pages') || error === 'too_much_text' || error === 'too_many_entries') {
            reject(new ExtractionError('too_large', 'The document is too large to import (page, size or structure limit).'));
          } else {
            reject(new ExtractionError('parse_failed', 'The document could not be read. It may be corrupt or password-protected.'));
          }
          return;
        }
        if (msg.result.text.replace(/\s+/g, '').length < 20) {
          reject(new ExtractionError('no_text', 'No text could be extracted. A scanned document needs OCR first, which is not supported yet.'));
          return;
        }
        resolve(msg.result);
      })
    );
    worker.on('error', () => finish(() => reject(new ExtractionError('parse_failed', 'The document could not be read (it exceeded a processing limit or is corrupt).'))));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new ExtractionError('parse_failed', 'The document could not be read.')));
    });
  });
}
