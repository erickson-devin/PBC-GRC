import { getDbMode } from './db';
import { MAX_ASSETS_PER_TENANT, listAssets, type AssetRecord } from './assets';
import { MAX_PROGRAMS_PER_TENANT, ProgramError, getProgram, inTenantTx, insertEventTx, listPrograms, pushMemoryEvent, type ProgramActor } from './programs';
import { summarizeScope, type AssetScopeSummary } from '../src/data/telemetry/assetScope';

/**
 * Boundary asset membership (issue #26): which assets of the tenant's inventory a program declares inside its boundary.
 * Assets stay tenant-wide (enclave_assets); one asset may belong to several programs. A program that declares none uses the whole
 * inventory (`declared: false`), so every tenant that never uses this keeps its output. Only ids are stored, logged or recorded in the
 * history: never a host name, an address or a note.
 *
 * PostgreSQL: program_assets has the tenant and the program row policies, so every statement runs in a transaction that sets both.
 * Deleting an asset or a program removes its rows through the foreign keys. The in-memory store keeps one Set per program and
 * intersects it with the current inventory on every read, which gives readers the same answer as the cascade.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Ids in one change (both lists together). */
export const MAX_ASSET_IDS_PER_CHANGE = MAX_ASSETS_PER_TENANT;
/** Ids kept per direction in a program event (the counts are always exact). */
const MAX_EVENT_IDS = 500;

const isMemory = (): boolean => getDbMode() === 'memory';
const memoryMembership = new Map<string, Set<string>>(); // key: tenantId__programId

const memoryKey = (tenantId: string, programId: string): string => `${tenantId}__${programId}`;

/** Test hook. */
export function __resetProgramAssetsForTests(): void {
  memoryMembership.clear();
}

export interface ProgramAssetChange {
  add: string[];
  remove: string[];
}

export interface ProgramAssetsResult {
  programId: string;
  /** True when the program names at least one asset; false means its boundary is the whole inventory. */
  declared: boolean;
  assetIds: string[];
}

export interface ProgramAssetsBoundary extends ProgramAssetsResult {
  summary: AssetScopeSummary;
}

export interface ProgramAssetsChanged extends ProgramAssetsResult {
  added: number;
  removed: number;
}

/** Checks a PATCH body: `add` and `remove` are optional arrays of asset ids, not both empty, no id in both. Throws invalid_asset_ids. */
export function parseAssetChange(body: unknown): ProgramAssetChange {
  const bad = (message: string): never => {
    throw new ProgramError('invalid_asset_ids', message);
  };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const list = (raw: unknown, field: string): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return bad(`Invalid ${field}: expected a list of asset ids`);
    if (raw.length > MAX_ASSET_IDS_PER_CHANGE) return bad(`Too many asset ids: at most ${MAX_ASSET_IDS_PER_CHANGE} per change`);
    for (const id of raw) if (typeof id !== 'string' || !ID_PATTERN.test(id)) return bad(`Invalid ${field}: an asset id is 1 to 64 letters, digits, underscores or hyphens`);
    return [...new Set(raw as string[])];
  };
  const rawAdd = Array.isArray(b.add) ? b.add.length : 0;
  const rawRemove = Array.isArray(b.remove) ? b.remove.length : 0;
  if (rawAdd + rawRemove > MAX_ASSET_IDS_PER_CHANGE) bad(`Too many asset ids: at most ${MAX_ASSET_IDS_PER_CHANGE} per change`);
  const add = list(b.add, 'add');
  const remove = list(b.remove, 'remove');
  if (add.length + remove.length === 0) bad('Nothing to change: send add and/or remove with at least one asset id');
  const removing = new Set(remove);
  if (add.some((id) => removing.has(id))) bad('An asset id cannot be in both add and remove');
  return { add, remove };
}

/** The asset ids the program declares, sorted. A program of another tenant, or an unknown one, has none (callers check it exists). */
export async function getProgramAssetIds(tenantId: string, programId: string): Promise<string[]> {
  if (isMemory()) {
    const set = memoryMembership.get(memoryKey(tenantId, programId));
    if (!set || set.size === 0) return [];
    const live = new Set((await listAssets(tenantId)).map((a) => a.id));
    return [...set].filter((id) => live.has(id)).sort();
  }
  return inTenantTx(tenantId, async (q) => {
    await q('SELECT set_config($1, $2, true)', ['app.current_program_id', programId]);
    const res = await q('SELECT asset_id FROM program_assets WHERE tenant_id = $1 AND program_id = $2 ORDER BY asset_id', [tenantId, programId]);
    return res.rows.map((r) => String(r.asset_id));
  });
}

/** What a program's boundary is: its declared assets, or the whole inventory when it declares none. 404 for an unknown program. */
export async function getProgramBoundary(tenantId: string, programId: string): Promise<ProgramAssetsBoundary> {
  const program = await getProgram(tenantId, programId);
  if (!program) throw new ProgramError('program_not_found', 'Program not found');
  const [assetIds, inventory] = await Promise.all([getProgramAssetIds(tenantId, program.id), listAssets(tenantId)]);
  const declared = assetIds.length > 0;
  const members = new Set(assetIds);
  const scoped: AssetRecord[] = declared ? inventory.filter((a) => members.has(a.id)) : inventory;
  return { programId: program.id, declared, assetIds, summary: summarizeScope(scoped) };
}

function eventValue(added: string[], removed: string[]): Record<string, unknown> {
  return {
    added: added.length,
    removed: removed.length,
    addedIds: added.slice(0, MAX_EVENT_IDS),
    removedIds: removed.slice(0, MAX_EVENT_IDS),
    truncated: added.length > MAX_EVENT_IDS || removed.length > MAX_EVENT_IDS,
  };
}

/**
 * Adds and removes assets in a program's boundary (delta semantics: two editors do not overwrite each other). Adding a member or removing
 * a non-member is not a change. Throws program_not_found, program_archived, unknown_assets (an id that is not in this tenant's inventory,
 * with `count`). Records one `assets_changed` event when something changed.
 */
export async function changeProgramAssets(tenantId: string, programId: string, change: ProgramAssetChange, who: ProgramActor): Promise<ProgramAssetsChanged> {
  const unknown = (count: number) => new ProgramError('unknown_assets', 'Some asset ids are not in the inventory of this tenant', { count });

  if (isMemory()) {
    const program = await getProgram(tenantId, programId);
    if (!program) throw new ProgramError('program_not_found', 'Program not found');
    if (program.archivedAt) throw new ProgramError('program_archived', 'The program is archived: unarchive it to change its assets');
    const live = new Set((await listAssets(tenantId)).map((a) => a.id));
    const missing = change.add.filter((id) => !live.has(id)).length;
    if (missing > 0) throw unknown(missing);
    const key = memoryKey(tenantId, programId);
    const set = new Set([...(memoryMembership.get(key) ?? [])].filter((id) => live.has(id)));
    const added = change.add.filter((id) => !set.has(id));
    for (const id of added) set.add(id);
    const removed = change.remove.filter((id) => set.delete(id));
    memoryMembership.set(key, set);
    if (added.length + removed.length > 0) pushMemoryEvent(tenantId, programId, 'assets_changed', who, null, eventValue(added, removed));
    return { programId, declared: set.size > 0, assetIds: [...set].sort(), added: added.length, removed: removed.length };
  }

  try {
    return await inTenantTx(tenantId, async (q) => {
      const row = await q('SELECT archived_at FROM programs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, programId]);
      if (!row.rows[0]) throw new ProgramError('program_not_found', 'Program not found');
      if (row.rows[0].archived_at) throw new ProgramError('program_archived', 'The program is archived: unarchive it to change its assets');
      if (change.add.length > 0) {
        const found = await q('SELECT id FROM enclave_assets WHERE tenant_id = $1 AND id = ANY($2::text[])', [tenantId, change.add]);
        if (found.rows.length < change.add.length) throw unknown(change.add.length - found.rows.length);
      }
      await q('SELECT set_config($1, $2, true)', ['app.current_program_id', programId]);
      const added: string[] = [];
      const removed: string[] = [];
      if (change.add.length > 0) {
        const res = await q(
          `INSERT INTO program_assets (tenant_id, program_id, asset_id, added_by)
           SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x
           ON CONFLICT DO NOTHING
           RETURNING asset_id`,
          [tenantId, programId, change.add, who.userId ? who.userId.slice(0, 255) : null]
        );
        added.push(...res.rows.map((r) => String(r.asset_id)));
      }
      if (change.remove.length > 0) {
        const res = await q('DELETE FROM program_assets WHERE tenant_id = $1 AND program_id = $2 AND asset_id = ANY($3::text[]) RETURNING asset_id', [tenantId, programId, change.remove]);
        removed.push(...res.rows.map((r) => String(r.asset_id)));
      }
      if (added.length + removed.length > 0) await insertEventTx(q, tenantId, programId, 'assets_changed', who, null, eventValue(added.sort(), removed.sort()));
      const all = await q('SELECT asset_id FROM program_assets WHERE tenant_id = $1 AND program_id = $2 ORDER BY asset_id', [tenantId, programId]);
      const assetIds = all.rows.map((r) => String(r.asset_id));
      return { programId, declared: assetIds.length > 0, assetIds, added: added.length, removed: removed.length };
    });
  } catch (err: unknown) {
    // an asset deleted between the check and the insert breaks the foreign key
    if ((err as { code?: string })?.code === '23503') throw unknown(1);
    throw err;
  }
}

/** The declared assets of every program of the tenant, archived ones included, in the order of listPrograms (the default first). */
export async function listAssetMemberships(tenantId: string): Promise<Array<{ programId: string; archived: boolean; assetIds: string[] }>> {
  const programs = (await listPrograms(tenantId, { includeArchived: true })).slice(0, MAX_PROGRAMS_PER_TENANT);
  const out: Array<{ programId: string; archived: boolean; assetIds: string[] }> = [];
  for (const p of programs) out.push({ programId: p.id, archived: p.archivedAt !== null, assetIds: await getProgramAssetIds(tenantId, p.id) });
  return out;
}
