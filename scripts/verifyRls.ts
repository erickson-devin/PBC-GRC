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
 *   9. objective catalog update (issue #273): the one-time migration of stored CMMC objective answers (ensureObjectiveCatalogCurrent) on PostgreSQL. control_objectives.objective_catalog_rev exists and is nullable; two concurrent calls change a legacy row once (SELECT ... FOR UPDATE: one 'catalog-update' event, hashes and lengths only), keep narrative, evidence and Not met answers, re-roll up the Met control, stamp the revision, leave the updated_at of unchanged rows alone, and a third call does nothing; another program of the tenant, an archived program and a non-CMMC framework are not touched.
 *   10. objective roll-up (issue #307): writeObjective with framework CMMC_L2 lowers one objective of a Met control and the control is lowered in the same transaction. The event CHECK on control_assessment_events.source accepts 'objective-rollup', exactly one such event exists (MET -> the rolled-up status, notes unchanged and kept only as a digest), another program's Met control is untouched, and the same write under a non-CMMC framework lowers nothing.
 *   11. Tools and services register (#239, #243, #248, #249): 8t inventory_vendors, inventory_tools and inventory_events (tenant isolation, the composite vendor key that nulls on delete, the unique name / seed / rank indexes, the CHECKs, the append-only history); 8u program_tools and program_tool_controls (program isolation, composite foreign keys, cascades from a tool and from a program); 8v the data inventory (program_data_inventory, program_cui_categories, program_cui_category_tools: isolation, the category and role CHECKs, the cascade from the answer); 8w program_vendor_documents (isolation, doc_kind CHECK, vendor cascade) and program_inventory_events (isolation, no foreign key, append-only). Rows are prefixed rls_verify.
 * It inserts and removes a few rows prefixed "rls_verify_" in tenants, tenant_users, enclave_assets, programs, control_assessments, control_assessment_events (actor "rls_verify_actor"), the vm_* tables (plus "RLS-VERIFY-" rows in vm_vulns) and local_users (ids "rls_verify_lu_*", plus their local_user_password_history rows); section 3e also writes control_objective_events (actor "rls_verify_actor") for programs it creates and deletes; section 8e creates and drops the schema rls_verify_upgrade. Exit code 0 = all checks passed.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

process.env.NODE_ENV = 'production'; // never fall back to the in-memory store: this script must hit the real DB

const { pool, initDb, queryWithTenant, queryWithProgram, queryWithUser, listUserTenants, checkDatabaseConnection } = await import('../server/db');
const { RLS_TENANT_TABLES, RLS_PROGRAM_TABLES, PROGRAM_BACKFILL_TABLES } = await import('../server/schema');
// The tables that existed before programs: they got a nullable program_id and a NOT VALID program_required check. Every other program table (the objective tables, program_events, program_assets, program_ssp_*, vm_poam_item_events, control_poam_* and the inventory program tables) is new (program_id NOT NULL).
const LEGACY_PROGRAM_TABLES: string[] = [...PROGRAM_BACKFILL_TABLES];
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
async function rejectsIn(scope: ProgramScope, sql: string, params: (string | number | boolean | null)[], want: { code?: string; constraint?: string }): Promise<{ ok: boolean; detail: string }> {
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

    // 11. vm_run_assets: which assets a run reported (ids only)
    const insertRunAsset = 'INSERT INTO vm_run_assets (tenant_id, run_id, asset_id) VALUES ($1, $2, $3)';
    let runAssetOk = false;
    try {
      await queryWithTenant(TENANT_X, insertRunAsset, [TENANT_X, runIdX, assetIdX]);
      runAssetOk = true;
    } catch {
      runAssetOk = false;
    }
    check(runAssetOk, 'vm_run_assets: tenant X can record an asset for its own run and asset');
    check(
      await rejectsWith(TENANT_X, insertRunAsset, [TENANT_X, runIdX, assetIdX], { code: '23505', constraint: 'vm_run_assets_pkey' }),
      'vm_run_assets: the same (tenant, run, asset) twice is refused (primary key)', lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertRunAsset, [TENANT_X, runIdX, assetIdY], { code: '23503', constraint: 'fk_vm_run_assets_asset' }),
      "vm_run_assets: a row naming tenant Y's asset is refused (composite foreign key)", lastRejection
    );
    const runY = await queryWithTenant(
      TENANT_Y,
      "INSERT INTO vm_runs (tenant_id, source_id, raw_path, raw_sha256) VALUES ($1, $2, 'rls_verify', $3) RETURNING id",
      [TENANT_Y, srcIdY, '9'.repeat(64)]
    );
    const runIdY = runY.rows[0]?.id;
    check(
      await rejectsWith(TENANT_X, insertRunAsset, [TENANT_X, runIdY, assetIdX], { code: '23503', constraint: 'fk_vm_run_assets_run' }),
      "vm_run_assets: a row naming tenant Y's run is refused (composite foreign key)", lastRejection
    );
    const runAssetsStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_run_assets WHERE tenant_id = $1', [TENANT_X]);
    check(runAssetsStolen.rows.length === 0, 'vm_run_assets: tenant Y cannot read tenant X rows even by naming the tenant');
    const runAssetsNoCtx = await pool.query('SELECT 1 FROM vm_run_assets WHERE run_id = $1', [runIdX]);
    check(runAssetsNoCtx.rowCount === 0, 'vm_run_assets: no tenant context => zero rows visible', `saw ${runAssetsNoCtx.rowCount}`);
    check(
      await rejectsWith(TENANT_X, insertRunAsset, [TENANT_Y, runIdX, assetIdX], { code: '42501' }),
      'vm_run_assets: tenant X cannot insert a row for tenant Y (WITH CHECK)', lastRejection
    );
    await queryWithTenant(TENANT_X, insertRunAsset, [TENANT_X, runIdX2, assetIdX]);
    await queryWithTenant(TENANT_X, 'DELETE FROM vm_runs WHERE id = $1', [runIdX2]);
    const runAssetsCascade = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_run_assets WHERE run_id = $1', [runIdX2]);
    check(runAssetsCascade.rows.length === 0, 'vm_run_assets: rows go with their run (ON DELETE CASCADE)', `saw ${runAssetsCascade.rows.length}`);

    // 12. vm_config_scans: one configuration scan of an asset in a run (issue #103), tenant-wide like every VM table
    const insertConfigScan =
      "INSERT INTO vm_config_scans (tenant_id, run_id, source_id, asset_id, benchmark_id, scanner_name, scanned_at, received_at) VALUES ($1, $2, $3, $4, 'rls_verify_bench', 'rls_verify', NOW(), NOW()) RETURNING id";
    const scanX = await queryWithTenant(TENANT_X, insertConfigScan, [TENANT_X, runIdX, srcIdX, assetIdX]);
    const scanIdX = scanX.rows[0]?.id;
    check(Boolean(scanIdX), 'vm_config_scans: tenant X can record a scan for its own run, source and asset');
    check(
      await rejectsWith(TENANT_X, insertConfigScan, [TENANT_X, runIdX, srcIdX, assetIdY], { code: '23503', constraint: 'fk_vm_config_scans_asset' }),
      "vm_config_scans: a scan naming tenant Y's asset is refused (composite foreign key)", lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertConfigScan, [TENANT_X, runIdY, srcIdX, assetIdX], { code: '23503', constraint: 'fk_vm_config_scans_run' }),
      "vm_config_scans: a scan naming tenant Y's run is refused (composite foreign key)", lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertConfigScan, [TENANT_X, runIdX, srcIdY, assetIdX], { code: '23503', constraint: 'fk_vm_config_scans_source' }),
      "vm_config_scans: a scan naming tenant Y's source is refused (composite foreign key)", lastRejection
    );
    const scansStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_config_scans WHERE tenant_id = $1', [TENANT_X]);
    check(scansStolen.rows.length === 0, 'vm_config_scans: tenant Y cannot read tenant X rows even by naming the tenant');
    const scansNoCtx = await pool.query('SELECT 1 FROM vm_config_scans WHERE run_id = $1', [runIdX]);
    check(scansNoCtx.rowCount === 0, 'vm_config_scans: no tenant context => zero rows visible', `saw ${scansNoCtx.rowCount}`);
    check(
      await rejectsWith(TENANT_X, insertConfigScan, [TENANT_Y, runIdX, srcIdX, assetIdX], { code: '42501' }),
      'vm_config_scans: tenant X cannot insert a row for tenant Y (WITH CHECK)', lastRejection
    );

    // 13. vm_config_results: the rule results of a scan
    const insertConfigResult = "INSERT INTO vm_config_results (tenant_id, scan_id, rule_id, result) VALUES ($1, $2, 'rls_verify_rule', $3)";
    let configResultOk = false;
    try {
      await queryWithTenant(TENANT_X, insertConfigResult, [TENANT_X, scanIdX, 'pass']);
      configResultOk = true;
    } catch {
      configResultOk = false;
    }
    check(configResultOk, 'vm_config_results: tenant X can record a rule result for its own scan');
    check(
      await rejectsWith(TENANT_X, insertConfigResult, [TENANT_X, scanIdX, 'PASS'], { code: '23514', constraint: 'vm_config_results_result_check' }),
      'vm_config_results: a result value outside the XCCDF list is refused', lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertConfigResult, [TENANT_X, scanIdX, 'fail'], { code: '23505', constraint: 'vm_config_results_pkey' }),
      'vm_config_results: the same rule twice in one scan is refused (primary key)', lastRejection
    );
    const scanY = await queryWithTenant(TENANT_Y, insertConfigScan, [TENANT_Y, runIdY, srcIdY, assetIdY]);
    const scanIdY = scanY.rows[0]?.id;
    check(
      await rejectsWith(TENANT_X, insertConfigResult, [TENANT_X, scanIdY, 'pass'], { code: '23503', constraint: 'fk_vm_config_results_scan' }),
      "vm_config_results: a row naming tenant Y's scan is refused (composite foreign key)", lastRejection
    );
    const resultsStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_config_results WHERE tenant_id = $1', [TENANT_X]);
    check(resultsStolen.rows.length === 0, 'vm_config_results: tenant Y cannot read tenant X rows even by naming the tenant');
    const resultsNoCtx = await pool.query('SELECT 1 FROM vm_config_results WHERE scan_id = $1', [scanIdX]);
    check(resultsNoCtx.rowCount === 0, 'vm_config_results: no tenant context => zero rows visible', `saw ${resultsNoCtx.rowCount}`);
    check(
      await rejectsWith(TENANT_X, insertConfigResult, [TENANT_Y, scanIdX, 'pass'], { code: '42501' }),
      'vm_config_results: tenant X cannot insert a row for tenant Y (WITH CHECK)', lastRejection
    );
    const runX3 = await queryWithTenant(
      TENANT_X,
      "INSERT INTO vm_runs (tenant_id, source_id, raw_path, raw_sha256) VALUES ($1, $2, 'rls_verify', $3) RETURNING id",
      [TENANT_X, srcIdX, '7'.repeat(64)]
    );
    const runIdX3 = runX3.rows[0]?.id;
    const scanX3 = await queryWithTenant(TENANT_X, insertConfigScan, [TENANT_X, runIdX3, srcIdX, assetIdX]);
    const scanIdX3 = scanX3.rows[0]?.id;
    await queryWithTenant(TENANT_X, insertConfigResult, [TENANT_X, scanIdX3, 'fail']);
    await queryWithTenant(TENANT_X, 'DELETE FROM vm_runs WHERE id = $1', [runIdX3]);
    const scanCascade = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_config_scans WHERE id = $1', [scanIdX3]);
    const resultCascade = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_config_results WHERE scan_id = $1', [scanIdX3]);
    check(scanCascade.rows.length === 0 && resultCascade.rows.length === 0, 'vm_config_scans and vm_config_results: rows go with their run (ON DELETE CASCADE)', `saw ${scanCascade.rows.length} scans, ${resultCascade.rows.length} results`);

    // 14. vm_host_inventory and vm_host_software: the current view one source has of a host, and its packages (issue #229 phase 2)
    const insertInventory =
      "INSERT INTO vm_host_inventory (tenant_id, asset_id, source_id, collected_at, first_seen_at, last_seen_at, last_run_id) VALUES ($1, $2, $3, NOW(), NOW(), NOW(), 'rls_verify')";
    let inventoryOk = false;
    try {
      await queryWithTenant(TENANT_X, insertInventory, [TENANT_X, assetIdX, srcIdX]);
      inventoryOk = true;
    } catch {
      inventoryOk = false;
    }
    check(inventoryOk, 'vm_host_inventory: tenant X can record a host view for its own asset and source');
    check(
      await rejectsWith(TENANT_X, insertInventory, [TENANT_X, assetIdY, srcIdX], { code: '23503', constraint: 'fk_vm_host_inventory_asset' }),
      "vm_host_inventory: a row naming tenant Y's asset is refused (composite foreign key)", lastRejection
    );
    check(
      await rejectsWith(TENANT_X, insertInventory, [TENANT_X, assetIdX, srcIdY], { code: '23503', constraint: 'fk_vm_host_inventory_source' }),
      "vm_host_inventory: a row naming tenant Y's source is refused (composite foreign key)", lastRejection
    );
    const inventoryStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_host_inventory WHERE tenant_id = $1', [TENANT_X]);
    check(inventoryStolen.rows.length === 0, 'vm_host_inventory: tenant Y cannot read tenant X rows even by naming the tenant');
    const inventoryNoCtx = await pool.query('SELECT 1 FROM vm_host_inventory WHERE asset_id = $1', [assetIdX]);
    check(inventoryNoCtx.rowCount === 0, 'vm_host_inventory: no tenant context => zero rows visible', `saw ${inventoryNoCtx.rowCount}`);
    check(
      await rejectsWith(TENANT_X, insertInventory, [TENANT_Y, assetIdX, srcIdX], { code: '42501' }),
      'vm_host_inventory: tenant X cannot insert a row for tenant Y (WITH CHECK)', lastRejection
    );
    const insertSoftware =
      "INSERT INTO vm_host_software (tenant_id, asset_id, source_id, name, version, architecture, first_seen_at, last_seen_at) VALUES ($1, $2, $3, 'rls_verify_pkg', '1', 'x', NOW(), NOW())";
    let softwareOk = false;
    try {
      await queryWithTenant(TENANT_X, insertSoftware, [TENANT_X, assetIdX, srcIdX]);
      softwareOk = true;
    } catch {
      softwareOk = false;
    }
    check(softwareOk, 'vm_host_software: tenant X can record a package for its own host view');
    check(
      await rejectsWith(TENANT_X, insertSoftware, [TENANT_X, assetIdY, srcIdX], { code: '23503', constraint: 'fk_vm_host_software_host' }),
      "vm_host_software: a package naming tenant Y's host view is refused (composite foreign key)", lastRejection
    );
    const softwareStolen = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM vm_host_software WHERE tenant_id = $1', [TENANT_X]);
    check(softwareStolen.rows.length === 0, 'vm_host_software: tenant Y cannot read tenant X rows even by naming the tenant');
    const softwareNoCtx = await pool.query('SELECT 1 FROM vm_host_software WHERE asset_id = $1', [assetIdX]);
    check(softwareNoCtx.rowCount === 0, 'vm_host_software: no tenant context => zero rows visible', `saw ${softwareNoCtx.rowCount}`);
    check(
      await rejectsWith(TENANT_X, insertSoftware, [TENANT_Y, assetIdX, srcIdX], { code: '42501' }),
      'vm_host_software: tenant X cannot insert a row for tenant Y (WITH CHECK)', lastRejection
    );
    // A throwaway asset proves the cascade without disturbing the rows the later blocks use.
    const cascadeAsset = await queryWithTenant(
      TENANT_X,
      "INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, 'rls_verify_inventory_cascade', 'CONTRACTOR_RISK') RETURNING id",
      [TENANT_X]
    );
    const cascadeAssetId = cascadeAsset.rows[0]?.id;
    await queryWithTenant(TENANT_X, insertInventory, [TENANT_X, cascadeAssetId, srcIdX]);
    await queryWithTenant(TENANT_X, insertSoftware, [TENANT_X, cascadeAssetId, srcIdX]);
    await queryWithTenant(TENANT_X, 'DELETE FROM enclave_assets WHERE id = $1', [cascadeAssetId]);
    const invCascade = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_host_inventory WHERE asset_id = $1', [cascadeAssetId]);
    const swCascade = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_host_software WHERE asset_id = $1', [cascadeAssetId]);
    check(invCascade.rows.length === 0 && swCascade.rows.length === 0, 'vm_host_inventory and vm_host_software: rows go with their asset (ON DELETE CASCADE)', `saw ${invCascade.rows.length} hosts, ${swCascade.rows.length} packages`);

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
    const underRetention = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
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
      await queryWithTenant(t, "DELETE FROM vm_run_assets WHERE run_id IN (SELECT id FROM vm_runs WHERE raw_path = 'rls_verify')", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_config_scans WHERE run_id IN (SELECT id FROM vm_runs WHERE raw_path = 'rls_verify')", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM vm_host_inventory WHERE last_run_id = 'rls_verify'", []).catch(() => undefined); // its packages go with it
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
  await verifyMembershipProfile();
  await verifyLocalIdentities();
  await verifyAccountEvents();
  await verifyProgramIsolation();
  await verifyCatalogUpdate();
  await verifyObjectiveRollup();
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

/** Issues #258, #259: the membership profile columns on tenant_users: one primary contact per tenant, value checks, tenant isolation of writes. */
async function verifyMembershipProfile() {
  console.log('\n--- 4b. Membership profile (access expiry, affiliation, US person, primary contact) ---');
  let lastRejection = '';
  const rejects = async (tenant: string, sql: string, params: (string | number | null)[], want: { code: string; constraint?: string }): Promise<boolean> => {
    try {
      await queryWithTenant(tenant, sql, params);
      lastRejection = 'no error';
      return false;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      lastRejection = `code ${e.code}, constraint ${e.constraint}`;
      return e.code === want.code && (want.constraint === undefined || e.constraint === want.constraint);
    }
  };
  const join = (tenant: string, user: string) =>
    queryWithTenant(
      tenant,
      `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ($1, $2, $1, $3, 'VIEWER') ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [user, `${user}@example.mil`, tenant]
    );
  const flag = (tenant: string, user: string, on: boolean) =>
    queryWithTenant(tenant, 'UPDATE tenant_users SET is_primary_contact = $3 WHERE tenant_id = $1 AND user_id = $2', [tenant, user, on]);
  const U1 = 'rls_verify_mp_u1';
  const U2 = 'rls_verify_mp_u2';
  const U3 = 'rls_verify_mp_u3';
  try {
    await join(TENANT_X, U1);
    await join(TENANT_X, U2);
    await join(TENANT_Y, U3);

    await flag(TENANT_X, U1, true);
    check(await rejects(TENANT_X, 'UPDATE tenant_users SET is_primary_contact = TRUE WHERE tenant_id = $1 AND user_id = $2', [TENANT_X, U2], { code: '23505', constraint: 'uq_tenant_users_primary_contact' }), 'a second primary contact in the same tenant is refused (unique index)', lastRejection);
    let otherTenantOk = true;
    try {
      await flag(TENANT_Y, U3, true);
    } catch {
      otherTenantOk = false;
    }
    check(otherTenantOk, 'a primary contact in another tenant is allowed (the index is per tenant)');
    await flag(TENANT_X, U1, false);
    await flag(TENANT_X, U2, true);
    const mine = await queryWithTenant(TENANT_X, 'SELECT user_id FROM tenant_users WHERE tenant_id = $1 AND is_primary_contact', [TENANT_X]);
    check(mine.rows.length === 1 && mine.rows[0].user_id === U2, 'the flag can move to another member once cleared', JSON.stringify(mine.rows));

    const stolen = await queryWithTenant(TENANT_X, 'UPDATE tenant_users SET access_expires_on = CURRENT_DATE WHERE tenant_id = $1', [TENANT_Y]);
    check(stolen.rowCount === 0, 'tenant X cannot set an expiry on a tenant Y member (0 rows)', 'rows updated: ' + stolen.rowCount);

    // node-pg returns a DATE as local midnight: the stored day must come back as the same calendar day (read with the local getters).
    await queryWithTenant(TENANT_X, "UPDATE tenant_users SET access_expires_on = DATE '2031-03-01' WHERE tenant_id = $1 AND user_id = $2", [TENANT_X, U1]);
    const { listTenantMembers } = await import('../server/db');
    const back = (await listTenantMembers(TENANT_X)).find((m) => m.userId === U1);
    check(back?.profile.accessExpiresOn === '2031-03-01', 'a stored expiry date reads back as the same calendar day', JSON.stringify(back?.profile));

    const seen = await queryWithUser(U1, 'SELECT access_expires_on FROM tenant_users WHERE user_id LIKE $1', ['rls_verify_mp_%']);
    check(seen.rows.length === 1, 'in user context only the user\'s own membership row is readable', `saw ${seen.rows.length}`);

    check(await rejects(TENANT_X, "UPDATE tenant_users SET affiliation = 'BOGUS' WHERE tenant_id = $1 AND user_id = $2", [TENANT_X, U1], { code: '23514', constraint: 'tenant_users_affiliation_check' }), 'an affiliation outside the list is refused (affiliation_check)', lastRejection);
    check(await rejects(TENANT_X, "UPDATE tenant_users SET us_person = 'MAYBE' WHERE tenant_id = $1 AND user_id = $2", [TENANT_X, U1], { code: '23514', constraint: 'tenant_users_us_person_check' }), 'a US person value outside the list is refused (us_person_check)', lastRejection);
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM tenant_users WHERE user_id LIKE 'rls_verify_mp_%'", []).catch(() => undefined);
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

    // V30b (issue #256): the migrated action list accepts the system use notice actions, and the notice table is one global row.
    await recordAccountEvent({ actorKind: 'user', actorUserId: TARGET, targetUserId: TARGET, action: 'system_use_acknowledged', details: { via: 'sign_in', noticeVersion: '1' } });
    const acked = (await listAccountEvents({ limit: 200 })).filter((e) => e.targetUserId === TARGET && e.action === 'system_use_acknowledged');
    check(acked.length === 1 && acked[0].details.noticeVersion === '1', 'the action list (migrated or new) accepts system_use_acknowledged', JSON.stringify(acked));
    const noticeFlags = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'platform_system_use_notice' AND relkind = 'r'");
    check(noticeFlags.rows[0]?.relrowsecurity === false, 'platform_system_use_notice: row security is NOT enabled (global table, read before sign-in)', JSON.stringify(noticeFlags.rows));
    check(
      await rejects(() => pool.query("INSERT INTO platform_system_use_notice (id, notice_text) VALUES (2, 'rls verify')"), { code: '23514', constraint: 'platform_system_use_notice_singleton' }),
      'a second platform_system_use_notice row (id 2) is refused (singleton check)', lastRejection
    );

    // V30c (issue #214): the migrated action list accepts the service token actions.
    await recordAccountEvent({ actorKind: 'user', actorUserId: TARGET, targetUserId: TARGET, action: 'vm_token_created', scopeTenantId: 'rls_verify_t', details: { tokenId: 'vmt_0123456789abcdef' } });
    const tokEvents = (await listAccountEvents({ limit: 200 })).filter((e) => e.targetUserId === TARGET && e.action === 'vm_token_created');
    check(tokEvents.length === 1 && tokEvents[0].details.tokenId === 'vmt_0123456789abcdef' && tokEvents[0].tenantId === 'rls_verify_t', 'the action list (migrated or new) accepts vm_token_created', JSON.stringify(tokEvents));

    // V30d (issues #258, #260): the migrated action list accepts the membership and announcement actions; the two announcement tables are global.
    await recordAccountEvent({ actorKind: 'user', actorUserId: TARGET, targetUserId: TARGET, action: 'membership_updated', scopeTenantId: 'rls_verify_t', details: { field: 'us_person', via: 'member_update' } });
    await recordAccountEvent({ actorKind: 'admin', actorUserId: TARGET, targetUserId: TARGET, action: 'announcement_posted', details: { announcementId: 'rls_verify_ann' } });
    await recordAccountEvent({ actorKind: 'admin', actorUserId: TARGET, targetUserId: TARGET, action: 'announcement_withdrawn', details: { announcementId: 'rls_verify_ann' } });
    const newActions = (await listAccountEvents({ limit: 200 })).filter((e) => e.targetUserId === TARGET).map((e) => e.action);
    check(['membership_updated', 'announcement_posted', 'announcement_withdrawn'].every((a) => newActions.includes(a as never)), 'the action list (migrated or new) accepts membership_updated, announcement_posted and announcement_withdrawn', JSON.stringify(newActions));
    const annFlags = await pool.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('platform_announcements', 'user_notice_reads') AND relkind = 'r'");
    check(annFlags.rows.length === 2 && annFlags.rows.every((r) => r.relrowsecurity === false), 'platform_announcements and user_notice_reads: row security is NOT enabled (global tables)', JSON.stringify(annFlags.rows));
    check(
      await rejects(() => pool.query("INSERT INTO platform_announcements (title, body, created_by_user_id) VALUES ('   ', 'rls verify', 'rls_verify_ann')"), { code: '23514', constraint: 'platform_announcements_title_check' }),
      'an announcement with a blank title is refused (title_check)', lastRejection
    );
    check(
      await rejects(() => pool.query("INSERT INTO platform_announcements (title, body, created_by_user_id) VALUES ('rls verify', repeat('x', 2001), 'rls_verify_ann')"), { code: '23514', constraint: 'platform_announcements_body_check' }),
      'an announcement body over 2000 characters is refused (body_check)', lastRejection
    );
    check(
      await rejects(() => pool.query("INSERT INTO user_notice_reads (user_id, kind, ref) VALUES ('rls_verify_ann', 'x', '1.0.0')"), { code: '23514', constraint: 'user_notice_reads_kind_check' }),
      'a notice read of an unknown kind is refused (kind_check)', lastRejection
    );

    // V-216 (issue #216): the simulator-era scan columns are retired: kept, marked, and (by the startup fix) nulled.
    const retired = await pool.query(
      "SELECT col_description('enclave_assets'::regclass, attnum) AS marker FROM pg_attribute WHERE attrelid = 'enclave_assets'::regclass AND attname IN ('compliance_score', 'last_scanned_at')"
    );
    check(retired.rows.length === 2 && retired.rows.every((r) => r.marker === 'Retired (#216): not written or shown'), 'V-216 compliance_score and last_scanned_at carry the retirement marker', JSON.stringify(retired.rows));

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

    // 8x. vulnerability POA&M item history (#295, #297): vm_poam_item_events isolation, its CHECKs, no foreign key (same pattern as 8i)
    const insertPoamEvent = "INSERT INTO vm_poam_item_events (tenant_id, program_id, item_id, source, actor, actor_user_id, old_status, new_status) VALUES ($1, $2, 'rls_verify_item', $3, $4, $5, 'OPEN', $6) RETURNING id";
    const poamEvArgs = (program: string | null, source = 'human', actor = 'rls_verify_actor', user: string | null = 'rls_verify_user', status = 'COMPLETED') => [TENANT_X, program, source, actor, user, status];
    const pv1 = await queryWithProgram(scopeA, insertPoamEvent, poamEvArgs(programA));
    check(pv1.rows.length === 1, '8x. vm_poam_item_events: under program A the event is inserted');
    const pvBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM vm_poam_item_events WHERE program_id = $1', [programA]);
    const pvBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM vm_poam_item_events WHERE tenant_id = $1', [TENANT_X]);
    check(pvBSeesA.rows.length === 0 && pvBSeesAny.rows.length === 0, "8x. vm_poam_item_events: program B cannot read program A's event (0 rows, by program or by tenant)", 'saw ' + pvBSeesA.rows.length + ' / ' + pvBSeesAny.rows.length);
    const pvBUpdates = await queryWithProgram(scopeB, "UPDATE vm_poam_item_events SET actor = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const pvBDeletes = await queryWithProgram(scopeB, 'DELETE FROM vm_poam_item_events WHERE program_id = $1', [programA]);
    check((pvBUpdates.rowCount ?? 0) === 0 && (pvBDeletes.rowCount ?? 0) === 0, "8x. vm_poam_item_events: program B can neither update nor delete program A's event (0 rows)", 'updated ' + pvBUpdates.rowCount + ', deleted ' + pvBDeletes.rowCount);
    const pvBInserts = await rejectsIn(scopeB, insertPoamEvent, poamEvArgs(programA), { code: '42501' });
    check(pvBInserts.ok, '8x. vm_poam_item_events: program B cannot insert an event into program A (WITH CHECK, 42501)', pvBInserts.detail);
    const pvNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM vm_poam_item_events WHERE tenant_id = $1', [TENANT_X]);
    check(pvNoCtx.rows.length === 0, '8x. vm_poam_item_events: a tenant context with no program context sees zero rows', 'saw ' + pvNoCtx.rows.length);
    let pvNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertPoamEvent, poamEvArgs(programA));
    } catch (err) {
      pvNoCtxInsert = String((err as { code?: string }).code);
    }
    check(pvNoCtxInsert === '42501', '8x. vm_poam_item_events: no program context cannot insert an event (42501)', pvNoCtxInsert);
    const pvBadStatus = await rejectsIn(scopeA, insertPoamEvent, poamEvArgs(programA, 'human', 'rls_verify_actor', 'rls_verify_user', 'BOGUS'), { code: '23514', constraint: 'vm_poam_item_events_status_check' });
    check(pvBadStatus.ok, '8x. vm_poam_item_events: an unknown status is refused (23514, vm_poam_item_events_status_check)', pvBadStatus.detail);
    const pvBadSystem = await rejectsIn(scopeA, insertPoamEvent, poamEvArgs(programA, 'system', 'rls_verify_actor', null), { code: '23514', constraint: 'vm_poam_item_events_system_check' });
    check(pvBadSystem.ok, '8x. vm_poam_item_events: a system event must carry the worker as actor and no user id (23514, vm_poam_item_events_system_check)', pvBadSystem.detail);
    const pvFk = await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'vm_poam_item_events'::regclass AND contype = 'f'");
    check(pvFk.rows[0]?.n === 0, '8x. vm_poam_item_events: no foreign key (the history outlives the item and the program)', JSON.stringify(pvFk.rows[0]));
    const pvNotNull = await pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'vm_poam_item_events'::regclass AND attname = 'program_id' AND NOT attisdropped");
    check(pvNotNull.rows.length === 1 && pvNotNull.rows[0].attnotnull === true, '8x. vm_poam_item_events: program_id is NOT NULL (attnotnull)', JSON.stringify(pvNotNull.rows));
    await queryWithProgram(scopeA, "DELETE FROM vm_poam_item_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);

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
    // the twelfth key (serviceCommitments) is accepted by the shape CHECK: merging it into program A's row under A's scope updates exactly that row
    const smServiceCommitments = await queryWithProgram(scopeA, "UPDATE program_ssp_metadata SET metadata = metadata || jsonb_build_object('serviceCommitments', 'rls_verify_sc') WHERE program_id = $1", [programA]);
    check((smServiceCommitments.rowCount ?? 0) === 1, '8l. program_ssp_metadata: the serviceCommitments key is accepted by the shape CHECK (one row updated under program A)', 'updated ' + smServiceCommitments.rowCount);
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

    // 8n. programs.stack_profile (issue #230): rides the programs tenant policy; the CHECK pins the keys and the size like the tenant's
    const spProfile = JSON.stringify({ identityProvider: 'OKTA', edrSolution: 'SENTINELONE', infrastructure: 'ON_PREM_RHEL', mdmSolution: 'JAMF', siemSolution: 'ELASTIC' });
    const spSetX = await queryWithTenant(TENANT_X, 'UPDATE programs SET stack_profile = $3::jsonb WHERE tenant_id = $1 AND id = $2', [TENANT_X, programA, spProfile]);
    const spSeenY = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM programs WHERE id = $1 AND stack_profile IS NOT NULL', [programA]);
    const spSetY = await queryWithTenant(TENANT_Y, 'UPDATE programs SET stack_profile = $3::jsonb WHERE tenant_id = $1 AND id = $2', [TENANT_X, programA, spProfile]);
    check((spSetX.rowCount ?? 0) === 1 && spSeenY.rows.length === 0 && (spSetY.rowCount ?? 0) === 0, "8n. programs.stack_profile: tenant X writes its program's profile; tenant Y neither sees it nor updates it", 'X ' + spSetX.rowCount + ', Y sees ' + spSeenY.rows.length + ' updates ' + spSetY.rowCount);
    const spReadX = await queryWithTenant(TENANT_X, 'SELECT stack_profile FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, programA]);
    check(spReadX.rows[0]?.stack_profile?.identityProvider === 'OKTA', '8n. programs.stack_profile: tenant X reads the profile back', JSON.stringify(spReadX.rows[0]?.stack_profile ?? null));
    let spBad = 'no error';
    try {
      await queryWithTenant(TENANT_X, 'UPDATE programs SET stack_profile = $3::jsonb WHERE tenant_id = $1 AND id = $2', [TENANT_X, programA, '{"x":1}']);
    } catch (err) {
      spBad = String((err as { code?: string }).code) + ' ' + String((err as { constraint?: string }).constraint);
    }
    check(spBad === '23514 programs_stack_profile_check', '8n. programs: a stack profile with an unknown key is refused (23514, programs_stack_profile_check)', spBad);
    // through the store: a changed profile records a digest-only stack_profile_changed event under program A's scope, invisible under B's
    const { updateProgram: updateSpProgram } = await import('../server/programs');
    await updateSpProgram(TENANT_X, programA, { stackProfile: { ...JSON.parse(spProfile), identityProvider: 'ENTRA_ID_GOV' } }, { actor: 'rls_verify_actor', userId: null });
    const spEvA = await queryWithProgram(scopeA, "SELECT 1 FROM program_events WHERE program_id = $1 AND kind = 'stack_profile_changed'", [programA]);
    const spEvB = await queryWithProgram(scopeB, "SELECT 1 FROM program_events WHERE program_id = $1 AND kind = 'stack_profile_changed'", [programA]);
    check(spEvA.rows.length === 1 && spEvB.rows.length === 0, '8n. program_events: a stack_profile_changed event is visible under program A and not under program B', 'A ' + spEvA.rows.length + ', B ' + spEvB.rows.length);
    await queryWithTenant(TENANT_X, 'UPDATE programs SET stack_profile = NULL WHERE tenant_id = $1 AND id = $2', [TENANT_X, programA]).catch(() => undefined);
    await queryWithProgram(scopeA, "DELETE FROM program_events WHERE program_id = $1 AND kind = 'stack_profile_changed'", [programA]).catch(() => undefined);

    // 8m. per-user default program: tenant isolation of user_program_defaults (ids only, no program policy)
    await queryWithTenant(TENANT_X, 'INSERT INTO user_program_defaults (tenant_id, user_id, program_id) VALUES ($1, $2, $3)', [TENANT_X, 'rls_verify_u1', programA]);
    const updSeenByX = await queryWithTenant(TENANT_X, 'SELECT 1 FROM user_program_defaults WHERE tenant_id = $1 AND user_id = $2', [TENANT_X, 'rls_verify_u1']);
    const updSeenByY = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM user_program_defaults WHERE tenant_id = $1', [TENANT_X]);
    check(updSeenByX.rows.length === 1 && updSeenByY.rows.length === 0, "8m. user_program_defaults: tenant X sees its own row, tenant Y sees none of X's", 'X ' + updSeenByX.rows.length + ', Y ' + updSeenByY.rows.length);
    let updRejection = 'no error';
    try {
      await queryWithTenant(TENANT_Y, 'INSERT INTO user_program_defaults (tenant_id, user_id, program_id) VALUES ($1, $2, $3)', [TENANT_X, 'rls_verify_u2', programA]);
    } catch (err) {
      updRejection = 'code ' + (err as { code?: string }).code;
    }
    check(updRejection === 'code 42501', "8m. user_program_defaults: tenant Y cannot insert a row into tenant X (WITH CHECK, 42501)", updRejection);
    await queryWithTenant(TENANT_X, "DELETE FROM user_program_defaults WHERE user_id LIKE 'rls_verify_%'", []).catch(() => undefined);

    // 8o. software_items (issue #229): tenant isolation, and the composite nullable foreign key to enclave_assets
    const swAssetX = (await queryWithTenant(TENANT_X, "INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, 'rls_verify_sw_asset_x', 'CUI_ASSET') RETURNING id", [TENANT_X])).rows[0]?.id;
    const swAssetY = (await queryWithTenant(TENANT_Y, "INSERT INTO enclave_assets (tenant_id, asset_name, cmmc_category) VALUES ($1, 'rls_verify_sw_asset_y', 'CUI_ASSET') RETURNING id", [TENANT_Y])).rows[0]?.id;
    await queryWithTenant(TENANT_X, 'INSERT INTO software_items (tenant_id, name, asset_id) VALUES ($1, $2, $3)', [TENANT_X, 'rls_verify_sw_x', swAssetX]);
    const swSeenX = await queryWithTenant(TENANT_X, "SELECT 1 FROM software_items WHERE tenant_id = $1 AND name LIKE 'rls_verify_%'", [TENANT_X]);
    const swSeenY = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM software_items WHERE tenant_id = $1', [TENANT_X]);
    check(swSeenX.rows.length === 1 && swSeenY.rows.length === 0, "8o. software_items: tenant X sees its own entry, tenant Y sees none of X's", 'X ' + swSeenX.rows.length + ', Y ' + swSeenY.rows.length);
    let swRejection = 'no error';
    try {
      await queryWithTenant(TENANT_Y, 'INSERT INTO software_items (tenant_id, name) VALUES ($1, $2)', [TENANT_X, 'rls_verify_sw_evil']);
    } catch (err) {
      swRejection = 'code ' + (err as { code?: string }).code;
    }
    check(swRejection === 'code 42501', '8o. software_items: tenant Y cannot insert an entry into tenant X (WITH CHECK, 42501)', swRejection);
    let swForeign = 'no error';
    try {
      await queryWithTenant(TENANT_X, 'INSERT INTO software_items (tenant_id, name, asset_id) VALUES ($1, $2, $3)', [TENANT_X, 'rls_verify_sw_foreign', swAssetY]);
    } catch (err) {
      swForeign = 'code ' + (err as { code?: string }).code;
    }
    check(swForeign === 'code 23503', "8o. software_items: an entry cannot link another tenant's asset (composite foreign key, 23503)", swForeign);
    await queryWithTenant(TENANT_X, 'DELETE FROM enclave_assets WHERE tenant_id = $1 AND id = $2', [TENANT_X, swAssetX]);
    const swAfterDelete = await queryWithTenant(TENANT_X, "SELECT asset_id FROM software_items WHERE tenant_id = $1 AND name = 'rls_verify_sw_x'", [TENANT_X]);
    check(swAfterDelete.rows.length === 1 && swAfterDelete.rows[0].asset_id === null, '8o. software_items: deleting the linked asset keeps the entry and sets asset_id to NULL', JSON.stringify(swAfterDelete.rows));

    // 8p. SSP profile (issues #241, #242, #246): program_ssp_profile isolation, the composite foreign key, the primary key and the shape CHECK
    const insertProfile = 'INSERT INTO program_ssp_profile (tenant_id, program_id, profile, updated_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING program_id';
    const profileJson = JSON.stringify({ systemIdentifier: 'rls_verify_sp' });
    const sp1 = await queryWithProgram(scopeA, insertProfile, [TENANT_X, programA, profileJson, 'rls_verify_actor']);
    check(sp1.rows.length === 1, '8p. program_ssp_profile: under program A the row is inserted');
    const spBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_profile WHERE program_id = $1', [programA]);
    const spBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_profile WHERE tenant_id = $1', [TENANT_X]);
    check(spBSeesA.rows.length === 0 && spBSeesAny.rows.length === 0, "8p. program_ssp_profile: program B cannot read program A's row (0 rows, by program or by tenant)", 'saw ' + spBSeesA.rows.length + ' / ' + spBSeesAny.rows.length);
    const spBUpdates = await queryWithProgram(scopeB, "UPDATE program_ssp_profile SET updated_by = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const spBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_ssp_profile WHERE program_id = $1', [programA]);
    check((spBUpdates.rowCount ?? 0) === 0 && (spBDeletes.rowCount ?? 0) === 0, "8p. program_ssp_profile: program B can neither update nor delete program A's row (0 rows)", 'updated ' + spBUpdates.rowCount + ', deleted ' + spBDeletes.rowCount);
    const spBInserts = await rejectsIn(scopeB, insertProfile, [TENANT_X, programA, profileJson, 'rls_verify_actor'], { code: '42501' });
    check(spBInserts.ok, '8p. program_ssp_profile: program B cannot insert a row into program A (WITH CHECK, 42501)', spBInserts.detail);
    const spNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_ssp_profile WHERE tenant_id = $1', [TENANT_X]);
    check(spNoCtx.rows.length === 0, '8p. program_ssp_profile: a tenant context with no program context sees zero rows', 'saw ' + spNoCtx.rows.length);
    let spNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertProfile, [TENANT_X, programA, profileJson, 'rls_verify_actor']);
    } catch (err) {
      spNoCtxInsert = String((err as { code?: string }).code);
    }
    check(spNoCtxInsert === '42501', '8p. program_ssp_profile: no program context cannot insert a row (42501)', spNoCtxInsert);
    const spForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertProfile, [TENANT_X, defaultY, profileJson, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_ssp_profile_program' });
    check(spForeignProgram.ok, "8p. program_ssp_profile: tenant X cannot attach a row to tenant Y's program (composite foreign key, 23503)", spForeignProgram.detail);
    const spDuplicate = await rejectsIn(scopeA, insertProfile, [TENANT_X, programA, profileJson, 'rls_verify_actor'], { code: '23505', constraint: 'pk_program_ssp_profile' });
    check(spDuplicate.ok, '8p. program_ssp_profile: a second row for the same program is refused (primary key, 23505)', spDuplicate.detail);
    const spShape = { code: '23514', constraint: 'program_ssp_profile_shape_check' };
    const spArray = await rejectsIn(scopeB, insertProfile, [TENANT_X, programB, '[]', 'rls_verify_actor'], spShape);
    const spTooBig = await rejectsIn(scopeB, insertProfile, [TENANT_X, programB, JSON.stringify({ systemIdentifier: 'x'.repeat(262144) }), 'rls_verify_actor'], spShape);
    check(spArray.ok && spTooBig.ok, '8p. program_ssp_profile: an array and a value over 262 144 bytes are each refused (23514, program_ssp_profile_shape_check)', [spArray.detail, spTooBig.detail].join(' | '));
    const spCascadeProgram = await createSmProgram(TENANT_X, { name: 'rls_verify_ssp_profile_cascade', frameworkId: 'CMMC_L2' }, null);
    const spCascadeScope = { tenantId: TENANT_X, programId: spCascadeProgram.id };
    await queryWithProgram(spCascadeScope, insertProfile, [TENANT_X, spCascadeProgram.id, profileJson, 'rls_verify_actor']);
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, spCascadeProgram.id]);
    const spCascade = await queryWithProgram(spCascadeScope, 'SELECT 1 FROM program_ssp_profile WHERE program_id = $1', [spCascadeProgram.id]);
    check(spCascade.rows.length === 0, '8p. program_ssp_profile: deleting a program removes its row through the cascade', 'saw ' + spCascade.rows.length);

    // 8q. SSP section sign-offs (issue #238): program_ssp_section_reviews isolation, the foreign key, the CHECKs, the append-only trigger and the cascade
    const insertReview = 'INSERT INTO program_ssp_section_reviews (tenant_id, program_id, section_id, content_sha256, reviewer_user_id, reviewer_name, reviewer_role) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id';
    const reviewSha = 'a'.repeat(64);
    const reviewArgs = (programId: string, section = 'identification', sha = reviewSha): (string | number | null)[] => [TENANT_X, programId, section, sha, 'rls_verify_user', 'rls_verify_actor', 'TENANT_OWNER'];
    const sr1 = await queryWithProgram(scopeA, insertReview, reviewArgs(programA));
    check(sr1.rows.length === 1, '8q. program_ssp_section_reviews: under program A the sign-off is inserted');
    const srBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_section_reviews WHERE program_id = $1', [programA]);
    const srBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_ssp_section_reviews WHERE tenant_id = $1', [TENANT_X]);
    check(srBSeesA.rows.length === 0 && srBSeesAny.rows.length === 0, "8q. program_ssp_section_reviews: program B cannot read program A's sign-off (0 rows, by program or by tenant)", 'saw ' + srBSeesA.rows.length + ' / ' + srBSeesAny.rows.length);
    const srBUpdates = await queryWithProgram(scopeB, "UPDATE program_ssp_section_reviews SET reviewer_name = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const srBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_ssp_section_reviews WHERE program_id = $1', [programA]);
    check((srBUpdates.rowCount ?? 0) === 0 && (srBDeletes.rowCount ?? 0) === 0, "8q. program_ssp_section_reviews: program B can neither update nor delete program A's sign-off (0 rows)", 'updated ' + srBUpdates.rowCount + ', deleted ' + srBDeletes.rowCount);
    const srBInserts = await rejectsIn(scopeB, insertReview, reviewArgs(programA), { code: '42501' });
    check(srBInserts.ok, '8q. program_ssp_section_reviews: program B cannot insert a sign-off into program A (WITH CHECK, 42501)', srBInserts.detail);
    const srNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_ssp_section_reviews WHERE tenant_id = $1', [TENANT_X]);
    check(srNoCtx.rows.length === 0, '8q. program_ssp_section_reviews: a tenant context with no program context sees zero rows', 'saw ' + srNoCtx.rows.length);
    let srNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertReview, reviewArgs(programA));
    } catch (err) {
      srNoCtxInsert = String((err as { code?: string }).code);
    }
    check(srNoCtxInsert === '42501', '8q. program_ssp_section_reviews: no program context cannot insert a sign-off (42501)', srNoCtxInsert);
    const srForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertReview, reviewArgs(defaultY), { code: '23503', constraint: 'fk_program_ssp_section_reviews_program' });
    check(srForeignProgram.ok, "8q. program_ssp_section_reviews: tenant X cannot attach a sign-off to tenant Y's program (composite foreign key, 23503)", srForeignProgram.detail);
    const srBadSha = await rejectsIn(scopeB, insertReview, reviewArgs(programB, 'identification', 'xyz'), { code: '23514', constraint: 'program_ssp_section_reviews_sha_check' });
    const srBadSection = await rejectsIn(scopeB, insertReview, reviewArgs(programB, 'Bad Id'), { code: '23514', constraint: 'program_ssp_section_reviews_section_check' });
    const srBadAction = await rejectsIn(scopeB, "INSERT INTO program_ssp_section_reviews (tenant_id, program_id, section_id, action, content_sha256, reviewer_user_id, reviewer_name, reviewer_role) VALUES ($1, $2, 'identification', 'approved', $3, 'rls_verify_user', 'rls_verify_actor', 'TENANT_OWNER')", [TENANT_X, programB, reviewSha], { code: '23514', constraint: 'program_ssp_section_reviews_action_check' });
    check(srBadSha.ok && srBadSection.ok && srBadAction.ok, '8q. program_ssp_section_reviews: a bad sha, a bad section id and an unknown action are each refused (23514)', [srBadSha.detail, srBadSection.detail, srBadAction.detail].join(' | '));
    let srUpdateErr = 'no error';
    try {
      await queryWithProgram(scopeA, "UPDATE program_ssp_section_reviews SET reviewer_name = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      srUpdateErr = String(e.code) + (String(e.message).includes('append-only') ? ' append-only' : ' ' + String(e.message));
    }
    check(srUpdateErr === '42501 append-only', '8q. program_ssp_section_reviews: updating a sign-off is refused by the append-only trigger (42501)', srUpdateErr);
    const srStillThere = await queryWithProgram(scopeA, 'SELECT reviewer_name FROM program_ssp_section_reviews WHERE program_id = $1', [programA]);
    check(srStillThere.rows.length === 1 && srStillThere.rows[0].reviewer_name === 'rls_verify_actor', "8q. program_ssp_section_reviews: program A's sign-off is untouched", JSON.stringify(srStillThere.rows));
    const srCascadeProgram = await createSmProgram(TENANT_X, { name: 'rls_verify_ssp_reviews_cascade', frameworkId: 'CMMC_L2' }, null);
    const srCascadeScope = { tenantId: TENANT_X, programId: srCascadeProgram.id };
    await queryWithProgram(srCascadeScope, insertReview, reviewArgs(srCascadeProgram.id));
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, srCascadeProgram.id]);
    const srCascade = await queryWithProgram(srCascadeScope, 'SELECT 1 FROM program_ssp_section_reviews WHERE program_id = $1', [srCascadeProgram.id]);
    check(srCascade.rows.length === 0, '8q. program_ssp_section_reviews: deleting a program removes its sign-offs through the cascade (DELETE is allowed)', 'saw ' + srCascade.rows.length);

    // 8y. control POA&M entries (#304): control_poam_entries isolation, the composite foreign key, the primary key, the CHECKs and the cascade
    const insertCpe = 'INSERT INTO control_poam_entries (tenant_id, program_id, control_id, owner, scheduled_completion, required_resources, plan, milestones, updated_by) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8::jsonb, $9) RETURNING control_id';
    const cpeArgs = (program: string, control = 'AC.L2-3.1.1', over: Partial<{ owner: string; date: string | null; resources: string; plan: string; milestones: string }> = {}) =>
      [TENANT_X, program, control, over.owner ?? 'rls_verify_owner', over.date === undefined ? '2027-01-15' : over.date, over.resources ?? 'rls_verify_resources', over.plan ?? 'rls_verify_plan', over.milestones ?? '[]', 'rls_verify_actor'];
    const cp1 = await queryWithProgram(scopeA, insertCpe, cpeArgs(programA));
    check(cp1.rows.length === 1, '8y. control_poam_entries: under program A the row is inserted');
    const cpBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM control_poam_entries WHERE program_id = $1', [programA]);
    const cpBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM control_poam_entries WHERE tenant_id = $1', [TENANT_X]);
    check(cpBSeesA.rows.length === 0 && cpBSeesAny.rows.length === 0, "8y. control_poam_entries: program B cannot read program A's row (0 rows, by program or by tenant)", 'saw ' + cpBSeesA.rows.length + ' / ' + cpBSeesAny.rows.length);
    const cpBUpdates = await queryWithProgram(scopeB, "UPDATE control_poam_entries SET updated_by = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const cpBDeletes = await queryWithProgram(scopeB, 'DELETE FROM control_poam_entries WHERE program_id = $1', [programA]);
    check((cpBUpdates.rowCount ?? 0) === 0 && (cpBDeletes.rowCount ?? 0) === 0, "8y. control_poam_entries: program B can neither update nor delete program A's row (0 rows)", 'updated ' + cpBUpdates.rowCount + ', deleted ' + cpBDeletes.rowCount);
    const cpBInserts = await rejectsIn(scopeB, insertCpe, cpeArgs(programA, 'SC.L2-3.13.1'), { code: '42501' });
    check(cpBInserts.ok, '8y. control_poam_entries: program B cannot insert a row into program A (WITH CHECK, 42501)', cpBInserts.detail);
    const cpNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM control_poam_entries WHERE tenant_id = $1', [TENANT_X]);
    check(cpNoCtx.rows.length === 0, '8y. control_poam_entries: a tenant context with no program context sees zero rows', 'saw ' + cpNoCtx.rows.length);
    let cpNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertCpe, cpeArgs(programA, 'SC.L2-3.13.1'));
    } catch (err) {
      cpNoCtxInsert = String((err as { code?: string }).code);
    }
    check(cpNoCtxInsert === '42501', '8y. control_poam_entries: no program context cannot insert a row (42501)', cpNoCtxInsert);
    const cpForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertCpe, cpeArgs(defaultY), { code: '23503', constraint: 'fk_control_poam_entries_program' });
    check(cpForeignProgram.ok, "8y. control_poam_entries: tenant X cannot attach a row to tenant Y's program (composite foreign key, 23503)", cpForeignProgram.detail);
    const cpDuplicate = await rejectsIn(scopeA, insertCpe, cpeArgs(programA), { code: '23505', constraint: 'pk_control_poam_entries' });
    check(cpDuplicate.ok, '8y. control_poam_entries: a second row for the same control and program is refused (primary key, 23505)', cpDuplicate.detail);
    const cpTextCheck = { code: '23514', constraint: 'control_poam_entries_text_check' };
    const cpOwnerLong = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { owner: 'x'.repeat(256) }), { code: '22001' });
    const cpResLong = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { resources: 'x'.repeat(2001) }), cpTextCheck);
    const cpPlanLong = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { plan: 'x'.repeat(4001) }), cpTextCheck);
    check(cpOwnerLong.ok && cpResLong.ok && cpPlanLong.ok, '8y. control_poam_entries: an owner over 255, resources over 2000 and a plan over 4000 characters are each refused (22001 / 23514 control_poam_entries_text_check)', [cpOwnerLong.detail, cpResLong.detail, cpPlanLong.detail].join(' | '));
    const cpDate = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { date: '2100-01-01' }), { code: '23514', constraint: 'control_poam_entries_date_check' });
    check(cpDate.ok, '8y. control_poam_entries: a date after 2099-12-31 is refused (23514, control_poam_entries_date_check)', cpDate.detail);
    const cpMs = { code: '23514', constraint: 'control_poam_entries_milestones_check' };
    const cpMsObject = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { milestones: '{}' }), cpMs);
    const cpMsMany = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { milestones: JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ id: 'ms-' + i }))) }), cpMs);
    const cpMsBig = await rejectsIn(scopeB, insertCpe, cpeArgs(programB, 'AC.L2-3.1.2', { milestones: JSON.stringify([{ description: 'x'.repeat(65536) }]) }), cpMs);
    check(cpMsObject.ok && cpMsMany.ok && cpMsBig.ok, '8y. control_poam_entries: a milestone value that is not an array, more than 20 milestones and a value over 64 KB are each refused (23514, control_poam_entries_milestones_check)', [cpMsObject.detail, cpMsMany.detail, cpMsBig.detail].join(' | '));
    const cpCascadeProgram = await createSmProgram(TENANT_X, { name: 'rls_verify_control_poam_cascade', frameworkId: 'CMMC_L2' }, null);
    const cpCascadeScope = { tenantId: TENANT_X, programId: cpCascadeProgram.id };
    await queryWithProgram(cpCascadeScope, insertCpe, cpeArgs(cpCascadeProgram.id));
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, cpCascadeProgram.id]);
    const cpCascade = await queryWithProgram(cpCascadeScope, 'SELECT 1 FROM control_poam_entries WHERE program_id = $1', [cpCascadeProgram.id]);
    check(cpCascade.rows.length === 0, '8y. control_poam_entries: deleting a program removes its entries through the cascade', 'saw ' + cpCascade.rows.length);

    // 8z. control POA&M history (#304): control_poam_events isolation, its CHECK, no foreign key, program_id NOT NULL (same pattern as 8x)
    const insertCpEvent = 'INSERT INTO control_poam_events (tenant_id, program_id, control_id, actor, actor_user_id, control_status, new_owner_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id';
    const cpEvArgs = (program: string | null, sha: string | null = 'b'.repeat(64)) => [TENANT_X, program, 'AC.L2-3.1.1', 'rls_verify_actor', 'rls_verify_user', 'NOT_MET', sha];
    const ce1 = await queryWithProgram(scopeA, insertCpEvent, cpEvArgs(programA));
    check(ce1.rows.length === 1, '8z. control_poam_events: under program A the event is inserted');
    const ceBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM control_poam_events WHERE program_id = $1', [programA]);
    const ceBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM control_poam_events WHERE tenant_id = $1', [TENANT_X]);
    check(ceBSeesA.rows.length === 0 && ceBSeesAny.rows.length === 0, "8z. control_poam_events: program B cannot read program A's event (0 rows, by program or by tenant)", 'saw ' + ceBSeesA.rows.length + ' / ' + ceBSeesAny.rows.length);
    const ceBUpdates = await queryWithProgram(scopeB, "UPDATE control_poam_events SET actor = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    const ceBDeletes = await queryWithProgram(scopeB, 'DELETE FROM control_poam_events WHERE program_id = $1', [programA]);
    check((ceBUpdates.rowCount ?? 0) === 0 && (ceBDeletes.rowCount ?? 0) === 0, "8z. control_poam_events: program B can neither update nor delete program A's event (0 rows)", 'updated ' + ceBUpdates.rowCount + ', deleted ' + ceBDeletes.rowCount);
    const ceBInserts = await rejectsIn(scopeB, insertCpEvent, cpEvArgs(programA), { code: '42501' });
    check(ceBInserts.ok, '8z. control_poam_events: program B cannot insert an event into program A (WITH CHECK, 42501)', ceBInserts.detail);
    const ceNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM control_poam_events WHERE tenant_id = $1', [TENANT_X]);
    check(ceNoCtx.rows.length === 0, '8z. control_poam_events: a tenant context with no program context sees zero rows', 'saw ' + ceNoCtx.rows.length);
    let ceNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertCpEvent, cpEvArgs(programA));
    } catch (err) {
      ceNoCtxInsert = String((err as { code?: string }).code);
    }
    check(ceNoCtxInsert === '42501', '8z. control_poam_events: no program context cannot insert an event (42501)', ceNoCtxInsert);
    const ceBadSha = await rejectsIn(scopeA, insertCpEvent, cpEvArgs(programA, 'not-a-digest'), { code: '23514', constraint: 'control_poam_events_sha_check' });
    check(ceBadSha.ok, '8z. control_poam_events: a digest that is not 64 hex characters is refused (23514, control_poam_events_sha_check)', ceBadSha.detail);
    const ceFk = await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'control_poam_events'::regclass AND contype = 'f'");
    check(ceFk.rows[0]?.n === 0, '8z. control_poam_events: no foreign key (the history outlives the entry and the program)', JSON.stringify(ceFk.rows[0]));
    const ceNotNull = await pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'control_poam_events'::regclass AND attname = 'program_id' AND NOT attisdropped");
    check(ceNotNull.rows.length === 1 && ceNotNull.rows[0].attnotnull === true, '8z. control_poam_events: program_id is NOT NULL (attnotnull)', JSON.stringify(ceNotNull.rows));
    await queryWithProgram(scopeA, "DELETE FROM control_poam_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);

    // 8t. Tools and services register (#239, #248, #249): inventory_vendors, inventory_tools and inventory_events are tenant tables (tenant policy only), with a composite vendor key
    const rejectsTenant = async (tenant: string, sql: string, params: (string | number | boolean | null)[], want: { code?: string; constraint?: string; message?: string }): Promise<{ ok: boolean; detail: string }> => {
      try {
        await queryWithTenant(tenant, sql, params);
        return { ok: false, detail: 'no error' };
      } catch (err) {
        const e = err as { code?: string; constraint?: string; message?: string };
        return {
          ok: (want.code === undefined || e.code === want.code) && (want.constraint === undefined || e.constraint === want.constraint) && (want.message === undefined || String(e.message).includes(want.message)),
          detail: 'code ' + e.code + ', constraint ' + e.constraint,
        };
      }
    };
    const mkVendor = async (tenant: string, name: string): Promise<string> => String((await queryWithTenant(tenant, 'INSERT INTO inventory_vendors (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant, name])).rows[0]?.id);
    const insertTool = 'INSERT INTO inventory_tools (tenant_id, name, vendor_id, end_users, deployment, seed_key, recovery_rank) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id';
    const toolArgs = (tenant: string, name: string, over: Partial<{ vendor: string | null; users: number | null; deployment: string | null; seed: string | null; rank: number | null }> = {}): (string | number | null)[] =>
      [tenant, name, over.vendor === undefined ? null : over.vendor, over.users === undefined ? 5 : over.users, over.deployment === undefined ? 'CLOUD' : over.deployment, over.seed === undefined ? null : over.seed, over.rank === undefined ? null : over.rank];
    const mkTool = async (tenant: string, name: string, over: Parameters<typeof toolArgs>[2] = {}): Promise<string> => String((await queryWithTenant(tenant, insertTool, toolArgs(tenant, name, over))).rows[0]?.id);
    const vendorX = await mkVendor(TENANT_X, 'rls_verify_vendor_x');
    const vendorY = await mkVendor(TENANT_Y, 'rls_verify_vendor_y');
    const toolX = await mkTool(TENANT_X, 'rls_verify_tool_x', { vendor: vendorX });
    check(Boolean(toolX), '8t. inventory_tools: under tenant X the tool is inserted');
    const itYSees = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM inventory_tools WHERE tenant_id = $1', [TENANT_X]);
    const ivYSees = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM inventory_vendors WHERE tenant_id = $1', [TENANT_X]);
    check(itYSees.rows.length === 0 && ivYSees.rows.length === 0, "8t. inventory_tools / inventory_vendors: tenant Y reads none of tenant X's rows", 'saw ' + itYSees.rows.length + ' / ' + ivYSees.rows.length);
    const itNoCtx = await pool.query("SELECT 1 FROM inventory_tools WHERE name LIKE 'rls_verify_%'");
    check(itNoCtx.rows.length === 0, '8t. inventory_tools: no tenant context reads zero rows', 'saw ' + itNoCtx.rows.length);
    const itYInserts = await rejectsTenant(TENANT_Y, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_evil'), { code: '42501' });
    check(itYInserts.ok, "8t. inventory_tools: tenant Y cannot insert a tool into tenant X (WITH CHECK, 42501)", itYInserts.detail);
    const itForeignVendor = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_fk', { vendor: vendorY }), { code: '23503', constraint: 'fk_inventory_tools_vendor' });
    check(itForeignVendor.ok, "8t. inventory_tools: a tool cannot name another tenant's vendor (composite foreign key, 23503, fk_inventory_tools_vendor)", itForeignVendor.detail);
    const itDuplicate = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'RLS_VERIFY_TOOL_X'), { code: '23505', constraint: 'unq_inventory_tools_name' });
    check(itDuplicate.ok, '8t. inventory_tools: a second tool with the same name ignoring case is refused (23505, unq_inventory_tools_name)', itDuplicate.detail);
    await mkTool(TENANT_X, 'rls_verify_tool_rank_a', { rank: 1 });
    const itRank = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_rank_b', { rank: 1 }), { code: '23505', constraint: 'unq_inventory_tools_rank' });
    check(itRank.ok, '8t. inventory_tools: two tools of one tenant cannot hold the same recovery rank (23505, unq_inventory_tools_rank)', itRank.detail);
    await mkTool(TENANT_Y, 'rls_verify_tool_rank_y', { rank: 1 });
    await mkTool(TENANT_X, 'rls_verify_tool_seed_a', { seed: 'catalog:rls-verify' });
    const itSeed = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_seed_b', { seed: 'catalog:rls-verify' }), { code: '23505', constraint: 'unq_inventory_tools_seed' });
    check(itSeed.ok, '8t. inventory_tools: a seed key is stored once per tenant (23505, unq_inventory_tools_seed), and the same rank in another tenant is fine', itSeed.detail);
    const itUsers = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_users', { users: -1 }), { code: '23514', constraint: 'inventory_tools_counts_check' });
    const itDeployment = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_dep', { deployment: 'bad' }), { code: '23514', constraint: 'inventory_tools_enum_check' });
    const itSeedKey = await rejectsTenant(TENANT_X, insertTool, toolArgs(TENANT_X, 'rls_verify_tool_sk', { seed: 'x' }), { code: '23514', constraint: 'inventory_tools_seed_check' });
    check(itUsers.ok && itDeployment.ok && itSeedKey.ok, "8t. inventory_tools: end_users = -1, deployment = 'bad' and seed_key = 'x' are each refused (23514)", [itUsers.detail, itDeployment.detail, itSeedKey.detail].join(' | '));
    const ivContract = await rejectsTenant(TENANT_X, "INSERT INTO inventory_vendors (tenant_id, name, contract_start, contract_end) VALUES ($1, 'rls_verify_vendor_dates', '2027-02-01', '2027-01-01')", [TENANT_X], { code: '23514', constraint: 'inventory_vendors_contract_check' });
    check(ivContract.ok, '8t. inventory_vendors: a contract end before its start is refused (23514, inventory_vendors_contract_check)', ivContract.detail);
    await queryWithTenant(TENANT_X, 'DELETE FROM inventory_vendors WHERE id = $1', [vendorX]);
    const itVendorNulled = await queryWithTenant(TENANT_X, 'SELECT vendor_id FROM inventory_tools WHERE id = $1', [toolX]);
    check(itVendorNulled.rows.length === 1 && itVendorNulled.rows[0].vendor_id === null, "8t. inventory_vendors: deleting the vendor keeps the tool and sets its vendor_id to null (ON DELETE SET NULL (vendor_id))", JSON.stringify(itVendorNulled.rows));
    const insertInvEvent = "INSERT INTO inventory_events (tenant_id, entity_kind, entity_id, action, actor, fields) VALUES ($1, 'tool', 'rls_verify_item', 'created', 'rls_verify_actor', '{}'::jsonb) RETURNING id";
    await queryWithTenant(TENANT_X, insertInvEvent, [TENANT_X]);
    const ieYSees = await queryWithTenant(TENANT_Y, 'SELECT 1 FROM inventory_events WHERE tenant_id = $1', [TENANT_X]);
    const ieYInserts = await rejectsTenant(TENANT_Y, insertInvEvent, [TENANT_X], { code: '42501' });
    check(ieYSees.rows.length === 0 && ieYInserts.ok, "8t. inventory_events: tenant Y reads none of tenant X's events and cannot insert one for it (42501)", 'saw ' + ieYSees.rows.length + ' / ' + ieYInserts.detail);
    const ieUpdate = await rejectsTenant(TENANT_X, "UPDATE inventory_events SET actor = 'rls_verify_changed' WHERE tenant_id = $1", [TENANT_X], { code: '42501', message: 'append-only' });
    check(ieUpdate.ok, '8t. inventory_events: an UPDATE is refused by the append-only trigger (42501, "append-only")', ieUpdate.detail);
    const ieBadShape = await rejectsTenant(TENANT_X, "INSERT INTO inventory_events (tenant_id, entity_kind, action, actor, fields) VALUES ($1, 'Tool', 'created', 'rls_verify_actor', '{}'::jsonb)", [TENANT_X], { code: '23514', constraint: 'inventory_events_shape_check' });
    check(ieBadShape.ok, '8t. inventory_events: an entity kind that is not lower case is refused (23514, inventory_events_shape_check)', ieBadShape.detail);

    // 8u. program_tools and program_tool_controls (the 8j pattern): boundary membership and the tool-to-control links of one program
    const toolPt = await mkTool(TENANT_X, 'rls_verify_tool_pt');
    const toolPtY = await mkTool(TENANT_Y, 'rls_verify_tool_pt_y');
    const insertPt = 'INSERT INTO program_tools (tenant_id, program_id, tool_id, added_by) VALUES ($1, $2, $3, $4) RETURNING tool_id';
    const insertPtc = 'INSERT INTO program_tool_controls (tenant_id, program_id, tool_id, control_id, evidence_source, linked_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING control_id';
    const pt1 = await queryWithProgram(scopeA, insertPt, [TENANT_X, programA, toolPt, 'rls_verify_actor']);
    const ptc1 = await queryWithProgram(scopeA, insertPtc, [TENANT_X, programA, toolPt, 'AC.L2-3.1.1', true, 'rls_verify_actor']);
    check(pt1.rows.length === 1 && ptc1.rows.length === 1, '8u. program_tools / program_tool_controls: under program A the membership and the link are inserted');
    for (const t of ['program_tools', 'program_tool_controls']) {
      const bSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM ' + t + ' WHERE program_id = $1', [programA]);
      const bSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM ' + t + ' WHERE tenant_id = $1', [TENANT_X]);
      check(bSeesA.rows.length === 0 && bSeesAny.rows.length === 0, "8u. " + t + ": program B cannot read program A's rows (0 rows, by program or by tenant)", 'saw ' + bSeesA.rows.length + ' / ' + bSeesAny.rows.length);
      const bUpdates = await queryWithProgram(scopeB, 'UPDATE ' + t + " SET " + (t === 'program_tools' ? 'added_by' : 'linked_by') + " = 'rls_verify_changed' WHERE program_id = $1", [programA]);
      const bDeletes = await queryWithProgram(scopeB, 'DELETE FROM ' + t + ' WHERE program_id = $1', [programA]);
      check((bUpdates.rowCount ?? 0) === 0 && (bDeletes.rowCount ?? 0) === 0, "8u. " + t + ": program B can neither update nor delete program A's rows (0 rows)", 'updated ' + bUpdates.rowCount + ', deleted ' + bDeletes.rowCount);
      const noCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM ' + t + ' WHERE tenant_id = $1', [TENANT_X]);
      check(noCtx.rows.length === 0, '8u. ' + t + ': a tenant context with no program context sees zero rows', 'saw ' + noCtx.rows.length);
    }
    const ptBInserts = await rejectsIn(scopeB, insertPt, [TENANT_X, programA, toolPt, 'rls_verify_actor'], { code: '42501' });
    const ptcBInserts = await rejectsIn(scopeB, insertPtc, [TENANT_X, programA, toolPt, 'SC.L2-3.13.1', false, 'rls_verify_actor'], { code: '42501' });
    check(ptBInserts.ok && ptcBInserts.ok, '8u. program_tools / program_tool_controls: program B cannot insert a row into program A (WITH CHECK, 42501)', ptBInserts.detail + ' | ' + ptcBInserts.detail);
    let ptNoCtxInsert = 'no error';
    try {
      await queryWithTenant(TENANT_X, insertPt, [TENANT_X, programA, toolPt, 'rls_verify_actor']);
    } catch (err) {
      ptNoCtxInsert = String((err as { code?: string }).code);
    }
    check(ptNoCtxInsert === '42501', '8u. program_tools: no program context cannot insert a row (42501)', ptNoCtxInsert);
    const ptForeignTool = await rejectsIn(scopeA, insertPt, [TENANT_X, programA, toolPtY, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_tools_tool' });
    const ptcForeignTool = await rejectsIn(scopeA, insertPtc, [TENANT_X, programA, toolPtY, 'AC.L2-3.1.2', false, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_tool_controls_tool' });
    check(ptForeignTool.ok && ptcForeignTool.ok, "8u. program_tools / program_tool_controls: tenant X cannot take tenant Y's tool (composite foreign key, 23503)", ptForeignTool.detail + ' | ' + ptcForeignTool.detail);
    const ptForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertPt, [TENANT_X, defaultY, toolPt, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_tools_program' });
    check(ptForeignProgram.ok, "8u. program_tools: tenant X cannot attach a tool to tenant Y's program (composite foreign key, 23503)", ptForeignProgram.detail);
    const ptDuplicate = await rejectsIn(scopeA, insertPt, [TENANT_X, programA, toolPt, 'rls_verify_actor'], { code: '23505', constraint: 'pk_program_tools' });
    const ptcBadControl = await rejectsIn(scopeA, insertPtc, [TENANT_X, programA, toolPt, 'bad id', false, 'rls_verify_actor'], { code: '23514', constraint: 'program_tool_controls_control_check' });
    check(ptDuplicate.ok && ptcBadControl.ok, "8u. a tool is a member of a program once (23505, pk_program_tools) and a control id such as 'bad id' is refused (23514, program_tool_controls_control_check)", ptDuplicate.detail + ' | ' + ptcBadControl.detail);
    // a foreign-key cascade is not filtered by row security: the tool delete (tenant context only) removes the rows that program A owns
    await queryWithTenant(TENANT_X, 'DELETE FROM inventory_tools WHERE id = $1', [toolPt]);
    const ptCascade = await queryWithProgram(scopeA, 'SELECT (SELECT COUNT(*) FROM program_tools WHERE program_id = $1)::int AS m, (SELECT COUNT(*) FROM program_tool_controls WHERE program_id = $1)::int AS l', [programA]);
    check(ptCascade.rows[0].m === 0 && ptCascade.rows[0].l === 0, '8u. program_tools / program_tool_controls: deleting a tool (tenant context only) removes its rows through the cascade', JSON.stringify(ptCascade.rows[0]));
    const ptProgram = await createSmProgram(TENANT_X, { name: 'rls_verify_inventory_cascade', frameworkId: 'CMMC_L2' }, null);
    const ptScope = { tenantId: TENANT_X, programId: ptProgram.id };
    const toolCascade = await mkTool(TENANT_X, 'rls_verify_tool_cascade');
    await queryWithProgram(ptScope, insertPt, [TENANT_X, ptProgram.id, toolCascade, 'rls_verify_actor']);
    await queryWithProgram(ptScope, insertPtc, [TENANT_X, ptProgram.id, toolCascade, 'AC.L2-3.1.1', false, 'rls_verify_actor']);
    await queryWithTenant(TENANT_X, 'DELETE FROM programs WHERE tenant_id = $1 AND id = $2', [TENANT_X, ptProgram.id]);
    const ptProgramCascade = await queryWithProgram(ptScope, 'SELECT (SELECT COUNT(*) FROM program_tools WHERE program_id = $1)::int AS m, (SELECT COUNT(*) FROM program_tool_controls WHERE program_id = $1)::int AS l', [ptProgram.id]);
    check(ptProgramCascade.rows[0].m === 0 && ptProgramCascade.rows[0].l === 0, '8u. program_tools / program_tool_controls: deleting a program removes its rows through the cascade', JSON.stringify(ptProgramCascade.rows[0]));

    // 8v. the data inventory (#243): program_data_inventory, program_cui_categories and program_cui_category_tools
    const toolDi = await mkTool(TENANT_X, 'rls_verify_tool_di');
    const toolDiY = await mkTool(TENANT_Y, 'rls_verify_tool_di_y');
    const insertDi = 'INSERT INTO program_data_inventory (tenant_id, program_id, handles_fci, updated_by) VALUES ($1, $2, $3, $4) RETURNING program_id';
    const insertCat = 'INSERT INTO program_cui_categories (tenant_id, program_id, category_id) VALUES ($1, $2, $3) RETURNING category_id';
    const insertCatTool = 'INSERT INTO program_cui_category_tools (tenant_id, program_id, category_id, tool_id, stores, processes, transmits) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING tool_id';
    const di1 = await queryWithProgram(scopeA, insertDi, [TENANT_X, programA, true, 'rls_verify_actor']);
    const dc1 = await queryWithProgram(scopeA, insertCat, [TENANT_X, programA, 'CTI']);
    const dt1 = await queryWithProgram(scopeA, insertCatTool, [TENANT_X, programA, 'CTI', toolDi, true, false, false]);
    check(di1.rows.length === 1 && dc1.rows.length === 1 && dt1.rows.length === 1, '8v. the data inventory: under program A the answer, the category and the tool row are inserted');
    for (const t of ['program_data_inventory', 'program_cui_categories', 'program_cui_category_tools']) {
      const bSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM ' + t + ' WHERE program_id = $1', [programA]);
      const bSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM ' + t + ' WHERE tenant_id = $1', [TENANT_X]);
      const bDeletes = await queryWithProgram(scopeB, 'DELETE FROM ' + t + ' WHERE program_id = $1', [programA]);
      const noCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM ' + t + ' WHERE tenant_id = $1', [TENANT_X]);
      check(bSeesA.rows.length === 0 && bSeesAny.rows.length === 0 && (bDeletes.rowCount ?? 0) === 0 && noCtx.rows.length === 0, "8v. " + t + ": program B cannot read or delete program A's rows, and no program context sees zero rows", 'saw ' + bSeesA.rows.length + ' / ' + bSeesAny.rows.length + ' / ' + noCtx.rows.length + ', deleted ' + bDeletes.rowCount);
    }
    const diBInserts = await rejectsIn(scopeB, insertDi, [TENANT_X, programA, false, 'rls_verify_actor'], { code: '42501' });
    const dcBInserts = await rejectsIn(scopeB, insertCat, [TENANT_X, programA, 'EXPT'], { code: '42501' });
    check(diBInserts.ok && dcBInserts.ok, '8v. program_data_inventory / program_cui_categories: program B cannot insert a row into program A (WITH CHECK, 42501)', diBInserts.detail + ' | ' + dcBInserts.detail);
    const diBadCategory = await rejectsIn(scopeA, insertCat, [TENANT_X, programA, 'bad id'], { code: '23514', constraint: 'program_cui_categories_id_check' });
    check(diBadCategory.ok, "8v. program_cui_categories: the category id 'bad id' is refused (23514, program_cui_categories_id_check)", diBadCategory.detail);
    const diNoRole = await rejectsIn(scopeA, insertCatTool, [TENANT_X, programA, 'CTI', toolDi, false, false, false], { code: '23514', constraint: 'program_cui_category_tools_role_check' });
    check(diNoRole.ok, '8v. program_cui_category_tools: a row that neither stores, processes nor transmits is refused (23514, program_cui_category_tools_role_check)', diNoRole.detail);
    const diNoCategory = await rejectsIn(scopeA, insertCatTool, [TENANT_X, programA, 'EXPT', toolDi, true, false, false], { code: '23503', constraint: 'fk_program_cui_category_tools_category' });
    const diForeignTool = await rejectsIn(scopeA, insertCatTool, [TENANT_X, programA, 'CTI', toolDiY, true, false, false], { code: '23503', constraint: 'fk_program_cui_category_tools_tool' });
    check(diNoCategory.ok && diForeignTool.ok, "8v. program_cui_category_tools: a category the program does not hold, and another tenant's tool, are each refused (23503)", diNoCategory.detail + ' | ' + diForeignTool.detail);
    const diForeignProgram = await rejectsIn({ tenantId: TENANT_X, programId: defaultY }, insertDi, [TENANT_X, defaultY, true, 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_data_inventory_program' });
    check(diForeignProgram.ok, "8v. program_data_inventory: tenant X cannot attach an answer to tenant Y's program (composite foreign key, 23503)", diForeignProgram.detail);
    await queryWithProgram(scopeA, 'DELETE FROM program_data_inventory WHERE tenant_id = $1 AND program_id = $2', [TENANT_X, programA]);
    const diCascade = await queryWithProgram(scopeA, 'SELECT (SELECT COUNT(*) FROM program_cui_categories WHERE program_id = $1)::int AS c, (SELECT COUNT(*) FROM program_cui_category_tools WHERE program_id = $1)::int AS t', [programA]);
    check(diCascade.rows[0].c === 0 && diCascade.rows[0].t === 0, '8v. program_data_inventory: deleting the row removes its categories and their tool rows through the cascade', JSON.stringify(diCascade.rows[0]));

    // 8w. program_vendor_documents and program_inventory_events: isolation, the CHECKs, the vendor cascade and the append-only history
    const vendorDoc = await mkVendor(TENANT_X, 'rls_verify_vendor_doc');
    const insertDoc = 'INSERT INTO program_vendor_documents (tenant_id, program_id, vendor_id, evidence_id, doc_kind, linked_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING evidence_id';
    const dd1 = await queryWithProgram(scopeA, insertDoc, [TENANT_X, programA, vendorDoc, 'rls_verify_evidence', 'CRM', 'rls_verify_actor']);
    check(dd1.rows.length === 1, '8w. program_vendor_documents: under program A the document link is inserted');
    const ddBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_vendor_documents WHERE program_id = $1', [programA]);
    const ddBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_vendor_documents WHERE tenant_id = $1', [TENANT_X]);
    const ddBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_vendor_documents WHERE program_id = $1', [programA]);
    const ddNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_vendor_documents WHERE tenant_id = $1', [TENANT_X]);
    check(ddBSeesA.rows.length === 0 && ddBSeesAny.rows.length === 0 && (ddBDeletes.rowCount ?? 0) === 0 && ddNoCtx.rows.length === 0, "8w. program_vendor_documents: program B cannot read or delete program A's links, and no program context sees zero rows", 'saw ' + ddBSeesA.rows.length + ' / ' + ddBSeesAny.rows.length + ' / ' + ddNoCtx.rows.length);
    const ddBInserts = await rejectsIn(scopeB, insertDoc, [TENANT_X, programA, vendorDoc, 'rls_verify_evidence_2', 'CRM', 'rls_verify_actor'], { code: '42501' });
    check(ddBInserts.ok, '8w. program_vendor_documents: program B cannot insert a link into program A (WITH CHECK, 42501)', ddBInserts.detail);
    const ddBadKind = await rejectsIn(scopeA, insertDoc, [TENANT_X, programA, vendorDoc, 'rls_verify_evidence_3', 'x', 'rls_verify_actor'], { code: '23514', constraint: 'program_vendor_documents_check' });
    check(ddBadKind.ok, "8w. program_vendor_documents: doc_kind = 'x' is refused (23514, program_vendor_documents_check)", ddBadKind.detail);
    const ddForeignVendor = await rejectsIn(scopeA, insertDoc, [TENANT_X, programA, vendorY, 'rls_verify_evidence_4', 'CRM', 'rls_verify_actor'], { code: '23503', constraint: 'fk_program_vendor_documents_vendor' });
    check(ddForeignVendor.ok, "8w. program_vendor_documents: tenant X cannot link another tenant's vendor (composite foreign key, 23503)", ddForeignVendor.detail);
    await queryWithTenant(TENANT_X, 'DELETE FROM inventory_vendors WHERE id = $1', [vendorDoc]);
    const ddCascade = await queryWithProgram(scopeA, 'SELECT 1 FROM program_vendor_documents WHERE program_id = $1', [programA]);
    check(ddCascade.rows.length === 0, '8w. program_vendor_documents: deleting the vendor (tenant context only) removes its links through the cascade', 'saw ' + ddCascade.rows.length);
    const insertPie = "INSERT INTO program_inventory_events (tenant_id, program_id, action, entity_id, actor, detail) VALUES ($1, $2, 'controls_changed', 'rls_verify_item', 'rls_verify_actor', '{}'::jsonb) RETURNING id";
    const pie1 = await queryWithProgram(scopeA, insertPie, [TENANT_X, programA]);
    check(pie1.rows.length === 1, '8w. program_inventory_events: under program A the event is inserted');
    const pieBSeesA = await queryWithProgram(scopeB, 'SELECT 1 FROM program_inventory_events WHERE program_id = $1', [programA]);
    const pieBSeesAny = await queryWithProgram(scopeB, 'SELECT 1 FROM program_inventory_events WHERE tenant_id = $1', [TENANT_X]);
    const pieBDeletes = await queryWithProgram(scopeB, 'DELETE FROM program_inventory_events WHERE program_id = $1', [programA]);
    const pieNoCtx = await queryWithTenant(TENANT_X, 'SELECT 1 FROM program_inventory_events WHERE tenant_id = $1', [TENANT_X]);
    check(pieBSeesA.rows.length === 0 && pieBSeesAny.rows.length === 0 && (pieBDeletes.rowCount ?? 0) === 0 && pieNoCtx.rows.length === 0, "8w. program_inventory_events: program B cannot read or delete program A's events, and no program context sees zero rows", 'saw ' + pieBSeesA.rows.length + ' / ' + pieBSeesAny.rows.length + ' / ' + pieNoCtx.rows.length);
    const pieBInserts = await rejectsIn(scopeB, insertPie, [TENANT_X, programA], { code: '42501' });
    check(pieBInserts.ok, '8w. program_inventory_events: program B cannot insert an event into program A (WITH CHECK, 42501)', pieBInserts.detail);
    let pieUpdate = 'no error';
    try {
      await queryWithProgram(scopeA, "UPDATE program_inventory_events SET actor = 'rls_verify_changed' WHERE program_id = $1", [programA]);
    } catch (err) {
      pieUpdate = String((err as { code?: string }).code) + ' ' + ((err as Error).message.includes('append-only') ? 'append-only' : 'other');
    }
    check(pieUpdate === '42501 append-only', '8w. program_inventory_events: an UPDATE is refused by the append-only trigger (42501, "append-only")', pieUpdate);
    const pieFk = await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'program_inventory_events'::regclass AND contype = 'f'");
    check(pieFk.rows[0]?.n === 0, '8w. program_inventory_events: no foreign key (the history outlives the program)', JSON.stringify(pieFk.rows[0]));
    const pieNotNull = await pool.query("SELECT attnotnull FROM pg_attribute WHERE attrelid = 'program_inventory_events'::regclass AND attname = 'program_id' AND NOT attisdropped");
    check(pieNotNull.rows.length === 1 && pieNotNull.rows[0].attnotnull === true, '8w. program_inventory_events: program_id is NOT NULL (attnotnull)', JSON.stringify(pieNotNull.rows));
    const pieBadAction = await rejectsIn(scopeA, "INSERT INTO program_inventory_events (tenant_id, program_id, action, actor, detail) VALUES ($1, $2, 'Bad Action', 'rls_verify_actor', '{}'::jsonb)", [TENANT_X, programA], { code: '23514', constraint: 'program_inventory_events_shape_check' });
    check(pieBadAction.ok, '8w. program_inventory_events: an action that is not snake case is refused (23514, program_inventory_events_shape_check)', pieBadAction.detail);
    await queryWithProgram(scopeA, "DELETE FROM program_inventory_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);

    await verifyUpgrade();
  } finally {
    for (const t of [TENANT_X, TENANT_Y]) {
      await queryWithTenant(t, "DELETE FROM software_items WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM inventory_tools WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined); // the boundary, link and data-inventory rows cascade with their tool
      await queryWithTenant(t, "DELETE FROM inventory_vendors WHERE name LIKE 'rls_verify_%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM inventory_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      await queryWithTenant(t, "DELETE FROM enclave_assets WHERE asset_name LIKE 'rls_verify_%'", []).catch(() => undefined); // the membership rows cascade with their asset
    }
    // the history has no foreign key, so a program's delete does not remove its events
    for (const id of [programA, programB]) {
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM control_objective_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM program_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM vm_poam_item_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM control_poam_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
      if (id) await queryWithProgram({ tenantId: TENANT_X, programId: id }, "DELETE FROM program_inventory_events WHERE actor LIKE 'rls_verify%'", []).catch(() => undefined);
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
    // 8i. the Admin role: a database made before TENANT_ADMIN has the four-role invitation CHECK (it only exists inline in CREATE TABLE IF NOT EXISTS)
    await pool.query('ALTER TABLE tenant_invitations DROP CONSTRAINT tenant_invitations_role_check');
    await pool.query("ALTER TABLE tenant_invitations ADD CONSTRAINT tenant_invitations_role_check CHECK (role IN ('TENANT_OWNER', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'))");
    await pool.query("ALTER TABLE tenant_users DROP CONSTRAINT tenant_users_role_check");
    await pool.query("ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check CHECK (role IN ('TENANT_OWNER', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'))");
    await pool.query(buildSchemaSql());
    const invitationCheck = await pool.query(
      "SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k WHERE k.conname = 'tenant_invitations_role_check' AND k.conrelid = 'tenant_invitations'::regclass"
    );
    check(invitationCheck.rows.length === 1 && String(invitationCheck.rows[0].def).includes('TENANT_ADMIN'), '8i1. an upgraded database accepts Admin invitations (the invitation role check was widened)', JSON.stringify(invitationCheck.rows));
    let adminInsert = 'accepted';
    try {
      await queryWithTenant(T, "INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ('rls_verify_up_admin', 'a@x.mil', 'a', $1, 'TENANT_ADMIN')", [T]);
    } catch (err) {
      adminInsert = 'code ' + (err as { code?: string }).code;
    }
    check(adminInsert === 'accepted', '8i2. an upgraded database accepts a TENANT_ADMIN member', adminInsert);
    let bogusInsert = 'accepted';
    try {
      await queryWithTenant(T, "INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ('rls_verify_up_bogus', 'b@x.mil', 'b', $1, 'BOGUS')", [T]);
    } catch (err) {
      bogusInsert = 'code ' + (err as { code?: string }).code;
    }
    check(bogusInsert === 'code 23514', '8i3. an unknown role is still refused by the CHECK (23514)', bogusInsert);
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

/**
 * 9. The one-time update of stored CMMC objective answers to the Assessment Guide objectives (issue #273), on PostgreSQL: legacy rows (objective_catalog_rev NULL)
 * are seeded with SQL, ensureObjectiveCatalogCurrent runs on them, and the expected values come from the same pure rules the server applies
 * (src/data/cmmcGuide/migration.ts). A failure message names ids, statuses and counts only, never a narrative or a row value. Every row, event
 * and program it creates is removed (the migration's history carries the actor "CMMC Assessment Guide v2.13 update", so it is deleted by program).
 */
async function verifyCatalogUpdate() {
  console.log('\n--- 9. Objective catalog update (one-time migration of stored CMMC objective answers) ---');
  const { ensureObjectiveCatalogCurrent } = await import('../server/objectiveCatalogMigration');
  const { CMMC_OBJECTIVE_CATALOG_REV } = await import('../src/data/cmmcGuide/guide');
  const { objectiveStatusAfterCatalogUpdate, controlStatusAfterCatalogUpdate } = await import('../src/data/cmmcGuide/migration');
  type Status = Parameters<typeof objectiveStatusAfterCatalogUpdate>[1];
  type ControlStatusValue = Parameters<typeof controlStatusAfterCatalogUpdate>[1];
  const T = TENANT_X;
  const NARRATIVE = 'rls_verify_narrative_9';
  const NOTES = 'rls_verify_notes_9';
  const SEEDED_AT = '2020-01-01T00:00:00.000Z';
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const controlOf = (objectiveId: string) => objectiveId.slice(0, objectiveId.indexOf('['));
  const seeds: { id: string; status: Status; narrative: string; evidence: string }[] = [
    { id: 'CA.L2-3.12.4[a]', status: 'MET', narrative: NARRATIVE, evidence: '{rls_verify_ev_9}' },
    { id: 'AC.L1-3.1.2[a]', status: 'MET', narrative: '', evidence: '{}' },
    { id: 'AC.L1-3.1.2[b]', status: 'MET', narrative: '', evidence: '{}' },
    { id: 'AC.L2-3.1.8[c]', status: 'NOT_MET', narrative: '', evidence: '{}' },
  ];
  const insertObjective =
    'INSERT INTO control_objectives (tenant_id, program_id, control_id, objective_id, status, narrative, linked_evidence_ids, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9::timestamptz)';
  const insertControl = 'INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes, program_id, updated_by) VALUES ($1, $2, $3, $4, $5, $6)';
  const seed = async (scope: ProgramScope, rows: typeof seeds) => {
    for (const s of rows) await queryWithProgram(scope, insertObjective, [scope.tenantId, scope.programId, controlOf(s.id), s.id, s.status, s.narrative, s.evidence, 'rls_verify_actor', SEEDED_AT]);
  };
  const readObjectives = async (scope: ProgramScope) => {
    const res = await queryWithProgram(scope, 'SELECT objective_id, status, narrative, linked_evidence_ids, objective_catalog_rev, updated_at FROM control_objectives WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
    return new Map(res.rows.map((r) => [String(r.objective_id), r]));
  };
  const objectiveEvents = async (scope: ProgramScope, objectiveId?: string) =>
    (
      await queryWithProgram(
        scope,
        "SELECT * FROM control_objective_events WHERE tenant_id = $1 AND program_id = $2 AND source = 'catalog-update' AND ($3::text IS NULL OR objective_id = $3::text)",
        [scope.tenantId, scope.programId, objectiveId ?? null]
      )
    ).rows;
  const controlEvents = async (scope: ProgramScope, controlId?: string) =>
    (
      await queryWithProgram(
        scope,
        "SELECT * FROM control_assessment_events WHERE tenant_id = $1 AND program_id = $2 AND source = 'catalog-update' AND ($3::text IS NULL OR control_id = $3::text)",
        [scope.tenantId, scope.programId, controlId ?? null]
      )
    ).rows;

  const ids: string[] = [];
  try {
    const mkP9 = async (name: string) => {
      const id = await mkProgram(T, 'rls_verify_p9_' + name);
      ids.push(id);
      return { tenantId: T, programId: id };
    };

    // 9a. the column
    const col = await pool.query(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'control_objectives' AND column_name = 'objective_catalog_rev'"
    );
    check(col.rows.length === 1 && col.rows[0].is_nullable === 'YES', '9a. control_objectives.objective_catalog_rev exists and is nullable (NULL = written before the update)', JSON.stringify(col.rows));
    if (col.rows.length !== 1) {
      console.log('  SKIP: 9b-9f. the column is missing, so the migration cannot be exercised');
      return;
    }

    // 9b. seed legacy rows (no revision) and two Met controls
    const primary = await mkP9('primary');
    await seed(primary, seeds);
    await queryWithProgram(primary, insertControl, [T, 'CA.L2-3.12.4', 'MET', NOTES, primary.programId, 'rls_verify_actor']);
    await queryWithProgram(primary, insertControl, [T, 'AC.L2-3.1.5', 'MET', NOTES, primary.programId, 'rls_verify_actor']);
    const seeded = await readObjectives(primary);
    check(seeded.size === seeds.length && [...seeded.values()].every((r) => r.objective_catalog_rev === null), '9b. the seeded objective rows are legacy (objective_catalog_rev NULL)', 'rows ' + seeded.size);
    const seededAt = new Map([...seeded].map(([id, r]) => [id, new Date(r.updated_at).getTime()]));

    // 9c. two concurrent first calls migrate once (the second waits on SELECT ... FOR UPDATE, then finds no legacy row)
    const results = await Promise.all([ensureObjectiveCatalogCurrent(primary, 'CMMC_L2'), ensureObjectiveCatalogCurrent(primary, 'CMMC_L2')]);
    const expected = new Map(seeds.map((s) => [s.id, objectiveStatusAfterCatalogUpdate(s.id, s.status, 'CMMC_L2')]));
    const changedIds = seeds.filter((s) => expected.get(s.id) !== s.status).map((s) => s.id);
    const brief = ['CA.L2-3.12.4[a]=IN_PROGRESS', 'AC.L1-3.1.2[a]=MET', 'AC.L1-3.1.2[b]=IN_PROGRESS', 'AC.L2-3.1.8[c]=NOT_MET'];
    check(
      JSON.stringify(seeds.map((s) => s.id + '=' + expected.get(s.id))) === JSON.stringify(brief),
      '9c. the pure rule keeps 3.12.4[a] IN_PROGRESS, L1 3.1.2[a] MET, 3.1.2[b] IN_PROGRESS and the Not met 3.1.8[c] (the expected values)',
      JSON.stringify(seeds.map((s) => s.id + '=' + expected.get(s.id)))
    );
    const objectivesChanged = results.reduce((n, r) => n + (r?.objectivesChanged ?? 0), 0);
    const controlsChanged = results.reduce((n, r) => n + (r?.controlsChanged ?? 0), 0);
    check(objectivesChanged === changedIds.length && controlsChanged === 1, '9c. two concurrent calls report the changes once between them (' + changedIds.length + ' objectives, 1 control)', 'objectives ' + objectivesChanged + ', controls ' + controlsChanged + ', results ' + JSON.stringify(results));

    const after = await readObjectives(primary);
    for (const s of seeds) {
      const row = after.get(s.id);
      check(row?.status === expected.get(s.id), '9c. ' + s.id + ' is ' + expected.get(s.id) + ' after the update', 'status ' + row?.status);
    }
    const ca = after.get('CA.L2-3.12.4[a]');
    check(ca?.narrative === NARRATIVE && JSON.stringify(ca?.linked_evidence_ids) === JSON.stringify(['rls_verify_ev_9']), '9c. CA.L2-3.12.4[a]: narrative and evidence links are unchanged');
    check(after.size === seeds.length && seeds.every((s) => after.get(s.id)?.objective_catalog_rev === CMMC_OBJECTIVE_CATALOG_REV), '9c. every seeded row (changed or not) is stamped with ' + CMMC_OBJECTIVE_CATALOG_REV + ' and none was deleted', JSON.stringify([...after].map(([id, r]) => id + ':' + r.objective_catalog_rev)));
    const keptStamp = after.get('AC.L1-3.1.2[a]');
    check(keptStamp !== undefined && new Date(keptStamp.updated_at).getTime() === seededAt.get('AC.L1-3.1.2[a]'), '9c. AC.L1-3.1.2[a], which did not change status, keeps its updated_at (the stamp is not a write)');
    const keptNotMet = after.get('AC.L2-3.1.8[c]');
    check(keptNotMet !== undefined && new Date(keptNotMet.updated_at).getTime() === seededAt.get('AC.L2-3.1.8[c]'), '9c. AC.L2-3.1.8[c], a Not met answer, keeps its updated_at');
    const changedRow = after.get('CA.L2-3.12.4[a]');
    check(changedRow !== undefined && new Date(changedRow.updated_at).getTime() > (seededAt.get('CA.L2-3.12.4[a]') ?? Infinity), '9c. CA.L2-3.12.4[a], which changed status, has a later updated_at');

    // 9d. the history: one event per changed objective (the concurrency proof), hashes and lengths only
    const caEvents = await objectiveEvents(primary, 'CA.L2-3.12.4[a]');
    check(caEvents.length === 1, "9d. exactly one 'catalog-update' event exists for CA.L2-3.12.4[a] (the two concurrent calls did not both write)", 'events ' + caEvents.length);
    const ev = caEvents[0];
    check(
      ev !== undefined && ev.old_status === 'MET' && ev.new_status === 'IN_PROGRESS' && ev.narrative_changed === false && ev.evidence_changed === false && ev.control_id === 'CA.L2-3.12.4',
      '9d. the event records MET -> IN_PROGRESS with no narrative or evidence change',
      ev ? ev.old_status + ' -> ' + ev.new_status : 'no event'
    );
    check(
      ev !== undefined &&
        ev.old_narrative_sha256 === sha(NARRATIVE) && ev.new_narrative_sha256 === sha(NARRATIVE) &&
        Number(ev.old_narrative_length) === NARRATIVE.length && Number(ev.new_narrative_length) === NARRATIVE.length &&
        !('narrative' in ev) && !JSON.stringify(ev).includes(NARRATIVE),
      '9d. the event carries the narrative only as SHA-256 and length (no text column, no text in the row)'
    );
    check((await objectiveEvents(primary)).length === changedIds.length, '9d. one catalog-update event per changed objective, none for the unchanged ones', 'events ' + (await objectiveEvents(primary)).length);

    // 9e. the control roll-up
    const controls = await queryWithProgram(primary, 'SELECT control_id, status, implementation_notes FROM control_assessments WHERE tenant_id = $1 AND program_id = $2', [T, primary.programId]);
    const controlRow = (id: string) => controls.rows.find((r) => r.control_id === id);
    const post: Record<string, Status> = {};
    for (const [id, r] of after) post[id] = r.status as Status;
    const expectCa = controlStatusAfterCatalogUpdate('CA.L2-3.12.4', 'MET' as ControlStatusValue, post, 'CMMC_L2');
    const expectAc = controlStatusAfterCatalogUpdate('AC.L2-3.1.5', 'MET' as ControlStatusValue, post, 'CMMC_L2');
    check(expectCa === 'IN_PROGRESS' && expectAc === 'MET', '9e. the pure rule re-rolls up the Met control 3.12.4 to IN_PROGRESS and keeps the Met control 3.1.5 (no objective answers)', expectCa + ' / ' + expectAc);
    check(controlRow('CA.L2-3.12.4')?.status === expectCa && controlRow('CA.L2-3.12.4')?.implementation_notes === NOTES, '9e. control CA.L2-3.12.4 is ' + expectCa + ' and its notes are unchanged', 'status ' + controlRow('CA.L2-3.12.4')?.status);
    check(controlRow('AC.L2-3.1.5')?.status === expectAc && controlRow('AC.L2-3.1.5')?.implementation_notes === NOTES, '9e. control AC.L2-3.1.5 (no objective rows) is still ' + expectAc, 'status ' + controlRow('AC.L2-3.1.5')?.status);
    const caControlEvents = await controlEvents(primary, 'CA.L2-3.12.4');
    const cev = caControlEvents[0];
    check(
      caControlEvents.length === 1 && cev.old_status === 'MET' && cev.new_status === 'IN_PROGRESS' && cev.notes_changed === false && cev.old_notes_sha256 === sha(NOTES) && cev.new_notes_sha256 === sha(NOTES) && !JSON.stringify(cev).includes(NOTES),
      "9e. exactly one 'catalog-update' event for control CA.L2-3.12.4: MET -> IN_PROGRESS, notes unchanged and stored only as a digest",
      'events ' + caControlEvents.length
    );
    check((await controlEvents(primary)).length === 1, "9e. no other control got a 'catalog-update' event", 'events ' + (await controlEvents(primary)).length);

    // 9f. a further call is a no-op
    const objectiveEventsBefore = (await objectiveEvents(primary)).length;
    const third = await ensureObjectiveCatalogCurrent(primary, 'CMMC_L2');
    check(third === null || (third.objectivesChanged === 0 && third.controlsChanged === 0), '9f. a third call reports no change', JSON.stringify(third));
    check((await objectiveEvents(primary)).length === objectiveEventsBefore && (await controlEvents(primary)).length === 1, '9f. and adds no event (idempotent)');
    const afterThird = await readObjectives(primary);
    check(seeds.every((s) => afterThird.get(s.id)?.status === expected.get(s.id) && afterThird.get(s.id)?.objective_catalog_rev === CMMC_OBJECTIVE_CATALOG_REV), '9f. and leaves every status and revision as they were');

    // 9g. program isolation: another program of the tenant is not touched by the first program's migration
    const other = await mkP9('other');
    await seed(other, [seeds[0]]);
    const otherRows = await readObjectives(other);
    const otherRow = otherRows.get('CA.L2-3.12.4[a]');
    check(otherRow?.status === 'MET' && otherRow.objective_catalog_rev === null, "9g. another program's legacy row is untouched by the first program's migration (still MET, no revision)", 'status ' + otherRow?.status + ', rev ' + otherRow?.objective_catalog_rev);
    check((await objectiveEvents(other)).length === 0, "9g. and has no catalog-update event", 'events ' + (await objectiveEvents(other)).length);

    // 9h. an archived program is skipped (the program the request resolved says so), and so is a program of a framework other than CMMC
    const archived = await mkP9('archived');
    await seed(archived, [seeds[0]]);
    await queryWithTenant(T, 'UPDATE programs SET archived_at = NOW() WHERE tenant_id = $1 AND id = $2', [T, archived.programId]);
    const archivedResult = await ensureObjectiveCatalogCurrent(archived, 'CMMC_L2', { archivedAt: new Date().toISOString() });
    const archivedRow = (await readObjectives(archived)).get('CA.L2-3.12.4[a]');
    check(archivedResult === null && archivedRow?.status === 'MET' && archivedRow.objective_catalog_rev === null, '9h. an archived program is skipped: its old answer stays MET with no revision', 'result ' + JSON.stringify(archivedResult) + ', status ' + archivedRow?.status);
    const nist = await mkP9('nist');
    await seed(nist, [seeds[0]]);
    const nistResult = await ensureObjectiveCatalogCurrent(nist, 'NIST_800_53_REV5');
    const nistRow = (await readObjectives(nist)).get('CA.L2-3.12.4[a]');
    check(nistResult === null && nistRow?.status === 'MET' && nistRow.objective_catalog_rev === null, '9h. a non-CMMC framework is skipped: the row stays MET with no revision', 'result ' + JSON.stringify(nistResult) + ', status ' + nistRow?.status);
    check((await objectiveEvents(archived)).length === 0 && (await objectiveEvents(nist)).length === 0, '9h. and neither records an event');
  } catch (err) {
    // the SQL state only: a message can carry a row value
    check(false, '9. the objective catalog update test ran to the end', 'code ' + String((err as { code?: string }).code ?? (err as Error).name));
  } finally {
    for (const id of ids) {
      const scope = { tenantId: T, programId: id };
      await queryWithProgram(scope, 'DELETE FROM control_objective_events WHERE program_id = $1', [id]).catch(() => undefined); // no foreign key: the history outlives its program
      await queryWithProgram(scope, 'DELETE FROM control_assessment_events WHERE program_id = $1', [id]).catch(() => undefined);
      await queryWithProgram(scope, 'DELETE FROM control_objectives WHERE program_id = $1', [id]).catch(() => undefined);
      await queryWithProgram(scope, 'DELETE FROM control_assessments WHERE program_id = $1', [id]).catch(() => undefined);
    }
    await queryWithTenant(T, "DELETE FROM programs WHERE name LIKE 'rls_verify_p9_%'", []).catch(() => undefined);
  }
}

/**
 * 10. A CMMC objective write lowers a Met control that its objectives no longer support (issue #307), on PostgreSQL, in the writer's own transaction.
 * Objectives and Met controls are seeded with SQL; the expected status comes from the pure rule (checkControlStatusWrite). Messages name ids and
 * statuses only, never a note. Every row, event and program it creates is removed.
 */
async function verifyObjectiveRollup() {
  console.log('\n--- 10. Objective roll-up (a Met control is lowered by the objective write that breaks it) ---');
  const { writeObjective } = await import('../server/controlObjectives');
  const { checkControlStatusWrite } = await import('../src/data/cmmcGuide/controlStatusGuard');
  const { cmmcNumberOf, guideObjectives } = await import('../src/data/cmmcGuide/guide');
  const T = TENANT_X;
  const CONTROL = 'AC.L2-3.1.5';
  const NOTES = 'rls_verify_notes_10';
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const letters = guideObjectives(cmmcNumberOf(CONTROL)!, 'CMMC_L2').map((g) => g.letter);
  const objectiveIds = letters.map((l) => CONTROL + '[' + l + ']');
  const insertObjective = 'INSERT INTO control_objectives (tenant_id, program_id, control_id, objective_id, status, narrative, linked_evidence_ids, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)';
  const insertControl = 'INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes, program_id, updated_by) VALUES ($1, $2, $3, $4, $5, $6)';
  const who = { source: 'human' as const, actor: 'rls_verify_actor', userId: 'rls_verify_user' };
  const ids: string[] = [];
  const mkMet = async (name: string): Promise<ProgramScope> => {
    const id = await mkProgram(T, 'rls_verify_p10_' + name);
    ids.push(id);
    const scope = { tenantId: T, programId: id };
    for (const o of objectiveIds) await queryWithProgram(scope, insertObjective, [T, id, CONTROL, o, 'MET', '', '{}', 'rls_verify_actor']);
    await queryWithProgram(scope, insertControl, [T, CONTROL, 'MET', NOTES, id, 'rls_verify_actor']);
    return scope;
  };
  const controlOf = async (scope: ProgramScope) =>
    (await queryWithProgram(scope, 'SELECT status, implementation_notes FROM control_assessments WHERE tenant_id = $1 AND program_id = $2 AND control_id = $3', [scope.tenantId, scope.programId, CONTROL])).rows[0];
  const rollupEvents = async (scope: ProgramScope) =>
    (await queryWithProgram(scope, "SELECT * FROM control_assessment_events WHERE tenant_id = $1 AND program_id = $2 AND source = 'objective-rollup'", [scope.tenantId, scope.programId])).rows;
  try {
    const primary = await mkMet('primary');
    const other = await mkMet('other');
    const nist = await mkMet('nist');
    const lowered = { ...Object.fromEntries(objectiveIds.map((o) => [o, 'MET' as const])), [objectiveIds[0]]: 'NOT_MET' as const };
    const decision = checkControlStatusWrite(CONTROL, 'MET', lowered, 'CMMC_L2');
    check(!decision.allowed && letters.length >= 2, '10a. the pure rule refuses Met once one objective is Not met (the expected value comes from it)', JSON.stringify(decision));
    const expected = decision.allowed ? 'MET' : decision.rolledUp;

    const result = await writeObjective(primary, { objectiveId: objectiveIds[0], controlId: CONTROL, status: 'NOT_MET' }, who, { framework: 'CMMC_L2' });
    check(result.changed && result.controls.length === 1 && result.controls[0].controlId === CONTROL && result.controls[0].status === expected, '10b. writeObjective reports the one control it lowered, at the rolled-up status ' + expected, JSON.stringify(result.controls));
    const row = await controlOf(primary);
    check(row?.status === expected && row?.implementation_notes === NOTES, '10b. the stored control is ' + expected + ' and its notes are unchanged', 'status ' + row?.status);

    const events = await rollupEvents(primary);
    const ev = events[0];
    check(events.length === 1, "10c. the CHECK on control_assessment_events.source accepts 'objective-rollup', and exactly one such event exists", 'events ' + events.length);
    check(
      ev !== undefined && ev.old_status === 'MET' && ev.new_status === expected && ev.notes_changed === false && ev.old_notes_sha256 === sha(NOTES) && ev.new_notes_sha256 === sha(NOTES) && ev.actor_user_id === who.userId && !JSON.stringify(ev).includes(NOTES),
      '10c. the event records MET -> ' + expected + ' under the signed-in user, notes unchanged and stored only as a digest',
      ev ? ev.old_status + ' -> ' + ev.new_status : 'no event'
    );

    const again = await writeObjective(primary, { objectiveId: objectiveIds[0], controlId: CONTROL, status: 'IN_PROGRESS' }, who, { framework: 'CMMC_L2' });
    check(again.controls.length === 0 && (await rollupEvents(primary)).length === 1, '10d. a second change lowers nothing more (the control is no longer Met) and adds no event');

    const otherRow = await controlOf(other);
    check(otherRow?.status === 'MET' && (await rollupEvents(other)).length === 0, "10e. another program's Met control is untouched, with no rollup event", 'status ' + otherRow?.status);

    const nistResult = await writeObjective(nist, { objectiveId: objectiveIds[0], controlId: CONTROL, status: 'NOT_MET' }, who, { framework: 'NIST_800_53_REV5' });
    const nistRow = await controlOf(nist);
    check(nistResult.changed && nistResult.controls.length === 0 && nistRow?.status === 'MET' && (await rollupEvents(nist)).length === 0, '10f. the same write under a non-CMMC framework lowers nothing', 'status ' + nistRow?.status);
  } catch (err) {
    // the SQL state only: a message can carry a row value
    check(false, '10. the objective roll-up test ran to the end', 'code ' + String((err as { code?: string }).code ?? (err as Error).name));
  } finally {
    for (const id of ids) {
      const scope = { tenantId: T, programId: id };
      await queryWithProgram(scope, 'DELETE FROM control_objective_events WHERE program_id = $1', [id]).catch(() => undefined); // no foreign key: the history outlives its program
      await queryWithProgram(scope, 'DELETE FROM control_assessment_events WHERE program_id = $1', [id]).catch(() => undefined);
      await queryWithProgram(scope, 'DELETE FROM control_objectives WHERE program_id = $1', [id]).catch(() => undefined);
      await queryWithProgram(scope, 'DELETE FROM control_assessments WHERE program_id = $1', [id]).catch(() => undefined);
    }
    await queryWithTenant(T, "DELETE FROM programs WHERE name LIKE 'rls_verify_p10_%'", []).catch(() => undefined);
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
