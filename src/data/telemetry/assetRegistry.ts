/**
 * Event Horizon: Singularity — Enclave Asset & Hardware Inventory Registry
 *
 * Provides persistent CRUD management for enclave hardware assets, CMMC 2.0 scoping
 * categories, DISA STIG scan history, bulk CSV onboarding, and real-time network discovery
 * ingestion from Elijah's Event Horizon: Accretion tool.
 */

import {
  EnclaveAsset,
  CmmcAssetCategory,
  EnclaveAssetStatus,
  AccretionDiscoveryItem,
  AccretionIngestResult,
} from '../../types/telemetry';
import { parseAssetsCsv } from './assetScope';
import { computeSha256 } from '../audit/cryptoUtils';
import { recordAuditEvent } from '../audit/auditLogger';

const ASSET_REGISTRY_STORAGE_KEY_PREFIX = 'pbc_enclave_assets_v1_';
const ACCRETION_CONFIG_KEY_PREFIX = 'pbc_accretion_cfg_v1_';

// ---------------------------------------------------------------------------
// 1. UUID Generator Helper
// ---------------------------------------------------------------------------

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'asset-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// 2. Storage Persistence
// ---------------------------------------------------------------------------

function getStorageKey(tenantId: string): string {
  return `${ASSET_REGISTRY_STORAGE_KEY_PREFIX}${tenantId}`;
}

/**
 * Browser-local inventory of a tenant that has not been moved to the server yet. It starts empty: assets come from the
 * user, a CSV import or a discovery ingest, never from a built-in sample fleet.
 */
export function getEnclaveAssets(tenantId: string): EnclaveAsset[] {
  try {
    const raw = localStorage.getItem(getStorageKey(tenantId));
    if (raw) {
      const parsed: EnclaveAsset[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item, idx) => ({
          ...item,
          macAddress: item.macAddress || `52:54:00:12:${((idx + 1) * 7).toString(16).padStart(2, '0')}:9A`.toUpperCase(),
          sourceOrigin: item.sourceOrigin || (item.isManuallyAdded ? 'MANUAL_ENTRY' : 'PHOTON_AGENT'),
          discoveryStatus: item.discoveryStatus || 'ACTIVE',
        }));
      }
    }
  } catch (err) {
    console.warn('[AssetRegistry] Failed to parse local asset storage:', err);
  }

  return [];
}

export function saveEnclaveAssets(assets: EnclaveAsset[], tenantId: string): void {
  try {
    localStorage.setItem(getStorageKey(tenantId), JSON.stringify(assets));
  } catch (err) {
    console.error('[AssetRegistry] Failed to save asset storage:', err);
  }
}

// ---------------------------------------------------------------------------
// 3. CRUD Operations
// ---------------------------------------------------------------------------

export function addEnclaveAsset(
  tenantId: string,
  assetInput: Omit<EnclaveAsset, 'id'>
): EnclaveAsset {
  const currentAssets = getEnclaveAssets(tenantId);
  const newAsset: EnclaveAsset = {
    ...assetInput,
    id: generateUuid(),
    tenantId,
    macAddress: assetInput.macAddress || `52:54:00:${Math.random().toString(16).slice(2, 6).toUpperCase()}:${Math.random().toString(16).slice(2, 4).toUpperCase()}`,
    sourceOrigin: assetInput.sourceOrigin || 'MANUAL_ENTRY',
    discoveryStatus: assetInput.discoveryStatus || 'ACTIVE',
    isManuallyAdded: assetInput.isManuallyAdded !== undefined ? assetInput.isManuallyAdded : true,
    status: assetInput.status || 'NEVER_SCANNED',
    complianceScore: assetInput.complianceScore !== undefined ? assetInput.complianceScore : null,
    lastScannedAt: assetInput.lastScannedAt || null,
  };

  const updated = [newAsset, ...currentAssets];
  saveEnclaveAssets(updated, tenantId);
  return newAsset;
}

export function updateEnclaveAsset(
  assetId: string,
  updates: Partial<EnclaveAsset>,
  tenantId: string
): EnclaveAsset {
  const currentAssets = getEnclaveAssets(tenantId);
  const targetIdx = currentAssets.findIndex(a => a.id === assetId);

  if (targetIdx === -1) {
    throw new Error(`Enclave asset with ID ${assetId} not found in tenant ${tenantId}`);
  }

  const updatedAsset: EnclaveAsset = {
    ...currentAssets[targetIdx],
    ...updates,
    id: assetId, // Prevent ID override
    tenantId,
  };

  currentAssets[targetIdx] = updatedAsset;
  saveEnclaveAssets(currentAssets, tenantId);
  return updatedAsset;
}

export function deleteEnclaveAsset(assetId: string, tenantId: string): void {
  const currentAssets = getEnclaveAssets(tenantId);
  const filtered = currentAssets.filter(a => a.id !== assetId);
  saveEnclaveAssets(filtered, tenantId);
}

// ---------------------------------------------------------------------------
// 4. Bulk CSV Importer
// ---------------------------------------------------------------------------

/** Local-store CSV import. Rows with an unrecognised category are skipped and reported (see parseAssetsCsv). */
export function importAssetsFromCsv(tenantId: string, csvContent: string): { imported: EnclaveAsset[]; errors: string[] } {
  const parsed = parseAssetsCsv(csvContent);
  const existing = getEnclaveAssets(tenantId);
  const names = new Set(existing.map(a => a.hostName.toLowerCase()));
  const errors = [...parsed.errors];
  const imported: EnclaveAsset[] = [];
  for (const input of parsed.assets) {
    const name = (input.hostName ?? '').toLowerCase();
    if (names.has(name)) {
      errors.push(`${input.hostName}: an asset with that name already exists.`);
      continue;
    }
    names.add(name);
    imported.push({
      id: generateUuid(),
      tenantId,
      hostName: input.hostName as string,
      ipAddress: input.ipAddress ?? '',
      macAddress: input.macAddress || `52:54:00:${Math.random().toString(16).slice(2, 6).toUpperCase()}:${Math.random().toString(16).slice(2, 4).toUpperCase()}`,
      osProfile: input.osProfile ?? 'custom',
      cmmcAssetCategory: input.cmmcAssetCategory as CmmcAssetCategory,
      status: 'NEVER_SCANNED',
      sourceOrigin: 'CSV_IMPORT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: null,
      complianceScore: null,
      notes: input.notes ?? '',
      owner: input.owner ?? '',
      isManuallyAdded: true,
    });
  }
  if (imported.length > 0) saveEnclaveAssets([...imported, ...existing], tenantId);
  return { imported, errors };
}

// ---------------------------------------------------------------------------
// 5. Real-Time Scan Synchronization
// ---------------------------------------------------------------------------

export function syncAssetScanResult(
  tenantId: string,
  hostName: string,
  ipAddress: string,
  score: number,
  forcedStatus?: EnclaveAssetStatus
): void {
  const currentAssets = getEnclaveAssets(tenantId);
  const matchIdx = currentAssets.findIndex(
    a => a.hostName.toLowerCase() === hostName.toLowerCase() || a.ipAddress === ipAddress
  );

  if (matchIdx >= 0) {
    const computedStatus: EnclaveAssetStatus = forcedStatus || (score === 100 ? 'ACTIVE' : 'NON_COMPLIANT');
    currentAssets[matchIdx] = {
      ...currentAssets[matchIdx],
      lastScannedAt: new Date().toISOString(),
      complianceScore: score,
      status: computedStatus,
    };
    saveEnclaveAssets(currentAssets, tenantId);
  }
}

// ---------------------------------------------------------------------------
// 6. Accretion Discovery Ingestion & Deduplication Pipeline
// ---------------------------------------------------------------------------

/**
 * Ingests network discovery data from Elijah's Event Horizon: Accretion sensor/agent.
 * Deduplicates against existing enclave assets using MAC address or IP address:
 * - Match found: Updates lastSeenAt, accretionMetadata, and sets discoveryStatus = 'ACTIVE'.
 * - New asset: Creates new asset record with sourceOrigin = 'ACCRETION_DISCOVERY',
 *   discoveryStatus = 'UNCONFIRMED_DISCOVERY', and default CMMC Category 'CONTRACTOR_RISK'
 *   awaiting admin review.
 * - Logs an immutable audit event for every newly discovered endpoint.
 */
export async function ingestAccretionDiscoveryPayload(
  tenantId: string,
  discoveredAssets: AccretionDiscoveryItem[]
): Promise<AccretionIngestResult> {
  const currentAssets = getEnclaveAssets(tenantId);
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;

  for (const item of discoveredAssets) {
    const cleanMac = item.macAddress.trim().toLowerCase();
    const cleanIp = item.ipAddress.trim();

    // Match by MAC address (primary network L2 identifier) or IP address (L3)
    const matchIdx = currentAssets.findIndex(
      a => (a.macAddress && a.macAddress.trim().toLowerCase() === cleanMac) || (a.ipAddress && a.ipAddress.trim() === cleanIp)
    );

    if (matchIdx >= 0) {
      // Deduplicated match: update telemetry metadata & mark active (preserve UNCONFIRMED until admin reviews)
      const existing = currentAssets[matchIdx];
      currentAssets[matchIdx] = {
        ...existing,
        discoveryStatus: existing.discoveryStatus === 'UNCONFIRMED_DISCOVERY' ? 'UNCONFIRMED_DISCOVERY' : 'ACTIVE',
        accretionMetadata: {
          agentId: item.agentId,
          discoveredPorts: item.discoveredPorts,
          osFingerprint: item.osFingerprint,
          lastSeenAt: item.detectedAt || now,
          connectionType: item.connectionType,
        },
        notes: existing.notes || item.notes || `Discovered ports: [${item.discoveredPorts.join(', ')}] via Accretion`,
      };
      updatedCount++;
    } else {
      // New network node discovered
      const newAsset: EnclaveAsset = {
        id: generateUuid(),
        tenantId,
        hostName: item.hostName || `accretion-${item.macAddress.slice(-5).replace(':', '').toLowerCase()}`,
        ipAddress: item.ipAddress,
        macAddress: item.macAddress,
        osProfile: item.osProfile || 'custom',
        cmmcAssetCategory: 'CONTRACTOR_RISK', // Default scope awaiting admin categorization
        status: 'NEVER_SCANNED',
        sourceOrigin: 'ACCRETION_DISCOVERY',
        discoveryStatus: 'UNCONFIRMED_DISCOVERY',
        accretionMetadata: {
          agentId: item.agentId,
          discoveredPorts: item.discoveredPorts,
          osFingerprint: item.osFingerprint,
          lastSeenAt: item.detectedAt || now,
          connectionType: item.connectionType,
        },
        lastScannedAt: null,
        complianceScore: null,
        notes: item.notes || `Discovered via Accretion sensor ${item.agentId}. Ports: [${item.discoveredPorts.join(', ')}]`,
        isManuallyAdded: false,
      };

      currentAssets.unshift(newAsset);
      newCount++;

      // Asynchronously log audit event for newly discovered rogue / unmanaged endpoint
      recordAuditEvent({
        tenantId,
        actorId: `accretion_${item.agentId}`,
        actorEmail: `accretion-sensor@${item.agentId}.local`,
        actorRole: 'Network Discovery Sensor',
        actionType: 'TELEMETRY_INGESTED',
        targetEntity: `EnclaveAsset:${newAsset.id}`,
        newState: {
          hostName: newAsset.hostName,
          ipAddress: newAsset.ipAddress,
          macAddress: newAsset.macAddress,
          osFingerprint: item.osFingerprint,
          ports: item.discoveredPorts,
          discoveryStatus: 'UNCONFIRMED_DISCOVERY',
        },
        metadata: {
          sensor: 'Event Horizon: Accretion',
          agentId: item.agentId,
          connectionType: item.connectionType,
        },
      });
    }
  }

  saveEnclaveAssets(currentAssets, tenantId);

  // Compute immutable audit hash
  const digest = await computeSha256(JSON.stringify({
    tenantId,
    timestamp: now,
    processedCount: discoveredAssets.length,
    newCount,
    updatedCount,
  }));

  return {
    totalProcessed: discoveredAssets.length,
    newDiscoveredCount: newCount,
    updatedExistingCount: updatedCount,
    auditHash: digest,
    items: currentAssets,
  };
}

// ---------------------------------------------------------------------------
// 7. Accretion Simulation Generator (for evaluation & testing)
// ---------------------------------------------------------------------------

/** The sample sensor sweep used by the "simulate discovery" button (two unknown devices and one that already exists). */
export function buildSimulatedDiscoveryBatch(): AccretionDiscoveryItem[] {
  return [
    {
      agentId: 'accretion-sensor-vlan50',
      hostName: 'UNMANAGED-DEV-01',
      ipAddress: '10.0.50.155',
      macAddress: '00:1A:2B:3C:4D:5E',
      osFingerprint: 'Linux 5.15.0-88-generic (Ubuntu)',
      osProfile: 'ubuntu2204',
      discoveredPorts: [22, 8080, 5432],
      connectionType: 'WIRELESS',
      detectedAt: new Date().toISOString(),
      notes: 'Developer workstation active on wireless enclave bridge. Unverified SSH/PostgreSQL listener.',
    },
    {
      agentId: 'accretion-sensor-vlan50',
      hostName: 'HVAC-CONTROLLER-IOT',
      ipAddress: '10.0.50.210',
      macAddress: 'B8:27:EB:4F:99:A1',
      osFingerprint: 'Embedded Linux 4.19 / Modbus Gateway',
      osProfile: 'custom',
      discoveredPorts: [80, 443, 502],
      connectionType: 'ETHERNET',
      detectedAt: new Date().toISOString(),
      notes: 'Physical security/environmental controller device detected on enclave subnet.',
    },
    {
      agentId: 'accretion-sensor-vlan50',
      hostName: 'WS-SEC-04',
      ipAddress: '192.168.1.142',
      macAddress: '00:50:56:B3:4A:19', // Matches existing asset! (Deduplication test)
      osFingerprint: 'Ubuntu 22.04.3 LTS (GNU/Linux 5.15)',
      osProfile: 'ubuntu2204',
      discoveredPorts: [22, 443],
      connectionType: 'ETHERNET',
      detectedAt: new Date().toISOString(),
      notes: 'Known security workstation beaconing active heartbeat to Accretion sensor.',
    },
  ];
}

// ---------------------------------------------------------------------------
// 8. Confirm Discovered Asset Classification
// ---------------------------------------------------------------------------

export function confirmDiscoveredAsset(
  tenantId: string,
  assetId: string,
  confirmedCategory: CmmcAssetCategory
): EnclaveAsset {
  return updateEnclaveAsset(
    assetId,
    {
      cmmcAssetCategory: confirmedCategory,
      discoveryStatus: 'ACTIVE',
    },
    tenantId
  );
}

// ---------------------------------------------------------------------------
// 9. Accretion Webhook & API Secret Key Configuration
// ---------------------------------------------------------------------------

export function getAccretionApiConfig(tenantId: string): { webhookUrl: string; secretKey: string } {
  const key = `${ACCRETION_CONFIG_KEY_PREFIX}${tenantId}`;
  let secret = '';
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.secretKey) {
        secret = parsed.secretKey;
      }
    }
  } catch (err) {
    console.warn('[AssetRegistry] Failed to read Accretion API config:', err);
  }

  if (!secret) {
    secret = `acc_live_sk_${Math.random().toString(36).substring(2, 12)}_${Date.now().toString(36)}`;
    try {
      localStorage.setItem(key, JSON.stringify({ secretKey: secret }));
    } catch {
      // Storage fallback
    }
  }

  return {
    webhookUrl: `https://grc.pitchblackcyber.com/api/v1/tenants/${tenantId}/assets/discovery`,
    secretKey: secret,
  };
}

export function rotateAccretionSecretKey(tenantId: string): string {
  const key = `${ACCRETION_CONFIG_KEY_PREFIX}${tenantId}`;
  const newSecret = `acc_live_sk_${Math.random().toString(36).substring(2, 12)}_${Date.now().toString(36)}`;
  try {
    localStorage.setItem(key, JSON.stringify({ secretKey: newSecret }));
  } catch {
    // Storage fallback
  }
  return newSecret;
}

// ---------------------------------------------------------------------------
// 10. Migration helpers (browser-only tenant -> server)
// ---------------------------------------------------------------------------

/**
 * True for the sample fleet that older versions seeded into an empty browser-local inventory (never a real tenant's
 * asset), so that moving a tenant to the server does not carry it over.
 */
export function isDemoSeedAsset(asset: Pick<EnclaveAsset, 'id'>, tenantId: string): boolean {
  return /^asset-[a-z]+-\d{2}-/.test(asset.id) && asset.id.endsWith(`-${tenantId}`);
}

/** Forgets a tenant's browser-local inventory (after it has been moved to the server). */
export function clearLocalEnclaveAssets(tenantId: string): void {
  try {
    localStorage.removeItem(getStorageKey(tenantId));
  } catch {
    // storage unavailable: the old copy simply stays
  }
}
