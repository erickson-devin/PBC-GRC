/**
 * Runs in a forked child process (see extract.ts): parses an untrusted PDF or DOCX. Isolated so that a malicious or huge
 * file, or a native crash in the parser, can only take down this process (it has a memory cap and a timeout), never the
 * API server. It receives one message, answers with one message and never writes document bytes or text to stdout/stderr.
 */
import { extractWith, type CoreInput } from './extractCore';

type ChildInput = Omit<CoreInput, 'data'> & { data: Uint8Array; testMode?: string };

/** Failure injection for the isolation tests. Only honoured when NODE_ENV is 'test' (the parent checks the same gate). */
async function testHook(mode: string): Promise<void> {
  switch (mode) {
    case 'abort':
      process.abort();
      break;
    case 'segv':
      process.kill(process.pid, 'SIGSEGV');
      await new Promise((r) => setTimeout(r, 5000));
      break;
    case 'throw':
      setImmediate(() => {
        throw new Error('test hook: throw');
      });
      await new Promise((r) => setTimeout(r, 5000));
      break;
    case 'reject':
      void Promise.reject(new Error('test hook: reject'));
      await new Promise((r) => setTimeout(r, 5000));
      break;
    case 'hang':
      setInterval(() => undefined, 1e9);
      await new Promise(() => undefined);
      break;
    case 'oom': {
      const hold: number[][] = [];
      for (;;) hold.push(new Array(1_000_000).fill(Math.random()));
    }
    case 'exit0':
      process.exit(0);
  }
}

const fatal = (): void => {
  const bail = setTimeout(() => process.exit(70), 1000);
  bail.unref();
  try {
    process.send?.({ ok: false, error: 'uncaught' }, () => process.exit(70));
  } catch {
    process.exit(70);
  }
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.on('disconnect', () => process.exit(1));

process.once('message', async (raw: ChildInput) => {
  try {
    if (raw.testMode && process.env.NODE_ENV === 'test') await testHook(raw.testMode);
    // pdfjs rejects a Buffer: copy into a plain Uint8Array whatever the IPC deserializer handed over
    const result = await extractWith({
      kind: raw.kind,
      data: new Uint8Array(raw.data),
      maxPages: raw.maxPages,
      maxChars: raw.maxChars,
      maxZipEntries: raw.maxZipEntries,
    });
    process.send?.({ ok: true, result });
  } catch (err: unknown) {
    process.send?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
