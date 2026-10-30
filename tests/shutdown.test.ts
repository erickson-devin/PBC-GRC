import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import {
  SHUTDOWN_CANCEL_MESSAGE,
  SHUTDOWN_DEADLINE_MS,
  __resetShutdownForTests,
  createShutdown,
  installSignalHandlers,
  trackSspJob,
  trackedSspJobs,
  type ShutdownDeps,
} from '../server/shutdown';

/**
 * Graceful shutdown (#44). Pure suite: the orchestration runs against fakes, so there is no server, no port and no real
 * signal. The wiring in server/index.ts, server/routes/sspImports.ts and docker-compose.yml is checked textually.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const OPTS = { deadlineMs: 300, jobGraceMs: 40, pollMs: 5 };
const SCOPE = { tenantId: 'tenant-secret-xyz', programId: 'prog-secret-xyz' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Rig {
  calls: string[];
  logs: string[];
  exits: number[];
  counts: { force: number; closeServer: number; closePool: number; mark: number };
  marked: Array<{ id: string; scope: unknown }>;
  deps: ShutdownDeps;
}

/** Fakes for one run. `stuck`: the job never finishes by itself. `closeServerNever` / `poolError` shape the failure cases. */
function rig(o: { jobs?: boolean; stuck?: boolean; closeServerNever?: boolean; poolError?: Error; poolDelayMs?: number } = {}): Rig {
  const r: Rig = { calls: [], logs: [], exits: [], counts: { force: 0, closeServer: 0, closePool: 0, mark: 0 }, marked: [], deps: undefined as unknown as ShutdownDeps };
  let cancelled = false;
  r.deps = {
    closeServer: () => { r.calls.push('closeServer'); r.counts.closeServer++; return o.closeServerNever ? new Promise<void>(() => undefined) : Promise.resolve(); },
    forceCloseConnections: () => { r.counts.force++; },
    stopScheduler: () => { r.calls.push('stopScheduler'); },
    activeSspJobs: () => (o.jobs === false ? [] : [{ id: 'j1', scope: SCOPE }]),
    cancelSspJob: async (_scope, id) => { r.calls.push(`cancel:${id}`); cancelled = true; return true; },
    isSspJobActive: () => (o.stuck ? true : !cancelled),
    markSspJobCancelled: async (scope, id) => { r.counts.mark++; r.marked.push({ id, scope }); },
    closePool: async () => {
      r.calls.push('closePool');
      r.counts.closePool++;
      if (o.poolDelayMs) await sleep(o.poolDelayMs);
      if (o.poolError) throw o.poolError;
    },
    log: (line) => { r.logs.push(line); },
    exit: (code) => { r.calls.push(`exit:${code}`); r.exits.push(code); },
  };
  return r;
}

async function main() {
  console.log('\n--- S44-1: a job that stops on cancel ---');
  __resetShutdownForTests();
  const a = rig();
  await createShutdown(a.deps, OPTS)('SIGTERM');
  assert(JSON.stringify(a.calls) === JSON.stringify(['stopScheduler', 'closeServer', 'cancel:j1', 'closePool', 'exit:0']), 'scheduler stops, server closes, the job is cancelled, the pool closes, exit 0', a.calls);
  assert(a.counts.mark === 0, 'a job that stopped by itself is not marked cancelled');

  console.log('\n--- S44-2: a job that does not stop ---');
  __resetShutdownForTests();
  const b = rig({ stuck: true });
  await createShutdown(b.deps, OPTS)('SIGTERM');
  assert(b.counts.mark === 1 && b.marked[0].id === 'j1' && JSON.stringify(b.marked[0].scope) === JSON.stringify(SCOPE), 'a job still active after the grace period is marked cancelled once, with its scope', b.marked);
  assert(b.exits.length === 1 && b.exits[0] === 0, 'a clean run still exits 0', b.exits);

  console.log('\n--- S44-3: a second signal ---');
  __resetShutdownForTests();
  const c = rig();
  const handler = createShutdown(c.deps, OPTS);
  const p1 = handler('SIGTERM');
  const p2 = handler('SIGINT');
  await p1;
  assert(p1 === p2, 'a second signal returns the same promise');
  assert(c.counts.closeServer === 1 && c.counts.closePool === 1 && c.exits.length === 1, 'closeServer, closePool and exit each run exactly once', { c: c.counts, e: c.exits });
  assert(c.logs.some((l) => l.includes('SIGINT') && l.includes('already shutting down')), 'the repeat is logged');

  console.log('\n--- S44-4: the server never closes ---');
  __resetShutdownForTests();
  const d = rig({ closeServerNever: true });
  const started = Date.now();
  const pd = createShutdown(d.deps, OPTS)('SIGTERM');
  await sleep(OPTS.deadlineMs + 150);
  assert(d.exits.length === 1 && d.exits[0] === 1, 'the deadline forces exit 1, once', d.exits);
  assert(d.counts.force >= 1, 'open connections are force-closed');
  assert(Date.now() - started >= OPTS.deadlineMs - 20, 'it waited for the deadline first');
  await pd;
  await sleep(30);
  assert(d.exits.length === 1, 'the run finishing after the deadline does not exit again', d.exits);

  console.log('\n--- S44-5: the pool fails to close ---');
  __resetShutdownForTests();
  const e = rig({ poolError: new Error('password=hunter2 host=db') });
  await createShutdown(e.deps, OPTS)('SIGTERM');
  assert(e.exits.length === 1 && e.exits[0] === 1, 'a failed step exits 1', e.exits);
  assert(e.logs.every((l) => !l.includes('hunter2')), 'no log line carries the error message', e.logs);
  assert(e.logs.some((l) => l.includes('Error')), 'the failure is logged by error name', e.logs);

  console.log('\n--- S44-6: log lines carry no identifiers ---');
  const all = [...a.logs, ...b.logs];
  assert(all.every((l) => !l.includes('tenant-secret-xyz') && !l.includes('prog-secret-xyz')), 'no log line contains a tenant or program id', all);
  assert(a.logs[0].includes('SIGTERM') && a.logs[0].includes('1 SSP import'), 'the first line names the signal and the job count', a.logs[0]);

  console.log('\n--- S44-7: the job registry ---');
  __resetShutdownForTests();
  const s = { tenantId: 't', programId: 'p' };
  trackSspJob('a', s);
  trackSspJob('b', s);
  assert(JSON.stringify(trackedSspJobs((id) => id === 'a')) === JSON.stringify([{ id: 'a', scope: s }]), 'only active jobs are listed');
  assert(JSON.stringify(trackedSspJobs(() => true)) === JSON.stringify([{ id: 'a', scope: s }]), 'an inactive job was dropped from the registry');

  console.log('\n--- S44-8: signal handlers ---');
  const em = new EventEmitter();
  const got: string[] = [];
  installSignalHandlers((sig) => { got.push(sig); }, em);
  em.emit('SIGTERM');
  em.emit('SIGINT');
  assert(JSON.stringify(got) === JSON.stringify(['SIGTERM', 'SIGINT']), 'SIGTERM and SIGINT reach the handler', got);

  console.log('\n--- S44-9: wiring ---');
  const index = read('server/index.ts');
  assert(index.includes('installSignalHandlers(createShutdown(') && index.includes("from './shutdown'") && index.includes('stopVmScheduler') && index.includes('pool.end()'), 'server/index.ts installs the handlers with the scheduler and pool wired');
  const routes = read('server/routes/sspImports.ts');
  assert((routes.match(/trackSspJob\(/g) ?? []).length >= 2, 'the SSP routes register the jobs they start or recover');
  assert(!read('server/shutdown.ts').includes('console.'), 'server/shutdown.ts does not log by itself');

  console.log('\n--- S44-10: constants ---');
  assert(SHUTDOWN_DEADLINE_MS < 10_000, 'the deadline is under the Docker stop timeout', SHUTDOWN_DEADLINE_MS);
  assert(/^The server was shut down/.test(SHUTDOWN_CANCEL_MESSAGE), 'the cancel message says why');

  console.log('\n--- S44-11: compose ---');
  const compose = read('docker-compose.yml');
  const start = compose.indexOf('\n  singularity-app:');
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:/);
  const block = next < 0 ? rest : rest.slice(0, next + 1);
  assert(start >= 0 && /^ {4}init: true\s*$/m.test(block), 'the app service runs with init: true');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Suite crashed:', err instanceof Error ? err.name : typeof err);
  process.exit(1);
});
