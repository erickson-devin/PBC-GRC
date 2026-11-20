import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, pool } from '../db';
import { notesDigest } from '../controlAssessments';
import type { InventoryEvent, InventoryTool, InventoryVendor } from '../../src/types/inventory';

/**
 * The Tools and Services register's history (inventory_events): who changed which tool or vendor, and which fields. It holds ids, enum values,
 * dates, counts, flags and the SHA-256 and length of every text field (name, vendor, mission, notes) and of the cost: never a name, a mission,
 * a note or a cost value (they may be CUI or commercial secrets). The cost digest sits under `annualCostCents`, which readers without a write role
 * never see (redactEventsForRole). Append-only in PostgreSQL (trigger); DELETE stays allowed for a later retention sweep.
 */

export const isMemory = (): boolean => getDbMode() === 'memory';

export type Q = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** One PostgreSQL transaction under the tenant's RLS context. */
export async function inTenantTx<T>(tenantId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Who made a change, as recorded: the signed-in user, never a name from a request body. */
export interface InventoryActor {
  actor: string;
  userId: string | null;
}

export type EventFields = InventoryEvent['fields'];
type EntityKind = InventoryEvent['entityKind'];

type ToolSnapshot = Pick<InventoryTool, 'name' | 'vendorName' | 'vendorId' | 'mission' | 'toolType' | 'deployment' | 'assetCategory' | 'fedrampStatus' | 'fedrampVerifiedOn' | 'crmOnFile' | 'endUsers' | 'privilegedUsers' | 'renewalDate' | 'notes'> & { annualCostCents: number | null };
type VendorSnapshot = Pick<InventoryVendor, 'name' | 'kind' | 'services' | 'contractStart' | 'contractEnd' | 'renewalDate' | 'fedrampStatus' | 'fedrampReference' | 'fedrampVerifiedOn' | 'crmOnFile' | 'lastReviewDate' | 'notes'>;

const TOOL_TEXT = ['name', 'vendorName', 'mission', 'notes'] as const;
const TOOL_PLAIN = ['vendorId', 'toolType', 'deployment', 'assetCategory', 'fedrampStatus', 'fedrampVerifiedOn', 'crmOnFile', 'endUsers', 'privilegedUsers', 'renewalDate'] as const;
const VENDOR_TEXT = ['name', 'services', 'fedrampReference', 'notes'] as const;
const VENDOR_PLAIN = ['kind', 'contractStart', 'contractEnd', 'renewalDate', 'fedrampStatus', 'crmOnFile', 'fedrampVerifiedOn', 'lastReviewDate'] as const;

export const EMPTY_TOOL: ToolSnapshot = {
  name: '', vendorName: '', vendorId: null, mission: '', toolType: null, deployment: null, assetCategory: null, fedrampStatus: 'UNKNOWN',
  fedrampVerifiedOn: null, crmOnFile: null, endUsers: null, privilegedUsers: null, renewalDate: null, notes: '', annualCostCents: null,
};
export const EMPTY_VENDOR: VendorSnapshot = {
  name: '', kind: 'VENDOR', services: '', contractStart: null, contractEnd: null, renewalDate: null, fedrampStatus: 'UNKNOWN', fedrampReference: '',
  fedrampVerifiedOn: null, crmOnFile: null, lastReviewDate: null, notes: '',
};

function diff(before: Record<string, unknown>, after: Record<string, unknown>, textKeys: readonly string[], plainKeys: readonly string[]): EventFields {
  const out: EventFields = {};
  for (const key of textKeys) {
    if (before[key] !== after[key]) out[key] = notesDigest(String(after[key] ?? ''));
  }
  for (const key of plainKeys) {
    if (before[key] !== after[key]) out[key] = (after[key] ?? null) as string | number | boolean | null;
  }
  return out;
}

/** The fields that differ between two versions of a tool (before null = a new tool, compared with the empty one). Text and cost as digests only. */
export function toolEventFields(before: ToolSnapshot | null, after: ToolSnapshot): EventFields {
  const b = before ?? EMPTY_TOOL;
  const out = diff(b, after, TOOL_TEXT, TOOL_PLAIN);
  if ((b.annualCostCents ?? null) !== (after.annualCostCents ?? null)) out.annualCostCents = after.annualCostCents === null || after.annualCostCents === undefined ? null : notesDigest(String(after.annualCostCents));
  return out;
}

export function vendorEventFields(before: VendorSnapshot | null, after: VendorSnapshot): EventFields {
  return diff(before ?? EMPTY_VENDOR, after, VENDOR_TEXT, VENDOR_PLAIN);
}

/** Readers without a write role never see the cost: its digest is dropped from every event. */
export function redactEventsForRole(events: InventoryEvent[], canSeeCost: boolean): InventoryEvent[] {
  if (canSeeCost) return events;
  return events.map((e) => {
    if (!('annualCostCents' in e.fields)) return e;
    const { annualCostCents: _cost, ...rest } = e.fields;
    return { ...e, fields: rest };
  });
}

// ------------------------------------------------------------------------------------------------ storage

interface MemoryEvent extends InventoryEvent {
  tenantId: string;
}
const memoryEvents: MemoryEvent[] = [];

/** Test hook. */
export function __resetInventoryEventsForTests(): void {
  memoryEvents.length = 0;
}

const iso = (v: unknown): string => new Date(v as string).toISOString();

/** Records one event inside the writer's transaction (PostgreSQL). */
export async function insertEventTx(q: Q, tenantId: string, kind: EntityKind, entityId: string | null, action: string, who: InventoryActor, fields: EventFields): Promise<void> {
  await q(
    `INSERT INTO inventory_events (tenant_id, entity_kind, entity_id, action, actor, actor_user_id, fields, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp())`,
    [tenantId, kind, entityId, action, who.actor.slice(0, 255), who.userId ? who.userId.slice(0, 128) : null, JSON.stringify(fields)]
  );
}

export function pushMemoryInventoryEvent(tenantId: string, kind: EntityKind, entityId: string | null, action: string, who: InventoryActor, fields: EventFields): void {
  memoryEvents.push({ id: crypto.randomUUID(), tenantId, entityKind: kind, entityId, action, actor: who.actor.slice(0, 255), createdAt: new Date().toISOString(), fields });
}

/** The register's history of the tenant, newest first (at most `limit`, 1 to 200, 100 by default), optionally for one tool or vendor. */
export async function listInventoryEvents(tenantId: string, opts: { entityId?: string; limit?: number } = {}): Promise<InventoryEvent[]> {
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 100)));
  if (isMemory()) {
    return memoryEvents
      .filter((e) => e.tenantId === tenantId && (opts.entityId === undefined || e.entityId === opts.entityId))
      .reverse()
      .slice(0, n)
      .map(({ tenantId: _tenant, ...e }) => ({ ...e, fields: { ...e.fields } }));
  }
  return inTenantTx(tenantId, async (q) => {
    const res = opts.entityId === undefined
      ? await q('SELECT * FROM inventory_events WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [tenantId, n])
      : await q('SELECT * FROM inventory_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [tenantId, opts.entityId, n]);
    return res.rows.map((r) => ({
      id: String(r.id),
      entityKind: r.entity_kind as EntityKind,
      entityId: r.entity_id ?? null,
      action: String(r.action),
      actor: String(r.actor),
      createdAt: iso(r.created_at),
      fields: (r.fields ?? {}) as EventFields,
    }));
  });
}
