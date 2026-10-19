import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from '../db';
import type { VmServiceToken, VmTokenScope } from '../../src/types/vm';

/**
 * Vulnerability-management service tokens: the machine credential a scanner exporter presents to push results.
 *
 * Security model (same as tenant invitations):
 *  - The secret is 256 random bits. Only its SHA-256 hash is stored; the plaintext exists once, in the creation response.
 *  - A token is bound to one tenant and a scope list, expires (default 365 days, at most 730) and can be revoked.
 *  - Lookup works before any tenant is known through an RLS discovery policy keyed on the hash of the presented token
 *    (app.vm_token_hash, see DISCOVERY_POLICIES in schema.ts); a request without the token can see none of these rows.
 */

export type VmTokenErrorCode = 'not_found' | 'limit';

export class VmTokenError extends Error {
  readonly code: VmTokenErrorCode;
  constructor(code: VmTokenErrorCode, message: string) {
    super(message);
    this.name = 'VmTokenError';
    this.code = code;
  }
}

export const VM_TOKEN_PREFIX = 'pbcvm_';
export const VM_TOKEN_PATTERN = /^pbcvm_[A-Za-z0-9_-]{43}$/;
export const DEFAULT_TOKEN_DAYS = 365;
export const MAX_TOKEN_DAYS = 730;
export const MAX_ACTIVE_TOKENS_PER_TENANT = 10;
/** last_used_at is refreshed at most this often, so a busy exporter does not write on every request. */
export const LAST_USED_RESOLUTION_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const generateVmToken = (): string => `${VM_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
export const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const clampTokenDays = (days: number | undefined): number =>
  Number.isFinite(days) ? Math.min(MAX_TOKEN_DAYS, Math.max(1, Math.floor(days as number))) : DEFAULT_TOKEN_DAYS;

/** True when last_used_at is unset or older than the resolution window. */
export const shouldTouchLastUsed = (lastUsedAt: string | Date | null | undefined, now: number = Date.now()): boolean =>
  !lastUsedAt || now - new Date(lastUsedAt).getTime() >= LAST_USED_RESOLUTION_MS;

const isMemory = (): boolean => getDbMode() === 'memory';

// ------------------------------------------------------------------------------------------------ memory store

interface MemoryToken extends VmServiceToken {
  tokenHash: string;
}
const memoryTokens = new Map<string, MemoryToken>(); // key: id

const toRecord = (m: MemoryToken): VmServiceToken => {
  const { tokenHash: _tokenHash, ...rest } = m;
  return { ...rest, scopes: [...rest.scopes] };
};

/** Test hook. */
export function __resetVmTokensForTests(): void {
  memoryTokens.clear();
}

/** Test hook (in-memory mode only): makes a token expired as of an hour ago. */
export function __expireVmTokenForTests(id: string): void {
  const m = memoryTokens.get(id);
  if (m) m.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

// ------------------------------------------------------------------------------------------------ PostgreSQL helpers

const RECORD_COLUMNS = 'id, tenant_id, name, token_prefix, scopes, created_by, created_by_user_id, created_at, expires_at, last_used_at, revoked_at';

function rowToRecord(row: pg.QueryResultRow): VmServiceToken {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    tokenPrefix: row.token_prefix as string,
    scopes: row.scopes as VmTokenScope[],
    createdBy: row.created_by as string,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: iso(row.created_at) as string,
    expiresAt: iso(row.expires_at) as string,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
  };
}

/** Runs `fn` in a transaction with the tenant's RLS context set. */
async function inTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Constant-time comparison of two lowercase 64-character hex SHA-256 digests. */
function hashesEqual(a: string, b: string): boolean {
  if (!HASH_PATTERN.test(a) || !HASH_PATTERN.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ------------------------------------------------------------------------------------------------ tenant-scoped operations

export interface NewVmToken {
  name: string;
  scopes: VmTokenScope[];
  expiresInDays?: number;
  createdBy: string;
  createdByUserId: string | null;
}

const isActive = (m: { revokedAt: string | null; expiresAt: string }, now = Date.now()): boolean =>
  !m.revokedAt && new Date(m.expiresAt).getTime() > now;

/** Creates a token and returns it together with the one-time plaintext. At most MAX_ACTIVE_TOKENS_PER_TENANT may be active. */
export async function createVmToken(tenantId: string, input: NewVmToken): Promise<{ token: string; record: VmServiceToken }> {
  const token = generateVmToken();
  const tokenHash = sha256Hex(token);
  const tokenPrefix = token.slice(0, 12);
  const expiresAt = new Date(Date.now() + clampTokenDays(input.expiresInDays) * DAY_MS).toISOString();

  if (isMemory()) {
    const active = [...memoryTokens.values()].filter((m) => m.tenantId === tenantId && isActive(m));
    if (active.length >= MAX_ACTIVE_TOKENS_PER_TENANT) throw new VmTokenError('limit', 'Too many active service tokens for this tenant');
    const record: MemoryToken = {
      id: `vmt_${crypto.randomBytes(8).toString('hex')}`,
      tenantId, name: input.name, tokenPrefix, scopes: [...input.scopes],
      createdBy: input.createdBy, createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(), expiresAt, lastUsedAt: null, revokedAt: null, tokenHash,
    };
    memoryTokens.set(record.id, record);
    return { token, record: toRecord(record) };
  }

  const record = await inTenantTx(tenantId, async (client) => {
    const active = await client.query(
      'SELECT count(*)::int AS n FROM vm_service_tokens WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
      [tenantId]
    );
    if (active.rows[0].n >= MAX_ACTIVE_TOKENS_PER_TENANT) throw new VmTokenError('limit', 'Too many active service tokens for this tenant');
    const res = await client.query(
      `INSERT INTO vm_service_tokens (tenant_id, name, token_hash, token_prefix, scopes, created_by, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${RECORD_COLUMNS}`,
      [tenantId, input.name, tokenHash, tokenPrefix, input.scopes, input.createdBy, input.createdByUserId, expiresAt]
    );
    return rowToRecord(res.rows[0]);
  });
  return { token, record };
}

export async function listVmTokens(tenantId: string): Promise<VmServiceToken[]> {
  if (isMemory()) {
    return [...memoryTokens.values()]
      .filter((m) => m.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toRecord);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${RECORD_COLUMNS} FROM vm_service_tokens WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [tenantId]
    );
    return res.rows.map(rowToRecord);
  });
}

/** Revokes a token. Idempotent: revoking a revoked token returns it unchanged. */
export async function revokeVmToken(tenantId: string, id: string): Promise<VmServiceToken> {
  if (isMemory()) {
    const m = memoryTokens.get(id);
    if (!m || m.tenantId !== tenantId) throw new VmTokenError('not_found', 'Service token not found');
    if (!m.revokedAt) m.revokedAt = new Date().toISOString();
    return toRecord(m);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE vm_service_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND tenant_id = $2 RETURNING ${RECORD_COLUMNS}`,
      [id, tenantId]
    );
    if (res.rows.length === 0) throw new VmTokenError('not_found', 'Service token not found');
    return rowToRecord(res.rows[0]);
  });
}

// ------------------------------------------------------------------------------------------------ authentication (token holder)

/**
 * Finds the token whose hash is `tokenHash`, whatever its state (the caller checks revokedAt / expiresAt), or null.
 * Works before the tenant is known; refreshes last_used_at at most once a minute for a live token.
 */
export async function lookupVmTokenByHash(tokenHash: string): Promise<VmServiceToken | null> {
  if (isMemory()) {
    let found: MemoryToken | null = null;
    for (const m of memoryTokens.values()) {
      if (hashesEqual(m.tokenHash, tokenHash)) found = m; // no early break: time does not depend on where the match is
    }
    if (!found) return null;
    if (isActive(found) && shouldTouchLastUsed(found.lastUsedAt)) found.lastUsedAt = new Date().toISOString();
    return toRecord(found);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.vm_token_hash', tokenHash]);
    const found = await client.query(`SELECT ${RECORD_COLUMNS}, token_hash FROM vm_service_tokens WHERE token_hash = $1`, [tokenHash]);
    if (found.rows.length === 0 || !hashesEqual(String(found.rows[0].token_hash), tokenHash)) {
      await client.query('ROLLBACK');
      return null;
    }
    const rec = rowToRecord(found.rows[0]);

    // From here on act as the tenant: the discovery policy grants no write.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', rec.tenantId]);
    const touched = await client.query(
      `UPDATE vm_service_tokens SET last_used_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL AND expires_at > NOW()
          AND (last_used_at IS NULL OR last_used_at < NOW() - interval '1 minute')
        RETURNING last_used_at`,
      [rec.id, rec.tenantId]
    );
    if (touched.rows[0]) rec.lastUsedAt = new Date(touched.rows[0].last_used_at as string).toISOString();
    await client.query('COMMIT');
    return rec;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
