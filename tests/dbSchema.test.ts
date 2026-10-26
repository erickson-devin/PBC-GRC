import { assertSupportedPostgresVersion, buildPoolConfig } from '../server/db';
import { CONTROL_CHANGE_SOURCES } from '../src/types/controlHistory';
import { DISCOVERY_POLICIES, RLS_TENANT_TABLES, TABLES_SQL, buildRlsSql, buildSchemaSql, rlsPolicyName } from '../server/schema';

/**
 * Pure checks (no database needed) on the schema bootstrap and the pool configuration:
 *  - tenant_users and ssp_documents are created by initDb;
 *  - EVERY tenant-bound table gets ENABLE + FORCE ROW LEVEL SECURITY and a policy;
 *  - DATABASE_URL selects a standard connection string, otherwise the existing Unix socket / TCP logic.
 * Live enforcement against PostgreSQL itself is covered by `npm run db:verify-rls` (needs a real database).
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

const schema = buildSchemaSql();
const rls = buildRlsSql();

console.log('--- initDb creates the membership and SSP tables ---');
assert(/CREATE TABLE IF NOT EXISTS tenant_users/.test(schema), 'tenant_users is created');
assert(/CREATE TABLE IF NOT EXISTS ssp_documents/.test(schema), 'ssp_documents is created');
assert(/CREATE TABLE IF NOT EXISTS local_users/.test(schema) && /password_hash/.test(schema) && !/\bpassword\s+VARCHAR/i.test(schema), 'local_users stores a password hash only, never a password column');
assert(schema.includes('CONSTRAINT unq_local_users_email UNIQUE (email)'), 'local user emails are unique');
assert(/UNIQUE \(user_id, tenant_id\)/.test(TABLES_SQL), 'tenant_users is unique per (user, tenant) so the upsert works');
assert(/CHECK \(role IN \('TENANT_OWNER', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'\)\)/.test(TABLES_SQL), 'role check allows exactly the four TenantRoles (incl. MSP_ADMIN)');
assert(/DROP CONSTRAINT IF EXISTS tenant_users_role_check/.test(TABLES_SQL), 'older tables get the corrected role check');

console.log('\n--- FORCE ROW LEVEL SECURITY on every tenant-bound table ---');
for (const { table } of RLS_TENANT_TABLES) {
  assert(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).test(rls), `${table}: ENABLE ROW LEVEL SECURITY`);
  assert(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`).test(rls), `${table}: FORCE ROW LEVEL SECURITY (owner cannot bypass)`);
  assert(rls.includes(`CREATE POLICY ${rlsPolicyName(table)} ON ${table}`), `${table}: tenant-isolation policy`);
}
const forceCount = (rls.match(/FORCE ROW LEVEL SECURITY/g) || []).length;
assert(forceCount === RLS_TENANT_TABLES.length, `one FORCE per table (${forceCount}/${RLS_TENANT_TABLES.length})`);
assert(
  (rls.match(/WITH CHECK/g) || []).length === RLS_TENANT_TABLES.length,
  'every policy has a WITH CHECK, so writes for another tenant are rejected as well as reads hidden'
);
assert(/tenants[\s\S]*USING \(id = NULLIF/.test(rls), 'the tenants table is keyed on id, not tenant_id');

// Guard against forgetting a future table: any CREATE TABLE with a tenant_id column must be RLS-protected.
const created = [...TABLES_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n  \);/g)].map((m) => ({ name: m[1], body: m[2] }));
const tenantBound = created.filter((t) => /\btenant_id\b/.test(t.body)).map((t) => t.name);
const protectedTables = new Set(RLS_TENANT_TABLES.map((t) => t.table));
assert(tenantBound.length >= 4, `found tenant-bound tables in the DDL (${tenantBound.join(', ')})`);
assert(tenantBound.every((t) => protectedTables.has(t)), 'every table with a tenant_id column is covered by RLS', tenantBound.filter((t) => !protectedTables.has(t)));
assert(!protectedTables.has('control_mappings'), 'global reference data (control_mappings) is intentionally not RLS-bound');
assert(!protectedTables.has('local_users') && !tenantBound.includes('local_users'), 'local_users is global identity data (login happens before any tenant exists), not tenant-bound');

console.log('\n--- Control assessment history ---');
const eventsStart = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS control_assessment_events (');
const eventsBlock = eventsStart < 0 ? '' : TABLES_SQL.slice(eventsStart, TABLES_SQL.indexOf('\n  );', eventsStart));
assert(eventsStart >= 0, 'control_assessment_events is created');
assert(RLS_TENANT_TABLES.some((r) => r.table === 'control_assessment_events' && r.tenantColumn === 'tenant_id'), 'control_assessment_events is in RLS_TENANT_TABLES on tenant_id');
assert(
  rls.includes('ALTER TABLE control_assessment_events FORCE ROW LEVEL SECURITY;') && rls.includes(`CREATE POLICY ${rlsPolicyName('control_assessment_events')} ON control_assessment_events`),
  'control_assessment_events: FORCE ROW LEVEL SECURITY and the tenant-isolation policy are in buildRlsSql()'
);
const eventSources = [...(/control_assessment_events_source_check CHECK \(source IN \(([^)]*)\)\)/.exec(TABLES_SQL)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((x) => x[1]);
assert(
  JSON.stringify(eventSources) === JSON.stringify(['human', 'ssp-commit', 'vm-snapshot']) && JSON.stringify(eventSources) === JSON.stringify(CONTROL_CHANGE_SOURCES),
  'the event source CHECK lists human, ssp-commit, vm-snapshot and equals CONTROL_CHANGE_SOURCES', eventSources
);
assert(
  TABLES_SQL.includes('DROP CONSTRAINT IF EXISTS control_assessment_events_source_check') &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS control_assessment_events_source_check') < TABLES_SQL.indexOf('ADD CONSTRAINT control_assessment_events_source_check'),
  'the source CHECK is dropped before it is added, so a new source reaches existing databases'
);
assert(
  eventsBlock.length > 0 && !/\bimplementation_notes\b/.test(eventsBlock) && !/\bnotes\s+TEXT\b/i.test(eventsBlock),
  'an event has no notes text column (notes may hold CUI: only the SHA-256 and length are kept)'
);
assert(eventsBlock.length > 0 && !/\bREFERENCES\b/i.test(eventsBlock), 'no foreign key: the history outlives the control_assessments row');
assert(
  TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_assessment_events_control ON control_assessment_events (tenant_id, control_id, created_at DESC);'),
  'the history is indexed by (tenant, control, newest first)'
);

console.log('\n--- Tenant discovery policies ("list my tenants") ---');
const byName = (name: string) => DISCOVERY_POLICIES.find((p) => p.name === name);
const tenantsPolicy = byName('rls_tenants_member_discovery');
const selfPolicy = byName('rls_tenant_users_self_discovery');
const userCtx = "NULLIF(current_setting('app.current_user_id', true), '')";
assert(Boolean(tenantsPolicy) && tenantsPolicy!.table === 'tenants', 'tenants has a member-discovery policy');
assert(Boolean(selfPolicy) && selfPolicy!.table === 'tenant_users', 'tenant_users has a self-visibility policy (the tenants policy reads it under RLS, so it needs one)');
assert(tenantsPolicy?.using === `id IN (SELECT tenant_id FROM tenant_users WHERE user_id = ${userCtx})`, 'tenants are visible only where the user has a tenant_users row', tenantsPolicy?.using);
assert(selfPolicy?.using === `user_id = ${userCtx}`, 'tenant_users: a user sees only their own rows', selfPolicy?.using);
const tokenCtx = "NULLIF(current_setting('app.invite_token_hash', true), '')";
const vmTokenCtx = "NULLIF(current_setting('app.vm_token_hash', true), '')";
const vmSchedulerCtx = "NULLIF(current_setting('app.vm_scheduler', true), '')";
assert(DISCOVERY_POLICIES.every((p) => p.using.includes(userCtx) || p.using.includes(tokenCtx) || p.using.includes(vmTokenCtx) || p.using.includes(vmSchedulerCtx)), "an unset or empty user / invite / vm-token / vm-scheduler context matches nothing (NULLIF, so '' never equals an id or hash)");

console.log('\n--- Invitations ---');
assert(schema.includes('CREATE TABLE IF NOT EXISTS tenant_invitations'), 'tenant_invitations is created by initDb');
const invBlock = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS tenant_invitations'), schema.indexOf('CREATE TABLE IF NOT EXISTS local_users'));
assert(/token_hash CHAR\(64\) NOT NULL/.test(invBlock) && !/\btoken VARCHAR|\btoken TEXT/i.test(invBlock), 'only a SHA-256 hash of the token is stored, never the token');
assert(invBlock.includes('CONSTRAINT unq_invitation_token_hash UNIQUE (token_hash)'), 'token hashes are unique');
assert(/accepted_at TIMESTAMPTZ/.test(invBlock) && /revoked_at TIMESTAMPTZ/.test(invBlock) && /expires_at TIMESTAMPTZ NOT NULL/.test(invBlock), 'single-use, revocation and expiry columns exist');
assert(/CHECK \(role IN \('TENANT_OWNER', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'\)\)/.test(invBlock), 'invited roles are limited to the four TenantRoles');
assert(protectedTables.has('tenant_invitations') && rls.includes('ALTER TABLE tenant_invitations FORCE ROW LEVEL SECURITY;'), 'tenant_invitations has tenant isolation with FORCE RLS');
assert(byName('rls_tenant_invitations_redeem')?.using === `token_hash = ${tokenCtx}`, 'an invitation is visible to whoever presents its token hash, and only that one');
assert(byName('rls_tenants_invite_redeem')?.using === `id IN (SELECT tenant_id FROM tenant_invitations WHERE token_hash = ${tokenCtx})`, 'the tenant it points at is visible too (for the accept-page preview)');
for (const p of DISCOVERY_POLICIES) {
  const start = rls.indexOf(`CREATE POLICY ${p.name}`);
  const block = rls.slice(start, rls.indexOf('END IF;', start));
  assert(start > 0 && /FOR SELECT/.test(block) && !/FOR ALL|FOR INSERT|FOR UPDATE|FOR DELETE/.test(block), `${p.name} is SELECT-only: it can never grant a write`);
  assert(!/WITH CHECK/.test(block), `${p.name} has no WITH CHECK`);
  assert(rls.includes(`policyname = '${p.name}'`), `${p.name} is created idempotently`);
}
assert(DISCOVERY_POLICIES.every((p) => protectedTables.has(p.table)), 'discovery policies only extend tables that already have FORCE RLS');
assert(!TABLES_SQL.includes('app.current_user_id'), 'the user context is used only by policies, never by table definitions');

console.log('\n--- local_users second factor (Phase 5.9) ---');
const luStart = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_users');
const luEnd = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS ssp_import_jobs');
const luBlock = luStart >= 0 && luEnd > luStart ? TABLES_SQL.slice(luStart, luEnd) : '';
const addColumnLines = [
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;',
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ;',
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT;',
  "ALTER TABLE local_users ADD COLUMN IF NOT EXISTS recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}';",
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;',
];
assert(addColumnLines.every((l) => TABLES_SQL.includes(l)), 'S1: the six ADD COLUMN IF NOT EXISTS lines for the second factor, token version and forced password change are present', addColumnLines.filter((l) => !TABLES_SQL.includes(l)));
const addColumnCount = (luBlock.match(/ADD COLUMN/g) || []).length;
const addColumnGuarded = (luBlock.match(/ADD COLUMN IF NOT EXISTS/g) || []).length;
const addConstraints = [...luBlock.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
assert(luBlock.length > 0 && addColumnCount === addColumnGuarded && addColumnCount === 6, 'S2: every ADD COLUMN in the local_users block is IF NOT EXISTS (idempotent)', { addColumnCount, addColumnGuarded });
assert(
  addConstraints.length === 3 && addConstraints.every((c) => luBlock.indexOf(`DROP CONSTRAINT IF EXISTS ${c}`) >= 0 && luBlock.indexOf(`DROP CONSTRAINT IF EXISTS ${c}`) < luBlock.indexOf(`ADD CONSTRAINT ${c}`)),
  'S2: every ADD CONSTRAINT is preceded by its DROP CONSTRAINT IF EXISTS',
  addConstraints
);
assert((luBlock.match(/CREATE TABLE/g) || []).length === 1 && !/\btenant_id\b/.test(luBlock), 'S2: the block creates only local_users and has no tenant_id (global identity data)');
assert(!/totp_secret\s+(TEXT|VARCHAR)/i.test(TABLES_SQL) && !/recovery_codes\s+(TEXT|JSONB)/i.test(TABLES_SQL), 'S3: no plaintext secret or recovery-code column (only totp_secret_enc and recovery_code_hashes)');
assert(!buildRlsSql().includes('local_users'), 'S4: buildRlsSql() does not mention local_users');
assert(
  ['local_users_totp_secret_enc_check', 'local_users_recovery_codes_check', 'local_users_totp_confirm_check'].every((c) => TABLES_SQL.includes(c)),
  'S5: the three second-factor CHECK constraints are present'
);

console.log('\n--- Programs (authorization boundaries): additive data layer ---');
const PROGRAM_SCOPED = ['control_assessments', 'control_assessment_events', 'evidence_metadata', 'ssp_import_jobs', 'staged_controls', 'vm_poam_items'];
const FK_TABLES = PROGRAM_SCOPED.filter((t) => t !== 'control_assessment_events');
const programsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS programs (');
const programsBlock = programsAt < 0 ? '' : TABLES_SQL.slice(programsAt, TABLES_SQL.indexOf('\n  );', programsAt));
const programDdl = programsAt < 0 ? '' : TABLES_SQL.slice(programsAt);
assert(programsAt >= 0 && TABLES_SQL.includes('CREATE TABLE IF NOT EXISTS programs ('), 'P1: programs is created by initDb');
assert(RLS_TENANT_TABLES.some((r) => r.table === 'programs' && r.tenantColumn === 'tenant_id'), 'P1: programs is in RLS_TENANT_TABLES on tenant_id (FORCE RLS and the tenant policy)');
assert(programsBlock.includes('CONSTRAINT unq_programs_tenant_id UNIQUE (tenant_id, id)'), 'P1: programs carries the (tenant_id, id) key the composite foreign keys point at');
assert(programsBlock.includes('id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text') && programsBlock.includes('CONSTRAINT programs_default_not_archived CHECK (NOT (is_default AND archived_at IS NOT NULL))'), 'P1: text ids like every other table, and a default program cannot be archived');
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_default ON programs (tenant_id) WHERE is_default'), 'P1: at most one default program per tenant');
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_name ON programs (tenant_id, lower(name))'), 'P1: program names are unique per tenant ignoring case');
assert(TABLES_SQL.includes("ADD CONSTRAINT programs_framework_check CHECK (framework_id IN ('CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'))"), 'P1: the framework check lists the five registry ids');
assert(TABLES_SQL.includes("ADD CONSTRAINT programs_baseline_check CHECK (baseline IS NULL OR (framework_id = 'NIST_800_53_REV5' AND baseline IN ('LOW', 'MODERATE', 'HIGH')))"), 'P1: a baseline exists for NIST only and is LOW, MODERATE or HIGH');
assert(
  ['programs_framework_check', 'programs_baseline_check'].every((c) => TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS ' + c) >= 0 && TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS ' + c) < TABLES_SQL.indexOf('ADD CONSTRAINT ' + c)),
  'P1: the two programs checks are dropped before they are added, so a new framework reaches existing databases'
);
for (const t of PROGRAM_SCOPED) {
  assert(TABLES_SQL.includes('ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS program_id VARCHAR(64)'), 'P1: ' + t + ' gets a nullable program_id, idempotently');
}
const fkCount = (programDdl.match(/FOREIGN KEY \(tenant_id, program_id\) REFERENCES programs \(tenant_id, id\)/g) || []).length;
assert(fkCount === FK_TABLES.length, 'P1: five composite (tenant_id, program_id) foreign keys', fkCount);
for (const t of FK_TABLES) {
  assert(programDdl.includes('ALTER TABLE ' + t + ' ADD CONSTRAINT fk_' + t + '_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id)'), 'P1: ' + t + ' has the composite program foreign key');
}
assert(!programDdl.includes('fk_control_assessment_events_program') && !programDdl.includes('ALTER TABLE control_assessment_events ADD CONSTRAINT'), 'P1: control_assessment_events has no foreign key (the history outlives the program)');
assert(
  programDdl.includes('ALTER TABLE control_assessments ADD CONSTRAINT fk_control_assessments_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
    programDdl.includes('ALTER TABLE staged_controls ADD CONSTRAINT fk_staged_controls_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE'),
  'P1: deleting a program removes its control answers and staged suggestions'
);
assert(
  ['evidence_metadata', 'ssp_import_jobs', 'vm_poam_items'].every((t) => programDdl.includes('ALTER TABLE ' + t + ' ADD CONSTRAINT fk_' + t + '_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE RESTRICT')),
  'P1: evidence, SSP imports and POA&M items RESTRICT the deletion of their program'
);
assert(TABLES_SQL.indexOf('ADD CONSTRAINT control_mappings_mapping_type_check') > 0 && TABLES_SQL.indexOf('ADD CONSTRAINT control_mappings_mapping_type_check') < programsAt, 'P1: the program DDL starts after control_mappings_mapping_type_check (the end of the old schema)');
assert(programsAt > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_admins') && programsAt > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_users'), 'P1: the program DDL sits after the VM block and the local_users block, which are not edited');
const fkAdds = (programDdl.match(/ADD CONSTRAINT fk_/g) || []).length;
const fkGuards = (programDdl.match(/conname = /g) || []).length;
assert(fkAdds === FK_TABLES.length && fkAdds === fkGuards, 'P1: every foreign key is added once, behind a pg_constraint guard (' + fkAdds + ' adds, ' + fkGuards + ' guards)');
assert(
  TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_assessment_events_program ON control_assessment_events (tenant_id, program_id, control_id, created_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_evidence_metadata_program ON evidence_metadata (tenant_id, program_id, uploaded_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_ssp_import_jobs_program ON ssp_import_jobs (tenant_id, program_id, created_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_vm_poam_items_program ON vm_poam_items (tenant_id, program_id, status);'),
  'P1: the four program indexes exist'
);
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_control_assessments_program_control ON control_assessments (tenant_id, program_id, control_id);'), 'P1: the per-program control key is added');
assert(!programDdl.includes('unq_tenant_control') && !programDdl.includes('RESTRICTIVE') && !programDdl.includes('NOT VALID') && !programDdl.includes('SET NOT NULL'), 'P1: nothing of the enforcement wave yet (the old unique key stays, no restrictive policy, no NOT VALID check, no NOT NULL)');
assert(!rls.includes('program_isolation') && (rls.match(/WITH CHECK/g) || []).length === RLS_TENANT_TABLES.length, 'P1: no program row policy yet; every policy is still a tenant policy');

console.log('\n--- Pool configuration ---');
const url = buildPoolConfig({ DATABASE_URL: 'postgres://app:s3cret@db.internal:6543/grc?sslmode=require' } as NodeJS.ProcessEnv);
assert(url.config.connectionString === 'postgres://app:s3cret@db.internal:6543/grc?sslmode=require', 'DATABASE_URL is passed through as the connection string');
assert(!url.target.includes('s3cret') && !url.target.includes('app:'), 'credentials never appear in the loggable target', url.target);
assert(url.target === 'db.internal:6543/grc', 'target shows host:port/database', url.target);

const both = buildPoolConfig({ DATABASE_URL: 'postgres://u:p@urlhost/db', DB_HOST: 'otherhost', DB_NAME: 'other' } as NodeJS.ProcessEnv);
assert(both.config.connectionString !== undefined && both.config.host === undefined, 'DATABASE_URL takes precedence over DB_* settings');
assert(buildPoolConfig({ DATABASE_URL: '   ' } as NodeJS.ProcessEnv).config.connectionString === undefined, 'blank DATABASE_URL is ignored');

const defaults = buildPoolConfig({} as NodeJS.ProcessEnv);
assert(defaults.config.host === '127.0.0.1' && defaults.config.port === 5432, 'default: 127.0.0.1 over TCP on 5432');
const socket = buildPoolConfig({ DB_HOST: '/var/run/postgresql' } as NodeJS.ProcessEnv);
assert(socket.config.host === '/var/run/postgresql' && socket.config.port === undefined, 'an absolute DB_HOST is a Unix socket directory (no port)');
const tcp = buildPoolConfig({ DB_HOST: 'singularity-db', DB_PORT: '5433', DB_USER: 'u', DB_NAME: 'n', DB_PASS: 'p' } as NodeJS.ProcessEnv);
assert(tcp.config.host === 'singularity-db' && tcp.config.port === 5433 && tcp.config.user === 'u', 'DB_HOST without a leading "/" is TCP with DB_PORT');
assert(buildPoolConfig({} as NodeJS.ProcessEnv).config.ssl === undefined, 'TLS is off unless requested');
const ssl = buildPoolConfig({ DATABASE_URL: 'postgres://a@h/d', DB_SSL: 'true' } as NodeJS.ProcessEnv);
assert((ssl.config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized === true, 'DB_SSL=true verifies the server certificate by default');
const sslLoose = buildPoolConfig({ DATABASE_URL: 'postgres://a@h/d', DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' } as NodeJS.ProcessEnv);
assert((sslLoose.config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized === false, 'verification can be disabled explicitly (self-signed on-prem)');
assert(url.config.max === 10, 'pool size is unchanged');

console.log('\n--- PostgreSQL version check ---');
function versionError(num: unknown, text: unknown): string | null {
  try {
    assertSupportedPostgresVersion(num, text);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
assert(versionError('160004', '16.4') === null, 'PostgreSQL 16.4 is accepted');
assert(versionError('150000', '15.0') === null, 'PostgreSQL 15.0 is accepted');
assert(versionError('140011', '14.11') === 'PBC-GRC requires PostgreSQL 15 or later; found 14.11', 'PostgreSQL 14.11 is refused with a clear message', versionError('140011', '14.11'));
assert(versionError('90624', '9.6.24') !== null, 'PostgreSQL 9.6.24 is refused');
const unknownVersion = versionError(undefined, undefined);
assert(unknownVersion !== null && unknownVersion.endsWith('found unknown'), 'an unreadable version is refused as unknown', unknownVersion);
assert(versionError('abc', 'x') !== null, 'a non-numeric version number is refused');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
