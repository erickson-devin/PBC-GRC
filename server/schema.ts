import { TENANT_ROLES } from '../src/utils/roles';
import { CMMC_ASSET_CATEGORIES } from '../src/data/telemetry/assetScope';
import { FIPS_STANDARDS, FIPS_STATUSES } from '../src/data/telemetry/fipsValidation';
import { CONTROL_CHANGE_SOURCES } from '../src/types/controlHistory';
import { OBJECTIVE_CHANGE_SOURCES, OBJECTIVE_STATUSES } from '../src/types/controlObjectives';
import { SSP_METADATA_FIELDS, SSP_METADATA_MAX_BYTES } from '../src/types/sspMetadata';
import { STACK_PROFILE_ENUM_KEYS, STACK_PROFILE_MAX_BYTES } from '../src/data/stackProfileSchema';
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
  { table: 'control_assessment_events', tenantColumn: 'tenant_id' },
  { table: 'evidence_metadata', tenantColumn: 'tenant_id' },
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
  { table: 'programs', tenantColumn: 'tenant_id' },
  { table: 'control_objectives', tenantColumn: 'tenant_id' },
  { table: 'control_objective_events', tenantColumn: 'tenant_id' },
  { table: 'program_events', tenantColumn: 'tenant_id' },
  { table: 'program_assets', tenantColumn: 'tenant_id' },
  { table: 'program_ssp_metadata', tenantColumn: 'tenant_id' },
];

export const rlsPolicyName = (table: string): string => `rls_${table}_tenant_isolation`;

/**
 * Tables whose rows belong to exactly one PROGRAM of their tenant (an authorization boundary, see server/programs.ts). Each is also in
 * RLS_TENANT_TABLES; on top of the tenant policy it gets a RESTRICTIVE policy tying rows to `app.current_program_id`, so the database
 * itself keeps program B from reading or overwriting program A, whatever a query's WHERE clause says.
 */
export const RLS_PROGRAM_TABLES: readonly string[] = [
  'control_assessments',
  'control_assessment_events',
  'evidence_metadata',
  'ssp_import_jobs',
  'staged_controls',
  'vm_poam_items',
  'control_objectives',
  'control_objective_events',
  'program_events',
  'program_assets',
  'program_ssp_metadata',
];

/**
 * The legacy tables whose program_id column was added nullable and is finalized (validated, NOT NULL) once every row has a program.
 * Must equal PROGRAM_SCOPED_TABLES in server/programs.ts (not imported: that file imports this one). The two objective tables and program_events
 * are NOT NULL from creation and are not listed.
 */
export const PROGRAM_BACKFILL_TABLES = [
  'control_assessments',
  'control_assessment_events',
  'evidence_metadata',
  'ssp_import_jobs',
  'staged_controls',
  'vm_poam_items',
] as const;

export const rlsProgramPolicyName = (table: string): string => `rls_${table}_program_isolation`;

const tenantPredicate = (column: string): string =>
  `${column} = NULLIF(current_setting('app.current_tenant_id', true), '')`;

const roleList = TENANT_ROLES.map((r) => `'${r}'`).join(', ');
const fipsStatusList = FIPS_STATUSES.map((s) => `'${s}'`).join(', ');
const fipsStandardList = FIPS_STANDARDS.map((s) => `'${s}'`).join(', ');
const assetCategoryList = CMMC_ASSET_CATEGORIES.map((c) => `'${c}'`).join(', ');
const controlChangeSourceList = CONTROL_CHANGE_SOURCES.map((s) => `'${s}'`).join(', ');
const objectiveStatusList = OBJECTIVE_STATUSES.map((s) => `'${s}'`).join(', ');
const objectiveChangeSourceList = OBJECTIVE_CHANGE_SOURCES.map((s) => `'${s}'`).join(', ');
const vmSourceKindList =VM_SOURCE_KINDS.map((k) => `'${k}'`).join(', ');
const vmScopeList = VM_TOKEN_SCOPES.map((s) => `'${s}'`).join(', ');
const vmRunStatusList = VM_RUN_STATUSES.map((s) => `'${s}'`).join(', ');
const vmSeverityList = VM_SEVERITIES.map((s) => `'${s}'`).join(', ');
const vmFindingStatusList = VM_FINDING_STATUSES.map((s) => `'${s}'`).join(', ');
const vmPoamStatusList = VM_POAM_STATUSES.map((s) => `'${s}'`).join(', ');
const vmVulnSourceList = VM_VULN_SOURCES.map((s) => `'${s}'`).join(', ');

/** The framework ids a program may carry: the registry ids (src/data/frameworks/frameworkRegistry.ts), canonical spelling only. */
export const PROGRAM_FRAMEWORK_IDS = ['CMMC_L1', 'CMMC_L2', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'] as const;
const programFrameworkList = PROGRAM_FRAMEWORK_IDS.map((f) => `'${f}'`).join(', ');
const sspMetadataFieldList = SSP_METADATA_FIELDS.map((f) => `'${f}'`).join(', ');
const stackProfileKeyList = [...STACK_PROFILE_ENUM_KEYS, 'odpParams'].map((k) => `'${k}'`).join(', ');

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
  -- Enclave stack profile (issue #84): the five tool choices and ODP parameters. Keys and size are pinned by the CHECK below.
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stack_profile JSONB;
  ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_stack_profile_check;
  ALTER TABLE tenants ADD CONSTRAINT tenants_stack_profile_check CHECK (stack_profile IS NULL OR (jsonb_typeof(stack_profile) = 'object' AND (stack_profile - ARRAY[${stackProfileKeyList}]) = '{}'::jsonb AND octet_length(stack_profile::text) <= ${STACK_PROFILE_MAX_BYTES}));

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

  -- Notes may hold CUI, so an event records only their SHA-256 and length, never the text.
  -- No foreign key to control_assessments: the history outlives the row it describes.
  CREATE TABLE IF NOT EXISTS control_assessment_events (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      source VARCHAR(16) NOT NULL,
      actor VARCHAR(255) NOT NULL,
      actor_user_id VARCHAR(128),
      old_status VARCHAR(32),
      new_status VARCHAR(32) NOT NULL,
      old_role VARCHAR(128),
      new_role VARCHAR(128) NOT NULL,
      notes_changed BOOLEAN NOT NULL,
      old_notes_sha256 CHAR(64),
      new_notes_sha256 CHAR(64) NOT NULL,
      old_notes_length INTEGER,
      new_notes_length INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT control_assessment_events_sha_check CHECK ((old_notes_sha256 IS NULL OR old_notes_sha256 ~ '^[0-9a-f]{64}$') AND new_notes_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT control_assessment_events_length_check CHECK ((old_notes_length IS NULL OR old_notes_length >= 0) AND new_notes_length >= 0)
  );
  ALTER TABLE control_assessment_events DROP CONSTRAINT IF EXISTS control_assessment_events_source_check;
  ALTER TABLE control_assessment_events ADD CONSTRAINT control_assessment_events_source_check CHECK (source IN (${controlChangeSourceList}));
  CREATE INDEX IF NOT EXISTS idx_control_assessment_events_control ON control_assessment_events (tenant_id, control_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_control_assessment_events_created ON control_assessment_events (tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS evidence_metadata (
      id VARCHAR(64) PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_size BIGINT NOT NULL,
      mime_type VARCHAR(128) NOT NULL,
      gcs_path TEXT NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      sync_status VARCHAR(32) DEFAULT 'local_storage',
      description TEXT,
      uploaded_by VARCHAR(255),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE evidence_metadata ALTER COLUMN sync_status SET DEFAULT 'local_storage';

  -- ssp_documents had no reader or writer (issue #25). It is dropped where it is empty; a table that still holds rows is kept with
  -- FORCE RLS restored (the probe has to lift FORCE: with no tenant context FORCE hides every row, so "empty" would always be true).
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ssp_documents' AND relkind = 'r' AND relnamespace = current_schema()::regnamespace) THEN
      ALTER TABLE ssp_documents NO FORCE ROW LEVEL SECURITY;
      IF NOT EXISTS (SELECT 1 FROM ssp_documents) THEN
        DROP TABLE ssp_documents;
      ELSE
        ALTER TABLE ssp_documents FORCE ROW LEVEL SECURITY;
        RAISE WARNING 'ssp_documents still holds rows and was not dropped';
      END IF;
    END IF;
  END
  $$;

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

  -- Local identities. Global, not tenant-bound: a person logs in first and
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

  -- Second factor (TOTP) and session revocation. token_version is bumped on a password change, a disable and an MFA
  -- reset; a session or pending token carrying an older version is rejected. totp_secret_enc is AES-256-GCM ciphertext
  -- (never the secret); recovery_code_hashes are keyed HMAC-SHA256 hex digests, never the codes.
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ;
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT;
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}';
  ALTER TABLE local_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_totp_secret_enc_check;
  ALTER TABLE local_users ADD CONSTRAINT local_users_totp_secret_enc_check CHECK (totp_secret_enc IS NULL OR totp_secret_enc ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$');
  ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_recovery_codes_check;
  ALTER TABLE local_users ADD CONSTRAINT local_users_recovery_codes_check CHECK (cardinality(recovery_code_hashes) <= 16 AND array_to_string(recovery_code_hashes, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$');
  ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_totp_confirm_check;
  ALTER TABLE local_users ADD CONSTRAINT local_users_totp_confirm_check CHECK (totp_confirmed_at IS NULL OR totp_secret_enc IS NOT NULL);

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
  ALTER TABLE vm_runs ADD COLUMN IF NOT EXISTS warning TEXT;

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
  -- Makes the worker's auto-created POA&M item unique per finding even across processes.
  CREATE UNIQUE INDEX IF NOT EXISTS unq_vm_poam_items_auto ON vm_poam_items (tenant_id, finding_id) WHERE created_by = 'system:vm-worker' AND finding_id IS NOT NULL;

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

  -- Programs (authorization boundaries), additive data layer: a tenant owns several programs, each with one framework (and, for
  -- NIST SP 800-53, one baseline). All program DDL lives here, after the VM and local_users blocks (tests pin their layout).
  -- program_id starts nullable at the column level (server/programs.ts backfills it lazily, per tenant, under that tenant's RLS context);
  -- the NOT VALID checks, the per-program unique key and the program row policies (buildProgramRlsSql) enforce it meanwhile, and
  -- buildProgramIdNotNullSql (the last step of buildSchemaSql) finalizes each table once none of its rows lacks a program.
  CREATE TABLE IF NOT EXISTS programs (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      framework_id VARCHAR(64) NOT NULL,
      baseline VARCHAR(16),
      system_boundary_summary TEXT NOT NULL DEFAULT '',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_programs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT programs_default_not_archived CHECK (NOT (is_default AND archived_at IS NOT NULL))
  );
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_framework_check;
  ALTER TABLE programs ADD CONSTRAINT programs_framework_check CHECK (framework_id IN (${programFrameworkList}));
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_baseline_check;
  ALTER TABLE programs ADD CONSTRAINT programs_baseline_check CHECK (baseline IS NULL OR (framework_id = 'NIST_800_53_REV5' AND baseline IN ('LOW', 'MODERATE', 'HIGH')));
  -- The privacy baseline (NIST SP 800-53B) is an immutable add-on to a NIST program's security baseline; false for every other program.
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS privacy_baseline BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_privacy_check;
  ALTER TABLE programs ADD CONSTRAINT programs_privacy_check CHECK (NOT privacy_baseline OR framework_id = 'NIST_800_53_REV5');
  -- Scope overlays (issue #22): booleans only, known keys only, only true is stored; NIST SP 800-53 programs only, and a privacy
  -- program keeps its PII controls. Set at creation, changed by owner/admin (each change is a program_events row).
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS scoping JSONB NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_scoping_check;
  ALTER TABLE programs ADD CONSTRAINT programs_scoping_check CHECK (jsonb_typeof(scoping) = 'object' AND (scoping - ARRAY['nonNetworkedOnly', 'noWireless', 'noMobileDevices', 'noPiiProcessing']) = '{}'::jsonb AND NOT jsonb_path_exists(scoping, '$.* ? (@ != true)'));
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_scoping_privacy_check;
  ALTER TABLE programs ADD CONSTRAINT programs_scoping_privacy_check CHECK (NOT (privacy_baseline AND scoping ? 'noPiiProcessing'));
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_scoping_framework_check;
  ALTER TABLE programs ADD CONSTRAINT programs_scoping_framework_check CHECK (scoping = '{}'::jsonb OR framework_id = 'NIST_800_53_REV5');
  -- The program that receives the tenant's vulnerability data (issue #21): at most one per tenant, a live CMMC program.
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS vm_target BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE programs DROP CONSTRAINT IF EXISTS programs_vm_target_check;
  ALTER TABLE programs ADD CONSTRAINT programs_vm_target_check CHECK (NOT vm_target OR (archived_at IS NULL AND framework_id IN ('CMMC_L1', 'CMMC_L2')));
  CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_vm_target ON programs (tenant_id) WHERE vm_target;
  -- One default program per tenant, and program names are unique per tenant ignoring case.
  CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_default ON programs (tenant_id) WHERE is_default;
  CREATE UNIQUE INDEX IF NOT EXISTS unq_programs_name ON programs (tenant_id, lower(name));

  ALTER TABLE control_assessments ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
  ALTER TABLE control_assessment_events ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
  ALTER TABLE evidence_metadata ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
  ALTER TABLE ssp_import_jobs ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
  ALTER TABLE staged_controls ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);
  ALTER TABLE vm_poam_items ADD COLUMN IF NOT EXISTS program_id VARCHAR(64);

  -- Composite foreign keys, added once (a re-run finds the constraint and skips). control_assessment_events deliberately has NO key:
  -- the history outlives the control row and its program. Files on disk, vault documents and the compliance record are RESTRICT.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_control_assessments_program' AND conrelid = 'control_assessments'::regclass) THEN
      ALTER TABLE control_assessments ADD CONSTRAINT fk_control_assessments_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_staged_controls_program' AND conrelid = 'staged_controls'::regclass) THEN
      ALTER TABLE staged_controls ADD CONSTRAINT fk_staged_controls_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_evidence_metadata_program' AND conrelid = 'evidence_metadata'::regclass) THEN
      ALTER TABLE evidence_metadata ADD CONSTRAINT fk_evidence_metadata_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ssp_import_jobs_program' AND conrelid = 'ssp_import_jobs'::regclass) THEN
      ALTER TABLE ssp_import_jobs ADD CONSTRAINT fk_ssp_import_jobs_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vm_poam_items_program' AND conrelid = 'vm_poam_items'::regclass) THEN
      ALTER TABLE vm_poam_items ADD CONSTRAINT fk_vm_poam_items_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE RESTRICT;
    END IF;
  END
  $$;

  CREATE INDEX IF NOT EXISTS idx_control_assessment_events_program ON control_assessment_events (tenant_id, program_id, control_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_evidence_metadata_program ON evidence_metadata (tenant_id, program_id, uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ssp_import_jobs_program ON ssp_import_jobs (tenant_id, program_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vm_poam_items_program ON vm_poam_items (tenant_id, program_id, status);
  -- The per-program key replaces the old (tenant_id, control_id) one: the same control id holds one row per program. Every ON CONFLICT
  -- on control_assessments names (tenant_id, program_id, control_id) (server/controlAssessments.ts, server/routes/controls.ts).
  CREATE UNIQUE INDEX IF NOT EXISTS unq_control_assessments_program_control ON control_assessments (tenant_id, program_id, control_id);
  ALTER TABLE control_assessments DROP CONSTRAINT IF EXISTS unq_tenant_control;

  -- program_id is required on every new or changed row. Each check is added unvalidated: it applies to writes from now on without
  -- scanning the table (a plain NOT NULL column constraint scans every row whatever the row policies say, and would stop the boot on a
  -- row that is not backfilled yet). Validating them is buildProgramIdNotNullSql's job; a table it has already finalized (column
  -- NOT NULL, check dropped) must not get its check back, or every boot would scan it again.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'control_assessments_program_required' AND conrelid = 'control_assessments'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'control_assessments'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE control_assessments ADD CONSTRAINT control_assessments_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'control_assessment_events_program_required' AND conrelid = 'control_assessment_events'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'control_assessment_events'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE control_assessment_events ADD CONSTRAINT control_assessment_events_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_metadata_program_required' AND conrelid = 'evidence_metadata'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'evidence_metadata'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE evidence_metadata ADD CONSTRAINT evidence_metadata_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ssp_import_jobs_program_required' AND conrelid = 'ssp_import_jobs'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ssp_import_jobs'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE ssp_import_jobs ADD CONSTRAINT ssp_import_jobs_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staged_controls_program_required' AND conrelid = 'staged_controls'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'staged_controls'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE staged_controls ADD CONSTRAINT staged_controls_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vm_poam_items_program_required' AND conrelid = 'vm_poam_items'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'vm_poam_items'::regclass AND attname = 'program_id' AND attnotnull) THEN
      ALTER TABLE vm_poam_items ADD CONSTRAINT vm_poam_items_program_required CHECK (program_id IS NOT NULL) NOT VALID;
    END IF;
  END
  $$;

  -- Assessment objectives (NIST SP 800-171A / 800-53A): the status, narrative and evidence links of one objective in one program.
  -- New tables, so program_id is NOT NULL from the start (no legacy rows to backfill) and the program key is inline.
  CREATE TABLE IF NOT EXISTS control_objectives (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      program_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      objective_id VARCHAR(96) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED',
      narrative TEXT NOT NULL DEFAULT '',
      linked_evidence_ids TEXT[] NOT NULL DEFAULT '{}',
      updated_by VARCHAR(255),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unq_control_objectives_program_objective UNIQUE (tenant_id, program_id, objective_id),
      CONSTRAINT fk_control_objectives_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE
  );
  ALTER TABLE control_objectives DROP CONSTRAINT IF EXISTS control_objectives_status_check;
  ALTER TABLE control_objectives ADD CONSTRAINT control_objectives_status_check CHECK (status IN (${objectiveStatusList}));
  CREATE INDEX IF NOT EXISTS idx_control_objectives_control ON control_objectives (tenant_id, program_id, control_id);

  -- The narrative may hold CUI, so an event records only its SHA-256 and length, never the text.
  -- No foreign key to control_objectives or programs: the history outlives the row and its program.
  CREATE TABLE IF NOT EXISTS control_objective_events (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      program_id VARCHAR(64) NOT NULL,
      control_id VARCHAR(64) NOT NULL,
      objective_id VARCHAR(96) NOT NULL,
      source VARCHAR(16) NOT NULL,
      actor VARCHAR(255) NOT NULL,
      actor_user_id VARCHAR(128),
      old_status VARCHAR(16),
      new_status VARCHAR(16) NOT NULL,
      narrative_changed BOOLEAN NOT NULL,
      old_narrative_sha256 CHAR(64),
      new_narrative_sha256 CHAR(64) NOT NULL,
      old_narrative_length INTEGER,
      new_narrative_length INTEGER NOT NULL,
      evidence_changed BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT control_objective_events_sha_check CHECK ((old_narrative_sha256 IS NULL OR old_narrative_sha256 ~ '^[0-9a-f]{64}$') AND new_narrative_sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT control_objective_events_length_check CHECK ((old_narrative_length IS NULL OR old_narrative_length >= 0) AND new_narrative_length >= 0)
  );
  ALTER TABLE control_objective_events DROP CONSTRAINT IF EXISTS control_objective_events_source_check;
  ALTER TABLE control_objective_events ADD CONSTRAINT control_objective_events_source_check CHECK (source IN (${objectiveChangeSourceList}));
  CREATE INDEX IF NOT EXISTS idx_control_objective_events_objective ON control_objective_events (tenant_id, program_id, objective_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_control_objective_events_created ON control_objective_events (tenant_id, created_at);

  -- Program events (issues #21, #22): scoping and VM-target changes. Booleans and ids only, never a name or a note.
  -- No foreign key to programs: the history outlives the program. program_id is NOT NULL from creation (nothing to backfill).
  CREATE TABLE IF NOT EXISTS program_events (
      id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
      tenant_id VARCHAR(64) NOT NULL,
      program_id VARCHAR(64) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      actor VARCHAR(255) NOT NULL,
      actor_user_id VARCHAR(128),
      old_value JSONB,
      new_value JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE program_events DROP CONSTRAINT IF EXISTS program_events_kind_check;
  ALTER TABLE program_events ADD CONSTRAINT program_events_kind_check CHECK (kind IN ('scoping_set', 'scoping_changed', 'vm_target_set', 'vm_target_cleared', 'assets_changed', 'ssp_metadata_changed'));
  CREATE INDEX IF NOT EXISTS idx_program_events_program ON program_events (tenant_id, program_id, created_at DESC);

  -- Boundary asset membership (issue #26): the assets a program declares inside its boundary. Assets stay tenant-wide
  -- (enclave_assets); one asset may belong to several programs. Ids only: never a host name, address or note.
  CREATE TABLE IF NOT EXISTS program_assets (
      tenant_id VARCHAR(64) NOT NULL,
      program_id VARCHAR(64) NOT NULL,
      asset_id VARCHAR(64) NOT NULL,
      added_by VARCHAR(255),
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pk_program_assets PRIMARY KEY (tenant_id, program_id, asset_id),
      CONSTRAINT fk_program_assets_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_program_assets_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES enclave_assets (tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_program_assets_asset ON program_assets (tenant_id, asset_id);

  -- Password history (IA.L2-3.5.8, issue #162): bcrypt hashes of a local account's previous passwords. Global identity data
  -- like local_users (no tenant_id, no row security), removed with the account. Never a password, only a hash.
  CREATE TABLE IF NOT EXISTS local_user_password_history (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      password_hash VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_local_user_password_history_user FOREIGN KEY (user_id) REFERENCES local_users (id) ON DELETE CASCADE,
      CONSTRAINT local_user_password_history_hash_check CHECK (password_hash ~ '^[$]2[aby][$][0-9]{2}[$]')
  );
  CREATE INDEX IF NOT EXISTS idx_local_user_password_history_user ON local_user_password_history (user_id, id DESC);

  -- Server-side sessions (AC.L2-3.1.10 / 3.1.11, issue #163): one row per signed token, keyed by the token's random sid,
  -- so a sign-out and an idle timeout can end a session before the token expires. Global identity data like local_users
  -- (no tenant_id, no row security), removed with the account. Never the token itself, only its random sid.
  CREATE TABLE IF NOT EXISTS local_sessions (
      sid VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      revoke_reason VARCHAR(32),
      mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
      CONSTRAINT fk_local_sessions_user FOREIGN KEY (user_id) REFERENCES local_users (id) ON DELETE CASCADE,
      CONSTRAINT local_sessions_sid_check CHECK (sid ~ '^[A-Za-z0-9_-]{16,64}$'),
      CONSTRAINT local_sessions_reason_check CHECK (revoke_reason IS NULL OR revoke_reason IN ('signed_out', 'idle', 'mfa_required', 'admin')),
      CONSTRAINT local_sessions_revoked_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_local_sessions_user ON local_sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_local_sessions_expires ON local_sessions (expires_at);

  -- Account events (issue #40): an append-only trail of security-relevant changes to local accounts (password and MFA
  -- changes, disable / enable, role changes, sign-out). Global like local_users (no tenant column, no row security):
  -- scope_tenant_id only names the tenant a role change applied to. No foreign key: the trail outlives the account.
  -- The details column holds ids and codes only; the check refuses anything containing an '@' (an email address).
  CREATE TABLE IF NOT EXISTS local_account_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_kind VARCHAR(8) NOT NULL,
      actor_user_id VARCHAR(64),
      target_user_id VARCHAR(64) NOT NULL,
      action VARCHAR(40) NOT NULL,
      scope_tenant_id VARCHAR(64),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT local_account_events_actor_check CHECK (actor_kind IN ('user', 'admin', 'cli', 'system')),
      CONSTRAINT local_account_events_action_check CHECK (action IN ('password_changed', 'password_reset', 'mfa_enrolled', 'mfa_reset', 'recovery_codes_regenerated', 'account_disabled', 'account_enabled', 'role_changed', 'member_removed', 'signed_out', 'session_revoked', 'step_up_failed')),
      CONSTRAINT local_account_events_details_check CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 2048 AND position('@' in details::text) = 0)
  );
  CREATE INDEX IF NOT EXISTS idx_local_account_events_at ON local_account_events (id DESC);
  CREATE INDEX IF NOT EXISTS idx_local_account_events_target ON local_account_events (target_user_id, id DESC);

  -- Append-only guard: UPDATE is always refused; DELETE only inside the retention sweep, which sets
  -- app.account_event_retention for its own transaction. TRUNCATE is refused outright. This guards against application
  -- bugs; the table owner can still drop the trigger.
  CREATE OR REPLACE FUNCTION local_account_events_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.account_event_retention', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'local_account_events is append-only' USING ERRCODE = '42501';
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_local_account_events_guard ON local_account_events;
  CREATE TRIGGER trg_local_account_events_guard BEFORE UPDATE OR DELETE ON local_account_events
      FOR EACH ROW EXECUTE FUNCTION local_account_events_guard();
  DROP TRIGGER IF EXISTS trg_local_account_events_no_truncate ON local_account_events;
  CREATE TRIGGER trg_local_account_events_no_truncate BEFORE TRUNCATE ON local_account_events
      FOR EACH STATEMENT EXECUTE FUNCTION local_account_events_guard();

  -- SSP metadata (issue #84): one row per program holding the SSP text fields (system name, environment, boundary and cloud
  -- service providers). The text is CUI: it is never logged and never written to program_events (digests only). Keys, value type and size
  -- are pinned by the CHECK below. Not backfilled: no row means the browser copy has not been uploaded yet.
  CREATE TABLE IF NOT EXISTS program_ssp_metadata (
      tenant_id VARCHAR(64) NOT NULL,
      program_id VARCHAR(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by VARCHAR(255),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pk_program_ssp_metadata PRIMARY KEY (tenant_id, program_id),
      CONSTRAINT fk_program_ssp_metadata_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs (tenant_id, id) ON DELETE CASCADE
  );
  ALTER TABLE program_ssp_metadata DROP CONSTRAINT IF EXISTS program_ssp_metadata_shape_check;
  ALTER TABLE program_ssp_metadata ADD CONSTRAINT program_ssp_metadata_shape_check CHECK (jsonb_typeof(metadata) = 'object' AND (metadata - ARRAY[${sspMetadataFieldList}]) = '{}'::jsonb AND NOT jsonb_path_exists(metadata, '$.* ? (@.type() != "string")') AND octet_length(metadata::text) <= ${SSP_METADATA_MAX_BYTES});
`;

const currentUserPredicate = "NULLIF(current_setting('app.current_user_id', true), '')";
const inviteTokenPredicate = "NULLIF(current_setting('app.invite_token_hash', true), '')";
const vmTokenPredicate = "NULLIF(current_setting('app.vm_token_hash', true), '')";
const vmSchedulerPredicate = "NULLIF(current_setting('app.vm_scheduler', true), '')";
const eventRetentionPredicate = "NULLIF(current_setting('app.event_retention', true), '')";

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
  // Retention sweep enumeration: the daily assessment-history sweep (and only it) sets app.event_retention = 'on' for one
  // transaction to list (tenant_id, id) of every program. The deletes then run under each program's own tenant and program settings.
  {
    table: 'programs',
    name: 'rls_programs_retention_sweep',
    using: `${eventRetentionPredicate} = 'on'`,
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

const programContext = "NULLIF(current_setting('app.current_program_id', true), '')";
const tenantContext = "NULLIF(current_setting('app.current_tenant_id', true), '')";
/** The tenant's default program: what a row that has no program yet (not backfilled) belongs to. Row-independent, so evaluated once per query. */
const tenantDefaultProgram = `(SELECT p.id FROM programs p WHERE p.tenant_id = ${tenantContext} AND p.is_default)`;

/**
 * The program-isolation policy of every RLS_PROGRAM_TABLES table, created once (a re-run finds it in pg_policies and skips).
 *
 * RESTRICTIVE: it is AND-ed with the tenant policy, so a row must belong to the session's tenant AND to the session's program.
 * USING: a row without a program counts as the tenant's default program's, so the lazy backfill (server/programs.ts) can still see and
 * adopt it. WITH CHECK: no such mapping, a written row must carry exactly the session's program. A session with no program set
 * (`app.current_program_id` unset or empty) sees no rows and cannot write: every path that touches these tables sets both settings.
 */
export function buildProgramRlsSql(tables: readonly string[] = RLS_PROGRAM_TABLES): string {
  const policies = tables
    .map((table) => {
      const name = rlsProgramPolicyName(table);
      return `    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${name}'
    ) THEN
      CREATE POLICY ${name} ON ${table}
        AS RESTRICTIVE
        FOR ALL
        USING (COALESCE(program_id, ${tenantDefaultProgram}) = ${programContext})
        WITH CHECK (program_id = ${programContext});
    END IF;`;
    })
    .join('\n\n');

  return `
  DO $$
  BEGIN
${policies}
  END
  $$;
`;
}

/**
 * Finalizes program_id on the legacy tables (issue #24): per table, VALIDATE the NOT VALID check, SET NOT NULL (PostgreSQL skips the
 * scan once a valid check proves it), then drop the now redundant check. VALIDATE scans the table whatever the row policies say, so a
 * row without a program raises check_violation: that table stays as it is (nullable, check NOT VALID) and the boot goes on. Only
 * check_violation is tolerated; any other error still fails the boot. The warning names the table, never row data.
 */
export function buildProgramIdNotNullSql(tables: readonly string[] = PROGRAM_BACKFILL_TABLES): string {
  const blocks = tables
    .map(
      (t) => `    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${t}_program_required' AND conrelid = '${t}'::regclass) THEN
      BEGIN
        ALTER TABLE ${t} VALIDATE CONSTRAINT ${t}_program_required;
        ALTER TABLE ${t} ALTER COLUMN program_id SET NOT NULL;
        ALTER TABLE ${t} DROP CONSTRAINT ${t}_program_required;
      EXCEPTION WHEN check_violation THEN
        RAISE WARNING '${t}: rows without a program remain; program_id stays nullable until every tenant is backfilled';
      END;
    END IF;`,
    )
    .join('\n');

  return `
  DO $$
  BEGIN
${blocks}
  END
  $$;
`;
}

/** Rows still without a program, per table and tenant: counts only, never row content. Needs a session that can see every tenant. */
export function buildLegacyProgramRowCountSql(tables: readonly string[] = PROGRAM_BACKFILL_TABLES): string {
  return tables
    .map((t) => `SELECT '${t}' AS table_name, tenant_id, count(*)::int AS n FROM ${t} WHERE program_id IS NULL GROUP BY tenant_id`)
    .join('\nUNION ALL\n');
}

/** Complete, idempotent schema bootstrap executed by initDb(). */
export function buildSchemaSql(): string {
  return `${TABLES_SQL}\n${buildRlsSql()}\n${buildProgramRlsSql()}\n${buildProgramIdNotNullSql()}`;
}
