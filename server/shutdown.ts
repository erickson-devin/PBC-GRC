import type { ProgramScope } from './db';

/**
 * Graceful shutdown (SIGTERM / SIGINT). The orchestration is here with injected dependencies so a pure suite can drive it
 * (tests/shutdown.test.ts); server/index.ts wires the real server, VM scheduler, SSP runner and database pool.
 *
 * No log line carries a tenant, program, file name, person or error message: only the signal, counts and step names.
 */

/** Hard stop: under Docker's default 10 s stop timeout, which would otherwise SIGKILL the container. */
export const SHUTDOWN_DEADLINE_MS = 8_000;
/** How long a cancelled SSP import gets to notice its abort before it is marked CANCELLED here. */
export const SSP_JOB_GRACE_MS = 3_000;
export const SHUTDOWN_CANCEL_MESSAGE = 'The server was shut down while this import was running. Upload the document again.';
/** Written to a VM run the shutdown interrupted (the run becomes FAILED; there is no separate status). */
export const VM_SHUTDOWN_MESSAGE = 'The server was shut down while this run was being processed. The scanner\'s next push sends the data again; an owner can also reprocess this run.';

// The runner keeps its active set private, so the routes register every job they start (or recover) here.
const sspJobs = new Map<string, ProgramScope>();

export function trackSspJob(jobId: string, scope: ProgramScope): void {
  sspJobs.set(jobId, scope);
}

/** The registered jobs that are still running; finished ones are dropped from the registry. */
export function trackedSspJobs(isActive: (id: string) => boolean): Array<{ id: string; scope: ProgramScope }> {
  const out: Array<{ id: string; scope: ProgramScope }> = [];
  for (const [id, scope] of [...sspJobs]) {
    if (isActive(id)) out.push({ id, scope });
    else sspJobs.delete(id);
  }
  return out;
}

export function __resetShutdownForTests(): void {
  sspJobs.clear();
}

export interface ShutdownDeps {
  closeServer(): Promise<void>;
  forceCloseConnections(): void;
  stopScheduler(): void;
  activeSspJobs(): Array<{ id: string; scope: ProgramScope }>;
  cancelSspJob(scope: ProgramScope, id: string): Promise<unknown>;
  isSspJobActive(id: string): boolean;
  markSspJobCancelled(scope: ProgramScope, id: string): Promise<unknown>;
  activeVmRuns(): Array<{ id: string; tenantId: string }>;
  abortVmRuns(): void;
  isVmRunActive(id: string): boolean;
  markVmRunInterrupted(tenantId: string, id: string): Promise<unknown>;
  closePool(): Promise<void>;
  log(line: string): void;
  exit(code: number): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createShutdown(
  deps: ShutdownDeps,
  opts: { deadlineMs?: number; jobGraceMs?: number; pollMs?: number } = {},
): (signal: string) => Promise<void> {
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const jobGraceMs = opts.jobGraceMs ?? SSP_JOB_GRACE_MS;
  const pollMs = opts.pollMs ?? 50;
  let running: Promise<void> | null = null;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  const run = async (signal: string): Promise<void> => {
    let failed = false;
    const step = async (name: string, fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err: unknown) {
        failed = true;
        deps.log(`[Shutdown] ${name} failed (${err instanceof Error ? err.name : typeof err})`);
      }
    };

    const deadline = setTimeout(() => {
      try { deps.forceCloseConnections(); } catch { /* the exit below is what matters */ }
      deps.log(`[Shutdown] deadline of ${deadlineMs / 1000} s reached: forcing exit`);
      exitOnce(1);
    }, deadlineMs);

    let jobs: Array<{ id: string; scope: ProgramScope }> = [];
    await step('list SSP imports', () => { jobs = deps.activeSspJobs(); });
    let vmRuns: Array<{ id: string; tenantId: string }> = [];
    await step('list VM runs', () => { vmRuns = deps.activeVmRuns(); });
    deps.log(`[Shutdown] ${signal} received: closing (${jobs.length} SSP import(s) to cancel, ${vmRuns.length} VM run(s) to stop)`);

    await step('stop scheduler', () => deps.stopScheduler());
    let closed: Promise<void> = Promise.resolve();
    await step('close server', () => { closed = deps.closeServer(); });
    // A rejection of the close promise is reported where it is awaited below
    closed.catch(() => undefined);

    for (const j of jobs) await step('cancel SSP import', () => deps.cancelSspJob(j.scope, j.id));
    if (vmRuns.length) await step('stop VM runs', () => deps.abortVmRuns());

    // The worker only checks its abort signal between stages, so give it a moment, then mark the stragglers here.
    const graceEnds = Date.now() + jobGraceMs;
    const anyActive = (): boolean => jobs.some((j) => deps.isSspJobActive(j.id)) || vmRuns.some((r) => deps.isVmRunActive(r.id));
    while (anyActive() && Date.now() < graceEnds) await sleep(pollMs);
    for (const j of jobs) {
      if (deps.isSspJobActive(j.id)) await step('mark SSP import cancelled', () => deps.markSspJobCancelled(j.scope, j.id));
    }
    // Only a run that was being processed changes (store.markRunInterrupted); one still queued stays RECEIVED.
    for (const r of vmRuns) {
      if (deps.isVmRunActive(r.id)) await step('mark VM run interrupted', () => deps.markVmRunInterrupted(r.tenantId, r.id));
    }

    await step('close server', () => Promise.race([closed, sleep(deadlineMs)]));
    await step('close connections', () => deps.forceCloseConnections());
    await step('close database pool', () => deps.closePool());

    clearTimeout(deadline);
    deps.log('[Shutdown] complete');
    exitOnce(failed ? 1 : 0);
  };

  return (signal: string): Promise<void> => {
    if (running) {
      deps.log(`[Shutdown] ${signal} received again: already shutting down`);
      return running;
    }
    running = run(signal);
    return running;
  };
}

export function installSignalHandlers(handler: (signal: string) => unknown, proc: Pick<NodeJS.EventEmitter, 'on'> = process): void {
  for (const signal of ['SIGTERM', 'SIGINT']) proc.on(signal, () => { void handler(signal); });
}
