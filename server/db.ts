import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

/**
 * Connection settings, chosen from the environment:
 *   1. DATABASE_URL  - standard PostgreSQL connection string (postgres://user:pass@host:5432/db?sslmode=require).
 *                      Takes precedence; works for managed Postgres, RDS, on-prem, docker, etc.
 *   2. DB_HOST etc.  - discrete settings. A DB_HOST starting with "/" (default: the Cloud SQL socket) is a Unix
 *                      domain socket; anything else is TCP using DB_PORT.
 * Optional TLS for either: DB_SSL=true (certificate verification stays on unless DB_SSL_REJECT_UNAUTHORIZED=false).
 */
export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env): { config: pg.PoolConfig; target: string } {
  const common: pg.PoolConfig = {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  if (env.DB_SSL === 'true') {
    common.ssl = { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let target = 'DATABASE_URL';
    try {
      const url = new URL(databaseUrl);
      target = `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`; // never log credentials
    } catch {
      // leave generic label; pg will report a precise error on connect
    }
    return { config: { ...common, connectionString: databaseUrl }, target };
  }

  const host = env.DB_HOST || '/cloudsql/grc-tool-507203:us-central1:pbc-grc-db';
  const user = env.DB_USER || 'postgres';
  const database = env.DB_NAME || 'cmmc_compliance_db';
  const password = env.DB_PASS || '';
  const port = env.DB_PORT ? parseInt(env.DB_PORT, 10) : 5432;
  const isSocket = host.startsWith('/');

  return {
    config: isSocket
      ? { ...common, host, user, database, password }
      : { ...common, host, port, user, database, password },
    target: `${host}${isSocket ? '' : `:${port}`}/${database}`,
  };
}

const { config: poolConfig, target: dbTarget } = buildPoolConfig();
export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[Cloud SQL Pool Error]:', errorMessage(err));
});

import { getEquivalentControlIds, CANONICAL_CONTROL_MAPPINGS } from '../src/data/frameworks/controlMappings';
import { errorMessage } from '../src/utils/errors';
import { isTenantRole } from '../src/utils/roles';
import { buildSchemaSql } from './schema';
import type { TenantRole } from '../src/types/tenant';

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

interface InMemoryTenantUser {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  tenant_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

const memoryTenantUsers = new Map<string, InMemoryTenantUser>(); // key: `${tenant_id}__${user_id}`
const memoryControls = new Map<string, InMemoryControl>(); // key: `${tenant_id}__${control_id}`
const memoryEvidence = new Map<string, InMemoryEvidence>(); // key: id

/** Bind parameter values accepted by the query helpers. */
export type SqlParam = string | number | boolean | Date | string[] | null | undefined;

export type DbMode = 'postgres' | 'memory';

/**
 * Which store the API uses. There is NO automatic fallback:
 *   - unset / DB_MODE=postgres : PostgreSQL. If it is unreachable, startup fails and queries throw.
 *   - DB_MODE=memory           : explicit opt-in to the in-memory, RLS-emulating store (local development and
 *                                tests only; data is lost on restart, and refused when NODE_ENV=production).
 */
export function getDbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  const raw = (env.DB_MODE || 'postgres').trim().toLowerCase();
  if (raw === 'postgres' || raw === 'memory') return raw;
  throw new Error(`Invalid DB_MODE "${env.DB_MODE}": expected "postgres" or "memory"`);
}

const isMemoryMode = (): boolean => getDbMode() === 'memory';

/** Throws on a configuration that must never run, e.g. the volatile in-memory store in production. */
export function assertDbModeAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (getDbMode(env) === 'memory' && env.NODE_ENV === 'production') {
    throw new Error('DB_MODE=memory is not allowed when NODE_ENV=production: data would be lost on restart and tenant isolation would not be enforced by PostgreSQL.');
  }
}

/**
 * Verifies the PostgreSQL connection. Resolves true when connected, false in memory mode (no database),
 * and REJECTS when PostgreSQL is configured but unreachable: callers must not continue silently.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  if (isMemoryMode()) return false;
  try {
    const client = await pool.connect();
    client.release();
  } catch (err: unknown) {
    throw new Error(`PostgreSQL connection failed (${dbTarget}): ${errorMessage(err)}. Fix DATABASE_URL / DB_* settings, or set DB_MODE=memory for local development.`);
  }
  console.log(`[Cloud SQL] Successfully connected to PostgreSQL at ${dbTarget}`);
  return true;
}

/** Non-throwing status for health probes. */
export async function getDatabaseStatus(): Promise<'connected' | 'memory' | 'unavailable'> {
  if (isMemoryMode()) return 'memory';
  try {
    await checkDatabaseConnection();
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

/**
 * Execute query guarded by Row-Level Security (RLS) tenant context session variable:
 * SET LOCAL app.current_tenant_id = '${tenantId}'
 */
export async function queryWithTenant(tenantId: string, text: string, params: SqlParam[] = []): Promise<pg.QueryResult> {
  // Sanitize tenant ID to prevent injection
  const sanitizedTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '');

  if (isMemoryMode()) {
    // Explicit DB_MODE=memory: emulate RLS tenant isolation in process memory
    return executeInMemoryWithTenant(sanitizedTenantId, text, params);
  }

  // PostgreSQL. Errors propagate to the caller; there is deliberately no fallback to another store.
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
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Executes queries against in-memory store while strictly enforcing
 * tenant isolation equivalent to PostgreSQL Row-Level Security (RLS).
 */
// `params` is positional and column-typed by the emulated statements below, hence the loose element type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function executeInMemoryWithTenant(tenantId: string, text: string, params: any[]): pg.QueryResult {
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

  // 6. tenant_users: upsert (INSERT ... ON CONFLICT (user_id, tenant_id) DO UPDATE)
  if (/INSERT\s+INTO\s+tenant_users/i.test(normalized)) {
    // params: [user_id, user_email, user_name, tenant_id, role]
    const [userId, email, name, rowTenantId, role] = params;
    if (rowTenantId !== tenantId) {
      throw new Error(`Row-Level Security violation: tenant ${tenantId} cannot write membership for tenant ${rowTenantId}`);
    }
    const key = `${tenantId}__${userId}`;
    const existing = memoryTenantUsers.get(key);
    const now = new Date().toISOString();
    const record: InMemoryTenantUser = {
      id: existing?.id || `tu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      user_id: userId,
      user_email: email,
      user_name: name,
      tenant_id: tenantId,
      role,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    memoryTenantUsers.set(key, record);
    return { rows: [record], command: 'INSERT', rowCount: 1, oid: 0, fields: [] };
  }

  // 7. tenant_users: SELECT (RLS: only the active tenant's rows; optional user_id filter in params[0])
  if (/FROM\s+tenant_users/i.test(normalized)) {
    const filterUser = /user_id\s*=\s*\$1/i.test(normalized) ? params[0] : undefined;
    const rows = [...memoryTenantUsers.values()]
      .filter((r) => r.tenant_id === tenantId && (filterUser === undefined || r.user_id === filterUser))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] };
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
  if (isMemoryMode()) {
    console.warn('[Database] DB_MODE=memory: using the in-memory store. Data is NOT persisted and PostgreSQL RLS is NOT in effect.');
    return;
  }
  await checkDatabaseConnection(); // rejects if PostgreSQL is unreachable

  const client = await pool.connect();
  try {
    // Tables, ENABLE + FORCE ROW LEVEL SECURITY, and tenant-isolation policies (see server/schema.ts)
    await client.query(buildSchemaSql());

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
  } catch (err: unknown) {
    throw new Error(`Failed to initialise the database schema: ${errorMessage(err)}`);
  } finally {
    client.release();
  }
}


/**
 * The user's membership row in the tenant, or null. Works against PostgreSQL and the in-memory fallback.
 * Fails closed (null) if the table is unavailable.
 */
async function findTenantMember(userId: string, tenantId: string): Promise<{ role: unknown } | null> {
  if (!userId || !tenantId) return null;
  if (isMemoryMode()) {
    return memoryTenantUsers.get(`${tenantId}__${userId}`) ?? null;
  }
  try {
    const result = await queryWithTenant(
      tenantId,
      'SELECT role FROM tenant_users WHERE user_id = $1 AND tenant_id = $2 LIMIT 1',
      [userId, tenantId]
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}

/** True when `userId` has a tenant_users membership row for `tenantId`. */
export async function isTenantMember(userId: string, tenantId: string): Promise<boolean> {
  return (await findTenantMember(userId, tenantId)) !== null;
}

/** The user's role in the tenant from tenant_users, or null if there is no (valid) membership row. */
export async function getTenantRole(userId: string, tenantId: string): Promise<TenantRole | null> {
  const member = await findTenantMember(userId, tenantId);
  return member && isTenantRole(member.role) ? member.role : null;
}

export interface TenantMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  tenantId: string;
  role: TenantRole;
  createdAt: string;
  updatedAt: string;
}

function mapMemberRow(row: pg.QueryResultRow): TenantMember {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.user_email,
    name: row.user_name,
    tenantId: row.tenant_id,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Inserts the member, or updates their role/contact details if they already belong to the tenant. */
export async function upsertTenantMember(
  tenantId: string,
  member: { userId: string; email: string; name: string; role: TenantRole }
): Promise<TenantMember> {
  const result = await queryWithTenant(
    tenantId,
    `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, tenant_id) DO UPDATE
       SET user_email = EXCLUDED.user_email, user_name = EXCLUDED.user_name, role = EXCLUDED.role, updated_at = NOW()
     RETURNING *`,
    [member.userId, member.email, member.name, tenantId, member.role]
  );
  return mapMemberRow(result.rows[0]);
}

/** All members of the tenant (RLS limits the query to the active tenant). */
export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  const result = await queryWithTenant(
    tenantId,
    'SELECT * FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at ASC',
    [tenantId]
  );
  return result.rows.map(mapMemberRow);
}

export interface NewTenantInput {
  id: string;
  name: string;
  cageCode?: string;
  samStatus?: string;
  systemName: string;
  systemOwner: string;
  industry?: string;
  enabledFrameworks: string[];
  primaryFramework: string;
  licenseTier: string;
}

export interface TenantRecord {
  id: string;
  name: string;
  cageCode: string | null;
  samStatus: string;
  systemName: string;
  systemOwner: string;
  industry: string;
  enabledFrameworks: string[];
  primaryFramework: string;
  licenseTier: string;
  createdAt: string;
}

export class TenantExistsError extends Error {
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} already exists`);
    this.name = 'TenantExistsError';
  }
}

const memoryTenants = new Map<string, TenantRecord>();

function toTenantRecord(t: NewTenantInput, createdAt: string): TenantRecord {
  return {
    id: t.id,
    name: t.name,
    cageCode: t.cageCode ?? null,
    samStatus: t.samStatus ?? 'ACTIVE',
    systemName: t.systemName,
    systemOwner: t.systemOwner,
    industry: t.industry ?? 'Defense Industrial Base (DIB)',
    enabledFrameworks: t.enabledFrameworks,
    primaryFramework: t.primaryFramework,
    licenseTier: t.licenseTier,
    createdAt,
  };
}

/**
 * Creates a tenant and makes `owner` its first TENANT_OWNER, atomically: on PostgreSQL both rows are written in
 * ONE transaction under the new tenant's RLS context, so a failure can never leave an ownerless tenant behind.
 * Throws TenantExistsError if the id is taken.
 */
export async function createTenantWithOwner(
  tenant: NewTenantInput,
  owner: { userId: string; email: string; name: string }
): Promise<{ tenant: TenantRecord; member: TenantMember }> {
  const tenantId = tenant.id;

  if (isMemoryMode()) {
    if (memoryTenants.has(tenantId)) throw new TenantExistsError(tenantId);
    const record = toTenantRecord(tenant, new Date().toISOString());
    memoryTenants.set(tenantId, record);
    const member = await upsertTenantMember(tenantId, { ...owner, role: 'TENANT_OWNER' });
    return { tenant: record, member };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);

    const inserted = await client.query(
      `INSERT INTO tenants (id, name, cage_code, sam_status, system_name, system_owner, industry,
                            enabled_frameworks, primary_framework, license_tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING created_at`,
      [
        tenantId, tenant.name, tenant.cageCode ?? null, tenant.samStatus ?? 'ACTIVE', tenant.systemName,
        tenant.systemOwner, tenant.industry ?? 'Defense Industrial Base (DIB)', tenant.enabledFrameworks,
        tenant.primaryFramework, tenant.licenseTier,
      ]
    );
    const memberRow = await client.query(
      `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role)
       VALUES ($1, $2, $3, $4, 'TENANT_OWNER') RETURNING *`,
      [owner.userId, owner.email, owner.name, tenantId]
    );
    await client.query('COMMIT');

    return {
      tenant: toTenantRecord(tenant, new Date(inserted.rows[0].created_at).toISOString()),
      member: mapMemberRow(memberRow.rows[0]),
    };
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((err as { code?: string })?.code === '23505') throw new TenantExistsError(tenantId);
    throw err;
  } finally {
    client.release();
  }
}

/** Test hook: clears the in-memory tenant and membership stores. */
export function __resetMemoryTenantsForTests(): void {
  memoryTenants.clear();
  memoryTenantUsers.clear();
}

