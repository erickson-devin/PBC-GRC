import { buildPoolConfig } from '../server/db';
import { DISCOVERY_POLICIES, RLS_TENANT_TABLES, TABLES_SQL, buildRlsSql, buildSchemaSql, rlsPolicyName } from '../server/schema';

/**
 * Pure checks (no database needed) on the schema bootstrap and the pool configuration:
 *  - tenant_users and ssp_documents are created by initDb;
 *  - EVERY tenant-bound table gets ENABLE + FORCE ROW LEVEL SECURITY and a policy;
 *  - DATABASE_URL selects a standard connection string, otherwise the existing Cloud SQL socket / TCP logic.
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

console.log('\n--- Tenant discovery policies ("list my tenants") ---');
const byName = (name: string) => DISCOVERY_POLICIES.find((p) => p.name === name);
const tenantsPolicy = byName('rls_tenants_member_discovery');
const selfPolicy = byName('rls_tenant_users_self_discovery');
const userCtx = "NULLIF(current_setting('app.current_user_id', true), '')";
assert(Boolean(tenantsPolicy) && tenantsPolicy!.table === 'tenants', 'tenants has a member-discovery policy');
assert(Boolean(selfPolicy) && selfPolicy!.table === 'tenant_users', 'tenant_users has a self-visibility policy (the tenants policy reads it under RLS, so it needs one)');
assert(tenantsPolicy?.using === `id IN (SELECT tenant_id FROM tenant_users WHERE user_id = ${userCtx})`, 'tenants are visible only where the user has a tenant_users row', tenantsPolicy?.using);
assert(selfPolicy?.using === `user_id = ${userCtx}`, 'tenant_users: a user sees only their own rows', selfPolicy?.using);
assert(DISCOVERY_POLICIES.every((p) => p.using.includes(userCtx)), "an unset or empty user context matches nothing (NULLIF, so '' never equals a user id)");
for (const p of DISCOVERY_POLICIES) {
  const start = rls.indexOf(`CREATE POLICY ${p.name}`);
  const block = rls.slice(start, rls.indexOf('END IF;', start));
  assert(start > 0 && /FOR SELECT/.test(block) && !/FOR ALL|FOR INSERT|FOR UPDATE|FOR DELETE/.test(block), `${p.name} is SELECT-only: it can never grant a write`);
  assert(!/WITH CHECK/.test(block), `${p.name} has no WITH CHECK`);
  assert(rls.includes(`policyname = '${p.name}'`), `${p.name} is created idempotently`);
}
assert(DISCOVERY_POLICIES.every((p) => protectedTables.has(p.table)), 'discovery policies only extend tables that already have FORCE RLS');
assert(!TABLES_SQL.includes('app.current_user_id'), 'the user context is used only by policies, never by table definitions');

console.log('\n--- Pool configuration ---');
const url = buildPoolConfig({ DATABASE_URL: 'postgres://app:s3cret@db.internal:6543/grc?sslmode=require' } as NodeJS.ProcessEnv);
assert(url.config.connectionString === 'postgres://app:s3cret@db.internal:6543/grc?sslmode=require', 'DATABASE_URL is passed through as the connection string');
assert(!url.target.includes('s3cret') && !url.target.includes('app:'), 'credentials never appear in the loggable target', url.target);
assert(url.target === 'db.internal:6543/grc', 'target shows host:port/database', url.target);

const both = buildPoolConfig({ DATABASE_URL: 'postgres://u:p@urlhost/db', DB_HOST: 'otherhost', DB_NAME: 'other' } as NodeJS.ProcessEnv);
assert(both.config.connectionString !== undefined && both.config.host === undefined, 'DATABASE_URL takes precedence over DB_* settings');
assert(buildPoolConfig({ DATABASE_URL: '   ' } as NodeJS.ProcessEnv).config.connectionString === undefined, 'blank DATABASE_URL is ignored');

const socket = buildPoolConfig({} as NodeJS.ProcessEnv);
assert(String(socket.config.host).startsWith('/cloudsql/') && socket.config.port === undefined, 'default: Cloud SQL Unix socket (no port)');
const tcp = buildPoolConfig({ DB_HOST: 'singularity-db', DB_PORT: '5433', DB_USER: 'u', DB_NAME: 'n', DB_PASS: 'p' } as NodeJS.ProcessEnv);
assert(tcp.config.host === 'singularity-db' && tcp.config.port === 5433 && tcp.config.user === 'u', 'DB_HOST without a leading "/" is TCP with DB_PORT');
assert(buildPoolConfig({} as NodeJS.ProcessEnv).config.ssl === undefined, 'TLS is off unless requested');
const ssl = buildPoolConfig({ DATABASE_URL: 'postgres://a@h/d', DB_SSL: 'true' } as NodeJS.ProcessEnv);
assert((ssl.config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized === true, 'DB_SSL=true verifies the server certificate by default');
const sslLoose = buildPoolConfig({ DATABASE_URL: 'postgres://a@h/d', DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' } as NodeJS.ProcessEnv);
assert((sslLoose.config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized === false, 'verification can be disabled explicitly (self-signed on-prem)');
assert(url.config.max === 10, 'pool size is unchanged');

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
