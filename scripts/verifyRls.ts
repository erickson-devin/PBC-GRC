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
 *   5. vulnerability-management tables: tenant isolation, composite foreign keys that refuse another tenant's asset, the CHECK constraints behind machine-confirmed closure, and the two SELECT-only discovery policies (service-token lookup, scheduler enumeration) that see nothing without their GUC.
 *   6. control assessment history: tenant isolation of control_assessment_events, and the CHECK constraints on its source and notes digest.
 * It inserts and removes a few rows prefixed "rls_verify_" in tenants, tenant_users, enclave_assets, control_assessment_events (actor "rls_verify_actor") and the vm_* tables (plus "RLS-VERIFY-" rows in vm_vulns). Exit code 0 = all checks passed.
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
    const rejectsFips = async (sql: string): Promise<boolean> => {
      try {
        await queryWithTenant(TENANT_X, sql, [TENANT_X]);
        return false;
      } catch {
        return true;
      }
    };
    check(
      await rejectsFips("INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category, fips_validation_status) VALUES ($1, 'rls_verify_fips_a', 'CUI_ASSET', 'GREAT')"),
      'enclave_assets: the database refuses a FIPS status outside VALIDATED / PENDING / NOT_APPLICABLE'
    );
    check(
      await rejectsFips("INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category, fips_certificate_number) VALUES ($1, 'rls_verify_fips_b', 'CUI_ASSET', 'abc')"),
      'enclave_assets: the database refuses a certificate number that is not 1-6 digits'
    );
    await queryWithTenant(
      TENANT_X,
      "INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category, fips_validation_status, fips_certificate_number, fips_module_name, fips_standard) VALUES ($1, 'rls_verify_fips_ok', 'SECURITY_PROTECTION', 'VALIDATED', '4211', 'Module', '140-2')",
      [TENANT_X]
    );
    const fipsRow = await queryWithTenant(TENANT_X, "SELECT fips_certificate_number, fips_module_name FROM enclave_assets WHERE asset_name = 'rls_verify_fips_ok'", []);
    check(fipsRow.rows[0]?.fips_certificate_number === '4211' && fipsRow.rows[0]?.fips_module_name === 'Module', 'enclave_assets: FIPS module details are stored and read back');

    console.log('\n--- 3b. Vulnerability management ---');
    let lastRejection = '';
    // True only when the statement fails with the expected SQLSTATE and/or constraint, so a stray error (a NULL id hitting
    // NOT NULL, a typo) cannot masquerade as the refusal under test. On a mismatch the detail names what was actually thrown.
    const rejectsWith = async (tenant: string, sql: string, params: (string | number | null)[], want: { code?: string; constraint?: string }): Promise<boolean> => {
      try {
        await queryWithTenant(tenant, sql, params);
        lastRejection = 'no error';
        return false;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        lastRejection = `code ${e.code}, constraint ${e.constraint}`;
        return (want.code === undefined || e.code === want.code) && (want.constraint === undefined || e.constraint === want.constraint);
      }
    };
    const assetIdX = (await queryWithTenant(TENANT_X, "SELECT id FROM enclave_assets WHERE asset_name = 'rls_verify_asset_x'", [])).rows[0]?.id;
    const assetIdY = (await queryWithTenant(TENANT_Y, "SELECT id FROM enclave_assets WHERE asset_name = 'rls_verify_asset_y'", [])).rows[0]?.id;
    check(Boolean(assetIdX) && Boolean(assetIdY), 'vm: the two verification assets can be read back by their owners');

    // 1. vm_vulns is global reference data
    const vulnsFlags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'vm_vulns'");
    check(vulnsFlags.rows.length === 1 && vulnsFlags.rows[0].relrowsecurity === false, 'vm_vulns is global reference data: no RLS');

    // 2. WITH CHECK on vm_sources
    check(
      await rejectsWith(TENANT_X, "INSERT INTO vm_sources (tenant_id, kind, label) VALUES ($1, 'WAZUH', 'rls_verify_src_evil')", [TENANT_Y], { code: '42501' }),
      'vm_sources: tenant X cannot write a source for tenant Y (WITH CHECK)', lastRejection
    );

    // 3. isolation
    const srcIdX = (await queryWithTenant(TENANT_X, "INSERT INTO vm_sources (tenant_id, kind, label) VALUES ($1, 'WAZUH', 'rls_verify_src_x') RETURNING id", [TENANT_X])).rows[0]?.id;
    const srcIdY = (await queryWithTenant(TENANT_Y, "INSERT INTO vm_sources (tenant_id, kind, label) VALUES ($1, 'WAZUH', 'rls_verify_src_y') RETURNING id", [TENANT_Y])).rows[0]?.id;
    const srcNoCtx = await pool.query("SELECT 1 FROM vm_sources WHERE label LIKE 'rls_verify_%'");
    check(srcNoCtx.rowCount === 0, 'vm_sources: no tenant context => zero rows visible', `saw ${srcNoCtx.rowCount}`);
    const srcAsX = await queryWithTenant(TENANT_X, "SELECT label FROM vm_sources WHERE label LIKE 'rls_verify_%'", []);
    check(srcAsX.rows.length === 1 && srcAsX.rows[0].label === 'rls_verify_src_x', 'vm_sources: tenant X sees only its own source', JSON.stringify(srcAsX.rows));

    // 4. scheduler discovery policy
    const schedulerSelect = "SELECT tenant_id, id FROM vm_sources WHERE label LIKE 'rls_verify_%' ORDER BY tenant_id";
    const underScheduler = async (value: string): Promise<number> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.vm_scheduler', $1, true)", [value]);
        const res = await client.query(schedulerSelect);
        return res.rows.length;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const schedulerOn = await underScheduler('on');
    check(schedulerOn === 2, "vm_sources: app.vm_scheduler = 'on' enumerates the sources of both tenants", `saw ${schedulerOn}`);
    let schedulerWriteRejected = false;
    let schedulerWriteCode = 'no error';
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.vm_scheduler', 'on', true)");
        await client.query("INSERT INTO vm_sources (tenant_id, kind, label) VALUES ($1, 'WAZUH', 'rls_verify_src_sched')", [TENANT_X]);
      } catch (err) {
        schedulerWriteCode = String((err as { code?: string }).code);
        schedulerWriteRejected = schedulerWriteCode === '42501';
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    check(schedulerWriteRejected, 'vm_sources: the scheduler GUC is SELECT-only (an INSERT under it alone is refused)', `error code: ${schedulerWriteCode}`);
    const schedulerOff = await underScheduler('off');
    check(schedulerOff === 0, "vm_sources: app.vm_scheduler = 'off' sees nothing", `saw ${schedulerOff}`);
    const schedulerEmpty = await underScheduler('');
    check(schedulerEmpty === 0, 'vm_sources: an empty app.vm_scheduler sees nothing', `saw ${schedulerEmpty}`);
    const schedulerUpper = await underScheduler('ON');
    check(schedulerUpper === 0, "vm_sources: app.vm_scheduler = 'ON' sees nothing (the match is exact)", `saw ${schedulerUpper}`);
    const schedulerUnset = await pool.query(schedulerSelect);
    check(schedulerUnset.rows.length === 0, "scheduler policy sees nothing without app.vm_scheduler = 'on'", `saw ${schedulerUnset.rows.length}`);

    // 5. token discovery policy
    const tokenHash = 'a'.repeat(64);
    await queryWithTenant(
      TENANT_X,
      `INSERT INTO vm_service_tokens (tenant_id, name, token_hash, token_prefix, scopes, created_by, expires_at)
       VALUES ($1, 'rls_verify_token', $2, 'pbcvm_rlsvfy', ARRAY['vm:ingest'], 'rls_verify', NOW() + interval '1 day')`,
      [TENANT_X, tokenHash]
    );
    const tokenNoCtx = await pool.query('SELECT 1 FROM vm_service_tokens WHERE token_hash = $1', [tokenHash]);
    check(tokenNoCtx.rowCount === 0, 'vm_service_tokens: no tenant context and no app.vm_token_hash => zero rows visible', `saw ${tokenNoCtx.rowCount}`);
    await queryWithTenant(
      TENANT_Y,
      `INSERT INTO vm_service_tokens (tenant_id, name, token_hash, token_prefix, scopes, created_by, expires_at)
       VALUES ($1, 'rls_verify_token_y', $2, 'pbcvm_rlsvfy', ARRAY['vm:ingest'], 'rls_verify', NOW() + interval '1 day')`,
      [TENANT_Y, 'c'.repeat(64)]
    );
    // No hash filter in the SELECT: the policy, not the WHERE clause, must narrow the result to the one token.
    const tokenSelect = "SELECT tenant_id, token_hash FROM vm_service_tokens WHERE name LIKE 'rls_verify_%'";
    const underTokenHash = async (value: string): Promise<{ tenant_id: string; token_hash: string }[]> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.vm_token_hash', $1, true)", [value]);
        return (await client.query(tokenSelect)).rows;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const tokenFound = await underTokenHash(tokenHash);
    check(
      tokenFound.length === 1 && tokenFound[0].tenant_id === TENANT_X && tokenFound[0].token_hash === tokenHash,
      'vm_service_tokens: app.vm_token_hash exposes exactly that token row (not the other tenant\'s), with its tenant',
      JSON.stringify(tokenFound)
    );
    const tokenOther = await underTokenHash('f'.repeat(64));
    check(tokenOther.length === 0, 'vm_service_tokens: app.vm_token_hash matching no token sees nothing', `saw ${tokenOther.length}`);
    const tokenEmpty = await underTokenHash('');
    check(tokenEmpty.length === 0, 'vm_service_tokens: an empty app.vm_token_hash sees nothing', `saw ${tokenEmpty.length}`);
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.vm_token_hash', $1, true)", [tokenHash]);
        const touched = await client.query('UPDATE vm_service_tokens SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash]);
        check(touched.rowCount === 0, 'vm_service_tokens: the token discovery policy grants no write (the middleware must switch to tenant context first)', `updated ${touched.rowCount}`);
      } catch (err) {
        check(false, 'vm_service_tokens: token discovery transaction ran', String(err));
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    check(
      await rejectsWith(
        TENANT_X,
        `INSERT INTO vm_service_tokens (tenant_id, name, token_hash, scopes, created_by, expires_at)
         VALUES ($1, 'rls_verify_token_bad_hash', 'abc', ARRAY['vm:ingest'], 'rls_verify', NOW() + interval '1 day')`,
        [TENANT_X],
        { code: '23514', constraint: 'vm_service_tokens_hash_check' }
      ),
      'vm_service_tokens: the database refuses a token hash that is not 64 lowercase hex characters', lastRejection
    );
    check(
      await rejectsWith(
        TENANT_X,
        `INSERT INTO vm_service_tokens (tenant_id, name, token_hash, scopes, created_by, expires_at)
         VALUES ($1, 'rls_verify_token_bad_scope', $2, ARRAY['vm:admin'], 'rls_verify', NOW() + interval '1 day')`,
        [TENANT_X, 'd'.repeat(64)],
        { code: '23514', constraint: 'vm_service_tokens_scopes_check' }
      ),
      'vm_service_tokens: the database refuses a scope outside the allowed list', lastRejection
    );

    // 6. composite foreign key refuses another tenant's asset
    await pool.query("INSERT INTO vm_vulns (vuln_id) VALUES ('RLS-VERIFY-0001') ON CONFLICT DO NOTHING");
    const insertFinding = "INSERT INTO vm_findings (tenant_id, asset_id, vuln_id, severity) VALUES ($1, $2, 'RLS-VERIFY-0001', 'HIGH') RETURNING id";
    check(
      await rejectsWith(TENANT_X, insertFinding, [TENANT_X, assetIdY], { code: '23503', constraint: 'fk_vm_findings_asset' }),
      "tenant X cannot attach a finding to tenant Y's asset: the composite foreign key refuses it even though RLS cannot see the difference", lastRejection
    );

    // 7. own asset works, duplicates do not
    const findingX = await queryWithTenant(TENANT_X, insertFinding, [TENANT_X, assetIdX]);
    const findingIdX = findingX.rows[0]?.id;
    check(Boolean(findingIdX), "vm_findings: tenant X can attach a finding to its own asset");
    check(await rejectsWith(TENANT_X, insertFinding, [TENANT_X, assetIdX], { code: '23505', constraint: 'unq_vm_finding' }), 'vm_findings: the same (tenant, asset, vuln) twice is refused (unq_vm_finding)', lastRejection);

    // 8. machine-confirmed closure and justified human decisions
    await pool.query("INSERT INTO vm_vulns (vuln_id) VALUES ('RLS-VERIFY-0002') ON CONFLICT DO NOTHING");
    check(
      await rejectsWith(TENANT_X, "INSERT INTO vm_findings (tenant_id, asset_id, vuln_id, severity, status) VALUES ($1, $2, 'RLS-VERIFY-0002', 'HIGH', 'RESOLVED')", [TENANT_X, assetIdX], { code: '23514', constraint: 'vm_findings_resolved_check' }),
      'vm_findings: RESOLVED without resolved_at and the confirming run is refused', lastRejection
    );
    check(
      await rejectsWith(TENANT_X, "INSERT INTO vm_findings (tenant_id, asset_id, vuln_id, severity, status) VALUES ($1, $2, 'RLS-VERIFY-0002', 'HIGH', 'RISK_ACCEPTED')", [TENANT_X, assetIdX], { code: '23514', constraint: 'vm_findings_decision_check' }),
      'vm_findings: human decisions need a justification, decided_by and decided_at', lastRejection
    );

    // 9. runs and sightings
    const runX = await queryWithTenant(
      TENANT_X,
      "INSERT INTO vm_runs (tenant_id, source_id, raw_path, raw_sha256) VALUES ($1, $2, 'rls_verify', $3) RETURNING id",
      [TENANT_X, srcIdX, 'b'.repeat(64)]
    );
    const runIdX = runX.rows[0]?.id;
    check(Boolean(runIdX), 'vm_runs: tenant X can record a run for its own source');
    let sightingOk = false;
    try {
      await queryWithTenant(TENANT_X, 'INSERT INTO vm_sightings (tenant_id, finding_id, run_id, source_id) VALUES ($1, $2, $3, $4)', [TENANT_X, findingIdX, runIdX, srcIdX]);
      sightingOk = true;
    } catch {
      sightingOk = false;
    }
    check(sightingOk, 'vm_sightings: tenant X can record a sighting for its own finding, run and source');
    // a second run, so the unique (run_id, finding_id) cannot refuse the insert before the source key is checked
    const runX2 = await queryWithTenant(
      TENANT_X,
      "INSERT INTO vm_runs (tenant_id, source_id, raw_path, raw_sha256) VALUES ($1, $2, 'rls_verify', $3) RETURNING id",
      [TENANT_X, srcIdX, 'e'.repeat(64)]
    );
    const runIdX2 = runX2.rows[0]?.id;
    check(
      await rejectsWith(
        TENANT_X,
        'INSERT INTO vm_sightings (tenant_id, finding_id, run_id, source_id) VALUES ($1, $2, $3, $4)',
        [TENANT_X, findingIdX, runIdX2, srcIdY],
        { code: '23503', constraint: 'fk_vm_sightings_source' }
      ),
      "vm_sightings: a sighting naming tenant Y's source is refused (composite foreign key)", lastRejection
    );

    // 10. tenant Y cannot see or change tenant X's findings
    const findingsStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_findings WHERE tenant_id = $1', [TENANT_X]);
    check(findingsStolen.rows.length === 0, 'vm_findings: tenant Y cannot read tenant X findings even by naming the tenant');
    const findingsUpdate = await queryWithTenant(TENANT_Y, "UPDATE vm_findings SET status = 'FALSE_POSITIVE' WHERE tenant_id = $1", [TENANT_X]);
    check((findingsUpdate.rowCount ?? 0) === 0, "vm_findings: tenant Y cannot update tenant X's findings");

    console.log('\n--- 3c. Control assessment history ---');
    const insertEvent =
      "INSERT INTO control_assessment_events (tenant_id, control_id, source, actor, new_status, new_role, notes_changed, new_notes_sha256, new_notes_length) VALUES ($1, 'AC.L1-3.1.1', $2, 'rls_verify_actor', 'MET', 'IT / Security Lead', true, $3, 0)";
    const goodSha = 'a'.repeat(64);
    check(
      await rejectsWith(TENANT_X, insertEvent, [TENANT_Y, 'human', goodSha], { code: '42501' }),
      "control_assessment_events: tenant X cannot insert an event for tenant Y (WITH CHECK)", lastRejection
    );
    let eventOk = false;
    try {
      await queryWithTenant(TENANT_X, insertEvent, [TENANT_X, 'human', goodSha]);
      eventOk = true;
    } catch {
      eventOk = false;
    }
    check(eventOk, 'control_assessment_events: tenant X can insert an event for itself');
    const eventsNoCtx = await pool.query("SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%'");
    check(eventsNoCtx.rowCount === 0, 'control_assessment_events: no tenant context => zero rows visible', `saw ${eventsNoCtx.rowCount}`);
    const eventsX = await queryWithTenant(TENANT_X, "SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []);
    check(eventsX.rows.length === 1, 'control_assessment_events: tenant X sees its own event', `saw ${eventsX.rows.length}`);
    const eventsY = await queryWithTenant(TENANT_Y, "SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%' OR tenant_id = $1", [TENANT_X]);
    check(eventsY.rows.length === 0, "control_assessment_events: tenant Y sees none of tenant X's events, even by naming the tenant", `saw ${eventsY.rows.length}`);
    check(
      await rejectsWith(TENANT_X, insertEvent, [TENANT_X, 'robot', goodSha], { code: '23514', constraint: 'control_assessment_events_source_check' }),
      "control_assessment_events: a source outside human, ssp-commit, vm-snapshot is refused (source_check)", lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertEvent, [TENANT_X, 'human', 'xyz'], { code: '23514', constraint: 'control_assessment_events_sha_check' }),
      "control_assessment_events: a notes digest that is not 64 lowercase hex characters is refused (sha_check)", lastRejection
    );
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
    }
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM vm_sightings WHERE source_id IN (SELECT id FROM vm_sources WHERE label LIKE 'rls_verify_%')", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_findings WHERE vuln_id LIKE 'RLS-VERIFY-%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_runs WHERE raw_path = 'rls_verify'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_sources WHERE label LIKE 'rls_verify_%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_service_tokens WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined);
    }
    await pool.query("DELETE FROM vm_vulns WHERE vuln_id LIKE 'RLS-VERIFY-%'").catch(() => undefined);
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
