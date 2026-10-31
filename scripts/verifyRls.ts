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
 *   6. control assessment history: tenant isolation of control_assessment_events, and the CHECK constraints on its source and notes digest. 3d: the SELECT-only app.event_retention policy on programs (the retention sweep's enumeration) sees nothing without its GUC and can never write. 3e: the history of a deleted program is untouched by the daily sweep, found by the operator pass (pruneDeletedProgramEvents) and deleted only through the program-confined deletes, and FORCE row security is back afterwards.
 *   7. local identities (second factor): local_users stays a global table without row security, the token_version / totp_* / recovery_code_hashes / must_change_password column shapes, an idempotent schema script, the three CHECK constraints (no plaintext secret, hex-only recovery digests, no confirmation without a secret), and the atomic single-use statements for recovery codes and TOTP steps. The same section proves local_user_password_history: a global table without row security, a bcrypt-only CHECK, a password change records the previous hash and keeps PASSWORD_HISTORY_DEPTH of them (none for a temporary password), and deleting the account deletes its history.
 *   8. program isolation (the RESTRICTIVE rls_<table>_program_isolation policies on the six program-scoped tables): a tenant cannot see another tenant's programs, a program cannot take another tenant's program id (composite foreign key), program B can neither read, update nor insert into program A's rows (and no program context sees and writes nothing), the same control id is one row per program (the old unique key is gone), the policies are in the catalog, every legacy table is finalized (program_id NOT NULL, no program_required check) or still waiting for a backfill (nullable, NOT VALID check), and an upgrade of legacy rows without a program (isolated schema rls_verify_upgrade, SKIPPED when CREATE SCHEMA is refused): visible under the default program only until migrateTenantToPrograms adopts them (8h: the schema step of initDb tolerates those rows, finalizes program_id once they are adopted, and never adds the check back). 8f: the same program isolation for control_objectives and control_objective_events (assessment objectives; new tables with program_id NOT NULL, so no program_required check). 8i: program_events isolation (same pattern as 8f, no foreign key, kind CHECK), the programs_scoping_check / programs_scoping_privacy_check / programs_scoping_framework_check refusals, and the one VM target per tenant (unq_programs_vm_target, programs_vm_target_check). 8j: program_assets isolation (boundary asset membership; same pattern as 8i), the two composite foreign keys (another tenant's asset or program is refused), and the cascade from an asset delete through FORCE RLS. 8l: program_ssp_metadata isolation (SSP metadata, issue #84; same pattern as 8j), the composite foreign key to programs, the primary key (one row per program), the shape CHECK (known keys, string values, 262 144 bytes), the first-writer race of writeSspMetadata, the tenants.stack_profile CHECK, and the cascade from a program delete.
 *   7b. account events (issue #40) and sessions (issue #163): local_sessions and local_account_events are global tables without row security; the sessions foreign key cascades, the sid / revoke-reason CHECKs refuse bad rows, a revoke changes exactly one row, and pruning removes only sessions that expired more than a day ago; the event table is append-only for the application role (UPDATE, DELETE and TRUNCATE refused with 42501), refuses an "@" in details and an action outside the list, and only the retention sweep can delete (the test event is backdated about 4000 days so no real event matches).
 * It inserts and removes a few rows prefixed "rls_verify_" in tenants, tenant_users, enclave_assets, programs, control_assessments, control_assessment_events (actor "rls_verify_actor"), the vm_* tables (plus "RLS-VERIFY-" rows in vm_vulns) and local_users (ids "rls_verify_lu_*", plus their local_user_password_history rows); section 3e also writes control_objective_events (actor "rls_verify_actor") for programs it creates and deletes; section 8e creates and drops the schema rls_verify_upgrade. Exit code 0 = all checks passed.
 */
export {};

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { pool, initDb, queryWithTenant, queryWithProgram, queryWithUser, listUserTenants, checkDatabaseConnection } = await import('../server/db');
const { RLS_TENANT_TABLES, RLS_PROGRAM_TABLES } = await import('../server/schema');
// The tables that existed before programs: they got a nullable program_id and a NOT VALID program_required check. The objective tables, program_events, program_assets and program_ssp_metadata are new (program_id NOT NULL).
const LEGACY_PROGRAM_TABLES = RLS_PROGRAM_TABLES.filter((t) => !t.startsWith('control_objective') && t !== 'program_events' && t !== 'program_assets' && t !== 'program_ssp_metadata');
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
  let zx: ProgramScope | null = null; // 3e: programs that get deleted, so their history is orphaned
  let zy: ProgramScope | null = null;
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
    check(badSource.ok, "control_assessment_events: a source outside human, ssp-commit, vm-snapshot, clone is refused (source_check)", badSource.detail);
    const badSha = await rejectsIn(scopeX, insertEvent, [TENANT_X, 'human', 'xyz', programX], { code: '23514', constraint: 'control_assessment_events_sha_check' });
    check(badSha.ok, "control_assessment_events: a notes digest that is not 64 lowercase hex characters is refused (sha_check)", badSha.detail);

    console.log('\n--- 3d. Retention sweep policy (programs, app.event_retention) ---');
    // the daily history sweep lists every program under this SELECT-only GUC, then deletes under each program's own tenant and program settings
    const underRetention = async <T>(fn: (c: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.event_retention', 'on', true)");
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const programsNoGuc = await pool.query("SELECT 1 FROM programs WHERE name LIKE 'rls_verify_%'");
    check(programsNoGuc.rowCount === 0, "programs: no tenant context and no app.event_retention => zero rows visible", `saw ${programsNoGuc.rowCount}`);
    const programsSeen = await underRetention(async (c) => (await c.query("SELECT tenant_id FROM programs WHERE name LIKE 'rls_verify_%'")).rows.map((r) => String(r.tenant_id)));
    check(programsSeen.includes(TENANT_X) && programsSeen.includes(TENANT_Y), "programs: app.event_retention = 'on' lists the programs of both tenants", JSON.stringify(programsSeen));
    const programsUpdated = await underRetention(async (c) => (await c.query('UPDATE programs SET name = name')).rowCount ?? 0);
    check(programsUpdated === 0, 'programs: the retention GUC is SELECT-only (an UPDATE under it alone changes nothing)', `updated ${programsUpdated}`);
    const programsDeleted = await underRetention(async (c) => (await c.query("DELETE FROM programs WHERE name LIKE 'rls_verify_%'")).rowCount ?? 0);
    check(programsDeleted === 0, 'programs: the retention GUC is SELECT-only (a DELETE under it alone removes nothing)', `deleted ${programsDeleted}`);
    const eventsUnderGuc = await underRetention(async (c) => (await c.query('SELECT 1 FROM control_assessment_events')).rows.length);
    check(eventsUnderGuc === 0, 'control_assessment_events: the retention GUC alone exposes no events (the deletes need the tenant and program settings)', `saw ${eventsUnderGuc}`);

    console.log('\n--- 3e. Events of deleted programs (operator pass, issue #150) ---');
    // the history has no foreign key to programs, so it outlives a deleted program; the daily sweep lists programs and never sees it
    const { pruneAssessmentEvents, pruneDeletedProgramEvents } = await import('../server/assessmentEventRetention');
    const zxId = await mkProgram(TENANT_X, 'rls_verify_deleted_x');
    const zyId = await mkProgram(TENANT_Y, 'rls_verify_deleted_y');
    zx = { tenantId: TENANT_X, programId: zxId };
    zy = { tenantId: TENANT_Y, programId: zyId };
    const insertOldEvent =
      "INSERT INTO control_assessment_events (tenant_id, control_id, source, actor, new_status, new_role, notes_changed, new_notes_sha256, new_notes_length, program_id, created_at) VALUES ($1, 'AC.L1-3.1.1', 'human', 'rls_verify_actor', 'MET', 'IT / Security Lead', true, $2, 0, $3, NOW() - make_interval(days => $4))";
    const insertOldObjectiveEvent =
      "INSERT INTO control_objective_events (tenant_id, program_id, control_id, objective_id, source, actor, new_status, narrative_changed, new_narrative_sha256, new_narrative_length, evidence_changed, created_at) VALUES ($1, $2, 'AC.L1-3.1.1', 'AC.L1-3.1.1[a]', 'human', 'rls_verify_actor', 'MET', true, $3, 0, false, NOW() - make_interval(days => $4))";
    await queryWithProgram(zx, insertOldEvent, [TENANT_X, goodSha, zxId, 400]);
    await queryWithProgram(zx, insertOldEvent, [TENANT_X, goodSha, zxId, 400]);
    await queryWithProgram(zx, insertOldEvent, [TENANT_X, goodSha, zxId, 1]);
    await queryWithProgram(zx, insertOldObjectiveEvent, [TENANT_X, zxId, goodSha, 400]);
    await queryWithProgram(zy, insertOldEvent, [TENANT_Y, goodSha, zyId, 400]);
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, zxId]);
    await queryWithTenant(TENANT_Y, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_Y, zyId]);
    const countIn = async (scope: ProgramScope, table: 'control_assessment_events' | 'control_objective_events'): Promise<number> =>
      Number((await queryWithProgram(scope, `SELECT count(*)::int AS n FROM ${table} WHERE actor = 'rls_verify_actor'`, [])).rows[0]?.n);
    const zxState = async (): Promise<string> => `${await countIn(zx!, 'control_assessment_events')}+${await countIn(zx!, 'control_objective_events')}`;
    check((await zxState()) === '3+1', "3e. the events of a deleted program are still reachable by its program id (assessment 3, objective 1)", await zxState());

    const daily = await pruneAssessmentEvents({ days: 365, onlyTenantIds: [TENANT_X, TENANT_Y] });
    check(daily.errors === 0 && !daily.skipped, '3e. the daily sweep over both tenants ends with no error', JSON.stringify(daily));
    check((await zxState()) === '3+1' && (await countIn(zy, 'control_assessment_events')) === 1, '3e. the daily sweep leaves the history of deleted programs alone (the sweep lists programs)', `${await zxState()}, zy ${await countIn(zy, 'control_assessment_events')}`);

    const dry = await pruneDeletedProgramEvents({ days: 365, dryRun: true, onlyTenantIds: [TENANT_X] });
    check(dry.errors === 0 && dry.deleted === 2 && dry.deletedObjectives === 1 && dry.scopes === 1, '3e. the operator pass in dry-run counts 2 assessment and 1 objective event in 1 deleted program', JSON.stringify(dry));
    check((await zxState()) === '3+1', '3e. the dry run changed nothing', await zxState());

    const real = await pruneDeletedProgramEvents({ days: 365, onlyTenantIds: [TENANT_X] });
    check(real.errors === 0 && real.deleted === 2 && real.deletedObjectives === 1, '3e. the operator pass deletes the old events of the deleted program', JSON.stringify(real));
    check((await countIn(zx, 'control_assessment_events')) === 1 && (await countIn(zx, 'control_objective_events')) === 0, '3e. the recent event of the deleted program survives, the old objective event is gone', await zxState());
    check((await countIn(zy, 'control_assessment_events')) === 1, "3e. another tenant's deleted program is untouched (--tenant scope)", `saw ${await countIn(zy, 'control_assessment_events')}`);
    check((await countIn(scopeX, 'control_assessment_events')) === 1, '3e. the event of a live program is untouched', `saw ${await countIn(scopeX, 'control_assessment_events')}`);

    const forced = await pool.query(
      "SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('control_assessment_events', 'control_objective_events', 'programs') AND relkind = 'r' AND pg_table_is_visible(oid)"
    );
    check(forced.rows.length === 3 && forced.rows.every((r) => r.relforcerowsecurity === true), '3e. FORCE row security is back on control_assessment_events, control_objective_events and programs', JSON.stringify(forced.rows));

    const again = await pruneDeletedProgramEvents({ days: 365, onlyTenantIds: [TENANT_X] });
    check(again.errors === 0 && again.deleted === 0 && again.deletedObjectives === 0, '3e. a second operator pass deletes nothing', JSON.stringify(again));
  } finally {
    for (const scope of [scopeX, scopeY, zx, zy]) {
      if (scope) {
        await queryWithProgram(scope, "DELETE FROM control_assessment_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
        await queryWithProgram(scope, "DELETE FROM control_objective_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      }
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
  await verifyAccountEvents();
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
  const { confirmTotp, consumeRecoveryCode, consumeTotpStep, replaceRecoveryCodeHashes, setLocalUserPassword, isInPasswordHistory, countPasswordHistory } = await import('../server/auth/localUsers');
  const { hashPassword } = await import('../server/auth/localAuth');
  const savedDepth = process.env.PASSWORD_HISTORY_DEPTH;
  process.env.PASSWORD_HISTORY_DEPTH = '2'; // read per call; restored in the finally below

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

    // V11 to V18: the password history (IA.L2-3.5.8, issue #162). The users above hold the placeholder hash 'x'; these need real bcrypt hashes.
    const histFlags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'local_user_password_history' AND relkind = 'r'");
    check(histFlags.rows[0]?.relrowsecurity === false, 'local_user_password_history: row security is NOT enabled (global identity table)', JSON.stringify(histFlags.rows));
    check(
      !RLS_TENANT_TABLES.some((t) => t.table === 'local_user_password_history') && !(RLS_PROGRAM_TABLES as readonly string[]).includes('local_user_password_history'),
      'local_user_password_history is in neither RLS_TENANT_TABLES nor RLS_PROGRAM_TABLES'
    );
    const histFk = await pool.query("SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_local_user_password_history_user'");
    check(histFk.rows[0]?.confdeltype === 'c', 'local_user_password_history: the foreign key to local_users cascades on delete', JSON.stringify(histFk.rows));

    const passphrase = (n: number) => `rls-verify-history-${n}-passphrase`;
    const H = [await hashPassword(passphrase(0)), await hashPassword(passphrase(1)), await hashPassword(passphrase(2)), await hashPassword(passphrase(3))];
    const insertHashedUser = (n: number, hash: string, mustChange = false) =>
      pool.query("INSERT INTO local_users (id, email, name, password_hash, must_change_password) VALUES ($1, $2, 'rls_verify', $3, $4)", [ID(n), `rls_verify_lu_${n}@example.mil`, hash, mustChange]);
    const historyHashes = async (n: number): Promise<string[]> =>
      (await pool.query('SELECT password_hash FROM local_user_password_history WHERE user_id = $1 ORDER BY id DESC', [ID(n)])).rows.map((r) => String(r.password_hash));

    await insertHashedUser(5, H[0]);
    check(
      await rejects(() => pool.query("INSERT INTO local_user_password_history (user_id, password_hash) VALUES ($1, 'not-bcrypt')", [ID(5)]), { code: '23514', constraint: 'local_user_password_history_hash_check' }),
      'a history entry that is not a bcrypt hash is refused (hash_check)', lastRejection
    );

    check((await setLocalUserPassword(ID(5), H[1])) === true, 'a password change on a known account returns true');
    const afterFirst = await historyHashes(5);
    check((await countPasswordHistory(ID(5))) === 1 && afterFirst[0] === H[0], 'the first password change records the replaced hash (history of 1)', `${afterFirst.length} row(s)`);

    check((await setLocalUserPassword(ID(5), H[2])) === true && (await countPasswordHistory(ID(5))) === 2, 'the second change makes a history of 2');
    check((await setLocalUserPassword(ID(5), H[3])) === true && (await countPasswordHistory(ID(5))) === 2, 'the third change trims the history to PASSWORD_HISTORY_DEPTH (2)');
    const trimmed = await historyHashes(5);
    check(trimmed.length === 2 && trimmed[0] === H[2] && trimmed[1] === H[1], 'the history holds the newest previous hashes (newest first)', `${trimmed.length} row(s)`);
    check((await isInPasswordHistory(ID(5), passphrase(1))) === true, 'a password still in the history is recognized');
    check((await isInPasswordHistory(ID(5), passphrase(0))) === false, 'a password trimmed from the history is no longer recognized');

    await insertHashedUser(6, H[0], true);
    check((await setLocalUserPassword(ID(6), H[1])) === true, 'a password change on a temporary-password account returns true');
    const tempUser = await pool.query('SELECT must_change_password, token_version FROM local_users WHERE id = $1', [ID(6)]);
    check((await countPasswordHistory(ID(6))) === 0, 'replacing a temporary password records nothing in the history');
    check(tempUser.rows[0]?.must_change_password === false && tempUser.rows[0]?.token_version === 1, 'the change clears must_change_password and bumps token_version', JSON.stringify(tempUser.rows));

    check((await setLocalUserPassword(ID(5), H[0], { mustChangePassword: true })) === true, 'an admin reset (temporary password) succeeds');
    const afterReset = await historyHashes(5);
    check(afterReset.length === 2 && afterReset[0] === H[3], 'an admin reset still records the replaced hash (history stays at 2)', `${afterReset.length} row(s)`);

    await pool.query('DELETE FROM local_users WHERE id = $1', [ID(5)]);
    check((await countPasswordHistory(ID(5))) === 0, 'deleting the account deletes its password history (cascade)');

    // V19 to V24: server-side sessions (local_sessions, issue #163).
    const { recordSession, revokeSession, pruneExpiredSessions } = await import('../server/auth/sessionStore');
    const sessFlags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'local_sessions' AND relkind = 'r'");
    check(sessFlags.rows[0]?.relrowsecurity === false, 'local_sessions: row security is NOT enabled (global identity table)', JSON.stringify(sessFlags.rows));
    check(
      !RLS_TENANT_TABLES.some((t) => t.table === 'local_sessions') && !(RLS_PROGRAM_TABLES as readonly string[]).includes('local_sessions'),
      'local_sessions is in neither RLS_TENANT_TABLES nor RLS_PROGRAM_TABLES'
    );
    const sessFk = await pool.query("SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_local_sessions_user'");
    check(sessFk.rows[0]?.confdeltype === 'c', 'local_sessions: the foreign key to local_users cascades on delete', JSON.stringify(sessFk.rows));

    await insertHashedUser(7, H[0]);
    const nowSec = Math.floor(Date.now() / 1000);
    check(
      await rejects(() => pool.query("INSERT INTO local_sessions (sid, user_id, issued_at, expires_at) VALUES ('bad sid!', $1, NOW(), NOW())", [ID(7)]), { code: '23514', constraint: 'local_sessions_sid_check' }),
      'a session id with characters outside the base64url set is refused (sid_check)', lastRejection
    );
    check(
      await rejects(
        () => pool.query("INSERT INTO local_sessions (sid, user_id, issued_at, expires_at, revoked_at) VALUES ('rls_verify_sess_0000099', $1, NOW(), NOW(), NOW())", [ID(7)]),
        { code: '23514', constraint: 'local_sessions_revoked_check' }
      ),
      'revoked_at without a revoke_reason is refused (revoked_check)', lastRejection
    );

    const SID = 'rls_verify_sess_0000001';
    await recordSession({ sid: SID, userId: ID(7), issuedAt: nowSec, expiresAt: nowSec + 3600, mfaVerified: false });
    const firstRevoke = await revokeSession(SID, 'signed_out');
    const secondRevoke = await revokeSession(SID, 'idle');
    const sessRow = await pool.query('SELECT revoke_reason FROM local_sessions WHERE sid = $1', [SID]);
    check(firstRevoke === 1 && sessRow.rows.length === 1 && sessRow.rows[0]?.revoke_reason === 'signed_out', 'revoking a session sets revoke_reason signed_out on exactly 1 row', `${firstRevoke}, ${JSON.stringify(sessRow.rows)}`);
    check(secondRevoke === 0 && (await pool.query('SELECT revoke_reason FROM local_sessions WHERE sid = $1', [SID])).rows[0]?.revoke_reason === 'signed_out', 'a second revoke changes 0 rows and keeps the first reason', String(secondRevoke));

    // Only rows that expired more than a day ago go; the one far in the past is ours, the other is current.
    await recordSession({ sid: 'rls_verify_sess_0000002', userId: ID(7), issuedAt: nowSec - 3 * 86_400, expiresAt: nowSec - 2 * 86_400, mfaVerified: false });
    await recordSession({ sid: 'rls_verify_sess_0000003', userId: ID(7), issuedAt: nowSec, expiresAt: nowSec + 3600, mfaVerified: false });
    await pruneExpiredSessions(Date.now());
    const kept = await pool.query("SELECT sid FROM local_sessions WHERE sid IN ('rls_verify_sess_0000002', 'rls_verify_sess_0000003') ORDER BY sid");
    check(kept.rows.length === 1 && kept.rows[0]?.sid === 'rls_verify_sess_0000003', 'pruning deletes the session that expired two days ago and keeps the one expiring in an hour', JSON.stringify(kept.rows));

    await pool.query('DELETE FROM local_users WHERE id = $1', [ID(7)]);
    const orphans = await pool.query("SELECT COUNT(*)::int AS n FROM local_sessions WHERE user_id = $1", [ID(7)]);
    check(orphans.rows[0]?.n === 0, 'deleting the account deletes its sessions (cascade)', JSON.stringify(orphans.rows));
  } finally {
    if (savedDepth === undefined) delete process.env.PASSWORD_HISTORY_DEPTH;
    else process.env.PASSWORD_HISTORY_DEPTH = savedDepth;
    await pool.query("DELETE FROM local_users WHERE id LIKE 'rls_verify_lu_%'").catch(() => undefined);
  }
}

async function verifyAccountEvents() {
  console.log('\n--- 7b. Account events (local_account_events, append-only, global table) ---');
  const { recordAccountEvent, listAccountEvents, pruneAccountEvents } = await import('../server/auth/accountEvents');
  let lastRejection = '';
  // True only for the expected SQLSTATE (and constraint when given), so a stray error cannot masquerade as the refusal under test.
  const rejects = async (run: () => Promise<unknown>, want: { code: string; constraint?: string }): Promise<boolean> => {
    try {
      await run();
      lastRejection = 'no error';
      return false;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      lastRejection = `code ${e.code}, constraint ${e.constraint}`;
      return e.code === want.code && (want.constraint === undefined || e.constraint === want.constraint);
    }
  };
  const TARGET = 'rls_verify_ev_1';
  const OLD_TARGET = 'rls_verify_ev_old';

  try {
    // V25: global table, no row security, no policy.
    const flags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'local_account_events' AND relkind = 'r'");
    check(flags.rows[0]?.relrowsecurity === false, 'local_account_events: row security is NOT enabled (global table)', JSON.stringify(flags.rows));
    check(
      !RLS_TENANT_TABLES.some((t) => t.table === 'local_account_events') && !(RLS_PROGRAM_TABLES as readonly string[]).includes('local_account_events'),
      'local_account_events is in neither RLS_TENANT_TABLES nor RLS_PROGRAM_TABLES'
    );

    // V26: the application role can append and read.
    await recordAccountEvent({ actorKind: 'cli', actorUserId: null, targetUserId: TARGET, action: 'mfa_reset', details: { reason: 'rls_verify' } });
    const listed = (await listAccountEvents({ limit: 200 })).filter((e) => e.targetUserId === TARGET);
    check(listed.length === 1 && listed[0].action === 'mfa_reset' && listed[0].actorKind === 'cli', 'the application role can append an event and read it back', JSON.stringify(listed));

    // V27 to V29: append-only. The guard trigger must exist before the destructive statements run (TRUNCATE would wipe a real trail).
    const triggers = await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'local_account_events'::regclass AND NOT tgisinternal ORDER BY tgname");
    const haveGuard = triggers.rows.some((r) => r.tgname === 'trg_local_account_events_guard') && triggers.rows.some((r) => r.tgname === 'trg_local_account_events_no_truncate');
    check(haveGuard, 'the append-only triggers exist on local_account_events', JSON.stringify(triggers.rows));
    if (haveGuard) {
      check(
        await rejects(() => pool.query("UPDATE local_account_events SET action = 'signed_out' WHERE target_user_id = $1", [TARGET]), { code: '42501' }),
        'an UPDATE of an event is refused (42501, append-only)', lastRejection
      );
      check(
        await rejects(() => pool.query('DELETE FROM local_account_events WHERE target_user_id = $1', [TARGET]), { code: '42501' }),
        'a DELETE without the retention setting is refused (42501)', lastRejection
      );
      check(await rejects(() => pool.query('TRUNCATE local_account_events'), { code: '42501' }), 'a TRUNCATE is refused (42501)', lastRejection);
    }

    // V30: the CHECK constraints.
    check(
      await rejects(() => pool.query(`INSERT INTO local_account_events (actor_kind, target_user_id, action, details) VALUES ('system', $1, 'signed_out', '{"reason":"a@b.mil"}'::jsonb)`, [TARGET]), { code: '23514', constraint: 'local_account_events_details_check' }),
      'details containing an "@" are refused (details_check)', lastRejection
    );
    check(
      await rejects(() => pool.query(`INSERT INTO local_account_events (actor_kind, target_user_id, action) VALUES ('system', $1, 'made_up')`, [TARGET]), { code: '23514', constraint: 'local_account_events_action_check' }),
      'an action outside the closed list is refused (action_check)', lastRejection
    );

    // V31: the retention sweep is the only way to delete. The test row is backdated far enough (about 11 years) that no real event can match the cutoff.
    await pool.query(
      "INSERT INTO local_account_events (at, actor_kind, target_user_id, action) VALUES (NOW() - INTERVAL '4000 days', 'system', $1, 'session_revoked')",
      [OLD_TARGET]
    );
    const dry = await pruneAccountEvents({ now: new Date(), days: 3000, dryRun: true });
    const swept = await pruneAccountEvents({ now: new Date(), days: 3000 });
    const gone = await pool.query('SELECT COUNT(*)::int AS n FROM local_account_events WHERE target_user_id = $1', [OLD_TARGET]);
    check(dry.deleted >= 1 && swept.deleted >= 1 && swept.errors === 0 && gone.rows[0]?.n === 0, 'the retention sweep deletes the backdated event (the dry run counted it first)', `${JSON.stringify(dry)} ${JSON.stringify(swept)}`);
  } finally {
    // The test rows go through the same door the sweep uses.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.account_event_retention', 'on', true)");
      await client.query("DELETE FROM local_account_events WHERE target_user_id LIKE 'rls_verify_%'");
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
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

    // 8j. boundary asset membership (issue #26): program_assets isolation, the composite foreign keys, and the cascade from an asset delete
    const mkAsset = async (tenant: string, name: string): Promise<string> =>
      String((await queryWithTenant(tenant, "INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, $2, 'CUI_ASSET') RETURNING id", [tenant, name])).rows[0]?.id);
    const assetX = await mkAsset(TENANT_X, 'rls_verify_p8_asset_x');
    const assetY = await mkAsset(TENANT_Y, 'rls_verify_p8_asset_y');
    const insertMember = 'INSERT INTO program_assets (tenant_id, program_id, asset_id, added_by) VALUES ($1, $2, $3, $4) RETURNING asset_id';
    const pa1 = await queryWithProgram(scopeA, insertMember, [TENANT_X, programA, assetX, 'rls_verify_actor']);
    check(pa1.rows.length === 1, '8j. program_assets: under program A the membership row is inserted');
    const paBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_assets WHERE program_id = $1', [programA]);
    const paBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_assets WHERE tenant_id = $1', [TENANT_X]);
    check(paBSeesA.rows.length === 0 && paBSeesAny.rows.length === 0, "8j. program_assets: program B cannot read program A's membership (0 rows, by program or by tenant)", 'saw ' + paBSeesA.rows.length + ' / ' + paBSeesAny.rows.length);
    const paBUpdates = await queryWithProgram(scopeB, "UPDATE program_assets SET added_by = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const paBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_assets WHERE program_id = $1', [programA]);
    check((paBUpdates.rowCount ?? 0) === 0 && (paBDeletes.rowCount ?? 0) === 0, "8j. program_assets: program B can neither update nor delete program A's membership (0 rows)", 'updated ' + paBUpdates.rowCount + ', deleted ' + paBDeletes.rowCount);
    const paBInserts = await rejectsIn(scopeB, insertMember, [TENANT_X, programA, assetX, 'rls_verify_actor'], { code: '42501' });
    check(paBInserts.ok, '8j. program_assets: program B cannot insert a membership into program A (WITH CHECK, 42501)', paBInserts.detail);
    const paNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_assets WHERE tenant_id = $1', [TENANT_X]);
    check(paNoCtx.rows.length === 0, '8j. program_assets: a tenant context with no program context sees zero rows', 'saw ' + paNoCtx.rows.length);
    let paNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertMember, [TENANT_X, programA, assetX, 'rls_verify_actor']);
    } catch (err) {
      paNoCtxInsert = String((err as { code?: string }).code);
    }
    check(paNoCtxInsert === '42501', '8j. program_assets: no program context cannot insert a membership (42501)', paNoCtxInsert);
    const paStillThere = await queryWithProgram(scopeA, 'SELECT asset_id FROM program_assets WHERE program_id = $1', [programA]);
    check(paStillThere.rows.length === 1 && paStillThere.rows[0].asset_id === assetX, "8j. program_assets: program A's membership is untouched", JSON.stringify(paStillThere.rows));
    const paForeignAsset = await rejectsIn(scopeA, insertMember, [TENANT_X, programA, assetY, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_assets_asset' });
    check(paForeignAsset.ok, "8j. program_assets: tenant X cannot take tenant Y's asset (composite foreign key, 23503)", paForeignAsset.detail);
    // the session runs in Y's default program so the program policy passes; (X, Y's program) does not exist, so the foreign key refuses it
    const paForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertMember, [TENANT_X, defaultY, assetX, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_assets_program' });
    check(paForeignProgram.ok, "8j. program_assets: tenant X cannot attach an asset to tenant Y's program (composite foreign key, 23503)", paForeignProgram.detail);
    // a foreign-key cascade is not filtered by row security: the asset delete (tenant context only) removes the membership that program A owns
    await queryWithTenant(TENANT_X, 'DELETE FROM enclave_assets WHERE id = $1', [assetX]);
    const paCascade = await queryWithProgram(scopeA, 'SELECT 1 FROM program_assets WHERE program_id = $1', [programA]);
    check(paCascade.rows.length === 0, "8j. program_assets: deleting an asset (tenant context only) removes its membership rows through the cascade", 'saw ' + paCascade.rows.length);

    // 8k. a stale overlay save (issue #115): two concurrent updates that both expect the same overlays; the row lock lets exactly one win
    const { createProgram, updateProgram } = await import('../server/programs');
    const raceProgram = await createProgram(TENANT_X, { name: 'rls_verify_scoping_race', frameworkId: 'NIST_800_53_REV5', baseline: 'MODERATE' }, null);
    const raceActor = { actor: 'rls_verify_actor', userId: null };
    const race = await Promise.allSettled([
      updateProgram(TENANT_X, raceProgram.id, { scoping: { noWireless: true }, expectedScoping: {} }, raceActor),
      updateProgram(TENANT_X, raceProgram.id, { scoping: { noMobileDevices: true }, expectedScoping: {} }, raceActor),
    ]);
    const raceWon = race.filter((r) => r.status === 'fulfilled').length;
    const raceLost = race.filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.code === 'scoping_conflict').length;
    check(raceWon === 1 && raceLost === 1, '8k. programs: of two concurrent saves that expect the same overlays exactly one succeeds and the other is a scoping_conflict', race.map((r) => r.status + (r.status === 'rejected' ? ':' + String((r.reason as { code?: unknown })?.code) : '')).join(' '));
    const raceEvents = await queryWithProgram({ tenantId: TENANT_X, programId: raceProgram.id }, "SELECT 1 FROM program_events WHERE program_id = $1 AND kind = 'scoping_changed'", [raceProgram.id]);
    check(raceEvents.rows.length === 1, '8k. program_events: exactly one scoping_changed event for the program (the refused save wrote nothing)', 'saw ' + raceEvents.rows.length);
    await queryWithProgram({ tenantId: TENANT_X, programId: raceProgram.id }, "DELETE FROM program_events WHERE program_id = $1", [raceProgram.id]).catch(() => undefined);

    // 8l. SSP metadata (issue #84): program_ssp_metadata isolation, the composite foreign key, the primary key, the shape CHECK, the first-writer race and the stack profile CHECK
    const insertMeta = 'INSERT INTO program_ssp_metadata (tenant_id, program_id, metadata, updated_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING program_id';
    const metaJson = JSON.stringify({ systemName: 'rls_verify_sm' });
    const sm1 = await queryWithProgram(scopeA, insertMeta, [TENANT_X, programA, metaJson, 'rls_verify_actor']);
    check(sm1.rows.length === 1, '8l. program_ssp_metadata: under program A the row is inserted');
    const smBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_metadata WHERE program_id = $1', [programA]);
    const smBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_metadata WHERE tenant_id = $1', [TENANT_X]);
    check(smBSeesA.rows.length === 0 && smBSeesAny.rows.length === 0, "8l. program_ssp_metadata: program B cannot read program A's row (0 rows, by program or by tenant)", 'saw ' + smBSeesA.rows.length + ' / ' + smBSeesAny.rows.length);
    const smBUpdates = await queryWithProgram(scopeB, "UPDATE program_ssp_metadata SET updated_by = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const smBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_ssp_metadata WHERE program_id = $1', [programA]);
    check((smBUpdates.rowCount ?? 0) === 0 && (smBDeletes.rowCount ?? 0) === 0, "8l. program_ssp_metadata: program B can neither update nor delete program A's row (0 rows)", 'updated ' + smBUpdates.rowCount + ', deleted ' + smBDeletes.rowCount);
    const smBInserts = await rejectsIn(scopeB, insertMeta, [TENANT_X, programA, metaJson, 'rls_verify_actor'], { code: '42501' });
    check(smBInserts.ok, '8l. program_ssp_metadata: program B cannot insert a row into program A (WITH CHECK, 42501)', smBInserts.detail);
    const smNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_ssp_metadata WHERE tenant_id = $1', [TENANT_X]);
    check(smNoCtx.rows.length === 0, '8l. program_ssp_metadata: a tenant context with no program context sees zero rows', 'saw ' + smNoCtx.rows.length);
    let smNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertMeta, [TENANT_X, programA, metaJson, 'rls_verify_actor']);
    } catch (err) {
      smNoCtxInsert = String((err as { code?: string }).code);
    }
    check(smNoCtxInsert === '42501', '8l. program_ssp_metadata: no program context cannot insert a row (42501)', smNoCtxInsert);
    const smStillThere = await queryWithProgram(scopeA, 'SELECT metadata FROM program_ssp_metadata WHERE program_id = $1', [programA]);
    check(smStillThere.rows.length === 1 && smStillThere.rows[0].metadata?.systemName === 'rls_verify_sm', "8l. program_ssp_metadata: program A's row is untouched", JSON.stringify(smStillThere.rows));
    // the session runs in Y's default program so the program policy passes; (X, Y's program) does not exist, so the foreign key refuses it
    const smForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertMeta, [TENANT_X, defaultY, metaJson, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_ssp_metadata_program' });
    check(smForeignProgram.ok, "8l. program_ssp_metadata: tenant X cannot attach a row to tenant Y's program (composite foreign key, 23503)", smForeignProgram.detail);
    const smDuplicate = await rejectsIn(scopeA, insertMeta, [TENANT_X, programA, metaJson, 'rls_verify_actor'], { code: '23505', constraint: 'pk_program_ssp_metadata' });
    check(smDuplicate.ok, '8l. program_ssp_metadata: a second row for the same program is refused (primary key, 23505)', smDuplicate.detail);
    // program B has no row yet: the shape CHECK is judged before the key, so a refused row never lands
    const smShape = { code: '23514', constraint: 'program_ssp_metadata_shape_check' };
    const smUnknownKey = await rejectsIn(scopeB, insertMeta, [TENANT_X, programB, JSON.stringify({ rls_verify_unknown: 'x' }), 'rls_verify_actor'], smShape);
    const smNumber = await rejectsIn(scopeB, insertMeta, [TENANT_X, programB, JSON.stringify({ systemName: 5 }), 'rls_verify_actor'], smShape);
    const smTooBig = await rejectsIn(scopeB, insertMeta, [TENANT_X, programB, JSON.stringify({ systemEnvironment: 'x'.repeat(262144) }), 'rls_verify_actor'], smShape);
    check(smUnknownKey.ok && smNumber.ok && smTooBig.ok, '8l. program_ssp_metadata: an unknown key, a numeric value and a value over 262 144 bytes are each refused (23514, program_ssp_metadata_shape_check)', [smUnknownKey.detail, smNumber.detail, smTooBig.detail].join(' | '));
    // the stack profile of a tenant: only the known keys, at most 16 384 bytes. The CHECK runs on the proposed row before
    // ON CONFLICT is considered, so this insert is refused whether or not the tenant row exists and never writes anything.
    let stackProfileBad = 'no error';
    try {
      await queryWithTenant(
        TENANT_X,
        `INSERT INTO tenants (id, name, system_name, system_owner, stack_profile) VALUES ($1, $1, 'sys', 'owner', $2::jsonb) ON CONFLICT (id) DO NOTHING`,
        [TENANT_X, '{"x":1}']
      );
    } catch (err) {
      stackProfileBad = String((err as { code?: string }).code) + ' ' + String((err as { constraint?: string }).constraint);
    }
    check(stackProfileBad === '23514 tenants_stack_profile_check', '8l. tenants: a stack profile with an unknown key is refused (23514, tenants_stack_profile_check)', stackProfileBad);
    // the first-writer race: two writes that both expect no row; the row lock plus INSERT ... DO NOTHING lets exactly one win
    const { createProgram: createSmProgram } = await import('../server/programs');
    const { writeSspMetadata } = await import('../server/sspMetadata');
    const smRaceProgram = await createSmProgram(TENANT_X, { name: 'rls_verify_ssp_race', frameworkId: 'CMMC_L2' }, null);
    const smRaceScope = { tenantId: TENANT_X, programId: smRaceProgram.id };
    const smActor = { actor: 'rls_verify_actor', userId: null };
    const smRace = await Promise.allSettled([
      writeSspMetadata(smRaceScope, { systemName: 'rls_verify_race_1' }, smActor, { expectedUpdatedAt: null }),
      writeSspMetadata(smRaceScope, { systemName: 'rls_verify_race_2' }, smActor, { expectedUpdatedAt: null }),
    ]);
    const smRaceWon = smRace.filter((r) => r.status === 'fulfilled').length;
    const smRaceLost = smRace.filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason?.code === 'stale_write').length;
    check(smRaceWon === 1 && smRaceLost === 1, '8l. program_ssp_metadata: of two concurrent first writes exactly one succeeds and the other is a stale_write', smRace.map((r) => r.status + (r.status === 'rejected' ? ':' + String((r.reason as { code?: unknown })?.code) : '')).join(' '));
    const smRaceEvents = await queryWithProgram(smRaceScope, "SELECT 1 FROM program_events WHERE program_id = $1 AND kind = 'ssp_metadata_changed'", [smRaceProgram.id]);
    check(smRaceEvents.rows.length === 1, '8l. program_events: exactly one ssp_metadata_changed event for the program (the refused write recorded nothing)', 'saw ' + smRaceEvents.rows.length);
    await queryWithProgram(smRaceScope, 'DELETE FROM program_events WHERE program_id = $1', [smRaceProgram.id]).catch(() => undefined);
    // the cascade: deleting the program (tenant context only) removes its row; a foreign-key cascade is not filtered by row security
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, smRaceProgram.id]);
    const smCascade = await queryWithProgram(smRaceScope, 'SELECT 1 FROM program_ssp_metadata WHERE program_id = $1', [smRaceProgram.id]);
    check(smCascade.rows.length === 0, '8l. program_ssp_metadata: deleting a program removes its row through the cascade', 'saw ' + smCascade.rows.length);

    await verifyUpgrade();
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM enclave_assets WHERE asset_name LIKE 'rls_verify_%'", []).catch(() => undefined); // the membership rows cascade with their asset
    }
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
