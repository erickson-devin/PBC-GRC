import { fork, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import type { ExtractedDocument, SspDocumentKind } from './types';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 500;
export const MAX_TEXT_CHARS = 5_000_000;
const MAX_ZIP_ENTRIES = 2000;
const EXTRACT_TIMEOUT_MS = 90_000;
const CHILD_MEMORY_MB = 768;
const STDERR_TAIL_BYTES = 8 * 1024;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ExtractionErrorCode = 'timeout' | 'no_text' | 'too_large' | 'parse_failed' | 'crashed';

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


const CHILD_PATH = fileURLToPath(new URL('./extractChild.ts', import.meta.url));
const HEAP_BANNER = /JavaScript heap out of memory|Reached heap limit/;

/** Every child that is running, so that the server's exit can never leave one behind. */
const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of live) c.kill('SIGKILL');
});

/** The child gets only what it needs to start, not the server's secrets (database URL, auth secret, ...). */
function childEnv(): NodeJS.ProcessEnv {
  const keys = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'NODE_ENV', 'TSX_TSCONFIG_PATH', 'TSX_DISABLE_CACHE'];
  if (process.env.NODE_ENV === 'test') keys.push('SSP_EXTRACT_TEST_MODE');
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * How a child that ended without answering is classified. A native crash (a signal, an abort, a Windows access violation)
 * is 'crashed'; running out of memory under the heap cap and the child's own "uncaught" exit (70) are an unreadable
 * document, as they were in the worker thread.
 */
export function classifyChildExit(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): 'crashed' | 'parse_failed' {
  if (HEAP_BANNER.test(stderrTail)) return 'parse_failed';
  if (signal) return 'crashed';
  if (code === 70) return 'parse_failed';
  return 'crashed';
}

/**
 * Extracts the text of a PDF or DOCX in a forked child process with a memory cap and a timeout, so that even a native crash
 * of the parser cannot take the API server down. A scanned PDF has no text layer: that is reported as 'no_text' (OCR is not
 * part of this feature). Nothing is written to disk and the child's output is never logged.
 */
export function extractDocument(
  buffer: Buffer,
  kind: SspDocumentKind,
  opts: { timeoutMs?: number; memoryMb?: number; onSpawn?: (child: ChildProcess) => void } = {}
): Promise<ExtractedDocument> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? CHILD_MEMORY_MB;
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: [...process.execArgv.filter((a) => !/^--(inspect(-brk|-port|-wait)?|debug-port|max-old-space-size)(=|$)/.test(a)), `--max-old-space-size=${memoryMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: childEnv(),
    });
    live.add(child);
    opts.onSpawn?.(child);

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('latin1')).slice(-STDERR_TAIL_BYTES);
    });

    let settled = false;
    let answered = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new ExtractionError('timeout', 'Reading the document took too long and was stopped.'))),
      timeoutMs
    );

    child.on('message', (msg: { ok: boolean; result?: ExtractedDocument; error?: string }) => {
      answered = true;
      finish(() => {
        if (!msg.ok || !msg.result) {
          const error = msg.error ?? 'unknown';
          if (error.startsWith('too_many_pages') || error === 'too_much_text' || error === 'too_many_entries') {
            reject(new ExtractionError('too_large', 'The document is too large to import (page, size or structure limit).'));
          } else if (error === 'uncaught') {
            reject(new ExtractionError('parse_failed', 'The document could not be read (it exceeded a processing limit or is corrupt).'));
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
      });
    });
    child.on('error', () => finish(() => reject(new ExtractionError('crashed', 'The document reader could not be started.'))));
    // 'close' (not 'exit'): stdio and the IPC channel are drained, so a final message cannot be lost
    child.on('close', (code, signal) =>
      finish(() => {
        if (answered) return;
        if (classifyChildExit(code, signal, stderrTail) === 'parse_failed') {
          reject(new ExtractionError('parse_failed', 'The document could not be read (it exceeded a processing limit or is corrupt).'));
          return;
        }
        console.error(`[SSP Import] the document reader stopped unexpectedly (exit code ${code}, signal ${signal})`);
        reject(new ExtractionError('crashed', 'The document reader stopped unexpectedly while reading this file. It may be corrupt; the server was not affected.'));
      })
    );

    const testMode = process.env.NODE_ENV === 'test' ? process.env.SSP_EXTRACT_TEST_MODE : undefined;
    child.send(
      { kind, data: new Uint8Array(buffer), maxPages: MAX_PAGES, maxChars: MAX_TEXT_CHARS, maxZipEntries: MAX_ZIP_ENTRIES, ...(testMode ? { testMode } : {}) },
      () => undefined
    );
  });
}
