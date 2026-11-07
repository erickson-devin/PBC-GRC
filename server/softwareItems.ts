import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from './db';
import { getAsset, listAssets } from './assets';
import type { SoftwareItem } from '../src/types/software';

/**
 * Software inventory store (issue #229, phase 1b): manual entries, tenant-wide like the enclave asset inventory, each
 * optionally linked to one enclave asset.
 *
 * Tenant isolation: every PostgreSQL statement runs in a transaction that sets app.current_tenant_id, and software_items
 * has FORCE ROW LEVEL SECURITY with that tenant policy (see schema.ts), on top of an explicit tenant_id filter. The
 * in-memory store (DB_MODE=memory) filters by tenant id and mirrors the "ON DELETE SET NULL (asset_id)" foreign key by
 * reporting a null assetId once the linked asset no longer exists.
 *
 * Name, version, vendor and notes may describe a CUI boundary: they are never logged and never put in an error message.
 */

export type SoftwareErrorCode = 'not_found' | 'limit' | 'invalid' | 'asset_not_found';

export class SoftwareError extends Error {
  readonly code: SoftwareErrorCode;
  constructor(code: SoftwareErrorCode, message: string) {
    super(message);
    this.name = 'SoftwareError';
    this.code = code;
  }
}

export const MAX_SOFTWARE_PER_TENANT = 5000;

export interface SoftwareFields {
  name: string;
  version: string;
  vendor: string;
  approved: boolean | null;
  assetId: string | null;
  notes: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(body: Record<string, unknown>, key: string, max: number, label: string, multiline = false): Validation<string | undefined> {
  const raw = body[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be text` };
  const value = raw.trim();
  if (value.length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
  if (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) : CONTROL_CHARS.test(value)) {
    return { ok: false, error: `${label} contains control characters` };
  }
  return { ok: true, value };
}

/**
 * Validates a software request body. With `partial` (PUT) only the fields present are returned and none are required;
 * otherwise (POST) a name is required and the rest get defaults (approved null = not reviewed, no linked asset).
 */
export function validateSoftwareInput(body: unknown, partial: boolean): Validation<Partial<SoftwareFields>> {
  if (!isRecord(body)) return { ok: false, error: 'Request body must be a JSON object' };
  const out: Partial<SoftwareFields> = {};

  const name = text(body, 'name', 255, 'Software name');
  if (!name.ok) return name;
  if (name.value !== undefined) {
    if (name.value === '') return { ok: false, error: 'Software name is required' };
    out.name = name.value;
  } else if (!partial) {
    return { ok: false, error: 'Software name is required' };
  }

  const version = text(body, 'version', 128, 'Version');
  if (!version.ok) return version;
  if (version.value !== undefined) out.version = version.value;

  const vendor = text(body, 'vendor', 255, 'Vendor');
  if (!vendor.ok) return vendor;
  if (vendor.value !== undefined) out.vendor = vendor.value;

  const notes = text(body, 'notes', 4000, 'Notes', true);
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;

  if (body.approved !== undefined) {
    if (body.approved !== true && body.approved !== false && body.approved !== null) {
      return { ok: false, error: 'Approved must be true, false or null' };
    }
    out.approved = body.approved;
  }

  if (body.assetId !== undefined) {
    if (body.assetId !== null && (typeof body.assetId !== 'string' || !ASSET_ID.test(body.assetId))) {
      return { ok: false, error: 'Asset id is invalid' };
    }
    out.assetId = body.assetId;
  }
  return { ok: true, value: out };
}

// ------------------------------------------------------------------------------------------------ record shape

interface MemorySoftware extends SoftwareFields {
  id: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}
const memorySoftware = new Map<string, MemorySoftware>(); // key: id

const toRecord = (m: MemorySoftware, assetIds: ReadonlySet<string>): SoftwareItem => ({
  id: m.id,
  tenantId: m.tenantId,
  name: m.name,
  version: m.version,
  vendor: m.vendor,
  approved: m.approved,
  assetId: m.assetId !== null && assetIds.has(m.assetId) ? m.assetId : null,
  notes: m.notes,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

function rowToRecord(row: pg.QueryResultRow): SoftwareItem {
  const iso = (v: unknown) => new Date(v as string).toISOString();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    version: row.version ?? '',
    vendor: row.vendor ?? '',
    approved: row.approved ?? null,
    assetId: row.asset_id ?? null,
    notes: row.notes ?? '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Test hook. */
export function __resetMemorySoftwareForTests(): void {
  memorySoftware.clear();
}

// ------------------------------------------------------------------------------------------------ helpers

const isMemory = (): boolean => getDbMode() === 'memory';

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

const isForeignKeyViolation = (err: unknown): boolean => (err as { code?: string })?.code === '23503';
const assetMissing = (): SoftwareError => new SoftwareError('asset_not_found', 'The linked asset was not found in this enclave');

/** The ids of this tenant's assets (memory store: stands in for the foreign key). */
async function memoryAssetIds(tenantId: string): Promise<Set<string>> {
  return new Set((await listAssets(tenantId)).map((a) => a.id));
}

const withDefaults = (f: Partial<SoftwareFields>): SoftwareFields => ({
  name: f.name as string,
  version: f.version ?? '',
  vendor: f.vendor ?? '',
  approved: f.approved ?? null,
  assetId: f.assetId ?? null,
  notes: f.notes ?? '',
});

// ------------------------------------------------------------------------------------------------ operations

export async function listSoftware(tenantId: string): Promise<SoftwareItem[]> {
  if (isMemory()) {
    const ids = await memoryAssetIds(tenantId);
    return [...memorySoftware.values()]
      .filter((m) => m.tenantId === tenantId)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.createdAt.localeCompare(b.createdAt))
      .map((m) => toRecord(m, ids));
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM software_items WHERE tenant_id = $1 ORDER BY lower(name), created_at LIMIT $2', [tenantId, MAX_SOFTWARE_PER_TENANT]);
    return res.rows.map(rowToRecord);
  });
}

export async function getSoftware(tenantId: string, id: string): Promise<SoftwareItem | null> {
  if (isMemory()) {
    const m = memorySoftware.get(id);
    return m && m.tenantId === tenantId ? toRecord(m, await memoryAssetIds(tenantId)) : null;
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM software_items WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  });
}

export async function createSoftware(tenantId: string, input: Partial<SoftwareFields>, actor: string): Promise<SoftwareItem> {
  const fields = withDefaults(input);
  if (isMemory()) {
    const mine = [...memorySoftware.values()].filter((m) => m.tenantId === tenantId);
    if (mine.length >= MAX_SOFTWARE_PER_TENANT) throw new SoftwareError('limit', 'This enclave has reached the maximum number of software entries');
    if (fields.assetId !== null && !(await getAsset(tenantId, fields.assetId))) throw assetMissing();
    const now = new Date().toISOString();
    const record: MemorySoftware = { ...fields, id: crypto.randomUUID(), tenantId, createdBy: actor, createdAt: now, updatedBy: actor, updatedAt: now };
    memorySoftware.set(record.id, record);
    return toRecord(record, await memoryAssetIds(tenantId));
  }
  try {
    return await inTenantTx(tenantId, async (client) => {
      const count = await client.query('SELECT COUNT(*)::int AS n FROM software_items WHERE tenant_id = $1', [tenantId]);
      if (count.rows[0].n >= MAX_SOFTWARE_PER_TENANT) throw new SoftwareError('limit', 'This enclave has reached the maximum number of software entries');
      const res = await client.query(
        `INSERT INTO software_items (tenant_id, name, version, vendor, approved, asset_id, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [tenantId, fields.name, fields.version, fields.vendor, fields.approved, fields.assetId, fields.notes, actor],
      );
      return rowToRecord(res.rows[0]);
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw assetMissing();
    throw err;
  }
}

export async function updateSoftware(tenantId: string, id: string, patch: Partial<SoftwareFields>, actor: string): Promise<SoftwareItem> {
  if (isMemory()) {
    const m = memorySoftware.get(id);
    if (!m || m.tenantId !== tenantId) throw new SoftwareError('not_found', 'Software entry not found');
    if (patch.assetId !== undefined && patch.assetId !== null && !(await getAsset(tenantId, patch.assetId))) throw assetMissing();
    Object.assign(m, patch, { updatedBy: actor, updatedAt: new Date().toISOString() });
    return toRecord(m, await memoryAssetIds(tenantId));
  }

  const columns: Record<keyof SoftwareFields, string> = {
    name: 'name', version: 'version', vendor: 'vendor', approved: 'approved', assetId: 'asset_id', notes: 'notes',
  };
  try {
    return await inTenantTx(tenantId, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const key of Object.keys(columns) as Array<keyof SoftwareFields>) {
        if (patch[key] === undefined) continue;
        params.push(patch[key]);
        sets.push(`${columns[key]} = $${params.length}`);
      }
      params.push(actor);
      sets.push(`updated_by = $${params.length}`, 'updated_at = NOW()');
      params.push(id, tenantId);
      const res = await client.query(
        `UPDATE software_items SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
        params,
      );
      if (!res.rows[0]) throw new SoftwareError('not_found', 'Software entry not found');
      return rowToRecord(res.rows[0]);
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw assetMissing();
    throw err;
  }
}

export async function deleteSoftware(tenantId: string, id: string): Promise<boolean> {
  if (isMemory()) {
    const m = memorySoftware.get(id);
    if (!m || m.tenantId !== tenantId) return false;
    memorySoftware.delete(id);
    return true;
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('DELETE FROM software_items WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  });
}
