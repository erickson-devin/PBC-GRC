/** The per-asset fleet record of browser-only tenants (legacy) and its storage helpers. Server-backed tenants keep it in memory only. Scanning, the boundary rollup, the status write and push remediation were retired in #103: configuration results now reach the server through the exporter. */

import { AssetTelemetryRecord } from '../../types/telemetry';
import { FLEET_KEY_PREFIX } from '../../services/browserStorageScrub';

// ---------------------------------------------------------------------------
// 2. Storage Persistence Helpers
// ---------------------------------------------------------------------------

/**
 * Where a tenant's fleet scan data lives. Host names, IPs and scan output are never kept in browser storage for a
 * server-backed tenant: the fleet stays in memory for the session. Browser-only tenants have no other home for it.
 */
export type FleetStorageMode = 'browser' | 'memory';

export function fleetStorageMode(t: { serverBacked?: boolean }): FleetStorageMode {
  return t.serverBacked ? 'memory' : 'browser';
}

// Session-only fleets of server-backed tenants (fail-safe default of every function below)
const memoryFleets = new Map<string, AssetTelemetryRecord[]>();

export function getEnclaveFleet(tenantId: string, mode: FleetStorageMode = 'memory'): AssetTelemetryRecord[] {
  if (mode === 'memory') return memoryFleets.get(tenantId) ?? [];
  try {
    const raw = localStorage.getItem(`${FLEET_KEY_PREFIX}${tenantId}`);
    if (raw) {
      const parsed: AssetTelemetryRecord[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    console.warn('[AssetTelemetry] Could not read the fleet cache');
  }

  // A fleet only ever contains hosts that were actually scanned
  return [];
}

export function saveEnclaveFleet(fleet: AssetTelemetryRecord[], tenantId: string, mode: FleetStorageMode = 'memory'): void {
  if (mode === 'memory') {
    memoryFleets.set(tenantId, fleet);
    // Remove any leftover browser copy
    try {
      localStorage.removeItem(`${FLEET_KEY_PREFIX}${tenantId}`);
    } catch {
      // storage unavailable: nothing to remove
    }
    return;
  }
  try {
    localStorage.setItem(`${FLEET_KEY_PREFIX}${tenantId}`, JSON.stringify(fleet));
  } catch {
    console.error('[AssetTelemetry] Could not save the fleet cache');
  }
}

/** Forgets a tenant's fleet everywhere: the session copy and the browser copy. */
export function clearEnclaveFleet(tenantId: string): void {
  memoryFleets.delete(tenantId);
  try {
    localStorage.removeItem(`${FLEET_KEY_PREFIX}${tenantId}`);
  } catch {
    // storage unavailable: nothing to remove
  }
}

export function saveAssetRecord(
  record: AssetTelemetryRecord,
  tenantId: string,
  mode: FleetStorageMode = 'memory'
): AssetTelemetryRecord[] {
  const fleet = getEnclaveFleet(tenantId, mode);
  const existingIdx = fleet.findIndex(a => a.assetId === record.assetId || a.ipAddress === record.ipAddress);
  
  let updatedFleet: AssetTelemetryRecord[];
  if (existingIdx >= 0) {
    updatedFleet = [...fleet];
    updatedFleet[existingIdx] = record;
  } else {
    updatedFleet = [...fleet, record];
  }

  saveEnclaveFleet(updatedFleet, tenantId, mode);
  return updatedFleet;
}
