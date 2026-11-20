import { MAX_PROGRAMS_PER_TENANT, listPrograms } from '../programs';
import { countToolUsage, getProgramToolIds } from './programInventoryStore';
import type { ToolMembership, ToolUsage } from '../../src/types/inventory';

/**
 * Cross-program views of the register: how a tool is used across the tenant's programs (archived ones included), and each program's declared boundary
 * (the cost roll-up per program needs it). Both read under each program's own context, as server/programAssets.ts does for assets. Ids and counts only.
 */

/** In how many programs the tool is in a declared boundary, linked to controls or named in a data inventory, and how many links that is. */
export async function toolUsage(tenantId: string, toolId: string): Promise<ToolUsage> {
  const programs = (await listPrograms(tenantId, { includeArchived: true })).slice(0, MAX_PROGRAMS_PER_TENANT);
  const usage: ToolUsage = { programs: 0, controlLinks: 0, cuiLinks: 0 };
  for (const p of programs) {
    const u = await countToolUsage({ tenantId, programId: p.id }, toolId);
    if (u.member || u.controlLinks > 0 || u.cuiLinks > 0) usage.programs++;
    usage.controlLinks += u.controlLinks;
    usage.cuiLinks += u.cuiLinks;
  }
  return usage;
}

/** The declared tools of every program of the tenant, archived ones included, in the order of listPrograms (the default first). */
export async function listToolMemberships(tenantId: string): Promise<ToolMembership[]> {
  const programs = (await listPrograms(tenantId, { includeArchived: true })).slice(0, MAX_PROGRAMS_PER_TENANT);
  const out: ToolMembership[] = [];
  for (const p of programs) {
    const toolIds = await getProgramToolIds({ tenantId, programId: p.id });
    out.push({ programId: p.id, archived: p.archivedAt !== null, declared: toolIds.length > 0, toolIds });
  }
  return out;
}
