/**
 * Operator script (issue #24): gives every legacy row without a program its tenant's default program, then finalizes program_id
 * (VALIDATE the NOT VALID check, SET NOT NULL, drop the check) on the six legacy tables.
 *
 *   DATABASE_URL=postgres://app_user:...@host:5432/db npm run db:backfill-program-ids -- --all --dry-run
 *   npm run db:backfill-program-ids -- --all                  (every tenant that still has rows without a program)
 *   npm run db:backfill-program-ids -- tenant_a tenant_b      (only these tenants)
 *
 * Normally a tenant is backfilled the first time it is used after the upgrade (server/programs.ts); this covers tenants that are
 * never used. Take a backup first. `--all` finds the tenants with one transaction that lifts FORCE ROW LEVEL SECURITY on the six
 * tables, counts the rows and is ALWAYS rolled back (it holds short ACCESS EXCLUSIVE locks): run it in a quiet window. It never starts
 * the HTTP server. Output is table names, tenant ids, counts and SQLSTATE codes only, never row data or error messages.
 * Exit code 0 = program_id is NOT NULL on all six tables.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = 'Usage: backfillProgramIds.ts [--dry-run] (--all | <tenantId> [<tenantId> ...])';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const explicit = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && a !== '--dry-run' && a !== '--all');
if (unknown.length > 0 || (!all && explicit.length === 0) || explicit.some((id) => !TENANT_ID.test(id))) {
  console.error(USAGE);
  process.exit(2);
}

const { pool, initDb, checkDatabaseConnection } = await import('../server/db');
const { PROGRAM_BACKFILL_TABLES, buildLegacyProgramRowCountSql, buildProgramIdNotNullSql } = await import('../server/schema');
const { migrateTenantToPrograms } = await import('../server/programs');

type Pending = { table: string; tenantId: string; n: number };

/** Rows without a program per table and tenant. FORCE hides every tenant from this role, so it is lifted inside a transaction that is always rolled back. */
async function discoverPending(): Promise<Pending[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of PROGRAM_BACKFILL_TABLES) await client.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    const { rows } = await client.query(buildLegacyProgramRowCountSql());
    return rows.map((r) => ({ table: String(r.table_name), tenantId: String(r.tenant_id), n: Number(r.n) }));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined); // restores FORCE; a dead connection aborts the transaction anyway
    client.release();
  }
}

async function main(): Promise<number> {
  if (!(await checkDatabaseConnection())) {
    console.error('Cannot connect to PostgreSQL; set DATABASE_URL (or DB_HOST/DB_USER/DB_PASS/DB_NAME).');
    return 2;
  }
  await initDb();

  let tenants = explicit;
  if (all) {
    const pending = await discoverPending();
    console.log(`Rows without a program: ${pending.length} table/tenant pair(s)`);
    for (const p of pending) console.log(`  ${p.table} tenant ${p.tenantId} ${p.n}`);
    tenants = [...new Set([...explicit, ...pending.map((p) => p.tenantId)])];
  }

  if (dryRun) {
    console.log(`Dry run: ${tenants.length} tenant(s) would be backfilled; nothing was changed.`);
    return 0;
  }

  for (const id of tenants) {
    if (!TENANT_ID.test(id)) {
      console.error(`  skipped a tenant id that is not a plain identifier`);
      continue;
    }
    try {
      const counts = await migrateTenantToPrograms(id);
      console.log(`  tenant ${id}: adopted ${counts.total} row(s)`);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      console.error(`  tenant ${id}: FAILED code ${e.code ?? 'unknown'}${e.constraint ? ` constraint ${e.constraint}` : ''}`);
    }
  }

  await pool.query(buildProgramIdNotNullSql());

  const state = await pool.query(
    "SELECT c.relname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'program_id' AND c.relname = ANY($1) AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname",
    [[...PROGRAM_BACKFILL_TABLES]]
  );
  const left = await pool.query("SELECT conname FROM pg_constraint WHERE conname LIKE '%\\_program\\_required' AND connamespace = current_schema()::regnamespace ORDER BY conname");
  let finalized = 0;
  for (const t of PROGRAM_BACKFILL_TABLES) {
    const ok = state.rows.find((r) => r.relname === t)?.attnotnull === true;
    if (ok) finalized++;
    console.log(`  ${t}: program_id ${ok ? 'NOT NULL' : 'still nullable'}`);
  }
  for (const r of left.rows) console.log(`  check ${r.conname} still present`);
  console.log(finalized === PROGRAM_BACKFILL_TABLES.length ? 'program_id is finalized on every table.' : 'Some tables still have rows without a program: fix the failures above and run again.');
  return finalized === PROGRAM_BACKFILL_TABLES.length ? 0 : 1;
}

main()
  .catch((err) => {
    // the code only: a database error message can carry row values
    console.error('Unexpected error' + ((err as { code?: string }).code ? ` (code ${(err as { code?: string }).code})` : ''));
    return 1;
  })
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  });
