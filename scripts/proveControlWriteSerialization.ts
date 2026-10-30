/**
 * Live proof that control writes serialize on SELECT ... FOR UPDATE, against a REAL PostgreSQL database (issue #54).
 *
 *   DATABASE_URL=postgres://<app role>@host/db npm run db:prove-control-serialization
 *   (or: npx tsx --env-file=.env.proof scripts/proveControlWriteSerialization.ts)
 *
 * Why it exists: the in-memory store the test suites use cannot block, so only a live database can show that a second writer
 * waits for the first one's row lock, then composes from the first writer's committed answer. Run it as the ordinary
 * application role (not a superuser and not BYPASSRLS), against a throwaway database. It is NOT part of test:all: concurrency
 * is timing-dependent by nature. The verdict rests on pg_stat_activity (the second writer is waiting on a lock) and on the
 * event hash chain (each event's old notes hash is the previous event's new notes hash), not on sleeps.
 *
 * Phase 1: writer A holds the row lock inside its transaction, writer B starts and must block before reading the row; after A
 * commits B sees A's notes. Phase 2: the same race with an expectedUpdatedAt (issue #70): B must be refused as a stale write.
 * Uses one scratch tenant ("serial_proof_...") and removes it afterwards. Prints only ids, counts, milliseconds and SQLSTATE
 * codes, never notes text. Exit code 0 = all checks passed.
 */
// Type-only (erased at run time): the Express Request augmentation (req.tenantId) lives here, and modules imported below need it
// when this script is type-checked on its own.
import type {} from '../server/middleware/authMiddleware';

export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { randomBytes } = await import('crypto');
const { pool, initDb, queryWithTenant, queryWithProgram, checkDatabaseConnection } = await import('../server/db');
const { writeControlAssessment, readControlAssessments, listControlAssessmentEvents, checkExpectedUpdatedAt, notesDigest } = await import('../server/controlAssessments');
const { ensureDefaultProgram } = await import('../server/programs');
type ControlAssessment = import('../server/controlAssessments').ControlAssessment;
type PoolClient = import('pg').PoolClient;

let failures = 0;
function check(ok: boolean, message: string, detail?: string) {
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}: ${message}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
}

const TENANT = 'serial_proof_' + randomBytes(3).toString('hex');
const CONTROL = 'AC.L1-3.1.1';
const who = (name: string) => ({ source: 'human' as const, actor: `serial-proof-${name}`, userId: null });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const digest = (s: string) => notesDigest(s).sha256;

/** Polls pg_stat_activity (from a third connection) until `pid` waits on a lock: true, false (never did) or null (the role cannot see it). */
async function waitsOnLock(pid: number): Promise<boolean | null> {
  let sawRow = false;
  for (let waited = 0; waited <= 5000; waited += 50) {
    const res = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (res.rows.length) {
      sawRow = true;
      if (res.rows[0].wait_event_type === 'Lock') return true;
    }
    await sleep(50);
  }
  return sawRow ? false : null;
}

/** Reports the pg_stat_activity result of a blocked writer. */
function reportWait(waits: boolean | null, label: string) {
  if (waits === null) console.log(`  WARN: pg_stat_activity shows nothing for ${label} (this role cannot see it); the hash-chain checks decide`);
  else check(waits, `${label} waits on a lock while A holds the row`);
}

let cA: PoolClient | null = null;
let cB: PoolClient | null = null;
let scope: { tenantId: string; programId: string } | null = null;

try {
  await checkDatabaseConnection();
  await initDb();
  await queryWithTenant(
    TENANT,
    `INSERT INTO tenants (id, name, system_name, system_owner) VALUES ($1, $2, 'sys', 'owner') ON CONFLICT (id) DO NOTHING`,
    [TENANT, TENANT]
  );
  scope = { tenantId: TENANT, programId: (await ensureDefaultProgram(TENANT)).id };
  const s = scope;
  console.log(`scratch tenant ${TENANT}, program ${s.programId}, control ${CONTROL}`);

  // seed: the first write of the control
  await writeControlAssessment(s, CONTROL, () => ({ status: null, notes: 'seed', role: null, updatedBy: 'serial-proof' }), who('seed'));

  cA = await pool.connect();
  cB = await pool.connect();
  const pidB = Number((await cB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // writeControlAssessment sets app.current_tenant_id / app.current_program_id itself (set_config(..., true), transaction-local)
  // on the caller's client, so a BEGIN on the client is all the GUC setup these transactions need.

  // ---- Phase 1: serialization ----
  console.log('\nPhase 1: a second writer waits for the first one\'s row lock');
  await cA.query('BEGIN');
  await writeControlAssessment(s, CONTROL, () => ({ status: null, notes: 'A', role: null, updatedBy: 'serial-proof' }), who('A'), cA); // holds the row lock
  await cB.query('BEGIN');
  let bSaw: ControlAssessment | null | undefined;
  const bWrite = writeControlAssessment(
    s,
    CONTROL,
    (cur) => {
      bSaw = cur;
      return { status: null, notes: (cur?.notes ?? '') + '+B', role: null, updatedBy: 'serial-proof' };
    },
    who('B'),
    cB
  );
  bWrite.catch(() => undefined); // observed below; avoids an unhandled rejection while we poll
  reportWait(await waitsOnLock(pidB), 'B');
  check(bSaw === undefined, 'B has not read the row yet');
  await sleep(500);
  const tCommitA = Date.now();
  await cA.query('COMMIT');
  await bWrite;
  const tBDone = Date.now();
  await cB.query('COMMIT');

  check(tBDone >= tCommitA, 'B finished only after A committed', `${tBDone - tCommitA} ms`);
  check(bSaw?.notes === 'A', "B composed from A's committed notes");
  const finalRow = (await readControlAssessments(s)).get(CONTROL);
  check(finalRow?.notes === 'A+B', 'final notes are A+B (no lost update)');
  const ev1 = await listControlAssessmentEvents(s, CONTROL, 10);
  const [evB, evA, evSeed] = ev1;
  check(ev1.length === 3, 'three events recorded (seed, A, B)', `${ev1.length} events`);
  check(
    !!evB && !!evA && !!evSeed && evB.oldNotesSha256 === evA.newNotesSha256 && evA.newNotesSha256 === digest('A') && evA.oldNotesSha256 === digest('seed'),
    'event hash chain is B <- A <- seed'
  );
  check(!!evA && !!evB && evA.createdAt <= evB.createdAt, "A's event is not later than B's");

  // ---- Phase 2: a stale expectedUpdatedAt under concurrency (#70) ----
  console.log('\nPhase 2: a stale expectedUpdatedAt is refused under concurrency');
  const u1 = finalRow?.updatedAt ?? null;
  const eventsBefore = (await listControlAssessmentEvents(s, CONTROL, 100)).length;
  await cA.query('BEGIN');
  await writeControlAssessment(
    s,
    CONTROL,
    (cur) => {
      checkExpectedUpdatedAt(cur, u1);
      return { status: null, notes: 'A2', role: null, updatedBy: 'serial-proof' };
    },
    who('A'),
    cA
  );
  await cB.query('BEGIN');
  const bWrite2 = writeControlAssessment(
    s,
    CONTROL,
    (cur) => {
      checkExpectedUpdatedAt(cur, u1);
      return { status: null, notes: 'B2', role: null, updatedBy: 'serial-proof' };
    },
    who('B'),
    cB
  );
  let bErr: unknown = null;
  const bDone2 = bWrite2.then(
    () => undefined,
    (err) => {
      bErr = err;
    }
  );
  reportWait(await waitsOnLock(pidB), 'B');
  await sleep(500);
  await cA.query('COMMIT');
  await bDone2;
  await cB.query('ROLLBACK');

  const stale = bErr as { code?: string; current?: { updatedAt: string | null } } | null;
  check(stale?.code === 'stale_write', 'B is refused with stale_write', stale ? `code ${String(stale.code)}` : 'B was not refused');
  check(!!stale?.current && stale.current.updatedAt !== u1, "the refusal carries the newer updatedAt, not the one B expected");
  const finalRow2 = (await readControlAssessments(s)).get(CONTROL);
  check(finalRow2?.notes === 'A2', "the stored notes are A's, B's write did not land");
  const eventsAfter = (await listControlAssessmentEvents(s, CONTROL, 100)).length;
  check(eventsAfter === eventsBefore + 1, 'exactly one new event (A\'s)', `${eventsAfter - eventsBefore} new`);

  if (failures === 0) {
    console.log(`\nVerdict: control writes serialize on FOR UPDATE (B waited ${tBDone - tCommitA} ms for A's commit); a stale expectedUpdatedAt is refused under concurrency.`);
  }
} catch (err) {
  const e = err as { name?: string; code?: string };
  console.log(`  ✗ FAIL: unexpected error ${e?.name ?? 'Error'}${e?.code ? ` (SQLSTATE/code ${e.code})` : ''}`);
  failures++;
} finally {
  for (const c of [cA, cB]) {
    if (!c) continue;
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
  if (scope) {
    const s = scope;
    await queryWithProgram(s, 'DELETE FROM control_assessment_events WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await queryWithProgram(s, 'DELETE FROM control_assessments WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await queryWithTenant(TENANT, 'DELETE FROM programs WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await queryWithTenant(TENANT, 'DELETE FROM tenants WHERE id = $1', [TENANT]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
}

if (failures > 0) console.log(`\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
