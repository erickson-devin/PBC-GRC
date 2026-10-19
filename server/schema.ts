import { TENANT_ROLES } from '../src/utils/roles';
import { CMMC_ASSET_CATEGORIES } from '../src/data/telemetry/assetScope';
import { FIPS_STANDARDS, FIPS_STATUSES } from '../src/data/telemetry/fipsValidation';
import { VM_FINDING_STATUSES, VM_POAM_STATUSES, VM_RUN_STATUSES, VM_SEVERITIES, VM_SOURCE_KINDS, VM_TOKEN_SCOPES, VM_VULN_SOURCES } from '../src/types/vm';

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
  { table: 'vm_service_tokens', tenantColumn: 'tenant_id' },
  { table: 'vm_sources', tenantColumn: 'tenant_id' },
  { table: 'vm_runs', tenantColumn: 'tenant_id' },
  { table: 'vm_findings', tenantColumn: 'tenant_id' },
  { table: 'vm_sightings', tenantColumn: 'tenant_id' },
  { table: 'vm_poam_items', tenantColumn: 'tenant_id' },
];

export const rlsPolicyName = (table: string): string => `rls_${table}_tenant_isolation`;

const tenantPredicate = (column: string): string =>
  `${column} = NULLIF(current_setting('app.current_tenant_id', true), '')`;

const roleList = TENANT_ROLES.map((r) => `'${r}'`).join(', ');
const fipsStatusList = FIPS_STATUSES.map((s) => `'${s}'`).join(', ');
const fipsStandardList = FIPS_STANDARDS.map((s) => `'${s}'`).join(', ');
const assetCategoryList = CMMC_ASSET_CATEGORIES.map((c) => `'${c}'`).join(', ');
const vmSourceKindList = VM_SOURCE_KINDS.map((k) => `'${k}'`).join(', ');
const vmScopeList = VM_TOKEN_SCOPES.map((s) => `'${s}'`).join(', ');
const vmRunStatusList = VM_RUN_STATUSES.map((s) => `'${s}'`).join(', ');
const vmSeverityList = VM_SEVERITIES.map((s) => `'${s}'`).join(', ');
const vmFindingStatusList = VM_FINDING_STATUSES.map((s) => `'${s}'`).join(', ');
const vmPoamStatusList = VM_POAM_STATUSES.map((s) => `'${s}'`).join(', ');
const vmVulnSourceList = VM_VULN_SOURCES.map((s) => `'${s}'`).join(', ');

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
      CONSTRAINT ssp_import_jobs_framework_check CHECK (framework IN ('CMMC_L1','CMMC_L2','NIST_800_53_REV5'))
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

  -- Phase 3 (NIST SP 800-53 Rev. 5): imports can target the 800-53 catalog, measured against one SP 800-53B baseline.
  -- A control id such as AC-2(1) fits staged_controls.control_id (VARCHAR(64)) unchanged.
  ALTER TABLE ssp_import_jobs ADD COLUMN IF NOT EXISTS baseline VARCHAR(16);
  ALTER TABLE ssp_import_jobs DROP CONSTRAINT IF EXISTS ssp_import_jobs_framework_check;
  ALTER TABLE ssp_import_jobs ADD CONSTRAINT ssp_import_jobs_framework_check
    CHECK (framework IN ('CMMC_L1','CMMC_L2','NIST_800_53_REV5'));
  ALTER TABLE ssp_import_jobs DROP CONSTRAINT IF EXISTS ssp_import_jobs_baseline_check;
  ALTER TABLE ssp_import_jobs ADD CONSTRAINT ssp_import_jobs_baseline_check
    CHECK (baseline IS NULL OR baseline IN ('LOW','MODERATE','HIGH'));

  -- Vulnerability management (docs/VULNERABILITY_MANAGEMENT.md). An external exporter PUSHES normalized scanner output
  -- with a tenant-scoped service token. A finding is closed (RESOLVED) only by machine confirmation; a person may record
  -- RISK_ACCEPTED or FALSE_POSITIVE with a justification. Keys between tenant tables include tenant_id: PostgreSQL checks
  -- foreign keys WITHOUT row-level security, so a key on the id alone would accept another tenant's row.
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS agent_ids JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE enclave_assets ADD COLUMN IF NOT EXISTS last_vuln_seen_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS unq_enclave_assets_tenant_id ON enclave_assets(tenant_id, id);

  -- Machine credentials for the exporter. Like tenant_invitations, only the SHA-256 hash of the token is stored.
  CREATE TABLE IF NOT EXISTS vm_service_tokens (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      token_prefix VARCHAR(16) NOT NULL DEFAULT '',
      scopes TEXT[] NOT NULL DEFAULT '{}',
      created_by VARCHAR(255) NOT NULL,
      created_by_user_id VARCHAR(128),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT unq_vm_service_token_hash UNIQUE (token_hash),
      CONSTRAINT vm_service_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT vm_service_tokens_scopes_check CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY[${vmScopeList}]::text[])
  );
  CREATE INDEX IF NOT EXISTS idx_vm_service_tokens_tenant ON vm_service_tokens(tenant_id);

  CREATE TABLE IF NOT EXISTS vm_sources (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      label VARCHAR(255) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      expected_interval_minutes INTEGER NOT NULL DEFAULT 1440,
      last_run_id VARCHAR(64),
      last_run_at TIMESTAMPTZ,
      stale_since TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_vm_sources_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT vm_sources_interval_check CHECK (expected_interval_minutes BETWEEN 5 AND 43200)
  );
  -- New scanner kinds are added to VM_SOURCE_KINDS (src/types/vm.ts); the check is re-created so older databases accept them.
  ALTER TABLE vm_sources DROP CONSTRAINT IF EXISTS vm_sources_kind_check;
  ALTER TABLE vm_sources ADD CONSTRAINT vm_sources_kind_check CHECK (kind IN (${vmSourceKindList}));
  CREATE UNIQUE INDEX IF NOT EXISTS unq_vm_sources_label ON vm_sources(tenant_id, lower(label));

  CREATE TABLE IF NOT EXISTS vm_runs (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      source_id VARCHAR(64) NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      collected_at TIMESTAMPTZ,
      exporter_name VARCHAR(64) NOT NULL DEFAULT '',
      exporter_version VARCHAR(64) NOT NULL DEFAULT '',
      host_count INTEGER NOT NULL DEFAULT 0,
      finding_count INTEGER NOT NULL DEFAULT 0,
      raw_path TEXT NOT NULL,
      raw_sha256 VARCHAR(64) NOT NULL,
      raw_bytes BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
      error TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      CONSTRAINT unq_vm_runs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT unq_vm_runs_raw_sha256 UNIQUE (tenant_id, raw_sha256),
      CONSTRAINT fk_vm_runs_source FOREIGN KEY (tenant_id, source_id) REFERENCES vm_sources (tenant_id, id),
      CONSTRAINT vm_runs_status_check CHECK (status IN (${vmRunStatusList})),
      CONSTRAINT vm_runs_counts_check CHECK (host_count >= 0 AND finding_count >= 0)
  );
  CREATE INDEX IF NOT EXISTS idx_vm_runs_source ON vm_runs (tenant_id, source_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vm_runs_status ON vm_runs (tenant_id, status);

  -- Global reference data (not tenant-bound, no RLS), like control_mappings. Tenant ingest may only INSERT a
  -- missing vuln_id (source INGEST) and never UPDATEs one. title, cvss_v3, severity, published_at, kev and epss are written only
  -- by the feed job or a platform administrator, which overwrite INGEST rows. Exporter-reported details live in
  -- vm_sightings.detail and vm_findings.severity.
  CREATE TABLE IF NOT EXISTS vm_vulns (
      vuln_id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      cvss_v3 NUMERIC(3,1),
      severity VARCHAR(16),
      published_at TIMESTAMPTZ,
      kev BOOLEAN NOT NULL DEFAULT FALSE,
      kev_added_at TIMESTAMPTZ,
      epss NUMERIC(5,4),
      epss_percentile NUMERIC(5,4),
      refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      source VARCHAR(16) NOT NULL DEFAULT 'INGEST',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT vm_vulns_id_check CHECK (vuln_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
      CONSTRAINT vm_vulns_cvss_check CHECK (cvss_v3 IS NULL OR (cvss_v3 BETWEEN 0 AND 10)),
      CONSTRAINT vm_vulns_severity_check CHECK (severity IS NULL OR severity IN (${vmSeverityList})),
      CONSTRAINT vm_vulns_epss_check CHECK ((epss IS NULL OR epss BETWEEN 0 AND 1) AND (epss_percentile IS NULL OR epss_percentile BETWEEN 0 AND 1)),
      CONSTRAINT vm_vulns_source_check CHECK (source IN (${vmVulnSourceList}))
  );

  CREATE TABLE IF NOT EXISTS vm_findings (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      asset_id VARCHAR(64) NOT NULL,
      vuln_id VARCHAR(64) NOT NULL REFERENCES vm_vulns(vuln_id),
      status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      severity VARCHAR(16) NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_run_id VARCHAR(64),
      sla_due_at TIMESTAMPTZ,
      package_name VARCHAR(255) NOT NULL DEFAULT '',
      package_version VARCHAR(128) NOT NULL DEFAULT '',
      fixed_version VARCHAR(128),
      justification TEXT,
      decided_by VARCHAR(255),
      decided_by_user_id VARCHAR(128),
      decided_at TIMESTAMPTZ,
      CONSTRAINT unq_vm_finding UNIQUE (tenant_id, asset_id, vuln_id),
      CONSTRAINT unq_vm_findings_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_vm_findings_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_vm_findings_resolved_run FOREIGN KEY (tenant_id, resolved_run_id) REFERENCES vm_runs (tenant_id, id),
      CONSTRAINT vm_findings_status_check CHECK (status IN (${vmFindingStatusList})),
      CONSTRAINT vm_findings_severity_check CHECK (severity IN (${vmSeverityList})),
      -- RESOLVED is machine-confirmed: it always names the run that no longer reported the finding.
      CONSTRAINT vm_findings_resolved_check CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL AND resolved_run_id IS NOT NULL)),
      CONSTRAINT vm_findings_decision_check CHECK (status NOT IN ('RISK_ACCEPTED', 'FALSE_POSITIVE') OR (justification IS NOT NULL AND btrim(justification) <> '' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
      CONSTRAINT vm_findings_seen_check CHECK (last_seen_at >= first_seen_at)
  );
  CREATE INDEX IF NOT EXISTS idx_vm_findings_tenant_status ON vm_findings (tenant_id, status, severity);
  CREATE INDEX IF NOT EXISTS idx_vm_findings_asset ON vm_findings (tenant_id, asset_id);
  CREATE INDEX IF NOT EXISTS idx_vm_findings_vuln ON vm_findings (vuln_id);
  CREATE INDEX IF NOT EXISTS idx_vm_findings_sla ON vm_findings (tenant_id, sla_due_at) WHERE status = 'OPEN';

  CREATE TABLE IF NOT EXISTS vm_sightings (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      finding_id VARCHAR(64) NOT NULL,
      run_id VARCHAR(64) NOT NULL,
      source_id VARCHAR(64) NOT NULL,
      reported_severity VARCHAR(32),
      reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT unq_vm_sighting UNIQUE (tenant_id, run_id, finding_id),
      CONSTRAINT fk_vm_sightings_finding FOREIGN KEY (tenant_id, finding_id) REFERENCES vm_findings (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_vm_sightings_run FOREIGN KEY (tenant_id, run_id) REFERENCES vm_runs (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_vm_sightings_source FOREIGN KEY (tenant_id, source_id) REFERENCES vm_sources (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_vm_sightings_finding ON vm_sightings (tenant_id, finding_id, reported_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vm_sightings_run ON vm_sightings (run_id);

  CREATE TABLE IF NOT EXISTS vm_poam_items (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      finding_id VARCHAR(64),
      control_id VARCHAR(64) NOT NULL,
      weakness TEXT NOT NULL,
      mitigation TEXT NOT NULL DEFAULT '',
      owner VARCHAR(255) NOT NULL DEFAULT '',
      scheduled_completion DATE,
      status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      created_by VARCHAR(255) NOT NULL DEFAULT 'system:vm-worker',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_vm_poam_items_finding FOREIGN KEY (tenant_id, finding_id) REFERENCES vm_findings (tenant_id, id) ON DELETE SET NULL (finding_id),
      CONSTRAINT vm_poam_items_status_check CHECK (status IN (${vmPoamStatusList}))
  );
  CREATE INDEX IF NOT EXISTS idx_vm_poam_items_tenant ON vm_poam_items (tenant_id, status);
  CREATE INDEX IF NOT EXISTS idx_vm_poam_items_finding ON vm_poam_items (tenant_id, finding_id);

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

  -- Dual-framework crosswalk (SP 800-171 Rev. 2 / CMMC <-> SP 800-53 Rev. 5), idempotent.
  -- provenance: where a row comes from (empty for the hand-curated rows).
  ALTER TABLE control_mappings ADD COLUMN IF NOT EXISTS provenance TEXT DEFAULT '';
  -- Lookups run from either side of a mapping.
  CREATE INDEX IF NOT EXISTS idx_control_mappings_target ON control_mappings (target_framework, target_control_id);
  CREATE INDEX IF NOT EXISTS idx_control_mappings_source ON control_mappings (source_framework, source_control_id);
  -- Only EXACT / EQUIVALENT mappings carry evidence between frameworks; SUBSET / SUPERSET are references.
  UPDATE control_mappings SET mapping_type = 'EQUIVALENT' WHERE mapping_type IS NULL OR mapping_type NOT IN ('EXACT', 'EQUIVALENT', 'SUBSET', 'SUPERSET');
  ALTER TABLE control_mappings DROP CONSTRAINT IF EXISTS control_mappings_mapping_type_check;
  ALTER TABLE control_mappings ADD CONSTRAINT control_mappings_mapping_type_check CHECK (mapping_type IN ('EXACT', 'EQUIVALENT', 'SUBSET', 'SUPERSET'));
`;

const currentUserPredicate = "NULLIF(current_setting('app.current_user_id', true), '')";
const inviteTokenPredicate = "NULLIF(current_setting('app.invite_token_hash', true), '')";
const vmTokenPredicate = "NULLIF(current_setting('app.vm_token_hash', true), '')";
const vmSchedulerPredicate = "NULLIF(current_setting('app.vm_scheduler', true), '')";

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
  // Service-token lookup: whoever presents a token (hashed by the server, set as app.vm_token_hash for one
  // transaction) can see that single vm_service_tokens row, and nothing else, before any tenant context exists.
  {
    table: 'vm_service_tokens',
    name: 'rls_vm_service_tokens_lookup',
    using: `token_hash = ${vmTokenPredicate}`,
  },
  // Scheduler enumeration: the in-process VM scheduler (and only it) sets app.vm_scheduler = 'on' for one
  // transaction to list (tenant_id, source_id, last_run_at, expected_interval_minutes) across tenants. Every
  // write it then performs happens under that tenant's app.current_tenant_id.
  {
    table: 'vm_sources',
    name: 'rls_vm_sources_scheduler',
    using: `${vmSchedulerPredicate} = 'on'`,
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
