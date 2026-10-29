/**
 * Live Row-Level Security verification against a REAL PostgreSQL database.
 *
 *   DATABASE_URL=postgres://app_user:...@host:5432/db npm run db:verify-rls
 *   (or the DB_HOST / DB_USER / DB_PASS / DB_NAME variables the server uses)
 *
 * Runs initDb(), then proves:
 *   1. every tenant-bound table has RLS enabled AND forced (so even the table owner is subject to it), and ssp_documents is gone (or kept with FORCE);
 *   2. the connecting role can be subject to RLS at all (superusers and BYPASSRLS roles always bypass it);
 *   3. with no tenant context a query sees zero rows, with a tenant context it sees only that tenant's rows,
 *      and a write for a different tenant is rejected.
 *   4. tenant DISCOVERY: in user context a user sees only the tenants they belong to (and only their own
 *      membership rows), and that context can never write.
 *   5. vulnerability-management tables: tenant isolation, composite foreign keys that refuse another tenant's asset, the CHECK constraints behind machine-confirmed closure, and the two SELECT-only discovery policies (service-token lookup, scheduler enumeration) that see nothing without their GUC.
 *   6. control assessment history: tenant isolation of control_assessment_events, and the CHECK constraints on its source and notes digest.
 *   7. local identities (second factor): local_users stays a global table without row security, the token_version / totp_* / recovery_code_hashes / must_change_password column shapes, an idempotent schema script, the three CHECK constraints (no plaintext secret, hex-only recovery digests, no confirmation without a secret), and the atomic single-use statements for recovery codes and TOTP steps.
 *   8. program isolation (the RESTRICTIVE rls_<table>_program_isolation policies on the six program-scoped tables): a tenant cannot see another tenant's programs, a program cannot take another tenant's program id (composite foreign key), program B can neither read, update nor insert into program A's rows (and no program context sees and writes nothing), the same control id is one row per program (the old unique key is gone), the policies are in the catalog, every legacy table is finalized (program_id NOT NULL, no program_required check) or still waiting for a backfill (nullable, NOT VALID check), and an upgrade of legacy rows without a program (isolated schema rls_verify_upgrade, SKIPPED when CREATE SCHEMA is refused): visible under the default program only until migrateTenantToPrograms adopts them (8h: the schema step of initDb tolerates those rows, finalizes program_id once they are adopted, and never adds the check back). 8f: the same program isolation for control_objectives and control_objective_events (assessment objectives; new tables with program_id NOT NULL, so no program_required check). 8i: program_events isolation (same pattern as 8f, no foreign key, kind CHECK), the programs_scoping_check / programs_scoping_privacy_check / programs_scoping_framework_check refusals, and the one VM target per tenant (unq_programs_vm_target, programs_vm_target_check).
 * It inserts and removes a few rows prefixed "rls_verify_" in tenants, tenant_users, enclave_assets, programs, control_assessments, control_assessment_events (actor "rls_verify_actor"), the vm_* tables (plus "RLS-VERIFY-" rows in vm_vulns) and local_users (ids "rls_verify_lu_*"); section 8e creates and drops the schema rls_verify_upgrade. Exit code 0 = all checks passed.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { pool, initDb, queryWithTenant, queryWithProgram, queryWithUser, listUserTenants, checkDatabaseConnection } = await import('../server/db');
const { RLS_TENANT_TABLES, RLS_PROGRAM_TABLES } = await import('../server/schema');
// The tables that existed before programs: they got a nullable program_id and a NOT VALID program_required check. The objective tables and program_events are new (program_id NOT NULL).
const LEGACY_PROGRAM_TABLES = RLS_PROGRAM_TABLES.filter((t) => !t.startsWith('control_objective') && t !== 'program_events');
type ProgramScope = { tenantId: string; programId: string };

let failures = 0;
function check(ok: boolean, message: string, detail?: string) {
  console.log(`${ok ? '  ✓ PASS' : '  ✗ FAIL'}: ${message}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
}

const TENANT_X = 'rls_verify_tenant_x';
const TENANT_Y = 'rls_verify_tenant_y';

/** Creates a CMMC_L2 program of the tenant (the tenant policy alone lets a program be inserted) and returns its id. */
const mkProgram = async (tenant: string, name: string, isDefault = false): Promise<string> =>
  String(
    (await queryWithTenant(tenant, "INSERT INTO programs (tenant_id, name, framework_id, is_default) VALUES ($1, $2, 'CMMC_L2', $3) RETURNING id", [tenant, name, isDefault])).rows[0]?.id
  );

/** True only when the statement, run in the program's context, fails with the expected SQLSTATE and/or constraint. */
async function rejectsIn(scope: ProgramScope, sql: string, params: (string | number | null)[], want: { code?: string; constraint?: string }): Promise<{ ok: boolean; detail: string }> {
  try {
    await queryWithProgram(scope, sql, params);
    return { ok: false, detail: 'no error' };
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { ok: (want.code === undefined || e.code === want.code) && (want.constraint === undefined || e.constraint === want.constraint), detail: 'code ' + e.code + ', constraint ' + e.constraint };
  }
}

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
  // ssp_documents had no reader or writer (issue #25): dropped where empty, otherwise kept with FORCE restored
  const ssp = await pool.query("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'ssp_documents' AND relkind = 'r' AND relnamespace = current_schema()::regnamespace");
  check(ssp.rows.length === 0 || ssp.rows[0].relforcerowsecurity === true, 'ssp_documents is dropped (or, if it still holds rows, kept with row security FORCED)', JSON.stringify(ssp.rows));

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
  let scopeX: ProgramScope | null = null;
  let scopeY: ProgramScope | null = null;
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
    // control_assessment_events is program-scoped: every insert and read below runs in the program of its tenant (both settings)
    const programX = await mkProgram(TENANT_X, 'rls_verify_events_x', true);
    const programY = await mkProgram(TENANT_Y, 'rls_verify_events_y', true);
    scopeX = { tenantId: TENANT_X, programId: programX };
    scopeY = { tenantId: TENANT_Y, programId: programY };
    const insertEvent =
      "INSERT INTO control_assessment_events (tenant_id, control_id, source, actor, new_status, new_role, notes_changed, new_notes_sha256, new_notes_length, program_id) VALUES ($1, 'AC.L1-3.1.1', $2, 'rls_verify_actor', 'MET', 'IT / Security Lead', true, $3, 0, $4)";
    const goodSha = 'a'.repeat(64);
    const crossTenant = await rejectsIn(scopeX, insertEvent, [TENANT_Y, 'human', goodSha, programX], { code: '42501' });
    check(crossTenant.ok, "control_assessment_events: tenant X cannot insert an event for tenant Y (WITH CHECK)", crossTenant.detail);
    let eventOk = false;
    try {
      await queryWithProgram(scopeX, insertEvent, [TENANT_X, 'human', goodSha, programX]);
      eventOk = true;
    } catch {
      eventOk = false;
    }
    check(eventOk, 'control_assessment_events: tenant X can insert an event for itself, in its program');
    const eventsNoCtx = await pool.query("SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%'");
    check(eventsNoCtx.rowCount === 0, 'control_assessment_events: no tenant context => zero rows visible', `saw ${eventsNoCtx.rowCount}`);
    const eventsTenantOnly = await queryWithTenant(TENANT_X, "SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []);
    check(eventsTenantOnly.rows.length === 0, 'control_assessment_events: a tenant context with no program context sees nothing (the program policy)', `saw ${eventsTenantOnly.rows.length}`);
    const eventsX = await queryWithProgram(scopeX, "SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []);
    check(eventsX.rows.length === 1, 'control_assessment_events: tenant X sees its own event', `saw ${eventsX.rows.length}`);
    const eventsY = await queryWithProgram(scopeY, "SELECT 1 FROM control_assessment_events WHERE actor LIKE 'rls_verify%' OR tenant_id = $1", [TENANT_X]);
    check(eventsY.rows.length === 0, "control_assessment_events: tenant Y sees none of tenant X's events, even by naming the tenant", `saw ${eventsY.rows.length}`);
    const badSource = await rejectsIn(scopeX, insertEvent, [TENANT_X, 'robot', goodSha, programX], { code: '23514', constraint: 'control_assessment_events_source_check' });
    check(badSource.ok, "control_assessment_events: a source outside human, ssp-commit, vm-snapshot is refused (source_check)", badSource.detail);
    const badSha = await rejectsIn(scopeX, insertEvent, [TENANT_X, 'human', 'xyz', programX], { code: '23514', constraint: 'control_assessment_events_sha_check' });
    check(badSha.ok, "control_assessment_events: a notes digest that is not 64 lowercase hex characters is refused (sha_check)", badSha.detail);
  } finally {
    for (const scope of [scopeX, scopeY]) {
      if (scope) await queryWithProgram(scope, "DELETE FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
    }
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM programs WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined);
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
  await verifyLocalIdentities();
  await verifyProgramIsolation();
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

async function verifyLocalIdentities() {
  console.log('\n--- 7. Local identities: second factor storage (local_users, global table) ---');
  const { buildSchemaSql } = await import('../server/schema');
  const { confirmTotp, consumeRecoveryCode, consumeTotpStep, replaceRecoveryCodeHashes } = await import('../server/auth/localUsers');

  const ID = (n: number) => `rls_verify_lu_${n}`;
  const GOOD_BLOB = `v1.${'A'.repeat(16)}.${'B'.repeat(24)}.${'C'.repeat(22)}`; // the shape encryptTotpSecret produces
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const insertUser = (n: number, extraColumns = '', extraValues: unknown[] = []) =>
    pool.query(
      `INSERT INTO local_users (id, email, name, password_hash${extraColumns}) VALUES ($1, $2, 'rls_verify', 'x'${extraValues.map((_, i) => `, $${i + 3}`).join('')})`,
      [ID(n), `rls_verify_lu_${n}@example.mil`, ...extraValues]
    );
  let lastRejection = '';
  // True only for the expected SQLSTATE and constraint, so a stray error cannot masquerade as the refusal under test.
  const rejects = async (run: () => Promise<unknown>, want: { code: string; constraint: string }): Promise<boolean> => {
    try {
      await run();
      lastRejection = 'no error';
      return false;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      lastRejection = `code ${e.code}, constraint ${e.constraint}`;
      return e.code === want.code && e.constraint === want.constraint;
    }
  };

  try {
    // V1: local_users is global identity data, not a tenant table.
    const luFlags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'local_users' AND relkind = 'r'");
    check(luFlags.rows[0]?.relrowsecurity === false, 'local_users: row security is NOT enabled (global identity table)', JSON.stringify(luFlags.rows));
    check(!RLS_TENANT_TABLES.some((t) => t.table === 'local_users'), 'local_users is not listed in RLS_TENANT_TABLES');

    // V2 and V9: the column shapes.
    const cols = await pool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'local_users' AND table_schema = current_schema()"
    );
    const col = (name: string) => cols.rows.find((r) => r.column_name === name);
    check(
      col('token_version')?.data_type === 'integer' && col('token_version')?.is_nullable === 'NO' && /^0\b/.test(String(col('token_version')?.column_default)),
      'local_users.token_version is integer NOT NULL DEFAULT 0', JSON.stringify(col('token_version'))
    );
    check(col('totp_secret_enc')?.data_type === 'text' && col('totp_secret_enc')?.is_nullable === 'YES', 'local_users.totp_secret_enc is nullable text', JSON.stringify(col('totp_secret_enc')));
    check(col('totp_confirmed_at')?.data_type === 'timestamp with time zone', 'local_users.totp_confirmed_at is timestamptz', JSON.stringify(col('totp_confirmed_at')));
    check(col('totp_last_used_step')?.data_type === 'bigint', 'local_users.totp_last_used_step is bigint', JSON.stringify(col('totp_last_used_step')));
    check(col('recovery_code_hashes')?.data_type === 'ARRAY' && col('recovery_code_hashes')?.is_nullable === 'NO', 'local_users.recovery_code_hashes is an ARRAY, NOT NULL', JSON.stringify(col('recovery_code_hashes')));
    check(!col('totp_secret'), 'local_users has no plaintext totp_secret column');
    check(
      col('must_change_password')?.data_type === 'boolean' && col('must_change_password')?.is_nullable === 'NO' && String(col('must_change_password')?.column_default) === 'false',
      'local_users.must_change_password is boolean NOT NULL DEFAULT false', JSON.stringify(col('must_change_password'))
    );

    // V3: the schema script is idempotent.
    let secondRun = true;
    try {
      await pool.query(buildSchemaSql());
    } catch (err) {
      secondRun = false;
      lastRejection = (err as Error).message;
    }
    check(secondRun, 'running the whole schema script a second time succeeds', lastRejection);
    const after = await pool.query("SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'local_users' AND table_schema = current_schema()");
    check(after.rows[0]?.n === cols.rows.length, 'the second schema run leaves the local_users column count unchanged', `${cols.rows.length} -> ${after.rows[0]?.n}`);

    // V4 to V6: the CHECK constraints.
    check(
      await rejects(() => insertUser(1, ', totp_secret_enc', ['JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP']), { code: '23514', constraint: 'local_users_totp_secret_enc_check' }),
      'a plaintext base32 secret in totp_secret_enc is refused (totp_secret_enc_check)', lastRejection
    );
    check(
      await rejects(() => insertUser(2, ', recovery_code_hashes', [['abc']]), { code: '23514', constraint: 'local_users_recovery_codes_check' }),
      'a recovery digest that is not 64 lowercase hex characters is refused (recovery_codes_check)', lastRejection
    );
    check(
      await rejects(() => insertUser(3, ', totp_confirmed_at', [new Date().toISOString()]), { code: '23514', constraint: 'local_users_totp_confirm_check' }),
      'totp_confirmed_at with no secret is refused (totp_confirm_check)', lastRejection
    );

    // V7, V8 and V10: the atomic statements, through the real storage functions. User 4 holds a confirmed factor.
    await insertUser(4, ', totp_secret_enc', [GOOD_BLOB]);
    check((await replaceRecoveryCodeHashes(ID(4), [HASH_A])) === false, 'replacing recovery codes with no confirmed factor updates 0 rows');
    const untouched = await pool.query('SELECT cardinality(recovery_code_hashes) AS n FROM local_users WHERE id = $1', [ID(4)]);
    check(untouched.rows[0]?.n === 0, 'the refused replacement left the recovery codes empty', JSON.stringify(untouched.rows));
    check((await confirmTotp(ID(4), 100, [HASH_A, HASH_B])) === true, 'confirming a pending factor stores the step and the recovery digests');
    check((await confirmTotp(ID(4), 101, [HASH_A])) === false, 'a second confirmation updates 0 rows');
    check((await replaceRecoveryCodeHashes(ID(4), [HASH_A])) === true, 'replacing recovery codes after confirmation updates exactly 1 row');

    check((await consumeRecoveryCode(ID(4), HASH_A)) === true, 'a recovery digest is consumed once (1 row)');
    check((await consumeRecoveryCode(ID(4), HASH_A)) === false, 'the same recovery digest cannot be consumed twice (0 rows)');

    check((await consumeTotpStep(ID(4), 200)) === true, 'a TOTP step newer than the last one is accepted (1 row)');
    check((await consumeTotpStep(ID(4), 200)) === false, 'the same TOTP step is refused (replay, 0 rows)');
    check((await consumeTotpStep(ID(4), 199)) === false, 'an older TOTP step is refused (0 rows)');
    check((await consumeTotpStep(ID(4), 201)) === true, 'the next TOTP step is accepted again (1 row)');
  } finally {
    await pool.query("DELETE FROM local_users WHERE id LIKE 'rls_verify_lu_%'").catch(() => undefined);
  }
}

async function verifyProgramIsolation() {
  console.log('\n--- 8. Program isolation (RESTRICTIVE program policies) ---');
  const insertControl = 'INSERT INTO control_assessments (tenant_id, control_id, status, program_id) VALUES ($1, $2, $3, $4) RETURNING id';
  const upsertControl =
    'INSERT INTO control_assessments (tenant_id, control_id, status, program_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, program_id, control_id) DO UPDATE SET status = EXCLUDED.status RETURNING id';
  let defaultX = '';
  let defaultY = '';
  let programA = '';
  let programB = '';
  try {
    defaultX = await mkProgram(TENANT_X, 'rls_verify_p8_x_default', true);
    programA = await mkProgram(TENANT_X, 'rls_verify_p8_a');
    programB = await mkProgram(TENANT_X, 'rls_verify_p8_b');
    defaultY = await mkProgram(TENANT_Y, 'rls_verify_p8_y_default', true);
    const scopeA = { tenantId: TENANT_X, programId: programA };
    const scopeB = { tenantId: TENANT_X, programId: programB };
    const scopeDefaultX = { tenantId: TENANT_X, programId: defaultX };
    const scopeDefaultY = { tenantId: TENANT_Y, programId: defaultY };

    // 8a. programs themselves carry the tenant policy only
    const noCtx = await pool.query("SELECT 1 FROM programs WHERE name LIKE 'rls_verify_p8_%'");
    check(noCtx.rowCount === 0, '8a. programs: no tenant context => zero rows visible', 'saw ' + noCtx.rowCount);
    const ownY = await queryWithTenant(TENANT_Y, "SELECT id FROM programs WHERE name LIKE 'rls_verify_p8_%'", []);
    check(ownY.rows.length === 1 && ownY.rows[0].id === defaultY, "8a. programs: tenant Y sees only its own program, none of tenant X's", JSON.stringify(ownY.rows));
    const yNamesX = await queryWithTenant(TENANT_Y, 'SELECT id FROM programs WHERE tenant_id = $1', [TENANT_X]);
    check(yNamesX.rows.length === 0, "8a. programs: tenant Y cannot read tenant X's programs even by naming the tenant", 'saw ' + yNamesX.rows.length);

    // 8b. a program id of another tenant is refused by the composite foreign key
    // (the session runs in Y's program so the program policy passes; (X, Y's program) does not exist, so the foreign key refuses it)
    const foreign = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertControl, [TENANT_X, 'AC.L1-3.1.1', 'MET', defaultY], { code: '23503', constraint: 'fk_control_assessments_program' });
    check(foreign.ok, "8b. control_assessments: tenant X cannot attach a row to tenant Y's program (composite foreign key)", foreign.detail);

    // 8c. program B cannot read or overwrite program A
    const x1 = await queryWithProgram(scopeA, insertControl, [TENANT_X, 'AC.L1-3.1.1', 'MET', programA]);
    check(x1.rows.length === 1, '8c. control_assessments: under program A the row X1 is inserted');
    const bSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM control_assessments WHERE program_id = $1', [programA]);
    check(bSeesA.rows.length === 0, "8c. program B cannot read program A's row by naming the program", 'saw ' + bSeesA.rows.length);
    const bSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM control_assessments WHERE tenant_id = $1', [TENANT_X]);
    check(bSeesAny.rows.length === 0, "8c. program B sees none of program A's rows (policy, not WHERE)", 'saw ' + bSeesAny.rows.length);
    const bUpdates = await queryWithProgram(scopeB, "UPDATE control_assessments SET status = 'NOT_MET' WHERE program_id = $1", [programA]);
    check((bUpdates.rowCount ?? 0) === 0, "8c. program B cannot update program A's row (0 rows)", 'updated ' + bUpdates.rowCount);
    const bDeletes = await queryWithProgram(scopeB, 'DELETE FROM control_assessments WHERE program_id = $1', [programA]);
    check((bDeletes.rowCount ?? 0) === 0, "8c. program B cannot delete program A's row (0 rows)", 'deleted ' + bDeletes.rowCount);
    const bInsertsIntoA = await rejectsIn(scopeB, insertControl, [TENANT_X, 'AC.L1-3.1.2', 'MET', programA], { code: '42501' });
    check(bInsertsIntoA.ok, "8c. program B cannot insert a row into program A (WITH CHECK, 42501)", bInsertsIntoA.detail);
    const stillMet = await queryWithProgram(scopeA, "SELECT status FROM control_assessments WHERE control_id = 'AC.L1-3.1.1'", []);
    check(stillMet.rows.length === 1 && stillMet.rows[0].status === 'MET', "8c. program A's row is untouched", JSON.stringify(stillMet.rows));

    // the evidence delete of the API (DELETE /evidence/:id) is program-scoped too: program B cannot remove program A's evidence
    await queryWithProgram(
      scopeA,
      "INSERT INTO evidence_metadata (id, tenant_id, control_id, file_name, file_size, mime_type, gcs_path, file_hash, program_id) VALUES ('rls_verify_del_ev', $1, 'AC.L1-3.1.1', 'del.pdf', 5, 'application/pdf', '/vault/del', 'h', $2)",
      [TENANT_X, programA]
    );
    const evDeleteSql = "DELETE FROM evidence_metadata WHERE tenant_id = $1 AND (id = $2 OR starts_with(id, $3::text)) AND (program_id = $4 OR program_id IS NULL) RETURNING id, gcs_path";
    const bDeletesEv = await queryWithProgram(scopeB, evDeleteSql, [TENANT_X, 'rls_verify_del_ev', 'rls_verify_del_ev__inh_', programB]);
    check((bDeletesEv.rowCount ?? 0) === 0, "8c. program B cannot delete program A's evidence through the API statement (0 rows)", 'deleted ' + bDeletesEv.rowCount);
    const aDeletesEv = await queryWithProgram(scopeA, evDeleteSql, [TENANT_X, 'rls_verify_del_ev', 'rls_verify_del_ev__inh_', programA]);
    check((aDeletesEv.rowCount ?? 0) === 1, "8c. program A can delete its own evidence through the same statement (1 row)", 'deleted ' + aDeletesEv.rowCount);

    // the same control id is one row per program: the per-program key replaced unq_tenant_control
    const uq = await pool.query(
      "SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname = 'unq_tenant_control' AND conrelid = 'control_assessments'::regclass) AS old_key, (SELECT count(*)::int FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'unq_control_assessments_program_control') AS new_key"
    );
    check(uq.rows[0]?.old_key === 0 && uq.rows[0]?.new_key === 1, '8c. the (tenant_id, control_id) unique key is gone and the (tenant_id, program_id, control_id) key exists', JSON.stringify(uq.rows[0]));
    await queryWithProgram(scopeB, upsertControl, [TENANT_X, 'AC.L1-3.1.1', 'NOT_MET', programB]);
    await queryWithProgram(scopeB, upsertControl, [TENANT_X, 'AC.L1-3.1.1', 'IN_PROGRESS', programB]); // the ON CONFLICT path
    const rowA = await queryWithProgram(scopeA, "SELECT status FROM control_assessments WHERE control_id = 'AC.L1-3.1.1'", []);
    const rowB = await queryWithProgram(scopeB, "SELECT status FROM control_assessments WHERE control_id = 'AC.L1-3.1.1'", []);
    check(
      rowA.rows.length === 1 && rowA.rows[0].status === 'MET' && rowB.rows.length === 1 && rowB.rows[0].status === 'IN_PROGRESS',
      "8c. the same control in program B is its own row, and the upsert never touches program A's row",
      JSON.stringify([rowA.rows, rowB.rows])
    );

    // no program context at all
    const tenantOnly = await queryWithTenant(TENANT_X, 'SELECT 1 FROM control_assessments WHERE tenant_id = $1', [TENANT_X]);
    check(tenantOnly.rows.length === 0, '8c. a tenant context with no program context sees zero control_assessments rows', 'saw ' + tenantOnly.rows.length);
    let tenantOnlyInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertControl, [TENANT_X, 'AC.L1-3.1.3', 'MET', programA]);
    } catch (err) {
      tenantOnlyInsert = String((err as { code?: string }).code);
    }
    check(tenantOnlyInsert === '42501', '8c. a tenant context with no program context cannot insert a row (42501)', tenantOnlyInsert);
    const asDefaultX = await queryWithProgram(scopeDefaultX, 'SELECT 1 FROM control_assessments WHERE tenant_id = $1', [TENANT_X]);
    check(asDefaultX.rows.length === 0, "8c. the default program sees none of A's or B's rows", 'saw ' + asDefaultX.rows.length);
    const yWithXProgram = await queryWithProgram({ tenantId: TENANT_Y, programId: programA }, 'SELECT 1 FROM control_assessments WHERE tenant_id = $1', [TENANT_X]);
    check(yWithXProgram.rows.length === 0, "8c. tenant Y running in tenant X's program id sees nothing (the tenant policy still applies)", 'saw ' + yWithXProgram.rows.length);
    const yDefault = await queryWithProgram(scopeDefaultY, 'SELECT 1 FROM control_assessments', []);
    check(yDefault.rows.length === 0, "8c. tenant Y's default program sees none of tenant X's rows", 'saw ' + yDefault.rows.length);

    // 8d. the catalog
    const pol = await pool.query(
      "SELECT tablename, policyname, permissive, cmd, qual, with_check FROM pg_policies WHERE schemaname = current_schema() AND policyname LIKE 'rls_%_program_isolation'"
    );
    check(pol.rows.length === RLS_PROGRAM_TABLES.length, '8d. exactly ' + RLS_PROGRAM_TABLES.length + ' program-isolation policies exist', 'found ' + pol.rows.length);
    for (const t of RLS_PROGRAM_TABLES) {
      const rows = pol.rows.filter((r) => r.tablename === t);
      const r = rows[0];
      check(
        rows.length === 1 && r.policyname === 'rls_' + t + '_program_isolation' && r.permissive === 'RESTRICTIVE' && r.cmd === 'ALL' && r.qual !== null && r.with_check !== null,
        '8d. ' + t + ': one RESTRICTIVE policy, FOR ALL, with USING and WITH CHECK',
        JSON.stringify(rows)
      );
    }
    const checks = await pool.query(
      "SELECT conrelid::regclass::text AS tbl, conname, convalidated FROM pg_constraint WHERE conname LIKE '%_program_required' AND connamespace = current_schema()::regnamespace"
    );
    const legacyNotNull = await pool.query(
      "SELECT c.relname, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'program_id' AND c.relname = ANY($1) AND c.relnamespace = current_schema()::regnamespace",
      [LEGACY_PROGRAM_TABLES]
    );
    for (const t of LEGACY_PROGRAM_TABLES) {
      const c = checks.rows.find((x) => x.conname === t + '_program_required');
      const nn = legacyNotNull.rows.find((x) => x.relname === t)?.attnotnull;
      // finalized (NOT NULL, check dropped) or still waiting for a backfill (nullable, check NOT VALID)
      const finalized = nn === true && !c;
      const waiting = nn === false && Boolean(c) && c.convalidated === false;
      check(finalized || waiting, '8d. ' + t + ': program_id is ' + (finalized ? 'finalized (NOT NULL, no check)' : 'waiting for a backfill (nullable, check NOT VALID)'), JSON.stringify({ attnotnull: nn, check: c }));
    }

    // 8f. assessment objectives: the same isolation on control_objectives and control_objective_events
    const insertObjective = 'INSERT INTO control_objectives (tenant_id, program_id, control_id, objective_id, narrative, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id';
    const insertObjectiveEvent =
      "INSERT INTO control_objective_events (tenant_id, program_id, control_id, objective_id, source, actor, new_status, narrative_changed, new_narrative_sha256, new_narrative_length, evidence_changed) VALUES ($1, $2, 'AC.L2-3.1.3', 'AC.L2-3.1.3[a]', 'human', 'rls_verify_actor', 'MET', true, $3, 0, false) RETURNING id";
    const SHA = 'a'.repeat(64);
    const OBJ = 'AC.L2-3.1.3[a]';
    const objForeign = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertObjective, [TENANT_X, defaultY, 'AC.L2-3.1.3', OBJ, 'rls_verify_text', 'rls_verify_actor'], { code: '23503', constraint: 'fk_control_objectives_program' });
    check(objForeign.ok, "8f. control_objectives: tenant X cannot attach a row to tenant Y's program (composite foreign key, 23503)", objForeign.detail);
    const o1 = await queryWithProgram(scopeA, insertObjective, [TENANT_X, programA, 'AC.L2-3.1.3', OBJ, 'rls_verify_text', 'rls_verify_actor']);
    check(o1.rows.length === 1, '8f. control_objectives: under program A the objective is inserted');
    const objBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM control_objectives WHERE program_id = $1', [programA]);
    const objBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM control_objectives WHERE tenant_id = $1', [TENANT_X]);
    check(objBSeesA.rows.length === 0 && objBSeesAny.rows.length === 0, "8f. control_objectives: program B cannot read program A's row (0 rows, by program or by tenant)", 'saw ' + objBSeesA.rows.length + ' / ' + objBSeesAny.rows.length);
    const objBUpdates = await queryWithProgram(scopeB, "UPDATE control_objectives SET narrative = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    check((objBUpdates.rowCount ?? 0) === 0, "8f. control_objectives: program B cannot update program A's row (0 rows)", 'updated ' + objBUpdates.rowCount);
    const objBDeletes = await queryWithProgram(scopeB, 'DELETE FROM control_objectives WHERE program_id = $1', [programA]);
    check((objBDeletes.rowCount ?? 0) === 0, "8f. control_objectives: program B cannot delete program A's row (0 rows)", 'deleted ' + objBDeletes.rowCount);
    const objBInserts = await rejectsIn(scopeB, insertObjective, [TENANT_X, programA, 'AC.L2-3.1.3', 'AC.L2-3.1.3[b]', 'rls_verify_text', 'rls_verify_actor'], { code: '42501' });
    check(objBInserts.ok, '8f. control_objectives: program B cannot insert a row into program A (WITH CHECK, 42501)', objBInserts.detail);
    const objIntact = await queryWithProgram(scopeA, 'SELECT narrative FROM control_objectives', []);
    check(objIntact.rows.length === 1 && objIntact.rows[0].narrative === 'rls_verify_text', "8f. control_objectives: program A's row is untouched", JSON.stringify(objIntact.rows));
    const objInB = await queryWithProgram(scopeB, insertObjective, [TENANT_X, programB, 'AC.L2-3.1.3', OBJ, 'rls_verify_b', 'rls_verify_actor']);
    check(objInB.rows.length === 1, '8f. control_objectives: the same objective id is its own row in program B (the key includes the program)');
    const objNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM control_objectives WHERE tenant_id = $1', [TENANT_X]);
    check(objNoCtx.rows.length === 0, '8f. control_objectives: a tenant context with no program context sees zero rows', 'saw ' + objNoCtx.rows.length);
    let objNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertObjective, [TENANT_X, programA, 'AC.L2-3.1.3', 'AC.L2-3.1.3[c]', 'rls_verify_text', 'rls_verify_actor']);
    } catch (err) {
      objNoCtxInsert = String((err as { code?: string }).code);
    }
    check(objNoCtxInsert === '42501', '8f. control_objectives: no program context cannot insert a row (42501)', objNoCtxInsert);

    const e1 = await queryWithProgram(scopeA, insertObjectiveEvent, [TENANT_X, programA, SHA]);
    check(e1.rows.length === 1, '8f. control_objective_events: under program A the event is inserted');
    const evBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM control_objective_events WHERE program_id = $1', [programA]);
    const evBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM control_objective_events WHERE tenant_id = $1', [TENANT_X]);
    check(evBSeesA.rows.length === 0 && evBSeesAny.rows.length === 0, "8f. control_objective_events: program B cannot read program A's event (0 rows)", 'saw ' + evBSeesA.rows.length + ' / ' + evBSeesAny.rows.length);
    const evBUpdates = await queryWithProgram(scopeB, "UPDATE control_objective_events SET actor = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const evBDeletes = await queryWithProgram(scopeB, 'DELETE FROM control_objective_events WHERE program_id = $1', [programA]);
    check((evBUpdates.rowCount ?? 0) === 0 && (evBDeletes.rowCount ?? 0) === 0, "8f. control_objective_events: program B can neither update nor delete program A's event (0 rows)", 'updated ' + evBUpdates.rowCount + ', deleted ' + evBDeletes.rowCount);
    const evBInserts = await rejectsIn(scopeB, insertObjectiveEvent, [TENANT_X, programA, SHA], { code: '42501' });
    check(evBInserts.ok, '8f. control_objective_events: program B cannot insert an event into program A (WITH CHECK, 42501)', evBInserts.detail);
    const evNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM control_objective_events WHERE tenant_id = $1', [TENANT_X]);
    check(evNoCtx.rows.length === 0, '8f. control_objective_events: a tenant context with no program context sees zero rows', 'saw ' + evNoCtx.rows.length);
    let evNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertObjectiveEvent, [TENANT_X, programA, SHA]);
    } catch (err) {
      evNoCtxInsert = String((err as { code?: string }).code);
    }
    check(evNoCtxInsert === '42501', '8f. control_objective_events: no program context cannot insert an event (42501)', evNoCtxInsert);
    const evFk = await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'control_objective_events'::regclass AND contype = 'f'");
    check(evFk.rows[0]?.n === 0, '8f. control_objective_events: no foreign key (the history outlives the program)', JSON.stringify(evFk.rows[0]));
    const notNull = await pool.query(
      "SELECT attrelid::regclass::text AS tbl, attnotnull FROM pg_attribute WHERE attname = 'program_id' AND attrelid IN ('control_objectives'::regclass, 'control_objective_events'::regclass) AND NOT attisdropped"
    );
    check(notNull.rows.length === 2 && notNull.rows.every((r) => r.attnotnull === true), '8f. program_id is NOT NULL on both objective tables (attnotnull)', JSON.stringify(notNull.rows));
    await queryWithProgram(scopeA, "DELETE FROM control_objective_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);

    // 8g. the privacy baseline (issue #20): only a NIST SP 800-53 program may carry it (programs_privacy_check)
    const privacyCode = async (sql: string, params: (string | boolean | null)[]): Promise<string> => {
      try {
        await queryWithTenant(TENANT_X, sql, params);
        return 'no error';
      } catch (err) {
        return String((err as { code?: string }).code) + ' ' + String((err as { constraint?: string }).constraint);
      }
    };
    const insertPrivacy = "INSERT INTO programs (tenant_id, name, framework_id, baseline, privacy_baseline) VALUES ($1, $2, $3, $4, $5) RETURNING id";
    const cmmcPrivacy = await privacyCode(insertPrivacy, [TENANT_X, 'rls_verify_p8_priv_cmmc', 'CMMC_L2', null, true]);
    check(cmmcPrivacy === '23514 programs_privacy_check', '8g. programs: a CMMC program with privacy_baseline TRUE is refused (23514, programs_privacy_check)', cmmcPrivacy);
    const nistPrivacy = await privacyCode(insertPrivacy, [TENANT_X, 'rls_verify_p8_priv_nist', 'NIST_800_53_REV5', 'MODERATE', true]);
    check(nistPrivacy === 'no error', '8g. programs: a NIST program with privacy_baseline TRUE is accepted', nistPrivacy);
    const cmmcUpdate = await privacyCode("UPDATE programs SET privacy_baseline = TRUE WHERE name = $1", ['rls_verify_p8_a']);
    check(cmmcUpdate === '23514 programs_privacy_check', '8g. programs: updating a CMMC program to privacy_baseline TRUE is refused (23514, programs_privacy_check)', cmmcUpdate);
    const privacyDefault = await queryWithTenant(TENANT_X, "SELECT privacy_baseline FROM programs WHERE name = 'rls_verify_p8_a'", []);
    check(privacyDefault.rows[0]?.privacy_baseline === false, '8g. programs: privacy_baseline defaults to FALSE', JSON.stringify(privacyDefault.rows));

    // 8i. program scoping and the VM target (issues #21, #22): program_events isolation, the scoping CHECKs, the one-target-per-tenant key
    const insertProgramEvent = "INSERT INTO program_events (tenant_id, program_id, kind, actor, new_value) VALUES ($1, $2, $3, 'rls_verify_actor', '{\"noWireless\":true}'::jsonb) RETURNING id";
    const pe1 = await queryWithProgram(scopeA, insertProgramEvent, [TENANT_X, programA, 'scoping_set']);
    check(pe1.rows.length === 1, '8i. program_events: under program A the event is inserted');
    const peBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_events WHERE program_id = $1', [programA]);
    const peBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_events WHERE tenant_id = $1', [TENANT_X]);
    check(peBSeesA.rows.length === 0 && peBSeesAny.rows.length === 0, "8i. program_events: program B cannot read program A's event (0 rows, by program or by tenant)", 'saw ' + peBSeesA.rows.length + ' / ' + peBSeesAny.rows.length);
    const peBUpdates = await queryWithProgram(scopeB, "UPDATE program_events SET actor = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const peBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_events WHERE program_id = $1', [programA]);
    check((peBUpdates.rowCount ?? 0) === 0 && (peBDeletes.rowCount ?? 0) === 0, "8i. program_events: program B can neither update nor delete program A's event (0 rows)", 'updated ' + peBUpdates.rowCount + ', deleted ' + peBDeletes.rowCount);
    const peBInserts = await rejectsIn(scopeB, insertProgramEvent, [TENANT_X, programA, 'scoping_set'], { code: '42501' });
    check(peBInserts.ok, '8i. program_events: program B cannot insert an event into program A (WITH CHECK, 42501)', peBInserts.detail);
    const peNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_events WHERE tenant_id = $1', [TENANT_X]);
    check(peNoCtx.rows.length === 0, '8i. program_events: a tenant context with no program context sees zero rows', 'saw ' + peNoCtx.rows.length);
    let peNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertProgramEvent, [TENANT_X, programA, 'scoping_set']);
    } catch (err) {
      peNoCtxInsert = String((err as { code?: string }).code);
    }
    check(peNoCtxInsert === '42501', '8i. program_events: no program context cannot insert an event (42501)', peNoCtxInsert);
    const peBadKind = await rejectsIn(scopeA, insertProgramEvent, [TENANT_X, programA, 'rls_verify_bogus_kind'], { code: '23514', constraint: 'program_events_kind_check' });
    check(peBadKind.ok, '8i. program_events: an unknown kind is refused (23514, program_events_kind_check)', peBadKind.detail);
    const peFk = await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'program_events'::regclass AND contype = 'f'");
    check(peFk.rows[0]?.n === 0, '8i. program_events: no foreign key (the history outlives the program)', JSON.stringify(peFk.rows[0]));
    const peNotNull = await pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'program_events'::regclass AND attname = 'program_id' AND NOT attisdropped");
    check(peNotNull.rows.length === 1 && peNotNull.rows[0].attnotnull === true, '8i. program_events: program_id is NOT NULL (attnotnull)', JSON.stringify(peNotNull.rows));

    const insertScoped = "INSERT INTO programs (tenant_id, name, framework_id, baseline, scoping) VALUES ($1, $2, 'NIST_800_53_REV5', 'MODERATE', $3::jsonb)";
    const scopingBogus = await privacyCode(insertScoped, [TENANT_X, 'rls_verify_p8_scope_bogus', '{"bogus":true}']);
    check(scopingBogus === '23514 programs_scoping_check', '8i. programs: an unknown scoping key is refused (23514, programs_scoping_check)', scopingBogus);
    const scopingFalse = await privacyCode(insertScoped, [TENANT_X, 'rls_verify_p8_scope_false', '{"noWireless":false}']);
    check(scopingFalse === '23514 programs_scoping_check', '8i. programs: a scoping value of false is refused, only true is stored (23514, programs_scoping_check)', scopingFalse);
    const scopingOk = await privacyCode(insertScoped, [TENANT_X, 'rls_verify_p8_scope_ok', '{"noWireless":true}']);
    check(scopingOk === 'no error', '8i. programs: a NIST program with {"noWireless":true} is accepted', scopingOk);
    const scopingPrivacy = await privacyCode(
      "INSERT INTO programs (tenant_id, name, framework_id, baseline, privacy_baseline, scoping) VALUES ($1, $2, 'NIST_800_53_REV5', 'MODERATE', TRUE, '{\"noPiiProcessing\":true}'::jsonb)",
      [TENANT_X, 'rls_verify_p8_scope_priv']
    );
    check(scopingPrivacy === '23514 programs_scoping_privacy_check', '8i. programs: a privacy program with {"noPiiProcessing":true} is refused (23514, programs_scoping_privacy_check)', scopingPrivacy);
    const scopingCmmc = await privacyCode(
      "INSERT INTO programs (tenant_id, name, framework_id, scoping) VALUES ($1, $2, 'CMMC_L2', '{\"noWireless\":true}'::jsonb)",
      [TENANT_X, 'rls_verify_p8_scope_cmmc']
    );
    check(scopingCmmc === '23514 programs_scoping_framework_check', '8i. programs: a CMMC program with {"noWireless":true} is refused (23514, programs_scoping_framework_check)', scopingCmmc);

    const targetA = await privacyCode('UPDATE programs SET vm_target = TRUE WHERE name = $1', ['rls_verify_p8_a']);
    check(targetA === 'no error', '8i. programs: a live CMMC program can be the VM target', targetA);
    const targetB = await privacyCode('UPDATE programs SET vm_target = TRUE WHERE name = $1', ['rls_verify_p8_b']);
    check(targetB === '23505 unq_programs_vm_target', '8i. programs: a second VM target in the same tenant is refused (23505, unq_programs_vm_target)', targetB);
    const archiveTarget = await privacyCode('UPDATE programs SET archived_at = NOW() WHERE name = $1', ['rls_verify_p8_a']);
    check(archiveTarget === '23514 programs_vm_target_check', '8i. programs: archiving the VM target is refused (23514, programs_vm_target_check)', archiveTarget);
    const targetNist = await privacyCode('UPDATE programs SET vm_target = TRUE WHERE name = $1', ['rls_verify_p8_priv_nist']);
    check(targetNist === '23514 programs_vm_target_check', '8i. programs: a NIST program cannot be the VM target (23514, programs_vm_target_check)', targetNist);
    await queryWithTenant(TENANT_X, 'UPDATE programs SET vm_target = FALSE WHERE name = $1', ['rls_verify_p8_a']);
    await queryWithProgram(scopeA, "DELETE FROM program_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);

    await verifyUpgrade();
  } finally {
    // the history has no foreign key, so a program's delete does not remove its events
    for (const id of [programA, programB]) {
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM control_objective_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM program_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
    }
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM programs WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined); // the rows cascade with their program
    }
  }
}

/**
 * 8e. An upgrade: a database that holds rows with no program (written before programs existed). They are visible under the tenant's
 * default program and not under another one, and migrateTenantToPrograms gives them the default program. Runs in the isolated schema
 * rls_verify_upgrade (SET search_path on every pooled connection, so the real server functions run there too); SKIPPED when the role
 * may not create a schema.
 */
async function verifyUpgrade() {
  const SCHEMA = 'rls_verify_upgrade';
  const { buildSchemaSql } = await import('../server/schema');
  const { migrateTenantToPrograms } = await import('../server/programs');
  const setSearchPath = async (path: string | null) => {
    // every connection of the pool (max 10) takes the setting, so queryWithTenant and migrateTenantToPrograms run in the schema as well
    const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
    try {
      for (const c of clients) await c.query(path ? 'SET search_path = ' + path : 'RESET search_path');
    } finally {
      for (const c of clients) c.release();
    }
  };
  try {
    await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE');
    await pool.query('CREATE SCHEMA ' + SCHEMA);
  } catch (err) {
    console.log('  SKIP: 8e. cannot create the schema ' + SCHEMA + ' (' + String((err as Error).message) + '); the upgrade of legacy rows is not verified here');
    return;
  }
  const T = TENANT_X;
  try {
    await setSearchPath(SCHEMA + ', public');
    await pool.query(buildSchemaSql());
    // the legacy state: program_id nullable and unchecked, no program policy yet (a fresh schema is already finalized)
    for (const t of ['control_assessments', 'evidence_metadata']) {
      await pool.query('ALTER TABLE ' + t + ' DROP CONSTRAINT IF EXISTS ' + t + '_program_required');
      await pool.query('ALTER TABLE ' + t + ' ALTER COLUMN program_id DROP NOT NULL');
      await pool.query('DROP POLICY rls_' + t + '_program_isolation ON ' + t);
    }
    const defaultId = await mkProgram(T, 'rls_verify_up_default', true);
    const otherId = await mkProgram(T, 'rls_verify_up_other');
    await queryWithTenant(T, "INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes) VALUES ($1, 'AC.L1-3.1.1', 'MET', 'legacy')", [T]);
    await queryWithTenant(
      T,
      "INSERT INTO evidence_metadata (id, tenant_id, control_id, file_name, file_size, mime_type, gcs_path, file_hash) VALUES ('rls_verify_up_ev', $1, 'AC.L1-3.1.1', 'old.pdf', 5, 'application/pdf', '/vault/old', 'h')",
      [T]
    );
    // 8h. the upgrade: the policies arrive over rows that have no program, and the finalize step must tolerate them
    const waitingState = async () =>
      (
        await pool.query(
          "SELECT c.relname, a.attnotnull, EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.conname = c.relname || '_program_required') AS has_check, (SELECT bool_and(k.convalidated) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.conname = c.relname || '_program_required') AS validated FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attname = 'program_id' AND c.relname IN ('control_assessments', 'evidence_metadata') AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname"
        )
      ).rows;
    let rerun = 'resolved';
    try {
      await pool.query(buildSchemaSql());
    } catch (err) {
      rerun = 'code ' + (err as { code?: string }).code;
    }
    check(rerun === 'resolved', '8h1. the schema script resolves (the boot goes on) while rows without a program exist', rerun);
    const waiting = await waitingState();
    check(waiting.length === 2 && waiting.every((r) => r.attnotnull === false && r.has_check === true && r.validated === false), '8h2. a table with such rows stays nullable with its NOT VALID program_required check', JSON.stringify(waiting));
    const underDefault = await queryWithProgram({ tenantId: T, programId: defaultId }, 'SELECT program_id FROM control_assessments WHERE tenant_id = $1', [T]);
    check(underDefault.rows.length === 1 && underDefault.rows[0].program_id === null, '8e. a legacy row (no program) is visible under the default program', JSON.stringify(underDefault.rows));
    const underOther = await queryWithProgram({ tenantId: T, programId: otherId }, 'SELECT program_id FROM control_assessments WHERE tenant_id = $1', [T]);
    check(underOther.rows.length === 0, '8e. the legacy row is not visible under another program', 'saw ' + underOther.rows.length);
    const evUnderOther = await queryWithProgram({ tenantId: T, programId: otherId }, 'SELECT 1 FROM evidence_metadata WHERE tenant_id = $1', [T]);
    check(evUnderOther.rows.length === 0, '8e. the legacy evidence row is not visible under another program', 'saw ' + evUnderOther.rows.length);
    const counts = await migrateTenantToPrograms(T);
    check(counts.control_assessments === 1 && counts.evidence_metadata === 1, '8e. migrateTenantToPrograms adopts the legacy answer and evidence row (both settings, WITH CHECK passes)', JSON.stringify(counts));
    const adopted = await queryWithProgram({ tenantId: T, programId: defaultId }, 'SELECT program_id FROM control_assessments WHERE tenant_id = $1', [T]);
    const adoptedEv = await queryWithProgram({ tenantId: T, programId: defaultId }, 'SELECT program_id FROM evidence_metadata WHERE tenant_id = $1', [T]);
    check(adopted.rows.length === 1 && adopted.rows[0].program_id === defaultId && adoptedEv.rows[0]?.program_id === defaultId, '8e. the rows now hold the default program id', JSON.stringify([adopted.rows, adoptedEv.rows]));
    const again = await migrateTenantToPrograms(T);
    check(again.total === 0, '8e. a second migration changes nothing', JSON.stringify(again));
    await pool.query(buildSchemaSql());
    const finalized = await waitingState();
    check(finalized.length === 2 && finalized.every((r) => r.attnotnull === true && r.has_check === false), '8h3. once the rows are adopted the schema script makes program_id NOT NULL and drops the check', JSON.stringify(finalized));
    let third = 'resolved';
    try {
      await pool.query(buildSchemaSql());
    } catch (err) {
      third = 'code ' + (err as { code?: string }).code;
    }
    const afterThird = await waitingState();
    check(third === 'resolved' && JSON.stringify(afterThird) === JSON.stringify(finalized), '8h4. a further run resolves, changes nothing and does not add the check back', third + ' ' + JSON.stringify(afterThird));
    const stillHidden = await queryWithProgram({ tenantId: T, programId: otherId }, 'SELECT 1 FROM control_assessments WHERE tenant_id = $1', [T]);
    check(stillHidden.rows.length === 0, '8e. the adopted row stays invisible to the other program', 'saw ' + stillHidden.rows.length);
  } catch (err) {
    check(false, '8e. the upgrade test ran to the end', String((err as Error).stack ?? err));
  } finally {
    await setSearchPath(null).catch(() => undefined);
    await pool.query('DROP SCHEMA IF EXISTS ' + SCHEMA + ' CASCADE').catch(() => undefined);
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
