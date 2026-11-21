import fs from 'fs';
import { assertSupportedPostgresVersion, assessDatabaseRole, buildPoolConfig } from '../server/db';
import { CONTROL_CHANGE_SOURCES } from '../src/types/controlHistory';
import { SSP_METADATA_FIELDS } from '../src/types/sspMetadata';
import { ACCOUNT_EVENT_ACTIONS } from '../server/auth/accountEvents';
import { DISCOVERY_POLICIES, PROGRAM_BACKFILL_TABLES, RLS_PROGRAM_TABLES, RLS_TENANT_TABLES, TABLES_SQL, buildLegacyProgramRowCountSql, buildProgramIdNotNullSql, buildProgramRlsSql, buildRlsSql, buildSchemaSql, rlsPolicyName, rlsProgramPolicyName } from '../server/schema';

/**
 * Pure checks (no database needed) on the schema bootstrap and the pool configuration:
 *  - tenant_users is created by initDb; ssp_documents is dropped;
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
assert(!/CREATE TABLE IF NOT EXISTS ssp_documents/.test(schema), 'D1: ssp_documents is no longer created (issue #25)');
assert(!RLS_TENANT_TABLES.some((t) => t.table === 'ssp_documents') && !buildRlsSql().includes('ssp_documents'), 'D2: ssp_documents has no tenant policy any more');
const sspNoForce = TABLES_SQL.indexOf('ALTER TABLE ssp_documents NO FORCE ROW LEVEL SECURITY;');
const sspProbe = TABLES_SQL.indexOf('IF NOT EXISTS (SELECT 1 FROM ssp_documents) THEN');
const sspDrop = TABLES_SQL.indexOf('DROP TABLE ssp_documents;');
const sspReforce = TABLES_SQL.indexOf('ALTER TABLE ssp_documents FORCE ROW LEVEL SECURITY;');
assert(0 < sspNoForce && sspNoForce < sspProbe && sspProbe < sspDrop && sspDrop < sspReforce, 'D3: ssp_documents is dropped only after an empty probe, and FORCE RLS is restored when rows remain', [sspNoForce, sspProbe, sspDrop, sspReforce]);
assert(
  (schema.match(/NO FORCE ROW LEVEL SECURITY/g) || []).length === 3 &&
    (schema.match(/ALTER TABLE (\w+) NO FORCE ROW LEVEL SECURITY/g) || []).join('|') === 'ALTER TABLE ssp_documents NO FORCE ROW LEVEL SECURITY|ALTER TABLE enclave_assets NO FORCE ROW LEVEL SECURITY|ALTER TABLE vm_poam_items NO FORCE ROW LEVEL SECURITY',
  'D4: the ssp_documents probe, the enclave_assets retired-column fix (#216) and the vm_poam_items item-number backfill (#305) are the only NO FORCE in the schema'
);
assert(TABLES_SQL.includes('relnamespace = current_schema()::regnamespace'), 'D5: the ssp_documents lookup is limited to the current schema');
assert(/CREATE TABLE IF NOT EXISTS local_users/.test(schema) && /password_hash/.test(schema) && !/\bpassword\s+VARCHAR/i.test(schema), 'local_users stores a password hash only, never a password column');
assert(schema.includes('CONSTRAINT unq_local_users_email UNIQUE (email)'), 'local user emails are unique');
assert(/UNIQUE \(user_id, tenant_id\)/.test(TABLES_SQL), 'tenant_users is unique per (user, tenant) so the upsert works');
assert(/CHECK \(role IN \('TENANT_OWNER', 'TENANT_ADMIN', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'\)\)/.test(TABLES_SQL), 'role check allows exactly the five TenantRoles (incl. TENANT_ADMIN and MSP_ADMIN)');
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
  JSON.stringify(eventSources) === JSON.stringify(['human', 'ssp-commit', 'vm-snapshot', 'clone', 'catalog-update', 'objective-rollup']) && JSON.stringify(eventSources) === JSON.stringify(CONTROL_CHANGE_SOURCES),
  'the event source CHECK lists human, ssp-commit, vm-snapshot, clone, catalog-update, objective-rollup and equals CONTROL_CHANGE_SOURCES', eventSources
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
assert(
  TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_assessment_events_created ON control_assessment_events (tenant_id, created_at);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_objective_events_created ON control_objective_events (tenant_id, created_at);'),
  'S53-16 both history tables are indexed by (tenant, created_at) for the retention sweep'
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
const retentionCtx = "NULLIF(current_setting('app.event_retention', true), '')";
assert(DISCOVERY_POLICIES.every((p) => p.using.includes(userCtx) || p.using.includes(tokenCtx) || p.using.includes(vmTokenCtx) || p.using.includes(vmSchedulerCtx) || p.using.includes(retentionCtx)), "an unset or empty user / invite / vm-token / vm-scheduler / event-retention context matches nothing (NULLIF, so '' never equals an id or hash)");
const retentionPolicy = byName('rls_programs_retention_sweep');
assert(
  retentionPolicy?.table === 'programs' && retentionPolicy.using === `${retentionCtx} = 'on'`,
  "S53-17 programs is listable only under app.event_retention = 'on' (the retention sweep's enumeration)",
  retentionPolicy
);

console.log('\n--- Invitations ---');
assert(schema.includes('CREATE TABLE IF NOT EXISTS tenant_invitations'), 'tenant_invitations is created by initDb');
const invBlock = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS tenant_invitations'), schema.indexOf('CREATE TABLE IF NOT EXISTS local_users'));
assert(/token_hash CHAR\(64\) NOT NULL/.test(invBlock) && !/\btoken VARCHAR|\btoken TEXT/i.test(invBlock), 'only a SHA-256 hash of the token is stored, never the token');
assert(invBlock.includes('CONSTRAINT unq_invitation_token_hash UNIQUE (token_hash)'), 'token hashes are unique');
assert(/accepted_at TIMESTAMPTZ/.test(invBlock) && /revoked_at TIMESTAMPTZ/.test(invBlock) && /expires_at TIMESTAMPTZ NOT NULL/.test(invBlock), 'single-use, revocation and expiry columns exist');
assert(/CHECK \(role IN \('TENANT_OWNER', 'TENANT_ADMIN', 'MSP_ADMIN', 'ASSESSOR', 'VIEWER'\)\)/.test(invBlock), 'invited roles are limited to the five TenantRoles');
{
  const widen = TABLES_SQL.search(/DROP CONSTRAINT IF EXISTS tenant_invitations_role_check;\s*ALTER TABLE tenant_invitations ADD CONSTRAINT tenant_invitations_role_check CHECK \(role IN \([^)]*'TENANT_ADMIN'/);
  assert(widen > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS tenant_invitations'), 'existing databases get the widened invitation role check (dropped and re-added after the CREATE TABLE)');
}
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
const dormantLines = [
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS disabled_reason VARCHAR(16);',
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;',
  'ALTER TABLE local_users ADD COLUMN IF NOT EXISTS dormancy_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();',
];
const actionBlockAt = TABLES_SQL.indexOf("ADD CONSTRAINT local_account_events_action_check CHECK (action IN ('password_changed'", TABLES_SQL.indexOf('LIKE \'%announcement_withdrawn%\''));
const reasonDrop = TABLES_SQL.indexOf('ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_disabled_reason_check;');
const reasonAdd = TABLES_SQL.indexOf('ALTER TABLE local_users ADD CONSTRAINT local_users_disabled_reason_check');
assert(
  dormantLines.every((l) => TABLES_SQL.includes(l) && TABLES_SQL.indexOf(l) > actionBlockAt) && actionBlockAt > 0 && reasonDrop > actionBlockAt && reasonAdd > reasonDrop && TABLES_SQL.includes("disabled_reason IS NULL OR disabled_reason IN ('admin', 'dormant')"),
  'DA1: the dormant account columns are added idempotently after the account events action block, with the reason check dropped before it is added (#257)',
  [actionBlockAt, reasonDrop, reasonAdd]
);
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
// The program DDL proper: the assessment-objectives tables that follow it are new tables with their own inline key (pinned further down)
const objectivesAt = TABLES_SQL.indexOf('-- Assessment objectives');
const programDdl = programsAt < 0 ? '' : TABLES_SQL.slice(programsAt, objectivesAt > programsAt ? objectivesAt : undefined);
const membershipAt = TABLES_SQL.indexOf('-- Boundary asset membership');
const objectivesDdl = objectivesAt < 0 ? '' : TABLES_SQL.slice(objectivesAt, membershipAt > objectivesAt ? membershipAt : undefined);
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
assert(
  TABLES_SQL.includes('ALTER TABLE programs ADD COLUMN IF NOT EXISTS privacy_baseline BOOLEAN NOT NULL DEFAULT FALSE;') && !programsBlock.includes('privacy_baseline') && programDdl.includes('privacy_baseline'),
  'P1: privacy_baseline is added to programs after the CREATE TABLE (so the table block is unchanged), inside the program DDL, false by default'
);
assert(
  TABLES_SQL.includes("ADD CONSTRAINT programs_privacy_check CHECK (NOT privacy_baseline OR framework_id = 'NIST_800_53_REV5')") &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS programs_privacy_check') >= 0 &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS programs_privacy_check') < TABLES_SQL.indexOf('ADD CONSTRAINT programs_privacy_check'),
  'P1: only a NIST SP 800-53 program can have the privacy baseline (programs_privacy_check, dropped before it is added)'
);
assert(TABLES_SQL.includes("ADD CONSTRAINT programs_baseline_check CHECK (baseline IS NULL OR (framework_id = 'NIST_800_53_REV5' AND baseline IN ('LOW', 'MODERATE', 'HIGH')))"), 'P1: programs_baseline_check is unchanged by the privacy baseline');
assert(
  TABLES_SQL.includes("ALTER TABLE programs ADD COLUMN IF NOT EXISTS scoping JSONB NOT NULL DEFAULT '{}'::jsonb;") && !programsBlock.includes('scoping') && programDdl.includes('scoping JSONB'),
  'P1: scoping is added to programs after the CREATE TABLE (table block unchanged), inside the program DDL, an empty object by default'
);
assert(
  ['programs_scoping_check', 'programs_scoping_privacy_check', 'programs_scoping_framework_check', 'programs_vm_target_check'].every((c) => TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS ' + c) >= 0 && TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS ' + c) < TABLES_SQL.indexOf('ADD CONSTRAINT ' + c)),
  'P1: the scoping and vm_target checks are dropped before they are added'
);
assert(
  TABLES_SQL.includes("CHECK (jsonb_typeof(scoping) = 'object' AND (scoping - ARRAY['nonNetworkedOnly', 'noWireless', 'noMobileDevices', 'noPiiProcessing']) = '{}'::jsonb AND NOT jsonb_path_exists(scoping, '$.* ? (@ != true)'))"),
  'P1: scoping is an object of the four known overlay keys, each only ever true'
);
assert(
  TABLES_SQL.includes("ADD CONSTRAINT programs_scoping_privacy_check CHECK (NOT (privacy_baseline AND scoping ? 'noPiiProcessing'))") &&
    TABLES_SQL.includes("ADD CONSTRAINT programs_scoping_framework_check CHECK (scoping = '{}'::jsonb OR framework_id = 'NIST_800_53_REV5')"),
  'P1: a privacy program keeps its PII controls, and only a NIST SP 800-53 program can be scoped'
);
assert(
  TABLES_SQL.includes('ALTER TABLE programs ADD COLUMN IF NOT EXISTS vm_target BOOLEAN NOT NULL DEFAULT FALSE;') && !programsBlock.includes('vm_target') &&
    TABLES_SQL.includes("ADD CONSTRAINT programs_vm_target_check CHECK (NOT vm_target OR (archived_at IS NULL AND framework_id IN ('CMMC_L1', 'CMMC_L2')))"),
  'P1: vm_target is added after the CREATE TABLE; the target is a live CMMC L1/L2 program'
);
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_vm_target ON programs (tenant_id) WHERE vm_target;'), 'P1: at most one VM target program per tenant');
const peAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_events (');
const programEvents = peAt < 0 ? '' : TABLES_SQL.slice(peAt, TABLES_SQL.indexOf('\n  );', peAt));
assert(peAt > objectivesAt && programEvents !== '', 'P1: program_events is created (IF NOT EXISTS) at the end of the DDL');
assert(!/FOREIGN KEY|REFERENCES/.test(programEvents) && /program_id VARCHAR\(64\) NOT NULL/.test(programEvents), 'P1: program_events has no foreign key (the history outlives the program) and a NOT NULL program_id');
assert(!/^\s+(name|description|notes|narrative)\s/m.test(programEvents) && /old_value JSONB,/.test(programEvents) && /new_value JSONB NOT NULL/.test(programEvents), 'P1: program_events holds JSON values only, no name, description, notes or narrative column');
assert(
  TABLES_SQL.includes("ADD CONSTRAINT program_events_kind_check CHECK (kind IN ('scoping_set', 'scoping_changed', 'vm_target_set', 'vm_target_cleared', 'assets_changed', 'ssp_metadata_changed', 'stack_profile_changed'))") &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS program_events_kind_check') < TABLES_SQL.indexOf('ADD CONSTRAINT program_events_kind_check'),
  'P1: the event kind CHECK lists the seven kinds (SSP metadata and stack profile included), dropped before it is added'
);
assert(TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_program_events_program ON program_events (tenant_id, program_id, created_at DESC);'), 'P1: program_events is indexed by program and time');
assert(RLS_TENANT_TABLES.some((r) => r.table === 'program_events' && r.tenantColumn === 'tenant_id') && !PROGRAM_BACKFILL_TABLES.includes('program_events' as never), 'P1: program_events is a tenant and program RLS table but is not backfilled');
assert(RLS_TENANT_TABLES.some((r) => r.table === 'vm_poam_item_events' && r.tenantColumn === 'tenant_id') && !PROGRAM_BACKFILL_TABLES.includes('vm_poam_item_events' as never) && !PROGRAM_SCOPED.includes('vm_poam_item_events'), 'P1: vm_poam_item_events is a tenant and program RLS table, NOT NULL program_id from creation, and is not backfilled');
for (const col of ['updated_by VARCHAR(255)', 'status_changed_by VARCHAR(255)', 'status_changed_at TIMESTAMPTZ', 'auto_complete BOOLEAN NOT NULL DEFAULT TRUE']) {
  assert(TABLES_SQL.includes('ALTER TABLE vm_poam_items ADD COLUMN IF NOT EXISTS ' + col + ';'), 'P1: vm_poam_items gets ' + col + ' idempotently (#295, #297)');
}
{
  const evStart = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS vm_poam_item_events (');
  const ev = evStart < 0 ? '' : TABLES_SQL.slice(evStart, TABLES_SQL.indexOf('\n  );', evStart));
  assert(ev !== '' && !/FOREIGN KEY|REFERENCES/.test(ev), 'P1: vm_poam_item_events has no foreign key (the history outlives the item and the program)');
  assert(ev !== '' && !/\b(owner|mitigation) (TEXT|VARCHAR)/.test(ev) && /new_owner_sha256/.test(ev) && /new_mitigation_length/.test(ev), 'P1: vm_poam_item_events holds no owner or mitigation text, only digests, lengths and flags');
}
for (const t of PROGRAM_SCOPED) {
  assert(TABLES_SQL.includes('ALTER TABLE ' + t + ' ADD COLUMN IF NOT EXISTS program_id VARCHAR(64)'), 'P1: ' + t + ' gets a nullable program_id, idempotently');
}
const fkCount = (programDdl.match(/FOREIGN KEY \(tenant_id, program_id\) REFERENCES programs \(tenant_id, id\)/g) || []).length;
assert(fkCount === FK_TABLES.length, 'P1: five composite (tenant_id, program_id) foreign keys', fkCount);
for (const t of FK_TABLES) {
  assert(programDdl.includes('ALTER TABLE ' + t + ' ADD CONSTRAINT fk_' + t + '_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id)'), 'P1: ' + t + ' has the composite program foreign key');
}
assert(!programDdl.includes('fk_control_assessment_events_program') && !programDdl.includes('ALTER TABLE control_assessment_events ADD CONSTRAINT fk_'), 'P1: control_assessment_events has no foreign key (the history outlives the program)');
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
const requiredAdds = programDdl.split('_program_required CHECK (program_id IS NOT NULL) NOT VALID;').length - 1;
const guards = (programDdl.match(/conname = /g) || []).length;
assert(fkAdds === FK_TABLES.length && fkAdds + requiredAdds === guards, 'P1: every foreign key and every program_required check is added once, behind a pg_constraint guard (' + fkAdds + ' keys + ' + requiredAdds + ' checks, ' + guards + ' guards)');
assert(
  TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_assessment_events_program ON control_assessment_events (tenant_id, program_id, control_id, created_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_evidence_metadata_program ON evidence_metadata (tenant_id, program_id, uploaded_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_ssp_import_jobs_program ON ssp_import_jobs (tenant_id, program_id, created_at DESC);') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_vm_poam_items_program ON vm_poam_items (tenant_id, program_id, status);'),
  'P1: the four program indexes exist'
);
assert(TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_control_assessments_program_control ON control_assessments (tenant_id, program_id, control_id);'), 'P1: the per-program control key is added');
assert(!programDdl.includes('SET NOT NULL'), 'P1: the program DDL never runs SET NOT NULL; buildProgramIdNotNullSql does, after VALIDATE (a bare SET NOT NULL scans every row, whatever the row policies say)');
assert(!rls.includes('program_isolation') && (rls.match(/WITH CHECK/g) || []).length === RLS_TENANT_TABLES.length, 'P1: buildRlsSql() holds only the tenant policies (the program policies are buildProgramRlsSql())');

console.log('\n--- Programs: database-enforced isolation (P5) ---');
const programRls = buildProgramRlsSql();
const OBJECTIVE_TABLES = ['control_objectives', 'control_objective_events'];
assert(JSON.stringify(RLS_PROGRAM_TABLES) === JSON.stringify([...PROGRAM_SCOPED, ...OBJECTIVE_TABLES, 'program_events', 'program_assets', 'program_ssp_metadata', 'vm_poam_item_events', 'program_ssp_profile', 'program_ssp_section_reviews', 'control_poam_entries', 'control_poam_events', 'program_tools', 'program_tool_controls', 'program_data_inventory', 'program_cui_categories', 'program_cui_category_tools', 'program_vendor_documents', 'program_inventory_events', 'program_governance_documents', 'program_document_controls', 'program_document_attachments', 'program_document_expectations']), 'P5: RLS_PROGRAM_TABLES is the six program-scoped tables plus the two objective tables, program_events, program_assets, program_ssp_metadata, vm_poam_item_events, program_ssp_profile, program_ssp_section_reviews, control_poam_entries, control_poam_events, the seven inventory program tables (program_tools, program_tool_controls, program_data_inventory, program_cui_categories, program_cui_category_tools, program_vendor_documents, program_inventory_events) and the four document register program tables (program_governance_documents, program_document_controls, program_document_attachments, program_document_expectations)', RLS_PROGRAM_TABLES);
assert(RLS_PROGRAM_TABLES.every((t) => RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id')), 'P5: every program table is also a tenant table (the program policy only narrows the tenant policy)');
assert(schema.includes(programRls) && schema.indexOf(programRls) > schema.indexOf(rls), 'P5: buildSchemaSql() runs the program policies after the tenant policies');
assert(
  (schema.match(/WITH CHECK/g) || []).length === RLS_TENANT_TABLES.length + RLS_PROGRAM_TABLES.length,
  'P5: every tenant and every program policy has a WITH CHECK (' + (schema.match(/WITH CHECK/g) || []).length + ' of ' + (RLS_TENANT_TABLES.length + RLS_PROGRAM_TABLES.length) + ')'
);
assert((programRls.match(/WITH CHECK/g) || []).length === RLS_PROGRAM_TABLES.length && (programRls.match(/CREATE POLICY/g) || []).length === RLS_PROGRAM_TABLES.length, 'P5: one policy with a WITH CHECK per program table');
for (const t of RLS_PROGRAM_TABLES) {
  const name = rlsProgramPolicyName(t);
  const start = programRls.indexOf('CREATE POLICY ' + name + ' ON ' + t);
  const block = start < 0 ? '' : programRls.slice(start, programRls.indexOf('END IF;', start));
  assert(name === 'rls_' + t + '_program_isolation' && start >= 0, 'P5: ' + t + ': CREATE POLICY ' + name);
  assert(block.includes('AS RESTRICTIVE') && block.includes('FOR ALL') && block.indexOf('AS RESTRICTIVE') < block.indexOf('FOR ALL'), 'P5: ' + t + ': the policy is RESTRICTIVE and FOR ALL (AND-ed with the tenant policy)');
  assert(programRls.includes("policyname = '" + name + "'"), 'P5: ' + t + ': the policy is created once (pg_policies guard)');
  const usingAt = block.indexOf('USING (');
  const checkAt = block.indexOf('WITH CHECK (');
  const using = usingAt < 0 || checkAt < usingAt ? '' : block.slice(usingAt + 'USING ('.length, checkAt);
  const withCheck = checkAt < 0 ? '' : block.slice(checkAt + 'WITH CHECK ('.length, block.lastIndexOf(');'));
  assert(using.includes("COALESCE(program_id, (SELECT p.id FROM programs p WHERE p.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '') AND p.is_default))") && using.includes("= NULLIF(current_setting('app.current_program_id', true), '')"), 'P5: ' + t + ': USING maps a row with no program to the tenant default program, then compares with the session program', using);
  assert(withCheck === "program_id = NULLIF(current_setting('app.current_program_id', true), '')" && !/COALESCE/.test(withCheck), 'P5: ' + t + ': WITH CHECK has no COALESCE (a written row must carry exactly the session program)', withCheck);
}
assert(!rls.includes('RESTRICTIVE') && DISCOVERY_POLICIES.every((p) => !p.using.includes('current_program_id')), 'P5: no tenant or discovery policy is restrictive or keys on the program');
assert(!programRls.includes('ON programs') && !programRls.includes('rls_programs_program_isolation'), 'P5: programs itself has no program policy (only the tenant policy)');
const uniqueNew = TABLES_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS unq_control_assessments_program_control ON control_assessments (tenant_id, program_id, control_id);');
const dropOld = TABLES_SQL.indexOf('ALTER TABLE control_assessments DROP CONSTRAINT IF EXISTS unq_tenant_control;');
assert(uniqueNew > 0 && dropOld > uniqueNew, 'P5: DROP CONSTRAINT IF EXISTS unq_tenant_control comes after the per-program unique index exists');
for (const t of PROGRAM_SCOPED) {
  const c = t + '_program_required';
  const guard = "conname = '" + c + "' AND conrelid = '" + t + "'::regclass";
  assert(programDdl.includes(guard) && programDdl.includes('ALTER TABLE ' + t + ' ADD CONSTRAINT ' + c + ' CHECK (program_id IS NOT NULL) NOT VALID;'), 'P5: ' + t + ': program_id IS NOT NULL check, NOT VALID, added once');
}
assert((programDdl.match(/NOT VALID/g) || []).length === PROGRAM_SCOPED.length, 'P5: exactly the six NOT VALID checks');

console.log('\n--- Finalizing program_id (issue #24) ---');
const fin = buildProgramIdNotNullSql();
assert(schema.includes(fin) && schema.indexOf(fin) > schema.indexOf(programRls), 'N1: buildSchemaSql() finalizes program_id after the program policies');
assert(JSON.stringify(PROGRAM_BACKFILL_TABLES) === JSON.stringify(PROGRAM_SCOPED), 'N2: PROGRAM_BACKFILL_TABLES is the six program-scoped legacy tables');
for (const t of PROGRAM_SCOPED) {
  const c = t + '_program_required';
  const v = fin.indexOf('ALTER TABLE ' + t + ' VALIDATE CONSTRAINT ' + c + ';');
  const n = fin.indexOf('ALTER TABLE ' + t + ' ALTER COLUMN program_id SET NOT NULL;');
  const d = fin.indexOf('ALTER TABLE ' + t + ' DROP CONSTRAINT ' + c + ';');
  assert(fin.includes("conname = '" + c + "' AND conrelid = '" + t + "'::regclass") && 0 <= v && v < n && n < d, 'N3: ' + t + ': VALIDATE, then SET NOT NULL, then drop the check, behind the constraint guard', [v, n, d]);
}
assert((fin.match(/EXCEPTION WHEN check_violation THEN/g) || []).length === PROGRAM_SCOPED.length && !/WHEN OTHERS/.test(fin), 'N4: only a row without a program (check_violation) is tolerated per table; any other error still fails the boot');
assert(!fin.includes('control_objective') && !fin.includes('NOT VALID'), 'N5: the objective tables are not touched and nothing is added unvalidated');
for (const t of PROGRAM_SCOPED) {
  assert(programDdl.includes("AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '" + t + "'::regclass AND attname = 'program_id' AND attnotnull)"), 'N6: ' + t + ': a finalized table never gets its NOT VALID check back');
}
const cnt = buildLegacyProgramRowCountSql();
assert((cnt.match(/WHERE program_id IS NULL GROUP BY tenant_id/g) || []).length === 6 && !/implementation_notes|file_name|description|narrative/.test(cnt), 'N7: the legacy row count selects counts per table and tenant only, never row content');

console.log('\n--- Assessment objectives (control_objectives, control_objective_events) ---');
const objTable = (name: string): string => {
  const start = objectivesDdl.indexOf('CREATE TABLE IF NOT EXISTS ' + name + ' (');
  return start < 0 ? '' : objectivesDdl.slice(start, objectivesDdl.indexOf('\n  );', start));
};
const objectivesTable = objTable('control_objectives');
const objectiveEvents = objTable('control_objective_events');
assert(objectivesTable !== '' && objectiveEvents !== '', 'OBJ: both tables are created (IF NOT EXISTS), after the program DDL');
assert(objectivesAt > programsAt && objectivesDdl.indexOf('CREATE TABLE IF NOT EXISTS control_objectives (') >= 0, 'OBJ: the objectives DDL follows the program DDL');
assert(objectivesTable.includes('CONSTRAINT unq_control_objectives_program_objective UNIQUE (tenant_id, program_id, objective_id)'), 'OBJ: one row per (tenant_id, program_id, objective_id)');
assert(
  objectivesTable.includes('CONSTRAINT fk_control_objectives_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE'),
  'OBJ: the inline composite program key cascades (deleting a program removes its objectives)'
);
assert((objectivesDdl.match(/FOREIGN KEY/g) || []).length === 1 && !/FOREIGN KEY|REFERENCES/.test(objectiveEvents), 'OBJ: the events table has no foreign key (the history outlives the row and the program)');
assert(/program_id VARCHAR\(64\) NOT NULL/.test(objectivesTable) && /program_id VARCHAR\(64\) NOT NULL/.test(objectiveEvents), 'OBJ: program_id is NOT NULL on both tables (no legacy rows)');
assert(
  objectiveEvents.includes("CONSTRAINT control_objective_events_sha_check CHECK ((old_narrative_sha256 IS NULL OR old_narrative_sha256 ~ '^[0-9a-f]{64}$') AND new_narrative_sha256 ~ '^[0-9a-f]{64}$')") &&
    objectiveEvents.includes('CONSTRAINT control_objective_events_length_check CHECK ((old_narrative_length IS NULL OR old_narrative_length >= 0) AND new_narrative_length >= 0)'),
  'OBJ: an event carries a SHA-256 and a length of the narrative, validated by CHECKs'
);
assert(!/^\s+narrative\s/m.test(objectiveEvents) && /^\s+narrative TEXT/m.test(objectivesTable), 'OBJ: the events table has no narrative text column');
assert(
  objectivesDdl.includes("ALTER TABLE control_objectives ADD CONSTRAINT control_objectives_status_check CHECK (status IN ('MET', 'NOT_MET', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_APPLICABLE'))") &&
    objectivesDdl.indexOf('DROP CONSTRAINT IF EXISTS control_objectives_status_check') < objectivesDdl.indexOf('ADD CONSTRAINT control_objectives_status_check'),
  'OBJ: the status CHECK is dropped and re-added (the five assessment statuses)'
);
assert(objectivesDdl.includes("ADD CONSTRAINT control_objective_events_source_check CHECK (source IN ('human', 'browser-import', 'clone', 'catalog-update'))"), 'OBJ: the event source CHECK lists human, browser-import, clone and catalog-update');
assert(
  objectivesTable.includes('objective_catalog_rev') === false &&
    objectivesDdl.includes('ALTER TABLE control_objectives ADD COLUMN IF NOT EXISTS objective_catalog_rev VARCHAR(32);') &&
    objectivesDdl.indexOf('ADD COLUMN IF NOT EXISTS objective_catalog_rev VARCHAR(32);') > objectivesDdl.indexOf('CREATE TABLE IF NOT EXISTS control_objectives ('),
  'OBJ: objective_catalog_rev is added idempotently (ADD COLUMN IF NOT EXISTS, nullable: NULL means written before the current catalog) after the table is created'
);
assert(
  objectivesDdl.includes('CREATE INDEX IF NOT EXISTS idx_control_objectives_control ON control_objectives (tenant_id, program_id, control_id);') &&
    objectivesDdl.includes('CREATE INDEX IF NOT EXISTS idx_control_objective_events_objective ON control_objective_events (tenant_id, program_id, objective_id, created_at DESC);'),
  'OBJ: the two indexes exist'
);
assert(OBJECTIVE_TABLES.every((t) => RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id')), 'OBJ: both tables are in RLS_TENANT_TABLES on tenant_id');
assert(!objectivesDdl.includes('NOT VALID') && !objectivesDdl.includes('SET NOT NULL'), 'OBJ: no NOT VALID check and no SET NOT NULL (the new tables need neither)');

console.log('\n--- Boundary asset membership (program_assets, issue #26) ---');
const paAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_assets (');
const paBlock = paAt < 0 ? '' : TABLES_SQL.slice(paAt, TABLES_SQL.indexOf('\n  );', paAt));
assert(paAt > peAt && peAt > 0 && membershipAt > peAt && membershipAt < paAt, 'PA1: program_assets is created after program_events, under its own heading');
assert(
  paBlock.includes('CONSTRAINT pk_program_assets PRIMARY KEY (tenant_id, program_id, asset_id)') &&
    paBlock.includes('CONSTRAINT fk_program_assets_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
    paBlock.includes('CONSTRAINT fk_program_assets_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE') &&
    /program_id VARCHAR\(64\) NOT NULL/.test(paBlock),
  'PA2: composite primary key, both composite foreign keys cascade, program_id is NOT NULL'
);
assert(paBlock !== '' && !/asset_name|host_name|ip_address|mac_address|description|notes/.test(paBlock), 'PA3: program_assets holds ids only (no name, address, description or notes column)');
assert(
  RLS_TENANT_TABLES.some((r) => r.table === 'program_assets' && r.tenantColumn === 'tenant_id') &&
    (RLS_PROGRAM_TABLES as readonly string[]).includes('program_assets') &&
    !PROGRAM_BACKFILL_TABLES.includes('program_assets' as never),
  'PA4: program_assets is a tenant table, a program table, and is not backfilled'
);
assert(TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_program_assets_asset ON program_assets (tenant_id, asset_id);'), 'PA5: program_assets is indexed by asset');
const afterMembership = membershipAt < 0 ? '' : TABLES_SQL.slice(membershipAt);
assert(afterMembership !== '' && !afterMembership.includes('NOT VALID') && !afterMembership.includes('SET NOT NULL'), 'PA6: no NOT VALID check and no SET NOT NULL after the membership heading');

console.log('\n--- Password history (#162) ---');
const phAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_user_password_history (');
const phBlock = phAt < 0 ? '' : TABLES_SQL.slice(phAt, TABLES_SQL.indexOf('\n  );', phAt));
assert(phAt > paAt && paAt > 0, 'PH1: local_user_password_history is created after program_assets, outside the local_users block');
assert(
  phBlock.includes('user_id VARCHAR(64) NOT NULL') &&
    phBlock.includes('password_hash VARCHAR(100) NOT NULL') &&
    phBlock.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()') &&
    phBlock.includes('CONSTRAINT fk_local_user_password_history_user FOREIGN KEY (user_id) REFERENCES local_users (id) ON DELETE CASCADE') &&
    phBlock.includes("CONSTRAINT local_user_password_history_hash_check CHECK (password_hash ~ '^[$]2[aby][$][0-9]{2}[$]')"),
  'PH2: the history table has a bcrypt-shaped hash check, a cascading FK to local_users and a created_at default'
);
assert(phBlock !== '' && !/\btenant_id\b/.test(phBlock) && !/\bpassword\s+(VARCHAR|TEXT)/i.test(phBlock), 'PH3: global identity data (no tenant_id) and no plaintext password column');
assert(
  !RLS_TENANT_TABLES.some((r) => r.table === 'local_user_password_history') &&
    !(RLS_PROGRAM_TABLES as readonly string[]).includes('local_user_password_history') &&
    !buildRlsSql().includes('local_user_password_history'),
  'PH4: the history table is in no row-security list and has no policy (like local_users)'
);
assert(TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_local_user_password_history_user ON local_user_password_history (user_id, id DESC);'), 'PH5: the history table is indexed by user, newest first');

console.log('\n--- Sessions and account events (#163, #40) ---');
const lsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_sessions (');
const lsBlock = lsAt < 0 ? '' : TABLES_SQL.slice(lsAt, TABLES_SQL.indexOf('\n  );', lsAt));
const aeAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_account_events (');
const aeBlock = aeAt < 0 ? '' : TABLES_SQL.slice(aeAt, TABLES_SQL.indexOf('\n  );', aeAt));
assert(lsAt > phAt && phAt > 0 && aeAt > phAt, 'LS1: local_sessions and local_account_events are created after local_user_password_history');
assert(
  lsBlock.includes('CONSTRAINT fk_local_sessions_user FOREIGN KEY (user_id) REFERENCES local_users (id) ON DELETE CASCADE') &&
    lsBlock.includes("CONSTRAINT local_sessions_sid_check CHECK (sid ~ '^[A-Za-z0-9_-]{16,64}$')") &&
    lsBlock.includes("CONSTRAINT local_sessions_reason_check CHECK (revoke_reason IS NULL OR revoke_reason IN ('signed_out', 'idle', 'mfa_required', 'admin'))"),
  'LS2: the sessions table cascades with the account and checks the sid shape and the revoke reason'
);
const sessionTables = ['local_sessions', 'local_account_events'];
assert(
  lsBlock !== '' && aeBlock !== '' && !/\btenant_id\b/.test(lsBlock) && !/\btenant_id\b/.test(aeBlock) &&
    sessionTables.every(
      (t) => !RLS_TENANT_TABLES.some((r) => r.table === t) && !(RLS_PROGRAM_TABLES as readonly string[]).includes(t) && !buildRlsSql().includes(t)
    ),
  'LS3: neither table has a tenant_id column, is in a row-security list or has a policy (global identity data)'
);
assert(
  aeBlock.includes("position('@' in details::text) = 0") && aeBlock.includes('CONSTRAINT local_account_events_action_check CHECK (action IN ('),
  'AE1: account event details cannot hold an "@" and the action is a closed list'
);
assert(
  TABLES_SQL.includes('local_account_events_guard') && TABLES_SQL.includes('BEFORE UPDATE OR DELETE ON local_account_events') && TABLES_SQL.includes('BEFORE TRUNCATE ON local_account_events'),
  'AE2: the account event table is guarded against UPDATE, DELETE and TRUNCATE'
);
assert(!/\b(email|name|password|token)\s+(VARCHAR|TEXT)/i.test(lsBlock) && !/\b(email|name|password|token)\s+(VARCHAR|TEXT)/i.test(aeBlock), 'AE3: neither table has an email, name, password or token column');
const suAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_system_use_notice (');
const suBlock = suAt < 0 ? '' : TABLES_SQL.slice(suAt, TABLES_SQL.indexOf('\n  );', suAt));
assert(
  suBlock.includes('CONSTRAINT platform_system_use_notice_singleton CHECK (id = 1)') && suBlock.includes('CONSTRAINT platform_system_use_notice_text_check CHECK (char_length(notice_text) BETWEEN 1 AND 4000)') &&
    !/\btenant_id\b/.test(suBlock) && !RLS_TENANT_TABLES.some((r) => r.table === 'platform_system_use_notice') &&
    !(RLS_PROGRAM_TABLES as readonly string[]).includes('platform_system_use_notice') && !buildRlsSql().includes('platform_system_use_notice'),
  'AE4: platform_system_use_notice is one global row (id pinned to 1), text 1 to 4000 characters, no tenant_id, no row security'
);
const listOf = (sql: string): string[] => (sql.match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1));
const inlineList = /CONSTRAINT local_account_events_action_check CHECK \(action IN \(([^)]*)\)\)/.exec(aeBlock)?.[1] ?? '';
const addMatch = /ADD CONSTRAINT local_account_events_action_check CHECK \(action IN \(([^)]*)\)\);/.exec(TABLES_SQL);
const dropAt = TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS local_account_events_action_check;');
assert(
  JSON.stringify(listOf(inlineList)) === JSON.stringify([...ACCOUNT_EVENT_ACTIONS]) && !!addMatch && JSON.stringify(listOf(addMatch[1])) === JSON.stringify([...ACCOUNT_EVENT_ACTIONS]) &&
    dropAt > 0 && dropAt < (addMatch?.index ?? -1) && TABLES_SQL.slice(0, dropAt).includes("LIKE '%announcement_withdrawn%'"),
  'AE5: the new-install and the migrated action lists both equal ACCOUNT_EVENT_ACTIONS; the old check is dropped before the new one is added, only while it lacks the newest action',
  [listOf(inlineList).length, addMatch ? listOf(addMatch[1]).length : null, ACCOUNT_EVENT_ACTIONS.length]
);
const eaAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS enclave_assets (');
const eaBlock = eaAt < 0 ? '' : TABLES_SQL.slice(eaAt, TABLES_SQL.indexOf('\n  );', eaAt));
const noForceAt = TABLES_SQL.indexOf('ALTER TABLE enclave_assets NO FORCE ROW LEVEL SECURITY', eaAt);
const nullAt = TABLES_SQL.indexOf('UPDATE enclave_assets SET compliance_score = NULL, last_scanned_at = NULL', eaAt);
const forceAt = TABLES_SQL.indexOf('ALTER TABLE enclave_assets FORCE ROW LEVEL SECURITY', eaAt);
const retiredGate = TABLES_SQL.slice(eaAt, forceAt);
assert(
  eaAt >= 0 && noForceAt > eaAt && nullAt > noForceAt && forceAt > nullAt && retiredGate.includes('col_description(') && retiredGate.includes("'Retired (#216): not written or shown'") &&
    eaBlock.includes('last_scanned_at TIMESTAMPTZ') && eaBlock.includes('compliance_score INTEGER'),
  'AS216: the retired scan columns stay in the table; a gated startup fix lifts FORCE RLS, nulls them and restores FORCE, in that order',
  [eaAt, noForceAt, nullAt, forceAt]
);

console.log('\n--- Membership profile columns (#258, #259) ---');
const tuCreateAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS tenant_users (');
const tuLines = [
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS access_expires_on DATE;',
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS affiliation VARCHAR(16);',
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS us_person VARCHAR(16);',
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS us_person_recorded_by VARCHAR(128);',
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS us_person_recorded_at TIMESTAMPTZ;',
  'ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE;',
  "ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_affiliation_check CHECK (affiliation IS NULL OR affiliation IN ('EMPLOYEE', 'CONTRACTOR', 'ESP'));",
  "ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_us_person_check CHECK (us_person IS NULL OR us_person IN ('US_PERSON', 'OTHER'));",
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_users_primary_contact ON tenant_users (tenant_id) WHERE is_primary_contact;',
];
assert(tuCreateAt >= 0 && tuLines.every((l) => TABLES_SQL.indexOf(l) > tuCreateAt), 'TU1: every membership profile column, check and the one-primary-contact index is in TABLES_SQL after the tenant_users table', tuLines.filter((l) => TABLES_SQL.indexOf(l) <= tuCreateAt));
assert(
  ['affiliation_check', 'us_person_check'].every((c) => {
    const d = TABLES_SQL.indexOf(`ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_${c};`);
    return d > tuCreateAt && d < TABLES_SQL.indexOf(`ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_${c}`);
  }),
  'TU2: each check is dropped before it is added, so the startup is repeatable'
);
assert(RLS_TENANT_TABLES.some((r) => r.table === 'tenant_users') && !TABLES_SQL.slice(tuCreateAt, TABLES_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_users_primary_contact')).includes('DROP COLUMN'), 'TU3: tenant_users stays under row security and nothing drops a column');

console.log('\n--- Platform announcements and notice reads (#260) ---');
const annAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS platform_announcements (');
const annBlock = annAt < 0 ? '' : TABLES_SQL.slice(annAt, TABLES_SQL.indexOf('\n  );', annAt));
const readsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS user_notice_reads (');
const readsBlock = readsAt < 0 ? '' : TABLES_SQL.slice(readsAt, TABLES_SQL.indexOf('\n  );', readsAt));
const luCreateAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS local_users (');
assert(
  annAt > 0 && readsAt > 0 && !/\btenant_id\b/.test(annBlock) && !/\btenant_id\b/.test(readsBlock) &&
    ['platform_announcements', 'user_notice_reads'].every((t) => !RLS_TENANT_TABLES.some((r) => r.table === t) && !(RLS_PROGRAM_TABLES as readonly string[]).includes(t) && !buildRlsSql().includes(t)),
  'AN1: both tables are global: no tenant_id, not in the tenant or program row security lists, not in buildRlsSql()'
);
assert(
  annBlock.includes('CONSTRAINT platform_announcements_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 120)') &&
    annBlock.includes('CONSTRAINT platform_announcements_body_check CHECK (char_length(body) BETWEEN 1 AND 2000)') &&
    annBlock.includes("CONSTRAINT platform_announcements_severity_check CHECK (severity IN ('info', 'warning'))") &&
    annBlock.includes('CONSTRAINT platform_announcements_window_check CHECK (expires_at IS NULL OR expires_at > created_at)') &&
    annBlock.includes('CONSTRAINT platform_announcements_withdrawn_check CHECK ((withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL))') &&
    TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_platform_announcements_active ON platform_announcements (created_at DESC) WHERE withdrawn_at IS NULL;'),
  'AN2: announcement title 1 to 120 and body 1 to 2000 characters, severity info or warning, an expiry after creation, withdrawn time and actor set together'
);
assert(
  readsAt > luCreateAt && luCreateAt > 0 && readsBlock.includes('CONSTRAINT pk_user_notice_reads PRIMARY KEY (user_id, kind, ref)') &&
    readsBlock.includes('FOREIGN KEY (user_id) REFERENCES local_users (id) ON DELETE CASCADE') &&
    readsBlock.includes("CHECK (kind IN ('release', 'announcement'))") && readsBlock.includes("CHECK (ref ~ '^[A-Za-z0-9._-]{1,64}$')"),
  'AN3: notice reads are keyed by user, kind and ref, follow the account (cascade), accept two kinds and a plain reference, and come after local_users'
);

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

console.log('\n--- Database role check, health probe ---');
const superRole = assessDatabaseRole({ rolsuper: true, rolbypassrls: false });
const bypassRole = assessDatabaseRole({ rolsuper: false, rolbypassrls: true });
assert(!superRole.ok && Boolean(superRole.message?.includes('SUPERUSER')), 'a SUPERUSER role is not ok and the message names SUPERUSER', superRole);
assert(!bypassRole.ok && Boolean(bypassRole.message?.includes('BYPASSRLS')), 'a BYPASSRLS role is not ok and the message names BYPASSRLS', bypassRole);
assert(assessDatabaseRole({ rolsuper: false, rolbypassrls: false }).ok, 'an ordinary role is ok');
assert(assessDatabaseRole(undefined).ok && assessDatabaseRole(undefined).message === null, 'a missing row is ok (cannot tell), no message');
const dbSrc = fs.readFileSync('server/db.ts', 'utf8').replace(/\r\n/g, '\n');
console.log('\n--- SSP metadata (program_ssp_metadata, issue #84) ---');
const smHeadingAt = TABLES_SQL.indexOf('-- SSP metadata (issue #84)');
const smAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_ssp_metadata (');
const smBlock = smAt < 0 ? '' : TABLES_SQL.slice(smAt, TABLES_SQL.indexOf('\n  );', smAt));
assert(smHeadingAt > aeAt && aeAt > 0 && smAt > smHeadingAt, 'SM-D1: program_ssp_metadata is created after local_account_events, under its own heading');
assert(
  smBlock.includes('CONSTRAINT pk_program_ssp_metadata PRIMARY KEY (tenant_id, program_id)') &&
    smBlock.includes('CONSTRAINT fk_program_ssp_metadata_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
    smBlock.includes('program_id VARCHAR(64) NOT NULL') &&
    smBlock.includes('tenant_id VARCHAR(64) NOT NULL'),
  'SM-D2: one row per program (primary key), cascading with the program, NOT NULL tenant and program'
);
assert(
  RLS_TENANT_TABLES.some((r) => r.table === 'program_ssp_metadata' && r.tenantColumn === 'tenant_id') &&
    (RLS_PROGRAM_TABLES as readonly string[]).includes('program_ssp_metadata') &&
    !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes('program_ssp_metadata'),
  'SM-D3: a tenant table and a program table, not backfilled'
);
const smShapeAt = TABLES_SQL.indexOf('ADD CONSTRAINT program_ssp_metadata_shape_check');
const smShape = smShapeAt < 0 ? '' : TABLES_SQL.slice(smShapeAt, TABLES_SQL.indexOf('\n', smShapeAt));
assert(
  smShape !== '' &&
    SSP_METADATA_FIELDS.every((k) => smShape.includes("'" + k + "'")) &&
    smShape.includes('262144') &&
    smShape.includes('@.type() != "string"') &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS program_ssp_metadata_shape_check') < smShapeAt &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS program_ssp_metadata_shape_check') > smAt,
  'SM-D4: the shape CHECK lists every field, string values only, 262144 bytes, dropped before it is added'
);
const spAt = TABLES_SQL.indexOf('ADD CONSTRAINT tenants_stack_profile_check');
const spLine = spAt < 0 ? '' : TABLES_SQL.slice(spAt, TABLES_SQL.indexOf('\n', spAt));
assert(
  TABLES_SQL.includes('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stack_profile JSONB;') &&
    spLine.includes("'identityProvider', 'edrSolution', 'infrastructure', 'mdmSolution', 'siemSolution', 'odpParams'") &&
    spLine.includes("'odpParams', 'customLabels'") &&
    spLine.includes('<= 16384') &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS tenants_stack_profile_check') > 0 &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS tenants_stack_profile_check') < spAt,
  'SM-D5: tenants.stack_profile is a JSONB column with a key and size CHECK, dropped before it is added'
);
const pLineAt = TABLES_SQL.indexOf('ALTER TABLE programs ADD CONSTRAINT programs_stack_profile_check');
const pLine = pLineAt < 0 ? '' : TABLES_SQL.slice(pLineAt, TABLES_SQL.indexOf('\n', pLineAt));
const tLine = spAt < 0 ? '' : 'ALTER TABLE tenants ' + spLine;
assert(
  TABLES_SQL.includes('ALTER TABLE programs ADD COLUMN IF NOT EXISTS stack_profile JSONB;') && !programsBlock.includes('stack_profile') &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS programs_stack_profile_check') > 0 &&
    TABLES_SQL.indexOf('DROP CONSTRAINT IF EXISTS programs_stack_profile_check') < pLineAt &&
    pLine !== '' && pLine.trimEnd() === tLine.trimEnd().replace('ALTER TABLE tenants', 'ALTER TABLE programs').replace('tenants_stack_profile_check', 'programs_stack_profile_check'),
  'SM-D7: programs.stack_profile (issue #230) is a JSONB column added after the CREATE TABLE, with the tenant CHECK (same keys and byte limit), dropped before it is added'
);
const afterSm = smHeadingAt < 0 ? '' : TABLES_SQL.slice(smHeadingAt);
assert(afterSm !== '' && !afterSm.includes('NOT VALID') && !afterSm.includes('SET NOT NULL'), 'SM-D6: no NOT VALID check and no SET NOT NULL after the SSP metadata heading');
assert(!TABLES_SQL.includes('SET stack_profile'), 'SM-D8: no boot-time UPDATE of stack_profile (tenants and programs are FORCE RLS, so it would see no rows)');

console.log('\n--- SSP profile and section reviews (program_ssp_profile, program_ssp_section_reviews, issues #238 #241 #242 #246) ---');
const sprAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_ssp_profile (');
const sprBlock = sprAt < 0 ? '' : TABLES_SQL.slice(sprAt, TABLES_SQL.indexOf('\n  );', sprAt));
assert(
  sprAt > smAt &&
    sprBlock.includes('CONSTRAINT pk_program_ssp_profile PRIMARY KEY (tenant_id, program_id)') &&
    sprBlock.includes('CONSTRAINT fk_program_ssp_profile_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
    sprBlock.includes('tenant_id VARCHAR(64) NOT NULL') &&
    sprBlock.includes('program_id VARCHAR(64) NOT NULL') &&
    sprBlock.includes("jsonb_typeof(profile) = 'object'") &&
    sprBlock.includes('262144') &&
    !TABLES_SQL.includes('DROP CONSTRAINT IF EXISTS program_ssp_profile'),
  'SP-D1: program_ssp_profile has the primary key, the cascading foreign key, NOT NULL tenant and program, an object and size CHECK, and no constraint is dropped and re-added'
);
const srAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_ssp_section_reviews (');
const srBlock = srAt < 0 ? '' : TABLES_SQL.slice(srAt, TABLES_SQL.indexOf('\n  );', srAt));
const srGuardAt = TABLES_SQL.indexOf('CREATE OR REPLACE FUNCTION program_ssp_section_reviews_guard()');
const srTail = srAt < 0 ? '' : TABLES_SQL.slice(srAt);
const srTrig = (name: string) => {
  const drop = srTail.indexOf(`DROP TRIGGER IF EXISTS ${name} ON program_ssp_section_reviews;`);
  const create = srTail.indexOf(`CREATE TRIGGER ${name} BEFORE `);
  return drop >= 0 && create > drop;
};
assert(
  sprAt > 0 && srAt > sprAt &&
    srBlock.includes('CONSTRAINT fk_program_ssp_section_reviews_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
    srBlock.includes("CHECK (action IN ('signed_off', 'withdrawn'))") &&
    srBlock.includes("content_sha256 ~ '^[0-9a-f]{64}$'") &&
    srBlock.includes("section_id ~ '^[a-z][a-z0-9_]{0,31}$'") &&
    srBlock.includes('reviewer_user_id VARCHAR(128) NOT NULL') &&
    srBlock.includes('reviewer_name VARCHAR(255) NOT NULL') &&
    srBlock.includes('program_id VARCHAR(64) NOT NULL'),
  'SR-D1: program_ssp_section_reviews has the cascading foreign key, the action, sha and section CHECKs and a NOT NULL reviewer'
);
assert(
  srGuardAt > srAt &&
    srTail.includes('RAISE EXCEPTION') && srTail.includes('append-only') && srTail.includes("ERRCODE = '42501'") &&
    srTrig('trg_program_ssp_section_reviews_guard') && srTrig('trg_program_ssp_section_reviews_no_truncate') &&
    srTail.includes('BEFORE UPDATE ON program_ssp_section_reviews') && srTail.includes('BEFORE TRUNCATE ON program_ssp_section_reviews') &&
    !srTail.includes('BEFORE DELETE ON program_ssp_section_reviews'),
  'SR-D1b: the append-only guard function and the update and truncate triggers exist, each dropped before it is created; DELETE stays allowed (program cascade)'
);
for (const t of ['program_ssp_profile', 'program_ssp_section_reviews']) {
  assert(
    RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id') &&
      (RLS_PROGRAM_TABLES as readonly string[]).includes(t) &&
      !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes(t),
    `SR-D2: ${t} is a tenant table and a program table, not backfilled`
  );
}
console.log('\n--- control POA&M entries, milestones and stable item numbers (#304, #305) ---');
{
  const entAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS control_poam_entries (');
  const entBlock = entAt < 0 ? '' : TABLES_SQL.slice(entAt, TABLES_SQL.indexOf('\n  );', entAt));
  assert(
    entBlock.includes('CONSTRAINT pk_control_poam_entries PRIMARY KEY (tenant_id, program_id, control_id)') &&
      entBlock.includes('CONSTRAINT fk_control_poam_entries_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE') &&
      entBlock.includes('tenant_id VARCHAR(64) NOT NULL') && entBlock.includes('program_id VARCHAR(64) NOT NULL') && entBlock.includes('control_id VARCHAR(64) NOT NULL') &&
      entBlock.includes("milestones JSONB NOT NULL DEFAULT '[]'::jsonb"),
    'CP-D1: control_poam_entries is keyed by tenant, program and control id, cascades with the program, and holds a JSON milestone list'
  );
  assert(
    entBlock.includes('length(owner) <= 255') && entBlock.includes('length(required_resources) <= 2000') && entBlock.includes('length(plan) <= 4000') &&
      entBlock.includes("BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'") &&
      entBlock.includes("jsonb_typeof(milestones) = 'array' AND jsonb_array_length(milestones) <= 20 AND octet_length(milestones::text) <= 65536"),
    'CP-D2: control_poam_entries CHECKs: owner 255, resources 2000, plan 4000 characters, the date bounds, at most 20 milestones and 64 KB'
  );
  const evAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS control_poam_events (');
  const evBlock = evAt < 0 ? '' : TABLES_SQL.slice(evAt, TABLES_SQL.indexOf('\n  );', evAt));
  assert(
    evBlock !== '' && !/FOREIGN KEY|REFERENCES/.test(evBlock) && evBlock.includes('program_id VARCHAR(64) NOT NULL') &&
      !/\b(owner|plan|required_resources|description|milestones) (TEXT|VARCHAR|JSONB)/.test(evBlock) &&
      /new_owner_sha256/.test(evBlock) && /new_resources_length/.test(evBlock) && /new_plan_sha256/.test(evBlock) && /new_milestones_sha256/.test(evBlock) && /new_milestone_count/.test(evBlock) &&
      evBlock.includes('control_poam_events_sha_check'),
    'CP-D3: control_poam_events has no foreign key, a NOT NULL program and no text column: flags, lengths, counts and SHA-256 digests only'
  );
  assert(TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_control_poam_events_control ON control_poam_events (tenant_id, program_id, control_id, created_at DESC);'), 'CP-D4: the history is indexed by control and time');
  for (const t of ['control_poam_entries', 'control_poam_events']) {
    assert(
      RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id') &&
        (RLS_PROGRAM_TABLES as readonly string[]).includes(t) &&
        !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes(t) &&
        buildRlsSql().includes(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`) && buildProgramRlsSql().includes(rlsProgramPolicyName(t)),
      `CP-D5: ${t} is a tenant table and a program table (FORCE row security, tenant and program policies), not backfilled`
    );
  }
  assert(RLS_PROGRAM_TABLES[RLS_PROGRAM_TABLES.length - 13] === 'control_poam_entries' && RLS_PROGRAM_TABLES[RLS_PROGRAM_TABLES.length - 12] === 'control_poam_events', 'CP-D6: both tables were appended after the SSP tables (only the seven inventory program tables and the four document register program tables come after them in RLS_PROGRAM_TABLES)');

  for (const col of ["milestones JSONB NOT NULL DEFAULT '[]'::jsonb", 'item_number INTEGER']) {
    assert(TABLES_SQL.includes('ALTER TABLE vm_poam_items ADD COLUMN IF NOT EXISTS ' + col + ';'), 'VM-D1: vm_poam_items gets ' + col + ' idempotently (nullable or defaulted: an older image still starts)');
  }
  for (const col of ['milestones_changed BOOLEAN NOT NULL DEFAULT FALSE', 'new_milestone_count INTEGER', 'new_milestones_completed INTEGER', 'new_milestones_sha256 VARCHAR(64)']) {
    assert(TABLES_SQL.includes('ALTER TABLE vm_poam_item_events ADD COLUMN IF NOT EXISTS ' + col + ';'), 'VM-D2: vm_poam_item_events gets ' + col + ' idempotently');
  }
  const guarded = (name: string, table: string): boolean =>
    TABLES_SQL.includes(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '${table}'::regclass) THEN`) && TABLES_SQL.includes(`ADD CONSTRAINT ${name} CHECK`);
  assert(guarded('vm_poam_items_milestones_check', 'vm_poam_items') && guarded('vm_poam_items_item_number_check', 'vm_poam_items') && guarded('vm_poam_item_events_milestones_check', 'vm_poam_item_events'), 'VM-D3: the new CHECKs on vm_poam_items and its events are added once, each guarded by pg_constraint (no rescan at every boot)');
  assert(!/DROP CONSTRAINT IF EXISTS vm_poam_items_(milestones|item_number)_check/.test(TABLES_SQL) && !/vm_poam_item_events_(status|source|sha|system)_check CHECK[^;]*milestone/.test(TABLES_SQL), 'VM-D4: no existing CHECK is widened or dropped (an older image still starts and runs)');

  // The item-number backfill (#305)
  const fillAt = TABLES_SQL.indexOf("IS DISTINCT FROM 'Stable per-program number (#305); backfilled once, oldest first' THEN");
  const fillEnd = fillAt < 0 ? -1 : TABLES_SQL.indexOf('$$;', fillAt);
  const fill = fillAt < 0 ? '' : TABLES_SQL.slice(fillAt, fillEnd);
  const noForce = fill.indexOf('ALTER TABLE vm_poam_items NO FORCE ROW LEVEL SECURITY;');
  const update = fill.indexOf('UPDATE vm_poam_items p SET item_number = n.rn');
  const force = fill.indexOf('ALTER TABLE vm_poam_items FORCE ROW LEVEL SECURITY;');
  const comment = fill.indexOf("COMMENT ON COLUMN vm_poam_items.item_number IS 'Stable per-program number (#305); backfilled once, oldest first';");
  assert(fillAt > TABLES_SQL.indexOf('ADD COLUMN IF NOT EXISTS item_number INTEGER') && 0 <= noForce && noForce < update && update < force && force < comment, 'VM-B1: the item-number backfill lifts FORCE, numbers the rows, restores FORCE and then sets the done marker, in that order', [noForce, update, force, comment]);
  assert(
    fill.includes('PARTITION BY u.tenant_id, u.program_id ORDER BY u.created_at, u.id') && fill.includes('WHERE u.item_number IS NULL AND u.program_id IS NOT NULL') && fill.includes('COALESCE(m.mx, 0) + ROW_NUMBER()') && !/updated_at/.test(fill),
    'VM-B2: the backfill numbers per tenant and program, oldest first (created_at, then id), only rows with no number and a program, after any number already held; updated_at is not touched'
  );
  assert(
    TABLES_SQL.includes('col_description(\'vm_poam_items\'::regclass') && fillAt > 0 && TABLES_SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS unq_vm_poam_items_number ON vm_poam_items (tenant_id, program_id, item_number);') > fillEnd,
    'VM-B3: the backfill runs once (guarded by the column comment) and the unique index (tenant_id, program_id, item_number) is created after it'
  );
  assert(TABLES_SQL.includes('CHECK (item_number IS NULL OR item_number > 0)'), 'VM-B4: a stored number is positive; NULL stays allowed (an older image inserts none)');
  const findingsSrc = fs.readFileSync('server/vm/findingsStore.ts', 'utf8').replace(/\r\n/g, '\n');
  assert(findingsSrc.includes('pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))') && findingsSrc.includes('COALESCE(MAX(item_number), 0)::int AS n FROM vm_poam_items WHERE tenant_id = $1::text AND program_id = $2::text'), 'VM-B5: insertPoamItems numbers the new items under a per-tenant-and-program advisory lock, after the largest stored number');
}
const kindLine = TABLES_SQL.slice(TABLES_SQL.indexOf('ADD CONSTRAINT program_events_kind_check'), TABLES_SQL.indexOf('\n', TABLES_SQL.indexOf('ADD CONSTRAINT program_events_kind_check')));
assert(kindLine.includes('ssp_metadata_changed') && !kindLine.includes('ssp_profile') && !kindLine.includes('ssp_section') && SSP_METADATA_FIELDS.length === 12, 'SR-D3: the program_events kind CHECK and the twelve SSP metadata fields are unchanged (no one-way upgrade)');

console.log('\n--- per-user default program (user_program_defaults) ---');
const updAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS user_program_defaults (');
const updBlock = updAt < 0 ? '' : TABLES_SQL.slice(updAt, TABLES_SQL.indexOf('\n  );', updAt));
assert(updAt > smAt && updBlock.includes('tenant_id VARCHAR(64) NOT NULL') && updBlock.includes('user_id VARCHAR(128) NOT NULL') && updBlock.includes('program_id VARCHAR(64) NOT NULL') && updBlock.includes('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'), 'UPD1: user_program_defaults is created after program_ssp_metadata with NOT NULL tenant, user and program');
assert(updBlock.includes('CONSTRAINT pk_user_program_defaults PRIMARY KEY (tenant_id, user_id)'), 'UPD2: one default per user and tenant (primary key)');
assert(updBlock.includes('FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE'), 'UPD3: composite foreign key to programs, cascading with the program');
assert(!updBlock.includes('tenant_users'), 'UPD4: no foreign key to tenant_users (a platform admin may have no membership row)');
assert(
  RLS_TENANT_TABLES.some((r) => r.table === 'user_program_defaults' && r.tenantColumn === 'tenant_id') &&
    !(RLS_PROGRAM_TABLES as readonly string[]).includes('user_program_defaults') &&
    !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes('user_program_defaults'),
  'UPD5: a tenant table (tenant RLS), not a program table and not backfilled'
);

console.log('\n--- software inventory (software_items) ---');
const swAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS software_items (');
const swBlock = swAt < 0 ? '' : TABLES_SQL.slice(swAt, TABLES_SQL.indexOf('\n  );', swAt));
assert(swAt > updAt && swBlock.includes('tenant_id VARCHAR(64) NOT NULL') && swBlock.includes('name VARCHAR(255) NOT NULL'), 'SW-D1: software_items is created after user_program_defaults with NOT NULL tenant and name');
assert(
  RLS_TENANT_TABLES.some((r) => r.table === 'software_items' && r.tenantColumn === 'tenant_id') &&
    !(RLS_PROGRAM_TABLES as readonly string[]).includes('software_items') &&
    !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes('software_items'),
  'SW-D2: a tenant table (tenant RLS), not a program table and not backfilled'
);

console.log('\n--- scanner host inventory (vm_host_inventory, vm_host_software; issue #229) ---');
for (const t of ['vm_host_inventory', 'vm_host_software']) {
  assert(
    RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id') &&
      !(RLS_PROGRAM_TABLES as readonly string[]).includes(t) &&
      !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes(t),
    `HI-D1: ${t} is a tenant table (tenant RLS), not a program table and not backfilled`
  );
  assert(buildRlsSql().includes(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`) && buildRlsSql().includes(rlsPolicyName(t)), `HI-D2: ${t} gets FORCE row security and its tenant policy`);
}

console.log('\n--- Tools and Services register (inventory_*, program_tools and friends; #239, #243, #248, #249) ---');
{
  const blockOf = (table: string): string => {
    const at = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    return at < 0 ? '' : TABLES_SQL.slice(at, TABLES_SQL.indexOf('\n  );', at));
  };
  const INVENTORY_TENANT_TABLES = ['inventory_vendors', 'inventory_tools', 'inventory_events', 'program_tools', 'program_tool_controls', 'program_data_inventory', 'program_cui_categories', 'program_cui_category_tools', 'program_vendor_documents', 'program_inventory_events'];
  const INVENTORY_PROGRAM_TABLES = INVENTORY_TENANT_TABLES.slice(3);
  const vendorsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS inventory_vendors (');
  const toolsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS inventory_tools (');
  const toolsBlock = blockOf('inventory_tools');
  assert(vendorsAt > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS control_poam_events (') && toolsAt > vendorsAt, 'INV-D1: inventory_tools is created after inventory_vendors (the table its foreign key points at)');
  assert(
    toolsBlock.includes('FOREIGN KEY (tenant_id, vendor_id) REFERENCES inventory_vendors (tenant_id, id) ON DELETE SET NULL (vendor_id)') &&
      TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_inventory_tools_name ON inventory_tools (tenant_id, lower(name));') &&
      TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_inventory_tools_seed ON inventory_tools (tenant_id, seed_key) WHERE seed_key IS NOT NULL;') &&
      TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_inventory_tools_rank ON inventory_tools (tenant_id, recovery_rank) WHERE recovery_rank IS NOT NULL;') &&
      toolsBlock.includes('inventory_tools_cost_check CHECK (annual_cost_cents IS NULL OR annual_cost_cents BETWEEN 0 AND 100000000000)') &&
      toolsBlock.includes('annual_cost_cents BIGINT') && toolsBlock.includes('renewal_date DATE'),
    'INV-D1: the vendor link nulls on delete, the name, seed and rank unique indexes exist, and the cost is a bounded BIGINT of cents'
  );
  assert(
    toolsBlock.includes("tool_type ~ '^[A-Z][A-Z0-9_]{0,31}$'") && toolsBlock.includes("deployment ~ '^[A-Z][A-Z_]{0,15}$'") && !/\bIN \(/.test(toolsBlock) && !/\bIN \(/.test(blockOf('inventory_vendors')) && !/\bIN \(/.test(blockOf('program_vendor_documents')),
    'INV-D1b: the enum columns are pattern CHECKs, never IN lists (a later image may add a value without a migration)'
  );
  const dropped = [...TABLES_SQL.matchAll(/DROP CONSTRAINT IF EXISTS (\w+)/g)].map((m) => m[1]);
  assert(
    dropped.every((c) => !INVENTORY_TENANT_TABLES.some((t) => c.startsWith(t))) && !/ALTER TABLE (inventory_\w+|program_(tools|tool_controls|data_inventory|cui_\w+|vendor_documents|inventory_events)) (DROP|ADD) CONSTRAINT/.test(TABLES_SQL),
    'INV-D2: no DROP or ADD CONSTRAINT touches a register table (every CHECK is inline: no one-way upgrade)',
    dropped.filter((c) => INVENTORY_TENANT_TABLES.some((t) => c.startsWith(t)))
  );
  for (const t of INVENTORY_PROGRAM_TABLES) {
    const b = blockOf(t);
    const viaProgram = b.includes('REFERENCES programs (tenant_id, id) ON DELETE CASCADE');
    const expected = t === 'program_cui_categories' ? b.includes('REFERENCES program_data_inventory (tenant_id, program_id) ON DELETE CASCADE')
      : t === 'program_cui_category_tools' ? b.includes('REFERENCES program_cui_categories (tenant_id, program_id, category_id) ON DELETE CASCADE')
      : t === 'program_inventory_events' ? !/REFERENCES/.test(b)
      : viaProgram;
    assert(b !== '' && expected && b.includes('program_id VARCHAR(64) NOT NULL') && b.includes('tenant_id VARCHAR(64) NOT NULL'), `INV-D3: ${t} cascades with its program (directly, through the data inventory or the category; the history has no foreign key) and has a NOT NULL program`);
  }
  assert(
    blockOf('program_cui_categories').includes("category_id VARCHAR(48) NOT NULL") && blockOf('program_cui_categories').includes("category_id ~ '^[A-Z][A-Z0-9_-]{0,47}$'") &&
      blockOf('program_cui_category_tools').includes('CHECK (stores OR processes OR transmits)'),
    'INV-D3b: category ids are 48 characters with hyphens allowed (the CUI Registry ids), and a tool row stores, processes or transmits'
  );
  const kindStart = TABLES_SQL.indexOf('ADD CONSTRAINT program_events_kind_check');
  const kindLine = TABLES_SQL.slice(kindStart, TABLES_SQL.indexOf('\n', kindStart));
  assert(!/tool|inventory|cui/.test(kindLine) && kindLine.includes('stack_profile_changed'), 'INV-D4: the program_events kind CHECK is unchanged (the register has its own history tables)');
  const trig = (name: string, table: string, when: string): boolean => {
    const dropAt = TABLES_SQL.indexOf(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
    const createAt = TABLES_SQL.indexOf(`CREATE TRIGGER ${name} BEFORE ${when} ON ${table}`);
    return dropAt > 0 && createAt > dropAt;
  };
  const guardAt = TABLES_SQL.indexOf('CREATE OR REPLACE FUNCTION inventory_events_guard()');
  const guardBody = guardAt < 0 ? '' : TABLES_SQL.slice(guardAt, TABLES_SQL.indexOf('$$ LANGUAGE plpgsql;', guardAt));
  assert(
    guardBody.includes('RAISE EXCEPTION') && guardBody.includes('append-only') && guardBody.includes("ERRCODE = '42501'") &&
      trig('trg_inventory_events_guard', 'inventory_events', 'UPDATE') && trig('trg_inventory_events_no_truncate', 'inventory_events', 'TRUNCATE') &&
      trig('trg_program_inventory_events_guard', 'program_inventory_events', 'UPDATE') && trig('trg_program_inventory_events_no_truncate', 'program_inventory_events', 'TRUNCATE') &&
      !/BEFORE DELETE ON (program_)?inventory_events/.test(TABLES_SQL),
    'INV-D5: both history tables are append-only through the guard function (UPDATE and TRUNCATE refused, each trigger dropped before it is created); DELETE stays allowed'
  );
  for (const t of INVENTORY_TENANT_TABLES) {
    assert(
      RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id') &&
        (RLS_PROGRAM_TABLES as readonly string[]).includes(t) === INVENTORY_PROGRAM_TABLES.includes(t) &&
        !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes(t) &&
        buildRlsSql().includes(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`) && (!INVENTORY_PROGRAM_TABLES.includes(t) || buildProgramRlsSql().includes(rlsProgramPolicyName(t))),
      `INV-D6: ${t} is a tenant table${INVENTORY_PROGRAM_TABLES.includes(t) ? ' and a program table' : ' (not a program table)'}, FORCE row security, not backfilled`
    );
  }
  assert(
    JSON.stringify(RLS_PROGRAM_TABLES.slice(-11, -4)) === JSON.stringify(INVENTORY_PROGRAM_TABLES) && JSON.stringify(RLS_TENANT_TABLES.slice(-19, -9).map((r) => r.table)) === JSON.stringify(INVENTORY_TENANT_TABLES),
    'INV-D7: the register tables sit after the SSP tables in both row-security lists, in creation order (the four remediation tables and the five document register tables come after them in RLS_TENANT_TABLES, the four document register program tables in RLS_PROGRAM_TABLES)'
  );
}

console.log('\n--- Document register and expected documents checklist (governance_documents, program_document_*; #240, #250) ---');
{
  const blockOf = (table: string): string => {
    const at = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    return at < 0 ? '' : TABLES_SQL.slice(at, TABLES_SQL.indexOf('\n  );', at));
  };
  const DOC_PROGRAM_TABLES = ['program_governance_documents', 'program_document_controls', 'program_document_attachments', 'program_document_expectations'];
  const DOC_TENANT_TABLES = ['governance_documents', ...DOC_PROGRAM_TABLES];
  const docsAt = TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS governance_documents (');
  const docsBlock = blockOf('governance_documents');
  assert(
    docsAt > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS programs (') && docsAt > TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS program_inventory_events (') &&
      TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_governance_documents_title ON governance_documents (tenant_id, lower(title)) WHERE status <> \'RETIRED\';') &&
      TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_governance_documents_seed ON governance_documents (tenant_id, seed_key) WHERE seed_key IS NOT NULL;') &&
      TABLES_SQL.includes('CREATE INDEX IF NOT EXISTS idx_governance_documents_kind ON governance_documents (tenant_id, kind);') &&
      docsBlock.includes('governance_documents_approval_check CHECK (status <> \'APPROVED\' OR (approval_date IS NOT NULL AND approved_at IS NOT NULL AND length(btrim(version)) > 0))') &&
      docsBlock.includes('CONSTRAINT unq_governance_documents_tenant_id UNIQUE (tenant_id, id)') && !/\bIN \(/.test(docsBlock),
    'DOC-D1: governance_documents is created after programs and the inventory tables, with its three indexes (live titles and seed keys unique per tenant), the approval CHECK and pattern CHECKs instead of IN lists'
  );
  const dropped = [...TABLES_SQL.matchAll(/DROP CONSTRAINT IF EXISTS (\w+)/g)].map((m) => m[1]);
  assert(
    dropped.every((c) => !DOC_TENANT_TABLES.some((t) => c.startsWith(t))) && !new RegExp('ALTER TABLE (' + DOC_TENANT_TABLES.join('|') + ') (DROP|ADD) CONSTRAINT').test(TABLES_SQL),
    'DOC-D2: no DROP or ADD CONSTRAINT touches a document register table (every CHECK is inline: no one-way upgrade)',
    dropped.filter((c) => DOC_TENANT_TABLES.some((t) => c.startsWith(t)))
  );
  for (const t of DOC_PROGRAM_TABLES) {
    const b = blockOf(t);
    assert(
      b.includes('REFERENCES programs (tenant_id, id) ON DELETE CASCADE') && b.includes('REFERENCES governance_documents (tenant_id, id) ON DELETE CASCADE') && b.includes('program_id VARCHAR(64) NOT NULL') && b.includes('tenant_id VARCHAR(64) NOT NULL'),
      `DOC-D3: ${t} cascades with its program and with its document (composite keys on the tenant) and has a NOT NULL program`
    );
  }
  const kindStart = TABLES_SQL.indexOf('ADD CONSTRAINT program_events_kind_check');
  const kindLine = TABLES_SQL.slice(kindStart, TABLES_SQL.indexOf('\n', kindStart));
  assert(!/document/.test(kindLine) && kindLine.includes('stack_profile_changed'), 'DOC-D4: the program_events kind CHECK is unchanged (the document register writes to the register history tables)');
  assert(
    TABLES_SQL.includes('CREATE UNIQUE INDEX IF NOT EXISTS unq_program_document_attachments_primary ON program_document_attachments (tenant_id, program_id, document_id) WHERE is_primary;') &&
      blockOf('program_document_expectations').includes("expected_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'") && !/FOREIGN KEY \(tenant_id, expected_id\)/.test(TABLES_SQL),
    'DOC-D5: a document has at most one primary attachment per program (partial unique index), and the expected-document id is a catalog code with a pattern CHECK and no foreign key'
  );
  for (const t of DOC_TENANT_TABLES) {
    assert(
      RLS_TENANT_TABLES.some((r) => r.table === t && r.tenantColumn === 'tenant_id') &&
        (RLS_PROGRAM_TABLES as readonly string[]).includes(t) === DOC_PROGRAM_TABLES.includes(t) &&
        !(PROGRAM_BACKFILL_TABLES as readonly string[]).includes(t) &&
        buildRlsSql().includes(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`) && (!DOC_PROGRAM_TABLES.includes(t) || buildProgramRlsSql().includes(rlsProgramPolicyName(t))),
      `DOC-D6: ${t} is a tenant table${DOC_PROGRAM_TABLES.includes(t) ? ' and a program table' : ' (not a program table)'}, FORCE row security, not backfilled`
    );
  }
  assert(
    JSON.stringify(RLS_PROGRAM_TABLES.slice(-4)) === JSON.stringify(DOC_PROGRAM_TABLES) && JSON.stringify(RLS_TENANT_TABLES.slice(-5).map((r) => r.table)) === JSON.stringify(DOC_TENANT_TABLES),
    'DOC-D7: the document register tables are appended at the end of both row-security lists, in creation order'
  );
}

const initAt = dbSrc.indexOf('export async function initDb(');
const verAt = dbSrc.indexOf('assertSupportedPostgresVersion(ver.rows', initAt);
const roleAt = dbSrc.indexOf('assessDatabaseRole(', initAt);
assert(initAt > 0 && verAt > initAt && roleAt > verAt && dbSrc.indexOf('[FATAL]', initAt) > roleAt, 'initDb checks the role after the version check and refuses with [FATAL]', [initAt, verAt, roleAt]);
assert(dbSrc.includes('connectionLogged') && /export function isDbReady\(/.test(dbSrc), 'db.ts logs the successful connection once (connectionLogged) and exports isDbReady()');
const apiSrc = fs.readFileSync('server/routes/api.ts', 'utf8');
assert(/router\.get\('\/health'[\s\S]*?isDbReady\(/.test(apiSrc), 'the health handler answers "starting" until isDbReady()');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
