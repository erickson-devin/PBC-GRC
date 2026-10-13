import { TENANT_ROLES } from '../src/utils/roles';
import { CMMC_ASSET_CATEGORIES } from '../src/data/telemetry/assetScope';
import { FIPS_STANDARDS, FIPS_STATUSES } from '../src/data/telemetry/fipsValidation';

/**
 * A table whose rows belong to exactly one tenant. Every table listed here gets
 * ENABLE + FORCE ROW LEVEL SECURITY and a policy tying rows to `app.current_tenant_id`.
 *
 * FORCE matters: without it the table OWNER (normally the role the app connects as) silently bypasses RLS.
 * Note that PostgreSQL superusers and roles with BYPASSRLS always bypass RLS regardless of FORCE, so the
 * application must connect as an ordinary role.
 */
export interface RlsTable {
  table: string;
  /** Column holding the tenant id (`id` for the tenants table itself). */
  tenantColumn: 'tenant_id' | 'id';
}

export const RLS_TENANT_TABLES: readonly RlsTable[] = [
  { table: 'tenants', tenantColumn: 'id' },
  { table: 'tenant_users', tenantColumn: 'tenant_id' },
  { table: 'control_assessments', tenantColumn: 'tenant_id' },
  { table: 'evidence_metadata', tenantColumn: 'tenant_id' },
  { table: 'ssp_documents', tenantColumn: 'tenant_id' },
  { table: 'tenant_invitations', tenantColumn: 'tenant_id' },
  { table: 'enclave_assets', tenantColumn: 'tenant_id' },
  { table: 'ssp_import_jobs', tenantColumn: 'tenant_id' },
  { table: 'staged_controls', tenantColumn: 'tenant_id' },
];

export const rlsPolicyName = (table: string): string => `rls_${table}_tenant_isolation`;

const tenantPredicate = (column: string): string =>
  `${column} = NULLIF(current_setting('app.current_tenant_id', true), '')`;

const roleList = TENANT_ROLES.map((r) => `'${r}'`).join(', ');
const fipsStatusList = FIPS_STATUSES.map((s) => `'${s}'`).join(', ');
const fipsStandardList = FIPS_STANDARDS.map((s) => `'${s}'`).join(', ');
const assetCategoryList = CMMC_ASSET_CATEGORIES.map((c) => `'${c}'`).join(', ');

/** Tables and columns (idempotent). */
export const TABLES_SQL = `
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS tenants (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      cage_code VARCHAR(10),
      sam_status VARCHAR(32) DEFAULT 'ACTIVE',
      system_name VARCHAR(255) NOT NULL,
      system_owner VARCHAR(255) NOT NULL,
      industry VARCHAR(128) DEFAULT 'Defense Industrial Base (DIB)',
      enabled_frameworks TEXT[] DEFAULT '{"CMMC_L1"}',
      primary_framework VARCHAR(64) DEFAULT 'CMMC_L1',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enabled_frameworks TEXT[] DEFAULT '{"CMMC_L1"}';
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_framework VARCHAR(64) DEFAULT 'CMMC_L1';

  -- Membership & RBAC: who belongs to which tenant, and with which role.
  CREATE TABLE IF NOT EXISTS tenant_users (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      user_id VARCHAR(128) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      tenant_id VARCHAR(64) NOT NULL,
      role VARCHAR(32) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_user_tenant UNIQUE (user_id, tenant_id)
  );
  ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  -- Older deployments created this table from schema.sql without MSP_ADMIN in the allowed roles.
  ALTER TABLE tenant_users DROP CONSTRAINT IF EXISTS tenant_users_role_check;
  ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check CHECK (role IN (${roleList}));
  CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON tenant_users(user_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON tenant_users(tenant_id);

  CREATE TABLE IF NOT EXISTS control_assessments (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
      implementation_notes TEXT DEFAULT '',
      responsible_role VARCHAR(128) DEFAULT 'IT / Security Lead',
      tags TEXT[] DEFAULT '{}',
      updated_by VARCHAR(255),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_tenant_control UNIQUE (tenant_id, control_id)
  );

  CREATE TABLE IF NOT EXISTS evidence_metadata (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_size BIGINT NOT NULL,
      mime_type VARCHAR(128) NOT NULL,
      gcs_path TEXT NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      sync_status VARCHAR(32) DEFAULT 'gcs_synced',
      description TEXT,
      uploaded_by VARCHAR(255),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS ssp_documents (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      system_name VARCHAR(255) NOT NULL,
      organization_name VARCHAR(255) NOT NULL,
      cage_code VARCHAR(20),
      sam_status VARCHAR(32) DEFAULT 'ACTIVE',
      system_owner VARCHAR(255) NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      assessment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      system_boundary_scope TEXT NOT NULL,
      system_environment TEXT NOT NULL,
      cloud_service_providers TEXT NOT NULL,
      version VARCHAR(32) DEFAULT '1.0.0',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_tenant_ssp UNIQUE (tenant_id)
  );

  -- Invitations to join a tenant. The secret token is NEVER stored: only its SHA-256 hash, so a database leak does not
  -- hand out working invitations. An invitation is single-use (accepted_at) and can be revoked or expire.
  CREATE TABLE IF NOT EXISTS tenant_invitations (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_by_user_id VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      accepted_by_user_id VARCHAR(128),
      revoked_at TIMESTAMPTZ,
      CONSTRAINT unq_invitation_token_hash UNIQUE (token_hash),
      CONSTRAINT tenant_invitations_role_check CHECK (role IN (${roleList}))
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant ON tenant_invitations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_invitations_email ON tenant_invitations(tenant_id, email);

  -- CMMC scoping: the assets that make up the assessment boundary, each with its CMMC asset category. Server-owned so the
  -- SSP boundary summary and scoring do not depend on one person's browser.
  CREATE TABLE IF NOT EXISTS enclave_assets (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      asset_name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cmmc_category VARCHAR(32) NOT NULL,
      owner VARCHAR(255) NOT NULL DEFAULT '',
      fips_validation_status VARCHAR(16),
      fips_certificate_number VARCHAR(16),
      fips_module_name VARCHAR(255),
      fips_standard VARCHAR(8),
      ip_address VARCHAR(64) NOT NULL DEFAULT '',
      mac_address VARCHAR(32) NOT NULL DEFAULT '',
      os_profile VARCHAR(64) NOT NULL DEFAULT 'custom',
      status VARCHAR(32) NOT NULL DEFAULT 'NEVER_SCANNED',
      source_origin VARCHAR(32) NOT NULL DEFAULT 'MANUAL_ENTRY',
      discovery_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
      accretion_metadata JSONB,
      last_scanned_at TIMESTAMPTZ,
      compliance_score INTEGER,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by VARCHAR(255),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT enclave_assets_category_check CHECK (cmmc_category IN (${assetCategoryList})),
      CONSTRAINT enclave_assets_score_check CHECK (compliance_score IS NULL OR (compliance_score BETWEEN 0 AND 100))
  );
  -- Cryptographic module validation (FIPS 140-2/3, CMVP). Added after the first release, so older databases get the columns here.
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS fips_validation_status VARCHAR(16);
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS fips_certificate_number VARCHAR(16);
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS fips_module_name VARCHAR(255);
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS fips_standard VARCHAR(8);
  ALTER TABLE enclave_assets DROP CONSTRAINT IF EXISTS enclave_assets_fips_status_check;
  ALTER TABLE enclave_assets ADD CONSTRAINT enclave_assets_fips_status_check CHECK (fips_validation_status IS NULL OR fips_validation_status IN (${fipsStatusList}));
  ALTER TABLE enclave_assets DROP CONSTRAINT IF EXISTS enclave_assets_fips_standard_check;
  ALTER TABLE enclave_assets ADD CONSTRAINT enclave_assets_fips_standard_check CHECK (fips_standard IS NULL OR fips_standard IN (${fipsStandardList}));
  ALTER TABLE enclave_assets DROP CONSTRAINT IF EXISTS enclave_assets_fips_cert_check;
  ALTER TABLE enclave_assets ADD CONSTRAINT enclave_assets_fips_cert_check CHECK (fips_certificate_number IS NULL OR fips_certificate_number ~ '^[0-9]{1,6}$');
  CREATE UNIQUE INDEX IF NOT EXISTS unq_enclave_assets_name ON enclave_assets(tenant_id, lower(asset_name));
  CREATE INDEX IF NOT EXISTS idx_enclave_assets_tenant_category ON enclave_assets(tenant_id, cmmc_category);

  -- Local (air-gapped) identities for AUTH_MODE=local. Global, not tenant-bound: a person logs in first and
  -- belongs to tenants through tenant_users. Passwords are stored only as bcrypt hashes.
  CREATE TABLE IF NOT EXISTS local_users (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_local_users_email UNIQUE (email)
  );

  -- SSP import (see server/ssp): an uploaded System Security Plan is extracted and mapped to controls, and the result is
  -- held HERE, in a staging area. Nothing in these tables is ever a compliance answer: control_assessments changes only
  -- through an explicit, reviewed commit, so these tables deliberately have no foreign key into it.
  CREATE TABLE IF NOT EXISTS ssp_import_jobs (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_by_user_id VARCHAR(64),
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(128) NOT NULL,
      file_size BIGINT NOT NULL,
      file_sha256 VARCHAR(64) NOT NULL,
      framework VARCHAR(32) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
      stage_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      stored_provider VARCHAR(8) NOT NULL,
      stored_path TEXT NOT NULL,
      page_count INTEGER,
      char_count INTEGER,
      chunk_count INTEGER,
      analyzer VARCHAR(32) NOT NULL DEFAULT 'regex-v1',
      coverage_report JSONB,
      unmapped_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      CONSTRAINT ssp_import_jobs_status_check CHECK (status IN ('QUEUED','EXTRACTING','ANALYZING','READY_FOR_REVIEW','COMMITTED','FAILED','CANCELLED')),
      CONSTRAINT ssp_import_jobs_framework_check CHECK (framework IN ('CMMC_L1','CMMC_L2'))
  );
  CREATE INDEX IF NOT EXISTS idx_ssp_import_jobs_tenant ON ssp_import_jobs (tenant_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS staged_controls (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      job_id VARCHAR(64) NOT NULL REFERENCES ssp_import_jobs(id) ON DELETE CASCADE,
      control_id VARCHAR(64) NOT NULL,
      framework VARCHAR(32) NOT NULL,
      match_kind VARCHAR(24) NOT NULL,
      origin VARCHAR(8) NOT NULL DEFAULT 'RULES',
      section_heading TEXT NOT NULL DEFAULT '',
      suggested_notes TEXT NOT NULL DEFAULT '',
      confidence NUMERIC(3,2) NOT NULL DEFAULT 0,
      source_quotes JSONB NOT NULL DEFAULT '[]'::jsonb,
      gap_analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
      base_hash VARCHAR(64),
      review_state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      edited_notes TEXT,
      reviewed_by VARCHAR(255),
      reviewed_at TIMESTAMPTZ,
      committed_at TIMESTAMPTZ,
      CONSTRAINT unq_staged_job_control UNIQUE (job_id, control_id),
      CONSTRAINT staged_controls_state_check CHECK (review_state IN ('PENDING','ACCEPTED','EDITED','REJECTED','COMMITTED','CONFLICT'))
  );
  CREATE INDEX IF NOT EXISTS idx_staged_controls_job ON staged_controls (job_id);

  -- Tables created by an earlier version of the SSP import: bring them up to date
  ALTER TABLE staged_controls ADD COLUMN IF NOT EXISTS origin VARCHAR(8) NOT NULL DEFAULT 'RULES';
  ALTER TABLE ssp_import_jobs DROP CONSTRAINT IF EXISTS ssp_import_jobs_status_check;
  ALTER TABLE ssp_import_jobs ADD CONSTRAINT ssp_import_jobs_status_check
    CHECK (status IN ('QUEUED','EXTRACTING','ANALYZING','READY_FOR_REVIEW','COMMITTED','FAILED','CANCELLED'));

  -- Platform administrators created through the first-time setup wizard (the operators of this installation; see
  -- server/platformSetup.ts). Global, not tenant-bound.
  CREATE TABLE IF NOT EXISTS platform_admins (
      user_id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_platform_admins_email UNIQUE (email)
  );

  -- The first-time setup lock. At most ONE row can ever exist (id is pinned to 1), so "claim the setup" is an atomic
  -- INSERT that only one caller can win. It is never deleted by the application once setup completed.
  CREATE TABLE IF NOT EXISTS platform_setup (
      id INTEGER PRIMARY KEY DEFAULT 1,
      admin_user_id VARCHAR(64) NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT platform_setup_singleton CHECK (id = 1)
  );

  -- Global reference data (not tenant-bound, no RLS)
  CREATE TABLE IF NOT EXISTS control_mappings (
      id VARCHAR(64) PRIMARY KEY,
      source_framework VARCHAR(64) NOT NULL,
      source_control_id VARCHAR(64) NOT NULL,
      target_framework VARCHAR(64) NOT NULL,
      target_control_id VARCHAR(64) NOT NULL,
      mapping_type VARCHAR(32) DEFAULT 'EQUIVALENT',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_source_target_mapping UNIQUE (source_framework, source_control_id, target_framework, target_control_id)
  );
`;

const currentUserPredicate = "NULLIF(current_setting('app.current_user_id', true), '')";
const inviteTokenPredicate = "NULLIF(current_setting('app.invite_token_hash', true), '')";

/**
 * Tenant DISCOVERY: lets a signed-in user see which tenants they belong to ("list my tenants") without any
 * tenant context, using `app.current_user_id` (set by the server inside a transaction, never by clients).
 *
 * Policies are permissive, so they are OR'd with the tenant-isolation policies above. They are SELECT-only and
 * have no WITH CHECK: they can reveal a user's OWN memberships and the tenants those point at, and can never
 * grant a write or expose anyone else's rows.
 *
 * The tenants policy reads tenant_users, which is itself under RLS for the same session, so tenant_users needs
 * the matching self-visibility policy; without it the subquery would see nothing.
 */
export interface DiscoveryPolicy {
  table: string;
  name: string;
  using: string;
}

export const DISCOVERY_POLICIES: readonly DiscoveryPolicy[] = [
  {
    table: 'tenant_users',
    name: 'rls_tenant_users_self_discovery',
    using: `user_id = ${currentUserPredicate}`,
  },
  {
    table: 'tenants',
    name: 'rls_tenants_member_discovery',
    using: `id IN (SELECT tenant_id FROM tenant_users WHERE user_id = ${currentUserPredicate})`,
  },
  // Invitation REDEMPTION: whoever holds the secret token (hashed by the server, set as app.invite_token_hash for
  // one transaction) can see that single invitation, and the tenant it points at, before they belong to any tenant.
  {
    table: 'tenant_invitations',
    name: 'rls_tenant_invitations_redeem',
    using: `token_hash = ${inviteTokenPredicate}`,
  },
  {
    table: 'tenants',
    name: 'rls_tenants_invite_redeem',
    using: `id IN (SELECT tenant_id FROM tenant_invitations WHERE token_hash = ${inviteTokenPredicate})`,
  },
];

/** ENABLE + FORCE row level security and the tenant-isolation policy for every tenant-bound table. */
export function buildRlsSql(
  tables: readonly RlsTable[] = RLS_TENANT_TABLES,
  discovery: readonly DiscoveryPolicy[] = DISCOVERY_POLICIES
): string {
  const alters = tables
    .map(
      ({ table }) =>
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;\n  ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`
    )
    .join('\n  ');

  const policies = tables
    .map(({ table, tenantColumn }) => {
      const name = rlsPolicyName(table);
      const predicate = tenantPredicate(tenantColumn);
      return `    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${name}'
    ) THEN
      CREATE POLICY ${name} ON ${table}
        FOR ALL
        USING (${predicate})
        WITH CHECK (${predicate});
    END IF;`;
    })
    .join('\n\n');

  // Permissive, SELECT-only, no WITH CHECK: see DISCOVERY_POLICIES
  const discoveryPolicies = discovery
    .map(
      ({ table, name, using }) => `    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${name}'
    ) THEN
      CREATE POLICY ${name} ON ${table}
        FOR SELECT
        USING (${using});
    END IF;`
    )
    .join('\n\n');

  return `
  ${alters}

  DO $$
  BEGIN
${policies}

${discoveryPolicies}
  END
  $$;
`;
}

/** Complete, idempotent schema bootstrap executed by initDb(). */
export function buildSchemaSql(): string {
  return `${TABLES_SQL}\n${buildRlsSql()}`;
}
