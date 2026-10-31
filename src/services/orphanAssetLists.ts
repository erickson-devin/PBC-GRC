/**
 * Asset lists an earlier move left in this browser under a tenant id the registry no longer holds (#112).
 *
 * Nothing links such a list to a tenant, so the start-up scrub skips it. A Tenant Owner or MSP Admin may claim one (it
 * then follows the #92 retry path into the current tenant) or discard it. Ids and counts only: an asset's name, host or
 * address is never read into a result or handed to the ledger. Pure module: the storage and the ledger writer are
 * injected. Every function is defensive and never throws.
 */

import { ENCLAVE_ASSETS_KEY_PREFIX, registeredTenantIds, type ScrubStorage } from './browserStorageScrub';
import { readFailedMoves, recordFailedMove } from './failedMoves';
import { isDemoSeedAsset } from '../data/telemetry/assetRegistry';

export interface OrphanAssetList {
  tenantId: string;
  assetCount: number;
}

/** The slice of the ledger writer the claim and discard need; the hook binds the actor and the action type. */
export type OrphanLedgerRecorder = (entry: { targetEntity: string; newState: { assetCount: number } }) => Promise<unknown>;

/** Real (non-demo) assets with an id in one stored list; 0 when unreadable. */
function countRealAssets(storage: ScrubStorage, tenantId: string): number {
  try {
    const raw = storage.getItem(ENCLAVE_ASSETS_KEY_PREFIX + tenantId);
    if (!raw) return 0;
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const item of list) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && !isDemoSeedAsset(item as { id: string }, tenantId)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Asset lists with real assets under an id that is not the current tenant, not registered and not already linked by a failed-move record. */
export function findOrphanAssetLists(storage: ScrubStorage, currentTenantId: string): OrphanAssetList[] {
  try {
    const registered = registeredTenantIds(storage);
    if (!registered) return [];
    const linked = new Set(readFailedMoves(storage).map(r => r.fromTenantId));
    const out: OrphanAssetList[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(ENCLAVE_ASSETS_KEY_PREFIX)) continue;
      const tenantId = key.slice(ENCLAVE_ASSETS_KEY_PREFIX.length);
      if (!tenantId || tenantId === currentTenantId || registered.has(tenantId) || linked.has(tenantId)) continue;
      const assetCount = countRealAssets(storage, tenantId);
      if (assetCount > 0) out.push({ tenantId, assetCount });
    }
    return out.sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Writes the ledger entry, then links the list to the current tenant with the same record a failed move leaves, so the
 * existing retry moves it. The asset key itself is untouched. False when the list is not an orphan, the ledger write
 * fails, or the record did not stick.
 */
export async function claimOrphanAssetList(
  storage: ScrubStorage,
  oldId: string,
  currentTenantId: string,
  at: string,
  record: OrphanLedgerRecorder
): Promise<boolean> {
  try {
    const found = findOrphanAssetLists(storage, currentTenantId).find(o => o.tenantId === oldId);
    if (!found) return false;
    await record({ targetEntity: `LocalAssetList:${oldId}`, newState: { assetCount: found.assetCount } });
    recordFailedMove(storage, { fromTenantId: oldId, toTenantId: currentTenantId, at, assetsFailed: found.assetCount });
    return readFailedMoves(storage).some(r => r.fromTenantId === oldId && r.toTenantId === currentTenantId);
  } catch {
    return false;
  }
}

/** Writes the ledger entry, then removes the list from this browser. False (and the list kept) when it is not an orphan or the entry fails. */
export async function discardOrphanAssetList(
  storage: ScrubStorage,
  oldId: string,
  currentTenantId: string,
  record: OrphanLedgerRecorder
): Promise<boolean> {
  try {
    const found = findOrphanAssetLists(storage, currentTenantId).find(o => o.tenantId === oldId);
    if (!found) return false;
    await record({ targetEntity: `LocalAssetList:${oldId}`, newState: { assetCount: found.assetCount } });
    storage.removeItem(ENCLAVE_ASSETS_KEY_PREFIX + oldId);
    return true;
  } catch {
    return false;
  }
}
