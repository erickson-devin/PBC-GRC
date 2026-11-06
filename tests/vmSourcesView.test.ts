import fs from 'node:fs';
import path from 'node:path';
import { CONNECTED_SCANNERS_COPY, SOURCE_STATE_LABEL, latestRunBySource, sourceStatus } from '../src/data/telemetry/vmSourcesView';

/**
 * Connected scanners (field test 0.3.1): the pure status of one VM source (never / ok / stale / failed), plus source checks that the client
 * methods are tenant-wide and that the helper is pure. No server.
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
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const run = (over: Record<string, unknown> = {}) => ({
  status: 'NORMALIZED' as const, error: null, warning: null, hostCount: 4, findingCount: 120, configResultCount: 0, exporterVersion: '0.1.0', ...over,
});

function main() {
  console.log('--- sourceStatus ---');
  const never = sourceStatus({ lastRunAt: null, lastNormalizedAt: null, staleSince: null }, null, NOW);
  assert(never.state === 'never' && never.lastPushAt === null && never.counts === null && never.exporterVersion === null && never.error === null, 'lastRunAt null -> never', never);

  const ok = sourceStatus({ lastRunAt: iso(2 * HOUR), lastNormalizedAt: iso(2 * HOUR), staleSince: null }, run(), NOW);
  assert(ok.state === 'ok' && ok.lastPushAt === iso(2 * HOUR) && ok.exporterVersion === '0.1.0' && ok.error === null, 'a recent NORMALIZED run -> ok', ok);
  assert(ok.counts?.hosts === 4 && ok.counts?.findings === 120 && ok.counts?.configResults === 0, 'the counts come from the latest run', ok.counts);

  const stale = sourceStatus({ lastRunAt: iso(30 * HOUR), lastNormalizedAt: iso(30 * HOUR), staleSince: null }, run(), NOW);
  assert(stale.state === 'stale', 'lastNormalizedAt older than the default 1440 minutes -> stale', stale);
  const fresh = sourceStatus({ lastRunAt: iso(30 * HOUR), lastNormalizedAt: iso(30 * HOUR), staleSince: null }, run(), NOW, 3 * 1440);
  assert(fresh.state === 'ok', 'a longer expected interval keeps the same push ok', fresh);
  const shortInterval = sourceStatus({ lastRunAt: iso(2 * HOUR), lastNormalizedAt: iso(2 * HOUR), staleSince: null }, run(), NOW, 60);
  assert(shortInterval.state === 'stale', 'a short expected interval makes a 2 hour old push stale', shortInterval);
  const oldNormalized = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(48 * HOUR), staleSince: null }, run({ status: 'RECEIVED' }), NOW);
  assert(oldNormalized.state === 'stale', 'staleness is measured from the newest NORMALIZED run, not from receipt', oldNormalized);
  const marked = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(HOUR), staleSince: iso(HOUR) }, run(), NOW);
  assert(marked.state === 'stale', 'a source the server marked stale -> stale', marked);
  const noNormalized = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: null, staleSince: null }, run({ status: 'RECEIVED' }), NOW);
  assert(noNormalized.state === 'ok', 'a run still being processed falls back to its receipt time (ok when recent)', noNormalized);

  const failed = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(30 * HOUR), staleSince: null }, run({ status: 'FAILED', error: 'Run failed while saving' }), NOW);
  assert(failed.state === 'failed' && failed.error === 'Run failed while saving', 'the latest run FAILED -> failed, with the server error text', failed);
  const warned = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(HOUR), staleSince: null }, run({ warning: '2 hosts skipped' }), NOW);
  assert(warned.state === 'ok' && warned.warning === '2 hosts skipped' && warned.error === null, 'a warning does not change the state', warned);
  const okWithOldError = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(HOUR), staleSince: null }, run({ error: 'left over' }), NOW);
  assert(okWithOldError.error === null, 'an error is shown only for a FAILED run', okWithOldError);
  const unknownRun = sourceStatus({ lastRunAt: iso(HOUR), lastNormalizedAt: iso(HOUR), staleSince: null }, null, NOW);
  assert(unknownRun.state === 'ok' && unknownRun.counts === null, 'without the latest run the counts are absent', unknownRun);
  const badInterval = sourceStatus({ lastRunAt: iso(30 * HOUR), lastNormalizedAt: iso(30 * HOUR), staleSince: null }, run(), NOW, 0);
  assert(badInterval.state === 'stale', 'a non-positive interval falls back to the default', badInterval);

  console.log('\n--- latestRunBySource and copy ---');
  const runs = [
    { sourceId: 'a', receivedAt: iso(5 * HOUR), id: 1 },
    { sourceId: 'a', receivedAt: iso(HOUR), id: 2 },
    { sourceId: 'b', receivedAt: iso(9 * HOUR), id: 3 },
  ];
  const latest = latestRunBySource(runs);
  assert(latest.get('a')?.id === 2 && latest.get('b')?.id === 3 && latest.size === 2, 'the newest run of each source wins, in any order', [...latest.entries()]);
  assert(CONNECTED_SCANNERS_COPY.empty === 'No scanner has pushed yet. Set up the exporter below.', 'the empty state text');
  assert(Object.values(SOURCE_STATE_LABEL).every((l) => l.length > 0), 'every state has a label');

  console.log('\n--- source checks ---');
  const helper = read('src/data/telemetry/vmSourcesView.ts');
  const nonTypeImports = helper.split('\n').filter((l) => /^import /.test(l) && !/^import type /.test(l));
  assert(nonTypeImports.length === 0 && !/react|console\.|localStorage|sessionStorage|fetch\(/.test(helper.replace(/\/\*[\s\S]*?\*\//, '')), 'the helper module is pure');
  const api = read('src/services/apiClient.ts');
  assert(/async listVmSources\(tenantId: string\)/.test(api) && /async listVmRuns\(tenantId: string, limit: number\)/.test(api), 'listVmSources(tenantId) and listVmRuns(tenantId, limit)');
  assert(!/(listVmSources|listVmRuns)\([^)]*programId/.test(api), 'the new methods take no programId');
  assert(api.includes('/vm/sources`') && api.includes('/vm/runs?limit='), 'the methods call the tenant sources and runs endpoints');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  process.exit(passed === total ? 0 : 1);
}

main();
