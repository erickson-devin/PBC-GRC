import crypto from 'crypto';
import type pg from 'pg';
import { nextStamp } from '../db';
import { matchesExpected, notesDigest, StaleWriteError } from '../controlAssessments';
import { __resetInventoryEventsForTests, inTenantTx, insertEventTx, isMemory, pushMemoryInventoryEvent, toolEventFields, vendorEventFields, type InventoryActor, type Q } from './events';
import type { ToolInputWithSeed, VendorInput } from '../../src/data/inventory/inventorySchema';
import {
  MAX_TOOLS_PER_TENANT,
  MAX_VENDORS_PER_TENANT,
  type FedrampStatus,
  type InventoryTool,
  type InventoryVendor,
  type ToolBatchResult,
  type ToolOrigin,
  type VendorKind,
} from '../../src/types/inventory';

/**
 * The Tools and Services register (issues #239, #248, #249): tools and vendors / external service providers, tenant-wide like the enclave asset
 * inventory (a program's boundary, control links and data inventory live in programInventoryStore.ts).
 *
 * Tenant isolation: every PostgreSQL statement runs in a transaction that sets app.current_tenant_id, and the tables have FORCE ROW LEVEL SECURITY with
 * that tenant policy (see schema.ts), on top of an explicit tenant_id filter. The in-memory store (DB_MODE=memory) filters by tenant id and mirrors
 * the vendor foreign key (ON DELETE SET NULL) by reporting a null vendorId once the vendor is gone. Its writes never await between a check and the
 * write, so they are atomic on the event loop.
 *
 * Names, vendors, missions, services and notes may be CUI: they are never logged and never put in an error message or a history event (digests only).
 * An update needs the stamp the client loaded (expectedUpdatedAt) and fails with StaleWriteError when the row changed since.
 */

export type InventoryErrorCode =
  | 'invalid'
  | 'not_found'
  | 'vendor_not_found'
  | 'tool_not_found'
  | 'evidence_not_found'
  | 'duplicate_name'
  | 'limit'
  | 'stale_order'
  | 'stale_write'
  | 'invalid_tool_ids'
  | 'unknown_tools'
  | 'tool_in_use'
  | 'tool_not_in_boundary'
  | 'control_not_in_program'
  | 'unknown_cui_category';

export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
    /** Extra facts for the caller (counts and ids only, never a name or a text). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

export const INVENTORY_STATUS: Record<InventoryErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  vendor_not_found: 404,
  tool_not_found: 404,
  evidence_not_found: 404,
  duplicate_name: 409,
  limit: 429,
  stale_order: 409,
  stale_write: 409,
  invalid_tool_ids: 400,
  unknown_tools: 400,
  tool_in_use: 409,
  tool_not_in_boundary: 409,
  control_not_in_program: 400,
  unknown_cui_category: 400,
};

const isUniqueViolation = (err: unknown, constraint?: string): boolean =>
  (err as { code?: string })?.code === '23505' && (constraint === undefined || (err as { constraint?: string }).constraint === constraint);
const isForeignKeyViolation = (err: unknown): boolean => (err as { code?: string })?.code === '23503';

const toolNameTaken = (): InventoryError => new InventoryError('duplicate_name', 'A tool or service with that name already exists');
const vendorNameTaken = (): InventoryError => new InventoryError('duplicate_name', 'A vendor with that name already exists');
const toolMissing = (): InventoryError => new InventoryError('not_found', 'Tool not found');
const vendorMissing = (): InventoryError => new InventoryError('vendor_not_found', 'The vendor was not found in this organization');
const vendorGone = (): InventoryError => new InventoryError('not_found', 'Vendor not found');

const lower = (s: string): string => s.toLowerCase();
const originOf = (seedKey: string | null | undefined): ToolOrigin => (seedKey?.startsWith('survey:') ? 'SURVEY' : seedKey?.startsWith('catalog:') ? 'CATALOG' : 'MANUAL');

type StoredTool = InventoryTool & { annualCostCents: number | null };

const toolDefaults = (input: ToolInputWithSeed): Omit<StoredTool, 'id' | 'tenantId' | 'recoveryRank' | 'createdAt' | 'updatedAt' | 'updatedBy'> => ({
  name: input.name as string,
  vendorName: input.vendorName ?? '',
  vendorId: input.vendorId ?? null,
  mission: input.mission ?? '',
  toolType: input.toolType ?? null,
  deployment: input.deployment ?? null,
  assetCategory: input.assetCategory ?? null,
  fedrampStatus: input.fedrampStatus ?? 'UNKNOWN',
  fedrampVerifiedOn: input.fedrampVerifiedOn ?? null,
  crmOnFile: input.crmOnFile ?? null,
  endUsers: input.endUsers ?? null,
  privilegedUsers: input.privilegedUsers ?? null,
  annualCostCents: input.annualCostCents ?? null,
  renewalDate: input.renewalDate ?? null,
  origin: originOf(input.seedKey),
  seedKey: input.seedKey ?? null,
  notes: input.notes ?? '',
});

const vendorDefaults = (input: VendorInput): Omit<InventoryVendor, 'id' | 'tenantId' | 'createdAt' | 'updatedAt' | 'updatedBy'> => ({
  name: input.name as string,
  kind: input.kind ?? 'VENDOR',
  services: input.services ?? '',
  contractStart: input.contractStart ?? null,
  contractEnd: input.contractEnd ?? null,
  renewalDate: input.renewalDate ?? null,
  fedrampStatus: input.fedrampStatus ?? 'UNKNOWN',
  fedrampReference: input.fedrampReference ?? '',
  fedrampVerifiedOn: input.fedrampVerifiedOn ?? null,
  crmOnFile: input.crmOnFile ?? null,
  lastReviewDate: input.lastReviewDate ?? null,
  notes: input.notes ?? '',
});

// ------------------------------------------------------------------------------------------------ rows

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
/** A DATE column as YYYY-MM-DD (the driver returns a Date at local midnight). */
const dateOnly = (v: unknown): string | null =>
  v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : ((v as string | null | undefined) ?? null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToTool(r: pg.QueryResultRow): StoredTool {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    vendorName: r.vendor_name ?? '',
    vendorId: r.vendor_id ?? null,
    mission: r.mission ?? '',
    toolType: r.tool_type ?? null,
    deployment: r.deployment ?? null,
    assetCategory: r.asset_category ?? null,
    fedrampStatus: r.fedramp_status as FedrampStatus,
    fedrampVerifiedOn: dateOnly(r.fedramp_verified_on),
    crmOnFile: r.crm_on_file ?? null,
    endUsers: num(r.end_users),
    privilegedUsers: num(r.privileged_users),
    recoveryRank: num(r.recovery_rank),
    annualCostCents: num(r.annual_cost_cents),
    renewalDate: dateOnly(r.renewal_date),
    origin: r.origin as ToolOrigin,
    seedKey: r.seed_key ?? null,
    notes: r.notes ?? '',
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by ?? null,
  };
}

function rowToVendor(r: pg.QueryResultRow): InventoryVendor {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    kind: r.kind as VendorKind,
    services: r.services ?? '',
    contractStart: dateOnly(r.contract_start),
    contractEnd: dateOnly(r.contract_end),
    renewalDate: dateOnly(r.renewal_date),
    fedrampStatus: r.fedramp_status as FedrampStatus,
    fedrampReference: r.fedramp_reference ?? '',
    fedrampVerifiedOn: dateOnly(r.fedramp_verified_on),
    crmOnFile: r.crm_on_file ?? null,
    lastReviewDate: dateOnly(r.last_review_date),
    notes: r.notes ?? '',
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by ?? null,
  };
}

// ------------------------------------------------------------------------------------------------ memory store

const memoryTools = new Map<string, StoredTool>(); // key: id
const memoryVendors = new Map<string, InventoryVendor>(); // key: id

/** Test hook (also clears the history). */
export function __resetInventoryForTests(): void {
  memoryTools.clear();
  memoryVendors.clear();
  __resetInventoryEventsForTests();
}

/** The ids of the tenant's tools in the memory store (programInventoryStore intersects its own rows with them, as the foreign keys would). */
export function memoryToolIds(tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const t of memoryTools.values()) if (t.tenantId === tenantId) ids.add(t.id);
  return ids;
}

export function memoryVendorIds(tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const v of memoryVendors.values()) if (v.tenantId === tenantId) ids.add(v.id);
  return ids;
}

const mineTools = (tenantId: string): StoredTool[] => [...memoryTools.values()].filter((t) => t.tenantId === tenantId);
const mineVendors = (tenantId: string): InventoryVendor[] => [...memoryVendors.values()].filter((v) => v.tenantId === tenantId);
const copyTool = (t: StoredTool, vendorIds: ReadonlySet<string>): StoredTool => ({ ...t, vendorId: t.vendorId !== null && vendorIds.has(t.vendorId) ? t.vendorId : null });
const byName = <T extends { name: string; createdAt: string }>(a: T, b: T): number => lower(a.name).localeCompare(lower(b.name)) || a.createdAt.localeCompare(b.createdAt);

function eventSnapshot(t: StoredTool): Parameters<typeof toolEventFields>[1] {
  return t;
}

// ------------------------------------------------------------------------------------------------ tools

const TOOL_COLUMNS = {
  name: 'name', vendorName: 'vendor_name', vendorId: 'vendor_id', mission: 'mission', toolType: 'tool_type', deployment: 'deployment',
  assetCategory: 'asset_category', fedrampStatus: 'fedramp_status', fedrampVerifiedOn: 'fedramp_verified_on', crmOnFile: 'crm_on_file',
  endUsers: 'end_users', privilegedUsers: 'privileged_users', annualCostCents: 'annual_cost_cents', renewalDate: 'renewal_date', notes: 'notes',
} as const;
type ToolKey = keyof typeof TOOL_COLUMNS;
const TOOL_DATE_KEYS: ReadonlySet<string> = new Set(['fedrampVerifiedOn', 'renewalDate']);

/** Every tool of the tenant (with the cost: the route strips it for read roles), by name. */
export async function listTools(tenantId: string): Promise<InventoryTool[]> {
  if (isMemory()) {
    const vendorIds = memoryVendorIds(tenantId);
    return mineTools(tenantId).sort(byName).map((t) => copyTool(t, vendorIds));
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM inventory_tools WHERE tenant_id = $1 ORDER BY lower(name), created_at LIMIT $2', [tenantId, MAX_TOOLS_PER_TENANT]);
    return res.rows.map(rowToTool);
  });
}

export async function getTool(tenantId: string, id: string): Promise<InventoryTool | null> {
  if (isMemory()) {
    const t = memoryTools.get(id);
    return t && t.tenantId === tenantId ? copyTool(t, memoryVendorIds(tenantId)) : null;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM inventory_tools WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToTool(res.rows[0]) : null;
  });
}

const INSERT_TOOL = `INSERT INTO inventory_tools (tenant_id, name, vendor_name, vendor_id, mission, tool_type, deployment, asset_category, fedramp_status, fedramp_verified_on,
    crm_on_file, end_users, privileged_users, annual_cost_cents, renewal_date, origin, seed_key, notes, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15::date, $16, $17, $18, $19, $19)`;

const insertToolParams = (tenantId: string, f: ReturnType<typeof toolDefaults>, who: InventoryActor): unknown[] => [
  tenantId, f.name, f.vendorName, f.vendorId, f.mission, f.toolType, f.deployment, f.assetCategory, f.fedrampStatus, f.fedrampVerifiedOn,
  f.crmOnFile, f.endUsers, f.privilegedUsers, f.annualCostCents, f.renewalDate, f.origin, f.seedKey, f.notes, who.actor.slice(0, 255),
];

async function requireVendorsTx(q: Q, tenantId: string, ids: string[]): Promise<void> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const found = await q('SELECT id FROM inventory_vendors WHERE tenant_id = $1 AND id = ANY($2::text[])', [tenantId, wanted]);
  if (found.rows.length < wanted.length) throw vendorMissing();
}

export async function createTool(tenantId: string, input: ToolInputWithSeed, who: InventoryActor): Promise<InventoryTool> {
  const f = toolDefaults(input);
  if (isMemory()) {
    if (mineTools(tenantId).length >= MAX_TOOLS_PER_TENANT) throw new InventoryError('limit', 'This organization has reached the maximum number of tools and services');
    if (f.vendorId !== null && !memoryVendorIds(tenantId).has(f.vendorId)) throw vendorMissing();
    if (mineTools(tenantId).some((t) => lower(t.name) === lower(f.name))) throw toolNameTaken();
    const now = nextStamp();
    const tool: StoredTool = { ...f, id: crypto.randomUUID(), tenantId, recoveryRank: null, createdAt: now, updatedAt: now, updatedBy: who.actor.slice(0, 255) };
    memoryTools.set(tool.id, tool);
    pushMemoryInventoryEvent(tenantId, 'tool', tool.id, 'created', who, { ...toolEventFields(null, eventSnapshot(tool)), origin: tool.origin });
    return copyTool(tool, memoryVendorIds(tenantId));
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const count = await q('SELECT COUNT(*)::int AS n FROM inventory_tools WHERE tenant_id = $1', [tenantId]);
      if (count.rows[0].n >= MAX_TOOLS_PER_TENANT) throw new InventoryError('limit', 'This organization has reached the maximum number of tools and services');
      if (f.vendorId !== null) await requireVendorsTx(q, tenantId, [f.vendorId]);
      const res = await q(`${INSERT_TOOL} RETURNING *`, insertToolParams(tenantId, f, who));
      const tool = rowToTool(res.rows[0]);
      await insertEventTx(q, tenantId, 'tool', tool.id, 'created', who, { ...toolEventFields(null, eventSnapshot(tool)), origin: tool.origin });
      return tool;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_inventory_tools_name')) throw toolNameTaken();
    if (isForeignKeyViolation(err)) throw vendorMissing();
    throw err;
  }
}

/**
 * Creates the items that do not clash with the register (insert-only): an item whose seed key is already stored is skipped as duplicate_seed, one whose
 * name is taken (ignoring case, also by an item of this same batch) as duplicate_name, and everything past the tenant limit as limit. A vendor id that is
 * not in this tenant fails the whole batch (vendor_not_found) before anything is written.
 */
export async function createToolsBatch(tenantId: string, items: ToolInputWithSeed[], who: InventoryActor): Promise<ToolBatchResult> {
  const rows = items.map((item) => toolDefaults(item));
  const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => v !== null))];
  const result: ToolBatchResult = { created: [], skipped: [] };

  if (isMemory()) {
    const known = memoryVendorIds(tenantId);
    if (vendorIds.some((v) => !known.has(v))) throw vendorMissing();
    rows.forEach((f, index) => {
      const mine = mineTools(tenantId);
      if (mine.length >= MAX_TOOLS_PER_TENANT) return void result.skipped.push({ index, reason: 'limit' });
      if (f.seedKey !== null && mine.some((t) => t.seedKey === f.seedKey)) return void result.skipped.push({ index, reason: 'duplicate_seed' });
      if (mine.some((t) => lower(t.name) === lower(f.name))) return void result.skipped.push({ index, reason: 'duplicate_name' });
      const now = nextStamp();
      const tool: StoredTool = { ...f, id: crypto.randomUUID(), tenantId, recoveryRank: null, createdAt: now, updatedAt: now, updatedBy: who.actor.slice(0, 255) };
      memoryTools.set(tool.id, tool);
      pushMemoryInventoryEvent(tenantId, 'tool', tool.id, 'created', who, { ...toolEventFields(null, eventSnapshot(tool)), origin: tool.origin });
      result.created.push(copyTool(tool, known));
    });
    return result;
  }

  return inTenantTx(tenantId, async (q) => {
    await requireVendorsTx(q, tenantId, vendorIds);
    const count = await q('SELECT COUNT(*)::int AS n FROM inventory_tools WHERE tenant_id = $1', [tenantId]);
    let total = Number(count.rows[0].n);
    for (let index = 0; index < rows.length; index++) {
      const f = rows[index];
      if (total >= MAX_TOOLS_PER_TENANT) {
        result.skipped.push({ index, reason: 'limit' });
        continue;
      }
      const res = await q(`${INSERT_TOOL} ON CONFLICT DO NOTHING RETURNING *`, insertToolParams(tenantId, f, who));
      if (res.rows[0]) {
        const tool = rowToTool(res.rows[0]);
        total++;
        await insertEventTx(q, tenantId, 'tool', tool.id, 'created', who, { ...toolEventFields(null, eventSnapshot(tool)), origin: tool.origin });
        result.created.push(tool);
        continue;
      }
      // classify the skip: the seed key first, otherwise the name
      const seed = f.seedKey === null ? { rows: [] } : await q('SELECT 1 FROM inventory_tools WHERE tenant_id = $1 AND seed_key = $2', [tenantId, f.seedKey]);
      result.skipped.push({ index, reason: seed.rows.length > 0 ? 'duplicate_seed' : 'duplicate_name' });
    }
    return result;
  });
}

function changedToolKeys(before: StoredTool, patch: ToolInputWithSeed): ToolKey[] {
  return (Object.keys(TOOL_COLUMNS) as ToolKey[]).filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
}

/**
 * Changes the fields sent. `expectedUpdatedAt` is the stamp the client loaded: another stamp is a StaleWriteError (nothing written), checked before
 * anything else. A write that changes nothing writes no row and no event (changed false). Throws not_found, vendor_not_found, duplicate_name.
 */
export async function updateTool(tenantId: string, id: string, patch: ToolInputWithSeed, expectedUpdatedAt: string, who: InventoryActor): Promise<{ tool: InventoryTool; changed: boolean }> {
  const stale = (t: StoredTool): StaleWriteError => new StaleWriteError({ updatedAt: t.updatedAt, updatedBy: t.updatedBy });
  if (isMemory()) {
    const m = memoryTools.get(id);
    if (!m || m.tenantId !== tenantId) throw toolMissing();
    if (!matchesExpected(m.updatedAt, expectedUpdatedAt)) throw stale(m);
    const keys = changedToolKeys(m, patch);
    const known = memoryVendorIds(tenantId);
    if (keys.length === 0) return { tool: copyTool(m, known), changed: false };
    if (keys.includes('vendorId') && patch.vendorId && !known.has(patch.vendorId)) throw vendorMissing();
    if (keys.includes('name') && mineTools(tenantId).some((t) => t.id !== id && lower(t.name) === lower(patch.name as string))) throw toolNameTaken();
    const before: StoredTool = { ...m };
    Object.assign(m, Object.fromEntries(keys.map((k) => [k, patch[k]])), { updatedAt: nextStamp(m.updatedAt), updatedBy: who.actor.slice(0, 255) });
    pushMemoryInventoryEvent(tenantId, 'tool', id, 'updated', who, toolEventFields(eventSnapshot(before), eventSnapshot(m)));
    return { tool: copyTool(m, known), changed: true };
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const cur = await q('SELECT * FROM inventory_tools WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
      if (!cur.rows[0]) throw toolMissing();
      const before = rowToTool(cur.rows[0]);
      if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw stale(before);
      const keys = changedToolKeys(before, patch);
      if (keys.length === 0) return { tool: before, changed: false };
      if (keys.includes('vendorId') && patch.vendorId) await requireVendorsTx(q, tenantId, [patch.vendorId]);
      const params: unknown[] = [];
      const sets: string[] = [];
      for (const k of keys) {
        params.push(patch[k]);
        sets.push(`${TOOL_COLUMNS[k]} = $${params.length}${TOOL_DATE_KEYS.has(k) ? '::date' : ''}`);
      }
      params.push(who.actor.slice(0, 255));
      sets.push(`updated_by = $${params.length}`, "updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')");
      params.push(id, tenantId);
      const res = await q(`UPDATE inventory_tools SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`, params);
      const tool = rowToTool(res.rows[0]);
      await insertEventTx(q, tenantId, 'tool', id, 'updated', who, toolEventFields(before, tool));
      return { tool, changed: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_inventory_tools_name')) throw toolNameTaken();
    if (isForeignKeyViolation(err)) throw vendorMissing();
    throw err;
  }
}

/** Removes a tool; its boundary, control links and data-inventory rows go with it (foreign key cascades). False when it does not exist. */
export async function deleteTool(tenantId: string, id: string, who: InventoryActor): Promise<boolean> {
  if (isMemory()) {
    const m = memoryTools.get(id);
    if (!m || m.tenantId !== tenantId) return false;
    memoryTools.delete(id);
    pushMemoryInventoryEvent(tenantId, 'tool', id, 'deleted', who, {});
    return true;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('DELETE FROM inventory_tools WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, tenantId, 'tool', id, 'deleted', who, {});
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ recovery order

const sameSequence = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Ranks the listed tools 1..n in that order (tools not listed become unranked): the tenant-wide recovery priority. `expectedOrder` is the ranked ids
 * the client last saw, in rank order: anything else is stale_order (with `current`) and nothing is written. An unknown id is invalid.
 */
export async function setRecoveryOrder(tenantId: string, order: string[], expectedOrder: string[], who: InventoryActor): Promise<string[]> {
  const stale = (current: string[]): InventoryError => new InventoryError('stale_order', 'The recovery order changed after you loaded it', { current });
  const unknown = (): InventoryError => new InventoryError('invalid', 'order holds an id that is not a tool of this organization');
  if (isMemory()) {
    const mine = mineTools(tenantId);
    const current = mine.filter((t) => t.recoveryRank !== null).sort((a, b) => (a.recoveryRank as number) - (b.recoveryRank as number)).map((t) => t.id);
    if (!sameSequence(current, expectedOrder)) throw stale(current);
    const ids = new Set(mine.map((t) => t.id));
    if (order.some((id) => !ids.has(id))) throw unknown();
    for (const t of mine) t.recoveryRank = null;
    order.forEach((id, i) => {
      (memoryTools.get(id) as StoredTool).recoveryRank = i + 1;
    });
    if (!sameSequence(current, order)) pushMemoryInventoryEvent(tenantId, 'order', null, 'order_changed', who, { count: order.length, order: notesDigest(order.join(',')) });
    return [...order];
  }
  return inTenantTx(tenantId, async (q) => {
    const ranked = await q('SELECT id FROM inventory_tools WHERE tenant_id = $1 AND recovery_rank IS NOT NULL ORDER BY recovery_rank FOR UPDATE', [tenantId]);
    const current = ranked.rows.map((r) => String(r.id));
    if (!sameSequence(current, expectedOrder)) throw stale(current);
    if (order.length > 0) {
      const found = await q('SELECT id FROM inventory_tools WHERE tenant_id = $1 AND id = ANY($2::text[])', [tenantId, order]);
      if (found.rows.length < order.length) throw unknown();
    }
    await q('UPDATE inventory_tools SET recovery_rank = NULL WHERE tenant_id = $1 AND recovery_rank IS NOT NULL', [tenantId]);
    if (order.length > 0) {
      await q(
        `UPDATE inventory_tools t SET recovery_rank = o.rn::int
         FROM unnest($2::text[]) WITH ORDINALITY AS o(id, rn)
         WHERE t.tenant_id = $1 AND t.id = o.id`,
        [tenantId, order]
      );
    }
    if (!sameSequence(current, order)) await insertEventTx(q, tenantId, 'order', null, 'order_changed', who, { count: order.length, order: notesDigest(order.join(',')) });
    return [...order];
  });
}

// ------------------------------------------------------------------------------------------------ vendors

const VENDOR_COLUMNS = {
  name: 'name', kind: 'kind', services: 'services', contractStart: 'contract_start', contractEnd: 'contract_end', renewalDate: 'renewal_date',
  fedrampStatus: 'fedramp_status', fedrampReference: 'fedramp_reference', fedrampVerifiedOn: 'fedramp_verified_on', crmOnFile: 'crm_on_file',
  lastReviewDate: 'last_review_date', notes: 'notes',
} as const;
type VendorKey = keyof typeof VENDOR_COLUMNS;
const VENDOR_DATE_KEYS: ReadonlySet<string> = new Set(['contractStart', 'contractEnd', 'renewalDate', 'fedrampVerifiedOn', 'lastReviewDate']);

export async function listVendors(tenantId: string): Promise<InventoryVendor[]> {
  if (isMemory()) return mineVendors(tenantId).sort(byName).map((v) => ({ ...v }));
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM inventory_vendors WHERE tenant_id = $1 ORDER BY lower(name), created_at LIMIT $2', [tenantId, MAX_VENDORS_PER_TENANT]);
    return res.rows.map(rowToVendor);
  });
}

export async function getVendor(tenantId: string, id: string): Promise<InventoryVendor | null> {
  if (isMemory()) {
    const v = memoryVendors.get(id);
    return v && v.tenantId === tenantId ? { ...v } : null;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('SELECT * FROM inventory_vendors WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToVendor(res.rows[0]) : null;
  });
}

const contractOrder = (start: string | null, end: string | null): void => {
  if (start !== null && end !== null && end < start) throw new InventoryError('invalid', 'contractEnd must not be before contractStart');
};

export async function createVendor(tenantId: string, input: VendorInput, who: InventoryActor): Promise<InventoryVendor> {
  const f = vendorDefaults(input);
  contractOrder(f.contractStart, f.contractEnd);
  if (isMemory()) {
    if (mineVendors(tenantId).length >= MAX_VENDORS_PER_TENANT) throw new InventoryError('limit', 'This organization has reached the maximum number of vendors');
    if (mineVendors(tenantId).some((v) => lower(v.name) === lower(f.name))) throw vendorNameTaken();
    const now = nextStamp();
    const vendor: InventoryVendor = { ...f, id: crypto.randomUUID(), tenantId, createdAt: now, updatedAt: now, updatedBy: who.actor.slice(0, 255) };
    memoryVendors.set(vendor.id, vendor);
    pushMemoryInventoryEvent(tenantId, 'vendor', vendor.id, 'created', who, vendorEventFields(null, vendor));
    return { ...vendor };
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const count = await q('SELECT COUNT(*)::int AS n FROM inventory_vendors WHERE tenant_id = $1', [tenantId]);
      if (count.rows[0].n >= MAX_VENDORS_PER_TENANT) throw new InventoryError('limit', 'This organization has reached the maximum number of vendors');
      const res = await q(
        `INSERT INTO inventory_vendors (tenant_id, name, kind, services, contract_start, contract_end, renewal_date, fedramp_status, fedramp_reference,
            fedramp_verified_on, crm_on_file, last_review_date, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7::date, $8, $9, $10::date, $11, $12::date, $13, $14, $14) RETURNING *`,
        [tenantId, f.name, f.kind, f.services, f.contractStart, f.contractEnd, f.renewalDate, f.fedrampStatus, f.fedrampReference, f.fedrampVerifiedOn, f.crmOnFile, f.lastReviewDate, f.notes, who.actor.slice(0, 255)]
      );
      const vendor = rowToVendor(res.rows[0]);
      await insertEventTx(q, tenantId, 'vendor', vendor.id, 'created', who, vendorEventFields(null, vendor));
      return vendor;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_inventory_vendors_name')) throw vendorNameTaken();
    throw err;
  }
}

function changedVendorKeys(before: InventoryVendor, patch: VendorInput): VendorKey[] {
  return (Object.keys(VENDOR_COLUMNS) as VendorKey[]).filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
}

/** Same contract as updateTool; also refuses a contract end before its start (checked on the merged row). */
export async function updateVendor(tenantId: string, id: string, patch: VendorInput, expectedUpdatedAt: string, who: InventoryActor): Promise<{ vendor: InventoryVendor; changed: boolean }> {
  const stale = (v: InventoryVendor): StaleWriteError => new StaleWriteError({ updatedAt: v.updatedAt, updatedBy: v.updatedBy });
  if (isMemory()) {
    const m = memoryVendors.get(id);
    if (!m || m.tenantId !== tenantId) throw vendorGone();
    if (!matchesExpected(m.updatedAt, expectedUpdatedAt)) throw stale(m);
    const keys = changedVendorKeys(m, patch);
    if (keys.length === 0) return { vendor: { ...m }, changed: false };
    contractOrder(keys.includes('contractStart') ? (patch.contractStart ?? null) : m.contractStart, keys.includes('contractEnd') ? (patch.contractEnd ?? null) : m.contractEnd);
    if (keys.includes('name') && mineVendors(tenantId).some((v) => v.id !== id && lower(v.name) === lower(patch.name as string))) throw vendorNameTaken();
    const before: InventoryVendor = { ...m };
    Object.assign(m, Object.fromEntries(keys.map((k) => [k, patch[k]])), { updatedAt: nextStamp(m.updatedAt), updatedBy: who.actor.slice(0, 255) });
    pushMemoryInventoryEvent(tenantId, 'vendor', id, 'updated', who, vendorEventFields(before, m));
    return { vendor: { ...m }, changed: true };
  }
  try {
    return await inTenantTx(tenantId, async (q) => {
      const cur = await q('SELECT * FROM inventory_vendors WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenantId]);
      if (!cur.rows[0]) throw vendorGone();
      const before = rowToVendor(cur.rows[0]);
      if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw stale(before);
      const keys = changedVendorKeys(before, patch);
      if (keys.length === 0) return { vendor: before, changed: false };
      contractOrder(keys.includes('contractStart') ? (patch.contractStart ?? null) : before.contractStart, keys.includes('contractEnd') ? (patch.contractEnd ?? null) : before.contractEnd);
      const params: unknown[] = [];
      const sets: string[] = [];
      for (const k of keys) {
        params.push(patch[k]);
        sets.push(`${VENDOR_COLUMNS[k]} = $${params.length}${VENDOR_DATE_KEYS.has(k) ? '::date' : ''}`);
      }
      params.push(who.actor.slice(0, 255));
      sets.push(`updated_by = $${params.length}`, "updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')");
      params.push(id, tenantId);
      const res = await q(`UPDATE inventory_vendors SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`, params);
      const vendor = rowToVendor(res.rows[0]);
      await insertEventTx(q, tenantId, 'vendor', id, 'updated', who, vendorEventFields(before, vendor));
      return { vendor, changed: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'unq_inventory_vendors_name')) throw vendorNameTaken();
    throw err;
  }
}

/** Removes a vendor: tools that named it keep their row with a null vendorId, and its document links in every program go with it. False when it does not exist. */
export async function deleteVendor(tenantId: string, id: string, who: InventoryActor): Promise<boolean> {
  if (isMemory()) {
    const v = memoryVendors.get(id);
    if (!v || v.tenantId !== tenantId) return false;
    memoryVendors.delete(id);
    for (const t of memoryTools.values()) if (t.tenantId === tenantId && t.vendorId === id) t.vendorId = null;
    pushMemoryInventoryEvent(tenantId, 'vendor', id, 'deleted', who, {});
    return true;
  }
  return inTenantTx(tenantId, async (q) => {
    const res = await q('DELETE FROM inventory_vendors WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, tenantId, 'vendor', id, 'deleted', who, {});
    return true;
  });
}
