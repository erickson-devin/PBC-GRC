// What the Tools and Services register shows (#239): the filters, the order, the rows that still lack user counts, the program boundary and the
// evidence status of each tool-to-control link. Pure: types only; nothing here touches storage, the network or the console (names may be CUI).

import type { InventoryTool, ProgramInventory, ToolControlLink } from '../../types/inventory';

export type ToolFilter = 'ALL' | 'ON_PREM' | 'CLOUD' | 'ESP';

const lower = (s: string): string => s.toLowerCase();

/** The register filtered by where the tool runs (All keeps every tool, including those with no deployment recorded) and by a case-insensitive search of name, vendor and mission. */
export function filterTools(tools: InventoryTool[], filter: ToolFilter, query?: string): InventoryTool[] {
  const q = lower((query ?? '').trim());
  return tools.filter((t) => {
    if (filter !== 'ALL' && t.deployment !== filter) return false;
    if (q === '') return true;
    return lower(t.name).includes(q) || lower(t.vendorName).includes(q) || lower(t.mission).includes(q);
  });
}

/** Recovery order first (rank ascending), then the unranked tools by name. A new array: the input is not changed. */
export function sortForRegister(tools: InventoryTool[]): InventoryTool[] {
  return tools.slice().sort((a, b) => {
    const ra = a.recoveryRank;
    const rb = b.recoveryRank;
    if (ra !== null && rb !== null) return ra - rb || lower(a.name).localeCompare(lower(b.name));
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return lower(a.name).localeCompare(lower(b.name)) || a.id.localeCompare(b.id);
  });
}

/** The order after moving one id a place up or down: a new array with the same ids; unchanged at either end or for an id that is not in it. */
export function moveInOrder(order: string[], id: string, dir: 'up' | 'down'): string[] {
  const from = order.indexOf(id);
  if (from === -1) return order.slice();
  const to = dir === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return order.slice();
  const next = order.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The tools a program's boundary holds: the declared ones, or the whole register while the program declares none. */
export function boundaryTools(tools: InventoryTool[], inv: Pick<ProgramInventory, 'declared' | 'toolIds'>): InventoryTool[] {
  if (!inv.declared) return tools;
  const ids = new Set(inv.toolIds);
  return tools.filter((t) => ids.has(t.id));
}

/** How many controls each tool is linked to in a program. */
export function controlCountsByTool(links: ToolControlLink[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of links) counts[l.toolId] = (counts[l.toolId] ?? 0) + 1;
  return counts;
}

/** A tool with no user counts yet (SSP 1.3.1 prints "Not recorded"): either count is missing. A tool that is out of scope is not printed there, so it is never flagged. */
export function hasMissingUserCounts(t: Pick<InventoryTool, 'assetCategory' | 'endUsers' | 'privilegedUsers'>): boolean {
  return t.assetCategory !== 'OUT_OF_SCOPE' && (t.endUsers === null || t.privilegedUsers === null);
}

/** The tools that still lack user counts. */
export function toolsMissingUserCounts<T extends Pick<InventoryTool, 'assetCategory' | 'endUsers' | 'privilegedUsers'>>(tools: T[]): T[] {
  return tools.filter(hasMissingUserCounts);
}

export interface EvidenceStatusRow {
  toolId: string;
  controlId: string;
  controlTitle: string;
  /** The control's status as the program holds it ('UNKNOWN' for a control that is not in the list given). */
  status: string;
  /** How many evidence files the control has in this program. */
  evidenceCount: number;
  /** The link says the tool is where evidence for the control comes from. */
  evidenceSource: boolean;
}

/**
 * For each control a tool is linked to in the program: the control's status and how many evidence files it has. By default only the links marked
 * "evidence comes from this tool"; `includeNonSource` adds the others; `toolId` limits it to one tool. Rows keep the order of `links`.
 */
export function toolEvidenceStatus(
  links: ToolControlLink[],
  controls: { id: string; title: string; status: string }[],
  evidence: { controlId: string }[],
  opts: { toolId?: string; includeNonSource?: boolean } = {}
): EvidenceStatusRow[] {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const e of evidence) counts.set(e.controlId, (counts.get(e.controlId) ?? 0) + 1);
  return links
    .filter((l) => (opts.toolId === undefined || l.toolId === opts.toolId) && (opts.includeNonSource === true || l.evidenceSource))
    .map((l) => {
      const c = byId.get(l.controlId);
      return {
        toolId: l.toolId,
        controlId: l.controlId,
        controlTitle: c?.title ?? l.controlId,
        status: c?.status ?? 'UNKNOWN',
        evidenceCount: counts.get(l.controlId) ?? 0,
        evidenceSource: l.evidenceSource,
      };
    });
}
