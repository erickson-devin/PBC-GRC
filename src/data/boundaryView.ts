/**
 * Boundary membership in the asset inventory (issue #26): the filter, the change plan and its confirmation text, why the
 * toggle is unavailable, and the boundary line of the SSP export. Pure: counts, ids and the host names the table already
 * shows on screen; nothing is logged.
 */
import type { AssetScopeSummary } from './telemetry/assetScope';

export type BoundaryFilter = 'ALL' | 'IN' | 'NOT_IN';
export type BoundaryDirection = 'add' | 'remove';
/** As useProgramAssets reports it ('unsupported': a browser-only tenant, which has no programs). */
export type BoundaryStatus = 'unsupported' | 'loading' | 'ready' | 'error';
export type BoundaryBlock = 'unsupported' | 'viewer' | 'archived' | 'error' | 'loading';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function matchesBoundaryFilter(assetId: string, filter: BoundaryFilter, activeIds: ReadonlySet<string>): boolean {
  if (filter === 'ALL') return true;
  return activeIds.has(assetId) === (filter === 'IN');
}

export interface BoundaryChangePlan {
  direction: BoundaryDirection;
  /** Only the assets whose membership changes (members are skipped on add, non-members on remove). */
  ids: string[];
  /** Up to sampleLimit host names, for the confirmation (on screen only). */
  sampleNames: string[];
  moreCount: number;
  membersBefore: number;
  membersAfter: number;
  /** Registered assets: what an undeclared program's boundary states (D2). */
  inventoryTotal: number;
}

export function planBoundaryChange(
  shown: ReadonlyArray<{ id: string; hostName: string }>,
  activeIds: ReadonlySet<string>,
  direction: BoundaryDirection,
  inventoryTotal: number,
  sampleLimit = 5
): BoundaryChangePlan {
  const seen = new Set<string>();
  const targets = shown.filter((a) => {
    if (seen.has(a.id) || activeIds.has(a.id) === (direction === 'add')) return false;
    seen.add(a.id);
    return true;
  });
  const ids = targets.map((a) => a.id);
  const membersBefore = activeIds.size;
  return {
    direction,
    ids,
    sampleNames: targets.slice(0, sampleLimit).map((a) => a.hostName),
    moreCount: Math.max(0, targets.length - sampleLimit),
    membersBefore,
    membersAfter: direction === 'add' ? membersBefore + ids.length : Math.max(0, membersBefore - ids.length),
    inventoryTotal,
  };
}

/** A single-row change asks first only when it switches the program between "declared" and "whole inventory" (D2). */
export function rowChangeNeedsConfirm(direction: BoundaryDirection, membersBefore: number): boolean {
  return direction === 'add' ? membersBefore === 0 : membersBefore === 1;
}

export function describeBoundaryChange(plan: BoundaryChangePlan, programName: string): string {
  const whole = `the whole inventory (${count(plan.inventoryTotal, 'registered asset', 'registered assets')})`;
  const before = count(plan.membersBefore, 'asset', 'assets');
  const after = count(plan.membersAfter, 'asset', 'assets');
  if (plan.direction === 'add' && plan.membersBefore === 0) {
    return `${programName} has not declared its assets, so its SSP boundary is currently ${whole}. After this change it declares ${after}, and its SSP export, FIPS module list and handover package state only those.`;
  }
  if (plan.direction === 'remove' && plan.membersAfter === 0) {
    return `This removes every declared asset. ${programName} then has no declared assets, so its SSP boundary falls back to ${whole}.`;
  }
  return `${programName} declares ${before}. After this change it declares ${after}, and its SSP export states those.`;
}

export function boundaryEditBlock(ctx: {
  supported: boolean; canEdit: boolean; hasActiveProgram: boolean; archived: boolean; status: BoundaryStatus;
}): BoundaryBlock | null {
  if (!ctx.supported || ctx.status === 'unsupported') return 'unsupported';
  if (!ctx.canEdit) return 'viewer';
  if (ctx.hasActiveProgram && ctx.archived) return 'archived';
  if (ctx.status === 'error') return 'error';
  if (!ctx.hasActiveProgram || ctx.status === 'loading') return 'loading';
  return null;
}

export function boundaryBlockMessage(block: BoundaryBlock, programName: string): string {
  switch (block) {
    case 'unsupported': return 'This organization is kept in this browser only: it has no programs, so its boundary is the whole inventory.';
    case 'viewer': return 'Read-only: only a Tenant Owner or MSP Admin can change which assets a program declares.';
    case 'archived': return `${programName} is archived, so its boundary is read-only.`;
    case 'error': return 'The program boundaries could not be loaded, so membership cannot be changed right now.';
    case 'loading': return 'Loading the program boundary…';
  }
}

/** Fixed copy only: never the server's text, never an asset name. */
export function boundaryErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { status?: unknown; reason?: unknown };
  const reason = typeof e.reason === 'string' ? e.reason : '';
  if (reason === 'program_archived' || e.status === 409) return 'This program was archived meanwhile, so its boundary can no longer be changed. Nothing was saved.';
  if (reason === 'program_not_found') return 'This program no longer exists. Nothing was saved.';
  if (reason === 'unknown_assets') return 'Some of these assets were removed from the inventory meanwhile. Nothing was saved; the list has been refreshed, so try again.';
  if (reason === 'invalid_asset_ids') return 'The server did not accept this change (too many or malformed asset ids). Nothing was saved.';
  if (e.status === 403) return 'Only a Tenant Owner or MSP Admin can change which assets a program declares. Nothing was saved.';
  return 'The boundary change could not be saved. Nothing was changed; try again.';
}

export function summaryCaption(input: { filter: BoundaryFilter; programName: string; declared: boolean; members: number; inventoryTotal: number }): string {
  if (input.filter === 'IN') {
    return input.declared
      ? `Summary: the SSP boundary of ${input.programName}, ${count(input.members, 'declared asset', 'declared assets')}.`
      : `Summary: the SSP boundary of ${input.programName}, which is the whole inventory (no assets declared).`;
  }
  return `Summary: the whole inventory, ${count(input.inventoryTotal, 'registered asset', 'registered assets')}.`;
}

export function emptyTableMessage(input: { assetCount: number; filter: BoundaryFilter; programName: string; declared: boolean }): string {
  if (input.assetCount === 0) return 'No assets registered yet. Add the systems that make up your CMMC assessment boundary and give each its category.';
  if (input.filter === 'IN' && !input.declared) return `${input.programName} has not declared any assets yet, so its SSP boundary uses the whole inventory.`;
  if (input.filter === 'IN') return `No assets in ${input.programName} match your other filters.`;
  if (input.filter === 'NOT_IN') return `No asset outside ${input.programName} matches your filters.`;
  return 'No enclave assets match your active filters.';
}

export function exportBoundaryLine(input: {
  assetsLoading: boolean; assetsError: boolean; status: BoundaryStatus; programName: string | null; declared: boolean;
  boundary: AssetScopeSummary; inventory: AssetScopeSummary;
}): string {
  if (input.assetsError || input.status === 'error') return 'Asset boundary: the asset inventory or the program boundary could not be loaded, so this document states no asset counts.';
  if (input.assetsLoading || input.status === 'loading') return 'Asset boundary: loading the asset inventory and the program boundary…';
  const scope = `${count(input.boundary.inScope, 'asset', 'assets')} in CMMC scope`;
  const whole = count(input.inventory.total, 'asset', 'assets');
  if (input.status === 'unsupported') return `Asset boundary: the whole asset inventory, ${whole} (${scope}).`;
  const name = input.programName ?? 'This program';
  return input.declared
    ? `Asset boundary: ${name} declares ${input.boundary.total} of ${whole} (${scope}). This document states only those.`
    : `Asset boundary: ${name} has not declared its assets, so this document states the whole inventory, ${whole} (${scope}).`;
}
