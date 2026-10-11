import { TENANT_ROLES } from '../src/utils/roles';

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
];

export const rlsPolicyName = (table: string): string => `rls_${table}_tenant_isolation`;

const tenantPredicate = (column: string): string =>
  `${column} = NULLIF(current_setting('app.current_tenant_id', true), '')`;

const roleList = TENANT_ROLES.map((r) => `'${r}'`).join(', ');

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
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS license_tier VARCHAR(64) DEFAULT 'FOUNDATIONAL';
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS annual_price NUMERIC DEFAULT 3500;

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

/** ENABLE + FORCE row level security and the tenant-isolation policy for every tenant-bound table. */
export function buildRlsSql(tables: readonly RlsTable[] = RLS_TENANT_TABLES): string {
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

  return `
  ${alters}

  DO $$
  BEGIN
${policies}
  END
  $$;
`;
}

/** Complete, idempotent schema bootstrap executed by initDb(). */
export function buildSchemaSql(): string {
  return `${TABLES_SQL}\n${buildRlsSql()}`;
}
