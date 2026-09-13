import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Database Connection Configuration
const dbHost = process.env.DB_HOST || '/cloudsql/grc-tool-507203:us-central1:pbc-grc-db';
const dbUser = process.env.DB_USER || 'postgres';
const dbName = process.env.DB_NAME || 'cmmc_compliance_db';
const dbPass = process.env.DB_PASS || '';
const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432;

// Configure Pool for Cloud SQL Unix Domain Sockets or standard TCP
const isSocket = dbHost.startsWith('/cloudsql') || dbHost.startsWith('/');

export const pool = new Pool(
  isSocket
    ? {
        host: dbHost,
        user: dbUser,
        database: dbName,
        password: dbPass,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
    : {
        host: dbHost,
        port: dbPort,
        user: dbUser,
        database: dbName,
        password: dbPass,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
);

pool.on('error', (err) => {
  console.error('[Cloud SQL Pool Error]:', err.message);
});

import { getEquivalentControlIds, CANONICAL_CONTROL_MAPPINGS } from '../src/data/frameworks/controlMappings';

// In-memory tenant isolation state for fallback when local PostgreSQL is not running
interface InMemoryControl {
  id: string;
  tenant_id: string;
  control_id: string;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'MET' | 'NOT_MET';
  implementation_notes: string;
  responsible_role: string;
  tags: string[];
  updated_by: string;
  updated_at: string;
}

interface InMemoryEvidence {
  id: string;
  tenant_id: string;
  control_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  gcs_path: string;
  file_hash: string;
  sync_status: string;
  description: string;
  uploaded_by: string;
  uploaded_at: string;
}

const memoryControls = new Map<string, InMemoryControl>(); // key: `${tenant_id}__${control_id}`
const memoryEvidence = new Map<string, InMemoryEvidence>(); // key: id

let isUsingMemoryFallback = false;
let dbVerified = false;

export async function checkDatabaseConnection(): Promise<boolean> {
  if (dbVerified && !isUsingMemoryFallback) return true;
  try {
    const client = await pool.connect();
    client.release();
    dbVerified = true;
    isUsingMemoryFallback = false;
    console.log(`[Cloud SQL] Successfully connected to PostgreSQL instance at ${dbHost}/${dbName}`);
    return true;
  } catch (err: any) {
    isUsingMemoryFallback = true;
    console.warn(`[Cloud SQL] Real PostgreSQL connection unavailable (${err.message}). Using local high-fidelity RLS-isolated fallback storage.`);
    return false;
  }
}

/**
 * Execute query guarded by Row-Level Security (RLS) tenant context session variable:
 * SET LOCAL app.current_tenant_id = '${tenantId}'
 */
export async function queryWithTenant(tenantId: string, text: string, params: any[] = []): Promise<pg.QueryResult<any>> {
  // Sanitize tenant ID to prevent injection
  const sanitizedTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '');

  if (!isUsingMemoryFallback) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Set PostgreSQL session variable for Row-Level Security
        await client.query(`SET LOCAL app.current_tenant_id = '${sanitizedTenantId}'`);
        // Also call set_config for maximum compatibility
        await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', sanitizedTenantId]);
        const res = await client.query(text, params);
        await client.query('COMMIT');
        return res;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (connErr: any) {
      // If live connection dropped or fails, fallback gracefully in local dev
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[Cloud SQL] Database query failed, falling back to local tenant isolation store:', connErr.message);
        isUsingMemoryFallback = true;
      } else {
        throw connErr;
      }
    }
  }

  // High-fidelity fallback enforcing strict RLS tenant isolation semantics
  return executeInMemoryWithTenant(sanitizedTenantId, text, params);
}

/**
 * Executes queries against in-memory store while strictly enforcing
 * tenant isolation equivalent to PostgreSQL Row-Level Security (RLS).
 */
function executeInMemoryWithTenant(tenantId: string, text: string, params: any[]): pg.QueryResult<any> {
  const normalized = text.trim();

  // 1. SELECT from control_assessments
  if (/SELECT\s+.*FROM\s+control_assessments/i.test(normalized)) {
    const rows: InMemoryControl[] = [];
    for (const item of memoryControls.values()) {
      // RLS filter: strictly match app.current_tenant_id
      if (item.tenant_id === tenantId) {
        rows.push(item);
      }
    }
    return {
      rows,
      command: 'SELECT',
      rowCount: rows.length,
      oid: 0,
      fields: [],
    };
  }

  // 2. UPSERT into control_assessments
  if (/INSERT\s+INTO\s+control_assessments/i.test(normalized)) {
    // params: [tenant_id, control_id, status, implementation_notes, responsible_role, updated_by]
    const rowTenantId = params[0];
    // RLS WITH CHECK validation: Cannot insert for a tenant other than active tenant
    if (rowTenantId !== tenantId) {
      return { rows: [], command: 'INSERT', rowCount: 0, oid: 0, fields: [] };
    }
    const controlId = params[1];
    const status = params[2] || 'NOT_STARTED';
    const notes = params[3] ?? '';
    const role = params[4] || 'IT / Security Lead';
    const updatedBy = params[5] || 'System';

    const key = `${tenantId}__${controlId}`;
    const existing = memoryControls.get(key);

    const record: InMemoryControl = {
      id: existing?.id || `ctrl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      tenant_id: tenantId,
      control_id: controlId,
      status,
      implementation_notes: notes,
      responsible_role: role,
      tags: existing?.tags || [],
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    };

    memoryControls.set(key, record);

    return {
      rows: [record],
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
    };
  }

  // 3. SELECT from evidence_metadata
  if (/SELECT\s+.*FROM\s+evidence_metadata/i.test(normalized)) {
    // Check if looking up single evidence ID (e.g. WHERE id = $1 AND tenant_id = $2 or WHERE id = $1)
    if (/\bid\s*=\s*\$1\b/i.test(normalized) && !/\btenant_id\s*=\s*\$1\b/i.test(normalized)) {
      const targetId = params[0];
      const item = memoryEvidence.get(targetId);
      // RLS check: only return if tenant_id matches active tenant!
      if (item && item.tenant_id === tenantId) {
        return { rows: [item], command: 'SELECT', rowCount: 1, oid: 0, fields: [] };
      }
      // Isolated from other tenant -> returns empty (404)
      return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
    }

    const rows: InMemoryEvidence[] = [];
    for (const item of memoryEvidence.values()) {
      if (item.tenant_id === tenantId) {
        rows.push(item);
      }
    }
    rows.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());

    return {
      rows,
      command: 'SELECT',
      rowCount: rows.length,
      oid: 0,
      fields: [],
    };
  }

  // 4. INSERT into evidence_metadata (with Cross-Framework Evidence Inheritance)
  if (/INSERT\s+INTO\s+evidence_metadata/i.test(normalized)) {
    const id = params[0];
    const rowTenantId = params[1];
    const controlId = params[2];
    // RLS WITH CHECK validation
    if (rowTenantId !== tenantId) {
      throw new Error(`Row-Level Security violation: tenant ${tenantId} cannot write record for tenant ${rowTenantId}`);
    }

    const isInherited = /'inherited'/i.test(normalized);
    const sync_status = isInherited ? 'inherited' : (params.length > 10 ? params[8] : 'gcs_signed_url');
    const description = params.length > 10 ? params[9] : params[8] || '';
    const uploaded_by = params.length > 10 ? params[10] : params[9] || 'Assessor';

    const record: InMemoryEvidence = {
      id,
      tenant_id: tenantId,
      control_id: controlId,
      file_name: params[3],
      file_size: params[4],
      mime_type: params[5],
      gcs_path: params[6],
      file_hash: params[7],
      sync_status,
      description,
      uploaded_by,
      uploaded_at: new Date().toISOString(),
    };

    memoryEvidence.set(id, record);

    // Cross-Framework Evidence Inheritance:
    // Automatically link upload with mapped controls (e.g., AC.L1-3.1.1 -> NIST AC-2 & SOC 2 CC6.1)
    if (!isInherited && !id.includes('__inh_')) {
      const mappedControlIds = getEquivalentControlIds(controlId);
      for (const mappedId of mappedControlIds) {
        const inhId = `${id}__inh_${mappedId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (!memoryEvidence.has(inhId)) {
          const inhRecord: InMemoryEvidence = {
            id: inhId,
            tenant_id: tenantId,
            control_id: mappedId,
            file_name: params[3],
            file_size: params[4],
            mime_type: params[5],
            gcs_path: params[6],
            file_hash: params[7],
            sync_status: 'inherited',
            description: `[Inherited from ${controlId}] ${description}`,
            uploaded_by,
            uploaded_at: new Date().toISOString(),
          };
          memoryEvidence.set(inhId, inhRecord);
        }
      }
    }

    return {
      rows: [record],
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      fields: [],
    };
  }

  // 5. SELECT from control_mappings
  if (/SELECT\s+.*FROM\s+control_mappings/i.test(normalized)) {
    return {
      rows: CANONICAL_CONTROL_MAPPINGS.map(m => ({
        id: m.id,
        source_framework: m.sourceFramework,
        source_control_id: m.sourceControlId,
        target_framework: m.targetFramework,
        target_control_id: m.targetControlId,
        mapping_type: m.mappingType,
        notes: m.notes || '',
      })),
      command: 'SELECT',
      rowCount: CANONICAL_CONTROL_MAPPINGS.length,
      oid: 0,
      fields: [],
    };
  }

  return { rows: [], command: 'SELECT', rowCount: 0, oid: 0, fields: [] };
}

/**
 * Initializes database schema with RLS policies if connected to a live PostgreSQL database
 */
export async function initDb(): Promise<void> {
  const isConnected = await checkDatabaseConnection();
  if (!isConnected) return;

  const client = await pool.connect();
  try {
    await client.query(`
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
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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

      ALTER TABLE control_assessments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE evidence_metadata ENABLE ROW LEVEL SECURITY;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE tablename = 'control_assessments' AND policyname = 'rls_control_assessments_tenant_isolation'
        ) THEN
          CREATE POLICY rls_control_assessments_tenant_isolation ON control_assessments
              FOR ALL
              USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
              WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE tablename = 'evidence_metadata' AND policyname = 'rls_evidence_metadata_tenant_isolation'
        ) THEN
          CREATE POLICY rls_evidence_metadata_tenant_isolation ON evidence_metadata
              FOR ALL
              USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
              WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
        END IF;
      END
      $$;
    `);

    // Seed canonical control mappings if not present
    for (const m of CANONICAL_CONTROL_MAPPINGS) {
      await client.query(
        `INSERT INTO control_mappings (id, source_framework, source_control_id, target_framework, target_control_id, mapping_type, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_framework, source_control_id, target_framework, target_control_id) DO NOTHING`,
        [m.id, m.sourceFramework, m.sourceControlId, m.targetFramework, m.targetControlId, m.mappingType, m.notes || '']
      );
    }

    console.log('[Cloud SQL] Database schema, control mappings, and RLS policies verified.');
  } catch (err: any) {
    console.error('[Cloud SQL] Failed to run schema DDL:', err.message);
  } finally {
    client.release();
  }
}

