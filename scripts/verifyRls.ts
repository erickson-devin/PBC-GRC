/**
 * Live Row-Level Security verification against a REAL PostgreSQL database.
 *
 *   DATABASE_URL=postgres://app_user:...@host:5432/db npm run db:verify-rls
 *   (or the DB_HOST / DB_USER / DB_PASS / DB_NAME variables the server uses)
 *
 * Runs initDb(), then proves:
 *   1. every tenant-bound table has RLS enabled AND forced (so even the table owner is subject to it);
 *   2. the connecting role can be subject to RLS at all (superusers and BYPASSRLS roles always bypass it);
 *   3. with no tenant context a query sees zero rows, with a tenant context it sees only that tenant's rows,
 *      and a write for a different tenant is rejected.
 * It inserts and removes a few rows prefixed "rls_verify_" in tenant_users. Exit code 0 = all checks passed.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { pool, initDb, queryWithTenant, checkDatabaseConnection } = await import('../server/db');
const { RLS_TENANT_TABLES } = await import('../server/schema');

let failures = 0;
function check(ok: boolean, message: string, detail?: string) {
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}: ${message}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
}

const TENANT_X = 'rls_verify_tenant_x';
const TENANT_Y = 'rls_verify_tenant_y';

async function main() {
  if (!(await checkDatabaseConnection())) {
    console.error('Cannot connect to PostgreSQL; set DATABASE_URL (or DB_HOST/DB_USER/DB_PASS/DB_NAME).');
    process.exit(2);
  }
  await initDb();

  console.log('--- 1. RLS enabled and forced on every tenant-bound table ---');
  const flags = await pool.query(
    'SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind = \'r\'',
    [RLS_TENANT_TABLES.map((t) => t.table)]
  );
  for (const { table } of RLS_TENANT_TABLES) {
    const row = flags.rows.find((r) => r.relname === table);
    check(Boolean(row), `${table} exists`);
    check(row?.relrowsecurity === true, `${table}: row security enabled`);
    check(row?.relforcerowsecurity === true, `${table}: row security FORCED`);
  }

  console.log('\n--- 2. Connecting role ---');
  const role = await pool.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  const me = role.rows[0];
  check(me && !me.rolsuper && !me.rolbypassrls, `role "${me?.name}" is neither SUPERUSER nor BYPASSRLS`, 'connect as an ordinary role: superusers always bypass RLS, FORCE or not');

  console.log('\n--- 3. Behaviour ---');
  const add = (tenant: string, user: string) =>
    queryWithTenant(
      tenant,
      `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ($1, $2, $3, $4, 'VIEWER')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [user, `${user}@example.mil`, user, tenant]
    );
  try {
    await add(TENANT_X, 'rls_verify_x1');
    await add(TENANT_Y, 'rls_verify_y1');

    const noContext = await pool.query("SELECT user_id FROM tenant_users WHERE user_id LIKE 'rls_verify_%'");
    check(noContext.rowCount === 0, 'no tenant context => zero rows visible', `saw ${noContext.rowCount}`);

    const asX = await queryWithTenant(TENANT_X, "SELECT user_id FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []);
    check(asX.rows.length === 1 && asX.rows[0].user_id === 'rls_verify_x1', 'tenant X sees only its own row', JSON.stringify(asX.rows));

    const asY = await queryWithTenant(TENANT_Y, "SELECT user_id FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []);
    check(asY.rows.length === 1 && asY.rows[0].user_id === 'rls_verify_y1', 'tenant Y sees only its own row', JSON.stringify(asY.rows));

    let rejected = false;
    try {
      await queryWithTenant(
        TENANT_X,
        `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ('rls_verify_evil', 'e@x.mil', 'e', $1, 'TENANT_OWNER')`,
        [TENANT_Y]
      );
    } catch {
      rejected = true;
    }
    check(rejected, 'tenant X cannot write a row for tenant Y (WITH CHECK)');

    const stolen = await queryWithTenant(TENANT_X, "SELECT 1 FROM tenant_users WHERE tenant_id = $1", [TENANT_Y]);
    check(stolen.rows.length === 0, 'tenant X cannot read tenant Y rows even by naming the tenant');
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []).catch(() => undefined);
    }
  }
}

main()
  .catch((err) => {
    console.error('Unexpected error:', err);
    failures++;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    console.log(failures === 0 ? '\nAll RLS checks passed.' : `\n${failures} RLS check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
