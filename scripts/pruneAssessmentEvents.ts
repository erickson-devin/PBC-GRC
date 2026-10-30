/**
 * Operator script (issue #53): deletes the control change history older than the retention period, once, now.
 *
 *   DATABASE_URL=postgres://app_user:...@host:5432/db npm run db:prune-assessment-events -- --dry-run
 *   npm run db:prune-assessment-events                          (ASSESSMENT_EVENT_RETENTION_DAYS, default 1095)
 *   npm run db:prune-assessment-events -- --days 730            (override the retention)
 *   npm run db:prune-assessment-events -- --tenant acme --tenant globex
 *   npm run db:prune-assessment-events -- --include-deleted-programs --dry-run   (also the history of deleted programs)
 *
 * Covers control_assessment_events and control_objective_events. The server runs the same sweep daily; this is for a first catch-up
 * or a one-off, and is safe to run beside it. Take a backup first: deleted events cannot be restored. It never starts the HTTP
 * server. The daily sweep never reaches the history of a deleted program (it lists programs); --include-deleted-programs also runs
 * that operator pass (issue #150), after the normal sweep, with the same --days, --tenant and --dry-run. Finding those events briefly
 * locks the two history tables (lock timeout 5 s), so run it in a quiet window. Output is counts, tenant ids and SQLSTATE codes only,
 * never notes or error messages. Exit code 0 = no error.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = 'Usage: pruneAssessmentEvents.ts [--dry-run] [--days N] [--tenant <id> ...] [--include-deleted-programs]';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

let dryRun = false;
let includeDeleted = false;
let days: number | undefined;
const tenants: string[] = [];
let usageError = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--include-deleted-programs') includeDeleted = true;
  else if (a === '--days') {
    const v = args[++i];
    if (v !== undefined && /^\d{1,5}$/.test(v)) days = Number(v);
    else usageError = true;
  } else if (a === '--tenant') {
    const v = args[++i];
    if (v !== undefined && TENANT_ID.test(v)) tenants.push(v);
    else usageError = true;
  } else usageError = true;
}
if (usageError) {
  console.error(USAGE);
  process.exit(2);
}

const { initDb, checkDatabaseConnection, pool } = await import('../server/db');
const { getAssessmentEventRetention, pruneAssessmentEvents, pruneDeletedProgramEvents, describeRetention } = await import('../server/assessmentEventRetention');

async function main(): Promise<number> {
  if (!(await checkDatabaseConnection())) {
    console.error('Cannot connect to PostgreSQL; set DATABASE_URL (or DB_HOST/DB_USER/DB_PASS/DB_NAME).');
    return 2;
  }
  await initDb();

  const cfg = getAssessmentEventRetention();
  const effective = days ?? cfg.days;
  console.log(describeRetention({ ...cfg, days: effective }));
  if (cfg.warning && days === undefined) console.warn(cfg.warning);
  if (effective === 0) {
    console.log('Retention is 0 (keep forever): nothing to delete.');
    return 0;
  }

  const onlyTenantIds = tenants.length > 0 ? tenants : undefined;
  const result = await pruneAssessmentEvents({ days: effective, dryRun, onlyTenantIds });
  if (result.skipped) {
    console.log('Another sweep is already running: nothing done.');
    return 1;
  }
  const verb = dryRun ? 'would delete' : 'deleted';
  console.log(`control_assessment_events: ${verb} ${result.deleted} row(s) older than ${effective} days`);
  console.log(`control_objective_events: ${verb} ${result.deletedObjectives} row(s) older than ${effective} days`);
  console.log(`${result.scopes} program(s) swept, ${result.errors} error(s)${dryRun ? '; dry run, nothing was changed' : ''}`);
  let errors = result.errors;
  if (includeDeleted) {
    const orphans = await pruneDeletedProgramEvents({ days: effective, dryRun, onlyTenantIds });
    if (orphans.skipped) {
      console.log('Deleted programs: nothing done (another sweep is running, or the in-memory store is in use).');
      return 1;
    }
    console.log(`deleted programs: ${verb} ${orphans.deleted} control_assessment_events and ${orphans.deletedObjectives} control_objective_events row(s) older than ${effective} days in ${orphans.scopes} deleted program(s), ${orphans.errors} error(s)`);
    errors += orphans.errors;
  }
  return errors > 0 ? 1 : 0;
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
