import { GcpServiceConfig } from '../types/tenant';
import { DEFAULT_GCP_CONFIG } from './gcsService';

export interface TableSummary {
  tableName: string;
  description: string;
  primaryKey: string;
  foreignKeys: string[];
  rlsEnabled: boolean;
  columnCount: number;
}

export const CloudSqlService = {
  getConfig(): GcpServiceConfig {
    return { ...DEFAULT_GCP_CONFIG };
  },

  getTables(): TableSummary[] {
    return [
      {
        tableName: 'tenants',
        description: 'Client organizations, CAGE codes, SAM status, and root boundaries',
        primaryKey: 'id (VARCHAR)',
        foreignKeys: [],
        rlsEnabled: false,
        columnCount: 8,
      },
      {
        tableName: 'tenant_users',
        description: 'Google Workspace and Cloud Identity user-to-tenant RBAC assignments',
        primaryKey: 'id (UUID)',
        foreignKeys: ['tenant_id -> tenants.id (CASCADE)'],
        rlsEnabled: true,
        columnCount: 6,
      },
      {
        tableName: 'control_assessments',
        description: 'Assessment state for the 17 CMMC Level 1 controls per tenant',
        primaryKey: 'id (UUID)',
        foreignKeys: ['tenant_id -> tenants.id (CASCADE)'],
        rlsEnabled: true,
        columnCount: 9,
      },
      {
        tableName: 'evidence_metadata',
        description: 'GCS bucket URIs, file metadata, and SHA-256 cryptographic hashes',
        primaryKey: 'id (VARCHAR)',
        foreignKeys: ['tenant_id -> tenants.id (CASCADE)'],
        rlsEnabled: true,
        columnCount: 11,
      },
      {
        tableName: 'ssp_documents',
        description: 'System Security Plan documentation, boundaries, and CSP metadata',
        primaryKey: 'id (UUID)',
        foreignKeys: ['tenant_id -> tenants.id (CASCADE)'],
        rlsEnabled: true,
        columnCount: 12,
      },
    ];
  },

  getSqlScript(): string {
    return `-- ==============================================================================
-- Google Cloud SQL (PostgreSQL 15+) Schema Definition
-- Multi-Tenant CMMC Level 1 GRC & Compliance Management Architecture
-- Designed for GCP Cloud Run microservices with PostgreSQL Row-Level Security (RLS)
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. TENANTS TABLE (Organizations / Clients)
CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    cage_code VARCHAR(10),
    sam_status VARCHAR(32) DEFAULT 'ACTIVE' CHECK (sam_status IN ('ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED')),
    system_name VARCHAR(255) NOT NULL,
    system_owner VARCHAR(255) NOT NULL,
    industry VARCHAR(128) DEFAULT 'Defense Industrial Base (DIB)',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. TENANT USERS & RBAC ROLES (Cloud Identity / Workspace Mapping)
CREATE TABLE IF NOT EXISTS tenant_users (
    id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    user_id VARCHAR(128) NOT NULL,
    user_email VARCHAR(255) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL CHECK (role IN ('TENANT_OWNER', 'ASSESSOR', 'VIEWER')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unq_user_tenant UNIQUE (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON tenant_users(tenant_id);

-- 4. CONTROL ASSESSMENTS TABLE (17 CMMC Level 1 Controls per Tenant)
CREATE TABLE IF NOT EXISTS control_assessments (
    id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    control_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET')),
    implementation_notes TEXT DEFAULT '',
    responsible_role VARCHAR(128) DEFAULT 'IT / Security Lead',
    tags TEXT[] DEFAULT '{}',
    updated_by VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unq_tenant_control UNIQUE (tenant_id, control_id)
);

CREATE INDEX IF NOT EXISTS idx_control_assessments_tenant ON control_assessments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_control_assessments_status ON control_assessments(tenant_id, status);

-- 5. EVIDENCE METADATA TABLE (GCS Bucket & SHA-256 Immutability)
CREATE TABLE IF NOT EXISTS evidence_metadata (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    control_id VARCHAR(64) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    gcs_path TEXT NOT NULL,
    file_hash VARCHAR(64) NOT NULL, -- SHA-256 Cryptographic Hash
    sync_status VARCHAR(32) DEFAULT 'gcs_synced' CHECK (sync_status IN ('local_cached', 'gcs_synced', 'gcs_signed_url')),
    description TEXT,
    uploaded_by VARCHAR(255),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_tenant_control ON evidence_metadata(tenant_id, control_id);
CREATE INDEX IF NOT EXISTS idx_evidence_file_hash ON evidence_metadata(file_hash);

-- 6. SYSTEM SECURITY PLAN (SSP) METADATA TABLE
CREATE TABLE IF NOT EXISTS ssp_documents (
    id VARCHAR(64) PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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

-- 7. POSTGRESQL ROW-LEVEL SECURITY (RLS) POLICIES
ALTER TABLE control_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE ssp_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_control_assessments_tenant_isolation ON control_assessments
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

CREATE POLICY rls_evidence_metadata_tenant_isolation ON evidence_metadata
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));

CREATE POLICY rls_ssp_documents_tenant_isolation ON ssp_documents
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
`;
  },
};
