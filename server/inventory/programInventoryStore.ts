import crypto from 'crypto';
import type pg from 'pg';
import { nextStamp, queryWithProgram, type ProgramScope } from '../db';
import { matchesExpected, StaleWriteError } from '../controlAssessments';
import { inTenantTx, isMemory, type InventoryActor, type Q } from './events';
import { InventoryError, memoryToolIds, memoryVendorIds } from './registerStore';
import type { DataInventoryInput, ToolControlLinkInput } from '../../src/data/inventory/inventorySchema';
import {
  MAX_DOCS_PER_VENDOR_PER_PROGRAM,
  MAX_LINKS_PER_PROGRAM,
  type CuiToolRole,
  type DataInventoryRecord,
  type ProgramInventory,
  type ProgramInventoryEvent,
  type ToolControlLink,
  type VendorDocumentKind,
  type VendorDocumentLink,
} from '../../src/types/inventory';

/**
 * A program's side of the Tools and Services register (issues #239, #243, #248): which tools it declares inside its boundary (none declared = the
 * whole register applies, like the boundary assets of server/programAssets.ts), the controls each tool is linked to (validated against the program's
 * own catalog by the route), the data inventory (FCI answer, CUI categories and the tools that store, process or transmit each) and the vendor
 * documents (evidence ids of this program). The tools and vendors themselves live in registerStore.ts, tenant-wide.
 *
 * PostgreSQL: every table here has the tenant and the program row policies, so each statement runs in a transaction that sets both settings; deleting a
 * tool, a vendor or a program removes its rows through the foreign keys. The in-memory store keeps its own maps and intersects every read with the live
 * tool and vendor ids of the tenant, which gives readers the same answer as the cascades. Its writes never await between a check and the write.
 *
 * Only ids, flags, counts and enum values are stored in the history (program_inventory_events): never a name, a mission or a note.
 */

const lowerSort = (ids: Iterable<string>): string[] => [...ids].sort();
/** Ids kept per list in a history event (the counts are always exact). */
const MAX_EVENT_IDS = 200;
const cap = (ids: string[]): { ids: string[]; truncated: boolean } => ({ ids: ids.slice(0, MAX_EVENT_IDS), truncated: ids.length > MAX_EVENT_IDS });

const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
const keyOf = (scope: ProgramScope): string => `${scope.tenantId}__${scope.programId}`;
const hasScope = (scope: ProgramScope): boolean => Boolean(scope.tenantId) && Boolean(scope.programId);

// ------------------------------------------------------------------------------------------------ memory store

interface MemoryData {
  handlesFci: boolean | null;
  updatedAt: string;
  updatedBy: string | null;
  categories: Map<string, Map<string, CuiToolRole>>; // categoryId -> toolId -> roles
}
interface MemoryProgram {
  members: Set<string>;
  links: Map<string, Map<string, boolean>>; // toolId -> controlId -> evidenceSource
  data: MemoryData | null;
  docs: VendorDocumentLink[];
}
interface MemoryEvent extends ProgramInventoryEvent {
  tenantId: string;
  programId: string;
}
const memoryPrograms = new Map<string, MemoryProgram>(); // key: tenantId__programId
const memoryEvents: MemoryEvent[] = [];

const blank = (): MemoryProgram => ({ members: new Set(), links: new Map(), data: null, docs: [] });
function memoryOf(scope: ProgramScope): MemoryProgram {
  let m = memoryPrograms.get(keyOf(scope));
  if (!m) {
    m = blank();
    memoryPrograms.set(keyOf(scope), m);
  }
  return m;
}

/** Test hook. */
export function __resetProgramInventoryForTests(): void {
  memoryPrograms.clear();
  memoryEvents.length = 0;
}

/** The rows of a deleted program go with it (in PostgreSQL the foreign keys cascade); its history stays, like program_events. */
export function __deleteProgramInventoryForMemory(scope: ProgramScope): void {
  if (hasScope(scope)) memoryPrograms.delete(keyOf(scope));
}

/** Test hook: how many rows (members, links, categories, category-tool rows, documents) the memory store holds for the program, history excluded. */
export function __programInventoryRowsForTests(scope: ProgramScope): number {
  const m = memoryPrograms.get(keyOf(scope));
  if (!m) return 0;
  let n = m.members.size + m.docs.length + (m.data ? 1 + m.data.categories.size : 0);
  for (const l of m.links.values()) n += l.size;
  for (const c of m.data?.categories.values() ?? []) n += c.size;
  return n;
}

function pushEvent(scope: ProgramScope, action: string, entityId: string | null, who: InventoryActor, detail: Record<string, unknown>): void {
  memoryEvents.push({ id: crypto.randomUUID(), tenantId: scope.tenantId, programId: scope.programId, action, entityId, actor: who.actor.slice(0, 255), createdAt: new Date().toISOString(), detail });
}

// ------------------------------------------------------------------------------------------------ PostgreSQL helpers

/** One transaction under the tenant's and the program's row policies. */
function inProgramTx<T>(scope: ProgramScope, fn: (q: Q) => Promise<T>): Promise<T> {
  return inTenantTx(scope.tenantId, async (q) => {
    await q('SELECT set_config($1, $2, true)', ['app.current_program_id', scope.programId]);
    return fn(q);
  });
}

/** Serializes the program's inventory writers (a lock that does not block the foreign keys of other tables). */
const lockProgram = (q: Q, scope: ProgramScope): Promise<pg.QueryResult> => q('SELECT 1 FROM programs WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE', [scope.tenantId, scope.programId]);

async function insertEventTx(q: Q, scope: ProgramScope, action: string, entityId: string | null, who: InventoryActor, detail: Record<string, unknown>): Promise<void> {
  await q(
    `INSERT INTO program_inventory_events (tenant_id, program_id, action, entity_id, actor, actor_user_id, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp())`,
    [scope.tenantId, scope.programId, action, entityId, who.actor.slice(0, 255), who.userId ? who.userId.slice(0, 128) : null, JSON.stringify(detail)]
  );
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && lowerSort(a).every((id, i) => id === lowerSort(b)[i]);

// ------------------------------------------------------------------------------------------------ reads

async function membersTx(q: Q, scope: ProgramScope): Promise<string[]> {
  const res = await q('SELECT tool_id FROM program_tools WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  return lowerSort(res.rows.map((r) => String(r.tool_id)));
}

function liveMembers(scope: ProgramScope): string[] {
  const m = memoryPrograms.get(keyOf(scope));
  if (!m) return [];
  const live = memoryToolIds(scope.tenantId);
  return lowerSort([...m.members].filter((id) => live.has(id)));
}

const sortLinks = (links: ToolControlLink[]): ToolControlLink[] => links.sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0));
const sortDocs = (docs: VendorDocumentLink[]): VendorDocumentLink[] => docs.sort((a, b) => (a.vendorId < b.vendorId ? -1 : a.vendorId > b.vendorId ? 1 : a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0));

/** The tool ids the program declares in its boundary, sorted (none = the whole register). */
export async function getProgramToolIds(scope: ProgramScope): Promise<string[]> {
  if (!hasScope(scope)) return [];
  if (isMemory()) return liveMembers(scope);
  return inProgramTx(scope, (q) => membersTx(q, scope));
}

/** The program's boundary, tool-to-control links and vendor documents. */
export async function readProgramInventory(scope: ProgramScope): Promise<ProgramInventory> {
  const empty: ProgramInventory = { programId: scope.programId, declared: false, toolIds: [], controlLinks: [], vendorDocuments: [] };
  if (!hasScope(scope)) return empty;
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    if (!m) return empty;
    const liveTools = memoryToolIds(scope.tenantId);
    const liveVendors = memoryVendorIds(scope.tenantId);
    const toolIds = liveMembers(scope);
    const controlLinks: ToolControlLink[] = [];
    for (const [toolId, controls] of m.links) {
      if (!liveTools.has(toolId)) continue;
      for (const [controlId, evidenceSource] of controls) controlLinks.push({ toolId, controlId, evidenceSource });
    }
    return {
      programId: scope.programId,
      declared: toolIds.length > 0,
      toolIds,
      controlLinks: sortLinks(controlLinks),
      vendorDocuments: sortDocs(m.docs.filter((d) => liveVendors.has(d.vendorId)).map((d) => ({ ...d }))),
    };
  }
  return inProgramTx(scope, async (q) => {
    const toolIds = await membersTx(q, scope);
    const links = await q('SELECT tool_id, control_id, evidence_source FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 LIMIT $3', [scope.tenantId, scope.programId, MAX_LINKS_PER_PROGRAM]);
    const docs = await q('SELECT vendor_id, evidence_id, doc_kind, linked_by, linked_at FROM program_vendor_documents WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
    return {
      programId: scope.programId,
      declared: toolIds.length > 0,
      toolIds,
      controlLinks: sortLinks(links.rows.map((r) => ({ toolId: String(r.tool_id), controlId: String(r.control_id), evidenceSource: r.evidence_source === true }))),
      vendorDocuments: sortDocs(docs.rows.map(docFromRow)),
    };
  });
}

function docFromRow(r: pg.QueryResultRow): VendorDocumentLink {
  return { vendorId: String(r.vendor_id), evidenceId: String(r.evidence_id), docKind: r.doc_kind as VendorDocumentKind, linkedAt: iso(r.linked_at), linkedBy: r.linked_by ?? null };
}

/** How one tool is used in the program: in the declared boundary, linked to controls, named in the data inventory. */
export async function countToolUsage(scope: ProgramScope, toolId: string): Promise<{ member: boolean; controlLinks: number; cuiLinks: number }> {
  if (!hasScope(scope)) return { member: false, controlLinks: 0, cuiLinks: 0 };
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    if (!m) return { member: false, controlLinks: 0, cuiLinks: 0 };
    let cui = 0;
    for (const c of m.data?.categories.values() ?? []) if (c.has(toolId)) cui++;
    return { member: m.members.has(toolId), controlLinks: m.links.get(toolId)?.size ?? 0, cuiLinks: cui };
  }
  return inProgramTx(scope, async (q) => {
    const res = await q(
      `SELECT (SELECT COUNT(*)::int FROM program_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = $3) AS member,
              (SELECT COUNT(*)::int FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id = $3) AS links,
              (SELECT COUNT(*)::int FROM program_cui_category_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = $3) AS cui`,
      [scope.tenantId, scope.programId, toolId]
    );
    const r = res.rows[0];
    return { member: Number(r.member) > 0, controlLinks: Number(r.links), cuiLinks: Number(r.cui) };
  });
}

// ------------------------------------------------------------------------------------------------ boundary

export interface ProgramToolsChanged {
  programId: string;
  declared: boolean;
  toolIds: string[];
  added: number;
  removed: number;
  /** With force: how many control links and data-inventory rows went with the removed tools. */
  linksRemoved: number;
  cuiLinksRemoved: number;
}

const inUse = (controlLinks: number, cuiLinks: number): InventoryError =>
  new InventoryError('tool_in_use', 'A tool you are removing is still linked to controls or named in the data inventory', { controlLinks, cuiLinks });
const unknownTools = (count: number): InventoryError => new InventoryError('unknown_tools', 'Some tool ids are not in the register of this organization', { count });

/**
 * Adds and removes tools in the program's boundary (deltas, so two editors do not overwrite each other). Adding a member or removing a non-member is not
 * a change. Throws unknown_tools ({ count }: an id that is not a tool of the tenant) and tool_in_use ({ controlLinks, cuiLinks }) when a removed member
 * still has links, unless `force`: then its links and data-inventory rows are deleted in the same transaction. One `tools_changed` event when something changed.
 */
export async function changeProgramTools(scope: ProgramScope, change: { add: string[]; remove: string[]; force: boolean }, who: InventoryActor): Promise<ProgramToolsChanged> {
  const eventDetail = (added: string[], removed: string[], linksRemoved: number, cuiRemoved: number): Record<string, unknown> => {
    const a = cap(added);
    const r = cap(removed);
    return { added: a.ids, removed: r.ids, addedCount: added.length, removedCount: removed.length, forced: change.force && linksRemoved + cuiRemoved > 0, linksRemoved, cuiLinksRemoved: cuiRemoved, truncated: a.truncated || r.truncated };
  };

  if (isMemory()) {
    const live = memoryToolIds(scope.tenantId);
    const missing = change.add.filter((id) => !live.has(id)).length;
    if (missing > 0) throw unknownTools(missing);
    const m = memoryOf(scope);
    for (const id of [...m.members]) if (!live.has(id)) m.members.delete(id);
    const removing = change.remove.filter((id) => m.members.has(id));
    let links = 0;
    let cui = 0;
    for (const id of removing) {
      links += m.links.get(id)?.size ?? 0;
      for (const c of m.data?.categories.values() ?? []) if (c.has(id)) cui++;
    }
    if (links + cui > 0 && !change.force) throw inUse(links, cui);
    for (const id of removing) {
      m.links.delete(id);
      for (const c of m.data?.categories.values() ?? []) c.delete(id);
    }
    const added = change.add.filter((id) => !m.members.has(id));
    for (const id of added) m.members.add(id);
    for (const id of removing) m.members.delete(id);
    if (added.length + removing.length > 0) pushEvent(scope, 'tools_changed', null, who, eventDetail(lowerSort(added), lowerSort(removing), links, cui));
    return { programId: scope.programId, declared: m.members.size > 0, toolIds: lowerSort(m.members), added: added.length, removed: removing.length, linksRemoved: change.force ? links : 0, cuiLinksRemoved: change.force ? cui : 0 };
  }

  try {
    return await inProgramTx(scope, async (q) => {
      await lockProgram(q, scope);
      if (change.add.length > 0) {
        const found = await q('SELECT id FROM inventory_tools WHERE tenant_id = $1 AND id = ANY($2::text[])', [scope.tenantId, change.add]);
        if (found.rows.length < change.add.length) throw unknownTools(change.add.length - found.rows.length);
      }
      let removing: string[] = [];
      let links = 0;
      let cui = 0;
      if (change.remove.length > 0) {
        const members = await q('SELECT tool_id FROM program_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])', [scope.tenantId, scope.programId, change.remove]);
        removing = members.rows.map((r) => String(r.tool_id));
        if (removing.length > 0) {
          const use = await q(
            `SELECT (SELECT COUNT(*)::int FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])) AS links,
                    (SELECT COUNT(*)::int FROM program_cui_category_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])) AS cui`,
            [scope.tenantId, scope.programId, removing]
          );
          links = Number(use.rows[0].links);
          cui = Number(use.rows[0].cui);
          if (links + cui > 0 && !change.force) throw inUse(links, cui);
          if (links > 0) await q('DELETE FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
          if (cui > 0) await q('DELETE FROM program_cui_category_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
          await q('DELETE FROM program_tools WHERE tenant_id = $1 AND program_id = $2 AND tool_id = ANY($3::text[])', [scope.tenantId, scope.programId, removing]);
        }
      }
      let added: string[] = [];
      if (change.add.length > 0) {
        const res = await q(
          `INSERT INTO program_tools (tenant_id, program_id, tool_id, added_by)
           SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x
           ON CONFLICT DO NOTHING
           RETURNING tool_id`,
          [scope.tenantId, scope.programId, change.add, who.actor.slice(0, 255)]
        );
        added = res.rows.map((r) => String(r.tool_id));
      }
      if (added.length + removing.length > 0) await insertEventTx(q, scope, 'tools_changed', null, who, eventDetail(lowerSort(added), lowerSort(removing), links, cui));
      const toolIds = await membersTx(q, scope);
      return { programId: scope.programId, declared: toolIds.length > 0, toolIds, added: added.length, removed: removing.length, linksRemoved: change.force ? links : 0, cuiLinksRemoved: change.force ? cui : 0 };
    });
  } catch (err) {
    // a tool deleted between the check and the insert breaks the foreign key
    if ((err as { code?: string })?.code === '23503') throw unknownTools(1);
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ control links

const toolMissing = (): InventoryError => new InventoryError('tool_not_found', 'The tool was not found in this organization');
const outsideBoundary = (): InventoryError => new InventoryError('tool_not_in_boundary', 'The tool is not in the boundary this program declares: add it to the boundary first');
const staleLinks = (currentControlIds: string[]): InventoryError => new InventoryError('stale_write', 'The control links of this tool changed after you loaded them', { currentControlIds });
const linkLimit = (): InventoryError => new InventoryError('limit', 'This program has reached the maximum number of tool-to-control links');

interface LinkPlan {
  added: ToolControlLinkInput[];
  removed: string[];
  flipped: ToolControlLinkInput[];
}

function planLinks(current: Map<string, boolean>, wanted: ToolControlLinkInput[]): LinkPlan {
  const want = new Map(wanted.map((c) => [c.controlId, c.evidenceSource] as const));
  return {
    added: wanted.filter((c) => !current.has(c.controlId)),
    removed: lowerSort([...current.keys()].filter((id) => !want.has(id))),
    flipped: wanted.filter((c) => current.has(c.controlId) && current.get(c.controlId) !== c.evidenceSource),
  };
}

const sortedControls = (controls: ToolControlLinkInput[]): ToolControlLinkInput[] => [...controls].sort((a, b) => (a.controlId < b.controlId ? -1 : a.controlId > b.controlId ? 1 : 0)).map((c) => ({ controlId: c.controlId, evidenceSource: c.evidenceSource }));

/**
 * Replaces the set of controls a tool is linked to in this program. `catalogIds` is the program's own control catalog: a control outside it is refused
 * (control_not_in_program, with the control id: ids are not CUI). `expectedControlIds` is the set the client loaded (stale_write, with
 * `currentControlIds`, when it differs). Refused with tool_not_found, tool_not_in_boundary (only when the program declares a boundary) and limit.
 * A write that changes nothing writes no row and no event (changed false). One `controls_changed` event otherwise.
 */
export async function putToolControls(
  scope: ProgramScope,
  toolId: string,
  controls: ToolControlLinkInput[],
  expectedControlIds: string[],
  catalogIds: ReadonlySet<string>,
  who: InventoryActor
): Promise<{ toolId: string; controls: ToolControlLinkInput[]; changed: boolean }> {
  const outside = controls.find((c) => !catalogIds.has(c.controlId));
  if (outside) throw new InventoryError('control_not_in_program', 'A control is not part of this program\'s catalog', { controlId: outside.controlId });

  const eventDetail = (plan: LinkPlan): Record<string, unknown> => {
    const a = cap(lowerSort(plan.added.map((c) => c.controlId)));
    const r = cap(plan.removed);
    const f = cap(lowerSort(plan.flipped.map((c) => c.controlId)));
    return { toolId, added: a.ids, removed: r.ids, evidenceSourceChanged: f.ids, addedCount: plan.added.length, removedCount: plan.removed.length, evidenceSourceChangedCount: plan.flipped.length, truncated: a.truncated || r.truncated || f.truncated };
  };

  if (isMemory()) {
    if (!memoryToolIds(scope.tenantId).has(toolId)) throw toolMissing();
    const m = memoryOf(scope);
    const live = memoryToolIds(scope.tenantId);
    const members = [...m.members].filter((id) => live.has(id));
    if (members.length > 0 && !members.includes(toolId)) throw outsideBoundary();
    const current = new Map(m.links.get(toolId) ?? []);
    if (!sameSet([...current.keys()], expectedControlIds)) throw staleLinks(lowerSort(current.keys()));
    let others = 0;
    for (const [id, l] of m.links) if (id !== toolId && live.has(id)) others += l.size;
    if (others + controls.length > MAX_LINKS_PER_PROGRAM) throw linkLimit();
    const plan = planLinks(current, controls);
    if (plan.added.length + plan.removed.length + plan.flipped.length === 0) return { toolId, controls: sortedControls(controls), changed: false };
    m.links.set(toolId, new Map(controls.map((c) => [c.controlId, c.evidenceSource] as const)));
    if (controls.length === 0) m.links.delete(toolId);
    pushEvent(scope, 'controls_changed', toolId, who, eventDetail(plan));
    return { toolId, controls: sortedControls(controls), changed: true };
  }

  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    const tool = await q('SELECT 1 FROM inventory_tools WHERE tenant_id = $1 AND id = $2', [scope.tenantId, toolId]);
    if (!tool.rows[0]) throw toolMissing();
    const members = await membersTx(q, scope);
    if (members.length > 0 && !members.includes(toolId)) throw outsideBoundary();
    const res = await q('SELECT control_id, evidence_source FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id = $3', [scope.tenantId, scope.programId, toolId]);
    const current = new Map(res.rows.map((r) => [String(r.control_id), r.evidence_source === true] as const));
    if (!sameSet([...current.keys()], expectedControlIds)) throw staleLinks(lowerSort(current.keys()));
    const others = await q('SELECT COUNT(*)::int AS n FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id <> $3', [scope.tenantId, scope.programId, toolId]);
    if (Number(others.rows[0].n) + controls.length > MAX_LINKS_PER_PROGRAM) throw linkLimit();
    const plan = planLinks(current, controls);
    if (plan.added.length + plan.removed.length + plan.flipped.length === 0) return { toolId, controls: sortedControls(controls), changed: false };
    if (plan.removed.length > 0) await q('DELETE FROM program_tool_controls WHERE tenant_id = $1 AND program_id = $2 AND tool_id = $3 AND control_id = ANY($4::text[])', [scope.tenantId, scope.programId, toolId, plan.removed]);
    if (plan.added.length > 0) {
      await q(
        `INSERT INTO program_tool_controls (tenant_id, program_id, tool_id, control_id, evidence_source, linked_by)
         SELECT $1, $2, $3, u.c, u.e, $6 FROM unnest($4::text[], $5::boolean[]) AS u(c, e)`,
        [scope.tenantId, scope.programId, toolId, plan.added.map((c) => c.controlId), plan.added.map((c) => c.evidenceSource), who.actor.slice(0, 255)]
      );
    }
    if (plan.flipped.length > 0) {
      await q(
        `UPDATE program_tool_controls t SET evidence_source = u.e
         FROM unnest($4::text[], $5::boolean[]) AS u(c, e)
         WHERE t.tenant_id = $1 AND t.program_id = $2 AND t.tool_id = $3 AND t.control_id = u.c`,
        [scope.tenantId, scope.programId, toolId, plan.flipped.map((c) => c.controlId), plan.flipped.map((c) => c.evidenceSource)]
      );
    }
    await insertEventTx(q, scope, 'controls_changed', toolId, who, eventDetail(plan));
    return { toolId, controls: sortedControls(controls), changed: true };
  });
}

// ------------------------------------------------------------------------------------------------ data inventory

const EMPTY_RECORD = (): DataInventoryRecord => ({ handlesFci: null, categories: [], updatedAt: null, updatedBy: null });

/** Categories by id and tool rows by tool id, so two records with the same content compare equal. */
function normalizeCategories(categories: DataInventoryInput['categories']): DataInventoryInput['categories'] {
  return [...categories]
    .sort((a, b) => (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0))
    .map((c) => ({
      categoryId: c.categoryId,
      tools: [...c.tools].sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0)).map((t) => ({ toolId: t.toolId, stores: t.stores, processes: t.processes, transmits: t.transmits })),
    }));
}

const sameContent = (a: DataInventoryInput, b: DataInventoryInput): boolean => a.handlesFci === b.handlesFci && JSON.stringify(normalizeCategories(a.categories)) === JSON.stringify(normalizeCategories(b.categories));

function memoryRecord(scope: ProgramScope): DataInventoryRecord {
  const d = memoryPrograms.get(keyOf(scope))?.data;
  if (!d) return EMPTY_RECORD();
  const live = memoryToolIds(scope.tenantId);
  return {
    handlesFci: d.handlesFci,
    categories: normalizeCategories([...d.categories].map(([categoryId, rows]) => ({ categoryId, tools: [...rows.values()].filter((t) => live.has(t.toolId)) }))),
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
  };
}

async function recordTx(q: Q, scope: ProgramScope, forUpdate = false): Promise<DataInventoryRecord> {
  const row = await q(`SELECT handles_fci, updated_by, updated_at FROM program_data_inventory WHERE tenant_id = $1 AND program_id = $2${forUpdate ? ' FOR UPDATE' : ''}`, [scope.tenantId, scope.programId]);
  if (!row.rows[0]) return EMPTY_RECORD();
  const cats = await q('SELECT category_id FROM program_cui_categories WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  const tools = await q('SELECT category_id, tool_id, stores, processes, transmits FROM program_cui_category_tools WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]);
  const byCategory = new Map<string, CuiToolRole[]>(cats.rows.map((r) => [String(r.category_id), []] as const));
  for (const r of tools.rows) byCategory.get(String(r.category_id))?.push({ toolId: String(r.tool_id), stores: r.stores === true, processes: r.processes === true, transmits: r.transmits === true });
  return {
    handlesFci: row.rows[0].handles_fci ?? null,
    categories: normalizeCategories([...byCategory].map(([categoryId, rows]) => ({ categoryId, tools: rows }))),
    updatedAt: iso(row.rows[0].updated_at),
    updatedBy: row.rows[0].updated_by ?? null,
  };
}

/** The program's data inventory (handlesFci null, no categories and updatedAt null before the first save). */
export async function readDataInventory(scope: ProgramScope): Promise<DataInventoryRecord> {
  if (!hasScope(scope)) return EMPTY_RECORD();
  if (isMemory()) return memoryRecord(scope);
  return inProgramTx(scope, (q) => recordTx(q, scope));
}

function dataEventDetail(before: DataInventoryRecord, after: DataInventoryInput): Record<string, unknown> {
  const beforeIds = before.categories.map((c) => c.categoryId);
  const afterIds = after.categories.map((c) => c.categoryId);
  const a = cap(lowerSort(afterIds.filter((id) => !beforeIds.includes(id))));
  const r = cap(lowerSort(beforeIds.filter((id) => !afterIds.includes(id))));
  const rows = (cs: DataInventoryInput['categories']): string => JSON.stringify(normalizeCategories(cs).map((c) => [c.categoryId, c.tools]));
  return {
    handlesFci: after.handlesFci,
    handlesFciChanged: before.handlesFci !== after.handlesFci,
    categoriesAdded: a.ids,
    categoriesRemoved: r.ids,
    categoryCount: after.categories.length,
    toolRowCount: after.categories.reduce((n, c) => n + c.tools.length, 0),
    toolRowsChanged: rows(before.categories) !== rows(after.categories),
    truncated: a.truncated || r.truncated,
  };
}

/**
 * Replaces the program's data inventory as a whole. `expectedUpdatedAt` is the stamp the client loaded (null = nothing saved yet): another stamp is a
 * StaleWriteError, checked first. Every tool named must be a tool of the tenant (tool_not_found) and, when the program declares a boundary, be in it
 * (tool_not_in_boundary). A write that changes nothing writes no row and no event (changed false). One `data_inventory_changed` event otherwise.
 */
export async function writeDataInventory(scope: ProgramScope, input: DataInventoryInput, expectedUpdatedAt: string | null, who: InventoryActor): Promise<{ record: DataInventoryRecord; changed: boolean }> {
  const toolIds = [...new Set(input.categories.flatMap((c) => c.tools.map((t) => t.toolId)))];
  const staleOf = (r: DataInventoryRecord): StaleWriteError => new StaleWriteError({ updatedAt: r.updatedAt, updatedBy: r.updatedBy });

  if (isMemory()) {
    const before = memoryRecord(scope);
    if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw staleOf(before);
    const live = memoryToolIds(scope.tenantId);
    if (toolIds.some((id) => !live.has(id))) throw toolMissing();
    const members = liveMembers(scope);
    if (members.length > 0 && toolIds.some((id) => !members.includes(id))) throw outsideBoundary();
    if (sameContent(before, input)) return { record: before, changed: false };
    const m = memoryOf(scope);
    m.data = {
      handlesFci: input.handlesFci,
      updatedAt: nextStamp(m.data?.updatedAt),
      updatedBy: who.actor.slice(0, 255),
      categories: new Map(input.categories.map((c) => [c.categoryId, new Map(c.tools.map((t) => [t.toolId, { ...t }] as const))] as const)),
    };
    pushEvent(scope, 'data_inventory_changed', null, who, dataEventDetail(before, input));
    return { record: memoryRecord(scope), changed: true };
  }

  return inProgramTx(scope, async (q) => {
    await lockProgram(q, scope);
    const before = await recordTx(q, scope, true);
    if (!matchesExpected(before.updatedAt, expectedUpdatedAt)) throw staleOf(before);
    if (toolIds.length > 0) {
      const found = await q('SELECT id FROM inventory_tools WHERE tenant_id = $1 AND id = ANY($2::text[])', [scope.tenantId, toolIds]);
      if (found.rows.length < toolIds.length) throw toolMissing();
      const members = await membersTx(q, scope);
      if (members.length > 0 && toolIds.some((id) => !members.includes(id))) throw outsideBoundary();
    }
    if (sameContent(before, input)) return { record: before, changed: false };
    const actor = who.actor.slice(0, 255);
    const userId = who.userId ? who.userId.slice(0, 128) : null;
    if (before.updatedAt === null) {
      await q('INSERT INTO program_data_inventory (tenant_id, program_id, handles_fci, updated_by, updated_by_user_id) VALUES ($1, $2, $3, $4, $5)', [scope.tenantId, scope.programId, input.handlesFci, actor, userId]);
    } else {
      await q(
        `UPDATE program_data_inventory SET handles_fci = $3, updated_by = $4, updated_by_user_id = $5, updated_at = GREATEST(NOW(), updated_at + interval '1 millisecond')
         WHERE tenant_id = $1 AND program_id = $2`,
        [scope.tenantId, scope.programId, input.handlesFci, actor, userId]
      );
      await q('DELETE FROM program_cui_categories WHERE tenant_id = $1 AND program_id = $2', [scope.tenantId, scope.programId]); // the tool rows cascade
    }
    if (input.categories.length > 0) {
      await q(
        'INSERT INTO program_cui_categories (tenant_id, program_id, category_id) SELECT $1, $2, x FROM unnest($3::text[]) AS x',
        [scope.tenantId, scope.programId, input.categories.map((c) => c.categoryId)]
      );
      const rows = input.categories.flatMap((c) => c.tools.map((t) => ({ categoryId: c.categoryId, ...t })));
      if (rows.length > 0) {
        await q(
          `INSERT INTO program_cui_category_tools (tenant_id, program_id, category_id, tool_id, stores, processes, transmits)
           SELECT $1, $2, u.c, u.t, u.s, u.p, u.x FROM unnest($3::text[], $4::text[], $5::boolean[], $6::boolean[], $7::boolean[]) AS u(c, t, s, p, x)`,
          [scope.tenantId, scope.programId, rows.map((r) => r.categoryId), rows.map((r) => r.toolId), rows.map((r) => r.stores), rows.map((r) => r.processes), rows.map((r) => r.transmits)]
        );
      }
    }
    await insertEventTx(q, scope, 'data_inventory_changed', null, who, dataEventDetail(before, input));
    return { record: await recordTx(q, scope), changed: true };
  });
}

// ------------------------------------------------------------------------------------------------ vendor documents

/** The same statement the evidence routes use: a record of this program (or a legacy one that has no program yet). */
const EVIDENCE_LOOKUP = 'SELECT * FROM evidence_metadata WHERE id = $1 AND tenant_id = $2 AND (program_id = $3 OR program_id IS NULL)';

const vendorMissing = (): InventoryError => new InventoryError('vendor_not_found', 'The vendor was not found in this organization');

/**
 * Links an evidence record of this program to a vendor as a CRM, SRM, contract, FedRAMP package, attestation or other document. The evidence id is
 * checked against the program (evidence_not_found), the vendor against the tenant (vendor_not_found). Linking the same pair again is not a change; with
 * another docKind it changes the kind (created false, changed true). At most 50 documents per vendor and program (limit).
 */
export async function linkVendorDocument(
  scope: ProgramScope,
  input: { vendorId: string; evidenceId: string; docKind: VendorDocumentKind },
  who: InventoryActor
): Promise<{ document: VendorDocumentLink; created: boolean; changed: boolean }> {
  const found = await queryWithProgram(scope, EVIDENCE_LOOKUP, [input.evidenceId, scope.tenantId, scope.programId]);
  if (!found.rows.some((r) => r.tenant_id === scope.tenantId)) throw new InventoryError('evidence_not_found', 'The evidence record was not found in this program');
  const tooMany = (): InventoryError => new InventoryError('limit', 'This vendor already has the maximum number of documents in this program');
  const detail = (): Record<string, unknown> => ({ evidenceId: input.evidenceId, docKind: input.docKind });

  if (isMemory()) {
    if (!memoryVendorIds(scope.tenantId).has(input.vendorId)) throw vendorMissing();
    const m = memoryOf(scope);
    const existing = m.docs.find((d) => d.vendorId === input.vendorId && d.evidenceId === input.evidenceId);
    if (existing) {
      if (existing.docKind === input.docKind) return { document: { ...existing }, created: false, changed: false };
      existing.docKind = input.docKind;
      pushEvent(scope, 'vendor_document_linked', input.vendorId, who, detail());
      return { document: { ...existing }, created: false, changed: true };
    }
    if (m.docs.filter((d) => d.vendorId === input.vendorId).length >= MAX_DOCS_PER_VENDOR_PER_PROGRAM) throw tooMany();
    const document: VendorDocumentLink = { vendorId: input.vendorId, evidenceId: input.evidenceId, docKind: input.docKind, linkedAt: new Date().toISOString(), linkedBy: who.actor.slice(0, 255) };
    m.docs.push(document);
    pushEvent(scope, 'vendor_document_linked', input.vendorId, who, detail());
    return { document: { ...document }, created: true, changed: true };
  }

  try {
    return await inProgramTx(scope, async (q) => {
      await lockProgram(q, scope);
      const vendor = await q('SELECT 1 FROM inventory_vendors WHERE tenant_id = $1 AND id = $2', [scope.tenantId, input.vendorId]);
      if (!vendor.rows[0]) throw vendorMissing();
      const existing = await q(
        'SELECT vendor_id, evidence_id, doc_kind, linked_by, linked_at FROM program_vendor_documents WHERE tenant_id = $1 AND program_id = $2 AND vendor_id = $3 AND evidence_id = $4 FOR UPDATE',
        [scope.tenantId, scope.programId, input.vendorId, input.evidenceId]
      );
      if (existing.rows[0]) {
        const document = docFromRow(existing.rows[0]);
        if (document.docKind === input.docKind) return { document, created: false, changed: false };
        await q('UPDATE program_vendor_documents SET doc_kind = $5 WHERE tenant_id = $1 AND program_id = $2 AND vendor_id = $3 AND evidence_id = $4', [scope.tenantId, scope.programId, input.vendorId, input.evidenceId, input.docKind]);
        await insertEventTx(q, scope, 'vendor_document_linked', input.vendorId, who, detail());
        return { document: { ...document, docKind: input.docKind }, created: false, changed: true };
      }
      const count = await q('SELECT COUNT(*)::int AS n FROM program_vendor_documents WHERE tenant_id = $1 AND program_id = $2 AND vendor_id = $3', [scope.tenantId, scope.programId, input.vendorId]);
      if (Number(count.rows[0].n) >= MAX_DOCS_PER_VENDOR_PER_PROGRAM) throw tooMany();
      const res = await q(
        `INSERT INTO program_vendor_documents (tenant_id, program_id, vendor_id, evidence_id, doc_kind, linked_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING vendor_id, evidence_id, doc_kind, linked_by, linked_at`,
        [scope.tenantId, scope.programId, input.vendorId, input.evidenceId, input.docKind, who.actor.slice(0, 255)]
      );
      await insertEventTx(q, scope, 'vendor_document_linked', input.vendorId, who, detail());
      return { document: docFromRow(res.rows[0]), created: true, changed: true };
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23503') throw vendorMissing();
    throw err;
  }
}

/** Removes a vendor document link (the evidence record itself stays). False when there is no such link. */
export async function unlinkVendorDocument(scope: ProgramScope, vendorId: string, evidenceId: string, who: InventoryActor): Promise<boolean> {
  if (isMemory()) {
    const m = memoryPrograms.get(keyOf(scope));
    const at = m ? m.docs.findIndex((d) => d.vendorId === vendorId && d.evidenceId === evidenceId) : -1;
    if (!m || at < 0) return false;
    m.docs.splice(at, 1);
    pushEvent(scope, 'vendor_document_unlinked', vendorId, who, { evidenceId });
    return true;
  }
  return inProgramTx(scope, async (q) => {
    const res = await q('DELETE FROM program_vendor_documents WHERE tenant_id = $1 AND program_id = $2 AND vendor_id = $3 AND evidence_id = $4 RETURNING evidence_id', [scope.tenantId, scope.programId, vendorId, evidenceId]);
    if (!res.rows[0]) return false;
    await insertEventTx(q, scope, 'vendor_document_unlinked', vendorId, who, { evidenceId });
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ history

/** The program's inventory history, newest first (at most `limit`, 1 to 200, 100 by default). */
export async function listProgramInventoryEvents(scope: ProgramScope, limit?: number): Promise<ProgramInventoryEvent[]> {
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? (limit as number) : 100)));
  if (!hasScope(scope)) return [];
  if (isMemory()) {
    return memoryEvents
      .filter((e) => e.tenantId === scope.tenantId && e.programId === scope.programId)
      .reverse()
      .slice(0, n)
      .map(({ tenantId: _t, programId: _p, ...e }) => ({ ...e, detail: { ...e.detail } }));
  }
  return inProgramTx(scope, async (q) => {
    const res = await q('SELECT * FROM program_inventory_events WHERE tenant_id = $1 AND program_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [scope.tenantId, scope.programId, n]);
    return res.rows.map((r) => ({ id: String(r.id), action: String(r.action), entityId: r.entity_id ?? null, actor: String(r.actor), createdAt: iso(r.created_at), detail: (r.detail ?? {}) as Record<string, unknown> }));
  });
}
