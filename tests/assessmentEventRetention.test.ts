import './testEnv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ASSESSMENT_EVENT_RETENTION_DAYS,
  describeRetention,
  getAssessmentEventRetention,
  pruneAssessmentEvents,
  retentionCutoff,
  startAssessmentEventRetention,
  stopAssessmentEventRetention,
} from '../server/assessmentEventRetention';
import { __resetControlAssessmentEventsForTests, listControlAssessmentEvents, writeControlAssessment } from '../server/controlAssessments';
import { __resetControlObjectivesForTests, listObjectiveEvents, writeObjective } from '../server/controlObjectives';

/**
 * Retention of the control change history (#53): the setting, the cutoff arithmetic, and the sweep over both event tables in the in-memory
 * store (scopes, the strict cutoff, dry run, tenant filter, batches, re-entrancy, nothing sensitive logged). Pure suite: no server, no port.
 * The PostgreSQL side (the SELECT-only programs policy, the per-program DELETE) is checked by db:verify-rls and tests/dbSchema.test.ts.
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

const DAY = 24 * 3_600_000;
const SECRET = 'RET-SECRET-NOTES';
const A = { tenantId: 'ret_t1', programId: 'ret_p1' };
const B = { tenantId: 'ret_t2', programId: 'ret_p2' };
const CONTROL = 'AC.L1-3.1.1';
const OBJECTIVE = 'AC.L1-3.1.1[a]';
const WHO = { source: 'human' as const, actor: 'ret_actor', userId: null };

/** Resets both histories, writes 3 control changes (and 3 objective changes) in A and 2 in B; returns every event's createdAt. */
async function seed(): Promise<{ all: number[]; a: number; b: number }> {
  __resetControlAssessmentEventsForTests();
  __resetControlObjectivesForTests();
  for (let i = 0; i < 3; i++) {
    await writeControlAssessment(A, CONTROL, () => ({ status: 'IN_PROGRESS', notes: `${SECRET} A ${i}`, role: null, updatedBy: 'ret' }), WHO);
    await writeObjective(A, { objectiveId: OBJECTIVE, controlId: CONTROL, narrative: `${SECRET} A ${i}` }, WHO);
  }
  for (let i = 0; i < 2; i++) {
    await writeControlAssessment(B, CONTROL, () => ({ status: 'IN_PROGRESS', notes: `${SECRET} B ${i}`, role: null, updatedBy: 'ret' }), WHO);
    await writeObjective(B, { objectiveId: OBJECTIVE, controlId: CONTROL, narrative: `${SECRET} B ${i}` }, WHO);
  }
  const ea = await listControlAssessmentEvents(A, CONTROL, 100);
  const eb = await listControlAssessmentEvents(B, CONTROL, 100);
  return { all: [...ea, ...eb].map((e) => Date.parse(e.createdAt)), a: ea.length, b: eb.length };
}

const counts = async () => ({
  a: (await listControlAssessmentEvents(A, CONTROL, 100)).length,
  b: (await listControlAssessmentEvents(B, CONTROL, 100)).length,
  oa: (await listObjectiveEvents(A, OBJECTIVE, 100)).length,
  ob: (await listObjectiveEvents(B, OBJECTIVE, 100)).length,
});

async function run() {
  console.log('--- S53-01-S53-05: the setting and the cutoff ---');
  const d = getAssessmentEventRetention({} as NodeJS.ProcessEnv);
  assert(d.days === 1095 && d.days === DEFAULT_ASSESSMENT_EVENT_RETENTION_DAYS && d.source === 'default' && d.warning === null, 'S53-01 unset -> 1095 days, source default, no warning', d);
  const zero = getAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv);
  assert(zero.days === 0 && zero.source === 'env' && describeRetention(zero).includes('kept forever') && describeRetention(d).includes('1095 days'), 'S53-02 0 keeps everything and says so', [zero, describeRetention(zero)]);
  const y = getAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '365' } as NodeJS.ProcessEnv);
  const short = getAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv);
  assert(y.days === 365 && y.warning === null && short.days === 30 && String(short.warning).includes('shorter than 365'), 'S53-03 365 has no warning; 30 days warns it is shorter than 365', [y, short]);
  const bad = ['abc', '-5', '1.5'].map((v) => getAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: v } as NodeJS.ProcessEnv));
  const empty = getAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '' } as NodeJS.ProcessEnv);
  assert(bad.every((b) => b.days === 0 && b.source === 'invalid' && b.warning !== null) && empty.days === 1095 && empty.source === 'default', 'S53-04 abc, -5 and 1.5 keep the history (days 0, invalid, warning); an empty value is the default', [bad, empty]);
  assert(retentionCutoff(new Date('2026-10-30T00:00:00Z'), 1095)?.toISOString() === '2023-10-31T00:00:00.000Z' && retentionCutoff(new Date(), 0) === null, 'S53-05 the cutoff is now minus the days; 0 days has none', retentionCutoff(new Date('2026-10-30T00:00:00Z'), 1095));

  console.log('\n--- S53-06-S53-11: the sweep in the in-memory store ---');
  const s = await seed();
  const minAt = Math.min(...s.all);
  const maxAt = Math.max(...s.all);
  assert(s.a === 3 && s.b === 2, 'setup: 3 control events in A and 2 in B (and as many objective events)', s);

  const r6 = await pruneAssessmentEvents({ now: new Date(maxAt + 1094 * DAY), days: 1095 });
  assert(!r6.skipped && r6.deleted === 0 && r6.deletedObjectives === 0 && r6.errors === 0 && same(await counts(), { a: 3, b: 2, oa: 3, ob: 2 }), 'S53-06 events younger than the retention are kept', [r6, await counts()]);

  const r7a = await pruneAssessmentEvents({ now: new Date(minAt + 1095 * DAY), days: 1095 });
  assert(r7a.deleted === 0 && same(await counts(), { a: 3, b: 2, oa: 3, ob: 2 }), 'S53-07 an event exactly as old as the retention is kept (the cutoff is strict)', r7a);
  const due = s.all.filter((t) => t < minAt + 1).length;
  const r7b = await pruneAssessmentEvents({ now: new Date(minAt + 1095 * DAY + 1), days: 1095 });
  const left = await counts();
  assert(r7b.deleted === due && left.a + left.b === 5 - due, 'S53-07 one millisecond later exactly the events created before the cutoff go', [r7b, due, left]);

  const s8 = await seed();
  const r8 = await pruneAssessmentEvents({ now: new Date(Date.now() + 5000 * DAY), days: 0 });
  assert(r8.skipped === true && r8.deleted === 0 && same(await counts(), { a: 3, b: 2, oa: 3, ob: 2 }) && s8.all.length === 5, 'S53-08 days 0 (keep forever) is skipped and deletes nothing', r8);

  const far = new Date(Date.now() + 5000 * DAY);
  const r9 = await pruneAssessmentEvents({ now: far, days: 1095, dryRun: true });
  assert(r9.deleted === 5 && r9.deletedObjectives === 5 && same(await counts(), { a: 3, b: 2, oa: 3, ob: 2 }), 'S53-09 a dry run counts every due event and deletes none', [r9, await counts()]);

  const r10 = await pruneAssessmentEvents({ now: far, days: 1095, onlyTenantIds: ['ret_t1'] });
  assert(r10.deleted === 3 && r10.deletedObjectives === 3 && same(await counts(), { a: 0, b: 2, oa: 0, ob: 2 }), 'S53-10 onlyTenantIds empties tenant ret_t1 and leaves ret_t2 alone', [r10, await counts()]);

  await seed();
  const r11 = await pruneAssessmentEvents({ now: far, days: 1095, batchSize: 2 });
  assert(r11.deleted === 5 && r11.deletedObjectives === 5 && same(await counts(), { a: 0, b: 0, oa: 0, ob: 0 }), 'S53-11 a small batch size still deletes everything due', [r11, await counts()]);

  console.log('\n--- S53-12-S53-13: re-entrancy and logging ---');
  await seed();
  const both = await Promise.all([pruneAssessmentEvents({ now: far, days: 1095 }), pruneAssessmentEvents({ now: far, days: 1095 })]);
  assert(both.filter((r) => r.skipped).length === 1 && both.filter((r) => !r.skipped).length === 1 && both.reduce((n, r) => n + r.deleted, 0) === 5, 'S53-12 two sweeps started together: exactly one is skipped, the other deletes everything once', both);

  await seed();
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(' ')); };
  console.log = grab; console.warn = grab; console.error = grab;
  try {
    await pruneAssessmentEvents({ now: far, days: 1095 });
  } finally {
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
  }
  assert(lines.length > 0 && lines.every((l) => !l.includes(SECRET) && !l.includes('ret_actor')), 'S53-13 the sweep logs counts only: no notes, no names', lines);
  assert(lines.some((l) => l.startsWith('[Retention] control_assessment_events: deleted 5 row(s) older than 1095 days')), 'S53-13 the log line names the table and the count', lines);

  console.log('\n--- S53-14: start and stop ---');
  const first = startAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv);
  const second = startAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv);
  stopAssessmentEventRetention();
  const third = startAssessmentEventRetention({ ASSESSMENT_EVENT_RETENTION_DAYS: '0' } as NodeJS.ProcessEnv);
  stopAssessmentEventRetention();
  assert(first?.days === 30 && second === null && third?.days === 0, 'S53-14 start returns the setting once; a second start returns null; after stop it can start again', [first, second, third]);

  console.log('\n--- S53-15: wiring ---');
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
  const index = read('server/index.ts');
  const pkg = read('package.json');
  assert(index.includes('startAssessmentEventRetention(') && index.includes('stopAssessmentEventRetention()'), 'S53-15 server/index.ts starts the sweep and stops it on shutdown');
  assert(pkg.includes('"db:prune-assessment-events"') && pkg.includes('"test:event-retention"'), 'S53-15 package.json has db:prune-assessment-events and test:event-retention');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('================================================================\n');
  process.exit(passed === total ? 0 : 1);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});
