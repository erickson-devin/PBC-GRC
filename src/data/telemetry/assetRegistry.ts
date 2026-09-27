/**
 * Event Horizon: Singularity — Enclave Asset & Hardware Inventory Registry
 *
 * Provides persistent CRUD management for enclave hardware assets, CMMC 2.0 scoping
 * categories, DISA STIG scan history, bulk CSV onboarding, and real-time network discovery
 * ingestion from Elijah's Event Horizon: Accretion tool.
 */

import {
  EnclaveAsset,
  EnclaveAssetOsProfile,
  CmmcAssetCategory,
  EnclaveAssetStatus,
  AccretionDiscoveryItem,
  AccretionIngestResult,
} from '../../types/telemetry';
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
// 2. Default Seed Assets for Enclave Boundary
// ---------------------------------------------------------------------------

export function generateDefaultEnclaveAssets(tenantId: string): EnclaveAsset[] {
  const now = new Date().toISOString();

  return [
    {
      id: `asset-cui-01-${tenantId}`,
      tenantId,
      hostName: 'enclave-node-01',
      ipAddress: '10.0.50.12',
      macAddress: '52:54:00:8C:92:4F',
      osProfile: 'rhel9',
      cmmcAssetCategory: 'CUI_ASSET',
      status: 'ACTIVE',
      sourceOrigin: 'PHOTON_AGENT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: now,
      complianceScore: 100,
      notes: 'Primary CUI processing node with automated OpenSCAP STIG evaluation daemon.',
      isManuallyAdded: false,
    },
    {
      id: `asset-sec-04-${tenantId}`,
      tenantId,
      hostName: 'WS-SEC-04',
      ipAddress: '192.168.1.142',
      macAddress: '00:50:56:B3:4A:19',
      osProfile: 'ubuntu2204',
      cmmcAssetCategory: 'SECURITY_PROTECTION',
      status: 'NON_COMPLIANT',
      sourceOrigin: 'PHOTON_AGENT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: now,
      complianceScore: 91,
      notes: 'Security analyst workstation. Root cause for boundary failure on AC.L1-3.1.1 & AC.L1-3.1.10.',
      isManuallyAdded: false,
    },
    {
      id: `asset-dc-01-${tenantId}`,
      tenantId,
      hostName: 'DC-ENCLAVE-01',
      ipAddress: '10.0.50.5',
      macAddress: '00:15:5D:01:AF:22',
      osProfile: 'win2022',
      cmmcAssetCategory: 'SECURITY_PROTECTION',
      status: 'ACTIVE',
      sourceOrigin: 'PHOTON_AGENT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: now,
      complianceScore: 100,
      notes: 'Enclave Domain Controller & Active Directory root identity provider for Kerberos MFA.',
      isManuallyAdded: false,
    },
    {
      id: `asset-app-02-${tenantId}`,
      tenantId,
      hostName: 'APP-PROD-02',
      ipAddress: '10.0.50.28',
      macAddress: '52:54:00:3E:11:9B',
      osProfile: 'rhel9',
      cmmcAssetCategory: 'CUI_ASSET',
      status: 'ACTIVE',
      sourceOrigin: 'PHOTON_AGENT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: now,
      complianceScore: 100,
      notes: 'Production container host running defense microservices with FIPS 140-3 cryptography.',
      isManuallyAdded: false,
    },
    {
      id: `asset-fw-01-${tenantId}`,
      tenantId,
      hostName: 'FW-GATEWAY-01',
      ipAddress: '10.0.50.1',
      macAddress: '00:0C:29:4F:88:1A',
      osProfile: 'cisco_ios',
      cmmcAssetCategory: 'SECURITY_PROTECTION',
      status: 'ACTIVE',
      sourceOrigin: 'MANUAL_ENTRY',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: null,
      complianceScore: null,
      notes: 'Perimeter next-generation firewall / IPsec VPN boundary router.',
      isManuallyAdded: true,
    },
    {
      id: `asset-contractor-01-${tenantId}`,
      tenantId,
      hostName: 'QA-LAB-CLIENT',
      ipAddress: '10.0.50.99',
      macAddress: 'A4:83:E7:22:90:BB',
      osProfile: 'win11',
      cmmcAssetCategory: 'CONTRACTOR_RISK',
      status: 'NEVER_SCANNED',
      sourceOrigin: 'MANUAL_ENTRY',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: null,
      complianceScore: null,
      notes: 'Contractor testing laptop temporarily connected to enclave evaluation VLAN.',
      isManuallyAdded: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 3. Storage Persistence
// ---------------------------------------------------------------------------

function getStorageKey(tenantId: string): string {
  return `${ASSET_REGISTRY_STORAGE_KEY_PREFIX}${tenantId}`;
}

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

  // Populate default seed inventory for new or uninitialized tenants
  const seeds = generateDefaultEnclaveAssets(tenantId);
  saveEnclaveAssets(seeds, tenantId);
  return seeds;
}

export function saveEnclaveAssets(assets: EnclaveAsset[], tenantId: string): void {
  try {
    localStorage.setItem(getStorageKey(tenantId), JSON.stringify(assets));
  } catch (err) {
    console.error('[AssetRegistry] Failed to save asset storage:', err);
  }
}

// ---------------------------------------------------------------------------
// 4. CRUD Operations
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
// 5. Bulk CSV Importer
// ---------------------------------------------------------------------------

export function importAssetsFromCsv(tenantId: string, csvContent: string): EnclaveAsset[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return [];

  // Parse header
  const headerLine = lines[0].toLowerCase();
  const headers = headerLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

  const hostIdx = headers.findIndex(h => h.includes('host') || h.includes('name'));
  const ipIdx = headers.findIndex(h => h.includes('ip') || h.includes('address'));
  const osIdx = headers.findIndex(h => h.includes('os') || h.includes('platform') || h.includes('profile'));
  const catIdx = headers.findIndex(h => h.includes('category') || h.includes('cmmc') || h.includes('scope'));
  const macIdx = headers.findIndex(h => h.includes('mac'));
  const notesIdx = headers.findIndex(h => h.includes('note') || h.includes('desc'));

  const currentAssets = getEnclaveAssets(tenantId);
  const importedList: EnclaveAsset[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawCols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (rawCols.length < 2) continue;

    const hostName = (hostIdx >= 0 ? rawCols[hostIdx] : rawCols[0]) || `host-node-${i}`;
    const ipAddress = (ipIdx >= 0 ? rawCols[ipIdx] : rawCols[1]) || `10.0.50.${100 + i}`;
    const rawOs = (osIdx >= 0 ? rawCols[osIdx] : 'rhel9').toLowerCase();
    const rawCat = (catIdx >= 0 ? rawCols[catIdx] : 'CUI_ASSET').toUpperCase();
    const macAddress = (macIdx >= 0 && rawCols[macIdx]) ? rawCols[macIdx] : `52:54:00:${Math.random().toString(16).slice(2, 6).toUpperCase()}:${Math.random().toString(16).slice(2, 4).toUpperCase()}`;
    const notes = notesIdx >= 0 ? rawCols[notesIdx] : 'Imported via CSV bulk onboarding';

    // Map OS Profile
    let osProfile: EnclaveAssetOsProfile = 'rhel9';
    if (rawOs.includes('ubuntu')) osProfile = 'ubuntu2204';
    else if (rawOs.includes('win11') || rawOs.includes('windows 11')) osProfile = 'win11';
    else if (rawOs.includes('win') || rawOs.includes('server')) osProfile = 'win2022';
    else if (rawOs.includes('rhel8')) osProfile = 'rhel8';
    else if (rawOs.includes('cisco') || rawOs.includes('ios')) osProfile = 'cisco_ios';
    else if (rawOs.includes('custom')) osProfile = 'custom';

    // Map CMMC Category
    let cmmcAssetCategory: CmmcAssetCategory = 'CUI_ASSET';
    if (rawCat.includes('SECURITY') || rawCat.includes('SPA')) cmmcAssetCategory = 'SECURITY_PROTECTION';
    else if (rawCat.includes('RISK') || rawCat.includes('CONTRACTOR')) cmmcAssetCategory = 'CONTRACTOR_RISK';
    else if (rawCat.includes('OUT') || rawCat.includes('SCOPE')) cmmcAssetCategory = 'OUT_OF_SCOPE';

    const newAsset: EnclaveAsset = {
      id: generateUuid(),
      tenantId,
      hostName,
      ipAddress,
      macAddress,
      osProfile,
      cmmcAssetCategory,
      status: 'NEVER_SCANNED',
      sourceOrigin: 'CSV_IMPORT',
      discoveryStatus: 'ACTIVE',
      lastScannedAt: null,
      complianceScore: null,
      notes,
      isManuallyAdded: true,
    };

    importedList.push(newAsset);
  }

  const combined = [...importedList, ...currentAssets];
  saveEnclaveAssets(combined, tenantId);
  return importedList;
}

// ---------------------------------------------------------------------------
// 6. Real-Time Scan Synchronization
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
// 7. Accretion Discovery Ingestion & Deduplication Pipeline
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
// 8. Accretion Simulation Generator (for evaluation & testing)
// ---------------------------------------------------------------------------

export async function simulateAccretionDiscovery(tenantId: string): Promise<AccretionIngestResult> {
  // If simulated accretion assets already exist in this tenant's inventory from a previous test,
  // clean them out so the simulation always demonstrates fresh unconfirmed rogue asset discovery and deduplication!
  const current = getEnclaveAssets(tenantId);
  const cleaned = current.filter(a => a.sourceOrigin !== 'ACCRETION_DISCOVERY');
  saveEnclaveAssets(cleaned, tenantId);

  const simulatedBatch: AccretionDiscoveryItem[] = [
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

  return await ingestAccretionDiscoveryPayload(tenantId, simulatedBatch);
}

// ---------------------------------------------------------------------------
// 9. Confirm Discovered Asset Classification
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
// 10. Accretion Webhook & API Secret Key Configuration
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
    webhookUrl: 'https://grc.pitchblackcyber.com/api/v1/assets/accretion-sync',
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
