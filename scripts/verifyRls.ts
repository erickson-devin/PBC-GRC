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
 *   4. tenant DISCOVERY: in user context a user sees only the tenants they belong to (and only their own
 *      membership rows), and that context can never write.
 * It inserts and removes a few rows prefixed "rls_verify_" in tenants and tenant_users. Exit code 0 = all checks passed.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { pool, initDb, queryWithTenant, queryWithUser, listUserTenants, checkDatabaseConnection } = await import('../server/db');
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

    // CMMC asset scoping: enclave_assets is tenant-isolated like every other tenant-bound table
    const addAsset = (tenant: string, name: string, category = 'CUI_ASSET') =>
      queryWithTenant(
        tenant,
        `INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, $2, $3)`,
        [tenant, name, category]
      );
    await addAsset(TENANT_X, 'rls_verify_asset_x');
    await addAsset(TENANT_Y, 'rls_verify_asset_y', 'SPECIALIZED_ASSET');
    const assetsNoCtx = await pool.query("SELECT 1 FROM enclave_assets WHERE asset_name LIKE 'rls_verify_%'");
    check(assetsNoCtx.rowCount === 0, 'enclave_assets: no tenant context => zero rows visible', `saw ${assetsNoCtx.rowCount}`);
    const assetsX = await queryWithTenant(TENANT_X, "SELECT asset_name FROM enclave_assets WHERE asset_name LIKE 'rls_verify_%'", []);
    check(assetsX.rows.length === 1 && assetsX.rows[0].asset_name === 'rls_verify_asset_x', 'enclave_assets: tenant X sees only its own asset', JSON.stringify(assetsX.rows));
    const assetsStolen = await queryWithTenant(TENANT_X, 'SELECT 1 FROM enclave_assets WHERE tenant_id = $1', [TENANT_Y]);
    check(assetsStolen.rows.length === 0, 'enclave_assets: tenant X cannot read tenant Y assets even by naming the tenant');
    let assetWriteRejected = false;
    try {
      await queryWithTenant(TENANT_X, `INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, 'rls_verify_asset_evil', 'CUI_ASSET')`, [TENANT_Y]);
    } catch {
      assetWriteRejected = true;
    }
    check(assetWriteRejected, 'enclave_assets: tenant X cannot write an asset for tenant Y (WITH CHECK)');
    const assetUpdate = await queryWithTenant(TENANT_X, "UPDATE enclave_assets SET owner = 'pwned' WHERE tenant_id = $1", [TENANT_Y]);
    check((assetUpdate.rowCount ?? 0) === 0, "enclave_assets: tenant X cannot update tenant Y's assets");
    let badCategory = false;
    try {
      await addAsset(TENANT_X, 'rls_verify_asset_bad', 'NOT_A_CATEGORY');
    } catch {
      badCategory = true;
    }
    check(badCategory, 'enclave_assets: the database refuses a category outside the five CMMC categories');
    let dupRejected = false;
    try {
      await addAsset(TENANT_X, 'RLS_VERIFY_ASSET_X');
    } catch {
      dupRejected = true;
    }
    check(dupRejected, 'enclave_assets: asset names are unique per tenant, ignoring case');
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM enclave_assets WHERE asset_name LIKE 'rls_verify_%'", []).catch(() => undefined);
    }
  }

  await verifyDiscovery();
}

async function verifyDiscovery() {
  console.log('\n--- 4. Tenant discovery (user context) ---');
  const U1 = 'rls_verify_disc_u1'; // member of X only
  const U2 = 'rls_verify_disc_u2'; // member of Y only
  const U3 = 'rls_verify_disc_u3'; // member of nothing
  const makeTenant = (id: string) =>
    queryWithTenant(
      id,
      `INSERT INTO tenants (id, name, system_name, system_owner) VALUES ($1, $2, 'sys', 'owner') ON CONFLICT (id) DO NOTHING`,
      [id, id]
    );
  const join = (tenant: string, user: string, role: string) =>
    queryWithTenant(
      tenant,
      `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ($1, $2, $1, $3, $4) ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [user, `${user}@example.mil`, tenant, role]
    );

  try {
    await makeTenant(TENANT_X);
    await makeTenant(TENANT_Y);
    await join(TENANT_X, U1, 'TENANT_OWNER');
    await join(TENANT_Y, U2, 'VIEWER');

    const u1 = await listUserTenants(U1);
    check(u1.length === 1 && u1[0].id === TENANT_X && u1[0].role === 'TENANT_OWNER', 'user 1 lists exactly tenant X with their role', JSON.stringify(u1.map((t) => [t.id, t.role])));
    const u2 = await listUserTenants(U2);
    check(u2.length === 1 && u2[0].id === TENANT_Y && u2[0].role === 'VIEWER', 'user 2 lists exactly tenant Y with their role', JSON.stringify(u2.map((t) => [t.id, t.role])));
    check((await listUserTenants(U3)).length === 0, 'a user with no membership lists nothing');

    // Raw queries in user context: the policies, not the WHERE clause, must do the filtering.
    const rawTenants = await queryWithUser(U1, "SELECT id FROM tenants WHERE id LIKE 'rls_verify_%'", []);
    check(rawTenants.rows.length === 1 && rawTenants.rows[0].id === TENANT_X, 'unfiltered SELECT on tenants as user 1 returns only tenant X (policy, not WHERE)', JSON.stringify(rawTenants.rows));
    const rawMembers = await queryWithUser(U1, "SELECT user_id FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []);
    check(rawMembers.rows.length === 1 && rawMembers.rows[0].user_id === U1, 'unfiltered SELECT on tenant_users as user 1 returns only user 1 (not other members)', JSON.stringify(rawMembers.rows));
    const noUser = await queryWithUser('', "SELECT id FROM tenants WHERE id LIKE 'rls_verify_%'", []);
    check(noUser.rows.length === 0, "an empty user id matches nothing");
    const noContext = await pool.query("SELECT id FROM tenants WHERE id LIKE 'rls_verify_%'");
    check(noContext.rows.length === 0, 'no user and no tenant context => zero tenants');
    const asTenantX = await queryWithTenant(TENANT_X, "SELECT id FROM tenants WHERE id LIKE 'rls_verify_%'", []);
    check(asTenantX.rows.length === 1 && asTenantX.rows[0].id === TENANT_X, 'tenant context still sees only its own tenant (discovery does not widen it)', JSON.stringify(asTenantX.rows));

    // Discovery must never grant writes.
    let insertRejected = false;
    try {
      await queryWithUser(U1, "INSERT INTO tenants (id, name, system_name, system_owner) VALUES ('rls_verify_new', 'n', 's', 'o')", []);
    } catch {
      insertRejected = true;
    }
    check(insertRejected, 'user context cannot INSERT into tenants');
    const upd = await queryWithUser(U1, "UPDATE tenants SET name = 'hacked' WHERE id = $1", [TENANT_X]);
    check(upd.rowCount === 0, 'user context cannot UPDATE tenants', 'rows updated: ' + upd.rowCount);
    const del = await queryWithUser(U1, 'DELETE FROM tenant_users WHERE user_id = $1', [U1]);
    check(del.rowCount === 0, 'user context cannot DELETE its own membership', 'rows deleted: ' + del.rowCount);
    let promoteRejected = false;
    try {
      await queryWithUser(U1, "INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ($1, 'e', 'e', $2, 'TENANT_OWNER')", [U1, TENANT_Y]);
    } catch {
      promoteRejected = true;
    }
    check(promoteRejected, 'user context cannot add itself to another tenant');
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM tenant_users WHERE user_id LIKE 'rls_verify_%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM tenants WHERE id LIKE 'rls_verify_%'", []).catch(() => undefined);
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
